// wren-track probe (Mac): long-lived helper. One JSON request per line on stdin, one answer per
// line on stdout. Ops: at, front, focused, perm. See designs/2026-10-13-track.md "Probe protocol".
// Never returns an element's value. Coordinates: global points, origin top-left (same as uiohook).
import AppKit
import ApplicationServices
import IOKit.hid
import Carbon.HIToolbox

setvbuf(stdout, nil, _IOLBF, 0)
signal(SIGPIPE, SIG_IGN)

// A hung app must not stall us: AX calls give up after this. One IPC per element
// (CopyMultipleAttributeValues) keeps a typical answer well under the 50 ms budget.
let axTimeout: Float = 0.04
let systemWide = AXUIElementCreateSystemWide()
AXUIElementSetMessagingTimeout(systemWide, axTimeout)

let elementAttrs: [String] = [
    kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXDescriptionAttribute,
    "AXLabel", kAXPositionAttribute, kAXSizeAttribute,
]
let windowAttrs: [String] = [kAXTitleAttribute, kAXPositionAttribute, kAXSizeAttribute]

func attrs(_ el: AXUIElement, _ names: [String]) -> [String: CFTypeRef]? {
    var out: CFArray?
    let err = AXUIElementCopyMultipleAttributeValues(el, names as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &out)
    guard err == .success, let arr = out as? [CFTypeRef], arr.count == names.count else { return nil }
    var d: [String: CFTypeRef] = [:]
    for (i, n) in names.enumerated() { d[n] = arr[i] }  // failed attributes come back as AXValue error types
    return d
}

func str(_ v: CFTypeRef?) -> String {
    guard let v = v, CFGetTypeID(v) == CFStringGetTypeID() else { return "" }
    return v as! String
}

func point(_ v: CFTypeRef?) -> CGPoint? {
    guard let v = v, CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
    var p = CGPoint.zero
    return AXValueGetValue(v as! AXValue, .cgPoint, &p) ? p : nil
}

func size(_ v: CFTypeRef?) -> CGSize? {
    guard let v = v, CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
    var s = CGSize.zero
    return AXValueGetValue(v as! AXValue, .cgSize, &s) ? s : nil
}

func r(_ d: CGFloat) -> Int { Int(d.rounded()) }

func elementJSON(_ el: AXUIElement) -> Any {
    AXUIElementSetMessagingTimeout(el, axTimeout)
    guard let a = attrs(el, elementAttrs) else { return NSNull() }
    let role = str(a[kAXRoleAttribute])
    if role.isEmpty { return NSNull() }
    let sub = str(a[kAXSubroleAttribute])
    var name = ""
    for k in [kAXTitleAttribute, kAXDescriptionAttribute, "AXLabel"] {
        name = str(a[k])
        if !name.isEmpty { break }
    }
    let p = point(a[kAXPositionAttribute]) ?? .zero
    let s = size(a[kAXSizeAttribute]) ?? .zero
    let secure = sub == "AXSecureTextField" || IsSecureEventInputEnabled()
    return [
        "role": role.hasPrefix("AX") ? String(role.dropFirst(2)).lowercased() : role.lowercased(),
        "name": name,
        "x": r(p.x), "y": r(p.y), "width": r(s.width), "height": r(s.height),
        "secure": secure,
    ] as [String: Any]
}

func opAt(_ x: Double, _ y: Double) -> Any {
    var el: AXUIElement?
    guard AXUIElementCopyElementAtPosition(systemWide, Float(x), Float(y), &el) == .success, let e = el else { return NSNull() }
    return elementJSON(e)
}

func opFocused() -> Any {
    var v: CFTypeRef?
    guard AXUIElementCopyAttributeValue(systemWide, kAXFocusedUIElementAttribute as CFString, &v) == .success,
          let e = v, CFGetTypeID(e) == AXUIElementGetTypeID() else { return NSNull() }
    return elementJSON(e as! AXUIElement)
}

func opFront() -> [String: Any] {
    // The AX focused application is live; NSWorkspace only updates while a run loop turns.
    var app: NSRunningApplication?
    var v: CFTypeRef?
    if AXUIElementCopyAttributeValue(systemWide, kAXFocusedApplicationAttribute as CFString, &v) == .success,
       let e = v, CFGetTypeID(e) == AXUIElementGetTypeID() {
        var pid: pid_t = 0
        if AXUIElementGetPid(e as! AXUIElement, &pid) == .success { app = NSRunningApplication(processIdentifier: pid) }
    }
    if app == nil {
        RunLoop.current.run(mode: .default, before: Date())
        app = NSWorkspace.shared.frontmostApplication
    }
    guard let app = app else { return ["app": NSNull(), "window": NSNull()] }
    let appJSON: [String: Any] = [
        "name": app.localizedName ?? "",
        "id": app.bundleIdentifier ?? "",
        "pid": Int(app.processIdentifier),
    ]
    var window: Any = NSNull()
    let ax = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(ax, axTimeout)
    var w: CFTypeRef?
    if AXUIElementCopyAttributeValue(ax, kAXFocusedWindowAttribute as CFString, &w) == .success,
       let we = w, CFGetTypeID(we) == AXUIElementGetTypeID() {
        let wel = we as! AXUIElement
        AXUIElementSetMessagingTimeout(wel, axTimeout)
        if let a = attrs(wel, windowAttrs) {
            let p = point(a[kAXPositionAttribute]) ?? .zero
            let s = size(a[kAXSizeAttribute]) ?? .zero
            window = ["title": str(a[kAXTitleAttribute]), "x": r(p.x), "y": r(p.y), "width": r(s.width), "height": r(s.height)] as [String: Any]
        }
    }
    return ["app": appJSON, "window": window]
}

func opPerm() -> [String: Any] {
    [
        "accessibility": AXIsProcessTrusted(),
        "screen": CGPreflightScreenCaptureAccess(),
        "input": IOHIDCheckAccess(kIOHIDRequestTypeListenEvent) == kIOHIDAccessTypeGranted,
    ]
}

func num(_ v: Any?) -> Double? { (v as? NSNumber)?.doubleValue }

func handle(_ req: [String: Any]) -> [String: Any] {
    var res: [String: Any] = ["id": req["id"] ?? NSNull()]
    switch req["op"] as? String {
    case "at":
        if let x = num(req["x"]), let y = num(req["y"]) { res["element"] = opAt(x, y) } else { res["element"] = NSNull() }
    case "focused": res["element"] = opFocused()
    case "front": res.merge(opFront()) { $1 }
    case "perm": res.merge(opPerm()) { $1 }
    default: res["error"] = "unknown op"
    }
    return res
}

while let line = readLine() {
    guard let data = line.data(using: .utf8),
          let req = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { continue }
    let res = handle(req)
    if let out = try? JSONSerialization.data(withJSONObject: res), let s = String(data: out, encoding: .utf8) {
        print(s)
        fflush(stdout)
    }
}
