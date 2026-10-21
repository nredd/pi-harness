import AppKit
// Logs every mouse/key/scroll event as `kind a b` lines (global top-left points via CGEvent) to argv[1].
let logPath = CommandLine.arguments[1]
let originX = Double(CommandLine.arguments[2])!, originY = Double(CommandLine.arguments[3])!
FileManager.default.createFile(atPath: logPath, contents: nil)
let handle = FileHandle(forWritingAtPath: logPath)!
func log(_ line: String) { handle.write((line + "\n").data(using: .utf8)!) }
final class Probe: NSView {
  override var acceptsFirstResponder: Bool { true }
  func at(_ e: NSEvent) -> String { let p = e.cgEvent?.location ?? .zero; return "\(Int(p.x.rounded())) \(Int(p.y.rounded()))" }
  override func mouseDown(with e: NSEvent) { log("left \(at(e)) clicks=\(e.clickCount)") }
  override func rightMouseDown(with e: NSEvent) { log("right \(at(e)) clicks=\(e.clickCount)") }
  override func otherMouseDown(with e: NSEvent) { log("other\(e.buttonNumber) \(at(e)) clicks=\(e.clickCount)") }
  override func scrollWheel(with e: NSEvent) { if e.scrollingDeltaY != 0 || e.scrollingDeltaX != 0 { log("scroll \(Int(e.scrollingDeltaX)) \(Int(e.scrollingDeltaY))") } }
  override func keyDown(with e: NSEvent) { log("key \(e.charactersIgnoringModifiers ?? "") flags=\(e.modifierFlags.intersection(.deviceIndependentFlagsMask).rawValue)") }
}
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let win = NSWindow(contentRect: NSRect(x: originX, y: 0, width: 500, height: 300), styleMask: [.titled], backing: .buffered, defer: false)
let view = Probe(frame: win.contentView!.bounds)
win.contentView!.addSubview(view)
win.title = "PCU probe"
// AppKit y is bottom-left relative to the main display; convert a top-left global origin.
let mainHeight = NSScreen.screens[0].frame.height
win.setFrameOrigin(NSPoint(x: originX, y: mainHeight - originY - 300))
win.makeKeyAndOrderFront(nil)
win.makeFirstResponder(view)
app.activate(ignoringOtherApps: true)
app.run()
