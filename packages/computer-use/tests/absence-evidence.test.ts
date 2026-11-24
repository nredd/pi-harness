// An `absent` condition holds only on complete evidence: a helper's `gone` needs a successor observation that
// neither shows the condition nor leaves its scope unread, or a proven closure (nredd/pi-harness#1242, #1243).
import assert from "node:assert/strict";
import { afterEach, expect, test, vi } from "vitest";
import { outcomeAfterCheck } from "../src/actions.ts";
import { desktopRoot, installFakeDesktop, lookPayload, wireButton, wireNode } from "../test/support/fake-desktop.mjs";

afterEach(() => {
	vi.unstubAllEnvs();
});

const UNREAD = { truncated: true };
/** The macOS marker for a node whose own fields were read but whose descendants were not (#1310). */
const CHILDREN_UNREAD = { truncated: true, childrenUnread: true };

/** A focused window with the saved root's title but another identity, e.g. a second document named alike. */
const lookalike = () =>
	desktopRoot({ rootRef: "ax:b", windowRef: "ax:b", windowId: 200, title: "Main", zOrder: 0, isFocused: true });

/** A listing the helper could not read completely (`complete: false`), as the macOS backend reports it. */
const partialListing = (roots: object[]) => Object.assign(roots, { complete: false });

test("an inconclusive check keeps the delivery outcome", () => {
	for (const outcome of ["worked", "didnt", "unknown"] as const)
		assert.equal(outcomeAfterCheck(outcome, "inconclusive"), outcome);
});

test("wait_for reports a helper's incomplete gone wait as inconclusive, not timed-out absence", async ({
	onTestFinished,
}) => {
	const fake = await installFakeDesktop(onTestFinished);
	fake.tree = [wireButton("go", "Go")];
	const { stateId } = await fake.observe();
	fake.waitFor = async () => {
		fake.tree = [];
		return { found: false, timedOut: true, incomplete: true, nodeCount: 2000 };
	};
	const result = await fake.call(fake.bridge.executeWaitFor, { stateId, text: "Go", until: "absent", timeoutMs: 250 });
	assert.deepEqual(
		[result.details.found, result.details.gone, result.details.timedOut, result.details.inconclusive],
		[false, undefined, true, true],
	);
	assert.equal(result.details.unreadRefs, undefined);
	assert.match(
		fake.text(result),
		/^Inconclusive: the condition is not proven gone: the accessibility tree could not be read completely within 250ms\. Observe or wait again/,
	);
});

test("a present-condition wait ignores the incomplete marker", async ({ onTestFinished }) => {
	const fake = await installFakeDesktop(onTestFinished);
	const { stateId } = await fake.observe();
	fake.waitFor = async () => ({ found: false, timedOut: true, incomplete: true, nodeCount: 2000 });
	const result = await fake.call(fake.bridge.executeWaitFor, { stateId, text: "Never", timeoutMs: 250 });
	assert.equal(result.details.inconclusive, undefined);
	assert.match(fake.text(result), /^Timed out after 250ms waiting for condition\./);
});

test.for([
	{
		name: "an unread node anywhere, unscoped",
		tree: () => [wireNode("panel", "AXGroup", "Panel", UNREAD), wireButton("b1", "Other")],
		condition: {},
		unread: ["@e4"],
	},
	{
		name: "an unread scope ancestor",
		tree: () => [
			wireNode("outer", "AXGroup", "Outer", { ...UNREAD, children: [wireNode("inner", "AXGroup", "Inner")] }),
		],
		condition: { scopeRef: "@e3" },
		unread: ["@e2"],
	},
	{
		name: "an unread node inside the scope",
		tree: () => [wireNode("outer", "AXGroup", "Outer", { children: [wireNode("inner", "AXGroup", "Inner", UNREAD)] })],
		condition: { scopeRef: "@e2" },
		unread: ["@e3"],
	},
	{
		name: "an unread exact scope",
		tree: () => [wireNode("outer", "AXGroup", "Outer", UNREAD)],
		condition: { ref: "@e2" },
		unread: ["@e2"],
	},
	{
		name: "an exact scope under an ancestor whose children are unread",
		tree: () => [
			wireNode("outer", "AXGroup", "Outer", {
				...CHILDREN_UNREAD,
				children: [wireNode("inner", "AXGroup", "Inner")],
			}),
		],
		condition: { ref: "@e3" },
		unread: ["@e2"],
		asked: [["inner", "inner"]],
	},
	{
		name: "a subtree scope whose children are unread, though the helper says it is the waited element",
		tree: () => [wireNode("outer", "AXGroup", "Outer", CHILDREN_UNREAD)],
		condition: { scopeRef: "@e2" },
		unread: ["@e2"],
		same: true,
	},
	{
		// The successor binds the scope's public ref structurally: only native identity proves the waited node.
		name: "an exact scope whose children alone are unread, not proven the waited element",
		tree: () => [wireNode("outer", "AXGroup", "Outer", CHILDREN_UNREAD)],
		condition: { ref: "@e2" },
		unread: ["@e2"],
		asked: [["outer", "outer"]],
	},
	{
		name: "a protected exact scope whose children are unread, though proven the waited element",
		tree: () => [wireNode("outer", "AXGroup", "Outer", { ...CHILDREN_UNREAD, subrole: "AXSecureTextField" })],
		condition: { ref: "@e2" },
		unread: ["@e2"],
		same: true,
	},
	{
		name: "a bare truncated exact scope, though proven the waited element",
		tree: () => [wireNode("outer", "AXGroup", "Outer", UNREAD)],
		condition: { ref: "@e2" },
		unread: ["@e2"],
		same: true,
	},
	{
		name: "an exact scope whose children are unread under a bare truncated ancestor, though proven the waited element",
		tree: () => [
			wireNode("outer", "AXGroup", "Outer", {
				...UNREAD,
				children: [wireNode("inner", "AXGroup", "Inner", CHILDREN_UNREAD)],
			}),
		],
		condition: { ref: "@e3" },
		unread: ["@e2", "@e3"],
		same: true,
	},
])(
	"a helper's gone is inconclusive with $name in the successor",
	async ({ tree, condition, unread, same, asked }, { onTestFinished }) => {
		const fake = await installFakeDesktop(onTestFinished);
		fake.sameElement = async () => same === true;
		fake.tree = [wireNode("outer", "AXGroup", "Outer", { children: [wireNode("inner", "AXGroup", "Inner")] })];
		const { stateId } = await fake.observe();
		// The Windows UIA wait returns `gone` even when its walk was truncated; only the successor shows the cut.
		fake.waitFor = async () => {
			fake.tree = tree();
			return { found: true, gone: true, nodeCount: 2 };
		};
		const result = await fake.call(fake.bridge.executeWaitFor, {
			stateId,
			text: "Target",
			until: "absent",
			...condition,
		});
		assert.deepEqual(
			[result.details.found, result.details.gone, result.details.inconclusive, result.details.unreadRefs],
			[false, undefined, true, unread],
		);
		assert.match(
			fake.text(result),
			/^Inconclusive: the condition is not proven gone: \d nodes? in its scope could not be read \(@e/,
		);
		// Identity is asked only when a `childrenUnread` marker at or above an exact, readable scope is all that blocks.
		assert.deepEqual(fake.identityChecks, asked ?? []);
	},
);

test.for([
	{
		name: "an unread node outside the scope",
		tree: () => [
			wireNode("outer", "AXGroup", "Outer", { children: [wireNode("inner", "AXGroup", "Inner")] }),
			wireNode("side", "AXGroup", "Side", UNREAD),
		],
		condition: { scopeRef: "@e3" },
	},
	{
		name: "an unread child of an exact scope",
		tree: () => [wireNode("outer", "AXGroup", "Outer", { children: [wireNode("inner", "AXGroup", "Inner", UNREAD)] })],
		condition: { ref: "@e2" },
	},
	{ name: "a vanished scope", tree: () => [wireButton("b1", "Other")], condition: { scopeRef: "@e3" } },
])("a helper's gone is corroborated with $name", async ({ tree, condition }, { onTestFinished }) => {
	const fake = await installFakeDesktop(onTestFinished);
	fake.tree = [wireNode("outer", "AXGroup", "Outer", { children: [wireNode("inner", "AXGroup", "Inner")] })];
	const { stateId } = await fake.observe();
	fake.waitFor = async () => {
		fake.tree = tree();
		return { found: true, gone: true, nodeCount: 2 };
	};
	const result = await fake.call(fake.bridge.executeWaitFor, {
		stateId,
		text: "Target",
		until: "absent",
		...condition,
	});
	assert.deepEqual([result.details.found, result.details.gone, result.details.inconclusive], [true, true, undefined]);
	assert.match(fake.text(result), /^Condition disappeared\./);
});

test("a helper's gone is inconclusive while the successor still shows the condition", async ({ onTestFinished }) => {
	const fake = await installFakeDesktop(onTestFinished);
	fake.tree = [wireButton("go", "Go")];
	const { stateId } = await fake.observe();
	fake.waitFor = async () => ({ found: true, gone: true, nodeCount: 2 });
	const result = await fake.call(fake.bridge.executeWaitFor, { stateId, text: "Go", until: "absent" });
	assert.deepEqual(
		[result.details.found, result.details.inconclusive, result.details.unreadRefs],
		[false, true, undefined],
	);
	assert.match(
		fake.text(result),
		/^Inconclusive: the condition is not proven gone: the successor observation still shows the condition\./,
	);
});

/** Observe a root showing "Go", then act on it with an `absent` expectation. */
async function actExpectingAbsence(
	onTestFinished: Parameters<typeof installFakeDesktop>[0],
	waitFor: (fake: Awaited<ReturnType<typeof installFakeDesktop>>) => Promise<object>,
) {
	vi.stubEnv("PI_COMPUTER_USE_HEADLESS", "1");
	const fake = await installFakeDesktop(onTestFinished);
	fake.tree = [wireButton("go", "Go")];
	const { stateId } = await fake.observe();
	fake.actBatchResult = {
		outcome: "worked",
		performed: { delivery: "ax", transaction: true, actionCount: 1 },
		steps: [{ outcome: "worked", performed: { delivery: "ax" } }],
	};
	fake.waitFor = async () => await waitFor(fake);
	const result = await fake.call(fake.bridge.executeAct, {
		stateId,
		actions: [{ action: "press", ref: "@e2" }],
		expect: { text: "Go", until: "absent", timeoutMs: 250 },
	});
	return { fake, result, execution: result.details.execution };
}

test("act_ui keeps an incomplete absent check inconclusive instead of failed", async ({ onTestFinished }) => {
	const { fake, result, execution } = await actExpectingAbsence(onTestFinished, async (fake) => {
		fake.tree = [];
		return { found: false, timedOut: true, incomplete: true, nodeCount: 2000 };
	});
	assert.equal(execution.verification.status, "inconclusive");
	assert.equal(execution.outcome, "worked", "an unproven absence neither confirms nor refutes delivery");
	assert.deepEqual(execution.error, {
		code: "postcondition_inconclusive",
		message:
			"The action was delivered, but its absent postcondition is not proven: the accessibility tree could not be read completely within 250ms.",
	});
	assert.equal(fake.looks.length, 2, "the successor state is still captured");
	assert.ok(result.details.capture.stateId);
});

test.for([
	{
		name: "an unread successor",
		tree: () => [wireNode("panel", "AXGroup", "Panel", UNREAD)],
		reason: "1 node in its scope could not be read (@e3)",
	},
	{
		name: "a successor that still shows it",
		tree: () => [wireButton("go", "Go")],
		reason: "the successor observation still shows the condition",
	},
])("act_ui keeps a helper's gone inconclusive with $name", async ({ tree, reason }, { onTestFinished }) => {
	const { execution } = await actExpectingAbsence(onTestFinished, async (fake) => {
		fake.tree = tree();
		return { found: true, gone: true, nodeCount: 1 };
	});
	assert.equal(execution.verification.status, "inconclusive");
	assert.equal(execution.outcome, "worked");
	assert.equal(execution.error.code, "postcondition_inconclusive");
	assert.equal(
		execution.error.message,
		`The action was delivered, but its absent postcondition is not proven: ${reason}.`,
	);
});

test("act_ui keeps a corroborated absence verified", async ({ onTestFinished }) => {
	const { execution } = await actExpectingAbsence(onTestFinished, async (fake) => {
		fake.tree = [wireButton("b1", "Other")];
		return { found: true, gone: true, nodeCount: 1 };
	});
	assert.equal(execution.verification.status, "verified");
	assert.equal(execution.error, undefined);
});

test("a proven closure verifies an absence the helper could not confirm", async ({ onTestFinished }) => {
	const { result, execution } = await actExpectingAbsence(onTestFinished, async (fake) => {
		fake.listRootsHook = () => [];
		fake.lookPayload = () => {
			throw new Error("capture failed");
		};
		return { found: false, timedOut: true, incomplete: true, nodeCount: 2000 };
	});
	assert.equal(result.details.status, "target_closed");
	assert.equal(execution.verification.status, "verified");
	assert.equal(execution.outcome, "worked");
	assert.equal(execution.error, undefined, "the closure settles the inconclusive check");
});

test("a proven closure keeps a helper-verified absence verified", async ({ onTestFinished }) => {
	const { result, execution } = await actExpectingAbsence(onTestFinished, async (fake) => {
		fake.listRootsHook = () => [];
		fake.lookPayload = () => {
			throw new Error("capture failed");
		};
		return { found: true, gone: true, nodeCount: 1 };
	});
	assert.equal(result.details.status, "target_closed");
	assert.equal(execution.verification.status, "verified");
	assert.equal(execution.error, undefined);
});

test.for([
	{
		name: "a window of the same helper session sharing its window id",
		left: { kind: "window", ref: "wab12-1", title: "Main" },
		status: "target_closed",
	},
	{
		name: "a window of a restarted helper with its window id",
		left: { kind: "window", ref: "wcd34-1", title: "Main" },
		status: "target_closed",
	},
	{
		name: "another sheet of the same helper session sharing its window id",
		left: { kind: "sheet", ref: "wab12-3", title: "Save" },
		status: "target_closed",
	},
	{
		name: "the same sheet listed by a restarted helper",
		left: { kind: "sheet", ref: "wcd34-2", title: "Save" },
		status: "post_action_observation_failed",
	},
] as const)(
	"the closure probe of a sheet with its own native ref reads $name",
	async ({ left, status }, { onTestFinished }) => {
		// An older helper gave a sheet without a CG window of its own its window's id (#1287): a window carrying it is
		// another root, before or after a helper restart; only a sheet re-identifies the saved sheet across one.
		vi.stubEnv("PI_COMPUTER_USE_HEADLESS", "1");
		const sheet = desktopRoot({
			kind: "sheet",
			rootRef: "wab12-2",
			windowRef: "wab12-2",
			windowId: 100,
			title: "Save",
		});
		const listed = desktopRoot({
			kind: left.kind,
			rootRef: left.ref,
			windowRef: left.ref,
			windowId: 100,
			title: left.title,
		});
		const fake = await installFakeDesktop(onTestFinished, { roots: [sheet] });
		fake.tree = [wireButton("go", "Go")];
		const { stateId } = await fake.observe();
		fake.actBatchResult = {
			outcome: "worked",
			performed: { delivery: "ax", transaction: true, actionCount: 1 },
			steps: [{ outcome: "worked", performed: { delivery: "ax" } }],
		};
		fake.waitFor = async () => {
			fake.listRootsHook = () => [listed];
			fake.lookPayload = () => {
				throw new Error("capture failed");
			};
			return { found: false, timedOut: true, incomplete: true, nodeCount: 2000 };
		};
		const result = await fake.call(fake.bridge.executeAct, {
			stateId,
			actions: [{ action: "press", ref: "@e2" }],
			expect: { text: "Go", until: "absent", timeoutMs: 250 },
		});
		assert.equal(result.details.status, status);
	},
);

test("a saved sheet never re-resolves as a restarted helper's window with its window id", async ({
	onTestFinished,
}) => {
	// The saved state keeps the root's kind: after a restart only the window carries the shared legacy id (#1287).
	vi.stubEnv("PI_COMPUTER_USE_HEADLESS", "1");
	const sheet = desktopRoot({ kind: "sheet", rootRef: "wab12-2", windowRef: "wab12-2", windowId: 100, title: "Save" });
	const fake = await installFakeDesktop(onTestFinished, { roots: [sheet] });
	fake.tree = [wireButton("go", "Go")];
	const { stateId } = await fake.observe();
	fake.listRootsHook = () => [desktopRoot({ rootRef: "wcd34-1", windowRef: "wcd34-1", windowId: 100, title: "Main" })];
	await expect(
		fake.call(fake.bridge.executeAct, { stateId, actions: [{ action: "press", ref: "@e2" }] }),
	).rejects.toThrow("The current controlled window is no longer available.");
});

test("an inventory the helper could not read completely cannot close the root", async ({ onTestFinished }) => {
	// 129 roots: over the native cap, so only the positive listing answers; the authoritative probe fails closed.
	const many = Array.from({ length: 129 }, (_, index) =>
		desktopRoot({ rootRef: `ax:m${index}`, windowRef: `ax:m${index}`, windowId: 1000 + index, title: `M${index}` }),
	);
	const queries: Array<{ pid?: number; authoritative?: boolean }> = [];
	const { result, execution } = await actExpectingAbsence(onTestFinished, async (fake) => {
		fake.listRootsHook = (query: { pid?: number; authoritative?: boolean }) => {
			queries.push(query);
			if (query.authoritative) throw Object.assign(new Error("inventory incomplete"), { code: "inventory_incomplete" });
			return [...fake.roots, ...many];
		};
		fake.lookPayload = () => {
			throw new Error("capture failed");
		};
		return { found: false, timedOut: true, incomplete: true, nodeCount: 2000 };
	});
	assert.equal(result.details.status, "post_action_observation_failed");
	assert.equal(result.details.cause, undefined);
	assert.equal(execution.verification.status, "inconclusive");
	assert.equal(execution.error.code, "postcondition_inconclusive");
	assert.equal(
		(execution.rootDelta ?? []).some((delta: { change: string }) => delta.change === "closed"),
		false,
	);
	assert.ok(
		queries.length > 0 && queries.every((query) => query.authoritative === true),
		"the closure probe asks for an authoritative listing",
	);
});

test("a partial listing still resolves the existing target", async ({ onTestFinished }) => {
	const fake = await installFakeDesktop(onTestFinished);
	const many = Array.from({ length: 128 }, (_, index) =>
		desktopRoot({ rootRef: `ax:m${index}`, windowRef: `ax:m${index}`, windowId: 1000 + index, title: `M${index}` }),
	);
	fake.listRootsHook = (query: { authoritative?: boolean }) => {
		if (query.authoritative) throw Object.assign(new Error("inventory incomplete"), { code: "inventory_incomplete" });
		return partialListing([...many, ...fake.roots]);
	};
	const { stateId } = await fake.observe();
	const waited = await fake.call(fake.bridge.executeWaitFor, { stateId, text: "Go" });
	assert.equal(waited.details.found, true, "the positive listing resolves the observed root");
	assert.equal(fake.looks.at(-1).target.windowId, 100);
});

test("a preexisting absence without a successor observation is inconclusive", async ({ onTestFinished }) => {
	vi.stubEnv("PI_COMPUTER_USE_HEADLESS", "1");
	const fake = await installFakeDesktop(onTestFinished);
	const { stateId } = await fake.observe();
	fake.waitFor = async () => {
		fake.lookPayload = () => {
			throw new Error("capture failed");
		};
		return { found: true, gone: true, nodeCount: 1 };
	};
	const result = await fake.call(fake.bridge.executeAct, {
		stateId,
		actions: [{ action: "press", ref: "@e2" }],
		expect: { text: "Never shown", until: "absent", timeoutMs: 250 },
	});
	assert.equal(result.details.status, "post_action_observation_failed");
	assert.equal(result.details.execution.verification.status, "inconclusive");
	assert.equal(
		result.details.execution.error.message,
		"The action was delivered, but its absent postcondition is not proven: no successor observation could be captured.",
	);
});

test("an inconclusive gone names at most five unread refs", async ({ onTestFinished }) => {
	const fake = await installFakeDesktop(onTestFinished);
	const { stateId } = await fake.observe();
	fake.waitFor = async () => {
		fake.tree = Array.from({ length: 6 }, (_, index) => wireNode(`p${index}`, "AXGroup", `P${index}`, UNREAD));
		return { found: true, gone: true, nodeCount: 7 };
	};
	const result = await fake.call(fake.bridge.executeWaitFor, { stateId, text: "Go", until: "absent" });
	assert.equal(result.details.unreadRefs.length, 6);
	assert.match(
		fake.text(result),
		/^Inconclusive: the condition is not proven gone: 6 nodes in its scope could not be read \((@e\d+, ){5}\.\.\.\)\./,
	);
});

test("act_ui leaves a failed absent check failed without a successor corroboration check", async ({
	onTestFinished,
}) => {
	const { execution } = await actExpectingAbsence(onTestFinished, async (fake) => {
		fake.tree = [wireNode("panel", "AXGroup", "Panel", UNREAD)];
		return { found: false, timedOut: true, nodeCount: 1 };
	});
	assert.equal(execution.verification.status, "failed");
	assert.equal(execution.outcome, "didnt");
	assert.equal(execution.error.code, "postcondition_failed");
});

test("wait_for corroborates on the exact root it waited on, not a modal that opened meanwhile", async ({
	onTestFinished,
}) => {
	const fake = await installFakeDesktop(onTestFinished);
	fake.tree = [wireButton("go", "Go")];
	const { stateId } = await fake.observe();
	const modal = desktopRoot({
		kind: "dialog",
		rootRef: "ax:modal",
		windowRef: "ax:modal",
		windowId: 200,
		title: "Modal",
		zOrder: 0,
		isFocused: true,
		isModal: true,
	});
	fake.lookPayload = (request: { target: { windowId?: number } }) =>
		lookPayload({
			lookId: `look-${request.target.windowId}`,
			// The modal's complete outline lacks the condition; the waited root still shows it.
			children: request.target.windowId === 200 ? [wireButton("ok", "OK")] : [wireButton("go", "Go")],
			window: { windowId: request.target.windowId ?? 0 },
		});
	fake.waitFor = async () => {
		fake.roots = [{ ...fake.roots[0], isFocused: false }, modal];
		return { found: true, gone: true, complete: true, nodeCount: 2 };
	};
	const result = await fake.call(fake.bridge.executeWaitFor, { stateId, text: "Go", until: "absent" });
	assert.equal(fake.looks.at(-1).target.windowId, 100, "the successor observes the waited root");
	assert.deepEqual([result.details.found, result.details.gone, result.details.inconclusive], [false, undefined, true]);
	assert.match(fake.text(result), /the successor observation still shows the condition/);
});

test("wait_for keeps a claimed absence inconclusive when its root cannot be observed afterward", async ({
	onTestFinished,
}) => {
	const fake = await installFakeDesktop(onTestFinished);
	fake.tree = [wireButton("go", "Go")];
	const { stateId } = await fake.observe();
	for (const reply of [
		{ found: true, gone: true, complete: true, nodeCount: 2 },
		{ found: false, timedOut: true, incomplete: true, nodeCount: 2000 },
	]) {
		fake.lookPayload = () => {
			throw new Error("capture failed");
		};
		fake.waitFor = async () => reply;
		const result = await fake.call(fake.bridge.executeWaitFor, { stateId, text: "Go", until: "absent" });
		assert.deepEqual(
			[result.details.found, result.details.gone, result.details.inconclusive, result.details.observationError],
			[false, undefined, true, "capture failed"],
		);
		assert.equal(result.details.stateId, stateId, "no successor state is created");
		assert.equal(result.details.timedOut, reply.timedOut);
		assert.equal(result.details.nodeCount, reply.nodeCount);
		assert.equal(
			fake.text(result),
			`Inconclusive: the condition is not proven gone: its root could not be observed afterward (capture failed). No successor state was created; state ${stateId} is unchanged. Call find_roots, then observe_ui before treating it as gone.`,
		);
	}
	fake.lookPayload = () => {
		throw "look refused";
	};
	fake.waitFor = async () => ({ found: true, gone: true, complete: true });
	const bare = await fake.call(fake.bridge.executeWaitFor, { stateId, text: "Go", until: "absent" });
	assert.deepEqual(
		[bare.details.observationError, bare.details.nodeCount, bare.details.timedOut],
		["look refused", undefined, undefined],
	);
	fake.lookPayload = () => {
		throw new Error("capture failed");
	};
	// A decisive timeout or a presence wait has no absence to keep: the failed observation is the error.
	for (const [params, reply] of [
		[{ until: "absent" }, { found: false, timedOut: true, nodeCount: 2 }],
		[{}, { found: true, nodeCount: 2 }],
	] as const) {
		fake.waitFor = async () => reply;
		await assert.rejects(fake.call(fake.bridge.executeWaitFor, { stateId, text: "Go", ...params }), /capture failed/);
	}
});

test("a helper's incomplete gone names the unread successor nodes", async ({ onTestFinished }) => {
	const fake = await installFakeDesktop(onTestFinished);
	fake.tree = [wireButton("go", "Go")];
	const { stateId } = await fake.observe();
	fake.waitFor = async () => {
		fake.tree = [wireNode("panel", "AXGroup", "Panel", UNREAD)];
		return { found: false, timedOut: true, incomplete: true, nodeCount: 2000 };
	};
	const result = await fake.call(fake.bridge.executeWaitFor, { stateId, text: "Go", until: "absent", timeoutMs: 250 });
	assert.deepEqual([result.details.inconclusive, result.details.unreadRefs], [true, ["@e3"]]);
	assert.match(fake.text(result), /could not be read completely within 250ms/);
});

test("a scope that moved under fresh wire refs is not read as gone", async ({ onTestFinished }) => {
	const fake = await installFakeDesktop(onTestFinished);
	fake.tree = [
		wireNode("outer", "AXGroup", "Outer", {
			children: [wireNode("inner", "AXGroup", "Inner", { children: [wireButton("t", "Target")] })],
		}),
	];
	const { stateId } = await fake.observe();
	fake.waitFor = async () => {
		// Look-local wire refs: the same scope comes back reparented, so its ancestry key and public ref change.
		fake.tree = [
			wireNode("x1", "AXGroup", "Side", {
				children: [wireNode("x2", "AXGroup", "Inner", { children: [wireButton("x3", "Target")] })],
			}),
		];
		return { found: true, gone: true, complete: true, nodeCount: 2 };
	};
	const result = await fake.call(fake.bridge.executeWaitFor, {
		stateId,
		text: "Target",
		until: "absent",
		scopeRef: "@e3",
	});
	assert.deepEqual([result.details.found, result.details.gone, result.details.inconclusive], [false, undefined, true]);
	assert.match(
		fake.text(result),
		/^Inconclusive: the condition is not proven gone: its scope could not be matched in the successor observation, which shows the condition elsewhere\./,
	);
});

test.for([
	{ name: "a successor that still shows it", capture: true },
	{ name: "no successor observation", capture: false },
])(
	"an unproven absence after an unknown delivery stays delivery-neutral with $name",
	async ({ capture }, { onTestFinished }) => {
		vi.stubEnv("PI_COMPUTER_USE_HEADLESS", "1");
		const fake = await installFakeDesktop(onTestFinished);
		fake.tree = [wireButton("go", "Go")];
		const { stateId } = await fake.observe();
		fake.actBatchResult = {
			outcome: "unknown",
			performed: { delivery: "ax", transaction: true, actionCount: 1 },
			steps: [{ outcome: "unknown", performed: { delivery: "ax" } }],
		};
		fake.waitFor = async () => {
			if (!capture)
				fake.lookPayload = () => {
					throw new Error("capture failed");
				};
			return { found: true, gone: true, complete: true, nodeCount: 1 };
		};
		const result = await fake.call(fake.bridge.executeAct, {
			stateId,
			actions: [{ action: "press", ref: "@e2" }],
			expect: { text: "Go", until: "absent", timeoutMs: 250 },
		});
		const { execution } = result.details;
		assert.equal(execution.verification.status, "inconclusive");
		assert.equal(execution.outcome, "unknown");
		assert.deepEqual(execution.error, {
			code: "postcondition_inconclusive",
			message: `The absent postcondition is not proven: ${capture ? "the successor observation still shows the condition" : "no successor observation could be captured"}.`,
		});
		if (!capture) {
			// The agent reads the settled outcome: an unknown delivery is never claimed, and no replay is suggested.
			const text = fake.text(result);
			assert.doesNotMatch(text, /action was delivered/);
			assert.match(
				text,
				/^Delivery of the action is unknown, and its source root App1 — Main could not be observed afterward: capture failed\nNo successor state was created\. Do not replay the transaction: call find_roots, then observe_ui to check whether it took effect\.$/,
			);
		}
	},
);

test("a partial listing never substitutes a same-title window for the omitted target", async ({ onTestFinished }) => {
	const fake = await installFakeDesktop(onTestFinished);
	const { stateId } = await fake.observe();
	fake.listRootsHook = () => partialListing([lookalike()]);
	for (const call of [() => fake.observe(), () => fake.call(fake.bridge.executeWaitFor, { stateId, text: "Go" })])
		await assert.rejects(call(), (error: { code?: string; message: string }) => {
			assert.equal(error.code, "inventory_incomplete");
			assert.match(error.message, /incomplete and does not name it; it may still be open/);
			return true;
		});
	fake.listRootsHook = () => partialListing([]);
	await assert.rejects(
		fake.call(fake.bridge.executeWaitFor, { stateId, text: "Go" }),
		/The current controlled window could not be verified: the window listing was incomplete/,
	);
	assert.ok(
		fake.looks.every((look: { target: { windowId?: number } }) => look.target.windowId === 100),
		"no look reached the lookalike",
	);
	// The verified identity still resolves from a partial listing.
	fake.listRootsHook = () => partialListing([lookalike(), ...fake.roots]);
	await fake.observe();
	assert.equal(fake.looks.at(-1).target.windowId, 100);
	// A complete listing that lacks the window id still follows a unique exact title, as before.
	fake.listRootsHook = () => [lookalike()];
	await fake.observe();
	assert.equal(fake.looks.at(-1).target.windowId, 200);
});

test("observe_ui never binds a saved root ref to a same-title window from a partial listing", async ({
	onTestFinished,
}) => {
	const fake = await installFakeDesktop(onTestFinished);
	const listed = await fake.call(fake.bridge.executeFind, {});
	const root = /@r\d+/.exec(fake.text(listed))![0];
	fake.listRootsHook = () => partialListing([lookalike()]);
	await assert.rejects(fake.observe({ root }), (error: { code?: string; message: string }) => {
		assert.equal(error.code, "inventory_incomplete");
		assert.match(
			error.message,
			new RegExp(`Root ref '${root}' could not be verified: the window listing was incomplete`),
		);
		return true;
	});
	assert.equal(fake.looks.length, 0);
	// A complete listing keeps the title fallback for a root whose window id changed.
	fake.listRootsHook = () => [lookalike()];
	await fake.observe({ root });
	assert.equal(fake.looks.at(-1).target.windowId, 200);
});

test("wait_for never corroborates an absence from a same-title window", async ({ onTestFinished }) => {
	const fake = await installFakeDesktop(onTestFinished);
	fake.tree = [wireButton("go", "Go")];
	const { stateId } = await fake.observe();
	// The lookalike's complete outline lacks the condition; only the waited root could corroborate it.
	fake.lookPayload = (request: { target: { windowId?: number } }) =>
		lookPayload({
			lookId: `look-${request.target.windowId}`,
			children: request.target.windowId === 200 ? [wireButton("ok", "OK")] : [wireButton("go", "Go")],
			window: { windowId: request.target.windowId ?? 0 },
		});
	for (const [listing, reason] of [
		[() => partialListing([lookalike()]), /incomplete and does not name it/],
		[() => [lookalike()], /The current controlled window is no longer available/],
	] as const) {
		fake.listRootsHook = undefined;
		fake.waitFor = async () => {
			fake.listRootsHook = listing;
			return { found: true, gone: true, complete: true, nodeCount: 2 };
		};
		const looks = fake.looks.length;
		const result = await fake.call(fake.bridge.executeWaitFor, { stateId, text: "Go", until: "absent" });
		assert.deepEqual(
			[result.details.found, result.details.gone, result.details.inconclusive],
			[false, undefined, true],
		);
		assert.match(result.details.observationError, reason);
		assert.equal(fake.looks.length, looks, "the lookalike is never observed");
	}
});

test("a Linux exact scope sent without a truncated marker stays unread despite childrenUnread", async ({
	onTestFinished,
}) => {
	const fake = await installFakeDesktop(onTestFinished);
	fake.sameElement = async () => true;
	// Linux omits the marker on a node whose own fields it could not read; only an explicit `truncated` pairs.
	fake.parseOptions = { unmarkedNodesUnread: true };
	fake.tree = [wireNode("outer", "AXGroup", "Outer", { truncated: false })];
	const { stateId } = await fake.observe();
	fake.waitFor = async () => {
		fake.tree = [wireNode("outer", "AXGroup", "Outer", { childrenUnread: true })];
		return { found: true, gone: true, nodeCount: 1 };
	};
	const result = await fake.call(fake.bridge.executeWaitFor, {
		stateId,
		text: "Target",
		until: "absent",
		ref: "@e2",
	});
	assert.deepEqual([result.details.inconclusive, result.details.unreadRefs], [true, ["@e2"]]);
	assert.deepEqual(fake.identityChecks, [], "a bare truncated node is never exempted, so identity is not asked");
});

test("a remapped exact scope whose children alone are unread cannot corroborate a gone value", async ({
	onTestFinished,
}) => {
	const fake = await installFakeDesktop(onTestFinished);
	fake.tree = [wireNode("a", "AXButton", "Save", { value: "Go" })];
	const { stateId } = await fake.observe();
	// The wait read A's value as "Stop"; A then moved under a same-role, same-label B in its old slot and went back
	// to "Go". The successor carries A's public ref onto B, whose unread children hide A, and the helper's identity
	// check tells B from A.
	fake.sameElement = async (ref, otherRef) => ref === otherRef;
	fake.waitFor = async () => {
		fake.tree = [
			wireNode("b", "AXButton", "Save", {
				value: "Stop",
				...CHILDREN_UNREAD,
				children: [],
			}),
		];
		return { found: true, gone: true, nodeCount: 1 };
	};
	const result = await fake.call(fake.bridge.executeWaitFor, {
		stateId,
		text: "Save",
		value: "Go",
		until: "absent",
		ref: "@e2",
	});
	assert.deepEqual(
		[fake.waits.at(-1)?.request.scopeRef, result.details.gone, result.details.inconclusive, result.details.unreadRefs],
		["a", undefined, true, ["@e2"]],
	);
	assert.deepEqual(fake.identityChecks, [["a", "b"]]);
});

/** Observe `before`, then wait for `Go` to leave exact ref `ref` while the successor shows `after`. */
async function waitExactAbsence(
	fake: Awaited<ReturnType<typeof installFakeDesktop>>,
	before: object[],
	after: object[],
	ref: string,
	signal?: AbortSignal,
) {
	fake.tree = before;
	const { stateId } = await fake.observe();
	fake.waitFor = async () => {
		fake.tree = after;
		return { found: true, gone: true, nodeCount: 1 };
	};
	return await fake.call(fake.bridge.executeWaitFor, { stateId, text: "Go", until: "absent", ref }, signal);
}

test.for([
	{
		name: "its children alone are unread",
		before: () => [wireButton("go", "Go")],
		after: () => [wireButton("go", "Stop", CHILDREN_UNREAD)],
		ref: "@e2",
		asked: [["go", "go"]],
	},
	{
		// The window's budget cut leaves an ancestor `childrenUnread`; the proven scope cannot hide there (#1338).
		name: "it sits under ancestors whose children the walk cut",
		before: () => [wireNode("outer", "AXGroup", "Outer", { children: [wireButton("go", "Go")] })],
		after: () => [
			wireNode("outer", "AXGroup", "Outer", {
				...CHILDREN_UNREAD,
				children: [wireButton("go", "Stop", CHILDREN_UNREAD)],
			}),
		],
		ref: "@e3",
		asked: [["go", "go"]],
	},
])(
	"a proven exact scope corroborates a gone condition when $name",
	async ({ before, after, ref, asked }, { onTestFinished }) => {
		const fake = await installFakeDesktop(onTestFinished);
		fake.sameElement = async (wireRef, otherRef) => wireRef === otherRef;
		const result = await waitExactAbsence(fake, before(), after(), ref);
		assert.deepEqual(
			[result.details.found, result.details.gone, result.details.inconclusive, result.details.unreadRefs],
			[true, true, undefined, undefined],
		);
		assert.match(fake.text(result), /^Condition disappeared\./);
		assert.deepEqual(fake.identityChecks, asked);
	},
);

test("an exact scope whose children are unread stays inconclusive without an identity check", async ({
	onTestFinished,
}) => {
	const fake = await installFakeDesktop(onTestFinished);
	// Linux and Windows backends have no `sameElement`.
	const { currentPlatformBackend } = await import("../src/platform/index.ts");
	delete currentPlatformBackend.sameElement;
	const result = await waitExactAbsence(
		fake,
		[wireButton("go", "Go")],
		[wireButton("go", "Stop", CHILDREN_UNREAD)],
		"@e2",
	);
	assert.deepEqual([result.details.inconclusive, result.details.unreadRefs], [true, ["@e2"]]);
});

test("a failed identity check proves nothing", async ({ onTestFinished }) => {
	const fake = await installFakeDesktop(onTestFinished);
	// e.g. an older external helper: `unknown_command`.
	fake.sameElement = async () => {
		throw new Error("Unknown command 'axSameElement'");
	};
	const result = await waitExactAbsence(
		fake,
		[wireButton("go", "Go")],
		[wireButton("go", "Stop", CHILDREN_UNREAD)],
		"@e2",
	);
	assert.deepEqual([result.details.inconclusive, result.details.unreadRefs], [true, ["@e2"]]);
	assert.deepEqual(fake.identityChecks, [["go", "go"]]);
});

test("an identity check cancelled with the call rejects instead of settling", async ({ onTestFinished }) => {
	const fake = await installFakeDesktop(onTestFinished);
	const controller = new AbortController();
	fake.sameElement = async (_ref, _otherRef, options) => {
		assert.equal(options.signal, controller.signal, "the check gets the call's signal");
		controller.abort();
		throw new Error("aborted");
	};
	await expect(
		waitExactAbsence(
			fake,
			[wireButton("go", "Go")],
			[wireButton("go", "Stop", CHILDREN_UNREAD)],
			"@e2",
			controller.signal,
		),
	).rejects.toThrow("aborted");
});

test.for([
	{ name: "children-unread", marker: CHILDREN_UNREAD, same: false, status: "inconclusive" },
	{ name: "bare truncated", marker: UNREAD, same: true, status: "inconclusive" },
	{ name: "proven children-unread", marker: CHILDREN_UNREAD, same: true, status: "verified" },
])(
	"act_ui settles an exact ref absence on a $name successor node $status",
	async ({ marker, same, status }, { onTestFinished }) => {
		vi.stubEnv("PI_COMPUTER_USE_HEADLESS", "1");
		const fake = await installFakeDesktop(onTestFinished);
		fake.sameElement = async () => same;
		fake.tree = [wireButton("go", "Go")];
		const { stateId } = await fake.observe();
		fake.actBatchResult = {
			outcome: "worked",
			performed: { delivery: "ax", transaction: true, actionCount: 1 },
			steps: [{ outcome: "worked", performed: { delivery: "ax" } }],
		};
		// The node stops showing "Go" while its `AXChildren` read keeps failing; the native exact wait says `gone`.
		fake.waitFor = async () => {
			fake.tree = [wireButton("go", "Stop", marker)];
			return { found: true, gone: true, nodeCount: 1 };
		};
		const result = await fake.call(fake.bridge.executeAct, {
			stateId,
			actions: [{ action: "press", ref: "@e2" }],
			expect: { ref: "@e2", text: "Go", until: "absent", timeoutMs: 250 },
		});
		assert.equal(result.details.execution.verification.status, status);
		assert.deepEqual(fake.identityChecks, marker === UNREAD ? [] : [["go", "go"]]);
	},
);
