// `act_ui` desktop transactions: batching, `expect`, root-delta refs, terminal results and the foreground modal note (nredd/pi-harness#712, Refs #645).
import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { currentPlatformBackend } from "../src/platform/index.ts";
import { desktopRoot, installFakeDesktop, wireButton } from "./support/fake-desktop.mjs";

afterEach(() => {
	vi.unstubAllEnvs();
});

/**
 * Install the fake desktop, observe its window and return an `act` shortcut.
 * @param {(fn: () => void | Promise<void>) => void} onTestFinished Vitest cleanup registrar.
 * @param {object} [options] `roots` override for `installFakeDesktop`.
 * @returns {Promise<object>} `{ fake, stateId, act }`; `act(actions, extra)` runs `act_ui` on the observed state.
 * @throws {Error} When the observation fails.
 */
async function observed(onTestFinished, options = {}) {
	const fake = await installFakeDesktop(onTestFinished, options);
	const { stateId } = await fake.observe();
	return { fake, stateId, act: (actions, extra = {}, signal) => fake.call(fake.bridge.executeAct, { stateId, actions, ...extra }, signal) };
}

const press = { action: "press", ref: "@e2" };

test("a step the helper reports as didnt stops the transaction and only the executed steps are counted", async ({ onTestFinished }) => {
	const { fake, act } = await observed(onTestFinished);
	fake.actResult = { outcome: "didnt", performed: { delivery: "pid" } };
	const result = await act([press, press, press]);
	assert.equal(fake.actCalls.length, 1, "later steps are not dispatched after a didnt");
	assert.equal(result.details.execution.outcome, "didnt");
	assert.equal(result.details.execution.actionCount, 1);
	assert.match(fake.text(result), /^Executed 1 checked UI action in/);
});

test("an unknown step makes the transaction unknown, and all-worked steps make it worked", async ({ onTestFinished }) => {
	const { fake, act } = await observed(onTestFinished);
	const results = [{ outcome: "worked", performed: { delivery: "pid" } }, { outcome: "unknown", performed: { delivery: "pid" } }];
	currentPlatformBackend.act = async (request) => {
		fake.actCalls.push(request);
		return results.shift() ?? { outcome: "worked", performed: { delivery: "pid" } };
	};
	const mixed = await act([press, press]);
	assert.equal(mixed.details.execution.outcome, "unknown");
	assert.deepEqual(mixed.details.execution.steps.map((step) => step.outcome), ["worked", "unknown"]);
	const { stateId } = await fake.observe();
	const clean = await fake.call(fake.bridge.executeAct, { stateId, actions: [press, press] });
	assert.equal(clean.details.execution.outcome, "worked");
	assert.equal(clean.details.execution.actionCount, 2);
});

test("an observed setText value turns an unknown helper outcome into worked", async ({ onTestFinished }) => {
	const { fake, act } = await observed(onTestFinished);
	fake.actResult = { outcome: "unknown", performed: { delivery: "pid" } };
	fake.tree = [wireButton("b1", "Go", { value: "typed" })];
	const result = await act([{ action: "setText", ref: "@e2", text: "typed" }]);
	assert.equal(result.details.execution.outcome, "worked");
});

test("a strict-headless batch with no checked steps is an error", async ({ onTestFinished }) => {
	vi.stubEnv("PI_COMPUTER_USE_HEADLESS", "1");
	const { fake, act } = await observed(onTestFinished);
	for (const steps of [undefined, []]) {
		const { stateId } = await fake.observe();
		fake.actBatchResult = { outcome: "worked", performed: { delivery: "ax" }, steps };
		await assert.rejects(() => fake.call(fake.bridge.executeAct, { stateId, actions: [press] }), /Native action transaction returned no checked steps\./);
	}
});

test("a strict-headless batch aggregates its checked steps and the batch root delta", async ({ onTestFinished }) => {
	vi.stubEnv("PI_COMPUTER_USE_HEADLESS", "1");
	const { fake, act } = await observed(onTestFinished);
	fake.actBatchResult = {
		outcome: "didnt",
		performed: { delivery: "ax", transaction: true, actionCount: 2 },
		stoppedAt: 1,
		steps: [{ outcome: "worked", performed: { delivery: "ax" } }, { outcome: "didnt", performed: { delivery: "ax" } }],
	};
	const result = await act([press, press, press]);
	assert.equal(fake.actBatchCalls[0].length, 3);
	assert.equal(result.details.execution.outcome, "didnt");
	assert.equal(result.details.execution.stoppedAt, 1);
	assert.equal(result.details.execution.actionCount, 2);
});

test("a batch result without an outcome is treated as unknown, with or without a postcondition or a capture failure", async ({ onTestFinished }) => {
	vi.stubEnv("PI_COMPUTER_USE_HEADLESS", "1");
	const { fake } = await observed(onTestFinished);
	fake.actBatchResult = { performed: { delivery: "ax", transaction: true, actionCount: 1 }, steps: [{ outcome: "worked", performed: { delivery: "ax" } }] };
	const run = async (extra = {}) => {
		const { stateId } = await fake.observe();
		return await fake.call(fake.bridge.executeAct, { stateId, actions: [press], ...extra });
	};
	assert.equal((await run()).details.execution.outcome, "unknown");
	const preexisting = await run({ expect: { text: "Go", timeoutMs: 250 } });
	assert.equal(preexisting.details.execution.verification.status, "preexisting");
	assert.equal(preexisting.details.execution.outcome, "unknown", "a preexisting condition does not upgrade an unknown outcome");
	const { stateId } = await fake.observe();
	let closed = false;
	failCapture(fake, () => {
		closed = true;
	});
	fake.listRootsHook = (query) => (closed ? [] : query?.pid ? fake.roots.filter((root) => root.pid === query.pid) : fake.roots);
	const terminal = await fake.call(fake.bridge.executeAct, { stateId, actions: [press], expect: { text: "Go", until: "absent", timeoutMs: 250 } });
	assert.equal(terminal.details.execution.verification.status, "verified");
	assert.equal(terminal.details.execution.outcome, "worked");
});

test("a failing wait on a batch without an outcome still reaches the terminal result for a closed root", async ({ onTestFinished }) => {
	vi.stubEnv("PI_COMPUTER_USE_HEADLESS", "1");
	const { fake, act } = await observed(onTestFinished);
	fake.actBatchResult = { performed: { delivery: "ax", transaction: true, actionCount: 1 }, steps: [{ outcome: "worked", performed: { delivery: "ax" } }] };
	let closed = false;
	fake.waitFor = async () => {
		closed = true;
		throw new Error("wait failed");
	};
	fake.listRootsHook = (query) => (closed ? [] : query?.pid ? fake.roots.filter((root) => root.pid === query.pid) : fake.roots);
	const result = await act([press], { expect: { text: "Go", timeoutMs: 250 } });
	assert.equal(result.details.status, "target_closed");
	assert.equal(result.details.execution.verification.status, "failed");
	assert.equal(result.details.execution.outcome, "didnt");
});

test("expect distinguishes a verified change from a preexisting condition and sends the scope and mode", async ({ onTestFinished }) => {
	const { fake, act } = await observed(onTestFinished);
	const verified = await act([press], { expect: { text: "Done", timeoutMs: 400 } });
	assert.equal(verified.details.execution.verification.status, "verified");
	assert.equal(verified.details.execution.outcome, "worked");
	assert.deepEqual({ text: fake.waits[0].request.text, gone: fake.waits[0].request.gone, scopeRef: fake.waits[0].request.scopeRef, timeoutMs: fake.waits[0].request.timeoutMs }, { text: "Done", gone: false, scopeRef: undefined, timeoutMs: 400 });
	assert.equal(fake.waits[0].options.timeoutMs, 2_400);

	const { stateId } = await fake.observe();
	const preexisting = await fake.call(fake.bridge.executeAct, { stateId, actions: [press], expect: { text: "Go", scopeRef: "@e1" } });
	assert.equal(preexisting.details.execution.verification.status, "preexisting");
	assert.equal(fake.waits[1].request.scopeRef, "w", "the scope ref goes out as the wire ref");

	const { stateId: next } = await fake.observe();
	const gone = await fake.call(fake.bridge.executeAct, { stateId: next, actions: [press], expect: { text: "Go", until: "absent" } });
	assert.equal(gone.details.execution.verification.status, "verified");
	assert.equal(gone.details.execution.verification.gone, true);
});

test("an unmet expect marks the transaction didnt with a postcondition error", async ({ onTestFinished }) => {
	const { fake, act } = await observed(onTestFinished);
	fake.waitFor = async () => ({ found: false, timedOut: true });
	const result = await act([press], { expect: { text: "Never", timeoutMs: 250 } });
	assert.equal(result.details.execution.verification.status, "failed");
	assert.equal(result.details.execution.outcome, "didnt");
	assert.deepEqual(result.details.execution.error, { code: "postcondition_failed", message: "The action was delivered but its postcondition was not satisfied within 250ms." });
});

test("expect with an unknown scope or no matcher is refused before the helper acts", async ({ onTestFinished }) => {
	const { fake, act } = await observed(onTestFinished);
	await assert.rejects(() => act([press], { expect: { text: "x", scopeRef: "@e99" } }), /Condition scope ref '@e99' is unavailable in this state\./);
	await assert.rejects(() => act([press], { expect: {} }), /A UI condition requires text, role, or value\./);
	assert.deepEqual(fake.actCalls, []);
});

/**
 * Make the post-act observation fail, as when the window closes under the action.
 * @param {object} fake Fake desktop controls.
 * @param {() => void} [before] Runs when the capture is attempted.
 * @param {unknown} [failure] What the capture throws.
 * @returns {void}
 * @throws {never} Installs the hook only.
 */
function failCapture(fake, before = () => {}, failure = new Error("capture failed")) {
	fake.lookPayload = () => {
		before();
		throw failure;
	};
}

test("a failed successor capture with the window still listed is a terminal observation failure", async ({ onTestFinished }) => {
	const { fake, stateId, act } = await observed(onTestFinished);
	failCapture(fake);
	const result = await act([press]);
	assert.equal(result.details.status, "post_action_observation_failed");
	assert.equal(result.details.baseStateId, stateId);
	assert.deepEqual(result.details.error, { code: "post_action_observation_failed", message: "capture failed" });
	assert.equal(result.details.cause, undefined);
	assert.match(fake.text(result), /^The action was delivered, but its source root App1 — Main could not be observed afterward: capture failed\nNo successor state was created\./);
	await assert.rejects(() => act([press]), /State is stale for desktop-pid:1/, "the consumed state is not reused");
});

test("a non-Error failure is stringified into the terminal result", async ({ onTestFinished }) => {
	const { fake, act } = await observed(onTestFinished);
	failCapture(fake, () => {}, "plain failure");
	const result = await act([press]);
	assert.equal(result.details.error.message, "plain failure");
});

test("a root_not_found failure while the root is listed reports an expired root ref", async ({ onTestFinished }) => {
	const { fake, act } = await observed(onTestFinished);
	failCapture(fake, () => {}, Object.assign(new Error("gone ref"), { code: "root_not_found" }));
	const result = await act([press]);
	assert.equal(result.details.error.code, "root_stale");
	assert.equal(result.details.error.message, "Root expired or was never valid for observation (gone ref). Rediscover with find_roots.");
	assert.equal(result.details.status, "post_action_observation_failed");
});

test("a root_not_found failure proves nothing when the identity probe itself fails", async ({ onTestFinished }) => {
	const { fake, act } = await observed(onTestFinished);
	let probing = false;
	failCapture(fake, () => {
		probing = true;
	}, Object.assign(new Error("gone ref"), { code: "root_not_found" }));
	fake.listRootsHook = (query) => {
		if (probing) throw new Error("listing failed");
		return query?.pid ? fake.roots.filter((root) => root.pid === query.pid) : fake.roots;
	};
	const result = await act([press]);
	assert.equal(result.details.error.code, "post_action_observation_failed");
	assert.equal(result.details.status, "post_action_observation_failed");
	assert.equal(result.details.cause, undefined, "a failed probe cannot prove the root closed");
});

test("a root that closed under the action is reported with a synthetic closed delta", async ({ onTestFinished }) => {
	const { fake, act } = await observed(onTestFinished);
	let closed = false;
	failCapture(fake, () => {
		closed = true;
	});
	fake.listRootsHook = (query) => (closed ? [] : query?.pid ? fake.roots.filter((root) => root.pid === query.pid) : fake.roots);
	const result = await act([press]);
	assert.equal(result.details.status, "target_closed");
	assert.equal(result.details.cause, "closed");
	assert.deepEqual(result.details.successors, []);
	assert.equal(result.details.error.code, "target_closed");
	assert.deepEqual(result.details.execution.rootDelta, [{ change: "closed", kind: "window", ref: "@r1", title: "Main", pid: 1, metadata: { source: "post_action_identity_probe" } }]);
	assert.match(fake.text(result), /^The action was delivered, and its source root App1 — Main closed before a successor observation could be captured\./);
});

test("a helper closed delta for the target is not duplicated by the identity probe", async ({ onTestFinished }) => {
	const { fake, act } = await observed(onTestFinished);
	let closed = false;
	fake.actResult = { outcome: "worked", performed: { delivery: "pid" }, rootDelta: [{ change: "closed", kind: "window", ref: "ax:w1", pid: 1 }] };
	failCapture(fake, () => {
		closed = true;
	});
	fake.listRootsHook = (query) => (closed ? [] : query?.pid ? fake.roots.filter((root) => root.pid === query.pid) : fake.roots);
	const result = await act([press]);
	assert.equal(result.details.status, "target_closed");
	assert.equal(result.details.execution.rootDelta.length, 1, "no synthetic duplicate");
	assert.equal(result.details.execution.rootDelta[0].ref, "@r1", "the native ref was rewritten to the public ref");
});

test("a closed root with a replacement dialog names its successor, and a failed expect is carried through", async ({ onTestFinished }) => {
	const dialog = desktopRoot({ pid: 1, windowId: 150, rootRef: "ax:dlg", windowRef: "ax:dlg", kind: "dialog", title: "Replace", isModal: true, isFocused: true });
	const bare = desktopRoot({ pid: 1, windowId: 151, rootRef: "ax:bare", windowRef: "ax:bare", title: "" });
	const menu = desktopRoot({ pid: 1, windowId: 152, rootRef: "ax:menu", windowRef: "ax:menu", kind: "menu", title: "Menu" });
	// Live roots that cannot or need not match by `rootRef`: another app, one with only a `windowRef`, one with no native ref at all.
	const stranger = desktopRoot({ pid: 3, windowId: 300, rootRef: "ax:stranger", windowRef: "ax:stranger" });
	const nameless = { ...desktopRoot({ pid: 1, windowId: 153, title: "Nameless" }), rootRef: undefined, windowRef: undefined };
	const windowOnly = { ...desktopRoot({ pid: 1, windowId: 154, windowRef: "ax:wonly", title: "WindowOnly" }), rootRef: undefined };
	const { fake, act } = await observed(onTestFinished, { roots: [desktopRoot({ pid: 1 }), dialog, bare, menu, windowOnly, stranger] });
	let closed = false;
	fake.actResult = {
		outcome: "worked",
		performed: { delivery: "pid" },
		rootDelta: [
			{ change: "appeared", kind: "dialog", ref: "ax:dlg", title: "Replace", pid: 1, isModal: true },
			{ change: "appeared", kind: "window", ref: "ax:bare", pid: 1 },
			{ change: "appeared", kind: "menu", ref: "ax:menu", title: "Menu", pid: 1 },
			{ change: "focused", kind: "dialog", ref: "ax:dlg", pid: 1 },
			{ change: "appeared", kind: "dialog", pid: 1 },
			{ change: "appeared", kind: "dialog", ref: "ax:elsewhere", pid: 2 },
			{ change: "appeared", kind: "window", ref: "ax:wonly", pid: 1 },
			{ change: "appeared", kind: "window", ref: "ax:stranger", pid: 3 },
		],
	};
	failCapture(fake, () => {
		closed = true;
	});
	fake.listRootsHook = (query) => {
		if (closed) return [stranger, nameless, windowOnly, dialog, bare, menu];
		return query?.pid ? fake.roots.filter((root) => root.pid === query.pid) : fake.roots;
	};
	const result = await act([press], { expect: { text: "Done", timeoutMs: 250 } });
	assert.equal(result.details.cause, "replaced");
	assert.deepEqual(result.details.successors.map(({ kind, title, isModal }) => ({ kind, title, isModal })), [
		{ kind: "dialog", title: "Replace", isModal: true },
		{ kind: "window", title: undefined, isModal: undefined },
		{ kind: "window", title: undefined, isModal: undefined },
	], "only appeared window, dialog and sheet roots that are still listed replace the target");
	assert.ok(result.details.successors.every((successor) => /^@r\d+$/.test(successor.ref)));
	assert.match(fake.text(result), /It was replaced by dialog "Replace" \(modal\), window "", window "".$/m);
	assert.equal(result.details.execution.verification.status, "failed", "the target closed before a presence postcondition could be verified");
	assert.equal(result.details.execution.outcome, "didnt");
	assert.equal(result.details.execution.error.code, "postcondition_failed");
});

test("a closed root satisfies an absence postcondition", async ({ onTestFinished }) => {
	const { fake, act } = await observed(onTestFinished);
	let closed = false;
	failCapture(fake, () => {
		closed = true;
	});
	fake.listRootsHook = (query) => (closed ? [] : query?.pid ? fake.roots.filter((root) => root.pid === query.pid) : fake.roots);
	const result = await act([press], { expect: { text: "Go", until: "absent", timeoutMs: 250 } });
	assert.deepEqual({ status: result.details.execution.verification.status, gone: result.details.execution.verification.gone, outcome: result.details.execution.outcome, error: result.details.execution.error }, { status: "verified", gone: true, outcome: "worked", error: undefined });
});

test("an abort during the failing capture rethrows instead of building a terminal result", async ({ onTestFinished }) => {
	const { fake, act } = await observed(onTestFinished);
	const abort = new AbortController();
	failCapture(fake, () => abort.abort(), new Error("capture aborted"));
	await assert.rejects(() => act([press], {}, abort.signal), /capture aborted/);
});

test("helper root-delta refs become public refs, and unresolvable ones are dropped", async ({ onTestFinished }) => {
	const other = desktopRoot({ pid: 2, windowId: 250, rootRef: "ax:other", windowRef: "ax:other", title: "Other" });
	const { fake, act } = await observed(onTestFinished, { roots: [desktopRoot({ pid: 1 }), desktopRoot({ pid: 1, windowId: 120, rootRef: "ax:sheet", windowRef: "ax:sheet", kind: "sheet", title: "Sheet" }), other] });
	fake.actResult = {
		outcome: "worked",
		performed: { delivery: "pid" },
		rootDelta: [
			{ change: "appeared", kind: "sheet", ref: "ax:sheet", pid: 1 },
			{ change: "appeared", kind: "window", ref: "ax:other", pid: 2 },
			{ change: "appeared", kind: "window", ref: "ax:unlisted", pid: 1 },
			{ change: "closed", kind: "window", ref: "ax:never-issued", pid: 1 },
			{ change: "focused", kind: "window", ref: "@r9", pid: 1 },
			{ change: "focused", kind: "window", pid: 1 },
		],
	};
	const result = await act([press]);
	const refs = result.details.execution.rootDelta.map((delta) => delta.ref);
	assert.match(refs[0], /^@r\d+$/);
	assert.match(refs[1], /^@r\d+$/);
	assert.notEqual(refs[0], refs[1]);
	assert.deepEqual(refs.slice(2), [undefined, undefined, "@r9", undefined]);
	const found = await fake.call(fake.bridge.executeFind, {});
	const byRef = Object.fromEntries(found.details.windows.map((window) => [window.windowRef, window]));
	assert.equal(byRef[refs[0]].app, "App1", "a root of the acted app keeps the target's app name");
	assert.equal(byRef[refs[1]].app, "App2", "a root of another app takes its own app name");
});

test("a listing failure while normalizing root deltas drops the refs it cannot resolve", async ({ onTestFinished }) => {
	const { fake, act } = await observed(onTestFinished);
	fake.actResult = { outcome: "worked", performed: { delivery: "pid" }, rootDelta: [{ change: "appeared", kind: "sheet", ref: "ax:sheet", pid: 1 }] };
	let acted = false;
	const delegate = currentPlatformBackend.act;
	currentPlatformBackend.act = async (request) => {
		acted = true;
		return await delegate(request);
	};
	fake.listRootsHook = (query) => {
		if (acted && query?.pid === 1 && !fake.listFailed) {
			fake.listFailed = true;
			throw new Error("listing failed");
		}
		return undefined;
	};
	const result = await act([press]);
	assert.equal(result.details.execution.rootDelta[0].ref, undefined);
});

test("a foreground modal that opened in front of the acted root is noted in the result", async ({ onTestFinished }) => {
	const modal = desktopRoot({ pid: 1, windowId: 160, rootRef: "ax:modal", windowRef: "ax:modal", kind: "dialog", title: "Are you sure?", isModal: true, isFocused: true, zOrder: -1 });
	const { fake, act } = await observed(onTestFinished);
	const delegate = currentPlatformBackend.act;
	currentPlatformBackend.act = async (request) => {
		fake.roots = [...fake.roots, modal];
		return await delegate(request);
	};
	const result = await act([press]);
	assert.match(fake.text(result), /\nNote: dialog "Are you sure\?" is now a foreground modal in front of this root\. Call find_roots, then observe_ui it\.$/);
});

test("the highest-scoring of several foreground modals is the one named", async ({ onTestFinished }) => {
	const modal = (windowId, title, over = {}) => desktopRoot({ pid: 1, windowId, rootRef: `ax:m${windowId}`, windowRef: `ax:m${windowId}`, kind: "dialog", title, isModal: true, isFocused: true, zOrder: -1, ...over });
	const { fake, act } = await observed(onTestFinished);
	const delegate = currentPlatformBackend.act;
	currentPlatformBackend.act = async (request) => {
		fake.roots = [...fake.roots, modal(160, "Small", { framePoints: { x: 0, y: 0, w: 10, h: 10 } }), modal(161, "Large"), modal(162, "Offscreen", { isOnscreen: false })];
		return await delegate(request);
	};
	const note = fake.text(await act([press])).split("\n").at(-1);
	assert.match(note, /^Note: dialog "(Small|Large)" is now a foreground modal/);
	assert.doesNotMatch(note, /Offscreen/);
});

test("no modal note when the acted root is gone from the listing, is itself modal, or the listing fails", async ({ onTestFinished }) => {
	const { fake } = await observed(onTestFinished);
	const noteFor = async (listing) => {
		const { stateId } = await fake.observe();
		let acted = false;
		const delegate = currentPlatformBackend.act;
		currentPlatformBackend.act = async (request) => {
			acted = true;
			return await delegate(request);
		};
		const original = fake.listRootsHook;
		fake.listRootsHook = (query) => (acted && query?.pid === 1 ? listing(query) : original?.(query));
		try {
			return fake.text(await fake.call(fake.bridge.executeAct, { stateId, actions: [press] }));
		} finally {
			currentPlatformBackend.act = delegate;
			fake.listRootsHook = original;
		}
	};
	const main = fake.roots[0];
	const modal = { ...main, windowId: 160, rootRef: "ax:modal", windowRef: "ax:modal", title: "Sheet", isModal: true, isFocused: true, zOrder: -1 };
	assert.doesNotMatch(await noteFor(() => []), /foreground modal/, "target not listed");
	assert.doesNotMatch(await noteFor(() => [{ ...main, isModal: true }, modal]), /foreground modal/, "target itself modal");
	assert.doesNotMatch(await noteFor(() => {
		throw new Error("listing failed");
	}), /foreground modal/, "listing failure is swallowed");
	assert.doesNotMatch(await noteFor(() => [main]), /foreground modal/, "no competing modal");
	assert.match(await noteFor(() => [main, { ...modal, title: "" }]), /Note: dialog|Note: window "\(untitled\)"/, "an untitled modal is named");
});

test("a tool called without params runs with defaults instead of failing on the state lookup", async ({ onTestFinished }) => {
	const fake = await installFakeDesktop(onTestFinished);
	const found = await fake.call(fake.bridge.executeFind, undefined);
	assert.equal(found.details.tool, "find_roots");
	assert.equal(found.details.windows.length, 1);
});

test("an output ref skips the state lookup entirely", async ({ onTestFinished }) => {
	const fake = await installFakeDesktop(onTestFinished);
	await assert.rejects(() => fake.call(fake.bridge.executeReadText, { ref: "@o99", stateId: "ignored" }), /Output ref '@o99' is unavailable or was evicted\./);
});
