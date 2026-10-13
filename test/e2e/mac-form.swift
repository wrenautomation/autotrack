// E2E test form (CI only): a window with a password box (NSSecureTextField) and a Submit button.
// Writes the screen centers of both (global points, top-left origin, as CGEvent wants) to the file
// in argv[1] once on screen; on Submit it appends "submitted" to that file's sibling `.done` and quits.
//
//   swiftc -O -o mac-form mac-form.swift && ./mac-form /tmp/form.json
import AppKit

let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "/tmp/autotrack-form.json"

final class Delegate: NSObject, NSApplicationDelegate {
  var window: NSWindow!
  var field: NSSecureTextField!
  var button: NSButton!

  func applicationDidFinishLaunching(_ note: Notification) {
    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 420, height: 160),
      styleMask: [.titled], backing: .buffered, defer: false)
    window.title = "autotrack e2e form"
    let label = NSTextField(labelWithString: "Password")
    label.frame = NSRect(x: 20, y: 100, width: 380, height: 20)
    field = NSSecureTextField(frame: NSRect(x: 20, y: 70, width: 380, height: 26))
    field.placeholderString = "Password"
    button = NSButton(title: "Submit", target: self, action: #selector(submit))
    button.frame = NSRect(x: 150, y: 16, width: 120, height: 32)
    for v in [label, field!, button!] { window.contentView!.addSubview(v) }
    // Bottom right, clear of the editor window the driver clicks first.
    let vis = NSScreen.screens[0].visibleFrame
    window.setFrameOrigin(NSPoint(x: vis.maxX - window.frame.width - 40, y: vis.minY + 40))
    window.level = .floating
    window.makeKeyAndOrderFront(nil)
    // No focused box until the driver clicks one: a focused password box turns on secure input.
    window.makeFirstResponder(nil)
    NSApp.activate(ignoringOtherApps: true)
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.writeCenters() }
  }

  func center(_ v: NSView) -> [String: Double] {
    let inWindow = v.convert(v.bounds, to: nil)
    let r = window.convertToScreen(inWindow)
    let top = NSScreen.screens[0].frame.maxY // global coords: top-left of the primary screen
    return ["x": Double(r.midX), "y": Double(top - r.midY)]
  }

  func writeCenters() {
    window.makeFirstResponder(nil) // again: activation can hand the window its initial responder
    let json: [String: Any] = ["password": center(field), "submit": center(button), "pid": getpid()]
    let data = try! JSONSerialization.data(withJSONObject: json)
    try! data.write(to: URL(fileURLWithPath: out + ".tmp"))
    _ = rename(out + ".tmp", out)
  }

  @objc func submit() {
    FileManager.default.createFile(atPath: out + ".done", contents: "submitted\n".data(using: .utf8))
    DispatchQueue.main.asyncAfter(deadline: .now() + 1) { NSApp.terminate(nil) }
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = Delegate()
app.delegate = delegate
DispatchQueue.main.asyncAfter(deadline: .now() + 120) { NSApp.terminate(nil) } // never hang CI
app.run()
