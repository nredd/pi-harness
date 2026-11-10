// Compiles the PURE region of native/macos/bridge.swift with a fixture main and runs it.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";

// Each run compiles real Swift. Measured on 72 hosted `owned shard (macos-14, ts)` jobs (`ci.yml`
// runs 41781117332-41960624589): green p50 6472 ms, p99 9844 ms (n=67); slowest 21644 ms on a
// ~3.5x-degraded runner (job 126769877232), which overran the 20 s suite default. The budget is
// ~2x that, as in `docs/test-worker-budgets.md` (#457).
const SWIFT_COMPILE_AND_RUN_BUDGET_MS = 45_000;

// NOT RUN elsewhere (requires macOS swiftc): Vitest reports the skip, never a pass.
test.skipIf(process.platform !== "darwin")("macOS native pure ref store and input helpers", { timeout: SWIFT_COMPILE_AND_RUN_BUDGET_MS }, async () => {
	const source = readFileSync(new URL("../native/macos/bridge.swift", import.meta.url), "utf8");
	const match = source.match(/\/\/ BEGIN PURE[^\n]*\n([\s\S]*?)\/\/ END PURE/);
	if (!match) throw new Error("PURE region not found in bridge.swift");

	const main = `
import Foundation\nimport CoreGraphics\nimport ApplicationServices
var failures = 0
func check(_ ok: Bool, _ name: String) { if !ok { failures += 1; print("FAIL: \\(name)") } }

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
check(topmostWindowOwnerPid(windowList, at: CGPoint(x: 150, y: 150), excludingPid: 99) == 50, "front-most window wins")
check(topmostWindowOwnerPid(windowList, at: CGPoint(x: 150, y: 150), excludingPid: 50) == 10, "own overlay and transparent windows are skipped")
check(topmostWindowOwnerPid(windowList, at: CGPoint(x: 1500, y: 150), excludingPid: 99) == nil, "no window at the point")

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
`;
	const dir = mkdtempSync(path.join(tmpdir(), "pcu-pure-"));
	try {
		writeFileSync(path.join(dir, "main.swift"), match[1] + main);
		execFileSync("swiftc", ["-O", "-o", path.join(dir, "t"), path.join(dir, "main.swift")], { stdio: "inherit" });
		let output;
		try {
			output = execFileSync(path.join(dir, "t"), { encoding: "utf8" });
		} catch (error) {
			// Vitest prints the message, not the child's stdout: carry the Swift FAIL lines into it.
			throw new Error(`${error.message}\n${error.stdout ?? ""}`, { cause: error });
		}
		process.stdout.write(output);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// Compiles the standalone KEYBOARD LAYOUT region (Carbon TIS) against real installed layouts.
test.skipIf(process.platform !== "darwin")("macOS keyboard layout translation", { timeout: SWIFT_COMPILE_AND_RUN_BUDGET_MS }, async () => {
	const source = readFileSync(new URL("../native/macos/bridge.swift", import.meta.url), "utf8");
	const match = source.match(/\/\/ BEGIN KEYBOARD LAYOUT[^\n]*\n([\s\S]*?)\/\/ END KEYBOARD LAYOUT/);
	if (!match) throw new Error("KEYBOARD LAYOUT region not found in bridge.swift");

	const main = `
import Foundation
import Carbon.HIToolbox
var failures = 0
var checked = 0
func check(_ ok: Bool, _ name: String) { if !ok { failures += 1; print("FAIL: \\(name)") } }

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
print("macos keyboard layout checks passed (\\(checked) reference sources)")
`;
	const dir = mkdtempSync(path.join(tmpdir(), "pcu-layout-"));
	try {
		writeFileSync(path.join(dir, "main.swift"), match[1] + main);
		execFileSync("swiftc", ["-O", "-o", path.join(dir, "t"), path.join(dir, "main.swift")], { stdio: "inherit" });
		let output;
		try {
			output = execFileSync(path.join(dir, "t"), { encoding: "utf8" });
		} catch (error) {
			throw new Error(`${error.message}\n${error.stdout ?? ""}`, { cause: error });
		}
		process.stdout.write(output);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
