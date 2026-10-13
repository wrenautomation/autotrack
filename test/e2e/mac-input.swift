// E2E input driver (CI only; never run it on a machine someone is using). Posts real CGEvents:
// presses Allow on the screen capture prompt if it is up, clicks TextEdit's window and types "hello" + Return, then clicks the test form's password box
// (mac-form.swift), types the password, and clicks Submit.
//
//   swiftc -O -o mac-input mac-input.swift && ./mac-input /tmp/form.json
import AppKit
import CoreGraphics

let formPath = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "/tmp/autotrack-form.json"
let source = CGEventSource(stateID: .hidSystemState)

func log(_ s: String) { FileHandle.standardError.write((s + "\n").data(using: .utf8)!) }
func pause(_ ms: Int) { usleep(useconds_t(ms * 1000)) }

func click(_ p: CGPoint) {
  CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left)?
    .post(tap: .cghidEventTap)
  pause(150)
  CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: p, mouseButton: .left)?
    .post(tap: .cghidEventTap)
  pause(60)
  CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: p, mouseButton: .left)?
    .post(tap: .cghidEventTap)
  log("click \(Int(p.x)),\(Int(p.y))")
}

// US layout virtual key codes.
let keys: [Character: CGKeyCode] = [
  "a": 0x00, "s": 0x01, "d": 0x02, "f": 0x03, "h": 0x04, "g": 0x05, "z": 0x06, "x": 0x07,
  "c": 0x08, "v": 0x09, "b": 0x0B, "q": 0x0C, "w": 0x0D, "e": 0x0E, "r": 0x0F, "y": 0x10,
  "t": 0x11, "1": 0x12, "2": 0x13, "3": 0x14, "4": 0x15, "6": 0x16, "5": 0x17, "9": 0x19,
  "7": 0x1A, "8": 0x1C, "0": 0x1D, "o": 0x1F, "u": 0x20, "i": 0x22, "p": 0x23, "l": 0x25,
  "j": 0x26, "k": 0x28, "n": 0x2D, "m": 0x2E,
]
let returnKey: CGKeyCode = 0x24

func key(_ code: CGKeyCode) {
  CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true)?.post(tap: .cghidEventTap)
  pause(30)
  CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false)?.post(tap: .cghidEventTap)
  pause(60)
}

func type(_ s: String) {
  for ch in s {
    guard let code = keys[ch] else { fatalError("no key code for \(ch)") }
    key(code)
  }
}

/// TextEdit's largest normal window, in global top-left points.
func textEditWindow() -> CGRect? {
  let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
    as? [[String: Any]] ?? []
  var best: CGRect?
  for w in list {
    guard (w[kCGWindowOwnerName as String] as? String) == "TextEdit",
      (w[kCGWindowLayer as String] as? Int) == 0,
      let b = w[kCGWindowBounds as String] as? NSDictionary,
      let r = CGRect(dictionaryRepresentation: b)
    else { continue }
    if best == nil || r.width * r.height > best!.width * best!.height { best = r }
  }
  return best
}

log("accessibility trusted: \(AXIsProcessTrusted()), post-event access: \(CGPreflightPostEventAccess())")

var win: CGRect?
for _ in 0..<40 {
  win = textEditWindow()
  if win != nil { break }
  pause(250)
}
guard let w = win else {
  log("no TextEdit window on screen")
  exit(1)
}
log("TextEdit window \(w)")
/// The front app by AX (live; NSWorkspace only updates while a run loop turns, and this has none).
func frontName() -> String {
  var v: CFTypeRef?
  var pid: pid_t = 0
  guard AXUIElementCopyAttributeValue(AXUIElementCreateSystemWide(), kAXFocusedApplicationAttribute as CFString, &v) == .success,
    let e = v, CFGetTypeID(e) == AXUIElementGetTypeID(), AXUIElementGetPid(e as! AXUIElement, &pid) == .success
  else { return "?" }
  return NSRunningApplication(processIdentifier: pid)?.localizedName ?? "?"
}

/// macOS 15+ asks whether node may "bypass the private window picker" in a floating window
/// (UserNotificationCenter) over the middle of the screen. Press its first button (Allow) by AX.
func dismissCapturePrompt() {
  for app in NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.UserNotificationCenter") {
    let ax = AXUIElementCreateApplication(app.processIdentifier)
    var wins: CFTypeRef?
    guard AXUIElementCopyAttributeValue(ax, kAXWindowsAttribute as CFString, &wins) == .success else { continue }
    for w in (wins as? [AXUIElement]) ?? [] {
      var kids: CFTypeRef?
      guard AXUIElementCopyAttributeValue(w, kAXChildrenAttribute as CFString, &kids) == .success else { continue }
      for k in (kids as? [AXUIElement]) ?? [] {
        var role: CFTypeRef?
        var title: CFTypeRef?
        AXUIElementCopyAttributeValue(k, kAXRoleAttribute as CFString, &role)
        AXUIElementCopyAttributeValue(k, kAXTitleAttribute as CFString, &title)
        if (role as? String) == "AXButton", (title as? String) == "Allow" {
          log("pressing Allow on the screen capture prompt: \(AXUIElementPerformAction(k, kAXPressAction as CFString) == .success)")
          pause(500)
        }
      }
    }
  }
}

dismissCapturePrompt()
// Left part of the text area: clear of anything centered on screen. Rest on it first so the
// recorder's 1 s front poll has met TextEdit before the click asks the probe about it.
let target = CGPoint(x: w.minX + 80, y: w.minY + 120)
CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: target, mouseButton: .left)?
  .post(tap: .cghidEventTap)
pause(1500)
// What a probe would see at the target just before the click, and how long AX took to say it.
do {
  var el: AXUIElement?
  let t0 = DispatchTime.now()
  let err = AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(target.x), Float(target.y), &el)
  let ms = Double(DispatchTime.now().uptimeNanoseconds - t0.uptimeNanoseconds) / 1e6
  var role: CFTypeRef?
  if let el = el { AXUIElementCopyAttributeValue(el, kAXRoleAttribute as CFString, &role) }
  log("AX at target: err \(err.rawValue), role \(role as? String ?? "none"), \(Int(ms)) ms; front \(frontName())")
}
click(target)
pause(800)
// Keys typed while another app is in front would land elsewhere (a focused password box turns on
// secure input, which hides them from every event tap): say so in the log rather than guess.
log("front after click: \(frontName())")
if frontName() != "TextEdit" {
  NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.TextEdit").first?.activate()
  pause(800)
  click(target)
  pause(800)
  log("front after retry: \(frontName())")
}
type("hello")
key(returnKey)
pause(1500) // the text run ends at Return; let frames settle

var form: [String: Any]?
for _ in 0..<40 {
  if let d = FileManager.default.contents(atPath: formPath),
    let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any]
  {
    form = j
    break
  }
  pause(250)
}
guard let f = form, let pw = f["password"] as? [String: Double], let sb = f["submit"] as? [String: Double]
else {
  log("no form coordinates in \(formPath)")
  exit(1)
}
click(CGPoint(x: pw["x"]!, y: pw["y"]!))
pause(800)
type("hunter2pw")
pause(1500)
click(CGPoint(x: sb["x"]!, y: sb["y"]!))
pause(1500)
log("done")
