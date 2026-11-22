// An `absent` condition holds only on complete evidence: a helper's `gone` needs a successor observation that
// neither shows the condition nor leaves its scope unread, or a proven closure (nredd/pi-harness#1242, #1243).
import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { outcomeAfterCheck } from "../src/actions.ts";
import { installFakeDesktop, wireButton, wireNode } from "../test/support/fake-desktop.mjs";

afterEach(() => {
	vi.unstubAllEnvs();
});

const UNREAD = { truncated: true };

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
	// The macOS helper now fails a PID-scoped listing whose window or sheet inventory was partial.
	const { result, execution } = await actExpectingAbsence(onTestFinished, async (fake) => {
		fake.listRootsHook = () => {
			throw Object.assign(new Error("inventory incomplete"), { code: "inventory_incomplete" });
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
