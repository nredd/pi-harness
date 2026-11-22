// An `absent` condition holds only on complete evidence: a helper's `gone` needs a successor observation that
// neither shows the condition nor leaves its scope unread, or a proven closure (nredd/pi-harness#1242, #1243).
import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { outcomeAfterCheck } from "../src/actions.ts";
import { desktopRoot, installFakeDesktop, lookPayload, wireButton, wireNode } from "../test/support/fake-desktop.mjs";

afterEach(() => {
	vi.unstubAllEnvs();
});

const UNREAD = { truncated: true };

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
])(
	"a helper's gone is inconclusive with $name in the successor",
	async ({ tree, condition, unread }, { onTestFinished }) => {
		const fake = await installFakeDesktop(onTestFinished);
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
			/^Inconclusive: the condition is not proven gone: 1 node in its scope could not be read \(@e/,
		);
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
