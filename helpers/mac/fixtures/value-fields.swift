// Probe test fixture (test.mjs): three text fields holding the same typed text, two of them named
// by it (AXTitle = the text, AXDescription contains it), one named "Email". The probe must name the
// first two "" and keep "Email", and the text must come back nowhere. Writes each field's center
// (global points, top-left origin) and its pid to argv[1] once on screen; quits after 60 s.
//
//   swiftc -O -o value-fields value-fields.swift && ./value-fields /tmp/fields.json
import AppKit

let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "/tmp/autotrack-fields.json"
let typed = "zq-secret-4417"

final class Delegate: NSObject, NSApplicationDelegate {
  var window: NSWindow!
  var fields: [NSTextField] = []

  func applicationDidFinishLaunching(_ note: Notification) {
    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 420, height: 170),
      styleMask: [.titled], backing: .buffered, defer: false)
    window.title = "autotrack value fields"
    let namings: [(NSTextField) -> Void] = [
      { $0.setAccessibilityTitle(typed) },
      { $0.setAccessibilityLabel("Notes " + typed) },
      { $0.setAccessibilityTitle("Email") },
    ]
    for (i, setName) in namings.enumerated() {
      let f = NSTextField(frame: NSRect(x: 20, y: 120 - i * 50, width: 380, height: 26))
      f.stringValue = typed
      setName(f)
      window.contentView!.addSubview(f)
      fields.append(f)
    }
    // Top left, away from the screen center where system prompts appear.
    let vis = NSScreen.screens[0].visibleFrame
    window.setFrameTopLeftPoint(NSPoint(x: vis.minX + 20, y: vis.maxY - 20))
    window.level = .floating
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
      self.window.makeFirstResponder(self.fields[0])
      self.write()
    }
  }

  func write() {
    let top = NSScreen.screens[0].frame.maxY
    let centers = fields.map { f -> [String: Double] in
      let r = window.convertToScreen(f.convert(f.bounds, to: nil))
      return ["x": Double(r.midX), "y": Double(top - r.midY)]
    }
    let json: [String: Any] = ["fields": centers, "pid": getpid(), "typed": typed]
    let data = try! JSONSerialization.data(withJSONObject: json)
    try! data.write(to: URL(fileURLWithPath: out + ".tmp"))
    _ = rename(out + ".tmp", out)
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = Delegate()
app.delegate = delegate
DispatchQueue.main.asyncAfter(deadline: .now() + 60) { NSApp.terminate(nil) }
app.run()
