import AppKit
import ApplicationServices
import Foundation

/// Fail the run, and exit before the caller can act, when a headless test reaches a live boundary.
func forbidden<T>(_ boundary: String) -> T {
    expect(false, "headless tests must never reach \(boundary)")
    fatalError("unreachable: \(boundary)")
}

/// An input sink whose every event, delivery, delay and layout read fails the test.
let forbiddenInputSink = NativeInputSink(
    mouseEvent: { _, _, _ in forbidden("mouse event creation") },
    wheelEvent: { _, _ in forbidden("wheel event creation") },
    keyEvent: { _, _ in forbidden("key event creation") },
    postToPid: { _, _ in forbidden("pid event delivery") },
    prepareHID: { _ in forbidden("HID activation") },
    postHID: { _, _ in forbidden("HID event delivery") },
    sleep: { _ in forbidden("input pacing") },
    keyboardInputSource: { forbidden("keyboard layout reads") },
    eventTimestamp: { forbidden("event timestamp reads") }
)

/// Drive `Bridge.handleRequest` through request admission paths that settle before capture, input,
/// clipboard writes, app activation or window changes. Capture and input go through stubs that fail
/// the test if invoked. Clipboard writes, permission panes and Launch Services activation have no
/// seam, so the only cases that reach those functions fail on arguments or on names no app can hold.
/// AX and `NSRunningApplication` calls, including the `AXEnhancedUserInterface` and
/// `AXManualAccessibility` setters, target a pid above the macOS pid range, so no process receives
/// them. Discovery and menu looks also read the live CG window list, which is read-only.
func runRequestAdmissionAssertions() throws {
    let refStore = AXRefStore()
    let bridge = Bridge(activityGlow: nil, readSession: { nil }, inputSink: forbiddenInputSink, refStore: refStore)
    let absentPid = Int32.max
    var owners: [UInt32] = []
    func send(_ request: [String: Any]) throws -> Any {
        try bridge.handleRequest(request, clientID: nil, lookWindowOwner: { id in
            owners.append(id)
            return absentPid
        }, lookCapture: { id in forbidden("capture of window \(id)") })
    }
    func call(_ request: [String: Any]) throws -> [String: Any] {
        let reply = try send(request)
        guard let object = reply as? [String: Any] else {
            expect(false, "\(request["cmd"] ?? ""): expected an object reply, got \(reply)")
            return [:]
        }
        return object
    }
    func refused(_ code: String, _ message: String, _ request: [String: Any]) {
        do {
            let reply = try send(request)
            expect(false, "\(request["cmd"] ?? ""): expected \(code), got reply \(reply)")
        } catch let error as BridgeFailure {
            expect(error.code == code && error.message == message, "\(request["cmd"] ?? ""): expected \(code) '\(message)', got \(error.code) '\(error.message)'")
        } catch {
            expect(false, "\(request["cmd"] ?? ""): unexpected \(error)")
        }
    }

    // Permission panes need a kind before anything opens.
    refused("invalid_args", "Missing string argument 'kind'", ["cmd": "openPermissionPane"])

    // Discovery for an absent owner or an unmatched title finds nothing, without a discovery seam.
    let windows = try send(["cmd": "listWindows", "pid": absentPid])
    expect((windows as? [[String: Any]])?.isEmpty == true, "listWindows for an absent pid is empty, got \(windows)")
    let pidRoots = try call(["cmd": "listRoots", "pid": absentPid])
    expect((pidRoots["roots"] as? [Any])?.isEmpty == true, "listRoots for an absent pid is empty")
    let titleRoots = try call(["cmd": "listRoots", "title": "  pi-cu-absent-title-\(UUID().uuidString) "])
    expect((titleRoots["roots"] as? [Any])?.isEmpty == true, "listRoots for an unmatched title is empty")

    // Window and focus commands resolve the target before changing anything.
    refused("app_not_found", "App with pid \(absentPid) is no longer running", ["cmd": "restoreUserFocus", "pid": absentPid, "windowTitle": "Fixture"])
    let focus = try call(["cmd": "focusWindow", "pid": absentPid])
    expect(focus["focused"] as? Bool == false && focus["reason"] as? String == "window_not_found", "focusWindow without a resolvable window reports window_not_found")
    let frame = try call(["cmd": "setWindowFrame", "pid": absentPid, "windowRef": "ax:stale"])
    expect(frame["ok"] as? Bool == false && frame["reason"] as? String == "window_not_found", "setWindowFrame without a resolvable window reports window_not_found before reading geometry")
    let focused = try call(["cmd": "focusedElement", "pid": absentPid, "windowRef": "ax:stale"])
    expect(focused.count == 1 && focused["exists"] as? Bool == false, "focusedElement without a focused element reports exists=false")

    // Wait conditions need a criterion and a resolvable root.
    refused("invalid_args", "axWaitFor requires role, text, or value", ["cmd": "axWaitFor", "pid": absentPid, "role": "  ", "text": "", "timeoutMs": 100])
    for _ in 0..<2 {
        // The second call reuses the enhanced-accessibility admission for the same pid.
        let wait = try call(["cmd": "axWaitFor", "pid": absentPid, "role": "AXButton", "timeoutMs": 100])
        expect(wait.count == 2 && wait["found"] as? Bool == false && wait["reason"] as? String == "window_not_found", "axWaitFor without a resolvable root reports window_not_found")
    }

    // Text reads require a live element ref and a readable value.
    refused("invalid_args", "Missing string argument 'elementRef'", ["cmd": "axReadText"])
    refused("element_ref_invalid", "Element reference is no longer valid", ["cmd": "axReadText", "elementRef": "ax:missing"])
    let absentRef = refStore.storeElement(AXUIElementCreateApplication(absentPid))
    refused("text_unavailable", "Element has no readable AXValue. Call snapshot/screenshot and choose a text-bearing ref.", ["cmd": "axReadText", "elementRef": absentRef, "offset": -3, "limit": 0])

    // Look admission: argument checks and capturability come before ownership.
    refused("invalid_args", "readText must be auto, always, or never", ["cmd": "look", "windowId": 42, "readText": "sometimes"])
    refused("root_not_capturable", "Root has no capturable window (unpaired with any on-screen window); use semantic observation (mode: semantic)", ["cmd": "look", "includeImage": true])
    expect(owners.isEmpty, "rejected looks never resolve a window owner")

    // A CG-only menu root is described without AX or capture and owns a fresh look id. Its frame comes
    // from the live CG window list, so only host-independent fields are asserted.
    let menuWindowId = UInt32.max - 1
    var lookIds: [String] = []
    for index in 1...9 {
        if index == 9 {
            // Eight retained looks still hold the first: the lookup succeeds and only the point is missing.
            refused("invalid_args", "Missing numeric argument 'x'", ["cmd": "hitTest", "lookId": "look_1"])
        }
        let menu = try call(["cmd": "look", "windowId": Int(menuWindowId), "windowRef": "cgmenu:\(index)", "includeImage": true, "readText": "always"])
        let window = menu["window"] as? [String: Any]
        let outline = menu["outline"] as? [String: Any]
        let timings = menu["timings"] as? [String: Any]
        let pairing = (window?["metadata"] as? [String: Any])?["pairing"] as? [String: Any]
        expect(menu["image"] == nil && menu["readText"] == nil, "menu looks never capture or OCR")
        expect(window?["windowId"] as? Int == Int(menuWindowId) && window?["rootRef"] as? String == "cgmenu:\(index)" && window?["kind"] as? String == "menu" && window?["role"] as? String == "AXMenu" && window?["isModal"] as? Bool == false, "menu look reports the requested CG menu root")
        expect(window?["framePoints"] is [String: Any] && pairing?["confidence"] as? String == "low", "menu look reports a frame and low pairing confidence")
        expect(outline?["ref"] as? String == "cgmenu:\(index)" && outline?["role"] as? String == "AXMenu" && outline?["title"] as? String == "Menu" && outline?["pictureOnly"] as? Bool == true && (outline?["children"] as? [Any])?.isEmpty == true, "menu outline is one picture-only node")
        expect(timings?["captureMs"] as? Int == 0 && timings?["describeMs"] as? Int == 0, "menu looks report zero capture and describe time")
        lookIds.append(menu["lookId"] as? String ?? "")
    }
    expect(lookIds == (1...9).map { "look_\($0)" }, "each look mints the next look id")
    expect(owners == Array(repeating: menuWindowId, count: 9), "menu looks resolve ownership through the CG window id")

    // Hit tests need a retained look: the ninth look evicted only the first. No probe carries a point,
    // so the missing-coordinate error proves the lookup succeeded and nothing reaches the live hit test.
    refused("invalid_args", "Missing string argument 'lookId'", ["cmd": "hitTest"])
    refused("stale_look", "Look id 'look_1' is no longer available", ["cmd": "hitTest", "lookId": "look_1"])
    refused("invalid_args", "Missing numeric argument 'x'", ["cmd": "hitTest", "lookId": "look_2"])
    refused("stale_look", "Look id 'look_404' is no longer available", ["cmd": "hitTest", "lookId": "look_404"])

    // Desktop input validates the action before any pointer, keyboard, clipboard or Launch Services call.
    refused("invalid_args", "Missing string argument 'action'", ["cmd": "desktopInput"])
    refused("invalid_args", "moveMouse requires x and y", ["cmd": "desktopInput", "action": "moveMouse", "x": 10])
    refused("invalid_args", "click requires x and y", ["cmd": "desktopInput", "action": "click", "y": 10])
    refused("invalid_args", "Unknown desktop action 'teleport'", ["cmd": "desktopInput", "action": "teleport", "button": "right"])
    refused("invalid_args", "Missing string argument 'text'", ["cmd": "desktopInput", "action": "writeClipboard"])
    refused("invalid_args", "Missing string argument 'app'", ["cmd": "desktopInput", "action": "activateApp"])
    // No app can hold these names, so even a regressed guard cannot reach `/usr/bin/open`.
    let missingApp = "pi-cu-absent-fixture-\(UUID().uuidString)"
    for app in ["/Applications/\(missingApp).app", "\(missingApp)/Helper"] {
        refused("invalid_args", "activateApp requires an app name or bundle id (no paths)", ["cmd": "desktopInput", "action": "activateApp", "app": app])
    }
    refused("app_not_found", "No running or installed app named '\(missingApp)'", ["cmd": "desktopInput", "action": "activateApp", "app": " \(missingApp) "])

    print("macos request admission assertions passed")
}
