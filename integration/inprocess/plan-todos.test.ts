/** Approved plan/todo lifecycle through the real Gitlinked pair and core settlement/storage. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	createTestUiContext,
	fauxAssistantMessage,
	fauxToolCall,
	getMessageText,
	type Harness,
} from "@earendil-works/pi-coding-agent/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { isolateStackHome, loadFork, startStack } from "./support.ts";

const PLAN =
	"# Ship widgets\n\n## Work\n- Add the `alpha` module\n- Wire `beta` into the CLI\n\n## Verification\n- `make test` passes\n";
const PLAN_ROWS = [
	"[pending] #1 Add the `alpha` module [plan: Work]",
	"[pending] #2 Wire `beta` into the CLI [plan: Work]",
	"[pending] #3 `make test` passes [plan: Verification]",
];
const REPLACEMENT_PLAN =
	"# Ship widgets v2\n\n## Work\n- Replace `alpha` with `gamma`\n\n## Verification\n- `make verify-fast` passes\n";
const REPLACEMENT_ROWS = [
	"[pending] #4 Replace `alpha` with `gamma` [plan: Work]",
	"[pending] #5 `make verify-fast` passes [plan: Verification]",
];
const REPROPOSAL_CONFIRMATION = {
	mode: "reproposal_confirmation",
	questions: [
		{
			id: "confirm",
			header: "Confirm",
			question: "Re-propose the revised plan?",
			options: [
				{ label: "Anything", description: "The tool replaces this option." },
				{ label: "Else", description: "The tool replaces this option too." },
			],
		},
	],
};
const EVIDENCE = "uv run pytest tests/test_alpha.py: 3 passed";
const BATCH_EVIDENCE = "make verify-fast: 42 passed";
const DEFER_REASON = "Blocked on the upstream CLI API.";
const PREMATURE_DONE = "All done!";
const DRAFTING_REPLACEMENT = "Drafting a replacement plan.";
const CONTINUE_OLD_PLAN = "Continue the original approved plan.";
const REMINDER_TYPE = "rpiv-todo-plan-reminder";
const REMINDER_MARKER = "[rpiv-todo] Plan items were still open when this run tried to finish.";

/** Only this runner's replies, not assistant messages restored from earlier runs. */
function getAssistantTexts(h: Harness): string[] {
	return h
		.eventsOfType("message_end")
		.filter((event) => event.message.role === "assistant")
		.map((event) => getMessageText(event.message));
}

type Step = Parameters<Harness["setResponses"]>[0][number];
const echoLast: Step = (ctx) => fauxAssistantMessage(`ECHO ${getMessageText(ctx.messages.at(-1))}`);

/** A scripted call goes through pi's schema validation, tool policy and real executor. */
function call(name: string, args: Parameters<typeof fauxToolCall>[1]): Step {
	return fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
}

interface Outcome {
	args: Record<string, unknown>;
	isError: boolean;
	text: string;
}

/** Pair each settled result with the arguments actually emitted by the model. */
function outcomes(h: Harness, name: string): Outcome[] {
	const args = new Map<string, Record<string, unknown>>();
	for (const event of h.eventsOfType("tool_execution_start")) {
		if (event.toolName === name) args.set(event.toolCallId, event.args);
	}
	return h
		.eventsOfType("tool_execution_end")
		.filter((event) => event.toolName === name)
		.map((event) => ({
			args: args.get(event.toolCallId) ?? {},
			isError: event.isError,
			text: getMessageText(event.result),
		}));
}

/** Assert one particular call, rather than silently accepting the wrong number of results. */
function only(items: Outcome[]): Outcome {
	expect(items).toHaveLength(1);
	const result = items[0];
	if (!result) throw new Error("Missing tool outcome");
	return result;
}

describe("approved plan todos in one real session", () => {
	let root: string;
	let work: string;
	let factories: ExtensionFactory[];
	const live = new Set<Harness>();
	let home: Awaited<ReturnType<typeof isolateStackHome>>;
	let serial = 0;

	beforeAll(async () => {
		home = await isolateStackHome();
		root = home.root;
		factories = [await loadFork("pi-plan-mode"), await loadFork("rpiv-todo")];
	});
	afterAll(async () => {
		await home.cleanup();
	});
	afterEach(async () => {
		for (const h of live) await close(h);
	});

	/** End extension resources before disposing the session; the persisted file stays caller-owned. */
	async function close(h: Harness): Promise<void> {
		await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		h.cleanup();
		live.delete(h);
	}

	/** A file-backed session, or a fresh extension runner reopened on exactly that file. */
	async function open(file?: string, selections: (string | undefined)[] = []) {
		work = file ? work : join(root, `work-${++serial}`);
		const notifications: string[] = [];
		const offered: { title: string; options: string[] }[] = [];
		const ui = createTestUiContext({
			select: async (title, options) => {
				offered.push({ title, options });
				const choice = selections.shift();
				if (choice !== undefined) {
					const actual = options.find((option) => option === choice || option.startsWith(`${choice} `));
					if (!actual) throw new Error(`Choice '${choice}' not offered in ${JSON.stringify(options)}`);
					return actual;
				}
				return undefined;
			},
			confirm: async () => false,
			notify: (message) => notifications.push(message),
		});
		const h = await startStack({
			cwd: work,
			factories,
			mode: "rpc",
			ui,
			sessionManager: file ? SessionManager.open(file) : SessionManager.create(work, join(root, "sessions")),
			settings: { compaction: { enabled: false } },
		});
		live.add(h);
		return { h, notifications, offered };
	}

	/** Await both the prompt and any turn queued by the real approval chooser. */
	async function turn(h: Harness, steps: Step[], prompt = "go"): Promise<void> {
		h.setResponses(steps);
		await h.session.prompt(prompt);
		await h.session.waitForIdle();
		expect(h.getPendingResponseCount(), JSON.stringify({ texts: getAssistantTexts(h) })).toBe(0);
		expect(
			h.eventsOfType("message_end").filter((e) => e.message.role === "assistant" && e.message.stopReason === "error"),
		).toEqual([]);
	}

	/** Approve with the RPC chooser's canonical Implement here action. */
	async function approved(
		implementation: Step[] = [fauxAssistantMessage("Start the original implementation."), echoLast],
	) {
		const result = await open(undefined, ["Implement here"]);
		await result.h.session.prompt("/plan start");
		await turn(result.h, [call("plan_mode_complete", { plan: PLAN }), ...implementation], "make the original plan");
		expect(only(outcomes(result.h, "plan_mode_complete")).isError).toBe(false);
		return result;
	}

	it("approval seeds verbatim bullets before any todo call", async () => {
		const { h } = await approved();
		await turn(h, [call("todo", { action: "list" }), fauxAssistantMessage("Listed"), echoLast]);
		const listed = only(outcomes(h, "todo"));
		expect(listed.args).toEqual({ action: "list" });
		expect(listed.text.split("\n")).toEqual(["Plan: Ship widgets -- 3/3 plan items open", ...PLAN_ROWS]);
	});

	it("seeded plan tasks keep the evidence gate", async () => {
		const { h } = await approved([
			call("todo", { action: "list" }),
			call("todo", { action: "update", id: 1, status: "completed" }),
			call("todo", { action: "update", id: 1, status: "completed", evidence: EVIDENCE }),
			fauxAssistantMessage(PREMATURE_DONE),
			echoLast,
		]);
		const [, bare, proven] = outcomes(h, "todo");
		expect(outcomes(h, "todo")).toHaveLength(3);
		expect(bare?.text.startsWith("Error: evidence required to mark a task completed")).toBe(true);
		expect(proven?.text).toBe("Updated #1 (pending → completed)");
	});

	it("open approved work reminds once at settlement", async () => {
		const { h } = await approved([
			call("todo", { action: "list" }),
			call("todo", { action: "update", id: 1, status: "completed" }),
			call("todo", { action: "update", id: 1, status: "completed", evidence: EVIDENCE }),
			fauxAssistantMessage(PREMATURE_DONE),
			echoLast,
		]);
		const texts = getAssistantTexts(h);
		expect(texts).toContain(PREMATURE_DONE);
		const after = texts.slice(texts.indexOf(PREMATURE_DONE) + 1);
		expect(after).toHaveLength(1);
		const reminder = after[0] ?? "";
		expect(reminder.startsWith("ECHO Plan check:")).toBe(true);
		expect(reminder).toContain('the approved plan "Ship widgets" still has 2/3 items open');
		expect(reminder).toContain("Do not tell the user the work is done.");
		expect(reminder).toContain("- #2 [Work] Wire `beta` into the CLI");
		expect(reminder).toContain("- #3 [Verification] `make test` passes");
		expect(reminder).not.toContain("#1 ");
		const file = sessionFile(h);
		await close(h);
		const entries = readFileSync(file, "utf8")
			.trim()
			.split("\n")
			.map((line): Record<string, unknown> => JSON.parse(line));
		const markers = entries.filter((entry) => entry.customType === REMINDER_TYPE);
		expect(markers).toHaveLength(1);
		expect(markers[0]).toMatchObject({ content: REMINDER_MARKER, display: false });
	});

	it("approved work closes in one evidenced batch", async () => {
		const ops: Parameters<typeof fauxToolCall>[1][] = [
			{ action: "update", id: 1, status: "completed", evidence: BATCH_EVIDENCE },
			{ action: "update", id: 2, status: "deferred", reason: DEFER_REASON },
			{ action: "update", id: 3, status: "completed", evidence: BATCH_EVIDENCE },
		];
		const { h } = await approved([
			call("todo", { ops }),
			call("todo", { action: "list" }),
			fauxAssistantMessage("Closed"),
		]);
		const [batch, listed] = outcomes(h, "todo");
		expect(outcomes(h, "todo")).toHaveLength(2);
		expect(batch?.args).toEqual({ ops });
		expect(batch?.isError).toBe(false);
		expect(listed?.args).toEqual({ action: "list" });
		expect(listed?.text.split("\n")).toEqual([
			"Plan: Ship widgets -- 0/3 plan items open",
			"[completed] #1 Add the `alpha` module [plan: Work]",
			`    evidence: ${BATCH_EVIDENCE}`,
			"[deferred] #2 Wire `beta` into the CLI [plan: Work]",
			`    deferred: ${DEFER_REASON}`,
			"[completed] #3 `make test` passes [plan: Verification]",
			`    evidence: ${BATCH_EVIDENCE}`,
		]);
		const file = sessionFile(h);
		await close(h);
		const resumed = await open(file);
		await resumed.h.session.prompt("/todos");
		expect(resumed.notifications).toHaveLength(1);
		const message = resumed.notifications[0] ?? "";
		expect(message.split("\n")[0]).toBe("2 done, 1 deferred");
		expect(message).not.toContain("Pending");
		expect(message).not.toContain("In Progress");
		expect(listed?.text.split("\n")[0]).toBe("Plan: Ship widgets -- 0/3 plan items open");
		await turn(resumed.h, [call("todo", { action: "list" }), fauxAssistantMessage("Restored")]);
		expect(only(outcomes(resumed.h, "todo")).text).toBe(listed?.text);
	});

	it("replacement approval replaces old work atomically", async () => {
		const initial = await approved();
		const file = sessionFile(initial.h);
		await close(initial.h);
		const { h } = await open(file, ["Implement here"]);
		await h.session.prompt("/plan start");
		await turn(
			h,
			[
				call("plan_mode_complete", { plan: REPLACEMENT_PLAN }),
				call("todo", { action: "list" }),
				fauxAssistantMessage("Listed"),
				echoLast,
			],
			"replace the plan",
		);
		expect(only(outcomes(h, "plan_mode_complete")).isError).toBe(false);
		const listed = only(outcomes(h, "todo"));
		expect(listed.args).toEqual({ action: "list" });
		expect(listed.text.split("\n")).toEqual(["Plan: Ship widgets v2 -- 2/2 plan items open", ...REPLACEMENT_ROWS]);
	});

	it("declined replacement preserves old work", async () => {
		const initial = await approved();
		const file = sessionFile(initial.h);
		await close(initial.h);
		const { h, offered } = await open(file, ["Stay in Plan mode", undefined]);
		await h.session.prompt("/plan start");
		await turn(h, [call("plan_mode_complete", { plan: REPLACEMENT_PLAN })], "draft a replacement");
		await turn(
			h,
			[
				call("plan_mode_question", REPROPOSAL_CONFIRMATION),
				call("plan_mode_complete", { plan: REPLACEMENT_PLAN }),
				fauxAssistantMessage("Awaiting permission"),
			],
			"no, keep working on the old plan",
		);
		const question = only(outcomes(h, "plan_mode_question"));
		expect(question.args).toEqual(REPROPOSAL_CONFIRMATION);
		expect(question.text).toContain('"mode": "reproposal_confirmation"');
		expect(question.text).toContain('"reason": "cancelled"');
		expect(offered.at(-1)?.options[0]).toContain("Re-propose now");
		expect(offered.at(-1)?.options[1]).toContain("Not yet");
		expect(outcomes(h, "plan_mode_complete").map((item) => item.isError)).toEqual([false, true]);
		await close(h);
		const remaining = await open(file);
		await remaining.h.session.prompt("/plan exit");
		await turn(
			remaining.h,
			[call("todo", { action: "list" }), fauxAssistantMessage("Listed"), echoLast],
			"list the remaining work",
		);
		expect(only(outcomes(remaining.h, "todo")).text.split("\n")).toEqual([
			"Plan: Ship widgets -- 3/3 plan items open",
			...PLAN_ROWS,
		]);
	});

	it("replanning suppresses reminders across compaction and legacy restore", async () => {
		const initial = await approved();
		const file = sessionFile(initial.h);
		await close(initial.h);

		const replanning = await open(file);
		await replanning.h.session.prompt("/plan start");
		replanning.h.settingsManager.applyOverrides({
			compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 1 },
		});
		// A split turn asks for both the ordinary summary and a turn-prefix summary.
		replanning.h.setResponses([
			fauxAssistantMessage("Summary: Original plan approved; drafting its replacement."),
			fauxAssistantMessage("Turn prefix: original work remains unfinished."),
		]);
		const compaction = await replanning.h.session.compact();
		expect(compaction.summary).toContain("Summary: Original plan approved; drafting its replacement.");
		expect(compaction.summary).toContain("Turn prefix: original work remains unfinished.");
		expect(compaction.firstKeptEntryId).toBeTruthy();
		expect(replanning.h.sessionManager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		expect(replanning.h.getPendingResponseCount()).toBe(0);
		const start = getAssistantTexts(replanning.h).length;
		await turn(replanning.h, [fauxAssistantMessage(DRAFTING_REPLACEMENT)], "draft a replacement");
		expect(getAssistantTexts(replanning.h).slice(start)).toEqual([DRAFTING_REPLACEMENT]);
		await close(replanning.h);

		const exited = await open(file);
		await exited.h.session.prompt("/plan exit");
		const exitStart = getAssistantTexts(exited.h).length;
		await turn(exited.h, [fauxAssistantMessage(CONTINUE_OLD_PLAN), echoLast], "continue the original work");
		const texts = getAssistantTexts(exited.h).slice(exitStart);
		expect(texts).toHaveLength(2);
		expect(texts[0]).toBe(CONTINUE_OLD_PLAN);
		expect(texts[1]?.startsWith("ECHO Plan check:")).toBe(true);
		expect(texts[1]).toContain('the approved plan "Ship widgets" still has 3/3 items open');
		await close(exited.h);

		const listed = await open(file);
		await turn(
			listed.h,
			[call("todo", { action: "list" }), fauxAssistantMessage("Listed"), echoLast],
			"list the remaining work",
		);
		const outcome = only(outcomes(listed.h, "todo"));
		expect(outcome.args).toEqual({ action: "list" });
		expect(outcome.text.split("\n")).toEqual(["Plan: Ship widgets -- 3/3 plan items open", ...PLAN_ROWS]);
		await close(listed.h);

		// Append the historical envelope through the real file-backed manager, then reopen.
		const legacyOn = SessionManager.open(file);
		legacyOn.appendCustomEntry("plan-mode-state", { enabled: true });
		const legacyPlanning = await open(file);
		const legacyStart = getAssistantTexts(legacyPlanning.h).length;
		await turn(
			legacyPlanning.h,
			[fauxAssistantMessage(DRAFTING_REPLACEMENT)],
			"continue replanning from a legacy session",
		);
		expect(getAssistantTexts(legacyPlanning.h).slice(legacyStart)).toEqual([DRAFTING_REPLACEMENT]);
		await close(legacyPlanning.h);

		const legacyOff = SessionManager.open(file);
		legacyOff.appendCustomEntry("plan-mode-state", { enabled: false });
		const legacyNormal = await open(file);
		const normalStart = getAssistantTexts(legacyNormal.h).length;
		await turn(
			legacyNormal.h,
			[fauxAssistantMessage(CONTINUE_OLD_PLAN), echoLast],
			"continue the original work after legacy restore",
		);
		const normal = getAssistantTexts(legacyNormal.h).slice(normalStart);
		expect(normal).toHaveLength(2);
		expect(normal[0]).toBe(CONTINUE_OLD_PLAN);
		expect(normal[1]?.startsWith("ECHO Plan check:")).toBe(true);
	});

	/** File-backed storage must really have a reopenable path. */
	function sessionFile(h: Harness): string {
		const file = h.sessionManager.getSessionFile();
		if (!file) throw new Error("Expected file-backed session");
		return file;
	}
});
