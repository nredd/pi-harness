// observe_ui, search_ui, expand_ui and inspect_ui through the public executors with a fake backend.
import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { desktopRoot, installFakeDesktop, wireButton, wireNode } from "./support/fake-desktop.mjs";
import { observeBrowser } from "./support/fake-browser.mjs";

vi.mock("../src/cdp.ts", async (importOriginal) => ({ ...(await importOriginal()), listCdpPageContexts: vi.fn(async () => []), cdpSnapshotForContext: vi.fn(async () => undefined) }));

const staticText = (ref, title, extra = {}) => wireNode(ref, "AXStaticText", title, extra);

test("observe_ui maps mode and readText onto the native look request", async ({ onTestFinished }) => {
	const fake = await installFakeDesktop(onTestFinished);
	const { executeObserve } = fake.bridge;

	const semantic = await fake.observe();
	assert.deepEqual(fake.looks[0], { target: { pid: 1, windowId: 100, rootRef: "ax:w1", windowRef: "ax:w1" }, baseLookId: undefined, readText: "never", scopeRef: undefined, maxDimension: 900, includeImage: false });
	assert.match(semantic.text, /^Observed semantic @r1 App1 — Main\. Returned the latest outline state\.\n\nnote @r1 "Main" \(pairing low, looked just now\)\n  go +seen\n\nControls \(1 of 2 nodes, stateId /);
	assert.equal(semantic.result.details.detail, "compact");

	await fake.call(executeObserve, { mode: "visual" });
	assert.deepEqual([fake.looks[1].readText, fake.looks[1].includeImage], ["always", true]);
	await fake.call(executeObserve, {});
	assert.deepEqual([fake.looks[2].readText, fake.looks[2].includeImage], ["auto", true], "fused is the default mode");
	await fake.call(executeObserve, { mode: "semantic", readText: "always" });
	assert.deepEqual([fake.looks[3].readText, fake.looks[3].includeImage], ["always", false], "explicit readText overrides the mode default");
	assert.deepEqual([fake.looks[1].maxDimension, fake.looks[2].maxDimension], [1_600, 900], "visual observations request the larger explicit image");

	const outline = await fake.call(executeObserve, { mode: "semantic", detail: "outline" });
	assert.match(fake.text(outline), /\n\nOutline \(2 nodes, stateId /);
	assert.equal(outline.details.detail, "outline");
});

test("observe_ui validates root selectors", async ({ onTestFinished }) => {
	const fake = await installFakeDesktop(onTestFinished);
	const { executeObserve } = fake.bridge;
	await assert.rejects(() => fake.call(executeObserve, { root: "Main" }), /must be an exact @r ref issued by find_roots/);
	await assert.rejects(() => fake.call(executeObserve, { root: "@r9" }), /Root ref '@r9' is not available in this session/);
	assert.equal(fake.looks.length, 0, "rejected selectors never reach the helper");
});

test("observe_ui follows root selection across roots and windows", async ({ onTestFinished }) => {
	const fake = await installFakeDesktop(onTestFinished, { roots: [desktopRoot({ pid: 1 }), desktopRoot({ pid: 2, windowId: 200 }), desktopRoot({ pid: 2, windowId: 201, rootRef: "ax:w2b", windowRef: "ax:w2b", title: "Second" })] });
	const { executeFind, executeObserve } = fake.bridge;
	const found = await fake.call(executeFind, {});
	const refOf = (app, title) => found.details.windows.find((w) => w.app === app && w.windowTitle === title).windowRef;

	await fake.observe({ root: refOf("App1", "Main") });
	fake.tree = [wireButton("other", "Elsewhere")];
	const other = await fake.observe({ root: refOf("App2", "Main") });
	assert.match(other.text, /Observed semantic @r\d+ App2 — Main\./);
	assert.match(other.text, /button "Elsewhere"/);
	// Same app, another window id.
	const second = await fake.observe({ root: refOf("App2", "Second") });
	assert.match(second.text, /App2 — Second\./);
	// A numeric window id is not a selector: only exact @r refs resolve (#709).
	await assert.rejects(() => fake.observe({ root: 100 }), /must be an exact @r ref issued by find_roots/);
	// Re-observing the current root keeps the same identity.
	const again = await fake.observe({ root: refOf("App1", "Main") });
	assert.match(again.text, /App1 — Main\./);
});

test("observe_ui keeps unpaired roots stable and rejects drifted selections", async ({ onTestFinished }) => {
	const unpaired = desktopRoot({ pid: 3, windowId: 0, rootRef: "ax:dlg", windowRef: "ax:dlg", title: "Dialog", kind: "dialog" });
	const fake = await installFakeDesktop(onTestFinished, { roots: [unpaired] });
	const { executeFind, executeObserve } = fake.bridge;
	fake.frontmostPid = 3;
	const first = await fake.observe();
	assert.match(first.text, /App3 — Dialog/);
	const second = await fake.observe();
	assert.match(second.text, /App3 — Dialog/, "native ref identity matches across looks");

	// A root with no window id and no native ref gets both on re-resolution; its title decides identity.
	const bare = { ...desktopRoot({ pid: 4, title: "Bare" }), windowId: undefined, rootRef: undefined, windowRef: undefined };
	fake.roots = [bare];
	let listings = 0;
	const resolved = { ...bare, windowId: 400, rootRef: "ax:bare", windowRef: "ax:bare" };
	fake.listRootsHook = () => (++listings <= 1 ? [bare] : [resolved]);
	const found = await fake.call(executeFind, { pid: 4 });
	listings = 0;
	fake.frontmostPid = 4;
	const bareRef = found.details.windows[0].windowRef;
	fake.tree = [wireButton("x", "X")];
	const ok = await fake.observe({ root: bareRef });
	assert.match(ok.text, /App4 — Bare/, "same title after refresh is the same root");

	listings = 0;
	const renamed = { ...resolved, title: "Renamed" };
	fake.listRootsHook = () => (++listings <= 1 ? [bare] : [renamed]);
	await assert.rejects(() => fake.call(executeObserve, { root: bareRef }), /Observation target drifted from the requested selection\. Requested App4 — Bare, captured App4 — Renamed\./);
});

test("search_ui ranks, bounds and describes outline matches", async ({ onTestFinished }) => {
	const fake = await installFakeDesktop(onTestFinished);
	const { executeSearchUi } = fake.bridge;
	fake.tree = [
		wireButton("save", "Save"),
		wireButton("saveas", "Save as"),
		wireNode("chk", "AXCheckBox", "Savings", { actions: ["AXPress"] }),
		...Array.from({ length: 14 }, (_, index) => wireButton(`n${index}`, `Item ${index}`)),
	];
	const { stateId } = await fake.observe();

	await assert.rejects(() => fake.call(executeSearchUi, { stateId }), /search_ui requires text, role, or capability/);
	await assert.rejects(() => fake.call(executeSearchUi, { stateId: "nope", text: "x" }), /State 'nope' is unavailable or was evicted/);

	const single = await fake.call(executeSearchUi, { stateId, text: "Save as" });
	assert.match(fake.text(single), /Found 1 outline match; returned 1\.\n@e3 button "Save as" \[exact\]$/);
	assert.equal(single.details.hasMore, false);
	assert.equal(single.details.returned, 1);

	const fuzzy = await fake.call(executeSearchUi, { stateId, text: "Svae" });
	assert.match(fake.text(fuzzy), /\[fuzzy \d\.\d\d\]/, "fuzzy matches print their score");

	const many = await fake.call(executeSearchUi, { stateId, role: "button" });
	assert.equal(many.details.returned, 12);
	assert.equal(many.details.totalMatches, 16);
	assert.equal(many.details.hasMore, true);
	assert.match(fake.text(many), /Found 16 outline matches; returned 12\. Refine the query to inspect 4 additional matches\./);
	assert.match(fake.text(many), /^note @r1 /, "the window note leads the result");
	assert.equal(fake.looks.length, 1, "matches with actionable controls never escalate to OCR");
});

test("search_ui prints paths only for matches that share a role and label", async ({ onTestFinished }) => {
	const fake = await installFakeDesktop(onTestFinished);
	fake.tree = [wireNode("left", "AXGroup", "Left", { children: [wireButton("s1", "Save")] }), wireNode("right", "AXGroup", "Right", { children: [wireButton("s2", "Save")] }), wireButton("s3", "Save as")];
	const { stateId } = await fake.observe();
	const result = await fake.call(fake.bridge.executeSearchUi, { stateId, text: "Save" });
	assert.deepEqual(fake.text(result).split("\n").slice(-5), [
		'@e5 button "Save" [exact]',
		'  path: AXWindow/AXStandardWindow "Main" ▸ AXGroup "Left" ▸ AXButton "Save"',
		'@e6 button "Save" [exact]',
		'  path: AXWindow/AXStandardWindow "Main" ▸ AXGroup "Right" ▸ AXButton "Save"',
		'@e4 button "Save as" [prefix]',
	]);
});

test("search_ui escalates to OCR once when only static text matches", async ({ onTestFinished }) => {
	const fake = await installFakeDesktop(onTestFinished);
	const { executeSearchUi } = fake.bridge;
	fake.tree = [staticText("hello", "Hello world")];
	fake.readText = { requested: "auto", executed: false };
	fake.lookPayload = (request) => {
		const ocr = request.readText === "always";
		return {
			lookId: ocr ? "ocr-look" : "plain-look",
			capturedAt: 1,
			window: { windowId: 100, rootRef: "ax:w1", kind: "window", framePoints: { x: 0, y: 0, w: 300, h: 200 }, scaleFactor: 1, isModal: false, role: "AXWindow", subrole: "AXStandardWindow", metadata: {} },
			outline: wireNode("w", "AXWindow", "Main", { children: ocr ? [staticText("hello", "Hello world"), wireButton("ocr", "Hello button")] : fake.tree }),
			readText: { requested: request.readText, executed: ocr },
			image: ocr ? { jpegBase64: "AA==", width: 4, height: 4 } : undefined,
			timings: {},
		};
	};
	const { stateId } = await fake.observe({ mode: "fused" });

	const escalated = await fake.call(executeSearchUi, { stateId, text: "Hello" });
	assert.equal(fake.looks.length, 2);
	assert.equal(fake.looks[1].readText, "always");
	assert.equal(fake.looks[1].includeImage, true, "OCR matches are clicked by coordinate, so the image is kept");
	assert.match(fake.text(escalated), /OCR text was escalated for this search after the cached outline had no matches\./);
	assert.deepEqual(escalated.details.matches.map((match) => match.label).sort(), ["Hello button", "Hello world"]);
	assert.equal(escalated.details.lookId, "ocr-look");

	// The escalated look already ran OCR, so a second search must not capture again.
	const again = await fake.call(executeSearchUi, { stateId: escalated.details.stateId, text: "Hello" });
	assert.equal(fake.looks.length, 2);
	assert.doesNotMatch(fake.text(again), /escalated/);
	assert.equal(again.details.matches.length, 2);
});

test("search_ui skips OCR escalation when the look already ran OCR or forbade it", async ({ onTestFinished }) => {
	const fake = await installFakeDesktop(onTestFinished);
	const { executeSearchUi } = fake.bridge;
	fake.tree = [staticText("t", "Plain")];
	for (const readText of [{ requested: "auto", executed: true }, { requested: "never", executed: false }]) {
		fake.readText = readText;
		const { stateId } = await fake.observe();
		const before = fake.looks.length;
		const none = await fake.call(executeSearchUi, { stateId, text: "Missing" });
		assert.match(fake.text(none), /Found 0 outline matches; returned 0\.\n?$/);
		assert.equal(fake.looks.length, before, `no OCR escalation for ${JSON.stringify(readText)}`);
	}
	// Static text that is not actionable still escalates, but the zero-match message names the cached outline.
	fake.readText = { requested: "auto", executed: false };
	const { stateId } = await fake.observe();
	const before = fake.looks.length;
	const escalated = await fake.call(executeSearchUi, { stateId, text: "Missing" });
	assert.equal(fake.looks.length, before + 1);
	assert.match(fake.text(escalated), /Found 0 outline matches; returned 0\. OCR text was escalated/);
});

test("expand_ui renders a bounded subtree and grafts truncated refs", async ({ onTestFinished }) => {
	const fake = await installFakeDesktop(onTestFinished);
	const { executeExpandUi, executeInspectUi } = fake.bridge;
	fake.tree = [wireNode("grp", "AXGroup", "Group", { truncated: true, children: [] }), wireNode("full", "AXGroup", "Full", { children: [wireNode("l1", "AXGroup", "L1", { children: [wireNode("l2", "AXGroup", "L2", { children: [wireNode("l3", "AXGroup", "L3", { children: [wireNode("l4", "AXGroup", "L4", { children: [wireNode("l5", "AXGroup", "L5", { children: [wireNode("l6", "AXGroup", "L6", { children: [wireNode("l7", "AXGroup", "L7", { children: [wireNode("l8", "AXGroup", "L8", { children: [wireButton("leaf", "Leaf")] })] })] })] })] })] })] })] })] })];
	const { stateId } = await fake.observe();

	await assert.rejects(() => fake.call(executeExpandUi, { stateId }), /expand_ui\.ref is required/);
	await assert.rejects(() => fake.call(executeExpandUi, { stateId: "stale", ref: "@e2" }), /State 'stale' is unavailable or was evicted/);
	await assert.rejects(() => fake.call(executeExpandUi, { stateId, ref: "@e99" }), /Outline ref '@e99' is not available in the current outline/);

	const shallow = await fake.call(executeExpandUi, { stateId, ref: "@e3", depth: 1 });
	assert.equal(fake.looks.length, 1, "a complete subtree needs no new look");
	assert.match(fake.text(shallow), /^@e3 AXGroup "Full"\npath: AXWindow\/AXStandardWindow "Main" ▸ AXGroup "Full"\n\n/);
	assert.doesNotMatch(fake.text(shallow), /L3/);
	const clamped = await fake.call(executeExpandUi, { stateId, ref: "@e3", depth: 99 });
	assert.match(fake.text(clamped), /L7/, "a deep request still renders");
	assert.doesNotMatch(fake.text(clamped), /L8/, "depth is clamped to 8, not unbounded");
	const floored = await fake.call(executeExpandUi, { stateId, ref: "@e3", depth: -4 });
	assert.equal(fake.text(floored), fake.text(shallow), "depth floors at 1");
	const defaulted = await fake.call(executeExpandUi, { stateId, ref: "@e3" });
	assert.match(fake.text(defaulted), /L2/);
	assert.doesNotMatch(fake.text(defaulted), /L4/, "depth defaults to 3");

	// Truncated refs trigger a scoped look that is grafted into the cached outline.
	fake.lookPayload = (request) => ({
		lookId: "scoped-look",
		capturedAt: 1,
		window: { windowId: 100, rootRef: "ax:w1", kind: "window", framePoints: { x: 0, y: 0, w: 300, h: 200 }, scaleFactor: 1, isModal: false, role: "AXWindow", subrole: "AXStandardWindow", metadata: {} },
		outline: wireNode("grp", "AXGroup", "Group", { children: [wireButton("inner", "Inner")] }),
		readText: { requested: request.readText, executed: false },
		timings: {},
	});
	const expanded = await fake.call(executeExpandUi, { stateId, ref: "@e2" });
	const scoped = fake.looks.at(-1);
	assert.deepEqual([scoped.scopeRef, scoped.baseLookId, scoped.includeImage, scoped.maxDimension, scoped.readText], ["grp", "look1", false, 1, "auto"]);
	assert.match(fake.text(expanded), /AXButton "Inner"/);
	assert.equal(expanded.details.lookId, "scoped-look");
	assert.equal(expanded.details.target.truncated, false);
	const inspected = await fake.call(executeInspectUi, { stateId, ref: "@e2" });
	assert.match(fake.text(inspected), /annotations: none/, "the graft persisted into the saved state");
});

test("expand_ui rescopes a region the last action touched", async ({ onTestFinished }) => {
	const fake = await installFakeDesktop(onTestFinished);
	const { executeAct, executeExpandUi } = fake.bridge;
	const { currentPlatformBackend } = await import("../src/platform/index.ts");
	currentPlatformBackend.act = async () => ({ outcome: "worked", performed: { delivery: "pid" } });
	fake.tree = [wireNode("grp", "AXGroup", "Panel", { children: [wireButton("go", "Go")] })];
	const { stateId } = await fake.observe();
	const acted = await fake.call(executeAct, { stateId, actions: [{ action: "press", ref: "@e3" }] });
	const afterAct = acted.details.capture.stateId;
	assert.match(fake.text(acted), /panel +changed +\(acted here\)/);
	const before = fake.looks.length;
	await fake.call(executeExpandUi, { stateId: afterAct, ref: "@e2" });
	assert.equal(fake.looks.length, before + 1, "a changed region forces a fresh scoped look even without truncation");
	assert.equal(fake.looks.at(-1).scopeRef, "grp");
});

test("inspect_ui reports geometry, actions, capabilities and annotations", async ({ onTestFinished }) => {
	const fake = await installFakeDesktop(onTestFinished);
	const { executeInspectUi } = fake.bridge;
	fake.tree = [
		wireNode("rich", "AXTextField", "Rich", {
			actions: ["AXPress", "AXShowMenu"],
			canPress: true,
			canFocus: true,
			canSetValue: true,
			canScroll: true,
			canIncrement: true,
			canDecrement: true,
			isTextInput: true,
			offscreen: true,
			pictureOnly: true,
			truncated: true,
			scrollExtent: { seen: 3, total: 9 },
		}),
		staticText("plain", "Plain"),
	];
	const { stateId } = await fake.observe();

	await assert.rejects(() => fake.call(executeInspectUi, { stateId }), /inspect_ui\.ref is required/);
	await assert.rejects(() => fake.call(executeInspectUi, { stateId, ref: "@e42" }), /Outline ref '@e42' is not available in the current outline/);
	await assert.rejects(() => fake.call(executeInspectUi, { ref: "@e2", stateId: "stale" }), /State 'stale' is unavailable/);

	const rich = await fake.call(executeInspectUi, { stateId, ref: "@e2" });
	const lines = fake.text(rich).split("\n");
	assert.deepEqual(lines.slice(1), [
		'path: AXWindow/AXStandardWindow "Main" ▸ AXTextField "Rich"',
		'rect: {"x":10,"y":10,"w":50,"h":20}',
		"actions: AXPress,AXShowMenu",
		"capabilities: press,focus,setValue,scroll,increment,decrement,textInput",
		"annotations: offscreen,pictureOnly,truncated,scrollable 3/9",
	]);
	assert.equal(rich.details.tool, "inspect_ui");
	assert.equal(rich.details.target.ref, "@e2");

	const plain = fake.text(await fake.call(executeInspectUi, { stateId, ref: "@e3" })).split("\n");
	assert.deepEqual(plain.slice(-3), ["actions: none", "capabilities: none", "annotations: none"]);
});

test("observe_ui reads browser pages through CDP and reports vanished contexts", async ({ onTestFinished }) => {
	const fake = await installFakeDesktop(onTestFinished);
	const { executeObserve } = fake.bridge;
	const { cdp, root, observed } = await observeBrowser(fake, [wireButton("go", "Go")]);
	assert.equal(fake.looks.length, 0, "browser roots never reach the native helper");
	assert.equal(observed.details.kind, "browser_page");
	assert.match(fake.text(observed), /^observe_ui completed for @r\d+ "Page"\. State base\.\nControls \(1 of 2 nodes, stateId base/);
	const outline = await fake.call(executeObserve, { root, detail: "outline" });
	assert.match(outline.details.renderedOutline, /AXButton "Go"/);
	assert.equal(outline.details.detail, "outline");

	cdp.cdpSnapshotForContext.mockResolvedValue(undefined);
	await assert.rejects(() => fake.call(executeObserve, { root }), /Browser context 'browser:page1' is no longer available\. Call find_roots again\./);
});

test("search_ui, expand_ui and inspect_ui query a saved browser observation", async ({ onTestFinished }) => {
	const fake = await installFakeDesktop(onTestFinished);
	const { executeSearchUi, executeExpandUi, executeInspectUi } = fake.bridge;
	const { stateId } = await observeBrowser(fake, [wireNode("form", "AXGroup", "Form", { children: [wireButton("go", "Go")] })]);

	const found = await fake.call(executeSearchUi, { stateId, text: "Go" });
	assert.equal(fake.text(found), 'Found 1 outline match; returned 1.\n@e3 button "Go" [exact]', "a browser page has no window note");
	assert.equal(found.details.stateId, stateId);
	const expanded = await fake.call(executeExpandUi, { stateId, ref: "@e2" });
	assert.match(fake.text(expanded), /^@e2 AXGroup "Form"\npath: AXWebArea "Page" ▸ AXGroup "Form"\n\n/);
	assert.match(fake.text(await fake.call(executeInspectUi, { stateId, ref: "@e3" })), /actions: AXPress\ncapabilities: none/);
	assert.equal(fake.looks.length, 0);
});

test("search_ui and expand_ui on a browser state never escalate to the desktop", async ({ onTestFinished }) => {
	const fake = await installFakeDesktop(onTestFinished);
	const { executeSearchUi, executeExpandUi } = fake.bridge;
	const { stateId } = await observeBrowser(fake, [wireButton("go", "Go"), wireNode("lbl", "AXStaticText", "Label"), wireNode("grp", "AXGroup", "Truncated", { truncated: true, children: [] })]);

	const missing = await fake.call(executeSearchUi, { stateId, text: "Missing" });
	assert.equal(missing.details.totalMatches, 0);
	assert.equal(missing.details.matches.length, 0);
	assert.equal(fake.text(missing), "Found 0 outline matches; returned 0.\n");
	const staticOnly = await fake.call(executeSearchUi, { stateId, text: "Label" });
	assert.equal(staticOnly.details.totalMatches, 1, "static-text-only matches stay as found");
	assert.doesNotMatch(fake.text(staticOnly), /OCR/);

	const expanded = await fake.call(executeExpandUi, { stateId, ref: "@e4" });
	assert.match(fake.text(expanded), /^@e4 AXGroup "Truncated"\npath: AXWebArea "Page" /);
	assert.match(fake.text(expanded), /\[truncated\]/, "the cached subtree still shows the node as truncated");
	assert.equal(fake.looks.length, 0, "no OCR or scoped look reaches the native helper");
});

test("wait_for with a blank stateId returns the coded error instead of a TypeError", async ({ onTestFinished }) => {
	const fake = await installFakeDesktop(onTestFinished);
	for (const stateId of ["", "   "]) {
		await assert.rejects(() => fake.call(fake.bridge.executeWaitFor, { stateId, text: "Go" }), (error) => {
			assert.ok(!(error instanceof TypeError), "no raw TypeError");
			assert.match(error.message, /No observation state is available\. Call observe_ui first\./);
			return true;
		});
	}
	assert.equal(fake.waits.length, 0);
});

test("wait_for, search_ui and expand_ui work on a state evicted and reconstructed from the session branch", async ({ onTestFinished }) => {
	const fake = await installFakeDesktop(onTestFinished);
	const { executeWaitFor, executeSearchUi, executeExpandUi, reconstructStateFromBranch } = fake.bridge;
	fake.tree = [wireNode("grp", "AXGroup", "Panel", { children: [wireButton("go", "Go")] })];
	const { result, stateId } = await fake.observe();
	const branch = { ...fake.ctx, sessionManager: { getBranch: () => [{ type: "message", message: { role: "toolResult", toolName: "observe_ui", details: JSON.parse(JSON.stringify(result.details)) } }] } };

	reconstructStateFromBranch(fake.ctx);
	await assert.rejects(() => fake.call(executeSearchUi, { stateId, text: "Go" }), /State '.+' is unavailable or was evicted/);
	reconstructStateFromBranch(branch);

	const found = await fake.call(executeSearchUi, { stateId, text: "Go" });
	assert.equal(found.details.totalMatches, 1);
	const expanded = await fake.call(executeExpandUi, { stateId, ref: "@e2" });
	assert.match(fake.text(expanded), /AXButton "Go"/);
	const waited = await fake.call(executeWaitFor, { stateId, text: "Go", timeoutMs: 100 });
	assert.equal(waited.details.found, true);
	assert.equal(waited.details.baseStateId, stateId);
});

test("root identity never crosses apps and prefers window id, then native ref, then title", async () => {
	const { testing } = await import("../src/bridge.ts");
	const root = (fields) => ({ appName: "App", pid: 1, windowTitle: "Untitled", windowId: 0, ...fields });
	const same = testing.sameRootIdentity;
	assert.equal(same(root({ pid: 1 }), root({ pid: 2 })), false, "two apps with identically titled, unpaired roots are different roots");
	assert.equal(same(root({ pid: 1, windowId: 5 }), root({ pid: 2, windowId: 5 })), false, "a window id is only unique within its app");
	assert.equal(same(root({ windowId: 5, nativeWindowRef: "a" }), root({ windowId: 5, nativeWindowRef: "b", windowTitle: "Other" })), true, "equal window ids decide first");
	assert.equal(same(root({ windowId: 5, nativeWindowRef: "a" }), root({ windowId: 6, nativeWindowRef: "a" })), false, "different window ids decide first");
	assert.equal(same(root({ nativeWindowRef: "a" }), root({ nativeWindowRef: "a", windowTitle: "Other" })), true, "without window ids the native ref decides");
	assert.equal(same(root({ nativeWindowRef: "a" }), root({ nativeWindowRef: "b" })), false);
	assert.equal(same(root({ windowTitle: "Doc " }), root({ windowTitle: "doc" })), true, "otherwise the normalized title decides");
	assert.equal(same(root({ windowTitle: "Doc" }), root({ windowTitle: "Other" })), false);
	assert.equal(same(root({ windowId: 5 }), root({ nativeWindowRef: "a" })), true, "a lone native ref falls back to the title");
	assert.equal(same(root({ windowId: 5 }), root({ nativeWindowRef: "a", windowTitle: "Other" })), false);
});
