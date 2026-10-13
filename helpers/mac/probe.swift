// autotrack probe (Mac): long-lived helper. One JSON request per line on stdin, one answer per
// line on stdout. Ops: at, front, focused, perm. See designs/2026-10-13-track.md "Probe protocol".
// Never returns an element's value. Coordinates: global points, origin top-left (same as uiohook).
// Elements also carry path (ancestors up to the window), id, cls, url, help; each omitted when empty.
// Chromium and Electron apps get AXManualAccessibility once per pid so web content shows its tree.
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
    "AXIdentifier", "AXDOMIdentifier", "AXDOMClassList", "AXURL", kAXHelpAttribute, kAXParentAttribute,
]
let ancestorAttrs: [String] = [
    kAXRoleAttribute, kAXTitleAttribute, kAXDescriptionAttribute, "AXLabel", kAXParentAttribute,
]
let maxAncestors = 6
let walkBudgetMs = 30.0  // ancestor walking stops past this, so a slow app can't blow the 50 ms answer
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

// Chromium and Electron build their web accessibility tree only when asked. AXManualAccessibility
// asks without side effects; AXEnhancedUserInterface is the fallback. Once per pid.
var enabledPids = Set<pid_t>()
let chromiumIds = ["com.google.Chrome", "com.microsoft.edgemac", "com.brave.Browser", "com.operasoftware.",
                   "company.thebrowser.Browser", "com.vivaldi."]
let noEnhance = ProcessInfo.processInfo.environment["AUTOTRACK_PROBE_NO_ENHANCE"] != nil  // for before/after measuring

func isChromiumBased(_ app: NSRunningApplication) -> Bool {
    if let id = app.bundleIdentifier, chromiumIds.contains(where: { id.hasPrefix($0) }) { return true }
    guard let url = app.bundleURL else { return false }
    let fw = url.appendingPathComponent("Contents/Frameworks")
    let fm = FileManager.default
    return fm.fileExists(atPath: fw.appendingPathComponent("Electron Framework.framework").path)
        || fm.fileExists(atPath: fw.appendingPathComponent("Chromium Embedded Framework.framework").path)
}

func enableWebAccessibility(_ pid: pid_t) {
    if noEnhance || enabledPids.contains(pid) { return }
    enabledPids.insert(pid)
    guard let app = NSRunningApplication(processIdentifier: pid), isChromiumBased(app) else { return }
    let ax = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(ax, 0.25)  // one-off, may take a moment while the tree builds
    if AXUIElementSetAttributeValue(ax, "AXManualAccessibility" as CFString, kCFBooleanTrue) != .success {
        _ = AXUIElementSetAttributeValue(ax, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
    }
}

func normRole(_ role: String) -> String {
    (role.hasPrefix("AX") ? String(role.dropFirst(2)) : role).lowercased()
}

func firstNonEmpty(_ a: [String: CFTypeRef], _ keys: [String]) -> String {
    for k in keys { let v = str(a[k]); if !v.isEmpty { return v } }
    return ""
}

func urlString(_ v: CFTypeRef?) -> String {
    guard let v = v else { return "" }
    if CFGetTypeID(v) == CFURLGetTypeID() { return (CFURLGetString((v as! CFURL)) as String?) ?? "" }
    return str(v)
}

func classList(_ v: CFTypeRef?) -> String {
    guard let v = v else { return "" }
    if CFGetTypeID(v) == CFArrayGetTypeID() { return ((v as! [Any]).compactMap { $0 as? String }).joined(separator: " ") }
    return str(v)
}

func axElement(_ v: CFTypeRef?) -> AXUIElement? {
    guard let v = v, CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
    return (v as! AXUIElement)
}

func msSince(_ t0: DispatchTime) -> Double { Double(DispatchTime.now().uptimeNanoseconds - t0.uptimeNanoseconds) / 1e6 }

// Ancestors nearest first, stopping before the window (the window is `front.window`).
func ancestors(from parent: AXUIElement?, _ t0: DispatchTime) -> [[String: Any]] {
    var out: [[String: Any]] = []
    var cur = parent
    while let el = cur, out.count < maxAncestors, msSince(t0) < walkBudgetMs {
        AXUIElementSetMessagingTimeout(el, axTimeout)
        guard let a = attrs(el, ancestorAttrs) else { break }
        let role = str(a[kAXRoleAttribute])
        if role.isEmpty || role == "AXWindow" || role == "AXApplication" || role == "AXSheet" { break }
        out.append(["role": normRole(role), "name": firstNonEmpty(a, [kAXTitleAttribute, kAXDescriptionAttribute, "AXLabel"])])
        cur = axElement(a[kAXParentAttribute])
    }
    return out
}

func elementJSON(_ el: AXUIElement) -> Any {
    let t0 = DispatchTime.now()
    AXUIElementSetMessagingTimeout(el, axTimeout)
    var pid: pid_t = 0
    if AXUIElementGetPid(el, &pid) == .success { enableWebAccessibility(pid) }
    guard let a = attrs(el, elementAttrs) else { return NSNull() }
    let role = str(a[kAXRoleAttribute])
    if role.isEmpty { return NSNull() }
    let sub = str(a[kAXSubroleAttribute])
    let p = point(a[kAXPositionAttribute]) ?? .zero
    let s = size(a[kAXSizeAttribute]) ?? .zero
    let secure = sub == "AXSecureTextField" || IsSecureEventInputEnabled()
    var out: [String: Any] = [
        "role": normRole(role),
        "name": firstNonEmpty(a, [kAXTitleAttribute, kAXDescriptionAttribute, "AXLabel"]),
        "x": r(p.x), "y": r(p.y), "width": r(s.width), "height": r(s.height),
        "secure": secure,
    ]
    let path = ancestors(from: axElement(a[kAXParentAttribute]), t0)
    if !path.isEmpty { out["path"] = path }
    for (key, value) in [
        "id": firstNonEmpty(a, ["AXIdentifier", "AXDOMIdentifier"]),
        "cls": classList(a["AXDOMClassList"]),
        "url": urlString(a["AXURL"]),
        "help": str(a[kAXHelpAttribute]),
    ] where !value.isEmpty { out[key] = value }
    return out
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
    enableWebAccessibility(app.processIdentifier)
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
