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
const CONTINUE = "Call find_roots, then observe_ui to continue.";

/** The replay guidance appears once, never repeated by the stop line. */
function assertOneReplayWarning(text: string) {
	assert.equal(text.match(/Do not replay/g)?.length, 1, text);
}

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
			`Stopped at action 2 (${code}); whether the transaction was delivered is unknown. Action 1 ran before it and may have delivered input.\n${ROOT_LINE}\nNo successor state was created. ${CHECK}`,
		);
		assertOneReplayWarning(fake.text(result));
	},
);

/** A non-headless macOS fake desktop with one button, observed, whose successor capture succeeds. */
async function capturing(onTestFinished: Parameters<typeof installFakeDesktop>[0]) {
	vi.stubEnv("PI_COMPUTER_USE_HEADLESS", "0");
	const fake = await installFakeDesktop(onTestFinished, { platform: "macos" });
	const { stateId } = await fake.observe();
	return { fake, act: (actions: unknown[]) => fake.call(fake.bridge.executeAct, { stateId, actions }) };
}

const SUCCESSOR_CHECK =
	/Do not replay the transaction: check state [\w-]+ for whether it took effect before retrying it\./;

test("a stop thrown after a delivered step names itself when the successor capture succeeds", async ({
	onTestFinished,
}) => {
	const { fake, act } = await capturing(onTestFinished);
	fake.actHook = () => {
		if (fake.actCalls.length === 1) return { outcome: "worked", performed: { delivery: "hid" } };
		throw Object.assign(new Error("Refused: input_unsafe"), { code: "input_unsafe" });
	};
	const result = await act([press, press, press]);
	const text = fake.text(result);
	assert.equal(result.details.execution.stoppedAt, 1);
	assert.doesNotMatch(text, /Executed \d+ checked UI action/);
	assert.ok(
		text.startsWith(
			"Stopped at action 2 (input_unsafe); whether the transaction was delivered is unknown. Action 1 ran before it and may have delivered input. Do not replay the transaction: check state ",
		),
		text,
	);
	assertOneReplayWarning(text);
});

test("an errorless didnt after a worked step names the stop when the successor capture succeeds", async ({
	onTestFinished,
}) => {
	const { fake, act } = await capturing(onTestFinished);
	fake.actHook = () =>
		fake.actCalls.length === 1
			? { outcome: "worked", performed: { delivery: "hid" } }
			: { outcome: "didnt", performed: { delivery: "ax" } };
	const result = await act([press, press, press]);
	const text = fake.text(result);
	assert.equal(fake.actCalls.length, 2, "action 3 never runs");
	assert.equal(result.details.execution.stoppedAt, 1);
	assert.doesNotMatch(text, /Executed \d+ checked UI action/);
	assert.ok(
		text.startsWith(
			"Stopped at action 2; whether the transaction was delivered is unknown. Action 1 ran before it and may have delivered input. Do not replay",
		),
		text,
	);
	assert.match(text, SUCCESSOR_CHECK);
});

test("a first-step refusal that posted nothing says a retry is safe when the successor capture succeeds", async ({
	onTestFinished,
}) => {
	const { fake, act } = await capturing(onTestFinished);
	fake.actResult = {
		outcome: "didnt",
		performed: { delivery: "ax" },
		error: { code: "ax_write_failed", message: "AXSelectedTextRange write failed" },
	};
	const text = fake.text(await act([press, press]));
	assert.match(
		text,
		/^Stopped at action 1 \(ax_write_failed\): nothing was posted, so a retry is safe\. Returned state [\w-]+\./,
	);
	assert.doesNotMatch(text, /Do not replay/);
});

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
			"Stopped at action 3; whether the transaction was delivered is unknown. Actions 1-2 ran before it and may have delivered input.\n",
		),
		text,
	);
});

test.for([
	{
		// An errorless `didnt` does not establish that nothing was posted, e.g. a scroll that saw no change.
		name: "an errorless didnt",
		hook: () => ({ outcome: "didnt", performed: { delivery: "ax" } }),
		expected: `Stopped at action 1; whether the transaction was delivered is unknown.\n${ROOT_LINE}\nNo successor state was created. ${CHECK}`,
	},
	{
		name: "a refusal with evidence",
		hook: () => {
			throw Object.assign(new Error("Refused"), { code: "input_unsafe", evidence: { held: [] } });
		},
		expected: `Stopped at action 1 (input_unsafe): nothing was posted, so a retry is safe.\n${ROOT_LINE}\nNo successor state was created. ${CONTINUE}`,
	},
	{
		name: "a keyboard refusal with zero posted units",
		hook: () => {
			throw Object.assign(new Error("Deadline"), { code: "input_deadline_expired", evidence: { postedUnits: 0 } });
		},
		expected: `Stopped at action 1 (input_deadline_expired): nothing was posted, so a retry is safe.\n${ROOT_LINE}\nNo successor state was created. ${CONTINUE}`,
	},
])(
	"a first-step stop by $name never claims delivery when the capture fails",
	async ({ hook, expected }, { onTestFinished }) => {
		const { fake, act } = await failingCapture(onTestFinished);
		fake.actHook = hook;
		const result = await act([press, press]);
		assert.equal(fake.actCalls.length, 1);
		assert.equal(result.details.execution.outcome, "didnt");
		assert.equal(fake.text(result), expected);
	},
);

test("web stale readback: posted replacement text the readback did not confirm is never called not delivered", async ({
	onTestFinished,
}) => {
	const { fake, act } = await failingCapture(onTestFinished);
	fake.actResult = {
		outcome: "unknown",
		performed: { delivery: "pid", grounding: "keyboard-events", selectionGrounding: "ax" },
		evidence: { deliveryUnknown: true, value: "before" },
	};
	const result = await act([{ action: "setText", ref: "@e2", text: "new" }, press]);
	assert.equal(fake.actCalls.length, 1);
	assert.equal(result.details.execution.outcome, "unknown");
	assert.equal(
		fake.text(result),
		`Action 1 posted input that its readback did not confirm; whether it was delivered is unknown.\n${ROOT_LINE}\nNo successor state was created. Do not replay the transaction: call find_roots, then observe_ui to check whether action 1 took effect.`,
	);
});

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
		`Stopped at action 2 (app_blocked). 1 key pair posted.\n${ROOT_LINE}\nNo successor state was created. ${CHECK}`,
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

/** The successor capture shows the requested `new` while the helper's readback stayed `before`. */
function observeNew(fake: Awaited<ReturnType<typeof installFakeDesktop>>) {
	fake.tree = [wireNode("name", "AXTextField", "Name", { canSetValue: true, isTextInput: true, value: "new" })];
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
	observeNew(fake);
	const result = await fake.call(fake.bridge.executeAct, { stateId, actions: setTwice });
	assert.deepEqual(
		fake.actCalls.map((request: { action: string; policy: string }) => `${request.action}:${request.policy}`),
		["setText:background"],
		"never resent in the foreground, and the next action never runs",
	);
	const { execution } = result.details;
	assert.equal(execution.outcome, "unknown", "the successor's requested value never upgrades the unknown write");
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
	observeNew(fake);
	const result = await fake.call(fake.bridge.executeAct, { stateId, actions: setTwice });
	assert.equal(fake.actBatchCalls.length, 1);
	assert.equal(fake.actCalls.length, 0);
	const { execution } = result.details;
	assert.equal(execution.outcome, "unknown", "the observed value never upgrades the unknown write");
	assert.deepEqual(execution.steps[0].evidence, { deliveryUnknown: true, value: "before" });
});

test("abort after accepted AX write keeps the stop text and the unknown trace on the thrown error", async ({
	onTestFinished,
}) => {
	const { fake, stateId } = await textField(onTestFinished, false);
	fake.actResult = STALE_WRITE;
	const abort = new AbortController();
	fake.lookPayload = () => {
		abort.abort();
		throw new Error("capture aborted");
	};
	await assert.rejects(
		() => fake.call(fake.bridge.executeAct, { stateId, actions: setTwice }, abort.signal),
		(error: Error & { code: string; execution: { outcome: string; stoppedAt: number } }) => {
			assert.equal(
				error.message,
				"Action 1 posted input that its readback did not confirm; whether it was delivered is unknown. The follow-up observation was aborted. Do not replay the transaction: call find_roots, then observe_ui to check whether action 1 took effect.",
			);
			assert.equal(error.code, "aborted");
			assert.equal(error.execution.outcome, "unknown");
			assert.equal(error.execution.stoppedAt, 0);
			return true;
		},
	);
	assert.equal(fake.actCalls.length, 1, "one dispatch, never resent");
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
		assert.equal(fake.text(result), `${stop}\n${ROOT_LINE}\nNo successor state was created. ${CHECK}`);
	},
);
