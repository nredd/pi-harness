import AppKit
let app = NSApplication.shared
app.setActivationPolicy(.regular)
app.activate(ignoringOtherApps: true)
DispatchQueue.main.async {
  let alert = NSAlert()
  alert.messageText = "PCU unpaired test"
  alert.informativeText = "Harmless test dialog"
  alert.addButton(withTitle: "OK")
  alert.addButton(withTitle: "Cancel")
  let r = alert.runModal()
  print("RESULT", r == .alertFirstButtonReturn ? "OK" : "Cancel"); fflush(stdout)
  exit(0)
}
app.run()
