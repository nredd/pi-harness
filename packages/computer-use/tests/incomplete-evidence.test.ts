// Timeouts and incomplete snapshots never read as delivery, closure or absence (nredd/pi-harness#1190).
import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { currentPlatformBackend } from "../src/platform/index.ts";
import { installFakeDesktop, wireButton, wireNode } from "../test/support/fake-desktop.mjs";

afterEach(() => {
	vi.unstubAllEnvs();
});

const TIMED_OUT_STEP = {
	outcome: "unknown",
	performed: { delivery: "ax" },
	error: { code: "timeout", message: "AT-SPI2 SetText timed out" },
};

/** A native batch that stopped at its first step because that step timed out. */
const timedOutBatch = () => ({
	outcome: "unknown",
	performed: { delivery: "ax", transaction: true, actionCount: 1 },
	stoppedAt: 0,
	steps: [TIMED_OUT_STEP],
});

test("keeps timed-out batch outcome unknown when the field already held the value", async ({ onTestFinished }) => {
	vi.stubEnv("PI_COMPUTER_USE_HEADLESS", "1");
	const fake = await installFakeDesktop(onTestFinished);
	fake.tree = [wireButton("b1", "Field", { value: "typed" })];
	const { stateId } = await fake.observe();
	fake.actBatchResult = timedOutBatch();
	const result = await fake.call(fake.bridge.executeAct, {
		stateId,
		actions: [{ action: "setText", ref: "@e2", text: "typed" }],
	});
	const { execution } = result.details;
	assert.equal(execution.outcome, "unknown", "a preexisting value does not prove the timed-out step was delivered");
	assert.equal(execution.error.code, "timeout");
	assert.ok(
		fake.text(result).startsWith("Action 1 timed out; whether it was delivered is unknown."),
		fake.text(result),
	);
});

test("a timed-out step stays unknown even when a later postcondition passes", async ({ onTestFinished }) => {
	const fake = await installFakeDesktop(onTestFinished);
	const { stateId } = await fake.observe();
	fake.actResult = TIMED_OUT_STEP;
	const result = await fake.call(fake.bridge.executeAct, {
		stateId,
		actions: [{ action: "press", ref: "@e2" }],
		expect: { text: "Done", timeoutMs: 250 },
	});
	const { execution } = result.details;
	assert.equal(execution.verification.status, "verified", "the postcondition is still reported");
	assert.equal(execution.outcome, "unknown");
	assert.match(fake.text(result), /^Action 1 timed out; whether it was delivered is unknown\./);
});

test.for([
	{ until: "absent", status: "verified" },
	{ until: "present", status: "failed" },
])(
	"a timed-out step whose root closed keeps delivery unknown ($until postcondition)",
	async ({ until, status }, { onTestFinished }) => {
		vi.stubEnv("PI_COMPUTER_USE_HEADLESS", "1");
		const fake = await installFakeDesktop(onTestFinished);
		const { stateId } = await fake.observe();
		const actBatch = currentPlatformBackend.actBatch!;
		currentPlatformBackend.actBatch = async (requests, options) => {
			fake.listRootsHook = () => [];
			fake.lookPayload = () => {
				throw new Error("capture failed");
			};
			fake.actBatchResult = timedOutBatch();
			return await actBatch(requests, options);
		};
		const result = await fake.call(fake.bridge.executeAct, {
			stateId,
			actions: [{ action: "press", ref: "@e2" }],
			expect: { text: "Go", until, timeoutMs: 250 },
		});
		const { execution } = result.details;
		assert.equal(result.details.status, "target_closed");
		assert.equal(execution.verification.status, status);
		assert.equal(execution.outcome, "unknown");
		assert.equal(execution.error.code, "timeout", "the timeout is not replaced by a postcondition verdict");
		assert.match(
			fake.text(result),
			/^Whether the action was delivered is unknown \(it timed out\), and its source root App1 \u2014 Main closed/,
		);
	},
);

test("a timed-out step reports unknown delivery when its root cannot be observed", async ({ onTestFinished }) => {
	vi.stubEnv("PI_COMPUTER_USE_HEADLESS", "1");
	const fake = await installFakeDesktop(onTestFinished);
	const { stateId } = await fake.observe();
	fake.actBatchResult = timedOutBatch();
	fake.lookPayload = () => {
		throw new Error("capture failed");
	};
	const result = await fake.call(fake.bridge.executeAct, { stateId, actions: [{ action: "press", ref: "@e2" }] });
	assert.equal(result.details.status, "post_action_observation_failed");
	assert.equal(result.details.execution.outcome, "unknown");
	assert.match(
		fake.text(result),
		/^Whether the action was delivered is unknown \(it timed out\), but its source root App1 \u2014 Main could not be observed afterward: capture failed/,
	);
});

test("search_ui reports zero matches in an incomplete outline as inconclusive", async ({ onTestFinished }) => {
	const fake = await installFakeDesktop(onTestFinished);
	fake.tree = [wireNode("panel", "AXGroup", "Panel", { truncated: true }), wireButton("b1", "Go")];
	const { stateId } = await fake.observe();
	const missing = await fake.call(fake.bridge.executeSearchUi, { stateId, text: "Hidden child" });
	assert.equal(missing.details.totalMatches, 0);
	assert.equal(missing.details.inconclusive, true);
	assert.deepEqual(missing.details.unreadRefs, ["@e2"]);
	assert.match(
		fake.text(missing),
		/Found 0 outline matches; returned 0\. Inconclusive: the outline is incomplete \(unread: @e2\); expand_ui an unread ref before concluding the element is absent\./,
	);
	const found = await fake.call(fake.bridge.executeSearchUi, { stateId, text: "Go" });
	assert.equal(found.details.totalMatches, 1);
	assert.equal(found.details.inconclusive, undefined, "a match is evidence regardless of completeness");

	fake.tree = [wireButton("b1", "Go")];
	const complete = await fake.observe();
	const absent = await fake.call(fake.bridge.executeSearchUi, { stateId: complete.stateId, text: "Hidden child" });
	assert.equal(absent.details.inconclusive, undefined);
	assert.doesNotMatch(fake.text(absent), /Inconclusive/);
});

test("an unread parent in the successor does not report its children as removed", async ({ onTestFinished }) => {
	const fake = await installFakeDesktop(onTestFinished);
	const child = wireButton("c1", "Child");
	fake.tree = [wireNode("panel", "AXGroup", "Panel", { children: [child] }), wireButton("b1", "Go")];
	const { stateId } = await fake.observe();
	// The successor look could not read the panel's children.
	fake.tree = [wireNode("panel", "AXGroup", "Panel", { truncated: true }), wireButton("b1", "Go")];
	const unread = await fake.call(fake.bridge.executeAct, { stateId, actions: [{ action: "press", ref: "@e3" }] });
	assert.equal(unread.details.view, "diff");
	assert.deepEqual(
		unread.details.changes.filter((change: { type: string }) => change.type === "removed"),
		[],
		"an unread child is not proven removed",
	);

	// A complete read that lacks the child does prove its removal.
	fake.tree = [wireNode("panel", "AXGroup", "Panel", { children: [child] }), wireButton("b1", "Go")];
	const { stateId: restored } = await fake.observe();
	fake.tree = [wireNode("panel", "AXGroup", "Panel"), wireButton("b1", "Go")];
	const removed = await fake.call(fake.bridge.executeAct, {
		stateId: restored,
		actions: [{ action: "press", ref: "@e3" }],
	});
	assert.deepEqual(
		removed.details.changes.filter((change: { type: string }) => change.type === "removed"),
		[{ type: "removed", ref: "@e4", parent: "@e2" }],
	);
});

test("a scoped look that is still incomplete keeps the node unread", async ({ onTestFinished }) => {
	const fake = await installFakeDesktop(onTestFinished);
	fake.tree = [wireNode("panel", "AXGroup", "Panel", { truncated: true }), wireButton("b1", "Go")];
	const { stateId } = await fake.observe();
	const expanded = await fake.call(fake.bridge.executeExpandUi, { stateId, ref: "@e2" });
	assert.equal(fake.looks.at(-1).scopeRef, "panel", "the unread node triggers a scoped look");
	assert.equal(expanded.details.target.truncated, true, "a still-unread scoped root stays truncated");
	const inspected = await fake.call(fake.bridge.executeInspectUi, { stateId, ref: "@e2" });
	assert.match(fake.text(inspected), /annotations: truncated/);
});
