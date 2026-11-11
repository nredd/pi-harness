// wait_for through the public executor: native helper waits and CDP browser polling.
import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { installFakeDesktop, wireButton, wireNode } from "./support/fake-desktop.mjs";
import { browserSnapshot, observeBrowser } from "./support/fake-browser.mjs";

vi.mock("../src/cdp.ts", async (importOriginal) => ({ ...(await importOriginal()), listCdpPageContexts: vi.fn(async () => []), cdpSnapshotForContext: vi.fn(async () => undefined) }));

const staticText = (ref, title, extra = {}) => wireNode(ref, "AXStaticText", title, extra);

test("wait_for validates its condition before touching the helper", async ({ onTestFinished }) => {
	const fake = await installFakeDesktop(onTestFinished);
	const { executeWaitFor } = fake.bridge;
	fake.tree = [wireButton("go", "Go"), staticText("lbl", "Label")];
	const { stateId } = await fake.observe();
	const rejects = (params, pattern) => assert.rejects(() => fake.call(executeWaitFor, { stateId, ...params }), pattern);

	await rejects({}, /A UI condition requires text, role, or value\./);
	await rejects({ role: "button" }, /A role-only UI condition requires ref or scopeRef\./);
	await rejects({ text: "Go", value: "x" }, /A value UI condition requires an exact ref\./);
	await rejects({ text: "Go", ref: "@e2", scopeRef: "@e1" }, /accepts ref or scopeRef, not both/);
	await rejects({ text: "Go", scopeRef: "@e99" }, /Condition scope ref '@e99' is unavailable in this state\./);
	await rejects({ text: "Go", ref: "@e99" }, /Condition scope ref '@e99' is unavailable in this state\./);
	assert.equal(fake.waits.length, 0, "invalid conditions never reach the helper");
});

test("wait_for reports an appeared condition with a diff and the matched target", async ({ onTestFinished }) => {
	const fake = await installFakeDesktop(onTestFinished);
	const { executeWaitFor } = fake.bridge;
	fake.tree = [wireNode("grp", "AXGroup", "Panel", { children: [wireButton("go", "Go")] })];
	const { stateId } = await fake.observe();
	fake.tree = [wireNode("grp", "AXGroup", "Panel", { children: [wireButton("go", "Go"), wireButton("done", "Done")] })];
	fake.waitFor = async () => ({ found: true, nodeCount: 3 });

	const result = await fake.call(executeWaitFor, { stateId, text: "Done", role: "AXButton", scopeRef: "@e2", timeoutMs: 5_000 });
	const { request, options } = fake.waits[0];
	assert.deepEqual({ ...request, lookId: undefined }, { pid: 1, windowId: 100, rootRef: "ax:w1", windowRef: "ax:w1", lookId: undefined, text: "Done", role: "AXButton", value: undefined, scopeRef: "grp", scopeExact: false, gone: false, timeoutMs: 5_000 });
	assert.equal(request.lookId, "look1");
	assert.equal(options.timeoutMs, 7_000, "the transport budget exceeds the wait by two seconds");

	assert.match(fake.text(result), /^Condition appeared\.\n\+ @e4 under @e2 "Done"\nUse stateId \S+ for subsequent actions and queries\.$/);
	assert.equal(result.details.view, "diff");
	assert.equal(result.details.found, true);
	assert.equal(result.details.gone, undefined);
	assert.equal(result.details.timedOut, undefined);
	assert.equal(result.details.nodeCount, 3);
	assert.equal(result.details.baseStateId, stateId);
	assert.notEqual(result.details.stateId, stateId);
	assert.equal(result.details.target.label, "Done");
	assert.equal(result.details.scopeRef, "@e2");
	assert.match(result.details.renderedOutline, /Done/);
});

test("wait_for maps roles, exact refs and values onto the helper request", async ({ onTestFinished }) => {
	const fake = await installFakeDesktop(onTestFinished);
	const { executeWaitFor } = fake.bridge;
	fake.tree = [wireNode("field", "AXTextField", "Name", { value: "Ada" }), wireNode("pic", "AXImage", "Logo", { pictureOnly: true, wireRef: undefined })];
	const { stateId } = await fake.observe();

	await fake.call(executeWaitFor, { stateId, text: "Name", role: "textfield" });
	assert.equal(fake.waits[0].request.role, "AXTextField", "a loose role resolves to the platform role in the outline");
	await fake.call(executeWaitFor, { stateId, text: "Name", role: "Slider" });
	assert.equal(fake.waits[1].request.role, "Slider", "an unseen role passes through");
	await fake.call(executeWaitFor, { stateId, text: "Name", ref: "@e2", value: "Ada" });
	assert.deepEqual([fake.waits[2].request.scopeRef, fake.waits[2].request.scopeExact, fake.waits[2].request.value], ["field", true, "Ada"]);
	await assert.rejects(() => fake.call(executeWaitFor, { stateId, text: "Logo", ref: "@e3" }), /pictureOnly and has no semantic element/);
	// Timeouts are clamped to [100, 60000] and default to 10s.
	await fake.call(executeWaitFor, { stateId, text: "Name", timeoutMs: 1 });
	await fake.call(executeWaitFor, { stateId, text: "Name", timeoutMs: 1e9 });
	await fake.call(executeWaitFor, { stateId, text: "Name" });
	assert.deepEqual(fake.waits.slice(3).map((wait) => wait.request.timeoutMs), [100, 60_000, 10_000]);
});

test("wait_for reports timeouts and disappearance, replacing the diff when the root changed", async ({ onTestFinished }) => {
	const fake = await installFakeDesktop(onTestFinished);
	const { executeWaitFor } = fake.bridge;
	fake.tree = [wireButton("go", "Go")];
	const { stateId } = await fake.observe();

	fake.waitFor = async () => ({ found: false, timedOut: true, nodeCount: Number.NaN });
	const timedOut = await fake.call(executeWaitFor, { stateId, text: "Never", timeoutMs: 250 });
	assert.match(fake.text(timedOut), /^Timed out after 250ms waiting for condition\.\n\(no element changes\)\nUse stateId /);
	assert.deepEqual([timedOut.details.found, timedOut.details.timedOut, timedOut.details.target], [false, true, undefined]);
	assert.equal(timedOut.details.nodeCount, 2, "a non-finite helper count falls back to the refreshed outline size");

	fake.waitFor = async () => ({ found: true, gone: true, nodeCount: 2 });
	const gone = await fake.call(executeWaitFor, { stateId, text: "Go", until: "absent" });
	assert.equal(fake.waits.at(-1).request.gone, true);
	assert.match(fake.text(gone), /^Condition disappeared\./);
	assert.equal(gone.details.gone, true);

	// A replaced root is not diffable: the full compact view comes back instead.
	fake.lookPayload = (request) => ({
		lookId: "replaced",
		capturedAt: 1,
		window: { windowId: 100, rootRef: "ax:w1", kind: "window", framePoints: { x: 0, y: 0, w: 300, h: 200 }, scaleFactor: 1, isModal: false, role: "AXSheet", subrole: "", metadata: {} },
		outline: wireNode("sheet", "AXSheet", "Sheet", { children: [wireButton("ok", "OK")] }),
		readText: { requested: request.readText, executed: false },
		timings: {},
	});
	const replaced = await fake.call(executeWaitFor, { stateId, text: "OK" });
	assert.equal(replaced.details.view, "full");
	assert.equal(replaced.details.changes, undefined);
	assert.match(fake.text(replaced), /\nControls \(1 of 2 nodes, stateId .*root_replaced|\nControls \(1 of 2 nodes/);
	assert.equal(replaced.details.target.label, "OK");
});

test("wait_for forwards aborts to the helper wait", async ({ onTestFinished }) => {
	const fake = await installFakeDesktop(onTestFinished);
	const { executeWaitFor } = fake.bridge;
	const { stateId } = await fake.observe();
	const controller = new AbortController();
	fake.waitFor = async (_request, options) => {
		assert.equal(options.signal, controller.signal);
		controller.abort();
		throw new Error("Operation aborted.");
	};
	await assert.rejects(() => fake.call(executeWaitFor, { stateId, text: "Go" }, controller.signal), /Operation aborted\./);
});

// Browser pages: the bridge polls CDP snapshots itself.
test("wait_for polls a browser page until the condition appears", async ({ onTestFinished }) => {
	const fake = await installFakeDesktop(onTestFinished);
	const { executeWaitFor } = fake.bridge;
	const { cdp, stateId } = await observeBrowser(fake, [wireButton("go", "Go")]);
	const withDone = await browserSnapshot("after", [wireButton("go", "Go"), wireButton("done", "Done")]);
	const calls = [];
	cdp.cdpSnapshotForContext.mockImplementation(async (contextId) => {
		calls.push(contextId);
		return calls.length < 3 ? await browserSnapshot(`poll${calls.length}`, [wireButton("go", "Go")]) : withDone;
	});

	const result = await fake.call(executeWaitFor, { stateId, text: "Done", timeoutMs: 5_000 });
	assert.equal(calls.length, 3, "polls until the condition appears");
	assert.deepEqual(calls, ["browser:page1", "browser:page1", "browser:page1"]);
	assert.equal(fake.text(result), 'Condition appeared.\n+ @e3 under @e1 "Done"\nUse stateId after for subsequent actions and queries.');
	assert.deepEqual([result.details.found, result.details.view, result.details.stateId, result.details.baseStateId], [true, "diff", "after", "base"]);
	assert.equal(result.details.nodeCount, 2);
	assert.equal(result.details.gone, undefined);
	assert.equal(result.details.timedOut, undefined);
	assert.equal(fake.bridge.testing.savedState("after").stateId, "after", "the successor state is saved for later calls");
});

test("wait_for on a browser page honors role, value and scope conditions", async ({ onTestFinished }) => {
	const fake = await installFakeDesktop(onTestFinished);
	const { executeWaitFor } = fake.bridge;
	const children = [wireNode("grp", "AXGroup", "Form", { children: [wireNode("name", "AXTextField", "Name", { value: "Ada" })] }), wireNode("other", "AXTextField", "Alias", { value: "Bob" })];
	const { cdp, stateId } = await observeBrowser(fake, children);
	cdp.cdpSnapshotForContext.mockImplementation(async () => await browserSnapshot("now", children));
	const wait = (params) => fake.call(executeWaitFor, { stateId, timeoutMs: 100, ...params });

	assert.equal((await wait({ text: "Name", role: "textfield", ref: "@e4", value: "Ada" })).details.found, true, "exact ref plus value match");
	assert.equal((await wait({ text: "Name", scopeRef: "@e2" })).details.found, true, "descendants of a scope ref match");
	const wrongValue = await wait({ text: "Name", ref: "@e4", value: "Bob" });
	assert.equal(wrongValue.details.found, false, "a different value is not a match");
	assert.equal(wrongValue.details.value, "Bob");
	assert.equal((await wait({ text: "Name", ref: "@e2" })).details.found, false, "an exact ref excludes its descendants");
	assert.equal((await wait({ text: "Alias", scopeRef: "@e2" })).details.found, false, "nodes outside the scope subtree do not match");
	assert.equal((await wait({ text: "Name", role: "button", scopeRef: "@e2" })).details.found, false, "a role mismatch is not a match");
	await assert.rejects(() => wait({ text: "Name", scopeRef: "@e77" }), /Condition scope ref '@e77' is unavailable in this state\./);
});

test("wait_for on a browser page times out and reports disappearance", async ({ onTestFinished }) => {
	const fake = await installFakeDesktop(onTestFinished);
	const { executeWaitFor } = fake.bridge;
	const { cdp, stateId } = await observeBrowser(fake, [wireButton("go", "Go")]);
	cdp.cdpSnapshotForContext.mockImplementation(async () => await browserSnapshot("same", [wireButton("go", "Go")]));

	const timedOut = await fake.call(executeWaitFor, { stateId, text: "Never", timeoutMs: 100 });
	assert.match(fake.text(timedOut), /^Timed out after 100ms waiting for condition\.\n\(no element changes\)/);
	assert.deepEqual([timedOut.details.found, timedOut.details.timedOut, timedOut.details.gone], [false, true, undefined]);
	assert.ok(cdp.cdpSnapshotForContext.mock.calls.length >= 2, "at least the initial poll ran");

	cdp.cdpSnapshotForContext.mockImplementation(async () => await browserSnapshot("gone", []));
	const gone = await fake.call(executeWaitFor, { stateId, text: "Go", until: "absent", timeoutMs: 5_000 });
	assert.match(fake.text(gone), /^Condition disappeared\./);
	assert.deepEqual([gone.details.found, gone.details.gone, gone.details.nodeCount], [true, true, 0]);

	// An absent condition that never clears times out without claiming it disappeared.
	cdp.cdpSnapshotForContext.mockImplementation(async () => await browserSnapshot("still", [wireButton("go", "Go")]));
	const stuck = await fake.call(executeWaitFor, { stateId, text: "Go", until: "absent", timeoutMs: 100 });
	assert.deepEqual([stuck.details.found, stuck.details.timedOut, stuck.details.gone], [false, true, undefined]);
});

test("wait_for on a browser page fails when the page vanishes or the wait is aborted", async ({ onTestFinished }) => {
	const fake = await installFakeDesktop(onTestFinished);
	const { executeWaitFor } = fake.bridge;
	const { cdp, stateId } = await observeBrowser(fake, [wireButton("go", "Go")]);

	cdp.cdpSnapshotForContext.mockResolvedValue(undefined);
	await assert.rejects(() => fake.call(executeWaitFor, { stateId, text: "Go" }), /Browser root 'browser:page1' is no longer available\. Call find_roots and observe_ui again\./);

	cdp.cdpSnapshotForContext.mockImplementation(async () => await browserSnapshot("poll", [wireButton("go", "Go")]));
	const controller = new AbortController();
	const pending = fake.call(executeWaitFor, { stateId, text: "Never", timeoutMs: 60_000 }, controller.signal);
	setTimeout(() => controller.abort(), 50);
	await assert.rejects(() => pending, /Operation aborted\./);
});

test("wait_for on a browser page returns the full view when the page root was replaced", async ({ onTestFinished }) => {
	const fake = await installFakeDesktop(onTestFinished);
	const { cdp, stateId } = await observeBrowser(fake, [wireButton("go", "Go")]);
	cdp.cdpSnapshotForContext.mockImplementation(async () => await browserSnapshot("dialog", [wireButton("ok", "OK")], { role: "AXDialog" }));

	const result = await fake.call(fake.bridge.executeWaitFor, { stateId, text: "OK" });
	assert.equal(result.details.view, "full");
	assert.equal(result.details.changes, undefined);
	assert.match(fake.text(result), /^Condition appeared\.\nControls \(1 of 2 nodes, stateId dialog, root @e1\):\n@e2 button "OK"/);
});
