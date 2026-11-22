// A background keyboard `didnt` is resent in the foreground only on explicit pre-delivery refusal evidence:
// `evidence.postedUnits === 0`. Anything else may already have typed the text (nredd/pi-harness#1241).
import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { canRetryInForeground, type PreparedAction } from "../src/actions.ts";
import { desktopRoot, installFakeDesktop, wireNode } from "../test/support/fake-desktop.mjs";

afterEach(() => {
	vi.unstubAllEnvs();
});

/** Pin a non-headless macOS desktop with one text field, so the case runs the same on Linux CI. */
const fakeMacDesktop = async (onTestFinished: Parameters<typeof installFakeDesktop>[0]) => {
	vi.stubEnv("PI_COMPUTER_USE_HEADLESS", "0");
	const fake = await installFakeDesktop(onTestFinished, { platform: "macos", roots: [desktopRoot({ pid: 1 })] });
	fake.tree = [wireNode("name", "AXTextField", "Name", { canSetValue: true, isTextInput: true, actions: ["AXPress"] })];
	return fake;
};

test.for([
	{ action: { action: "typeText", ref: "@e2", text: "hi" }, evidence: undefined },
	{ action: { action: "typeText", ref: "@e2", text: "hi" }, evidence: { value: "" } },
	{ action: { action: "typeText", ref: "@e2", text: "hi" }, evidence: { postedUnits: 2 } },
	{ action: { action: "keypress", ref: "@e2", keys: ["a"] }, evidence: undefined },
	{ action: { action: "keypress", ref: "@e2", keys: ["a"] }, evidence: { postedUnits: "0" } },
])(
	"a background $action.action didnt after posting is dispatched once (evidence $evidence)",
	async ({ action, evidence }, { onTestFinished }) => {
		const fake = await fakeMacDesktop(onTestFinished);
		const { stateId } = await fake.observe();
		fake.actResult = { outcome: "didnt", performed: { delivery: "pid" }, ...(evidence ? { evidence } : {}) };
		const result = await fake.call(fake.bridge.executeAct, { stateId, actions: [action] });
		assert.deepEqual(
			fake.actCalls.map((request: { policy: string }) => request.policy),
			["background"],
			"possibly-posted input is never resent in the foreground",
		);
		const [step] = result.details.execution.steps;
		assert.equal(step.escalatedToForeground, undefined);
		assert.equal(step.outcome, "didnt");
	},
);

test("a background didnt that proves nothing was posted retries once in the foreground", async ({ onTestFinished }) => {
	const fake = await fakeMacDesktop(onTestFinished);
	const { stateId } = await fake.observe();
	fake.actHook = (request: { policy: string }) =>
		request.policy === "background"
			? { outcome: "didnt", performed: { delivery: "pid" }, evidence: { postedUnits: 0 } }
			: { outcome: "worked", performed: { delivery: "hid" } };
	const result = await fake.call(fake.bridge.executeAct, {
		stateId,
		actions: [{ action: "typeText", ref: "@e2", text: "hi" }],
	});
	assert.deepEqual(
		fake.actCalls.map((request: { policy: string }) => request.policy),
		["background", "foreground"],
	);
	const [step] = result.details.execution.steps;
	assert.equal(step.escalationReason, "side_effect_free_didnt");
	assert.deepEqual(step.backgroundAttempt, {
		outcome: "didnt",
		reason: "Background input posted nothing; a foreground retry was safe.",
	});
});

test("canRetryInForeground requires zero posted units, a keyboard action and a non-headless session", () => {
	const typeText = { action: "typeText" } as PreparedAction;
	const refused = { outcome: "didnt", evidence: { postedUnits: 0 } } as const;
	assert.equal(canRetryInForeground(typeText, refused, false), true);
	assert.equal(canRetryInForeground({ action: "keypress" } as PreparedAction, refused, false), true);
	assert.equal(canRetryInForeground(typeText, refused, true), false, "strict headless never escalates");
	assert.equal(canRetryInForeground({ action: "paste" } as PreparedAction, refused, false), false);
	assert.equal(canRetryInForeground(typeText, { outcome: "unknown", evidence: { postedUnits: 0 } }, false), false);
	assert.equal(canRetryInForeground(typeText, { outcome: "didnt" }, false), false, "no evidence is not refusal");
	assert.equal(canRetryInForeground(typeText, { outcome: "didnt", evidence: { postedUnits: 1 } }, false), false);
});
