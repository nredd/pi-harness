// An explicitly indeterminate delivery (an AX press that may have landed, posted text its readback did not confirm)
// stops the transaction and is never settled by later observation (nredd/pi-harness#1240, #1241).
import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { installFakeDesktop, wireButton, wireNode } from "../test/support/fake-desktop.mjs";

afterEach(() => {
	vi.unstubAllEnvs();
});

const AX_UNKNOWN = {
	outcome: "unknown",
	performed: { delivery: "ax", grounding: "description" },
	evidence: { deliveryUnknown: true },
	error: { code: "ax_delivery_unknown", message: "AXPress failed (AXError -25204) and may have been delivered" },
};
const PRESS_SENTENCE =
	"Action 1 failed with an AX error after the press may have landed (ax_delivery_unknown); whether it was delivered is unknown.";
const TEXT_SENTENCE = "Action 1 posted input that its readback did not confirm; whether it was delivered is unknown.";
const twoButtons = () => [wireButton("b1", "One"), wireButton("b2", "Two")];
const pressBoth = [
	{ action: "press", ref: "@e2" },
	{ action: "press", ref: "@e3" },
];

test("an indeterminate press stops the serial transaction and keeps its error", async ({ onTestFinished }) => {
	vi.stubEnv("PI_COMPUTER_USE_HEADLESS", "0");
	const fake = await installFakeDesktop(onTestFinished, { platform: "macos" });
	fake.tree = twoButtons();
	const { stateId } = await fake.observe();
	fake.actHook = () => (fake.actCalls.length === 1 ? AX_UNKNOWN : { outcome: "worked", performed: { delivery: "ax" } });
	const result = await fake.call(fake.bridge.executeAct, {
		stateId,
		actions: pressBoth,
		expect: { text: "Done", timeoutMs: 250 },
	});
	const { execution } = result.details;
	assert.equal(fake.actCalls.length, 1, "the second press is never dispatched");
	assert.equal(fake.waits.length, 0, "no postcondition settles an indeterminate press");
	assert.equal(execution.outcome, "unknown");
	assert.equal(execution.stoppedAt, 0);
	assert.equal(execution.actionCount, 1);
	assert.deepEqual(execution.error, AX_UNKNOWN.error);
	assert.ok(fake.text(result).startsWith(`${PRESS_SENTENCE} Do not replay the transaction:`), fake.text(result));
	assert.ok(
		result.details.note.regions.some(
			(region: { detail?: string }) =>
				region.detail ===
				"acted here; delivery unknown (action 1 failed with an AX error after the press may have landed)",
		),
		JSON.stringify(result.details.note),
	);
});

test("a generic unknown does not stop the serial transaction", async ({ onTestFinished }) => {
	const fake = await installFakeDesktop(onTestFinished);
	fake.tree = twoButtons();
	const { stateId } = await fake.observe();
	fake.actResult = { outcome: "unknown", performed: { delivery: "ax" } };
	const result = await fake.call(fake.bridge.executeAct, { stateId, actions: pressBoth });
	assert.equal(fake.actCalls.length, 2);
	assert.equal(result.details.execution.stoppedAt, undefined);
	assert.ok(fake.text(result).startsWith("Executed 2 checked UI actions"), fake.text(result));
});

test("posted text with an unconfirmed readback skips the postcondition and stays unknown", async ({
	onTestFinished,
}) => {
	vi.stubEnv("PI_COMPUTER_USE_HEADLESS", "0");
	const fake = await installFakeDesktop(onTestFinished, { platform: "macos" });
	fake.tree = [wireNode("name", "AXTextField", "Name", { canSetValue: true, isTextInput: true })];
	const { stateId } = await fake.observe();
	fake.actResult = {
		outcome: "unknown",
		performed: { delivery: "pid" },
		evidence: { valueChanged: false, deliveryUnknown: true },
	};
	fake.waitFor = async () => ({ found: false, nodeCount: 2 });
	const result = await fake.call(fake.bridge.executeAct, {
		stateId,
		actions: [
			{ action: "typeText", ref: "@e2", text: "hi" },
			{ action: "keypress", ref: "@e2", keys: ["enter"] },
		],
		expect: { text: "hi", timeoutMs: 250 },
	});
	const { execution } = result.details;
	assert.equal(fake.actCalls.length, 1, "the keypress never runs after unconfirmed text");
	assert.equal(fake.waits.length, 0, "a stale postcondition cannot turn unknown into didnt");
	assert.equal(execution.outcome, "unknown");
	assert.equal(execution.error, undefined, "no postcondition_failed claims the text was delivered");
	assert.ok(fake.text(result).startsWith(`${TEXT_SENTENCE} Do not replay the transaction:`), fake.text(result));
});

test("a failed successor capture after an indeterminate press never claims delivery", async ({ onTestFinished }) => {
	const fake = await installFakeDesktop(onTestFinished);
	const { stateId } = await fake.observe();
	fake.actResult = AX_UNKNOWN;
	fake.lookPayload = () => {
		throw new Error("capture failed");
	};
	const result = await fake.call(fake.bridge.executeAct, { stateId, actions: [{ action: "press", ref: "@e2" }] });
	assert.equal(result.details.status, "post_action_observation_failed");
	assert.equal(result.details.execution.outcome, "unknown");
	assert.match(
		fake.text(result),
		/^Action 1 failed with an AX error after the press may have landed \(ax_delivery_unknown\); whether it was delivered is unknown\.\nIts source root App1 \u2014 Main could not be observed afterward: capture failed\nNo successor state was created\. Do not replay the transaction: call find_roots, then observe_ui to check whether action 1 took effect\.$/,
	);
});

test("a strict-headless batch stopped at an indeterminate press reports unknown delivery", async ({
	onTestFinished,
}) => {
	vi.stubEnv("PI_COMPUTER_USE_HEADLESS", "1");
	const fake = await installFakeDesktop(onTestFinished);
	fake.tree = twoButtons();
	const { stateId } = await fake.observe();
	fake.actBatchResult = {
		outcome: "unknown",
		performed: { transaction: true, actionCount: 1 },
		stoppedAt: 0,
		steps: [AX_UNKNOWN],
	};
	const result = await fake.call(fake.bridge.executeAct, { stateId, actions: pressBoth });
	const { execution } = result.details;
	assert.equal(execution.outcome, "unknown");
	assert.equal(execution.stoppedAt, 0);
	assert.equal(execution.error.code, "ax_delivery_unknown");
	assert.ok(fake.text(result).startsWith(`${PRESS_SENTENCE} Do not replay the transaction:`), fake.text(result));
});
