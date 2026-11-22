import ApplicationServices
import Carbon.HIToolbox
import Foundation

private final class ActFixture {
    // Opaque handles only. No AX query is made on either handle.
    let element = AXUIElementCreateApplication(1234)
    let other = AXUIElementCreateApplication(1235)
    let bridge: Bridge
    let useNativeKeyboard: Bool
    var onValueRead: () -> Void = {}
    var onAttributeWrite: (String) -> Void = { _ in }
    var rejectSelection = false
    var onSleep: (useconds_t) -> Void = { _ in }

    init(inputSink: NativeInputSink? = nil) {
        useNativeKeyboard = inputSink != nil
        if let inputSink {
            bridge = Bridge(activityGlow: nil, inputSink: inputSink)
        } else {
            bridge = Bridge(activityGlow: nil)
        }
    }
    let point = CGPoint(x: 110, y: 220)
    var hasImage = true
    var web = false
    var supported = true
    var value = "before"
    var hits: [AXUIElement] = []
    var statuses: [AXError] = []
    var refind = true
    var scrollResult: [String: Any] = [:]
    var scrollPositions = ["before", "after"]
    var bar: ActWorld.ScrollBarWrite?
    var admissionOverride: FocusCheck?
    var blocked = false
    var blockDuringSnapshot = false
    var blockDuringLayout = false
    var focusFails = false
    var pasteCode: UInt16? = 9
    var range: CFTypeRef?
    var trace: [String] = []
    var lookups: [String] = []
    var pointers: [CGPoint] = []

    var world: ActWorld {
        let keyboard = useNativeKeyboard ? bridge.actionWorld() : nil
        return ActWorld(
            lookRecord: { id in
                self.lookups.append(id)
                guard id == "look" else { return nil }
                return LookRecord(lookId: id, windowId: 8, windowFrame: CGRect(x: 100, y: 200, width: 300, height: 200), imageWidth: 300, imageHeight: 200, hasImage: self.hasImage)
            },
            cachedElement: { $0 == "ref" ? self.element : nil },
            refindElement: { ref, pid, window, _ in
                self.trace.append("refind:\(ref):\(pid):\(window ?? 0)")
                return self.refind && ref == "ref" ? self.other : nil
            },
            copyAttribute: { _, _ in self.range },
            stringAttribute: { _, attribute in
                switch attribute as String {
                case kAXRoleAttribute: return "AXButton"
                case kAXValueAttribute:
                    self.onValueRead()
                    return self.value
                default: return nil
                }
            },
            frame: { _ in CGRect(x: 100, y: 200, width: 20, height: 40) },
            hasAncestorRole: { _, _ in self.web },
            supportsAction: { _, _ in self.supported },
            performAction: { element, action in
                self.trace.append("ax:\(action):\(element === self.element ? "cached" : "refound")")
                let status = self.statuses.isEmpty ? .success : self.statuses.removeFirst()
                if status == .success { self.value = "pressed" }
                return status
            },
            setAttribute: { _, attribute, raw in
                self.trace.append("set:\(attribute)")
                self.onAttributeWrite(attribute as String)
                switch attribute as String {
                case kAXValueAttribute: self.value = raw as? String ?? ""
                case kAXSelectedTextRangeAttribute:
                    if self.rejectSelection { return .cannotComplete }
                    self.range = raw
                default: break
                }
                return .success
            },
            hitTest: { _ in
                self.trace.append("hit")
                return self.hits.isEmpty ? self.element : self.hits.removeFirst()
            },
            sameElement: { $0 === $1 }, isDescendant: { _, _ in false }, describeElement: { _ in "other" },
            sheetCount: { _, _ in 0 }, focusedWindow: { _ in "none" },
            activateIfInactive: { _ in self.trace.append("activate"); return true },
            raiseWindow: { _, _ in self.trace.append("raise"); return true },
            animateCursor: { _, window in self.trace.append("cursor:\(window)") },
            requireTargetFocus: { pid in
                self.trace.append("require:\(pid)")
                if self.focusFails { throw BridgeFailure(message: "focus fixture", code: "focus_not_acquired") }
            },
            keyboardAdmission: { blocked, _ in { force in
                if let override = self.admissionOverride { return try override(force) }
                guard let blocked else { return }
                expect(blocked.last == "com.example.Vault" && blocked.contains("com.apple.SecurityAgent"), "keyboard refusal receives request and built-in blocks")
                self.trace.append("keyboard")
                try self.checkBlocked()
            } },
            refuseBlockedPoints: { points, blocked in
                expect(blocked.last == "com.example.Vault" && blocked.contains("com.apple.SecurityAgent"), "pointer refusal receives request and built-in blocks")
                self.trace.append("pointer")
                self.pointers = points
                try self.checkBlocked()
            },
            beginRootDelta: { pid in
                self.trace.append("begin:\(pid)")
                return { self.trace.append("finish"); return $0 }
            },
            lockInput: { self.trace.append("lock") }, unlockInput: { self.trace.append("unlock") },
            sleep: { self.trace.append("sleep:\($0)"); self.onSleep($0) },
            scrollSignature: { _ in self.scrollPositions.isEmpty ? "after" : self.scrollPositions.removeFirst() },
            scrollAction: { _, request in
                expect(request.point == self.point, "scroll dispatch passes the grounded point to AX actions")
                self.trace.append("scrollAX:\(request.targetPid):\(request.scrollX):\(request.scrollY):\(request.steps)")
                return self.scrollResult
            },
            scrollBar: { _, request in
                expect(request.point == self.point, "scroll dispatch passes the grounded point to AX bars")
                self.trace.append("bar:\(request.scrollX):\(request.scrollY)")
                return self.bar
            },
            postMouseClick: { point, pid, button, count, delivery in
                expect(point == self.point, "click uses the grounded point")
                self.trace.append("click:\(pid):\(button.rawValue):\(count):\(delivery)")
            },
            postMouseMove: { _, pid, delivery in self.trace.append("move:\(pid):\(delivery)") },
            postScrollWheel: { _, x, y, pid, delivery in self.trace.append("wheel:\(pid):\(x):\(y):\(delivery)") },
            postMouseDrag: { points, pid, delivery in
                expect(points == [self.point, CGPoint(x: 130, y: 240), CGPoint(x: 150, y: 260)], "ground every drag vertex")
                self.trace.append("drag:\(pid):\(delivery)")
            },
            postKeyPress: { keys, pid, delivery, beforeKeyDown in
                if let keyboard { return try keyboard.postKeyPress(keys, pid, delivery, beforeKeyDown) }
                try beforeKeyDown(false, true)
                self.trace.append("key:\(keys.joined(separator: "+")):\(pid):\(delivery)")
            },
            postKeyCode: { code, flags, pid, delivery, beforeKeyDown in
                if let keyboard { return try keyboard.postKeyCode(code, flags, pid, delivery, beforeKeyDown) }
                try beforeKeyDown(false, true)
                expect(flags == .maskCommand, "paste posts command modifier")
                self.trace.append("keyCode:\(code):\(pid):\(delivery)")
            },
            postUnicodeText: { text, pid, delivery, beforeKeyDown in
                if let keyboard { return try keyboard.postUnicodeText(text, pid, delivery, beforeKeyDown) }
                try beforeKeyDown(false, true)
                self.trace.append("type:\(text):\(pid):\(delivery)")
                self.value = text
            },
            postAtomicUnicodeText: { text, pid, delivery, beforeKeyDown in
                if let keyboard { return try keyboard.postAtomicUnicodeText(text, pid, delivery, beforeKeyDown) }
                try beforeKeyDown(false, true)
                self.trace.append("atomic:\(text):\(pid):\(delivery)")
                self.value = text
            },
            snapshotClipboard: { text in
                self.trace.append("snapshot")
                if self.blockDuringSnapshot { self.blocked = true }
                return (write: { self.trace.append("clipboard:\(text)") }, restore: {
                    self.trace.append("restore")
                    return true
                })
            },
            pasteKeyCode: {
                self.trace.append("layout")
                if self.blockDuringLayout { self.blocked = true }
                return self.pasteCode
            }
        )
    }

    private func checkBlocked() throws {
        if blocked { throw BridgeFailure(message: "blocked fixture", code: "app_blocked") }
    }

    func request(_ action: String, policy: String = "default", coords: Bool = false, params: [String: Any] = [:]) -> [String: Any] {
        let target: [String: Any] = coords ? ["x": 10, "y": 20] : ["ref": "ref"]
        return ["lookId": "look", "pid": 1234, "action": action, "policy": policy, "params": params,
                "target": target, "blockedBundleIds": ["com.example.Vault"]]
    }

    func act(_ action: String, policy: String = "default", coords: Bool = false, params: [String: Any] = [:]) throws -> [String: Any] {
        try bridge.act(request(action, policy: policy, coords: coords, params: params), world: world, supportsAgentCursor: true)
    }
}

private func actionFailure(_ code: String, message: String? = nil, postedUnits: Int? = nil, _ body: () throws -> [String: Any]) throws {
    do {
        _ = try body()
        expect(false, "expected action failure \(code)")
    } catch let error as BridgeFailure {
        expect(error.code == code, "expected \(code), got \(error.code)")
        if let message { expect(error.message == message, "expected '\(message)', got '\(error.message)'") }
        if let postedUnits {
            let bytes = try JSONSerialization.data(withJSONObject: error.wireError)
            let wire = try JSONSerialization.jsonObject(with: bytes) as? [String: Any]
            expect(wire?["code"] as? String == code && (wire?["evidence"] as? [String: Int])?["postedUnits"] == postedUnits,
                   "serialized \(code) distinguishes \(postedUnits) posted keyboard units")
        }
    }
}

func runActAssertions() throws {
    try runPointerAssertions()
    try runKeyboardActionAssertions()
    try runPasteFailureAssertions()
    try runScrollAssertions()
    runAXScrollAssertions()
    try runBatchAssertions()
    try runRootPIDAssertions()
    try runPIDAdmissionAssertions()
    expect(suppressionTapShouldReenable(.tapDisabledByTimeout) && suppressionTapShouldReenable(.tapDisabledByUserInput), "re-enable the tap on either disable notification")
    expect(!suppressionTapShouldReenable(.keyDown) && !suppressionTapShouldReenable(.mouseMoved), "ordinary user events stay suppressed")
    try runEventAssertions()
    print("macos action dispatch assertions passed")
}

private func runPointerAssertions() throws {
    let press = ActFixture()
    press.statuses = [.invalidUIElement, .success]
    let pressed = try press.act("press", policy: "background")
    expect(pressed["outcome"] as? String == "worked", "AX press sees value change")
    expect(press.trace == ["begin:1234", "ax:AXPress:cached", "refind:ref:1234:8", "ax:AXPress:refound", "cursor:8", "finish"], "AX press refinds once and never posts input")

    let fg = ActFixture()
    fg.web = true
    try actionFailure("foreground_required") { try fg.act("click", policy: "background") }
    expect(fg.trace == ["begin:1234"], "background web click requests foreground without posting")
    fg.trace = []
    fg.hits = [fg.other, fg.element]
    let clicked = try fg.act("click", policy: "foreground", params: ["button": "right", "clickCount": 9])
    expect((clicked["performed"] as? [String: Any])?["delivery"] as? String == "hid", "foreground click records HID delivery")
    expect(fg.trace == ["begin:1234", "lock", "activate", "raise", "sleep:20000", "hit", "activate", "raise", "sleep:20000", "sleep:20000", "hit", "pointer", "click:1234:1:3:hid", "finish", "unlock"], "foreground click retries after focus and checks blocking immediately before posting")
    fg.trace = []
    fg.hits = Array(repeating: fg.other, count: 4)
    try actionFailure("occluded_target") { try fg.act("click", policy: "foreground") }
    expect(fg.trace.filter { $0 == "hit" }.count == 4 && fg.trace.last == "unlock" && !fg.trace.contains { $0.hasPrefix("click:") }, "persistent occlusion stops after four hits and releases lock")

    let drag = ActFixture()
    let path = [["x": 10, "y": 20], ["x": 30, "y": 40], ["x": 50, "y": 60]]
    drag.blocked = true
    try actionFailure("app_blocked") { try drag.act("drag", coords: true, params: ["path": path]) }
    expect(drag.pointers == [drag.point, CGPoint(x: 130, y: 240), CGPoint(x: 150, y: 260)], "HID drag checks all vertices before posting")
    expect(drag.trace.last == "unlock" && !drag.trace.contains("drag:1234:hid"), "blocked drag does not post and releases lock")
    drag.trace = []
    _ = try drag.act("drag", policy: "background", coords: true, params: ["path": path])
    expect(drag.trace == ["begin:1234", "cursor:8", "drag:1234:pid", "finish"], "PID drag skips HID focus, preflight and lock")
    try actionFailure("invalid_args") { try drag.act("drag", coords: true, params: ["path": [path[0], ["x": 3]]]) }
    try actionFailure("foreground_required") { try drag.act("moveMouse", policy: "ax_only", coords: true) }
    drag.trace = []
    _ = try drag.act("moveMouse", coords: true, params: ["delivery": "pid"])
    expect(drag.trace == ["begin:1234", "cursor:8", "move:1234:pid", "finish"], "explicit PID movement uses the PID sink")
    drag.hasImage = false
    try actionFailure("coordinate_unavailable_for_root") { try drag.act("click", coords: true) }
}

private func runKeyboardActionAssertions() throws {
    let keys = ActFixture()
    keys.blocked = true
    try actionFailure("app_blocked") { try keys.act("keypress", coords: true, params: ["keys": ["cmd", "a"]]) }
    expect(keys.trace.suffix(3) == ["require:1234", "keyboard", "unlock"], "blocked keypress checks after focus and never posts")
    keys.trace = []
    keys.blocked = false
    let typed = try keys.act("typeText", params: ["text": "🙂", "preserveFocus": true])
    expect(typed["outcome"] as? String == "worked", "typing checks the value changed")
    expect(keys.trace == ["begin:1234", "set:AXFocused", "lock", "keyboard", "keyboard", "type:🙂:1234:hid", "sleep:30000", "finish", "unlock"], "preserveFocus skips activation, not the blocked-keyboard check")
    keys.trace = []
    _ = try keys.act("keypress", policy: "background", params: ["keys": ["cmd", "a"]])
    expect(keys.trace == ["begin:1234", "set:AXFocused", "set:AXSelectedTextRange", "key:cmd+a:1234:pid", "finish"], "PID cmd+a primes AX selection before the chord")
    let selected = try keys.act("selectText", policy: "ax_only", params: ["start": 0, "length": 2])
    expect(selected["outcome"] as? String == "worked", "selection verifies UTF-16 readback")
    try actionFailure("invalid_args") { try keys.act("selectText", params: ["start": 0, "length": 3]) }
    let set = try keys.act("setText", policy: "ax_only", params: ["text": "replacement"])
    expect(set["outcome"] as? String == "worked" && keys.value == "replacement", "AX value write verifies readback")
    keys.web = true
    try actionFailure("foreground_required") { try keys.act("setText", policy: "ax_only") }
    keys.trace = []
    _ = try keys.act("setText", policy: "background", params: ["text": "new"])
    expect(keys.trace.contains("atomic:new:1234:pid"), "web replacement posts atomic text after selecting the original value")
    keys.trace = []
    _ = try keys.act("paste", coords: true, params: ["text": "temporary", "preserveFocus": true])
    expect(Array(keys.trace.prefix(9)) == ["begin:1234", "lock", "keyboard", "snapshot", "keyboard", "clipboard:temporary", "layout", "keyboard", "keyCode:9:1234:hid"], "paste checks focus before reading, before writing and after layout lookup")
    expect(keys.trace.suffix(3) == ["restore", "finish", "unlock"], "paste restores before finish and unlock")
    keys.trace = []
    keys.statuses = [.cannotComplete]
    let secondary = try keys.act("secondaryAction", policy: "ax_only", params: ["name": "AXShowMenu"])
    expect(secondary["outcome"] as? String == "unknown" && keys.trace == ["begin:1234", "ax:AXShowMenu:cached", "finish"], "ambiguous secondary action failure is not retried")
}

private func runPasteFailureAssertions() throws {
    let params: [String: Any] = ["text": "temporary", "preserveFocus": true]
    let first = ActFixture()
    first.blocked = true
    try actionFailure("app_blocked") { try first.act("paste", coords: true, params: params) }
    expect(first.trace == ["begin:1234", "lock", "keyboard", "unlock"], "first refusal never touches the clipboard or posts")

    let second = ActFixture()
    second.blockDuringSnapshot = true
    try actionFailure("app_blocked") { try second.act("paste", coords: true, params: params) }
    expect(second.trace == ["begin:1234", "lock", "keyboard", "snapshot", "keyboard", "unlock"], "focus change during snapshot refuses without publishing, restoring or posting Cmd+V")

    let third = ActFixture()
    third.blockDuringLayout = true
    try actionFailure("app_blocked") { try third.act("paste", coords: true, params: params) }
    expect(third.trace == ["begin:1234", "lock", "keyboard", "snapshot", "keyboard", "clipboard:temporary", "layout", "keyboard", "restore", "unlock"], "post-layout refusal restores the clipboard without posting Cmd+V")

    let layout = ActFixture()
    layout.pasteCode = nil
    try actionFailure("layout_unsupported", message: "The active keyboard layout is unreadable, so cmd+v cannot be sent") {
        try layout.act("paste", coords: true, params: params)
    }
    expect(layout.trace == ["begin:1234", "lock", "keyboard", "snapshot", "keyboard", "clipboard:temporary", "layout", "restore", "unlock"], "unreadable layout restores without rechecking or posting")

    let focus = ActFixture()
    focus.focusFails = true
    try actionFailure("focus_not_acquired", message: "focus fixture") {
        try focus.act("paste", coords: true, params: ["text": "temporary"])
    }
    expect(focus.trace == ["begin:1234", "lock", "activate", "raise", "sleep:20000", "require:1234", "unlock"], "failed focus stops before privacy checks, clipboard and input")
}

private func runScrollAssertions() throws {
    let params = ["scrollX": 15, "scrollY": -25]
    let semantic = ActFixture()
    semantic.scrollResult = ["scrolled": true]
    let confirmed = try semantic.act("scroll", policy: "background", params: params)
    expect(confirmed["outcome"] as? String == "worked" && semantic.trace == ["begin:1234", "scrollAX:1234:15:-25:1", "cursor:8", "finish"], "AX scrolling wins before bar or wheel")
    let complete = ActFixture()
    complete.bar = (0.4, 0, 0, false)
    let unknown = try complete.act("scroll", params: params)
    expect(unknown["outcome"] as? String == "unknown" && complete.trace == ["begin:1234", "scrollAX:1234:15:-25:1", "bar:15:-25", "finish"], "accepted unconfirmed bar write never also posts wheel input")
    let partial = ActFixture()
    partial.bar = (0.4, 15, 0, true)
    let strict = try partial.act("scroll", policy: "ax_only", params: params)
    expect((strict["evidence"] as? [String: Any])?["unmovedScrollX"] as? Int == 15 && !partial.trace.contains("wheel:1234:15:0:hid"), "strict partial scroll reports remaining axes without synthesizing events")
    partial.trace = []
    _ = try partial.act("scroll", policy: "background", params: params)
    expect(partial.trace.contains("wheel:1234:15:0:pid"), "partial bar write passes only the remaining axis to the wheel")
    partial.trace = []
    partial.blocked = true
    let refused = try partial.act("scroll", params: params)
    let error = (refused["evidence"] as? [String: Any])?["error"] as? [String: String]
    expect(refused["outcome"] as? String == "unknown" && error?["code"] == "app_blocked" && partial.trace.last == "unlock", "wheel refusal retains partial delivery evidence")
    let fallback = ActFixture()
    _ = try fallback.act("scroll", policy: "background", params: params)
    expect(fallback.trace.contains("wheel:1234:15:-25:pid"), "wheel fallback preserves both axes when AX cannot scroll")
}

private func runAXScrollAssertions() {
    let fixture = ActFixture()
    let leaf = fixture.element
    let inner = fixture.other
    let area = AXUIElementCreateApplication(1236)
    var hit = leaf
    var areaPid: Int32 = 1234
    var trace: [String] = []
    let world = AXScrollWorld(
        pid: { $0 === area ? areaPid : 1234 },
        parent: { $0 === leaf ? inner : ($0 === inner ? area : nil) },
        supportsAction: { $0 === area && ($1 as String).hasPrefix("AXScroll") },
        performAction: { _, action in trace.append(action as String); return .success },
        role: { $0 === area ? kAXScrollAreaRole : kAXGroupRole },
        hitTest: { point, pid in
            expect(point == fixture.point, "scroll traversal hit-tests the exact grounded point")
            trace.append("hit:\(pid ?? 0)")
            return hit
        },
        sameElement: { $0 === $1 },
        writeBar: { _, attribute, delta, vertical in
            trace.append("\(attribute):\(delta)")
            return vertical ? (.unconfirmed, nil) : (.notWritten, nil)
        }
    )
    let bridge = fixture.bridge
    let request = ActScrollRequest(targetPid: 1234, scrollX: 3, scrollY: -4, steps: 2, point: fixture.point)
    let action = bridge.performScrollActionOrAncestor(startingAt: leaf, request: request, world: world)
    expect(action["scrolled"] as? Bool == true && trace == ["AXScrollUp", "AXScrollRight", "AXScrollUp", "AXScrollRight"], "distinct axes select the directions and steps repeat the pair")
    trace = []
    let opposite = ActScrollRequest(targetPid: 1234, scrollX: -3, scrollY: 4, steps: 1, point: nil)
    let reversed = bridge.performScrollActionOrAncestor(startingAt: leaf, request: opposite, world: world)
    expect(reversed["scrolled"] as? Bool == true && trace == ["AXScrollDown", "AXScrollLeft"], "ancestor scroll actions support reversed directions")
    trace = []
    let bars = bridge.setScrollBarValueOrAncestor(startingAt: leaf, request: request, world: world)
    expect(bars?.remainingX == 3 && bars?.remainingY == 0 && bars?.confirmed == false && trace == ["hit:1234", "AXVerticalScrollBar:-4", "AXHorizontalScrollBar:3"], "same-area hit allows the ancestor write and consumes even an unconfirmed axis")
    trace = []
    hit = AXUIElementCreateApplication(9876)
    let outside = bridge.setScrollBarValueOrAncestor(startingAt: leaf, request: request, world: world)
    expect(outside == nil && trace == ["hit:1234"], "unrelated hit cannot authorize an outer scroll bar write")
    trace = []
    areaPid = 4321
    let wrongPid = bridge.performScrollActionOrAncestor(startingAt: leaf, request: request, world: world)
    expect(wrongPid["reason"] as? String == "pid_mismatch" && trace.isEmpty, "ancestor scroll stops before an action in another process")
}

private func runBatchAssertions() throws {
    let fixture = ActFixture()
    let press = fixture.request("press", policy: "ax_only")
    let success = try fixture.bridge.actBatch(["actions": [press, fixture.request("setText", policy: "ax_only", params: ["text": "ok"])]], world: fixture.world, supportsAgentCursor: false)
    expect(success["outcome"] as? String == "worked" && fixture.trace == ["begin:1234", "ax:AXPress:cached", "set:AXValue", "finish"], "all-AX batch has one root delta and no physical lock")
    fixture.trace = []
    let result = try fixture.bridge.actBatch(["actions": [fixture.request("moveMouse", policy: "background", coords: true), fixture.request("drag", coords: true), press]], world: fixture.world, supportsAgentCursor: false)
    let steps = result["steps"] as? [[String: Any]]
    expect(result["outcome"] as? String == "didnt" && result["stoppedAt"] as? Int == 1 && steps?.count == 2, "batch stops at the failed step")
    expect(fixture.trace == ["begin:1234", "lock", "move:1234:pid", "lock", "activate", "raise", "sleep:20000", "unlock", "finish", "unlock"], "batch keeps the outer lock through finish and does not execute the trailing press")
    fixture.trace = []
    let aliasedPid = 1234 + (1 << 32)
    for pid in [aliasedPid, Int(Int32.min) - 1, Int(Int32.max) + 1, Int.max] {
        var invalid = press
        invalid["pid"] = NSNumber(value: pid)
        try actionFailure("invalid_args") { try fixture.bridge.actBatch(["actions": [press, invalid]], world: fixture.world, supportsAgentCursor: false) }
        try actionFailure("invalid_args") { try fixture.bridge.actBatch(["actions": [invalid, press]], world: fixture.world, supportsAgentCursor: false) }
        try actionFailure("invalid_args") { try fixture.bridge.act(invalid, world: fixture.world, supportsAgentCursor: false) }
        expect(fixture.trace.isEmpty, "an invalid PID must not start or execute any action")
    }
    try actionFailure("invalid_args") { try fixture.bridge.actBatch(["actions": [press, press.merging(["pid": 999]) { _, new in new }]], world: fixture.world, supportsAgentCursor: false) }
    try actionFailure("invalid_args") { try fixture.bridge.actBatch(["actions": [press, press.merging(["lookId": "unrelated"]) { _, new in new }]], world: fixture.world, supportsAgentCursor: false) }
    try actionFailure("invalid_args") { try fixture.bridge.actBatch(["actions": Array(repeating: press, count: 21)], world: fixture.world, supportsAgentCursor: false) }
    expect(fixture.trace.isEmpty, "invalid batches have no root or input side effects")
}

private func runRootPIDAssertions() throws {
    let bridge = Bridge(activityGlow: nil, readSession: { nil })
    var discovered: [Int32?] = []
    func listRoots(_ json: String) throws -> [String: Any] {
        let request = try JSONSerialization.jsonObject(with: Data(json.utf8)) as! [String: Any]
        return try bridge.handleRequest(request, clientID: nil, discoverRoots: { pid, title in
            discovered.append(pid)
            expect(title == "Fixture", "listRoots preserves the title filter")
            return ["roots": []]
        }) as! [String: Any]
    }
    _ = try listRoots(#"{"cmd":"listRoots","title":"Fixture","pid":null}"#)
    _ = try listRoots(#"{"cmd":"listRoots","title":"Fixture"}"#)
    _ = try listRoots(#"{"cmd":"listRoots","title":"Fixture","pid":"not numeric"}"#)
    _ = try listRoots(#"{"cmd":"listRoots","title":"Fixture","pid":1234}"#)
    try actionFailure("invalid_args") {
        try listRoots(#"{"cmd":"listRoots","title":"Fixture","pid":4294968530}"#)
    }
    try actionFailure("invalid_args") {
        try listRoots(#"{"cmd":"listRoots","title":"Fixture","pid":18446744073709551615}"#)
    }
    _ = try listRoots(#"{"cmd":"listRoots","title":"Fixture","pid":2147483647}"#)
    try actionFailure("invalid_args", message: "pid must be a 32-bit integer") {
        try listRoots(#"{"cmd":"listRoots","title":"Fixture","pid":2147483648}"#)
    }
    expect(discovered == [nil, nil, nil, 1234, 2147483647], "listRoots discovers unfiltered for null, missing and nonnumeric PIDs, and never discovers for out-of-range PIDs")
}

private func runPIDAdmissionAssertions() throws {
    let fixture = ActFixture()
    var failures: [String] = []
    func check(_ label: String, code: String = "invalid_args", message: String, _ run: () throws -> Any) throws {
        do {
            _ = try run()
            failures.append("\(label): expected \(code)")
        } catch let error as BridgeFailure {
            if error.code != code || error.message != message {
                failures.append("\(label): got \(error.code): \(error.message)")
            }
        }
    }
    let pidError = "pid must be a 32-bit integer"
    for lookId in ["stale", nil] as [String?] {
        var request = fixture.request("click", policy: "background", coords: true)
        request["pid"] = 2147483648
        request["lookId"] = lookId
        try check(lookId ?? "missing look", message: pidError) {
            try fixture.bridge.act(request, world: fixture.world, supportsAgentCursor: false)
        }
    }
    if !fixture.lookups.isEmpty || !fixture.trace.isEmpty {
        failures.append("invalid act performed lookups or actions: \(fixture.lookups), \(fixture.trace)")
    }

    let bridge = Bridge(activityGlow: nil, readSession: { nil })
    var observations: [String] = []
    func look(pid: Any?, readText: String, owner: Int32? = 1234) throws -> Any {
        var request: [String: Any] = ["cmd": "look", "windowId": 42, "readText": readText]
        request["pid"] = pid
        return try bridge.handleRequest(request, clientID: nil, lookWindowOwner: { id in
            observations.append("owner:\(id)")
            return owner
        }, lookCapture: { id in
            observations.append("capture:\(id)")
            throw BridgeFailure(message: "capture fixture", code: "fixture_capture")
        })
    }
    try check("overflow look", message: pidError) { try look(pid: 2147483648, readText: "invalid sentinel") }
    if !observations.isEmpty { failures.append("invalid look resolved ownership or captured") }
    try check("wrong owner", code: "pid_mismatch", message: "pid does not match the resolved root owner") {
        try look(pid: 4321, readText: "never")
    }
    if observations != ["owner:42"] { failures.append("wrong owner did not stop at ownership: \(observations)") }
    observations = []
    try check("unresolved owner", code: "root_not_found", message: "Root is not owned by a running app") {
        try look(pid: 1234, readText: "never", owner: nil)
    }
    if observations != ["owner:42"] { failures.append("unresolved owner did not stop before capture: \(observations)") }
    for pid in [nil, NSNull(), 1234] as [Any?] {
        observations = []
        try check("omitted, null or matching owner", code: "fixture_capture", message: "capture fixture") {
            try look(pid: pid, readText: "never")
        }
        if observations != ["owner:42", "capture:42"] { failures.append("look did not resolve ownership before capture: \(observations)") }
    }
    expect(failures.isEmpty, failures.joined(separator: "\n"))
}

private func runEventAssertions() throws {
    struct Event: Equatable {
        let type: CGEventType
        let pid: Int32
        let delivery: String
        var point: CGPoint = .zero
        var data: Int64 = 0
        var flags: CGEventFlags = []
        var text: String = ""
        var horizontal: Int64 = 0
    }
    var events: [Event] = []
    var delays: [useconds_t] = []
    var rejectDragAt: CGPoint?
    var cancelAfterFirstDrag = false
    var rejectNextMouseType: CGEventType?
    var rejectWheel = false
    var keyAllocations = 0
    var rejectKeyAllocation: Int?
    var testLayout: Data?
    var onLayoutLookup: () -> Void = {}
    var onInputSleep: () -> Void = {}
    var onHIDPrepare: () -> Bool = { false }
    var onHIDPost: (CGEventType) -> Void = { _ in }
    func record(_ event: CGEvent, pid: Int32, delivery: String) {
        var entry = Event(type: event.type, pid: pid, delivery: delivery)
        switch event.type {
        case .keyDown, .keyUp:
            entry.data = event.getIntegerValueField(.keyboardEventKeycode)
            entry.flags = event.flags
            var length = 0
            var text = Array(repeating: UInt16(0), count: 64)
            event.keyboardGetUnicodeString(maxStringLength: text.count, actualStringLength: &length, unicodeString: &text)
            entry.text = String(decoding: text.prefix(length), as: UTF16.self)
        case .scrollWheel:
            entry.point = event.location
            entry.data = event.getIntegerValueField(.scrollWheelEventPointDeltaAxis1)
            entry.horizontal = event.getIntegerValueField(.scrollWheelEventPointDeltaAxis2)
        default:
            entry.point = event.location
            entry.data = event.getIntegerValueField(.mouseEventClickState)
        }
        events.append(entry)
    }
    let sink = NativeInputSink(
        mouseEvent: { type, point, button in
            if type == rejectNextMouseType {
                rejectNextMouseType = nil
                return nil
            }
            guard type != .leftMouseDragged || point != rejectDragAt else { return nil }
            return NativeInputSink.createMouseEvent(type, point, button)
        },
        wheelEvent: { vertical, horizontal in
            rejectWheel ? nil : NativeInputSink.createWheelEvent(vertical, horizontal)
        },
        keyEvent: { code, down in
            keyAllocations += 1
            return keyAllocations == rejectKeyAllocation ? nil : NativeInputSink.createKeyEvent(code, down)
        },
        postToPid: { record($0, pid: $1, delivery: "pid") },
        prepareHID: { _ in onHIDPrepare() },
        postHID: { record($0, pid: $1, delivery: "hid"); onHIDPost($0.type) },
        sleep: { delays.append($0); onInputSleep() },
        keyboardInputSource: {
            onLayoutLookup()
            return KeyboardInputSource(isKeyboardLayout: testLayout != nil, layoutData: testLayout)
        },
        checkCancellation: {
            if cancelAfterFirstDrag && events.last?.type == .leftMouseDragged { throw CancellationError() }
        }
    )
    let world = Bridge(activityGlow: nil, inputSink: sink).actionWorld()
    let start = CGPoint(x: 100, y: 200)
    let midpoint = CGPoint(x: 112, y: 200)
    let end = CGPoint(x: 124, y: 200)
    func mouse(_ type: CGEventType, _ point: CGPoint, _ data: Int64 = 0, delivery: String = "pid") -> Event {
        Event(type: type, pid: 1234, delivery: delivery, point: point, data: data)
    }
    try world.postMouseClick(start, 1234, .right, 2, "pid")
    expect(events == [mouse(.mouseMoved, start), mouse(.rightMouseDown, start, 1), mouse(.rightMouseUp, start, 1), mouse(.rightMouseDown, start, 2), mouse(.rightMouseUp, start, 2)] && delays == [12_000, 70_000, 12_000], "PID double click emits ordered pairs with click-state increments and delays")
    events = []; delays = []
    try world.postMouseDrag([start, end], 1234, "pid")
    expect(events == [mouse(.mouseMoved, start), mouse(.leftMouseDown, start, 1), mouse(.leftMouseDragged, midpoint, 1), mouse(.leftMouseDragged, end, 1), mouse(.leftMouseUp, end, 1)] && delays == [30_000, 8_000, 8_000], "drag interpolates and releases at destination")
    events = []; delays = []
    rejectDragAt = end
    try actionFailure("input_failed", message: "Failed to create mouse drag event") {
        try world.postMouseDrag([start, end], 1234, "pid")
        return [:]
    }
    expect(events == [mouse(.mouseMoved, start), mouse(.leftMouseDown, start, 1), mouse(.leftMouseDragged, midpoint, 1), mouse(.leftMouseUp, midpoint, 1)], "drag creation failure releases at last posted position")
    events = []; delays = []
    rejectDragAt = nil
    cancelAfterFirstDrag = true
    do {
        try world.postMouseDrag([start, end], 1234, "pid")
        expect(false, "cancelled drag must throw")
    } catch is CancellationError {
        expect(events == [mouse(.mouseMoved, start), mouse(.leftMouseDown, start, 1), mouse(.leftMouseDragged, midpoint, 1), mouse(.leftMouseUp, midpoint, 1)], "cancelled drag releases once at the last posted position")
    }
    cancelAfterFirstDrag = false
    events = []; delays = []
    rejectNextMouseType = .leftMouseUp
    try actionFailure("input_failed", message: "Failed to create mouse up event") {
        try world.postMouseDrag([start, end], 1234, "pid")
        return [:]
    }
    expect(rejectNextMouseType == nil && events.isEmpty && delays.isEmpty, "failed mouse-up reservation posts no mouse-down or other input")
    events = []; delays = []
    try world.postScrollWheel(start, 15, -25, 1234, "hid")
    expect(events == [mouse(.mouseMoved, start, delivery: "hid"), Event(type: .scrollWheel, pid: 1234, delivery: "hid", point: start, data: 25, horizontal: -15)] && delays.isEmpty, "HID wheel emits signed vertical and horizontal deltas at the point")
    events = []; delays = []
    try world.postKeyPress([" Cmd + Shift + a ", "tab"], 1234, "pid", { _, _ in })
    let flags: CGEventFlags = [.maskCommand, .maskShift]
    expect(events.map(\.type) == [.keyDown, .keyUp, .keyDown, .keyUp] && events.map(\.data) == [0, 0, 48, 48] && events.map(\.flags) == [flags, flags, [], []] && events.allSatisfy { $0.pid == 1234 && $0.delivery == "pid" } && delays == [8_000, 8_000], "key sequence preserves chord flags and keycode order: \(events)")
    events = []; delays = []
    try world.postUnicodeText("a🙂", 1234, "pid", { _, _ in })
    expect(events.map(\.type) == [.keyDown, .keyUp, .keyDown, .keyUp] && events.map(\.text) == ["a", "a", "🙂", "🙂"] && delays == [8_000, 8_000], "unreadable keyboard layout delivers one UTF-16 pair per scalar")
    events = []; delays = []
    try world.postAtomicUnicodeText("a🙂", 1234, "pid", { _, _ in })
    expect(events.map(\.type) == [.keyDown, .keyUp] && events.map(\.text) == ["a🙂", "a🙂"] && delays == [8_000], "atomic replacement delivers the whole text in one pair")

    events = []; delays = []
    rejectNextMouseType = .rightMouseUp
    try actionFailure("input_failed", message: "Failed to create mouse click event") {
        try world.postMouseClick(start, 1234, .right, 2, "pid")
        return [:]
    }
    expect(rejectNextMouseType == nil, "click fixture rejects the first right-button-up allocation")
    expect(events == [mouse(.mouseMoved, start)] && delays.isEmpty, "failed click pair posts neither a partial click nor the next click")

    events = []; delays = []
    rejectWheel = true
    try actionFailure("input_failed", message: "Failed to create scroll event") {
        try world.postScrollWheel(start, 15, -25, 1234, "hid")
        return [:]
    }
    expect(events == [mouse(.mouseMoved, start, delivery: "hid")] && delays.isEmpty, "failed wheel posts only the preceding mouse move")

    events = []; delays = []; keyAllocations = 0
    rejectKeyAllocation = 4
    try actionFailure("input_failed", message: "Failed to create key event") {
        try world.postKeyPress(["a", "tab", "b"], 1234, "pid", { _, _ in })
        return [:]
    }
    expect(events.map(\.type) == [.keyDown, .keyUp] && events.map(\.data) == [0, 0] && keyAllocations == 4 && delays == [8_000], "failed second key pair posts neither a partial pair nor the next key")

    events = []; delays = []; keyAllocations = 0
    try actionFailure("input_failed", message: "Failed to create unicode key event") {
        try world.postUnicodeText("a🙂b", 1234, "pid", { _, _ in })
        return [:]
    }
    expect(events.map(\.type) == [.keyDown, .keyUp] && events.map(\.text) == ["a", "a"] && keyAllocations == 4 && delays == [8_000], "failed second scalar posts neither a partial pair nor the next scalar")

    events = []; delays = []; keyAllocations = 0
    rejectKeyAllocation = 2
    try actionFailure("input_failed", message: "Failed to create unicode text event") {
        try world.postAtomicUnicodeText("a🙂", 1234, "pid", { _, _ in })
        return [:]
    }
    expect(events.isEmpty && keyAllocations == 2 && delays.isEmpty, "failed atomic pair posts nothing")

    rejectKeyAllocation = nil
    keyAllocations = 0
    try world.postKeyCode(9, .maskCommand, 1234, "pid", { _, _ in })
    expect(events.map(\.type) == [.keyDown, .keyUp] && events.map(\.data) == [9, 9], "direct paste chord still posts a pair")

    let typing = ActFixture(inputSink: sink)
    events = []; keyAllocations = 0
    onLayoutLookup = { typing.blocked = true }
    try actionFailure("app_blocked", postedUnits: 0) { try typing.act("typeText", coords: true, params: ["text": "a🙂"]) }
    expect(events.isEmpty && keyAllocations == 0, "layout lookup changes focus before the first typing pair is even allocated")
    onLayoutLookup = {}

    typing.blocked = false
    onInputSleep = { typing.blocked = true }
    try actionFailure("app_blocked", postedUnits: 1) { try typing.act("typeText", coords: true, params: ["text": "a🙂"]) }
    expect(events.map(\.type) == [.keyDown, .keyUp] && events.map(\.text) == ["a", "a"], "typing stops after focus moves during the inter-key delay")
    onInputSleep = {}

    let physicalTyping = ActFixture(inputSink: sink)
    let us = [kTISPropertyInputSourceID as String: "com.apple.keylayout.US"] as CFDictionary
    guard let sources = TISCreateInputSourceList(us, true)?.takeRetainedValue() as? [TISInputSource],
          let source = sources.first, let data = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) else {
        expect(false, "required US keyboard layout is readable")
        return
    }
    testLayout = Unmanaged<CFData>.fromOpaque(data).takeUnretainedValue() as Data
    events = []
    onInputSleep = { physicalTyping.blocked = true }
    try actionFailure("app_blocked", postedUnits: 1) {
        try physicalTyping.act("typeText", coords: true, params: ["text": "Bc"])
    }
    expect(events.map(\.type) == [.keyDown, .keyUp] && events.map(\.data) == [11, 11] && events.allSatisfy { $0.flags.contains(.maskShift) },
           "readable layout posts one physical Shift+B pair and admits no second stroke: \(events)")
    testLayout = nil
    onInputSleep = {}

    let slowTyping = ActFixture(inputSink: sink)
    var clock = 0.0
    var probes = 0
    let admission = KeyboardAdmission(now: { clock }, deadline: 0.15)
    slowTyping.admissionOverride = { force in
        try admission.check(force: force, frontmostPid: { 1234 }, focusedPid: {
            probes += 1
            if probes == 3 { clock += 0.100 }
            return 1234
        }, refuse: { _ in })
    }
    events = []
    onInputSleep = { clock += 0.008 }
    try actionFailure("input_deadline_expired", postedUnits: 8) {
        try slowTyping.act("typeText", coords: true, params: ["text": String(repeating: "a", count: 12)])
    }
    expect(probes == 3 && events.map(\.type) == Array(repeating: [CGEventType.keyDown, .keyUp], count: 8).flatMap { $0 },
           "slow cadence probe expires the deadline after eight complete pairs and stops before another down")
    onInputSleep = {}

    let keys = ActFixture(inputSink: sink)
    events = []; delays = []
    onHIDPrepare = {
        delays.append(20_000)
        keys.blocked = true
        return true
    }
    try actionFailure("app_blocked") { try keys.act("keypress", coords: true, params: ["keys": ["tab"]]) }
    expect(delays == [20_000] && events.isEmpty, "activation wait finishes before admission and no key posts after focus flips")
    var preparations = 0
    onHIDPrepare = { preparations += 1; return false }
    keys.blocked = false
    onHIDPost = { if $0 == .keyDown { keys.blocked = true } }
    try actionFailure("app_blocked") { try keys.act("keypress", coords: true, params: ["keys": ["cmd+a", "tab", "b"]]) }
    expect(events.map(\.type) == [.keyDown, .keyUp] && events.map(\.data) == [0, 0] && events.map(\.flags) == [.maskCommand, .maskCommand], "keypress releases the posted chord after focus moves and refuses the next key")
    expect(preparations == 2, "prepare each attempted key-down but never prepare its owed release")
    onHIDPrepare = { false }
    onHIDPost = { _ in }

    events = []
    try runWebReplacementRefusals(sink: sink) { events.map(\.type) }
}

private func runWebReplacementRefusals(sink: NativeInputSink, posted: () -> [CGEventType]) throws {
    let params = ["text": "replacement"]

    let focus = ActFixture(inputSink: sink)
    focus.web = true
    focus.onAttributeWrite = { [unowned focus] in
        if $0 == kAXFocusedAttribute { focus.blocked = true }
    }
    focus.onValueRead = { [unowned focus] in
        if focus.blocked { focus.trace.append("read:AXValue") }
    }
    try actionFailure("app_blocked") { try focus.act("setText", params: params) }
    expect(!focus.trace.contains("read:AXValue") && posted().isEmpty, "web focus write refuses before the selection read or any post")

    let value = ActFixture(inputSink: sink)
    value.web = true
    value.onValueRead = { [unowned value] in
        if value.trace.contains("set:AXFocused") { value.blocked = true }
    }
    try actionFailure("app_blocked") { try value.act("setText", params: params) }
    expect(!value.trace.contains("set:AXSelectedTextRange") && posted().isEmpty, "web value read refuses before the selection write or any post")

    for reject in [false, true] {
        let selection = ActFixture(inputSink: sink)
        selection.web = true
        selection.rejectSelection = reject
        selection.onAttributeWrite = { [unowned selection] in
            if $0 == kAXSelectedTextRangeAttribute { selection.blocked = true }
        }
        try actionFailure("app_blocked") { try selection.act("setText", params: params) }
        expect(posted().isEmpty, "web selection write refuses both replacement text and fallback Cmd+A (selection rejected: \(reject))")
    }

    let fallback = ActFixture(inputSink: sink)
    fallback.web = true
    fallback.rejectSelection = true
    fallback.onSleep = { [unowned fallback] in
        if $0 == 20_000 && fallback.trace.contains("set:AXSelectedTextRange") { fallback.blocked = true }
    }
    try actionFailure("app_blocked", postedUnits: 1) { try fallback.act("setText", params: params) }
    expect(posted() == [.keyDown, .keyUp], "focus moving during fallback wait stops replacement text after the Cmd+A pair: \(posted()), \(fallback.trace)")
}
