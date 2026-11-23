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
    var windowFrame = CGRect(x: 100, y: 200, width: 300, height: 200)
    var postDrag: (([CGPoint], Int32, String) throws -> Void)?
    var hasImage = true
    var web = false
    var supported = true
    /// When set, only these elements advertise actions (identity match); `supported` applies otherwise.
    var supportedElements: [AXUIElement]?
    /// False makes the cached handle for `ref` unavailable, so `act` refinds it.
    var cached = true
    /// False makes every frame read fail, leaving a ref target without coordinate grounding.
    var frameReadable = true
    /// Scripted `setAttribute` results, consumed first: a failure is returned without writing.
    var writeStatuses: [AXError] = []
    /// Scripted sheet counts, consumed per read: `nil` is a failed read. Falls back to 0 once empty.
    var sheetCounts: [Int?] = []
    var value = "before"
    /// Scripted `AXValue` reads, consumed first: `nil` is a failed read. Falls back to `value` once empty.
    var valueReads: [String?] = []
    var hits: [AXUIElement] = []
    var statuses: [AXError] = []
    var refind = true
    var scrollResult: [String: Any] = [:]
    var scrollPositions = ["before", "after"]
    var bar: ActWorld.ScrollBarWrite?
    var admissionOverride: FocusCheck?
    /// Builds the admission from the deadline `act` resolved, e.g. a `KeyboardAdmission` on a simulated clock.
    var clockedAdmission: ((TimeInterval) -> FocusCheck)?
    var deadlines: [TimeInterval] = []
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
                return LookRecord(lookId: id, windowId: 8, windowFrame: self.windowFrame, imageWidth: 300, imageHeight: 200, hasImage: self.hasImage)
            },
            cachedElement: { $0 == "ref" && self.cached ? self.element : nil },
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
                    return self.valueReads.isEmpty ? self.value : self.valueReads.removeFirst()
                default: return nil
                }
            },
            frame: { _ in self.frameReadable ? CGRect(x: 100, y: 200, width: 20, height: 40) : nil },
            hasAncestorRole: { _, _ in self.web },
            supportsAction: { element, _ in self.supportedElements.map { $0.contains { $0 === element } } ?? self.supported },
            performAction: { element, action in
                self.trace.append("ax:\(action):\(element === self.element ? "cached" : "refound")")
                let status = self.statuses.isEmpty ? .success : self.statuses.removeFirst()
                if status == .success { self.value = "pressed" }
                return status
            },
            setAttribute: { _, attribute, raw in
                self.trace.append("set:\(attribute)")
                self.onAttributeWrite(attribute as String)
                if let status = self.writeStatuses.first {
                    self.writeStatuses.removeFirst()
                    if status != .success { return status }
                }
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
            sheetCount: { _, _ in self.sheetCounts.isEmpty ? 0 : self.sheetCounts.removeFirst() }, focusedWindow: { _ in "none" },
            activateIfInactive: { _ in self.trace.append("activate"); return true },
            raiseWindow: { _, _ in self.trace.append("raise"); return true },
            animateCursor: { _, window in self.trace.append("cursor:\(window)") },
            requireTargetFocus: { pid in
                self.trace.append("require:\(pid)")
                if self.focusFails { throw BridgeFailure(message: "focus fixture", code: "focus_not_acquired") }
            },
            keyboardAdmission: { blocked, deadline in
                self.deadlines.append(deadline)
                if let clocked = self.clockedAdmission { return clocked(deadline) }
                return { force in
                if let override = self.admissionOverride { return try override(force) }
                guard let blocked else { return }
                expect(blocked.last == "com.example.Vault" && blocked.contains("com.apple.SecurityAgent"), "keyboard refusal receives request and built-in blocks")
                self.trace.append("keyboard")
                try self.checkBlocked()
                }
            },
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
                if let post = self.postDrag { return try post(points, pid, delivery) }
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
        expect(error.code == code, "expected \(code), got \(error.code): \(error.message)")
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
    try runActEdgeAssertions()
    try runKeyboardActionAssertions()
    try runPasteFailureAssertions()
    try runScrollAssertions()
    runAXScrollAssertions()
    try runBatchAssertions()
    try runBatchDeadlineAssertions()
    try runRootPIDAssertions()
    try runWindowIDAssertions()
    try runPIDAdmissionAssertions()
    expect(suppressionTapShouldReenable(.tapDisabledByTimeout) && suppressionTapShouldReenable(.tapDisabledByUserInput), "re-enable the tap on either disable notification")
    expect(!suppressionTapShouldReenable(.keyDown) && !suppressionTapShouldReenable(.mouseMoved), "ordinary user events stay suppressed")
    try runEventAssertions()
    runKeyboardDeadlineAssertions()
    try runProductionSinkAssertions()
    print("macos action dispatch assertions passed")
}

private func runPointerAssertions() throws {
    let press = ActFixture()
    press.statuses = [.invalidUIElement, .success]
    let pressed = try press.act("press", policy: "background")
    expect(pressed["outcome"] as? String == "worked", "AX press sees value change")
    expect(press.trace == ["begin:1234", "ax:AXPress:cached", "refind:ref:1234:8", "ax:AXPress:refound", "cursor:8", "finish"], "AX press refinds once and never posts input")
    try runIndeterminatePressAssertions()

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

/// `act` branches the other suites leave unreached: admission refusals, ref resolution, AX write and action
/// refusals with their single refind retry, and the window-change outcome of a coordinate action.
private func runActEdgeAssertions() throws {
    try runActAdmissionEdgeAssertions()
    try runActRefEdgeAssertions()
    try runActSecondaryEdgeAssertions()
    try runActSelectionEdgeAssertions()
    try runActOutcomeEdgeAssertions()
}

/// Requests `act` refuses before resolving or posting anything.
private func runActAdmissionEdgeAssertions() throws {
    let stale = ActFixture()
    var gone = stale.request("press")
    gone["lookId"] = "gone"
    try actionFailure("stale_look", message: "Look id 'gone' is no longer available") {
        try stale.bridge.act(gone, world: stale.world, supportsAgentCursor: true)
    }
    let path = [["x": 10, "y": 20], ["x": 30, "y": 40]]
    var goneDrag = stale.request("drag", coords: true, params: ["path": path])
    goneDrag["lookId"] = "gone"
    try actionFailure("stale_look", message: "Look id 'gone' is no longer available") {
        try stale.bridge.actBatch(["actions": [goneDrag]], world: stale.world, supportsAgentCursor: false)
    }
    expect(stale.trace.isEmpty && stale.lookups == ["gone", "gone"], "a stale look id is refused before any root delta, lock or input: \(stale.trace)")

    let untargeted = ActFixture()
    var half = untargeted.request("click", policy: "background")
    half["target"] = ["x": 10] as [String: Any]
    // No target, params or policy keys at all: the defaults still refuse before a lock.
    let bare: [String: Any] = ["lookId": "look", "pid": 1234, "action": "click"]
    for request in [half, bare] {
        try actionFailure("invalid_args", message: "act target must include ref or x/y") {
            try untargeted.bridge.act(request, world: untargeted.world, supportsAgentCursor: true)
        }
    }
    try actionFailure("invalid_args", message: "paste requires non-empty text") { try untargeted.act("paste", policy: "background") }
    for (action, params) in [("keypress", [:]), ("keypress", ["keys": [String]()])] as [(String, [String: Any])] {
        try actionFailure("invalid_args", message: "keypress requires keys") { try untargeted.act(action, policy: "background", params: params) }
    }
    for action in ["secondaryAction", "selectText"] {
        try actionFailure("invalid_args", message: "\(action) requires a ref") {
            try untargeted.act(action, policy: "background", coords: true, params: ["name": "AXShowMenu", "start": 0])
        }
    }
    // `setText` has no coordinate form: a coordinate target is refused after the root delta, before any post.
    try actionFailure("invalid_args", message: "Action setText cannot use coordinate grounding") {
        try untargeted.act("setText", policy: "background", coords: true, params: ["text": "new"])
    }
    expect(untargeted.trace == Array(repeating: "begin:1234", count: 8), "admission refusals post nothing and take no lock: \(untargeted.trace)")

    // A batch drag with no target or params is refused before the transaction's root delta or lock.
    let batch = ActFixture()
    let unpathed: [String: Any] = ["lookId": "look", "pid": 1234, "action": "drag"]
    try actionFailure("invalid_args") { try batch.bridge.actBatch(["actions": [unpathed]], world: batch.world, supportsAgentCursor: false) }
    expect(batch.trace.isEmpty, "an unpathed batch drag has no side effects: \(batch.trace)")
    // A step without a policy is the default policy, which may post input: the transaction holds the lock.
    var press = batch.request("press")
    press.removeValue(forKey: "policy")
    _ = try batch.bridge.actBatch(["actions": [press]], world: batch.world, supportsAgentCursor: false)
    expect(batch.trace == ["begin:1234", "lock", "ax:AXPress:cached", "finish", "unlock"], "a policy-less batch step locks input around the transaction: \(batch.trace)")
}

/// A cached handle that fails its liveness read is refound once; no handle and no frame are refusals.
private func runActRefEdgeAssertions() throws {
    let refound = ActFixture()
    refound.cached = false
    let pressed = try refound.act("press", policy: "background")
    expect((pressed["performed"] as? [String: Any])?["refound"] as? Bool == true && pressed["outcome"] as? String == "worked", "a missing cached handle is refound and pressed: \(pressed)")
    expect(refound.trace == ["begin:1234", "refind:ref:1234:8", "ax:AXPress:refound", "cursor:8", "finish"], "the refound handle receives the press: \(refound.trace)")

    let gone = ActFixture()
    gone.cached = false
    gone.refind = false
    try actionFailure("stale_ref", message: "Element reference is stale") { try gone.act("press", policy: "background") }
    expect(gone.trace == ["begin:1234", "refind:ref:1234:8"], "a ref that cannot be refound is stale before any action: \(gone.trace)")

    // An unreadable frame fails the cached handle's liveness check, and the refound handle has no frame either.
    let frameless = ActFixture()
    frameless.frameReadable = false
    frameless.supported = false
    try actionFailure("coordinate_unavailable", message: "No coordinate grounding is available") { try frameless.act("click") }
    expect(frameless.trace == ["begin:1234", "refind:ref:1234:8"], "a ref without a frame never locks, focuses or clicks: \(frameless.trace)")

    let unsupported = ActFixture()
    unsupported.supported = false
    let clicked = try unsupported.act("press", policy: "background")
    let performed = clicked["performed"] as? [String: Any]
    expect(performed?["grounding"] as? String == "coordinates" && performed?["verification"] as? String == "caller_required", "a press the element does not advertise is a coordinate click: \(clicked)")
    expect(unsupported.trace == ["begin:1234", "cursor:8", "click:1234:0:1:pid", "finish"], "the fallback click lands on the frame center: \(unsupported.trace)")

    let rewritten = ActFixture()
    rewritten.writeStatuses = [.cannotComplete]
    let set = try rewritten.act("setText", policy: "ax_only", params: ["text": "new"])
    expect(set["outcome"] as? String == "worked" && (set["performed"] as? [String: Any])?["refound"] as? Bool == true, "a refused AXValue write is retried once on the refound handle: \(set)")
    expect(rewritten.trace == ["begin:1234", "set:AXValue", "refind:ref:1234:8", "set:AXValue", "finish"], "the retry writes the refound handle once: \(rewritten.trace)")

    // Both writes refused: the coordinate fallback has no setText form, so it refuses without posting. Only that
    // part is pinned: the error codes and the HID path's focus steal are #1365.
    for policy in ["ax_only", "background"] {
        let refused = ActFixture()
        refused.writeStatuses = [.cannotComplete, .cannotComplete]
        do {
            _ = try refused.act("setText", policy: policy, params: ["text": "new"])
            expect(false, "\(policy) twice-refused AXValue write must not report a result")
        } catch is BridgeFailure {}
        expect(refused.trace == ["begin:1234", "set:AXValue", "refind:ref:1234:8", "set:AXValue"] && refused.value == "before", "\(policy) twice-refused AXValue write posts nothing: \(refused.trace)")
    }
}

/// `secondaryAction` runs only an advertised `AX` action, refinding once for support or a dead handle.
private func runActSecondaryEdgeAssertions() throws {
    let names = ActFixture()
    for name in ["ShowMenu", "AX"] {
        try actionFailure("invalid_args", message: "secondaryAction requires an AX action name") {
            try names.act("secondaryAction", policy: "ax_only", params: ["name": name])
        }
    }
    expect(names.trace == ["begin:1234", "begin:1234"], "a non-AX action name is refused before any action")

    let advertised = ActFixture()
    advertised.supportedElements = [advertised.other]
    let ran = try advertised.act("secondaryAction", policy: "ax_only", params: ["name": "AXShowMenu"])
    expect(ran["outcome"] as? String == "worked" && (ran["performed"] as? [String: Any])?["action"] as? String == "AXShowMenu", "an action only the refound handle advertises runs there: \(ran)")
    expect(advertised.trace == ["begin:1234", "refind:ref:1234:8", "ax:AXShowMenu:refound", "sleep:60000", "finish"], "a successful action waits for async menus before finishing: \(advertised.trace)")

    let missing = ActFixture()
    missing.supportedElements = []
    try actionFailure("action_unsupported", message: "Element does not advertise AXShowMenu") {
        try missing.act("secondaryAction", policy: "ax_only", params: ["name": "AXShowMenu"])
    }
    expect(missing.trace == ["begin:1234", "refind:ref:1234:8"], "an action no handle advertises never runs: \(missing.trace)")

    let dead = ActFixture()
    dead.statuses = [.invalidUIElement, .success]
    let retried = try dead.act("secondaryAction", policy: "ax_only", params: ["name": "AXShowMenu"])
    expect(retried["outcome"] as? String == "worked", "a dead handle's action is retried on the refound handle: \(retried)")
    expect(dead.trace == ["begin:1234", "ax:AXShowMenu:cached", "refind:ref:1234:8", "ax:AXShowMenu:refound", "sleep:60000", "finish"], "the safe retry runs the action once more: \(dead.trace)")
}

/// `selectText` needs a start, and a refused range write is retried once before it reads as `didnt`.
private func runActSelectionEdgeAssertions() throws {
    let start = ActFixture()
    try actionFailure("invalid_args", message: "selectText requires start") { try start.act("selectText", policy: "ax_only", params: ["length": 2]) }
    expect(start.trace == ["begin:1234"], "a selection without start writes nothing")

    let retried = ActFixture()
    retried.writeStatuses = [.cannotComplete]
    let selected = try retried.act("selectText", policy: "ax_only", params: ["start": 1, "length": 2])
    expect(selected["outcome"] as? String == "worked" && (selected["evidence"] as? [String: Any])?["selection"] as? [String: Int] == ["start": 1, "length": 2], "a refused range write is retried on the refound handle and read back: \(selected)")
    expect(retried.trace == ["begin:1234", "set:AXSelectedTextRange", "refind:ref:1234:8", "set:AXSelectedTextRange", "finish"], "the retry writes the range once more: \(retried.trace)")

    let caret = ActFixture()
    let collapsed = try caret.act("selectText", policy: "ax_only", params: ["start": 3])
    expect((collapsed["evidence"] as? [String: Any])?["selection"] as? [String: Int] == ["start": 3, "length": 0], "a selection without length is a caret at start: \(collapsed)")

    let refused = ActFixture()
    refused.writeStatuses = [.cannotComplete, .cannotComplete]
    let failed = try refused.act("selectText", policy: "ax_only", params: ["start": 1, "length": 2])
    let error = failed["error"] as? [String: String]
    expect(failed["outcome"] as? String == "didnt" && error?["code"] == "ax_write_failed" && error?["message"] == "The element refused AXSelectedTextRange (AXError -25204)", "a twice-refused range write is didnt: \(failed)")
    expect(failed["evidence"] == nil && refused.range == nil, "a refused selection reads nothing back")
}

/// Focus evidence for a ref-targeted paste, and the window-change outcome of a coordinate action.
private func runActOutcomeEdgeAssertions() throws {
    for (status, focused) in [(AXError.success, true), (.cannotComplete, false)] {
        let paste = ActFixture()
        paste.writeStatuses = [status]
        let pasted = try paste.act("paste", policy: "background", params: ["text": "temporary"])
        let performed = pasted["performed"] as? [String: Any]
        expect((performed?["focused"] as? Bool ?? false) == focused && performed?["pasteDeadlineExpired"] as? Bool == true, "a ref paste reports focus only when the AXFocused write succeeds: \(pasted)")
        expect(Array(paste.trace.prefix(6)) == ["begin:1234", "set:AXFocused", "snapshot", "clipboard:temporary", "layout", "keyCode:9:1234:pid"], "a ref paste focuses the element before the clipboard: \(paste.trace)")
    }

    // A failed sheet read before the action counts as 0; after it, as the count before.
    for (counts, changed) in [([0, 1], true), ([nil, 1], true), ([nil, 0], false), ([0, nil], false), ([2, nil], false), ([2, 2], false)] as [([Int?], Bool)] {
        let click = ActFixture()
        click.sheetCounts = counts
        let result = try click.act("click", policy: "background", coords: true)
        let evidence = result["evidence"] as? [String: Any]
        expect(result["outcome"] as? String == (changed ? "worked" : "unknown") && (evidence?["windowChanged"] as? Bool == true) == changed, "sheet counts \(counts) after a coordinate click: \(result)")
    }

    let wheel = ActFixture()
    _ = try wheel.act("scroll", policy: "background", coords: true)
    expect(wheel.trace == ["begin:1234", "cursor:8", "wheel:1234:0:0:pid", "finish"], "a coordinate scroll without deltas posts a zero wheel: \(wheel.trace)")
}

/// An AX press failure that does not establish non-delivery is reported unknown: never re-pressed, never clicked (#1240).
private func runIndeterminatePressAssertions() throws {
    for status in [AXError.cannotComplete, .failure] {
        for policy in ["background", "foreground"] {
            let press = ActFixture()
            press.statuses = [status, .success]
            let result = try press.act("press", policy: policy)
            let error = result["error"] as? [String: String]
            expect(result["outcome"] as? String == "unknown" && error?["code"] == "ax_delivery_unknown", "\(policy) AXError \(status.rawValue) press reports unknown delivery")
            expect((result["evidence"] as? [String: Any])?["deliveryUnknown"] as? Bool == true, "\(policy) AXError \(status.rawValue) press is flagged deliveryUnknown")
            expect(press.trace == ["begin:1234", "ax:AXPress:cached", "finish"], "\(policy) AXError \(status.rawValue) press is delivered once: no refound press, no pointer click")
        }
    }
    let refound = ActFixture()
    refound.statuses = [.invalidUIElement, .cannotComplete]
    let second = try refound.act("press", policy: "foreground")
    expect(second["outcome"] as? String == "unknown" && !refound.trace.contains { $0.hasPrefix("click:") }, "an indeterminate refound press never falls back to a click")
    let dead = ActFixture()
    dead.statuses = [.actionUnsupported]
    dead.refind = false
    _ = try dead.act("press", policy: "background")
    expect(dead.trace.filter { $0.hasPrefix("click:") } == ["click:1234:0:1:pid"], "a press the element refused falls back to one pointer click")
    expect(!axPressNotDelivered(axError: AXError.cannotComplete.rawValue) && !axPressNotDelivered(axError: AXError.failure.rawValue), "cannotComplete and failure may have pressed")
    expect(axPressNotDelivered(axError: AXError.invalidUIElement.rawValue) && axPressNotDelivered(axError: AXError.actionUnsupported.rawValue), "a dead element or unsupported action was not pressed")
}

private func runKeyboardActionAssertions() throws {
    // A stale or failed readback after posted text is unknown, never didnt: didnt invites a resend (#1241).
    let stale = ActFixture()
    let unconfirmed = try stale.act("typeText", policy: "background", params: ["text": "before"])
    expect(unconfirmed["outcome"] as? String == "unknown" && stale.trace.filter { $0.hasPrefix("type:") } == ["type:before:1234:pid"], "posted text with an unchanged readback is unknown and typed once")
    expect((unconfirmed["evidence"] as? [String: Any])?["deliveryUnknown"] as? Bool == true, "an unconfirmed posted text is flagged deliveryUnknown")
    // Only two successful, different reads confirm posted text; a failed read never fabricates a value (#1241).
    for (reads, label) in [(["before", nil], "failed post-read"), ([nil, "hi"], "failed pre-read"), ([nil, nil], "two failed reads")] as [([String?], String)] {
        let fixture = ActFixture()
        fixture.valueReads = reads
        let result = try fixture.act("typeText", policy: "background", params: ["text": "hi"])
        let evidence = result["evidence"] as? [String: Any]
        expect(result["outcome"] as? String == "unknown" && evidence?["deliveryUnknown"] as? Bool == true && evidence?["valueChanged"] as? Bool == false, "\(label) after posted text is unknown: \(result)")
        expect((evidence?["value"] as? String) == reads[1], "\(label) reports only a value it actually read")
    }
    let typer = ActFixture()
    let confirmed = try typer.act("typeText", policy: "background", params: ["text": "hi"])
    let typedEvidence = confirmed["evidence"] as? [String: Any]
    expect(confirmed["outcome"] as? String == "worked" && typedEvidence?["value"] as? String == "hi" && typedEvidence?["deliveryUnknown"] == nil, "two different successful reads confirm posted text")
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
    // An accepted AXValue write with a stale or failed readback may have landed: unknown, written once (#1290).
    for policy in ["ax_only", "background", "foreground"] {
        for (stale, label) in [("before", "stale readback"), (nil, "failed readback")] as [(String?, String)] {
            let write = ActFixture()
            write.valueReads = ["before", stale]
            let result = try write.act("setText", policy: policy, params: ["text": "new"])
            let evidence = result["evidence"] as? [String: Any]
            expect(result["outcome"] as? String == "unknown" && evidence?["deliveryUnknown"] as? Bool == true && result["error"] == nil, "\(policy) accepted write with a \(label) is unknown, not refused: \(result)")
            expect((evidence?["value"] as? String) == stale, "\(policy) \(label) reports only a value it actually read")
            expect(write.trace.filter { $0 == "set:AXValue" }.count == 1 && !write.trace.contains { $0.hasPrefix("click:") || $0.hasPrefix("type:") || $0.hasPrefix("atomic:") }, "\(policy) \(label) writes AXValue once and posts nothing")
        }
    }
    keys.web = true
    try actionFailure("foreground_required") { try keys.act("setText", policy: "ax_only") }
    keys.trace = []
    _ = try keys.act("setText", policy: "background", params: ["text": "new"])
    expect(keys.trace.contains("atomic:new:1234:pid"), "web replacement posts atomic text after selecting the original value")
    // Posted replacement text whose readback is stale or failed may have landed: unknown, never `didnt`.
    for (reads, label) in [(["before", "before", "before"], "stale readback"), (["before", "before", nil], "failed readback"), (["before", "before", "new"], "confirmed readback")] as [([String?], String)] {
        let web = ActFixture()
        web.web = true
        web.valueReads = reads
        let result = try web.act("setText", policy: "background", params: ["text": "new"])
        let evidence = result["evidence"] as? [String: Any]
        let confirmed = reads.last == "new"
        expect(result["outcome"] as? String == (confirmed ? "worked" : "unknown") && (evidence?["deliveryUnknown"] as? Bool == true) == !confirmed && result["error"] == nil, "web \(label) after posting text: \(result)")
        expect((evidence?["value"] as? String) == reads.last ?? nil, "web \(label) reports only a value it actually read")
        expect(web.trace.filter { $0.hasPrefix("atomic:") }.count == 1, "web \(label) posts the replacement once")
    }
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
    let move = fixture.request("moveMouse", policy: "background", coords: true)
    try actionFailure("invalid_args") {
        try fixture.bridge.actBatch(["actions": [move, fixture.request("drag", coords: true), press]], world: fixture.world, supportsAgentCursor: false)
    }
    expect(fixture.trace.isEmpty, "malformed batch drag must not acquire outer lock or execute an earlier action")
    // In-range vertices, but the coordinate target grounds past the limit on a far-right window.
    fixture.windowFrame.origin.x = 999_900
    let farTarget = fixture.request("drag", params: ["path": [["x": 0, "y": 0], ["x": 50, "y": 0]]])
        .merging(["target": ["x": 290, "y": 10]]) { _, new in new }
    try actionFailure("invalid_args", message: "Drag coordinates must be finite and within +/-1000000") {
        try fixture.bridge.actBatch(["actions": [move, farTarget, press]], world: fixture.world, supportsAgentCursor: false)
    }
    expect(fixture.trace.isEmpty, "out-of-range batch drag target must not lock, activate, preflight or execute an earlier step: \(fixture.trace)")
    fixture.windowFrame.origin.x = 100
    fixture.blocked = true
    let drag = fixture.request("drag", coords: true, params: ["path": [["x": 10, "y": 20], ["x": 30, "y": 40]]])
    let result = try fixture.bridge.actBatch(["actions": [move, drag, press]], world: fixture.world, supportsAgentCursor: false)
    let steps = result["steps"] as? [[String: Any]]
    expect(result["outcome"] as? String == "didnt" && result["stoppedAt"] as? Int == 1 && steps?.count == 2, "batch stops at the failed step")
    expect(fixture.trace == ["begin:1234", "lock", "move:1234:pid", "lock", "activate", "raise", "sleep:20000", "pointer", "unlock", "finish", "unlock"], "batch keeps the outer lock through finish and does not execute the trailing press")
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
    // An indeterminate press stops the batch: a later step must not run on, or hide, an unknown delivery (#1240).
    let uncertain = ActFixture()
    uncertain.statuses = [.cannotComplete]
    let pair = uncertain.request("press", policy: "ax_only")
    let stopped = try uncertain.bridge.actBatch(["actions": [pair, pair]], world: uncertain.world, supportsAgentCursor: false)
    let stoppedSteps = stopped["steps"] as? [[String: Any]]
    expect(stopped["outcome"] as? String == "unknown" && stopped["stoppedAt"] as? Int == 0 && stoppedSteps?.count == 1, "an indeterminate press stops the batch at its step: \(stopped)")
    expect((stoppedSteps?.first?["error"] as? [String: String])?["code"] == "ax_delivery_unknown", "the stopped step keeps its ax_delivery_unknown error")
    expect(uncertain.trace == ["begin:1234", "ax:AXPress:cached", "finish"], "the second press is never dispatched: \(uncertain.trace)")
    let generic = ActFixture()
    generic.scrollPositions = ["same", "same"]
    generic.scrollResult = ["scrolled": true]
    let scroll = generic.request("scroll", policy: "ax_only", params: ["scrollY": 1])
    let continued = try generic.bridge.actBatch(["actions": [scroll, generic.request("press", policy: "ax_only")]], world: generic.world, supportsAgentCursor: false)
    expect(continued["stoppedAt"] == nil && (continued["steps"] as? [[String: Any]])?.count == 2, "a generic unknown does not stop the batch: \(continued)")
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
    for pid in [2147483648, 0, -1] {
        try actionFailure("invalid_args", message: "pid must be a positive 32-bit integer") {
            try listRoots(#"{"cmd":"listRoots","title":"Fixture","pid":\#(pid)}"#)
        }
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
    let pidError = "pid must be a positive 32-bit integer"
    let invalidPids = try JSONSerialization.jsonObject(with: Data(#"[2147483648, 1234.5, "1234", true, 0, -1]"#.utf8)) as! [Any]
    for pid in invalidPids {
        for lookId in ["stale", nil] as [String?] {
            var request = fixture.request("click", policy: "background", coords: true)
            request["pid"] = pid
            request["lookId"] = lookId
            try check("act pid \(String(reflecting: pid)), \(lookId ?? "missing look")", message: pidError) {
                try fixture.bridge.act(request, world: fixture.world, supportsAgentCursor: false)
            }
        }
    }
    if !fixture.lookups.isEmpty || !fixture.trace.isEmpty {
        failures.append("invalid act performed lookups or actions: \(fixture.lookups), \(fixture.trace)")
    }

    let refStore = AXRefStore()
    let axPid = getpid()
    let windowRef = refStore.storeWindow(AXUIElementCreateApplication(axPid))
    let bridge = Bridge(activityGlow: nil, readSession: { nil }, refStore: refStore)
    var observations: [String] = []
    func look(pid: Any?, readText: String, owner: Int32? = 1234, includeImage: Bool = true, windowRef: String? = nil) throws -> Any {
        var request: [String: Any] = ["cmd": "look", "windowId": 42, "readText": readText, "includeImage": includeImage]
        request["pid"] = pid
        request["windowRef"] = windowRef
        return try bridge.handleRequest(request, clientID: nil, lookWindowOwner: { id in
            observations.append("owner:\(id)")
            return owner
        }, lookCapture: { id in
            observations.append("capture:\(id)")
            throw BridgeFailure(message: "capture fixture", code: "fixture_capture")
        })
    }
    for pid in invalidPids {
        try check("look pid \(String(reflecting: pid))", message: pidError) {
            try look(pid: pid, readText: "invalid sentinel")
        }
    }
    if !observations.isEmpty { failures.append("invalid look resolved ownership or captured") }
    try check("wrong owner", code: "pid_mismatch", message: "pid does not match the resolved root owner") {
        try look(pid: 4321, readText: "never")
    }
    if observations != ["owner:42"] { failures.append("wrong owner did not stop at ownership: \(observations)") }
    observations = []
    // Ownership mismatch proves the semantic look resolved the stored AX owner without
    // walking a live AX tree. An image look for the same root must not use the AX fallback.
    let otherPid = axPid == 1 ? 2 : 1
    try check("semantic look uses the stored AX owner", code: "pid_mismatch", message: "pid does not match the resolved root owner") {
        try look(pid: otherPid, readText: "never", owner: nil, includeImage: false, windowRef: windowRef)
    }
    if observations != ["owner:42"] { failures.append("semantic look attempted capture: \(observations)") }
    observations = []
    try check("image look requires a CG owner", code: "root_not_found", message: "Root is not owned by a running app") {
        try look(pid: axPid, readText: "never", owner: nil, windowRef: windowRef)
    }
    if observations != ["owner:42"] { failures.append("unresolved CG owner did not stop before capture: \(observations)") }
    for pid in [nil, NSNull(), 1234] as [Any?] {
        observations = []
        try check("omitted, null or matching owner", code: "fixture_capture", message: "capture fixture") {
            try look(pid: pid, readText: "never")
        }
        if observations != ["owner:42", "capture:42"] { failures.append("look did not resolve ownership before capture: \(observations)") }
    }
    expect(failures.isEmpty, failures.joined(separator: "\n"))
}

private func runWindowIDAssertions() throws {
    let bridge = Bridge(activityGlow: nil, readSession: { nil })
    let invalidIds: [Any] = [1.5, -1, 0, UInt64(UInt32.max) + 1, UInt64.max, Double.nan, true, "12"]
    for command in ["setWindowFrame", "focusedElement", "focusWindow", "look", "axWaitFor"] {
        for id in invalidIds {
            // Use an impossible PID and suppress images so a parser regression cannot focus or capture a live window.
            let request: [String: Any] = ["cmd": command, "pid": Int(Int32.max), "windowId": id, "includeImage": false, "role": "AXButton"]
            do {
                _ = try bridge.handleRequest(request, clientID: nil)
                expect(false, "\(command) accepted invalid windowId \(id)")
            } catch let failure as BridgeFailure {
                expect(failure.code == "invalid_args" && failure.message == "windowId must be a positive 32-bit unsigned integer", "\(command) must reject invalid windowId \(id) before window lookup, got \(failure)")
            }
        }
    }
    // Every window-ID site validates the PID first, so a request with both malformed reports the PID error.
    for command in ["setWindowFrame", "focusedElement", "focusWindow", "look", "axWaitFor"] {
        let request: [String: Any] = ["cmd": command, "pid": 0, "windowId": 1.5, "includeImage": false, "role": "AXButton"]
        do {
            _ = try bridge.handleRequest(request, clientID: nil)
            expect(false, "\(command) accepted an invalid pid and windowId")
        } catch let failure as BridgeFailure {
            expect(failure.code == "invalid_args" && failure.message == "pid must be a positive 32-bit integer", "\(command) must report the pid error first when pid and windowId are both invalid, got \(failure)")
        }
    }
    let omitted = try checkedWindowId(nil)
    let null = try checkedWindowId(NSNull())
    let smallest = try checkedWindowId(NSNumber(value: 1))
    let largest = try checkedWindowId(NSNumber(value: UInt32.max))
    let decimal = try checkedWindowId(NSDecimalNumber(string: "4294967295"))
    expect(omitted == nil && null == nil && smallest == 1 && largest == UInt32.max && decimal == UInt32.max, "missing and null IDs are absent; both positive UInt32 boundaries are accepted")

    // Real NDJSON framing and JSONSerialization: these decode as NSDecimalNumber, whose Double view is integral.
    var frames: [Data] = []
    let framed = Bridge(activityGlow: nil, readSession: { nil }, writeOutput: { frames.append($0) })
    for command in ["setWindowFrame", "focusedElement", "focusWindow", "look", "axWaitFor"] {
        for id in ["4294967295.00000001", "4294967295.0000000001", "1.000000000000000001"] {
            frames = []
            framed.handleLine(#"{"id":"w","cmd":"\#(command)","pid":2147483647,"windowId":\#(id),"includeImage":false,"role":"AXButton"}"#)
            let response = frames.count == 1 ? (try? JSONSerialization.jsonObject(with: frames[0])) as? [String: Any] : nil
            expect(response?["ok"] as? Bool == false && (response?["error"] as? [String: String]) == ["message": "windowId must be a positive 32-bit unsigned integer", "code": "invalid_args"], "\(command) must reject fractional decimal windowId \(id): \(String(describing: response))")
        }
    }
}

private final class RecordingInputLock: NSLocking {
    var acquisitions = 0
    func lock() { acquisitions += 1 }
    func unlock() {}
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
        /// `CGEvent.timestamp` at post, and the fake-clock stamp issued for this post (nil when none was).
        var stamp: CGEventTimestamp = 0
        var issued: CGEventTimestamp?

        /// Shape only: stamps are clock values, asserted per post by `stampedAtPost`.
        static func == (lhs: Event, rhs: Event) -> Bool {
            lhs.type == rhs.type && lhs.pid == rhs.pid && lhs.delivery == rhs.delivery && lhs.point == rhs.point
                && lhs.data == rhs.data && lhs.flags == rhs.flags && lhs.text == rhs.text && lhs.horizontal == rhs.horizontal
        }
    }
    var events: [Event] = []
    var delays: [useconds_t] = []
    var mouseAllocations: [CGEventType] = []
    let inputLock = RecordingInputLock()
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
    // Fake monotonic clock shared by allocation and post. Every tick is unique, so a creation stamp can never
    // equal the stamp issued for a post: each pointer event must carry the stamp issued for its own post.
    var clockTicks: CGEventTimestamp = 0
    func tick() -> CGEventTimestamp { clockTicks += 1; return clockTicks }
    var pendingStamp: CGEventTimestamp?
    func issueStamp() -> CGEventTimestamp {
        expect(pendingStamp == nil, "each post-time stamp is consumed by its own post before the next is issued")
        let stamp = tick()
        pendingStamp = stamp
        return stamp
    }
    func stampedAtPost(_ events: [Event]) -> Bool {
        !events.isEmpty && events.allSatisfy { $0.issued != nil && $0.stamp == $0.issued }
    }
    func record(_ event: CGEvent, pid: Int32, delivery: String) {
        var entry = Event(type: event.type, pid: pid, delivery: delivery, stamp: event.timestamp, issued: pendingStamp)
        pendingStamp = nil
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
            mouseAllocations.append(type)
            if type == rejectNextMouseType {
                rejectNextMouseType = nil
                return nil
            }
            guard type != .leftMouseDragged || point != rejectDragAt else { return nil }
            let event = NativeInputSink.createMouseEvent(type, point, button)
            event?.timestamp = tick()
            return event
        },
        wheelEvent: { vertical, horizontal in
            let event = rejectWheel ? nil : NativeInputSink.createWheelEvent(vertical, horizontal)
            event?.timestamp = tick()
            return event
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
        },
        eventTimestamp: issueStamp
    )
    let world = Bridge(activityGlow: nil, inputSink: sink, physicalInputLock: inputLock).actionWorld()
    let start = CGPoint(x: 100, y: 200)
    let midpoint = CGPoint(x: 112, y: 200)
    let end = CGPoint(x: 124, y: 200)
    func mouse(_ type: CGEventType, _ point: CGPoint, _ data: Int64 = 0, delivery: String = "pid") -> Event {
        Event(type: type, pid: 1234, delivery: delivery, point: point, data: data)
    }
    try world.postMouseClick(start, 1234, .right, 2, "pid")
    expect(events == [mouse(.mouseMoved, start), mouse(.rightMouseDown, start, 1), mouse(.rightMouseUp, start, 1), mouse(.rightMouseDown, start, 2), mouse(.rightMouseUp, start, 2)] && delays == [12_000, 70_000, 12_000], "PID double click emits ordered pairs with click-state increments and delays")
    expect(stampedAtPost(events), "every PID double-click event carries the stamp issued for its own post: \(events.map { ($0.stamp, $0.issued) })")
    events = []; delays = []
    try world.postMouseDrag([start, end], 1234, "pid")
    expect(events == [mouse(.mouseMoved, start), mouse(.leftMouseDown, start, 1), mouse(.leftMouseDragged, midpoint, 1), mouse(.leftMouseDragged, end, 1), mouse(.leftMouseUp, end, 1)] && delays == [30_000, 8_000, 8_000], "drag interpolates and releases at destination")
    expect(stampedAtPost(events), "every drag event, including the preallocated release, carries the stamp issued for its own post: \(events.map { ($0.stamp, $0.issued) })")
    events = []; delays = []
    let dragFixture = ActFixture()
    dragFixture.postDrag = world.postMouseDrag
    let invalidDrag = "Drag coordinates must be finite and within +/-1000000"
    mouseAllocations = []
    for x: Double in [1e100, 1e39, 1.7e308, -1_000_000.0001, .nan, .infinity, -.infinity] {
        try actionFailure("invalid_args", message: invalidDrag) {
            try world.postMouseDrag([.zero, CGPoint(x: x, y: 0)], 1234, "hid")
            return [:]
        }
        expect(inputLock.acquisitions == 0, "invalid native drag must not acquire HID lock")
        expect(mouseAllocations.isEmpty, "invalid native drag must not reserve mouse-up or allocate any event")
        expect(events.isEmpty && delays.isEmpty, "invalid native drag must not post or wait")

        dragFixture.trace = []
        try actionFailure("invalid_args", message: invalidDrag) {
            try dragFixture.act("drag", coords: true, params: ["path": [["x": 0.0, "y": 0.0], ["x": x, "y": 0.0]]])
        }
        expect(dragFixture.trace == ["begin:1234"], "invalid act drag must not lock, activate, raise or preflight: \(dragFixture.trace)")
        expect(mouseAllocations.isEmpty, "invalid act drag must not allocate input events")

        // A ref target has an element, so preflight would hit-test; coordinate targets return before that.
        dragFixture.trace = []
        try actionFailure("invalid_args", message: invalidDrag) {
            try dragFixture.act("drag", params: ["path": [["x": 0.0, "y": 0.0], ["x": x, "y": 0.0]]])
        }
        expect(dragFixture.trace == ["begin:1234"] && !dragFixture.trace.contains("hit"), "invalid ref drag must not lock, activate, raise or hit-test: \(dragFixture.trace)")
        expect(mouseAllocations.isEmpty, "invalid ref drag must not allocate input events")
    }
    dragFixture.trace = []
    dragFixture.windowFrame.origin.x = 999_900
    try actionFailure("invalid_args", message: invalidDrag) {
        try dragFixture.act("drag", coords: true, params: ["path": [["x": 0, "y": 0], ["x": 300, "y": 0]]])
    }
    expect(dragFixture.trace == ["begin:1234"] && mouseAllocations.isEmpty, "out-of-range grounded drag must not lock, activate, raise, preflight or allocate")
    dragFixture.trace = []
    try actionFailure("invalid_args", message: invalidDrag) {
        try dragFixture.act("drag", params: ["path": [["x": 0, "y": 0], ["x": 300, "y": 0]]])
    }
    expect(dragFixture.trace == ["begin:1234"] && mouseAllocations.isEmpty, "out-of-range grounded ref drag must not lock, activate, raise, hit-test or allocate: \(dragFixture.trace)")

    let signedZero = CGPoint(x: -0.0, y: 0)
    let subnormal = CGPoint(x: Double.leastNonzeroMagnitude, y: -Double.leastNonzeroMagnitude)
    try world.postMouseDrag([signedZero, subnormal], 1234, "pid")
    expect(events.first?.point == signedZero && events.last?.point == subnormal && events.last?.type == .leftMouseUp, "signed zero and subnormal vertices are in range")
    events = []; delays = []; mouseAllocations = []

    let secondary = CGPoint(x: -240, y: -120)
    let boundary = CGPoint(x: -1_000_000, y: 1_000_000)
    try world.postMouseDrag([secondary, boundary], 1234, "hid")
    expect(inputLock.acquisitions > 0 && mouseAllocations.first == .leftMouseUp, "valid drag acquires HID lock and reserves release first")
    expect(events.first?.point == secondary && events.last?.point == boundary, "signed secondary-display coordinates and inclusive boundary are accepted")
    expect(events.allSatisfy { abs($0.point.x) <= 1_000_000 && abs($0.point.y) <= 1_000_000 }, "all derived drag steps stay in range")
    events = []; delays = []

    // desktopInput drag through the real router and sink fixture. Far off-screen, so no window can match the refusal.
    let desktop = Bridge(activityGlow: nil, readSession: { nil }, inputSink: sink, physicalInputLock: inputLock)
    let far = [CGPoint(x: -999_000, y: -999_000), CGPoint(x: -998_976, y: -999_000)]
    let desktopDrag = try desktop.handleRequest(["cmd": "desktopInput", "action": "drag", "path": far.map { ["x": $0.x, "y": $0.y] }], clientID: nil) as? [String: Any]
    let readback = desktopDrag?["mouse"] as? [String: Any]
    expect(desktopDrag.map { Set($0.keys) } == ["performed", "mouse"] && desktopDrag?["performed"] as? String == "drag" && readback?["x"] is NSNumber && readback?["y"] is NSNumber, "desktop drag keeps the common success shape with mouse readback: \(String(describing: desktopDrag))")
    expect(events.first?.point == far[0] && events.last?.type == .leftMouseUp && events.last?.point == far[1] && events.allSatisfy { $0.delivery == "hid" }, "desktop drag posts through the HID sink")
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
    rejectNextMouseType = .mouseMoved
    try actionFailure("input_failed", message: "Failed to create mouse move event") {
        try world.postMouseDrag([start, end], 1234, "pid")
        return [:]
    }
    expect(rejectNextMouseType == nil && events.isEmpty && delays.isEmpty, "failed initial move posts no release or other input: \(events)")
    events = []; delays = []
    rejectNextMouseType = .leftMouseDown
    try actionFailure("input_failed", message: "Failed to create mouse down event") {
        try world.postMouseDrag([start, end], 1234, "pid")
        return [:]
    }
    expect(rejectNextMouseType == nil && events == [mouse(.mouseMoved, start)] && delays.isEmpty, "failed mouse-down posts only the initial move, no unmatched release: \(events)")
    events = []; delays = []
    try world.postScrollWheel(start, 15, -25, 1234, "hid")
    expect(events == [mouse(.mouseMoved, start, delivery: "hid"), Event(type: .scrollWheel, pid: 1234, delivery: "hid", point: start, data: 25, horizontal: -15)] && delays.isEmpty, "HID wheel emits signed vertical and horizontal deltas at the point")
    expect(stampedAtPost(events), "HID move and wheel events carry the stamp issued for their own post: \(events.map { ($0.stamp, $0.issued) })")
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
    try actionFailure("app_blocked", postedUnits: 1) { try keys.act("keypress", coords: true, params: ["keys": ["cmd+a", "tab", "b"]]) }
    expect(events.map(\.type) == [.keyDown, .keyUp] && events.map(\.data) == [0, 0] && events.map(\.flags) == [.maskCommand, .maskCommand], "keypress releases the posted chord after focus moves and refuses the next key")
    expect(preparations == 2, "prepare each attempted key-down but never prepare its owed release")
    onHIDPrepare = { false }
    onHIDPost = { _ in }

    // An unsupported key anywhere refuses the whole sequence before its first key-down, and names no key.
    keys.blocked = false
    for sequence in [["cmd+s", "not-a-key"], ["tab", "not-a-key"], ["cmd", "not-a-key"]] {
        events = []; keyAllocations = 0
        try actionFailure("invalid_args", message: "Unsupported key at keys[1]; no key was posted", postedUnits: 0) {
            try keys.act("keypress", coords: true, params: ["keys": sequence])
        }
        expect(events.isEmpty && keyAllocations == 0, "an invalid sequence \(sequence) allocates and posts nothing")
    }

    // A failure after admission, here the second pair's event allocation, still reports the posted prefix.
    events = []; keyAllocations = 0
    rejectKeyAllocation = 3
    try actionFailure("input_failed", message: "Failed to create key event", postedUnits: 1) {
        try keys.act("keypress", coords: true, params: ["keys": ["cmd+s", "tab"]])
    }
    expect(events.map(\.type) == [.keyDown, .keyUp] && events.map(\.data) == [1, 1], "allocation failure after cmd+s posts only that pair")
    events = []; keyAllocations = 0
    try actionFailure("input_failed", message: "Failed to create unicode key event", postedUnits: 1) {
        try keys.act("typeText", coords: true, params: ["text": "a🙂"])
    }
    expect(events.map(\.text) == ["a", "a"], "typing allocation failure after one pair reports it")
    rejectKeyAllocation = nil

    // act_ui's length-based deadline: 5,000 characters at 8 ms per pair run 40 s, past any 30 s bound.
    let longTyping = ActFixture(inputSink: sink)
    var typingClock = ProcessInfo.processInfo.systemUptime
    longTyping.clockedAdmission = { deadline in
        let gate = KeyboardAdmission(now: { typingClock }, deadline: deadline)
        return { _ in try gate.checkDeadline() }
    }
    onInputSleep = { typingClock += 0.008 }
    events = []
    let text = String(repeating: "a", count: 5_000)
    var longRequest = longTyping.request("typeText", coords: true, params: ["text": text])
    longRequest["keyboardDeadlineUptimeMs"] = (typingClock + 129) * 1000
    _ = try longTyping.bridge.act(longRequest, world: longTyping.world, supportsAgentCursor: false)
    expect(events.count == 10_000, "a valid long act typeText is not cut mid-string: \(events.count / 2) of 5000 pairs")
    onInputSleep = {}

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

private func runKeyboardDeadlineAssertions() {
    let now = 1_000.0
    for ceiling in [desktopInputKeyboardCeiling, nil] {
        expect(keyboardDeadline(["keyboardDeadlineUptimeMs": 1_012_500], now: now, ceiling: ceiling) == 1_012.5, "the uptime deadline is used as is, with no wall-clock conversion")
        expect(keyboardDeadline(["keyboardDeadlineUptimeMs": 999_000], now: now, ceiling: ceiling) == 999, "a deadline already past stays past")
        expect(keyboardDeadline(["keyboardDeadlineUptimeMs": Double.nan], now: now, ceiling: ceiling) == 1_030, "a non-finite deadline falls back to 30 s")
        expect(keyboardDeadline(["keyboardDeadlineMs": 1_012_500], now: now, ceiling: ceiling) == 1_030, "the retired wall-clock field grants nothing")
        expect(keyboardDeadline([:], now: now, ceiling: ceiling) == 1_030, "a missing deadline falls back to 30 s")
    }
    expect(keyboardDeadline(["keyboardDeadlineUptimeMs": 1_031_000], now: now, ceiling: desktopInputKeyboardCeiling) == 1_030, "desktopInput bounds a deadline to its client's fixed 30 s")
    // act_ui budgets 25 ms per character: 5,000 characters get about 129 s, which a 30 s bound would cut mid-string.
    expect(keyboardDeadline(["keyboardDeadlineUptimeMs": 1_129_000], now: now, ceiling: nil) == 1_129, "act keeps the client's length-based deadline")
}

/// The batch resolves its keyboard deadline once and every step inherits it.
private func runBatchDeadlineAssertions() throws {
    func keypressBatch(_ fixture: ActFixture, deadlineMs: Double?, count: Int = 1) throws -> [String: Any] {
        var request: [String: Any] = ["actions": Array(repeating: fixture.request("keypress", coords: true, params: ["keys": ["tab"]]), count: count)]
        if let deadlineMs { request["keyboardDeadlineUptimeMs"] = deadlineMs }
        return try fixture.bridge.actBatch(request, world: fixture.world, supportsAgentCursor: false)
    }
    func realClock(_ fixture: ActFixture) {
        fixture.clockedAdmission = { deadline in
            let gate = KeyboardAdmission(now: { ProcessInfo.processInfo.systemUptime }, deadline: deadline)
            return { _ in try gate.checkDeadline() }
        }
    }

    let expired = ActFixture()
    realClock(expired)
    let stopped = try keypressBatch(expired, deadlineMs: (ProcessInfo.processInfo.systemUptime - 1) * 1000)
    let step = (stopped["steps"] as? [[String: Any]])?.first
    expect(stopped["stoppedAt"] as? Int == 0 && (step?["error"] as? [String: String])?["code"] == "input_deadline_expired", "an expired batch deadline stops the first keyboard step: \(stopped)")
    expect((step?["evidence"] as? [String: Int])?["postedUnits"] == 0 && !expired.trace.contains { $0.hasPrefix("key:") }, "an expired batch deadline posts no key-down: \(expired.trace)")

    let live = ActFixture()
    realClock(live)
    let posted = try keypressBatch(live, deadlineMs: (ProcessInfo.processInfo.systemUptime + 60) * 1000)
    expect(posted["stoppedAt"] == nil && live.trace.contains("key:tab:1234:hid"), "a future batch deadline posts the key: \(live.trace)")

    // Real time passes between steps, so a per-step fallback would give each step a later deadline.
    let missing = ActFixture()
    missing.onSleep = { _ in Thread.sleep(forTimeInterval: 0.002) }
    let before = ProcessInfo.processInfo.systemUptime
    _ = try keypressBatch(missing, deadlineMs: nil, count: 2)
    expect(missing.deadlines.count == 2 && missing.deadlines[0] == missing.deadlines[1], "a missing batch deadline falls back once, not per step: \(missing.deadlines)")
    expect(missing.deadlines.allSatisfy { $0 >= before + 30 && $0 <= ProcessInfo.processInfo.systemUptime + 30 }, "the batch fallback is 30 s from batch entry")

    let long = ActFixture()
    _ = try keypressBatch(long, deadlineMs: 5_000_129_000, count: 2)
    expect(long.deadlines == [5_000_129, 5_000_129], "a batch keeps the client's length-based deadline for every step: \(long.deadlines)")
}

/// The production sink with activation, its settle wait and the final OS post injected one at a time.
private func runProductionSinkAssertions() throws {
    expect(!NativeInputSink.activateIfInactive(-1), "no running app at the pid means no activation")
    var effects: [String] = []
    var activates = true
    var onActivate: () -> Void = {}
    let sink = NativeInputSink.production(
        activate: { pid in
            effects.append("activate:\(pid)")
            onActivate()
            return activates
        },
        sleep: { effects.append("sleep:\($0)") },
        post: { effects.append("post:\($0.type == .keyDown ? "down" : "up"):\($0.getIntegerValueField(.keyboardEventKeycode))") }
    )
    let keys = ActFixture(inputSink: sink)
    keys.admissionOverride = { _ in effects.append("admit") }
    _ = try keys.act("keypress", coords: true, params: ["keys": ["tab"]])
    // The first admission is the forced check before any activation.
    expect(effects == ["admit", "activate:1234", "sleep:20000", "admit", "post:down:48", "post:up:48", "sleep:8000"],
           "activation settles before admission and the final post adds no wait: \(effects)")

    effects = []
    activates = false
    _ = try keys.act("keypress", coords: true, params: ["keys": ["tab"]])
    expect(effects == ["admit", "activate:1234", "admit", "post:down:48", "post:up:48", "sleep:8000"], "an active target posts with no settle wait: \(effects)")

    effects = []
    activates = true
    keys.admissionOverride = nil
    onActivate = { keys.blocked = true }
    try actionFailure("app_blocked", postedUnits: 0) { try keys.act("keypress", coords: true, params: ["keys": ["tab"]]) }
    expect(effects == ["activate:1234", "sleep:20000"], "focus lost during the settle wait refuses before any post: \(effects)")
}
