// autotrack probe (Mac): long-lived helper. One JSON request per line on stdin, one answer per
// line on stdout. Ops: at, front, focused, perm. See designs/2026-10-13-autotrack.md "Probe protocol".
// `probe --shots` is the same binary as a second process that only takes screen frames (ops grab,
// save, displays; see "Shots protocol"), so a capture never delays a probe answer.
// Never returns an element's value, nor a name that shows it (a text field named by its content).
// Coordinates: global points, origin top-left (same as uiohook).
// Elements also carry path (ancestors up to the window), id, cls, url, help; each omitted when empty.
// Chromium and Electron apps get AXManualAccessibility once per pid so web content shows its tree.
import AppKit
import ApplicationServices
import IOKit.hid
import Carbon.HIToolbox
import ImageIO
import ScreenCaptureKit

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
func ancestors(from parent: AXUIElement?, _ t0: DispatchTime, wait: Float = axTimeout) -> [[String: Any]] {
    var out: [[String: Any]] = []
    var cur = parent
    while let el = cur, out.count < maxAncestors, msSince(t0) < walkBudgetMs {
        AXUIElementSetMessagingTimeout(el, wait)
        guard let a = attrs(el, ancestorAttrs) else { break }
        let role = str(a[kAXRoleAttribute])
        if role.isEmpty || role == "AXWindow" || role == "AXApplication" || role == "AXSheet" { break }
        let name = firstNonEmpty(a, [kAXTitleAttribute, kAXDescriptionAttribute, "AXLabel"])
        out.append(["role": normRole(role), "name": safeName(el, role: role, name)])
        cur = axElement(a[kAXParentAttribute])
    }
    return out
}

// Text-entry roles: AXTitle/AXDescription can carry what was typed (web inputs, some editors).
let textRoles: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox"]

/// The element's value, its first 4,096 characters at most, only to compare names against. Never sent.
func valuePrefix(_ el: AXUIElement) -> String {
    var count: CFTypeRef?
    if AXUIElementCopyAttributeValue(el, kAXNumberOfCharactersAttribute as CFString, &count) == .success,
       let n = (count as? NSNumber)?.intValue, n > 4096 {
        var range = CFRange(location: 0, length: 4096)
        var out: CFTypeRef?
        guard let r = AXValueCreate(.cfRange, &range),
              AXUIElementCopyParameterizedAttributeValue(el, kAXStringForRangeParameterizedAttribute as CFString, r, &out) == .success
        else { return "" }
        return str(out)
    }
    var v: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, kAXValueAttribute as CFString, &v) == .success else { return "" }
    return str(v)
}

/// A name that is (or holds) the element's value is no name: it would leak what was typed.
func nameShowsValue(_ name: String, _ value: String) -> Bool {
    let n = name.trimmingCharacters(in: .whitespacesAndNewlines)
    let v = value.trimmingCharacters(in: .whitespacesAndNewlines)
    if n.isEmpty || v.isEmpty { return false }
    return n == v || (v.count >= 3 && n.contains(v)) || (n.count >= 12 && v.contains(n))
}

/// The element's name, empty when a text-entry element's name shows its value.
func safeName(_ el: AXUIElement, role: String, _ name: String) -> String {
    if name.isEmpty || !textRoles.contains(role) { return name }
    return nameShowsValue(name, valuePrefix(el)) ? "" : name
}

func elementJSON(_ el: AXUIElement, wait: Float = axTimeout) -> Any {
    let t0 = DispatchTime.now()
    AXUIElementSetMessagingTimeout(el, wait)
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
        "name": safeName(el, role: role, firstNonEmpty(a, [kAXTitleAttribute, kAXDescriptionAttribute, "AXLabel"])),
        "x": r(p.x), "y": r(p.y), "width": r(s.width), "height": r(s.height),
        "secure": secure,
    ]
    let path = ancestors(from: axElement(a[kAXParentAttribute]), t0, wait: wait)
    if !path.isEmpty { out["path"] = path }
    for (key, value) in [
        "id": firstNonEmpty(a, ["AXIdentifier", "AXDOMIdentifier"]),
        "cls": classList(a["AXDOMClassList"]),
        "url": urlString(a["AXURL"]),
        "help": str(a[kAXHelpAttribute]),
    ] where !value.isEmpty { out[key] = value }
    return out
}

/// `wait`: the AX timeout for this ask. An app busy taking focus (a click that activates it) can
/// miss 40 ms, so the client asks again with longer.
func opAt(_ x: Double, _ y: Double, wait: Float = axTimeout) -> Any {
    var el: AXUIElement?
    AXUIElementSetMessagingTimeout(systemWide, wait)
    defer { AXUIElementSetMessagingTimeout(systemWide, axTimeout) }
    guard AXUIElementCopyElementAtPosition(systemWide, Float(x), Float(y), &el) == .success, let e = el else { return NSNull() }
    return elementJSON(e, wait: wait)
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
        let wait = num(req["wait"]).map { Float(min(max($0, 40), 2000) * 0.8 / 1000) } ?? axTimeout
        if let x = num(req["x"]), let y = num(req["y"]) { res["element"] = opAt(x, y, wait: wait) } else { res["element"] = NSNull() }
    case "focused": res["element"] = opFocused()
    case "front": res.merge(opFront()) { $1 }
    case "perm": res.merge(opPerm()) { $1 }
    default: res["error"] = "unknown op"
    }
    return res
}

// MARK: - Shots mode (`probe --shots`)
//
// ops: displays | grab {display} | save {slot, seq?, path, quality?}. A grab captures the display, scales
// it to at most 1920 px on the long side into one of 4 ring slots (memory only) and answers its slot,
// seq, size and a 64-bit hash. A save encodes a slot to a JPEG (path.tmp, then rename). Pixels never
// reach the parent process.

let shotsMaxSide = 1920
let ringSize = 4

/// Same rule as the recorder: long side at most 1920, aspect kept.
func fitSize(_ w: Int, _ h: Int) -> (Int, Int) {
    let k = min(1.0, Double(shotsMaxSide) / Double(max(w, h)))
    return (max(1, Int((Double(w) * k).rounded())), max(1, Int((Double(h) * k).rounded())))
}

struct DisplayInfo {
    let id: CGDirectDisplayID
    let bounds: CGRect  // global points, origin top-left (same space as uiohook)
    let pixelW: Int
    let pixelH: Int
}

func displayInfos() -> [DisplayInfo] {
    var n: UInt32 = 0
    CGGetActiveDisplayList(0, nil, &n)
    var ids = [CGDirectDisplayID](repeating: 0, count: Int(n))
    CGGetActiveDisplayList(n, &ids, &n)
    return ids.prefix(Int(n)).map { id in
        let mode = CGDisplayCopyDisplayMode(id)
        return DisplayInfo(id: id, bounds: CGDisplayBounds(id),
                           pixelW: mode?.pixelWidth ?? CGDisplayPixelsWide(id),
                           pixelH: mode?.pixelHeight ?? CGDisplayPixelsHigh(id))
    }
}

func round2(_ v: Double) -> Double { (v * 100).rounded() / 100 }

func displayJSON(_ d: DisplayInfo) -> [String: Any] {
    let b = d.bounds
    let (fw, _) = fitSize(d.pixelW, d.pixelH)
    let rect: [String: Any] = [
        "x": round2(Double(b.origin.x)), "y": round2(Double(b.origin.y)),
        "width": round2(Double(b.width)), "height": round2(Double(b.height)),
    ]
    var out = rect
    out["id"] = String(d.id)
    out["scale"] = (Double(fw) / Double(b.width) * 1000).rounded() / 1000  // frame pixels per point
    out["primary"] = CGDisplayIsMain(d.id) != 0
    // The OS's own units, for turning a logical point back into them (identity on Mac).
    var os = rect
    os["scale"] = 1
    out["os"] = os
    return out
}

// Two capture paths. ScreenCaptureKit (macOS 14+) is the default: measured on this Mac it costs ~4 ms CPU
// and ~55 MB RSS a grab, against ~40 ms and ~340 MB for CGDisplayCreateImage, because it scales on the
// GPU and hands back an image already at the frame size. CGDisplayCreateImage is the fallback (macOS 12/13,
// or SCK failing). It is deprecated and unavailable to the compiler in recent SDKs, but the symbol is still
// in the system library, so it is looked up at run time and one binary builds against any SDK.
typealias DisplayImageFn = @convention(c) (CGDirectDisplayID) -> Unmanaged<CGImage>?
let displayImageFn: DisplayImageFn? = {
    guard let sym = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "CGDisplayCreateImage") else { return nil }  // RTLD_DEFAULT
    return unsafeBitCast(sym, to: DisplayImageFn.self)
}()
let env = ProcessInfo.processInfo.environment
let preferCG = env["AUTOTRACK_SHOTS_CG"] != nil   // for testing the fallback
let forceSCK = env["AUTOTRACK_SHOTS_SCK"] != nil  // for testing the other one

/// ScreenCaptureKit filters, kept per display: looking one up costs more than the capture. Dropped on a miss.
var sckFilters: [CGDirectDisplayID: Any] = [:]

@available(macOS 14.0, *)
func sckFilter(_ id: CGDirectDisplayID) -> SCContentFilter? {
    if let f = sckFilters[id] as? SCContentFilter { return f }
    let sem = DispatchSemaphore(value: 0)
    var out: SCContentFilter?
    SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) { content, _ in
        if let d = content?.displays.first(where: { $0.displayID == id }) {
            out = SCContentFilter(display: d, excludingWindows: [])
        }
        sem.signal()
    }
    _ = sem.wait(timeout: .now() + 3)
    sckFilters[id] = out
    return out
}

@available(macOS 14.0, *)
func sckCapture(_ id: CGDirectDisplayID, _ w: Int, _ h: Int) -> CGImage? {
    guard let filter = sckFilter(id) else { return nil }
    let cfg = SCStreamConfiguration()
    cfg.width = w
    cfg.height = h
    cfg.showsCursor = false
    let sem = DispatchSemaphore(value: 0)
    var out: CGImage?
    SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg) { image, _ in
        out = image
        sem.signal()
    }
    _ = sem.wait(timeout: .now() + 3)
    if out == nil { sckFilters[id] = nil }
    return out
}

func captureDisplay(_ d: DisplayInfo) -> CGImage? {
    if !preferCG, #available(macOS 14.0, *) {
        let (w, h) = fitSize(d.pixelW, d.pixelH)
        if let img = sckCapture(d.id, w, h) { return img }
        if forceSCK { return nil }
    }
    if let fn = displayImageFn { return fn(d.id)?.takeRetainedValue() }
    return nil
}

final class Slot {
    var ctx: CGContext?
    var w = 0
    var h = 0
    var space: CGColorSpace?
    var seq = 0
}
var ring = (0..<ringSize).map { _ in Slot() }
var grabSeq = 0
let srgb = CGColorSpace(name: CGColorSpace.sRGB)!

/// 64-bit hash of a BGRA frame, cheap: top byte = mean luma of the top half, next = bottom half, low 48
/// bits = difference hash (is each cell darker than its right neighbour) over a 9x6 grid of cell means.
func frameHash(_ ctx: CGContext) -> UInt64 {
    guard let base = ctx.data?.assumingMemoryBound(to: UInt8.self) else { return 0 }
    let w = ctx.width, h = ctx.height, bpr = ctx.bytesPerRow
    let cols = 9, rows = 6, sub = 6
    var cell = [Int](repeating: 0, count: cols * rows)
    for gy in 0..<rows {
        for gx in 0..<cols {
            var sum = 0
            for sy in 0..<sub {
                let y = ((gy * sub + sy) * 2 + 1) * h / (2 * rows * sub)
                let row = base + y * bpr
                for sx in 0..<sub {
                    let x = ((gx * sub + sx) * 2 + 1) * w / (2 * cols * sub)
                    let p = row + x * 4
                    sum += (Int(p[2]) * 77 + Int(p[1]) * 150 + Int(p[0]) * 29) >> 8
                }
            }
            cell[gy * cols + gx] = sum / (sub * sub)
        }
    }
    var bits: UInt64 = 0
    for gy in 0..<rows {
        for gx in 0..<(cols - 1) where cell[gy * cols + gx] < cell[gy * cols + gx + 1] {
            bits |= 1 << UInt64(gy * (cols - 1) + gx)
        }
    }
    let half = cols * rows / 2
    let top = cell[0..<half].reduce(0, +) / half
    let bottom = cell[half...].reduce(0, +) / half
    return bits | UInt64(bottom) << 48 | UInt64(top) << 56
}

func opGrab(_ req: [String: Any]) -> [String: Any] {
    guard let idStr = req["display"] as? String, let id = UInt32(idStr),
          let d = displayInfos().first(where: { $0.id == id }) else { return ["error": "no such display"] }
    guard let src = captureDisplay(d) else { return ["error": "capture failed"] }
    let (w, h) = fitSize(src.width, src.height)
    grabSeq += 1
    let slot = ring[grabSeq % ringSize]
    slot.seq = 0  // not savable until the new picture is in
    // Draw in the display's own colour space: converting to sRGB made the downscale 4x slower.
    let space = src.colorSpace ?? srgb
    if slot.ctx == nil || slot.w != w || slot.h != h || slot.space != space {
        slot.space = space
        slot.ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: space,
                             bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
        slot.w = w
        slot.h = h
    }
    guard let ctx = slot.ctx else { return ["error": "no memory for a frame"] }
    ctx.interpolationQuality = .medium
    ctx.setBlendMode(.copy)
    ctx.draw(src, in: CGRect(x: 0, y: 0, width: w, height: h))
    slot.seq = grabSeq
    return ["slot": grabSeq % ringSize, "seq": grabSeq, "w": w, "h": h, "hash": String(format: "%016llx", frameHash(ctx))]
}

func opSave(_ req: [String: Any]) -> [String: Any] {
    func fail(_ why: String) -> [String: Any] { ["ok": false, "error": why] }
    guard let n = (req["slot"] as? NSNumber)?.intValue, n >= 0, n < ringSize,
          let path = req["path"] as? String, !path.isEmpty else { return fail("bad request") }
    let slot = ring[n]
    guard let ctx = slot.ctx, slot.seq > 0 else { return fail("empty slot") }
    if let seq = (req["seq"] as? NSNumber)?.intValue, seq != slot.seq { return fail("slot reused") }
    guard let image = ctx.makeImage() else { return fail("no image") }
    let q = min(100, max(1, (req["quality"] as? NSNumber)?.doubleValue ?? 70)) / 100
    let tmp = path + ".tmp"
    guard let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: tmp) as CFURL, "public.jpeg" as CFString, 1, nil)
    else { return fail("cannot write \(tmp)") }
    CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: q] as CFDictionary)
    guard CGImageDestinationFinalize(dest) else { unlink(tmp); return fail("encode failed") }
    guard rename(tmp, path) == 0 else { unlink(tmp); return fail("rename failed: \(String(cString: strerror(errno)))") }
    var st = stat()
    return ["ok": true, "bytes": stat(path, &st) == 0 ? Int(st.st_size) : 0]
}

func handleShots(_ req: [String: Any]) -> [String: Any] {
    var res: [String: Any]
    switch req["op"] as? String {
    case "displays": sckFilters = [:]; res = ["displays": displayInfos().map(displayJSON)]  // layout may have changed
    case "grab": res = opGrab(req)
    case "save": res = opSave(req)
    default: res = ["error": "unknown op"]
    }
    res["id"] = req["id"] ?? NSNull()
    return res
}

func serve(_ handler: ([String: Any]) -> [String: Any]) {
    while let line = readLine() {
        guard let data = line.data(using: .utf8),
              let req = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { continue }
        let res = autoreleasepool { handler(req) }  // no run loop here: free CG's autoreleased images per request
        if let out = try? JSONSerialization.data(withJSONObject: res), let s = String(data: out, encoding: .utf8) {
            print(s)
            fflush(stdout)
        }
    }
}

if CommandLine.arguments.contains("--shots") {
    serve(handleShots)
} else {
    serve(handle)
}
