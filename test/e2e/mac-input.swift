// E2E input driver (CI only; never run it on a machine someone is using). Posts real CGEvents:
// clicks TextEdit's window and types "hello" + Return, then clicks the test form's password box
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
click(CGPoint(x: w.midX, y: w.midY + 20))
pause(800)
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
