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

test("a returned timeout skips the postcondition and keeps the outcome unknown", async ({ onTestFinished }) => {
	const fake = await installFakeDesktop(onTestFinished);
	const { stateId } = await fake.observe();
	fake.actResult = TIMED_OUT_STEP;
	const result = await fake.call(fake.bridge.executeAct, {
		stateId,
		actions: [{ action: "press", ref: "@e2" }],
		expect: { text: "Done", timeoutMs: 250 },
	});
	const { execution } = result.details;
	assert.equal(fake.waits.length, 0, "a passing postcondition cannot prove the timed-out step was delivered");
	assert.equal(execution.verification, undefined);
	assert.equal(execution.outcome, "unknown");
	assert.equal(execution.stoppedAt, 0);
	assert.match(fake.text(result), /^Action 1 timed out; whether it was delivered is unknown\. Do not replay/);
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
			/^Action 1 timed out; whether it was delivered is unknown\. Its source root App1 \u2014 Main closed before a successor observation could be captured\.\nNo successor state was created\. Do not replay the transaction: call find_roots, then observe_ui to check whether action 1 took effect\.$/,
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
		/^Action 1 timed out; whether it was delivered is unknown\. Its source root App1 \u2014 Main could not be observed afterward: capture failed\n/,
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
		/^Inconclusive: no matches in the part of the outline that could be read; 1 node unread \(@e2\)\. expand_ui an unread ref before concluding the element is absent\./m,
	);
	assert.doesNotMatch(fake.text(missing), /Found 0/, "an incomplete read never leads with a zero count");
	const found = await fake.call(fake.bridge.executeSearchUi, { stateId, text: "Go" });
	assert.equal(found.details.totalMatches, 1);
	assert.equal(found.details.inconclusive, undefined, "a match is evidence regardless of completeness");

	fake.tree = Array.from({ length: 6 }, (_, index) =>
		wireNode(`p${index}`, "AXGroup", `P${index}`, { truncated: true }),
	);
	const many = await fake.call(fake.bridge.executeSearchUi, {
		stateId: (await fake.observe()).stateId,
		text: "Hidden",
	});
	assert.equal(many.details.unreadRefs.length, 6);
	assert.match(fake.text(many), /6 nodes unread \(@e2, @e3, @e4, @e5, @e6, \.\.\.\)\./);

	fake.tree = [wireButton("b1", "Go")];
	const complete = await fake.observe();
	const absent = await fake.call(fake.bridge.executeSearchUi, { stateId: complete.stateId, text: "Hidden child" });
	assert.equal(absent.details.inconclusive, undefined);
	assert.equal(absent.details.unreadRefs, undefined);
	assert.match(fake.text(absent), /Found 0 outline matches; returned 0\./);
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

const timeoutError = () => Object.assign(new Error("AT-SPI2 DoAction timed out"), { code: "timeout" });
const threeButtons = () => [wireButton("b1", "One"), wireButton("b2", "Two"), wireButton("b3", "Three")];
const pressAll = [
	{ action: "press", ref: "@e2" },
	{ action: "press", ref: "@e3" },
	{ action: "press", ref: "@e4" },
];

test("a thrown semantic timeout on the first action returns a numbered unknown step", async ({ onTestFinished }) => {
	const fake = await installFakeDesktop(onTestFinished);
	fake.tree = threeButtons();
	const { stateId } = await fake.observe();
	fake.actHook = () => {
		throw timeoutError();
	};
	const result = await fake.call(fake.bridge.executeAct, { stateId, actions: pressAll });
	const { execution } = result.details;
	assert.equal(fake.actCalls.length, 1, "no later action runs after an indeterminate one");
	assert.equal(execution.outcome, "unknown");
	assert.equal(execution.stoppedAt, 0);
	assert.equal(execution.actionCount, 1);
	assert.deepEqual(execution.error, { code: "timeout", message: "AT-SPI2 DoAction timed out" });
	assert.equal(execution.steps[0].outcome, "unknown");
	assert.match(
		fake.text(result),
		/^Action 1 timed out; whether it was delivered is unknown\. Do not replay the transaction: check state [\w-]+ for whether action 1 took effect before retrying it\./,
	);
});

test.for([
	{ name: "thrown", hook: () => timeoutError() },
	{ name: "returned", hook: () => TIMED_OUT_STEP },
])(
	"a $name timeout at action 2 keeps the completed prefix and stops the transaction",
	async ({ hook }, { onTestFinished }) => {
		const fake = await installFakeDesktop(onTestFinished);
		fake.tree = threeButtons();
		const { stateId } = await fake.observe();
		fake.actHook = () => {
			if (fake.actCalls.length === 1) return { outcome: "worked", performed: { delivery: "pid" } };
			const outcome = hook();
			if (outcome instanceof Error) throw outcome;
			return outcome;
		};
		const result = await fake.call(fake.bridge.executeAct, { stateId, actions: pressAll });
		const { execution } = result.details;
		assert.equal(fake.actCalls.length, 2, "action 3 must not run and mask the unknown outcome");
		assert.equal(execution.outcome, "unknown");
		assert.equal(execution.stoppedAt, 1);
		assert.equal(execution.actionCount, 2);
		assert.deepEqual(
			execution.steps.map((step: { outcome: string }) => step.outcome),
			["worked", "unknown"],
		);
		assert.equal(execution.error.code, "timeout");
		assert.match(
			fake.text(result),
			/^Action 2 timed out; whether it was delivered is unknown\. Action 1 completed\. Do not replay the transaction:/,
		);
	},
);

test("other thrown errors still fail the act", async ({ onTestFinished }) => {
	const fake = await installFakeDesktop(onTestFinished);
	const { stateId } = await fake.observe();
	fake.actHook = () => {
		throw Object.assign(new Error("boom"), { code: "internal" });
	};
	await assert.rejects(
		fake.call(fake.bridge.executeAct, { stateId, actions: [{ action: "press", ref: "@e2" }] }),
		/boom/,
	);
});

test("saved and hydrated states keep a timed-out action's delivery unknown", async ({ onTestFinished }) => {
	const fake = await installFakeDesktop(onTestFinished);
	fake.tree = threeButtons();
	const { stateId } = await fake.observe();
	fake.actHook = () => {
		throw timeoutError();
	};
	const acted = await fake.call(fake.bridge.executeAct, { stateId, actions: [{ action: "press", ref: "@e3" }] });
	const successor = acted.details.capture.stateId;
	const unknownRegion = { status: "changed", detail: "acted here; delivery unknown (action 1 timed out)" };
	assert.ok(
		acted.details.note.regions.some(
			(region: { status: string; detail?: string }) =>
				region.status === unknownRegion.status && region.detail === unknownRegion.detail,
		),
		JSON.stringify(acted.details.note),
	);
	// A later observation replaces the current state; the follow-up call hydrates the saved successor.
	await fake.observe();
	const restored = await fake.call(fake.bridge.executeSearchUi, { stateId: successor, text: "Two" });
	assert.match(fake.text(restored), /two\s+changed\s+\(acted here; delivery unknown \(action 1 timed out\)\)/);
});

test.for([
	{ name: "[] then a failed probe", probes: ["empty", "fail"] },
	{ name: "a failed probe then []", probes: ["fail", "empty"] },
])("$name cannot prove the root closed", async ({ probes }, { onTestFinished }) => {
	vi.stubEnv("PI_COMPUTER_USE_HEADLESS", "1");
	const fake = await installFakeDesktop(onTestFinished);
	const { stateId } = await fake.observe();
	const sequence = [...probes];
	fake.lookPayload = () => {
		fake.listRootsHook = () => {
			if (sequence.shift() === "fail") throw new Error("listRoots timed out");
			return [];
		};
		throw new Error("capture failed");
	};
	const result = await fake.call(fake.bridge.executeAct, {
		stateId,
		actions: [{ action: "press", ref: "@e2" }],
		expect: { text: "Go", until: "absent", timeoutMs: 250 },
	});
	assert.equal(result.details.status, "post_action_observation_failed");
	assert.equal(result.details.execution.verification?.status, "verified", "the native wait_for verdict stands");
	assert.equal(
		(result.details.execution.rootDelta ?? []).some((delta: { change: string }) => delta.change === "closed"),
		false,
		"no closure is synthesized from a probe sequence that failed",
	);
	assert.equal(result.details.cause, undefined);
});

test("read_text on an unread node reports empty text as unread, not empty", async ({ onTestFinished }) => {
	const fake = await installFakeDesktop(onTestFinished);
	fake.tree = [wireNode("t1", "AXStaticText", "Log", { truncated: true }), wireNode("t2", "AXStaticText", "Empty")];
	const { stateId } = await fake.observe();
	const unread = await fake.call(fake.bridge.executeReadText, { stateId, ref: "@e2" });
	assert.equal(unread.details.text, "");
	assert.equal(unread.details.inconclusive, true);
	assert.match(fake.text(unread), /^\(no text read: @e2 is unread \(truncated\), so empty text is not evidence/);
	const empty = await fake.call(fake.bridge.executeReadText, { stateId, ref: "@e3" });
	assert.equal(empty.details.inconclusive, undefined);
	assert.equal(fake.text(empty), "(empty text slice)");
	fake.readTextResult = async () => ({ text: "line", offset: 0, limit: 1, totalChars: 4, hasMore: false });
	const read = await fake.call(fake.bridge.executeReadText, { stateId, ref: "@e2" });
	assert.equal(read.details.inconclusive, undefined, "text that was read is evidence");
	assert.equal(fake.text(read), "line");
});

test("a removal is unproven under any unread surviving ancestor, not only the nearest", async ({ onTestFinished }) => {
	const fake = await installFakeDesktop(onTestFinished);
	const child = wireButton("c1", "Child");
	const panel = (extra: object) =>
		wireNode("panel", "AXGroup", "Panel", {
			...extra,
			children: [wireNode("inner", "AXGroup", "Inner", { children: extra === UNREAD ? [] : [child] })],
		});
	const UNREAD = { truncated: true };
	fake.tree = [panel({}), wireButton("b1", "Go")];
	const { stateId } = await fake.observe();
	fake.tree = [panel(UNREAD), wireButton("b1", "Go")];
	const result = await fake.call(fake.bridge.executeAct, { stateId, actions: [{ action: "press", ref: "@e3" }] });
	assert.equal(result.details.view, "diff");
	assert.deepEqual(
		result.details.changes.filter((change: { type: string }) => change.type === "removed"),
		[],
	);
});

test("parseLookResponse reads an omitted marker as unread only when asked", async () => {
	const { parseLookResponse } = await import("../src/outline.ts");
	const raw = {
		lookId: "l1",
		outline: {
			ref: "w",
			role: "window",
			truncated: false,
			children: [
				{ ref: "a", role: "panel" },
				{ ref: "b", role: "panel", truncated: false },
			],
		},
	};
	const flags = (options?: { unmarkedNodesUnread: boolean }) =>
		parseLookResponse(raw, options).parsedOutline!.nodes.map((node) => node.truncated);
	assert.deepEqual(flags(), [false, false, false], "macOS and Windows keep the historic default");
	assert.deepEqual(flags({ unmarkedNodesUnread: true }), [false, true, false]);
});

test("the Linux backend reads an omitted completeness marker as unread", async ({ onTestFinished }) => {
	const { linuxHelper } = await import("../src/platform/linux/helper.ts");
	const { linuxBackend } = await import("../src/platform/linux/backend.ts");
	const command = vi.spyOn(linuxHelper, "command").mockResolvedValue({
		lookId: "l1",
		outline: { ref: "w", role: "frame", truncated: false, children: [{ ref: "a", role: "panel" }] },
	});
	onTestFinished(() => command.mockRestore());
	const look = await linuxBackend.observe({ target: { pid: 1 } });
	assert.equal(look.parsedOutline!.nodes[1].truncated, true);
});

const LINUX_PARSE = { unmarkedNodesUnread: true };
const marked = (node: ReturnType<typeof wireNode>) => ({ ...node, truncated: false });

test("a Linux node without a completeness marker keeps search, expand and diff inconclusive", async ({
	onTestFinished,
}) => {
	const fake = await installFakeDesktop(onTestFinished);
	fake.parseOptions = LINUX_PARSE;
	const child = marked(wireButton("c1", "Child"));
	fake.tree = [marked(wireNode("panel", "AXGroup", "Panel", { children: [child] })), marked(wireButton("b1", "Go"))];
	const { stateId } = await fake.observe();
	// The successor omits the panel's marker and its children.
	fake.tree = [wireNode("panel", "AXGroup", "Panel"), marked(wireButton("b1", "Go"))];
	const acted = await fake.call(fake.bridge.executeAct, { stateId, actions: [{ action: "press", ref: "@e3" }] });
	assert.deepEqual(
		acted.details.changes.filter((change: { type: string }) => change.type === "removed"),
		[],
		"diff: an unmarked parent does not prove its child removed",
	);
	const successor = acted.details.capture.stateId;
	const search = await fake.call(fake.bridge.executeSearchUi, { stateId: successor, text: "Child" });
	assert.equal(search.details.inconclusive, true, "search: an unmarked node is unread");
	assert.deepEqual(search.details.unreadRefs, ["@e2"]);
	const looks = fake.looks.length;
	const expanded = await fake.call(fake.bridge.executeExpandUi, { stateId: successor, ref: "@e2" });
	assert.equal(fake.looks.length, looks + 1, "expand: an unmarked node triggers a scoped look");
	assert.equal(expanded.details.target.truncated, true, "expand: a still-unmarked scoped root stays unread");
});

test("a batch that timed out at action 3 names the completed prefix", async ({ onTestFinished }) => {
	vi.stubEnv("PI_COMPUTER_USE_HEADLESS", "1");
	const fake = await installFakeDesktop(onTestFinished);
	fake.tree = threeButtons();
	const { stateId } = await fake.observe();
	fake.actBatchResult = {
		outcome: "unknown",
		performed: { delivery: "ax", transaction: true, actionCount: 3 },
		stoppedAt: 2,
		steps: [{ outcome: "worked" }, { outcome: "worked" }, TIMED_OUT_STEP],
	};
	const result = await fake.call(fake.bridge.executeAct, { stateId, actions: pressAll });
	assert.equal(result.details.execution.outcome, "unknown");
	assert.match(
		fake.text(result),
		/^Action 3 timed out; whether it was delivered is unknown\. Actions 1-2 completed\. Do not replay the transaction:/,
	);
});
