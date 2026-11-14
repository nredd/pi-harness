import AppKit

// Headless tests retain the complete entry function in the coverage map without invoking it.
#if !PI_CU_HEADLESS_TEST
@main
#endif
struct PiComputerUseHelper {
	static func main() {
		_ = NSApplication.shared
		NSApp.setActivationPolicy(CommandLine.arguments.contains("serve") ? .accessory : .prohibited)
		Bridge().run()
	}
}
