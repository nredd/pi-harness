#!/usr/bin/env node
// Post-action classification: replaced vs closed vs stale root, never silent success.
import assert from "node:assert/strict";

const { currentPlatformBackend } = await import("../src/platform/index.ts");
const { terminalDesktopActionResult: rawTerminal, testing } = await import("../src/bridge.ts");
const { foldToBudget, serializeOutline } = await import("../src/outline.ts");
const { changesBetween } = await import("../src/view.ts");

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

const uiNode = (ref, title, role = "AXButton", fields = {}) => ({ ref, role, subrole: "", identifier: "", title, description: "", value: "", actions: ["AXPress"], canPress: true, canFocus: false, canSetValue: false, canScroll: false, canIncrement: false, canDecrement: false, isTextInput: false, focused: false, offscreen: false, pictureOnly: false, truncated: false, text: [], children: [], ...fields });
const outlineOf = (rootNode) => {
	const nodes = [];
	const visit = (current, parent) => {
		current.parent = parent;
		nodes.push(current);
		for (const child of current.children) visit(child, current);
	};
	visit(rootNode, undefined);
	return { lookId: "look", root: rootNode, nodes, refToWireRef: new Map(), wireRefToRef: new Map() };
};
const passiveNode = (ref, title, role, children = []) => uiNode(ref, title, role, { actions: [], canPress: false, children });
const buttons = outlineOf(passiveNode("@e1", "Doc", "AXWindow", [uiNode("@e2", "Save"), passiveNode("@e3", "Body", "AXStaticText")]));
const canvas = outlineOf(passiveNode("@e1", "Canvas", "AXWindow", [passiveNode("@e2", "Body", "AXStaticText")]));
const capture = (outline, stateId) => ({ target: { appName: "App", pid: 7, windowTitle: "Doc", windowId: 5 }, capture: { stateId, width: 0, height: 0, scaleFactor: 1, timestamp: 0 }, look: { lookId: "look" }, outline, activation: {} });
const buildToolResult = (...args) => testing.runInOperation(() => testing.buildToolResult(...args));

result = await buildToolResult("observe_ui", "Observed.", capture(buttons, "S1"), {}, undefined, "never");
assert.equal(text(result), 'Observed.\n\nControls (1 of 3 nodes, stateId S1, root @e1):\n@e2 button "Save"\n… 2 other nodes hidden. Use search_ui to find more; expand_ui({ stateId: "S1", ref: "@e1", depth: 2 }) or observe_ui detail "outline" for structure.');
assert.equal(result.details.detail, "compact");
assert.equal(result.details.renderedOutline, foldToBudget(buttons).text, "details.renderedOutline keeps the folded text");

result = await buildToolResult("observe_ui", "Observed.", capture(buttons, "S1"), {}, undefined, "never", undefined, "outline");
assert.equal(text(result), `Observed.\n\nOutline (3 nodes, stateId S1):\n${foldToBudget(buttons).text}`, "detail outline must reproduce the previous observe_ui text");
assert.equal(result.details.detail, "outline");

result = await buildToolResult("observe_ui", "Observed.", capture(canvas, "S2"), {}, undefined, "never");
assert.equal(text(result), `Observed.\n\nOutline (2 nodes, stateId S2, no actionable controls found):\n${foldToBudget(canvas).text}`, "zero controls must fall back to the fold and say so");
assert.equal(result.details.detail, "outline");

const replaced = outlineOf(passiveNode("@e1", "Sheet", "AXSheet", [uiNode("@e4", "OK")]));
result = await buildToolResult("act_ui", "Acted.", capture(replaced, "S3"), {}, undefined, "never", { stateId: "S1", outline: buttons });
assert.match(text(result), /^Acted\.\n\nControls \(1 of 2 nodes, stateId S3, root @e1, full view: root_replaced\):\n@e4 button "OK"\n/, "act_ui full views must be compact");

assert.match(testing.waitForViewText(replaced, "S4", changesBetween(buttons, replaced)), /^Controls \(1 of 2 nodes, stateId S4, root @e1\):\n@e4 button "OK"\n/, "wait_for full views must be compact");
assert.equal(testing.waitForViewText(buttons, "S5", changesBetween(buttons, buttons)), "(no element changes)\nUse stateId S5 for subsequent actions and queries.", "wait_for diff views are unchanged");

const snapshot = { contextId: "ctx", snapshotId: "B1", targetId: "t", title: "Page", url: "about:blank", capturedAt: 0, text: "", targets: [], outline: serializeOutline(buttons) };
const browserResult = (detail) => testing.runInOperation(() => testing.browserObservationResult(snapshot, "browser:ctx", 0, "observe_ui", undefined, detail));
result = browserResult("outline");
assert.equal(text(result), `observe_ui completed for ${result.details.root.ref} "Page". State B1.\n${foldToBudget(buttons).text}`, "browser detail outline must keep the previous header-less fold");
result = browserResult(undefined);
assert.match(text(result), /State B1\.\nControls \(1 of 3 nodes, stateId B1, root @e1\):\n@e2 button "Save"\n/, "browser observations default to compact");

const twins = outlineOf(passiveNode("@e1", "Doc", "AXWindow", [passiveNode("@e2", "Left", "AXGroup", [uiNode("@e3", "Save")]), passiveNode("@e4", "Right", "AXGroup", [uiNode("@e5", "Save")]), uiNode("@e6", "Save as")]));
const search = async (params, outline) => text(await testing.runInOperation(() => testing.performSearchUi(params), { currentOutline: outline, currentCapture: { stateId: "S6" } }));
const twinLines = (await search({ text: "Save" }, twins)).split("\n").slice(1);
assert.deepEqual(twinLines, ['@e3 button "Save" [exact]', '  path: AXWindow "Doc" ▸ AXGroup "Left" ▸ AXButton "Save"', '@e5 button "Save" [exact]', '  path: AXWindow "Doc" ▸ AXGroup "Right" ▸ AXButton "Save"', '@e6 button "Save as" [prefix]'], "search_ui prints paths only for colliding matches");

console.log("act outcome checks passed");
