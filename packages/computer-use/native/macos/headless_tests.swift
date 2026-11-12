import Foundation
import AppKit
import ApplicationServices
import Carbon.HIToolbox

/// Exercise native policy and ref bookkeeping without live AX reads or event delivery.
func runPureAssertions() {

var failures = 0
func check(_ ok: Bool, _ name: String) { if !ok { failures += 1; print("FAIL: \(name)") } }

// Modal classification
check(!classifyModal(axModal: false, sheetCount: 0, role: "AXWindow", subrole: "AXDialog"), "AXModal=0 + AXDialog is nonmodal (Fusion sidebar)")
check(classifyModal(axModal: true, sheetCount: 0, role: "AXWindow", subrole: "AXStandardWindow"), "AXModal=1 is modal")
check(classifyModal(axModal: true, sheetCount: 0, role: "AXWindow", subrole: "AXDialog"), "AXModal=1 + AXDialog is modal")
check(classifyModal(axModal: false, sheetCount: 1, role: "AXWindow", subrole: "AXStandardWindow"), "sheet child is modal")
check(classifyModal(axModal: nil, sheetCount: 0, role: "AXSheet", subrole: ""), "AXSheet is modal")
check(classifyModal(axModal: nil, sheetCount: 0, role: "AXWindow", subrole: "AXDialog"), "unreported AXModal + AXDialog falls back to modal")
check(!classifyModal(axModal: nil, sheetCount: 0, role: "AXWindow", subrole: "AXStandardWindow"), "plain window nonmodal")
check(!classifyModal(axModal: false, sheetCount: 0, role: "AXWindow", subrole: "AXSystemDialog"), "explicit AXModal=0 wins over any dialog subrole")

// Capture target resolution
check(resolveCaptureTarget(windowId: 12, wantsImage: true) == .capture(windowId: 12), "paired + image captures")
check(resolveCaptureTarget(windowId: 12, wantsImage: false) == .semanticOnly, "paired semantic skips capture")
check(resolveCaptureTarget(windowId: nil, wantsImage: false) == .semanticOnly, "unpaired semantic ok")
check(resolveCaptureTarget(windowId: nil, wantsImage: true) == .notCapturable, "unpaired visual errors")
check(resolveCaptureTarget(windowId: 0, wantsImage: true) == .notCapturable, "window 0 never captured")

// Window id normalization and fallback rule
check(normalizedWindowId(nil) == nil, "nil id")
check(normalizedWindowId(0) == nil, "0 is no window")
check(normalizedWindowId(-4) == nil, "negative is no window")
check(normalizedWindowId(5_000_000_000) == nil, "out of range")
check(normalizedWindowId(4259) == 4259, "valid id")
check(allowsFirstWindowFallback(windowId: nil, windowRef: nil), "unqualified may fall back")
check(!allowsFirstWindowFallback(windowId: nil, windowRef: "ax:dlg"), "stale ref must not fall back to first window")
check(!allowsFirstWindowFallback(windowId: 7, windowRef: nil), "id request must not fall back")

// App blocklist and session lock
check(isBlockedBundleId("com.apple.Terminal", blocked: ["com.apple.terminal"]), "bundle ids match case-insensitively")
check(!isBlockedBundleId("com.apple.TextEdit", blocked: ["com.apple.Terminal"]), "unlisted app is allowed")
check(!isBlockedBundleId(nil, blocked: ["com.apple.Terminal"]) && !isBlockedBundleId("", blocked: [""]), "no bundle id never matches")
check(blockedBundleIdList([:]) == alwaysBlockedBundleIds, "system agents are blocked with no request list")
check(isBlockedBundleId("com.apple.SecurityAgent", blocked: blockedBundleIdList(["blockedBundleIds": []])), "empty request list keeps system agents blocked")
check(isBlockedBundleId("com.example.Vault", blocked: blockedBundleIdList(["blockedBundleIds": ["com.example.Vault", 7]])), "request list extends the blocklist")
check(sessionIsLocked(["CGSSessionScreenIsLocked": true]), "screen-locked flag locks the session")
check(sessionIsLocked(["CGSSessionScreenIsLocked": NSNumber(value: 1)]), "NSNumber lock flag locks the session")
check(sessionIsLocked(["kCGSSessionOnConsoleKey": false]), "session off the console is unusable")
check(!sessionIsLocked(["kCGSSessionOnConsoleKey": true]), "unlocked console session")
check(!sessionIsLocked(["CGSSessionScreenIsLocked": false, "kCGSSessionOnConsoleKey": true]), "explicitly unlocked session")
check(!sessionIsLocked([:]) && !sessionIsLocked(nil), "no lock flag and no session are not locked")
check(["look", "act", "actBatch", "desktopInput", "captureDisplay", "axReadText", "focusWindow"].allSatisfy(commandRequiresUnlockedSession), "UI commands need an unlocked session")
check(!["listApps", "listRoots", "getFrontmost", "diagnostics", "checkPermissions", "shutdown"].contains(where: commandRequiresUnlockedSession), "discovery and lifecycle commands work while locked")
let lockedRefusal = lockedSessionRefusal(cmd: "act", session: ["CGSSessionScreenIsLocked": true])
check(lockedRefusal?.code == "screen_locked" && lockedRefusal?.message.hasPrefix("screen_locked:") == true && lockedRefusal?.message.contains("'act'") == true, "locked act is refused with screen_locked")
check(lockedSessionRefusal(cmd: "desktopInput", session: ["kCGSSessionOnConsoleKey": false])?.code == "screen_locked", "off-console desktopInput is refused with screen_locked")
check(lockedSessionRefusal(cmd: "act", session: ["CGSSessionScreenIsLocked": false]) == nil, "unlocked act runs")
check(lockedSessionRefusal(cmd: "listRoots", session: ["CGSSessionScreenIsLocked": true]) == nil, "discovery runs while locked")
let windowList: [[String: Any]] = [
	["kCGWindowOwnerPID": 50, "kCGWindowAlpha": 1.0, "kCGWindowBounds": ["X": 0, "Y": 0, "Width": 1000, "Height": 800]],
	["kCGWindowOwnerPID": 20, "kCGWindowAlpha": 0.0, "kCGWindowBounds": ["X": 0, "Y": 0, "Width": 400, "Height": 400]],
	["kCGWindowOwnerPID": 10, "kCGWindowAlpha": 1.0, "kCGWindowBounds": ["X": 100, "Y": 100, "Width": 200, "Height": 200]],
	["kCGWindowOwnerPID": 30, "kCGWindowAlpha": 1.0, "kCGWindowBounds": ["X": 0, "Y": 0, "Width": 1000, "Height": 800]],
]
let blockedPids: Set<Int32> = [10]
let isBlockedPid: (Int32) -> Bool = { blockedPids.contains($0) }
check(blockedWindowOwnerPid(windowList, at: CGPoint(x: 150, y: 150), excludingPid: 99, isBlockedPid: isBlockedPid) == nil, "a layer-0 window of an unblocked app above a blocked one ends the scan")
check(blockedWindowOwnerPid(windowList, at: CGPoint(x: 150, y: 150), excludingPid: 50, isBlockedPid: isBlockedPid) == 10, "own overlay and transparent windows are skipped")
check(blockedWindowOwnerPid(windowList, at: CGPoint(x: 1500, y: 150), excludingPid: 99, isBlockedPid: isBlockedPid) == nil, "no window at the point")
let overlayList: [[String: Any]] = [
	["kCGWindowOwnerPID": 70, "kCGWindowLayer": 25, "kCGWindowAlpha": 1.0, "kCGWindowBounds": ["X": 0, "Y": 0, "Width": 1000, "Height": 800]],
	["kCGWindowOwnerPID": 10, "kCGWindowLayer": 0, "kCGWindowAlpha": 1.0, "kCGWindowBounds": ["X": 100, "Y": 100, "Width": 200, "Height": 200]],
	["kCGWindowOwnerPID": 30, "kCGWindowLayer": 0, "kCGWindowAlpha": 1.0, "kCGWindowBounds": ["X": 0, "Y": 0, "Width": 1000, "Height": 800]],
]
check(blockedWindowOwnerPid(overlayList, at: CGPoint(x: 150, y: 150), excludingPid: 99, isBlockedPid: isBlockedPid) == 10, "a full-screen overlay at a higher layer does not hide a blocked window")
check(blockedWindowOwnerPid(overlayList, at: CGPoint(x: 500, y: 500), excludingPid: 99, isBlockedPid: isBlockedPid) == nil, "outside the blocked window nothing is refused")
// Key focus can sit in a non-activating panel of a blocked app while another app is frontmost
check(keyboardTargetRefusalPid(frontmostPid: 5, focusedPid: 10, isBlockedPid: isBlockedPid) == 10, "a blocked focused app is refused though the frontmost app is fine")
check(keyboardTargetRefusalPid(frontmostPid: 10, focusedPid: nil, isBlockedPid: isBlockedPid) == 10, "a blocked frontmost app is refused when the focused app is unknown")
check(keyboardTargetRefusalPid(frontmostPid: 5, focusedPid: nil, isBlockedPid: isBlockedPid) == nil, "unknown focus with an unblocked frontmost app runs")
check(keyboardTargetRefusalPid(frontmostPid: 5, focusedPid: 6, isBlockedPid: isBlockedPid) == nil, "unblocked frontmost and focused apps run")
// Coordinate act refuses a blocked window or AX hit at the point
check(coordinateTargetRefusalPid(windows: overlayList, at: CGPoint(x: 150, y: 150), hitPid: nil, excludingPid: 99, isBlockedPid: isBlockedPid) == 10, "coordinate act refuses a blocked window at the point")
check(coordinateTargetRefusalPid(windows: [], at: CGPoint(x: 1, y: 1), hitPid: 10, excludingPid: 99, isBlockedPid: isBlockedPid) == 10, "coordinate act refuses a blocked AX hit")
check(coordinateTargetRefusalPid(windows: [], at: CGPoint(x: 1, y: 1), hitPid: 99, excludingPid: 99, isBlockedPid: isBlockedPid) == nil, "own AX hit is ignored")
check(coordinateTargetRefusalPid(windows: overlayList, at: CGPoint(x: 500, y: 500), hitPid: 30, excludingPid: 99, isBlockedPid: isBlockedPid) == nil, "unblocked point runs")
check(actPointerRefusalApplies(delivery: "hid"), "HID act runs the pointer refusal")
check(!actPointerRefusalApplies(delivery: "pid"), "pid act skips the pointer refusal so a host terminal cannot block it")
check(hitTestVertexIndices(count: 5) == [0, 4], "AX hit test runs at drag endpoints only")
check(hitTestVertexIndices(count: 1) == [0], "a single point is its own endpoint")
check(hitTestVertexIndices(count: 0).isEmpty, "no vertices, no hit tests")
check(targetHoldsFocus(frontmostPid: 7, focusedPid: nil, targetPid: 7), "frontmost target with unknown AX focus holds focus")
check(targetHoldsFocus(frontmostPid: 7, focusedPid: 7, targetPid: 7), "frontmost and focused target holds focus")
check(!targetHoldsFocus(frontmostPid: 10, focusedPid: 7, targetPid: 7), "a host terminal still frontmost does not hold focus")
check(!targetHoldsFocus(frontmostPid: 7, focusedPid: 10, targetPid: 7), "a blocked focused panel does not hold focus")
var polls = 0
var slept: [Int] = []
var clock = 0
let advance: (Int) -> Void = { slept.append($0); clock += $0 }
check(waitForFocus(maxMs: 200, stepMs: 10, holdsFocus: { polls += 1; return polls == 4 }, sleepMs: advance, nowMs: { clock }), "focus that settles within the bound is accepted")
check(polls == 4 && slept == [10, 10, 10], "polling sleeps between checks and stops once focus holds")
polls = 0
slept = []
clock = 0
check(!waitForFocus(maxMs: 200, stepMs: 10, holdsFocus: { polls += 1; return false }, sleepMs: advance, nowMs: { clock }), "focus that never settles is refused")
check(polls == 21 && slept.count == 20 && slept.reduce(0, +) == 200, "polling is bounded at 200 ms")
polls = 0
clock = 0
// A stalled focus probe (e.g. a hung app's AX call) burns wall time; the deadline is wall time, not step count.
check(!waitForFocus(maxMs: 200, stepMs: 10, holdsFocus: { polls += 1; clock += 150; return false }, sleepMs: { clock += $0 }, nowMs: { clock }), "a stalled probe is refused")
check(polls == 2, "the wall-clock deadline stops after two stalled probes, not twenty-one")
polls = 0
check(waitForFocus(maxMs: 200, stepMs: 10, holdsFocus: { polls += 1; return true }, sleepMs: { _ in }, nowMs: { 0 }), "already-focused target returns at once")
check(polls == 1, "no polling when focus already holds")

// selectText range validation, paste clipboard fence and outcome classification
check(selectionRangeIssue(start: 0, length: 0, valueLength: 5) == nil, "caret at the start is valid")
check(selectionRangeIssue(start: 5, length: 0, valueLength: 5) == nil, "caret at the end is valid")
check(selectionRangeIssue(start: 1, length: 4, valueLength: 5) == nil, "range ending at the end is valid")
check(selectionRangeIssue(start: 1, length: 5, valueLength: 5) != nil, "range past the end is refused")
check(selectionRangeIssue(start: 6, length: 0, valueLength: 5) != nil, "caret past the end is refused")
check(selectionRangeIssue(start: -1, length: 0, valueLength: 5) != nil, "negative start is refused")
check(selectionRangeIssue(start: 0, length: -1, valueLength: nil) != nil, "negative length is refused even without a value")
check(selectionRangeIssue(start: 99, length: 9, valueLength: nil) == nil, "unreadable value defers to the element")
check(clipboardRestoreIsSafe(changeCountAfterWrite: 7, changeCountNow: 7), "untouched clipboard is restored")
check(!clipboardRestoreIsSafe(changeCountAfterWrite: 7, changeCountNow: 8), "a newer clipboard write is never overwritten")
check(pasteOutcome(valueBefore: "a", valueAfter: "ab") == "worked", "changed value proves the paste")
check(pasteOutcome(valueBefore: "a", valueAfter: "a") == "unknown", "unchanged value is unknown, never didnt: a slow target may still paste")
check(pasteOutcome(valueBefore: nil, valueAfter: "a") == "unknown" && pasteOutcome(valueBefore: "a", valueAfter: nil) == "unknown", "unreadable value is unknown")
check(selectionOutcome(requested: (2, 3), readBack: (2, 3)) == "worked", "matching read-back proves the selection")
check(selectionOutcome(requested: (2, 3), readBack: (0, 0)) == "didnt", "a rewritten range is a failure")
check(selectionOutcome(requested: (2, 3), readBack: nil) == "unknown", "no read-back is unknown")
check(pasteTransientTypeIdentifiers == ["org.nspasteboard.TransientType", "org.nspasteboard.AutoGeneratedType", "org.nspasteboard.ConcealedType"], "paste marks its item transient, auto-generated and concealed")
var restores = 0
var ranBody = false
struct Refused: Error {}
func restoreOnce() -> Bool { restores += 1; return true }
check((try? withRestoredClipboard(write: {}, restore: restoreOnce, body: { ranBody = true })) == true && restores == 1 && ranBody, "normal completion restores once")
restores = 0; ranBody = false
do { _ = try withRestoredClipboard(write: {}, restore: restoreOnce, body: { throw Refused() }); check(false, "a refusing body must rethrow") } catch { check(error is Refused && restores == 1, "a refusal in the body restores the clipboard and rethrows") }
restores = 0
do { _ = try withRestoredClipboard(write: { throw Refused() }, restore: restoreOnce, body: { ranBody = true }); check(false, "a failed write must rethrow") } catch { check(error is Refused && restores == 1 && !ranBody, "a failed write restores the clipboard and skips the body") }
check(!(try! withRestoredClipboard(write: {}, restore: { false }, body: {})), "a skipped restore is reported")
check(secondaryActionRetryIsSafe(axError: AXError.invalidUIElement.rawValue), "a dead element may be retried")
check(!secondaryActionRetryIsSafe(axError: AXError.cannotComplete.rawValue) && !secondaryActionRetryIsSafe(axError: AXError.failure.rawValue) && !secondaryActionRetryIsSafe(axError: AXError.actionUnsupported.rawValue), "other AX failures are never retried")
check(secondaryActionFailureOutcome(axError: AXError.cannotComplete.rawValue) == "unknown", "cannotComplete may have run the action")
check(secondaryActionFailureOutcome(axError: AXError.failure.rawValue) == "didnt" && secondaryActionFailureOutcome(axError: AXError.actionUnsupported.rawValue) == "didnt", "other failures are didnt")
var axCalls = 0
_ = targetHoldsFocus(frontmostPid: 10, focusedPid: { axCalls += 1; return 7 }(), targetPid: 7)
check(axCalls == 0, "AX focus is not queried while another app is frontmost")
let displayApps: [(id: String?, name: String)] = [("com.apple.Terminal", "Terminal"), ("com.example.Safe", "Safe"), (nil, "Unbundled"), ("COM.EXAMPLE.VAULT", "Vault")]
check(itemsWithBlockedBundleId(displayApps, blocked: ["com.apple.terminal", "com.example.Vault"], bundleId: { $0.id }).map { $0.name } == ["Terminal", "Vault"], "display capture excludes exactly the blocked apps, case-insensitively")
check(itemsWithBlockedBundleId(displayApps, blocked: [], bundleId: { $0.id }).isEmpty, "empty blocklist excludes nothing")

// Drag interpolation
let pts = interpolatedDragPoints(from: CGPoint(x: 0, y: 0), to: CGPoint(x: 100, y: 0), maxStep: 12)
check(pts.count == 9 && pts.last == CGPoint(x: 100, y: 0), "100pt drag steps <=12 and ends exactly at target")
check(zip([CGPoint(x: 0, y: 0)] + pts, pts).allSatisfy { hypot($1.x - $0.x, $1.y - $0.y) <= 12.0001 }, "no step exceeds maxStep")
check(interpolatedDragPoints(from: CGPoint(x: 5, y: 5), to: CGPoint(x: 5, y: 5), maxStep: 12) == [CGPoint(x: 5, y: 5)], "zero-length drag is the endpoint")
check(interpolatedDragPoints(from: .zero, to: CGPoint(x: 100000, y: 0), maxStep: 12).count == 400, "steps capped")

// Ref store: element refs live as long as their look; unowned refs are FIFO-capped
let store = AXRefStore(unownedCapacity: 3)
let el = AXUIElementCreateApplication(getpid())
let w1 = store.storeWindow(el)
check(store.storeWindow(el) == w1, "window refs are deduped")
check(w1.range(of: "^w[0-9a-f]+-[0-9]+$", options: .regularExpression) != nil, "window ref carries the epoch")
let a = (0..<5).map { _ in store.storeElement(el, owner: "look_1") }
let b = (0..<2).map { _ in store.storeElement(el, owner: "look_2") }
check(a[0].range(of: "^e[0-9a-f]+-[0-9]+$", options: .regularExpression) != nil, "element ref carries the epoch")
check(store.elementCount == 7, "owned refs stored")
store.dropElements(owner: "look_1")
check(store.elementCount == 2 && store.element(for: a[0]) == nil && store.element(for: b[1]) != nil, "dropping a look frees only its refs")
store.dropElements(owner: "look_1")
check(store.elementCount == 2, "dropping twice is a no-op")
let u = (0..<5).map { _ in store.storeElement(el, snapshot: AXRefStore.Snapshot(role: "r", identifier: "", label: "", rect: .zero)) }
check(store.elementCount == 5, "unowned refs capped at 3")
check(store.element(for: u[0]) == nil && store.snapshot(for: u[1]) == nil && store.element(for: u[4]) != nil, "unowned FIFO evicts the oldest with its snapshot")
let g = AXRefStore()
let base = g.storeElement(el, owner: "look_a")
g.transferElements(from: "look_a", to: "look_b")
g.dropElements(owner: "look_a")
check(g.element(for: base) != nil, "refs handed to a successor look survive the base look's eviction")
g.dropElements(owner: "look_b")
check(g.element(for: base) == nil, "transferred refs drop with the successor look")
check(AXRefStore().storeWindow(el) != w1, "another store (helper process) never reissues the same ref")

// Keyboard layout gate for physical key strokes (upstream #113)
check(usLayoutKeyStroke(for: ":").map { $0.key == ";" && $0.shift } == true, "colon is shifted semicolon on the US layout")
check(usLayoutKeyStroke(for: "Q").map { $0.key == "q" && $0.shift } == true, "uppercase letter is shifted")
check(usLayoutKeyStroke(for: "æ") == nil && usLayoutKeyStroke(for: "ab") == nil, "no US key for non-ASCII or multi-character text")
check(physicalKeyStrokeTypes(":", isKeyboardLayout: true, layoutProduces: ":"), "matching layout output allows the physical key")
check(!physicalKeyStrokeTypes(":", isKeyboardLayout: true, layoutProduces: "Æ"), "layout that types another character falls back")
check(!physicalKeyStrokeTypes("'", isKeyboardLayout: true, layoutProduces: nil), "dead key falls back")
check(!physicalKeyStrokeTypes("a", isKeyboardLayout: false, layoutProduces: "a"), "input method falls back even when the layout matches")

// Scroll bar fallback (upstream #114)
func near(_ value: Double?, _ expected: Double) -> Bool { value.map { abs($0 - expected) < 0.001 } ?? false }
check(near(scrollBarTargetValue(current: 0, delta: 600, viewportLength: 579, contentLength: 1374, thumbLength: nil, trackLength: nil), 600.0 / 795.0), "content size maps points to the scroll bar range")
check(near(scrollBarTargetValue(current: 0.5, delta: 2_000, viewportLength: 579, contentLength: 1374, thumbLength: nil, trackLength: nil), 1), "large delta clamps to the end")
check(near(scrollBarTargetValue(current: 0.5, delta: -2_000, viewportLength: 579, contentLength: 1374, thumbLength: nil, trackLength: nil), 0), "negative delta clamps to the start")
check(near(scrollBarTargetValue(current: 0, delta: 100, viewportLength: 500, contentLength: nil, thumbLength: 250, trackLength: 500), 0.2), "thumb ratio estimates the content length")
check(scrollBarTargetValue(current: 1, delta: 100, viewportLength: 579, contentLength: 1374, thumbLength: nil, trackLength: nil) == nil, "bar at the end can't scroll further")
check(scrollBarTargetValue(current: 0, delta: 100, viewportLength: 579, contentLength: 579, thumbLength: nil, trackLength: nil) == nil, "content that fits has nothing to scroll")
check(scrollBarTargetValue(current: 0, delta: 0, viewportLength: 579, contentLength: 1374, thumbLength: nil, trackLength: nil) == nil, "zero delta does nothing")

// Scroll bar write scope and per-axis delivery
check(scrollBarWriteAllowed(depthFromStart: 0, hitTestResolvesToArea: false), "the scroll area itself may be written")
check(scrollBarWriteAllowed(depthFromStart: 1, hitTestResolvesToArea: false), "a direct child of the scroll area may be written")
check(!scrollBarWriteAllowed(depthFromStart: 3, hitTestResolvesToArea: false), "a deeper ref in an inner scroller must fall through to the wheel")
check(scrollBarWriteAllowed(depthFromStart: 3, hitTestResolvesToArea: true), "a hit test resolving to the same area allows the write")
let bothMoved = remainingScroll(requestedX: 5, requestedY: 7, x: .moved, y: .moved)
check(bothMoved.x == 0 && bothMoved.y == 0, "both axes moved leaves nothing to deliver")
let onlyYMoved = remainingScroll(requestedX: 5, requestedY: 7, x: .notWritten, y: .moved)
check(onlyYMoved.x == 5 && onlyYMoved.y == 0, "an unwritten horizontal axis stays requested")
let onlyXMoved = remainingScroll(requestedX: 5, requestedY: 0, x: .moved, y: .notWritten)
check(onlyXMoved.x == 0 && onlyXMoved.y == 0, "an axis never requested stays zero")
let lateWrite = remainingScroll(requestedX: 5, requestedY: 7, x: .unconfirmed, y: .unconfirmed)
check(lateWrite.x == 0 && lateWrite.y == 0, "an accepted but unconfirmed write is delivered, not carried to the wheel")
check(scrollWritesConfirmed(x: .moved, y: .notWritten), "confirmed and unwritten axes leave the write confirmed")
check(!scrollWritesConfirmed(x: .moved, y: .unconfirmed), "an unconfirmed axis makes the outcome unknown")

// Wheel counts follow the AX/scroll-bar convention on both axes (#650)
let wheelRight = scrollWheelCounts(deltaX: 200, deltaY: 0)
check(wheelRight.wheel2 == -200 && wheelRight.wheel1 == 0, "positive scrollX posts a negative wheel2 so the view scrolls right")
let wheelLeft = scrollWheelCounts(deltaX: -200, deltaY: 0)
check(wheelLeft.wheel2 == 200, "negative scrollX posts a positive wheel2 so the view scrolls left")
let wheelDown = scrollWheelCounts(deltaX: 0, deltaY: 200)
check(wheelDown.wheel1 == -200 && wheelDown.wheel2 == 0, "positive scrollY posts a negative wheel1 so the view scrolls down")
let wheelUp = scrollWheelCounts(deltaX: 0, deltaY: -200)
check(wheelUp.wheel1 == 200, "negative scrollY posts a positive wheel1 so the view scrolls up")
let wheelExtreme = scrollWheelCounts(deltaX: Int(Int32.min), deltaY: Int.min)
check(wheelExtreme.wheel2 == Int32.max && wheelExtreme.wheel1 == Int32.max, "extreme negative deltas clamp instead of trapping")
let wheelHuge = scrollWheelCounts(deltaX: Int.max, deltaY: Int.max)
check(wheelHuge.wheel2 == -Int32.max && wheelHuge.wheel1 == -Int32.max, "extreme positive deltas clamp instead of trapping")

if failures > 0 { exit(1) }
print("macos native pure checks passed")
}
/// Translate installed keyboard-layout data without posting a key or activating an app.
func runKeyboardAssertions() {

var failures = 0
var checked = 0
func check(_ ok: Bool, _ name: String) { if !ok { failures += 1; print("FAIL: \(name)") } }

func installedSource(_ id: String) -> TISInputSource? {
	let filter = [kTISPropertyInputSourceID as String: id] as CFDictionary
	guard let list = TISCreateInputSourceList(filter, true)?.takeRetainedValue() as? [TISInputSource] else { return nil }
	return list.first
}
func layoutData(_ id: String) -> Data? {
	guard let source = installedSource(id), let data = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) else { return nil }
	return Unmanaged<CFData>.fromOpaque(data).takeUnretainedValue() as Data
}
// US virtual key codes, as used by Bridge.keyCode.
let semicolon: UInt16 = 41, slash: UInt16 = 44, minus: UInt16 = 27, keyA: UInt16 = 0, digit1: UInt16 = 18

if let us = layoutData("com.apple.keylayout.US") {
	checked += 1
	check(keyboardLayoutCharacter(layoutData: us, keyCode: semicolon, shift: true) == ":", "US shift+semicolon types a colon")
	check(keyboardLayoutCharacter(layoutData: us, keyCode: slash, shift: false) == "/", "US slash types a slash")
	check(keyboardLayoutCharacter(layoutData: us, keyCode: keyA, shift: true) == "A", "US shift+a types A")
}
let keyV: UInt16 = 9
/// These layouts ship with macOS: a missing one fails the suite instead of silently skipping its checks.
func requiredLayout(_ id: String) -> Data {
	guard let data = layoutData(id) else { print("FAIL: required keyboard layout \(id) is not installed"); exit(1) }
	checked += 1
	return data
}
check(pasteKeyCode(layoutData: nil) == nil, "an unreadable layout has no paste key")
if let us = layoutData("com.apple.keylayout.US") {
	checked += 1
	check(pasteKeyCode(layoutData: us) == keyV, "US cmd+v is key code 9")
	check(layoutCommandKeyCode(producing: "~", layoutData: us) == nil, "a character no key produces has no command key code")
}
do {
	let dvorak = requiredLayout("com.apple.keylayout.Dvorak")
	let typed = (0..<UInt16(128)).first { keyboardLayoutCharacter(layoutData: dvorak, keyCode: $0, shift: false) == "v" }
	check(typed != nil && typed != keyV, "plain Dvorak types v on another key than ANSI key code 9")
	check(pasteKeyCode(layoutData: dvorak) == typed, "plain Dvorak cmd+v follows the layout: the Dvorak v key")
}
do {
	let dvorakQwerty = requiredLayout("com.apple.keylayout.DVORAK-QWERTYCMD")
	check(keyboardLayoutCharacter(layoutData: dvorakQwerty, keyCode: 47, modifierState: commandModifierState) == ".", "Dvorak-QWERTY command map keeps QWERTY: key 47 is a period")
	check(pasteKeyCode(layoutData: dvorakQwerty) == keyV, "Dvorak - QWERTY Command pastes with key code 9, not the Dvorak v key")
}
for id in ["com.apple.keylayout.Russian", "com.apple.keylayout.Ukrainian", "com.apple.keylayout.Greek", "com.apple.keylayout.Hebrew", "com.apple.keylayout.Arabic"] {
	let required = id.hasSuffix("Russian") || id.hasSuffix("Ukrainian")
	if let layout = required ? requiredLayout(id) : layoutData(id) {
		if !required { checked += 1 }
		check(keyboardLayoutCharacter(layoutData: layout, keyCode: keyV, shift: false) != "v", "\(id) types no v on key 9")
		check(keyboardLayoutCharacter(layoutData: layout, keyCode: keyV, modifierState: commandModifierState) == "v", "\(id) command map yields v on key 9")
		check(pasteKeyCode(layoutData: layout) == keyV, "\(id) pastes with key code 9, it is not refused")
	}
}
if let danish = layoutData("com.apple.keylayout.Danish") {
	checked += 1
	check(keyboardLayoutCharacter(layoutData: danish, keyCode: semicolon, shift: true) != ":", "Danish shift+semicolon is not a colon")
	check(keyboardLayoutCharacter(layoutData: danish, keyCode: slash, shift: false) != "/", "Danish slash key is not a slash")
	check(keyboardLayoutCharacter(layoutData: danish, keyCode: minus, shift: false) != "-", "Danish minus key is not a minus")
	check(keyboardLayoutCharacter(layoutData: danish, keyCode: keyA, shift: false) == "a", "Danish letters still type directly")
}
if let french = layoutData("com.apple.keylayout.French") {
	checked += 1
	check(keyboardLayoutCharacter(layoutData: french, keyCode: keyA, shift: false) != "a", "AZERTY a key types q")
	check(keyboardLayoutCharacter(layoutData: french, keyCode: digit1, shift: false) != "1", "AZERTY digits need Shift")
}
if let pinyin = installedSource("com.apple.inputmethod.SCIM.ITABC"), let type = TISGetInputSourceProperty(pinyin, kTISPropertyInputSourceType) {
	checked += 1
	check((Unmanaged<CFString>.fromOpaque(type).takeUnretainedValue() as String) != (kTISTypeKeyboardLayout as String), "Pinyin is an input method, not a keyboard layout")
}
let active = currentKeyboardInputSource()
check(active.layoutData != nil, "active keyboard layout data is readable")

if failures > 0 { exit(1) }
if checked == 0 { print("FAIL: no reference keyboard layouts installed"); exit(1) }
print("macos keyboard layout checks passed (\(checked) reference sources)")
}
@main
struct HeadlessTests {
 @MainActor static func main() { runPureAssertions(); runKeyboardAssertions(); runRequestFramingAssertions(); testMotionLifecycle(); runCursorMotionAssertions() }
    @MainActor
    static func testMotionLifecycle() {
        let renderer = AgentCursorRenderer()
        renderer.setInitialPosition(CGPoint(x: 100, y: 100))

        expect(!renderer.isAnimating, "renderer should start idle")

        renderer.moveTo(point: CGPoint(x: 500, y: 400))
        expect(renderer.isAnimating, "renderer should become active when motion starts")

        var now: CFTimeInterval = 0
        for _ in 0..<12_000 where renderer.isAnimating {
            now += 1.0 / 120.0
            renderer.tick(now: now)
        }

        expect(!renderer.isAnimating, "renderer should become idle after motion settles")

        renderer.moveTo(point: CGPoint(x: 800, y: 600))
        renderer.tick(now: now + 1.0 / 120.0)
        let stoppedPosition = renderer.position

        renderer.cancelAnimation()
        expect(!renderer.isAnimating, "cancelled motion should become idle")

        renderer.tick(now: now + 1)
        expect(renderer.position == stoppedPosition, "idle ticks should not change the cancelled position")

        renderer.setInitialPosition(CGPoint(x: 100, y: 100))
        renderer.moveTo(point: CGPoint(x: 300, y: 300))
        for _ in 0..<12 {
            now += 1.0 / 120.0
            renderer.tick(now: now)
        }
        let latestTarget = CGPoint(x: 900, y: 700)
        renderer.moveTo(point: latestTarget)
        for _ in 0..<12_000 where renderer.isAnimating {
            now += 1.0 / 120.0
            renderer.tick(now: now)
        }

        let endpointOffset = CGFloat(cos(Double.pi / 4) * 16)
        let expectedPosition = CGPoint(
            x: latestTarget.x + endpointOffset,
            y: latestTarget.y + endpointOffset
        )
        expect(distance(renderer.position, expectedPosition) < 0.001, "latest target should supersede in-flight motion")
    }

    private static func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
        if !condition() { print("FAIL: \(message)"); exit(1) }
    }

    private static func distance(_ lhs: CGPoint, _ rhs: CGPoint) -> CGFloat {
        hypot(lhs.x - rhs.x, lhs.y - rhs.y)
    }
}
