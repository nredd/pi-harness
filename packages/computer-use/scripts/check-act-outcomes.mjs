#!/usr/bin/env node
// Post-action classification: replaced vs closed vs stale root, never silent success.
import assert from "node:assert/strict";

const { currentPlatformBackend } = await import("../src/platform/index.ts");
const { terminalDesktopActionResult: rawTerminal, testing } = await import("../src/bridge.ts");

const target = { appName: "App", pid: 7, windowTitle: "Open", windowId: 0, windowRef: "@r1", nativeWindowRef: "ax:dlg" };
const terminalDesktopActionResult = (...args) => testing.runInOperation(() => rawTerminal(...args));
const originalListRoots = currentPlatformBackend.listRoots;
process.on("exit", () => { currentPlatformBackend.listRoots = originalListRoots; });
const rootsAfter = (roots) => {
	currentPlatformBackend.listRoots = async () => roots;
};
const codeError = (message, code) => Object.assign(new Error(message), { code });
const text = (result) => result.content[0].text;

// Dialog dismissed, main window remains and a new root appeared -> replaced, successor named.
rootsAfter([{ pid: 7, rootRef: "ax:main", windowRef: "ax:main", windowId: 5, kind: "window", title: "Main", framePoints: { x: 0, y: 0, w: 9, h: 9 }, scaleFactor: 1 }, { pid: 7, rootRef: "ax:new", windowRef: "ax:new", kind: "dialog", title: "Confirm", framePoints: { x: 1, y: 1, w: 9, h: 9 }, scaleFactor: 1 }]);
let result = await terminalDesktopActionResult(target, "s1", {
	strategy: "act",
	rootDelta: [
		{ change: "closed", kind: "dialog", ref: "ax:dlg", pid: 7 },
		{ change: "appeared", kind: "dialog", ref: "ax:new", title: "Confirm", pid: 7, isModal: true },
	],
}, new Error("Root is not available through Accessibility"));
assert.equal(result.details.status, "target_closed");
assert.equal(result.details.cause, "replaced");
assert.match(result.details.successors[0].ref, /^@r\d+$/, "successor ref must be an extension @r ref, not a helper-native ref");
assert.doesNotMatch(JSON.stringify(result.details), /ax:new/, "native ref leaked");
assert.match(text(result), /delivered/);
assert.match(text(result), /replaced by dialog "Confirm" \(modal\)/);

// A menu, a gone root and another pid's root are not replacements.
rootsAfter([{ pid: 7, rootRef: "ax:main", windowRef: "ax:main" }, { pid: 7, rootRef: "ax:menu", windowRef: "ax:menu" }, { pid: 9, rootRef: "ax:other", windowRef: "ax:other" }]);
result = await terminalDesktopActionResult(target, "s1", {
	strategy: "act",
	rootDelta: [
		{ change: "appeared", kind: "menu", ref: "ax:menu", pid: 7 },
		{ change: "appeared", kind: "dialog", ref: "ax:gone", pid: 7 },
		{ change: "appeared", kind: "dialog", ref: "ax:other", pid: 9 },
	],
}, new Error("x"));
assert.equal(result.details.cause, "closed", "menus, dead and foreign roots must not count as replacements");
assert.deepEqual(result.details.successors, []);

// Closed with no successor -> closed.
rootsAfter([{ pid: 7, rootRef: "ax:main", windowRef: "ax:main", windowId: 5 }]);
result = await terminalDesktopActionResult(target, "s1", { strategy: "act", rootDelta: [] }, new Error("x"));
assert.equal(result.details.cause, "closed");
assert.deepEqual(result.details.successors, []);

// Root still listed but observation says root unavailable -> root_stale, not success.
rootsAfter([{ pid: 7, rootRef: "ax:dlg", windowRef: "ax:dlg" }]);
result = await terminalDesktopActionResult(target, "s1", { strategy: "act" }, codeError("Root is not available through Accessibility", "root_not_found"));
assert.equal(result.details.status, "post_action_observation_failed");
assert.equal(result.details.error.code, "root_stale");
assert.match(result.details.error.message, /find_roots/);
assert.equal(result.details.cause, undefined);

// Same message text without the root_not_found code is NOT classified by regex.
rootsAfter([{ pid: 7, rootRef: "ax:dlg", windowRef: "ax:dlg" }]);
result = await terminalDesktopActionResult(target, "s1", { strategy: "act" }, new Error("Root is not available through Accessibility"));
assert.equal(result.details.error.code, "post_action_observation_failed");

// Failed identity probe proves nothing: even root_not_found stays generic.
currentPlatformBackend.listRoots = async () => { throw new Error("probe failed"); };
result = await terminalDesktopActionResult(target, "s1", { strategy: "act" }, codeError("Root is not owned by a running app", "root_not_found"));
assert.equal(result.details.error.code, "post_action_observation_failed");

// Unrelated observation failure keeps its own code.
rootsAfter([{ pid: 7, rootRef: "ax:dlg", windowRef: "ax:dlg" }]);
result = await terminalDesktopActionResult(target, "s1", { strategy: "act" }, new Error("boom"));
assert.equal(result.details.error.code, "post_action_observation_failed");

// A different pid's root with the same ref never counts as the target.
rootsAfter([{ pid: 99, rootRef: "ax:dlg", windowRef: "ax:dlg" }]);
result = await terminalDesktopActionResult(target, "s1", { strategy: "act" }, new Error("x"));
assert.equal(result.details.status, "target_closed");

console.log("act outcome checks passed");
