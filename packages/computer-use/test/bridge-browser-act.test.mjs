// `act_ui`, `navigate_browser` and `evaluate_browser` on CDP browser states through the real `cdp.ts` over the scriptable fake CDP (nredd/pi-harness#712, Refs #645).
import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { cdpError, startFakeCdp } from "./fixtures/fake-cdp.mjs";
import { installFakeDesktop } from "./support/fake-desktop.mjs";

/**
 * Build one `Accessibility.getFullAXTree` node.
 * @param {string} nodeId Node id.
 * @param {string} role AX role.
 * @param {string} name Accessible name.
 * @param {object} [extra] Extra node fields (`parentId`, `childIds`, `backendDOMNodeId`, ...).
 * @returns {object} AX node.
 * @throws {never} Pure constructor.
 */
const ax = (nodeId, role, name, extra = {}) => ({ nodeId, role: { type: "role", value: role }, name: { type: "computedString", value: name }, ...extra });

/** Page with a link, a button, a textbox and a node without a backend id, all under one web area. */
const PAGE = [
	ax("1", "RootWebArea", "Form", { childIds: ["2", "3", "4", "5"], backendDOMNodeId: 1 }),
	ax("2", "button", "Save", { parentId: "1", backendDOMNodeId: 11 }),
	ax("3", "textbox", "Email", { parentId: "1", backendDOMNodeId: 12 }),
	ax("4", "link", "Docs", { parentId: "1", backendDOMNodeId: 13 }),
	ax("5", "paragraph", "Intro", { parentId: "1" }),
];

let fakes = [];

afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all(fakes.map((fake) => fake.close()));
	fakes = [];
});

/**
 * Observe the fake page and index its refs.
 * @param {(fn: () => void | Promise<void>) => void} onTestFinished Vitest cleanup registrar.
 * @param {{ nodes?: object[], text?: string }} [options] AX tree and `document.body.innerText`.
 * @returns {Promise<object>} `{ desktop, cdp, stateId, refs, act, paramsOf }`.
 * @throws {assert.AssertionError} If the page is not offered as a root.
 */
async function observePage(onTestFinished, { nodes = PAGE, text = "Hello page" } = {}) {
	const desktop = await installFakeDesktop(onTestFinished, { roots: [] });
	const cdp = await startFakeCdp({ id: "page1", title: "Form", url: "https://example.test/form" });
	fakes.push(cdp);
	vi.stubEnv("PI_COMPUTER_USE_CDP_PORT", String(cdp.port));
	const page = { text, nodes };
	cdp.handle("Runtime.evaluate", (params) => (params.expression.startsWith("document.body") ? { result: { value: page.text } } : { result: { value: 42 } }));
	cdp.handle("Accessibility.getFullAXTree", () => ({ nodes: page.nodes }));
	cdp.handle("DOM.resolveNode", (params) => ({ object: { objectId: `object-${params.backendNodeId}` } }));
	const found = await desktop.call(desktop.bridge.executeFind, { app: "Browser" });
	const root = found.details.windows.find((window) => window.kind === "browser_page").windowRef;
	const observed = await desktop.call(desktop.bridge.executeObserve, { root });
	const stateId = observed.details.stateId;
	/** Refs by accessible name for `id`. */
	const refsOf = (id) => Object.fromEntries(desktop.bridge.testing.savedState(id).value.snapshot.targets.map((target) => [target.name, target.ref]));
	return {
		desktop,
		cdp,
		page,
		stateId,
		refs: refsOf(stateId),
		refsOf,
		act: (params, signal) => desktop.call(desktop.bridge.executeAct, params, signal),
		paramsOf: (method) => cdp.commands.filter((command) => command.method === method).map((command) => command.params),
		methods: () => cdp.commands.map((command) => command.method),
	};
}

test("act_ui press clicks the backend node once per clickCount and returns a successor diff", async ({ onTestFinished }) => {
	const { act, stateId, refs, paramsOf, page } = await observePage(onTestFinished);
	page.nodes = [...PAGE.slice(0, 3), ax("3", "textbox", "Email", { parentId: "1", backendDOMNodeId: 12, value: { type: "string", value: "new" } }), ...PAGE.slice(4)];
	const result = await act({ stateId, actions: [{ action: "press", ref: refs.Save }, { action: "click", ref: refs.Docs, clickCount: 2 }] });
	assert.deepEqual(paramsOf("DOM.resolveNode").map((params) => params.backendNodeId), [11, 13, 13]);
	assert.equal(paramsOf("Runtime.callFunctionOn").length, 3);
	assert.equal(result.details.tool, "act_ui");
	assert.equal(result.details.baseStateId, stateId);
	assert.notEqual(result.details.stateId, stateId);
	assert.match(result.content[0].text, /^act_ui completed for @r\d+ "Form"\. State /);
});

test("a browser transaction advances the epoch: the base state is stale afterwards", async ({ onTestFinished }) => {
	const { act, stateId, refs, desktop } = await observePage(onTestFinished);
	const first = await act({ stateId, actions: [{ action: "press", ref: refs.Save }] });
	await assert.rejects(() => act({ stateId, actions: [{ action: "press", ref: refs.Save }] }), /State is stale for cdp:page1: expected epoch 0, current epoch 1\./);
	// The successor is the live state and chains again.
	const next = await act({ stateId: first.details.stateId, actions: [{ action: "press", ref: refs.Save }] });
	assert.equal(next.details.baseStateId, first.details.stateId);
	assert.equal(desktop.bridge.testing.savedState(next.details.stateId).epoch, 2);
});

test("browser states refuse paste, selectText and secondaryAction before the epoch advances", async ({ onTestFinished }) => {
	const { act, stateId, refs, methods } = await observePage(onTestFinished);
	const baseline = methods().length;
	for (const action of [{ action: "paste", text: "x" }, { action: "selectText", ref: refs.Email, start: 0, length: 1 }, { action: "secondaryAction", ref: refs.Save, name: "AXShowMenu" }]) {
		await assert.rejects(() => act({ stateId, actions: [action] }), (error) => error.code === "unsupported_command" && error.message === `Browser transactions do not support '${action.action}'.`);
	}
	await assert.rejects(() => act({ stateId, actions: [{ action: "press", ref: refs.Save }, { action: "wait", ms: 1 }] }), (error) => error.code === "unsupported_command");
	assert.equal(methods().length, baseline, "nothing reached the page");
	// The base state is still current: the epoch did not advance.
	assert.match((await act({ stateId, actions: [{ action: "press", ref: refs.Save }] })).details.stateId, /./);
});

test("act_ui coordinate input reaches the page through CDP input events", async ({ onTestFinished }) => {
	const { act, stateId, refs, paramsOf } = await observePage(onTestFinished);
	await act({
		stateId,
		actions: [
			{ action: "click", x: 5, y: 6 },
			{ action: "click", x: 7, y: 8, button: "right", clickCount: 2 },
			{ action: "moveMouse", x: 9, y: 10 },
			{ action: "typeText", text: "focused" },
			{ action: "typeText", ref: refs.Email, text: "typed" },
			{ action: "setText", ref: refs.Email, text: "set" },
			{ action: "keypress", keys: ["cmd", "a"] },
			{ action: "scroll", scrollX: 3, scrollY: -4 },
			{ action: "scroll", ref: refs.Docs, scrollY: 9 },
			{ action: "drag", path: [[1, 2], { x: 3, y: 4 }, [5, "bad"], { x: 7 }] },
		],
	});
	const mouse = paramsOf("Input.dispatchMouseEvent");
	assert.deepEqual(mouse.slice(0, 5).map(({ type, x, y, button, clickCount }) => ({ type, x, y, button, clickCount })), [
		{ type: "mousePressed", x: 5, y: 6, button: "left", clickCount: 1 },
		{ type: "mouseReleased", x: 5, y: 6, button: "left", clickCount: 1 },
		{ type: "mousePressed", x: 7, y: 8, button: "right", clickCount: 2 },
		{ type: "mouseReleased", x: 7, y: 8, button: "right", clickCount: 2 },
		{ type: "mouseMoved", x: 9, y: 10, button: "none", clickCount: 1 },
	]);
	assert.deepEqual(paramsOf("Input.insertText"), [{ text: "focused" }]);
	const calls = paramsOf("Runtime.callFunctionOn");
	assert.deepEqual(calls.slice(0, 2).map((call) => call.arguments), [[{ value: "typed" }, { value: false }], [{ value: "set" }, { value: true }]], "typeText appends and setText replaces");
	assert.deepEqual(paramsOf("Input.dispatchKeyEvent").map((event) => [event.type, event.key, event.modifiers]), [["keyDown", "a", 4], ["keyUp", "a", 4]]);
	assert.deepEqual(paramsOf("Runtime.evaluate").filter((params) => params.expression.startsWith("window.scrollBy")).map((params) => params.expression), ["window.scrollBy(3, -4)"]);
	assert.deepEqual(calls[2].arguments, [{ value: 0 }, { value: 9 }], "a node scroll sends both deltas");
	// `normalizeActionPath`: tuples and objects, non-finite coordinates fall back to 0.
	assert.deepEqual(mouse.slice(5).map(({ type, x, y }) => [type, x, y]), [["mousePressed", 1, 2], ["mouseMoved", 3, 4], ["mouseMoved", 5, 0], ["mouseMoved", 7, 0], ["mouseReleased", 7, 0]]);
});

test("browser text actions default their missing text", async ({ onTestFinished }) => {
	const { act, stateId, refs, paramsOf } = await observePage(onTestFinished);
	await act({ stateId, actions: [{ action: "setText", ref: refs.Email }, { action: "typeText", ref: refs.Email }, { action: "typeText" }] });
	assert.deepEqual(paramsOf("Runtime.callFunctionOn").map((call) => call.arguments), [[{ value: "" }, { value: true }], [{ value: "" }, { value: false }]]);
	assert.deepEqual(paramsOf("Input.insertText"), [{ text: "" }]);
});

test("an empty browser keypress is rejected before the write epoch advances", async ({ onTestFinished }) => {
	const { act, stateId, refs, methods } = await observePage(onTestFinished);
	const baseline = methods().length;
	for (const action of [{ action: "keypress" }, { action: "keypress", keys: [] }, { action: "keypress", keys: "a" }]) {
		await assert.rejects(() => act({ stateId, actions: [{ action: "press", ref: refs.Save }, action] }), (error) => error.code === "invalid_args" && error.message === "keypress.keys must contain at least one key.");
	}
	assert.equal(methods().length, baseline, "the valid first step was not delivered either");
	const ok = await act({ stateId, actions: [{ action: "press", ref: refs.Save }] });
	assert.equal(ok.details.baseStateId, stateId, "the base state is still current");
});

test("browser moveMouse refs reject with invalid_args before any delivery or epoch change", async ({ onTestFinished }) => {
	const { act, stateId, refs, methods, paramsOf } = await observePage(onTestFinished);
	const baseline = methods().length;
	for (const ref of [refs.Save, ` ${refs.Save} `, "@e99"]) {
		await assert.rejects(() => act({ stateId, actions: [{ action: "press", ref: refs.Save }, { action: "moveMouse", ref }] }), (error) => error.code === "invalid_args" && error.message === "Browser moveMouse requires x/y coordinates; ref targets are not supported.");
	}
	assert.equal(methods().length, baseline, "preflight did not deliver even the valid prefix");
	const result = await act({ stateId, actions: [{ action: "moveMouse", x: 0, y: 0 }] });
	assert.equal(result.details.baseStateId, stateId, "rejection did not consume the base epoch");
	assert.deepEqual(paramsOf("Input.dispatchMouseEvent"), [{ type: "mouseMoved", x: 0, y: 0, button: "none", clickCount: 1 }]);
});

test("a padded stateId resolves the same state and its refs", async ({ onTestFinished }) => {
	const { act, stateId, refs, paramsOf } = await observePage(onTestFinished);
	await act({ stateId: `  ${stateId} `, actions: [{ action: "press", ref: ` ${refs.Save} ` }] });
	assert.deepEqual(paramsOf("DOM.resolveNode").map((params) => params.backendNodeId), [11]);
});

test("a drag without a path reports the failure and leaves the page without input", async ({ onTestFinished }) => {
	const { act, stateId, paramsOf } = await observePage(onTestFinished);
	await assert.rejects(() => act({ stateId, actions: [{ action: "drag" }] }), /drag\.path|at least two points/);
	assert.deepEqual(paramsOf("Input.dispatchMouseEvent"), []);
});

test("browser actions reject bad targets before any input", async ({ onTestFinished }) => {
	const { act, stateId, refs, refsOf, methods } = await observePage(onTestFinished);
	const baseline = methods().length;
	/** Assert that one action is rejected with `pattern`. */
	const rejects = (action, pattern) => assert.rejects(() => act({ stateId, actions: [action] }), pattern);
	await rejects({ action: "click", ref: refs.Save, button: "right" }, /Browser ref clicks support only the left button/);
	await rejects({ action: "press", ref: "@e99" }, new RegExp(`Browser press requires an actionable @e ref owned by ${stateId}`));
	await rejects({ action: "setText", ref: "@e99", text: "x" }, /Browser setText requires an actionable @e ref/);
	await rejects({ action: "typeText", ref: "@e99", text: "x" }, /Browser typeText requires an actionable @e ref/);
	await rejects({ action: "click", ref: "@e99" }, /Browser click requires an actionable @e ref/);
	await rejects({ action: "scroll", ref: "@e99", scrollY: 1 }, new RegExp(`Browser scroll ref must be owned by ${stateId}\\.`));
	assert.deepEqual(Object.keys(refsOf(stateId)).sort(), ["Docs", "Email", "Save"], "the paragraph is not an actionable target");
	assert.equal(refsOf(stateId).Intro, undefined);
	assert.equal(methods().length, baseline, "validation fails before the write lock and CDP");
});

test("act_ui validates targets and the transaction size before dispatch", async ({ onTestFinished }) => {
	const { act, stateId, refs } = await observePage(onTestFinished);
	/** Assert that the transaction `params` are rejected with `pattern`. */
	const rejects = (params, pattern) => assert.rejects(() => act({ stateId, ...params }), pattern);
	await rejects({ actions: [] }, /act_ui\.actions must contain at least one action\./);
	await rejects({}, /act_ui\.actions must contain at least one action\./);
	await rejects({ actions: Array.from({ length: 21 }, () => ({ action: "moveMouse", x: 1, y: 1 })) }, /at most 20 actions/);
	await rejects({ actions: [{ action: "click", x: 1 }] }, /click coordinates require both x and y\./);
	await rejects({ actions: [{ action: "moveMouse", y: 1 }] }, /moveMouse coordinates require both x and y\./);
	await rejects({ actions: [{ action: "click" }] }, /click requires exactly one target: ref or x\/y coordinates\./);
	await rejects({ actions: [{ action: "click", ref: refs.Save, x: 1, y: 2 }] }, /click requires exactly one target/);
	await rejects({ actions: [{ action: "moveMouse" }] }, /moveMouse requires exactly one target/);
	await rejects({ actions: [{ action: "press" }] }, /press requires an actionable ref\./);
	await rejects({ actions: [{ action: "scroll", scrollX: 0 }] }, /scroll requires a non-zero scrollX or scrollY delta\./);
	for (const clickCount of [0, 4, 1.5, "2"]) await rejects({ actions: [{ action: "click", x: 1, y: 1, clickCount }] }, /clickCount must be an integer from 1 to 3\./);
});

test("act_ui reports a page that disappears mid-transaction and stays on the base state", async ({ onTestFinished }) => {
	const { act, stateId, refs, cdp, paramsOf } = await observePage(onTestFinished);
	cdp.handle("Runtime.callFunctionOn", () => {
		cdp.setTargets([]);
		return {};
	});
	await assert.rejects(() => act({ stateId, actions: [{ action: "press", ref: refs.Save }, { action: "press", ref: refs.Docs }] }), /The browser root became unavailable during the action transaction\. Observe it again\./);
	assert.equal(paramsOf("DOM.resolveNode").length, 1, "the second action never ran");
});

test("act_ui reports a vanished page when the successor snapshot cannot be taken", async ({ onTestFinished }) => {
	const { act, stateId, refs, cdp } = await observePage(onTestFinished);
	cdp.handle("Runtime.callFunctionOn", () => {
		cdp.setTargets([]);
		return {};
	});
	await assert.rejects(() => act({ stateId, actions: [{ action: "press", ref: refs.Save }] }), /Browser root 'browser:page1' is no longer available\. Call find_roots and observe_ui again\./);
});

test("expect on a browser transaction passes once the page shows the text", async ({ onTestFinished }) => {
	const { act, stateId, refs, page, cdp } = await observePage(onTestFinished);
	let calls = 0;
	cdp.handle("Accessibility.getFullAXTree", () => {
		calls += 1;
		// Base observation, then the postcondition poll: absent twice, present on the third look.
		const done = calls >= 4;
		const root = { ...page.nodes[0], childIds: [...page.nodes[0].childIds, "6"] };
		return { nodes: done ? [root, ...page.nodes.slice(1), ax("6", "button", "Done", { parentId: "1", backendDOMNodeId: 16 })] : page.nodes };
	});
	const result = await act({ stateId, actions: [{ action: "press", ref: refs.Save }], expect: { text: "Done", timeoutMs: 5_000 } });
	assert.ok(calls >= 4, `polled until the text appeared (${calls} snapshots)`);
	assert.match(JSON.stringify(result.details), /Done/);
});

test("expect absent passes when the text is absent and fails when it stays", async ({ onTestFinished }) => {
	const { act, stateId, refs } = await observePage(onTestFinished);
	const gone = await act({ stateId, actions: [{ action: "press", ref: refs.Save }], expect: { text: "Missing", until: "absent", timeoutMs: 100 } });
	await assert.rejects(() => act({ stateId: gone.details.stateId, actions: [{ action: "press", ref: refs.Save }], expect: { text: "Save", until: "absent", timeoutMs: 100 } }), /The browser action was delivered but its postcondition was not satisfied within 100ms\./);
});

test("expect that never holds fails after the timeout and an unknown scope is rejected up front", async ({ onTestFinished }) => {
	const { act, stateId, refs, methods } = await observePage(onTestFinished);
	await assert.rejects(() => act({ stateId, actions: [{ action: "press", ref: refs.Save }], expect: { text: "Never", timeoutMs: 100 } }), /not satisfied within 100ms/);
	const baseline = methods().length;
	await assert.rejects(() => act({ stateId, actions: [{ action: "press", ref: refs.Save }], expect: { text: "Save", scopeRef: "@e99" } }), /Condition scope ref '@e99' is unavailable in this state\./);
	assert.equal(methods().length, baseline);
});

test("expect fails when the page disappears while polling", async ({ onTestFinished }) => {
	const { act, stateId, refs, cdp } = await observePage(onTestFinished);
	cdp.handle("DOM.resolveNode", (params) => {
		cdp.setTargets([]);
		return { object: { objectId: `object-${params.backendNodeId}` } };
	});
	await assert.rejects(() => act({ stateId, actions: [{ action: "press", ref: refs.Save }], expect: { text: "Done", timeoutMs: 100 } }), /Browser root 'browser:page1' is no longer available\. Observe it again\./);
});

test("an abort during the first postcondition poll stops the transaction after the action was delivered", async ({ onTestFinished }) => {
	const { act, stateId, refs, cdp, page, paramsOf } = await observePage(onTestFinished);
	const abort = new AbortController();
	cdp.handle("Accessibility.getFullAXTree", () => {
		abort.abort();
		return { nodes: page.nodes };
	});
	await assert.rejects(() => act({ stateId, actions: [{ action: "press", ref: refs.Save }], expect: { text: "Never", timeoutMs: 20_000 } }, abort.signal), /^Error: Operation aborted\.$/);
	assert.equal(paramsOf("Runtime.callFunctionOn").length, 1, "the press was delivered before the wait was cancelled");
});

test("a CDP error from the page propagates and still consumes the write epoch", async ({ onTestFinished }) => {
	const { act, stateId, refs, cdp } = await observePage(onTestFinished);
	cdp.handle("Runtime.callFunctionOn", () => cdpError("Node is detached"));
	await assert.rejects(() => act({ stateId, actions: [{ action: "press", ref: refs.Save }] }), /Node is detached/);
	await assert.rejects(() => act({ stateId, actions: [{ action: "press", ref: refs.Save }] }), /State is stale/);
});

test("navigate_browser navigates, waits for load and returns the successor state", async ({ onTestFinished }) => {
	const { desktop, cdp, stateId, paramsOf } = await observePage(onTestFinished);
	cdp.handle("Page.navigate", (_params, ctx) => {
		setImmediate(() => ctx.connection.emit("Page.loadEventFired", {}));
		return { frameId: "f" };
	});
	const result = await desktop.call(desktop.bridge.executeNavigateBrowser, { stateId, url: "https://example.test/next" });
	assert.deepEqual(paramsOf("Page.navigate"), [{ url: "https://example.test/next" }]);
	assert.equal(result.details.tool, "navigate_browser");
	assert.equal(result.details.baseStateId, stateId);
	await assert.rejects(() => desktop.call(desktop.bridge.executeNavigateBrowser, { stateId, url: "https://example.test/again" }), /State is stale/);
});

test("navigate_browser validates its target and url", async ({ onTestFinished }) => {
	const { desktop, stateId, methods } = await observePage(onTestFinished);
	/** Call `navigate_browser`. */
	const navigate = (params) => desktop.call(desktop.bridge.executeNavigateBrowser, params);
	await assert.rejects(() => navigate({ stateId, url: "file:///etc/passwd" }), /navigate_browser\.url must be an absolute HTTP\(S\) URL\./);
	await assert.rejects(() => navigate({ stateId }), /navigate_browser\.url must be an absolute HTTP\(S\) URL\./);
	await assert.rejects(() => navigate({ url: "https://example.test/" }), /navigate_browser\.stateId must belong to a CDP browser-page observation/);
	await assert.rejects(() => navigate({ stateId: "nope", url: "https://example.test/" }), /State 'nope' is unavailable or was evicted/);
	assert.ok(!methods().includes("Page.navigate"));
});

test("navigate_browser reports a page that is gone", async ({ onTestFinished }) => {
	const { desktop, cdp, stateId } = await observePage(onTestFinished);
	cdp.setTargets([]);
	await assert.rejects(() => desktop.call(desktop.bridge.executeNavigateBrowser, { stateId, url: "https://example.test/" }), /Browser context 'browser:page1' is no longer available\. Observe it again\./);
});

test("evaluate_browser returns the value with the successor state", async ({ onTestFinished }) => {
	const { desktop, stateId, paramsOf } = await observePage(onTestFinished);
	const result = await desktop.call(desktop.bridge.executeEvaluateBrowser, { stateId, expression: "6 * 7" });
	assert.ok(paramsOf("Runtime.evaluate").some((params) => params.expression === "6 * 7"));
	assert.equal(result.details.tool, "evaluate_browser");
	assert.equal(result.details.baseStateId, stateId);
	assert.notEqual(result.details.stateId, stateId);
	assert.equal(result.content.at(-1).text, "Evaluation value: 42");
});

test("evaluate_browser validates its target and expression and reports a gone page", async ({ onTestFinished }) => {
	const { desktop, cdp, stateId } = await observePage(onTestFinished);
	/** Call `evaluate_browser`. */
	const evaluate = (params) => desktop.call(desktop.bridge.executeEvaluateBrowser, params);
	await assert.rejects(() => evaluate({ stateId, expression: "  " }), /evaluate_browser\.expression must be non-empty JavaScript\./);
	await assert.rejects(() => evaluate({ stateId, expression: 5 }), /evaluate_browser\.expression must be non-empty JavaScript\./);
	await assert.rejects(() => evaluate({ expression: "1" }), /evaluate_browser\.stateId must belong to a browser observation\./);
	cdp.setTargets([]);
	await assert.rejects(() => evaluate({ stateId, expression: "1" }), /Browser context 'browser:page1' is no longer available\. Observe it again\./);
});
