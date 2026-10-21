#!/usr/bin/env node
// Compiles the PURE region of native/macos/bridge.swift with a fixture main and runs it.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

if (process.platform !== "darwin") {
	console.log("macos native pure checks skipped (not macOS)");
	process.exit(0);
}
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

if failures > 0 { exit(1) }
print("macos native pure checks passed")
`;
const dir = mkdtempSync(path.join(tmpdir(), "pcu-pure-"));
try {
	writeFileSync(path.join(dir, "main.swift"), match[1] + main);
	execFileSync("swiftc", ["-O", "-o", path.join(dir, "t"), path.join(dir, "main.swift")], { stdio: "inherit" });
	process.stdout.write(execFileSync(path.join(dir, "t"), { encoding: "utf8" }));
} finally {
	rmSync(dir, { recursive: true, force: true });
}
