// A stopped transaction whose successor capture fails never reads as delivered (nredd/pi-harness#1281), and an
// accepted macOS `AXValue` write with a stale readback is one unknown step, never resent (nredd/pi-harness#1290).
import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { desktopRoot, installFakeDesktop, wireNode } from "../test/support/fake-desktop.mjs";

afterEach(() => {
	vi.unstubAllEnvs();
});

const press = { action: "press", ref: "@e2" };
const ROOT_LINE = "Its source root App1 \u2014 Main could not be observed afterward: capture failed";
const CHECK = "Do not replay the transaction: call find_roots, then observe_ui to check whether it took effect.";

/** A non-headless macOS fake desktop with one button, observed, whose successor capture then fails. */
async function failingCapture(onTestFinished: Parameters<typeof installFakeDesktop>[0]) {
	vi.stubEnv("PI_COMPUTER_USE_HEADLESS", "0");
	const fake = await installFakeDesktop(onTestFinished, { platform: "macos" });
	const { stateId } = await fake.observe();
	fake.lookPayload = () => {
		throw new Error("capture failed");
	};
	const act = (actions: unknown[]) => fake.call(fake.bridge.executeAct, { stateId, actions });
	return { fake, act };
}

test.for(["input_unsafe", "cancelled"])(
	"a %s thrown after a delivered step names the stop and warns against replay when the capture fails",
	async (code, { onTestFinished }) => {
		const { fake, act } = await failingCapture(onTestFinished);
		fake.actHook = () => {
			if (fake.actCalls.length === 1) return { outcome: "worked", performed: { delivery: "hid" } };
			throw Object.assign(new Error(`Refused: ${code}`), { code });
		};
		const result = await act([press, press, press]);
		assert.equal(result.details.status, "post_action_observation_failed");
		assert.equal(result.details.execution.outcome, "unknown");
		assert.equal(result.details.execution.stoppedAt, 1);
		assert.equal(
			fake.text(result),
			`Stopped at action 2 (${code}); whether the transaction was delivered is unknown. Action 1 ran before it and may have delivered input. Do not replay the transaction.\n${ROOT_LINE}\nNo successor state was created. ${CHECK}`,
		);
	},
);

test("a refusal returned on the stopped step keeps its code on the transaction and in the text", async ({
	onTestFinished,
}) => {
	const { fake, act } = await failingCapture(onTestFinished);
	const refusal = { code: "ax_write_failed", message: "AXSelectedTextRange write failed" };
	fake.actHook = () =>
		fake.actCalls.length === 1
			? { outcome: "worked", performed: { delivery: "hid" } }
			: { outcome: "didnt", performed: { delivery: "ax" }, error: refusal };
	const result = await act([press, press]);
	assert.equal(result.details.execution.stoppedAt, 1);
	assert.deepEqual(result.details.execution.error, refusal);
	assert.ok(fake.text(result).startsWith("Stopped at action 2 (ax_write_failed);"), fake.text(result));
});

test("a stop after several delivered steps names the whole prefix", async ({ onTestFinished }) => {
	const { fake, act } = await failingCapture(onTestFinished);
	fake.actHook = () =>
		fake.actCalls.length < 3
			? { outcome: "worked", performed: { delivery: "hid" } }
			: { outcome: "didnt", performed: { delivery: "ax" } };
	const text = fake.text(await act([press, press, press]));
	assert.doesNotMatch(text, /was delivered,/);
	assert.ok(
		text.startsWith(
			"Stopped at action 3; whether the transaction was delivered is unknown. Actions 1-2 ran before it and may have delivered input. Do not replay the transaction.\n",
		),
		text,
	);
});

test.for([
	{ name: "an errorless didnt", hook: () => ({ outcome: "didnt", performed: { delivery: "ax" } }), refusal: "" },
	{
		name: "a refusal with evidence",
		hook: () => {
			throw Object.assign(new Error("Refused"), { code: "input_unsafe", evidence: { held: [] } });
		},
		refusal: " (input_unsafe)",
	},
])(
	"a first-step stop by $name never claims delivery when the capture fails",
	async ({ hook, refusal }, { onTestFinished }) => {
		const { fake, act } = await failingCapture(onTestFinished);
		fake.actHook = hook;
		const result = await act([press, press]);
		assert.equal(fake.actCalls.length, 1);
		assert.equal(result.details.execution.outcome, "didnt");
		assert.equal(
			fake.text(result),
			`Stopped at action 1${refusal}: it did not take effect.\n${ROOT_LINE}\nNo successor state was created. Call find_roots, then observe_ui to continue.`,
		);
	},
);

test("a keyboard stop keeps the root observation on its own line", async ({ onTestFinished }) => {
	const { fake, act } = await failingCapture(onTestFinished);
	const { HelperCommandError } = await import("../src/platform/macos/helper.ts");
	fake.actHook = () => {
		if (fake.actCalls.length === 1) return { outcome: "worked", performed: { delivery: "pid" } };
		throw new HelperCommandError("keyboard stop fixture", "app_blocked", { postedUnits: 1 });
	};
	const text = fake.text(await act([press, { action: "keypress", ref: "@e2", keys: ["tab"] }]));
	assert.equal(
		text,
		`Stopped at action 2 (app_blocked). 1 key pair posted. Do not replay the transaction.\n${ROOT_LINE}\nNo successor state was created. ${CHECK}`,
	);
});

/** A macOS fake desktop with one settable text field, observed. */
async function textField(onTestFinished: Parameters<typeof installFakeDesktop>[0], headless: boolean) {
	vi.stubEnv("PI_COMPUTER_USE_HEADLESS", headless ? "1" : "0");
	const fake = await installFakeDesktop(onTestFinished, { platform: "macos", roots: [desktopRoot({ pid: 1 })] });
	fake.tree = [wireNode("name", "AXTextField", "Name", { canSetValue: true, isTextInput: true, value: "before" })];
	const { stateId } = await fake.observe();
	return { fake, stateId };
}

const STALE_WRITE = {
	outcome: "unknown",
	performed: { delivery: "ax", grounding: "description" },
	evidence: { deliveryUnknown: true, value: "before" },
};
const setTwice = [
	{ action: "setText", ref: "@e2", text: "new" },
	{ action: "setText", ref: "@e2", text: "other" },
];

test("an accepted AXValue write with a stale readback is dispatched once and stops the transaction", async ({
	onTestFinished,
}) => {
	const { fake, stateId } = await textField(onTestFinished, false);
	fake.actResult = STALE_WRITE;
	const result = await fake.call(fake.bridge.executeAct, { stateId, actions: setTwice });
	assert.deepEqual(
		fake.actCalls.map((request: { action: string; policy: string }) => `${request.action}:${request.policy}`),
		["setText:background"],
		"never resent in the foreground, and the next action never runs",
	);
	const { execution } = result.details;
	assert.equal(execution.outcome, "unknown");
	assert.equal(execution.stoppedAt, 0);
	assert.equal(execution.steps[0].escalatedToForeground, undefined);
	assert.match(fake.text(result), /^Action 1 posted input that its readback did not confirm; whether it was delivered/);
});

test("a strict-headless batch keeps the stale write unknown and its readback value", async ({ onTestFinished }) => {
	const { fake, stateId } = await textField(onTestFinished, true);
	fake.actBatchResult = {
		outcome: "unknown",
		performed: { delivery: "ax", transaction: true, actionCount: 1 },
		stoppedAt: 0,
		steps: [STALE_WRITE],
	};
	const result = await fake.call(fake.bridge.executeAct, { stateId, actions: setTwice });
	assert.equal(fake.actBatchCalls.length, 1);
	assert.equal(fake.actCalls.length, 0);
	const { execution } = result.details;
	assert.equal(execution.outcome, "unknown", "the observed value never upgrades the unknown write");
	assert.deepEqual(execution.steps[0].evidence, { deliveryUnknown: true, value: "before" });
});

test.for([
	{
		outcome: "didnt",
		stoppedAt: 1,
		steps: [{ outcome: "worked" }, { outcome: "didnt" }],
		stop: "Stopped at action 2; whether the transaction was delivered is unknown. Action 1 ran before it and may have delivered input.",
	},
	{
		outcome: "unknown",
		stoppedAt: 0,
		steps: [{ outcome: "unknown" }],
		stop: "Stopped at action 1; whether the transaction was delivered is unknown.",
	},
])(
	"a helper batch stopped at $stoppedAt is never settled by its own $outcome outcome",
	async ({ outcome, stoppedAt, steps, stop }, { onTestFinished }) => {
		vi.stubEnv("PI_COMPUTER_USE_HEADLESS", "1");
		const fake = await installFakeDesktop(onTestFinished, { platform: "macos" });
		const { stateId } = await fake.observe();
		fake.lookPayload = () => {
			throw new Error("capture failed");
		};
		fake.actBatchResult = {
			outcome,
			performed: { delivery: "ax", transaction: true, actionCount: steps.length },
			stoppedAt,
			steps: steps.map((step) => ({ ...step, performed: { delivery: "ax" } })),
		};
		const result = await fake.call(fake.bridge.executeAct, { stateId, actions: [press, press] });
		assert.equal(
			fake.text(result),
			`${stop} Do not replay the transaction.\n${ROOT_LINE}\nNo successor state was created. ${CHECK}`,
		);
	},
);
