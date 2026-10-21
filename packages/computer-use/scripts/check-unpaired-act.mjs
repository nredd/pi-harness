#!/usr/bin/env node
// act_ui on an unpaired root (no windowId) must succeed with a semantic successor, never root_not_capturable.
import assert from "node:assert/strict";

const { currentPlatformBackend } = await import("../src/platform/index.ts");
const { executeFind, executeObserve, executeAct } = await import("../src/bridge.ts");
const { parseLookResponse } = await import("../src/outline.ts");
const { withDesktopLock } = await import("../src/desktop.ts");

const root = {
	kind: "dialog", rootRef: "ax:dlg", windowRef: "ax:dlg", pid: 7, appName: "App", title: "Unpaired", zOrder: 0,
	framePoints: { x: 0, y: 0, w: 300, h: 200 }, scaleFactor: 1, isOnscreen: true, isFocused: true, isMinimized: false, isMain: false, isModal: true,
};
const observeCalls = [];
const lookPayload = (n) => ({
	lookId: `look${n}`, capturedAt: 1,
	window: { windowId: 0, rootRef: "ax:dlg", kind: "dialog", framePoints: root.framePoints, scaleFactor: 1, isModal: true, role: "AXWindow", subrole: "AXDialog", metadata: { pairing: { confidence: "low", score: 0 }, sheetCount: 0 } },
	outline: { ref: "w", wireRef: "w", role: "AXWindow", subrole: "AXDialog", title: "Unpaired", label: "", value: "", actions: [], rect: { x: 0, y: 0, w: 300, h: 200 }, children: [{ ref: "b", wireRef: "b", role: "AXButton", subrole: "", title: "Go", label: "Go", value: "", actions: ["AXPress"], rect: { x: 10, y: 10, w: 50, h: 20 }, children: [] }] },
	timings: { captureMs: 0, describeMs: 0, readTextMs: 0 },
});
Object.assign(currentPlatformBackend, {
	ensureReady: async () => ({ permissionStatus: { accessibility: true, screenRecording: true }, lastPermissionCheckAt: Date.now() }),
	listApps: async () => [{ appName: "App", pid: 7, isFrontmost: true }],
	listRoots: async () => [root],
	getFrontmost: async () => ({ appName: "App", pid: 7 }),
	observe: async (request) => {
		observeCalls.push(request);
		if (request.includeImage !== false && !request.target.windowId) throw Object.assign(new Error("Root has no capturable window"), { code: "root_not_capturable" });
		return parseLookResponse(lookPayload(observeCalls.length));
	},
	act: async () => ({ outcome: "worked", performed: { delivery: "pid" } }),
	actBatch: async () => ({ outcome: "worked", performed: { delivery: "pid", transaction: true, actionCount: 1 }, steps: [{ outcome: "worked" }] }),
});

const ctx = { cwd: process.cwd(), hasUI: false, ui: { notify() {} }, sessionManager: { getBranch: () => [] } };
const call = (fn, params) => fn("t", params, undefined, undefined, ctx);
const text = (r) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");

await call(executeFind, { app: "App" });
const observed = await call(executeObserve, { root: "@r1", mode: "semantic" });
const stateId = text(observed).match(/stateId ([0-9a-f-]{36})/)[1];
observeCalls.length = 0;
const result = await call(executeAct, { stateId, actions: [{ action: "press", ref: text(observed).match(/(@e\d+) AXButton/)[1] }] });
assert.notEqual(result.details?.status, "post_action_observation_failed", text(result));
assert.match(text(result), /Executed 1 checked UI action/);
const successor = observeCalls.at(-1);
assert.equal(successor.includeImage, false, "unpaired successor must be semantic");
assert.equal(successor.target.windowId, undefined, "windowId 0 must not be sent");
assert.equal(successor.target.windowRef, "ax:dlg");
// Root delta refs: the ref shown for a new dialog must be the one find_roots issues for it, even when the
// dialog has a real windowId (helper deltas carry helper-native refs, a different namespace).
const dialog2 = { ...root, rootRef: "ax:dlg2", windowRef: "ax:dlg2", windowId: 99, title: "Confirm", framePoints: { x: 50, y: 50, w: 200, h: 100 } };
const mainWindow = { ...root, kind: "window", rootRef: "ax:main", windowRef: "ax:main", windowId: 5, title: "Main", isModal: false, isMain: true, isFocused: false };
currentPlatformBackend.listRoots = async () => [mainWindow, dialog2, root];
const appeared = [{ change: "appeared", kind: "dialog", ref: "ax:dlg2", title: "Confirm", pid: 7, isModal: true }];
currentPlatformBackend.act = async () => ({ outcome: "worked", performed: { delivery: "pid" }, rootDelta: appeared });
currentPlatformBackend.actBatch = async () => ({
	outcome: "worked",
	performed: { delivery: "pid", transaction: true, actionCount: 1 },
	steps: [{ outcome: "worked", rootDelta: appeared }],
	rootDelta: appeared,
});
const second = await call(executeObserve, { root: "@r1", mode: "semantic" });
const second_state = text(second).match(/stateId ([0-9a-f-]{36})/)[1];
const acted = await call(executeAct, { stateId: second_state, actions: [{ action: "press", ref: text(second).match(/(@e\d+) AXButton/)[1] }] });
const deltaRef = text(acted).match(/New root: dialog "Confirm"[^\n]*\((@r\d+)\)/)?.[1];
assert.ok(deltaRef, `delta line missing an @r ref:\n${text(acted)}`);
const refreshed = await call(executeFind, { app: "App" });
const findRef = text(refreshed).match(/(@r\d+) dialog App[^\n]*Confirm/)?.[1];
assert.equal(deltaRef, findRef, "delta ref and find_roots ref must name the same root with one @r ref");
assert.doesNotMatch(text(acted), /Unknown App/);

// Desktop lock scope: only foreground (physical) delivery waits for desktop_input; background acts don't.
currentPlatformBackend.listRoots = async () => [root];
const policies = [];
let needForeground = false;
currentPlatformBackend.act = async (request) => {
	policies.push(request.policy);
	if (needForeground && request.policy !== "foreground") throw Object.assign(new Error("needs focus"), { code: "foreground_required" });
	return { outcome: "worked", performed: { delivery: request.policy === "foreground" ? "hid" : "pid" } };
};
let release;
const held = withDesktopLock(() => new Promise((resolve) => { release = resolve; }));
const lockObs = await call(executeObserve, { root: "@r1", mode: "semantic" });
const lockState = () => text(lockObs).match(/stateId ([0-9a-f-]{36})/)[1];
const goRef = text(lockObs).match(/(@e\d+) AXButton/)[1];
const background = await Promise.race([
	call(executeAct, { stateId: lockState(), actions: [{ action: "press", ref: goRef }] }).then(() => "done"),
	new Promise((resolve) => setTimeout(() => resolve("blocked"), 2_000)),
]);
assert.equal(background, "done", "a background act must not wait for the desktop lock");
assert.ok(!policies.includes("foreground"));
needForeground = true;
policies.length = 0;
const again = await call(executeObserve, { root: "@r1", mode: "semantic" });
let foregroundDone = false;
const foreground = call(executeAct, { stateId: text(again).match(/stateId ([0-9a-f-]{36})/)[1], actions: [{ action: "press", ref: text(again).match(/(@e\d+) AXButton/)[1] }] }).then(() => { foregroundDone = true; });
await new Promise((resolve) => setTimeout(resolve, 200));
assert.equal(foregroundDone, false, "a foreground act must wait for the desktop lock");
assert.ok(!policies.includes("foreground"), "foreground delivery must not start while the lock is held");
release();
await held;
await foreground;
assert.ok(policies.includes("foreground"));

// Once a transaction goes physical it keeps the lock to the end: a desktop_input queued during step 1 runs
// only after step 2 (which may rely on focus step 1 set up), never between them.
const order = [];
let queuedDesk;
currentPlatformBackend.act = async (request) => {
	if (request.policy !== "foreground") throw Object.assign(new Error("needs focus"), { code: "foreground_required" });
	order.push("fg");
	queuedDesk ??= withDesktopLock(async () => { order.push("desk"); });
	await new Promise((resolve) => setTimeout(resolve, 20));
	return { outcome: "worked", performed: { delivery: "hid" } };
};
const two = await call(executeObserve, { root: "@r1", mode: "semantic" });
const goTwice = text(two).match(/(@e\d+) AXButton/)[1];
await call(executeAct, { stateId: text(two).match(/stateId ([0-9a-f-]{36})/)[1], actions: [{ action: "press", ref: goTwice }, { action: "press", ref: goTwice }] });
await queuedDesk;
assert.deepEqual(order, ["fg", "fg", "desk"], "desktop_input must not interleave inside a physical act_ui transaction");
// And the lease is released afterwards: the lock is free again.
assert.equal(await Promise.race([withDesktopLock(async () => "free"), new Promise((resolve) => setTimeout(() => resolve("stuck"), 1_000))]), "free");

console.log("unpaired act checks passed");
