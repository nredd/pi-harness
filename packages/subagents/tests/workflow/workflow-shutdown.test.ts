/**
 * workflow-shutdown.test.ts — a workflow aborted at `session_shutdown` settles inside it (#1257).
 *
 * The engine is a double whose run settles only when the test says so, so the run's
 * completion lands exactly where the shutdown path allows it to: joined, it reaches
 * the outbox before disposal (dropped on quit, spooled on a switch); detached, it
 * armed a notice timer on the closed outbox after shutdown returned.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { FakeClock } from "@nredd/pi-test-lib/clock";
import { deferred } from "@nredd/pi-test-lib/deferred";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NOTIFICATION_HOLD_MS } from "../../src/completion-outbox.ts";
import { drainDetached } from "../../src/detached-results.ts";
import {
	createSubagentsExtension,
	WORKFLOW_ENTRY_TYPE,
	WORKFLOW_FILE_FLAG,
	WORKFLOW_SHUTDOWN_REFUSAL,
} from "../../src/index.ts";
import { runWorkflow, type WorkflowRunResult } from "../../src/workflow/runtime.ts";
import { type BootedPi, bootPi, ctx, flush, type Hermetic, hermeticDir, textOf } from "../fixtures/boot-extension.ts";

vi.mock("../../src/workflow/runtime.ts", async (original) => ({
	...(await original<typeof import("../../src/workflow/runtime.ts")>()),
	runWorkflow: vi.fn(),
}));

const meta = { name: "held", description: "settles when the test says so" };
const script = `export const meta = ${JSON.stringify(meta)};\nawait agent("never spawned");\n`;

let hermetic: Hermetic;
let booted: BootedPi;
let clock: FakeClock;
let sessionFile: string;
let context: ReturnType<typeof ctx>;

beforeEach(() => {
	hermetic = hermeticDir({ settings: { workflowsEnabled: true, outputTranscript: false } });
	sessionFile = join(hermetic.dir, "parent.jsonl");
	context = ctx({
		cwd: hermetic.dir,
		sessionManager: { ...ctx().sessionManager, getSessionFile: () => sessionFile },
	});
	clock = new FakeClock();
});

afterEach(() => {
	vi.mocked(runWorkflow).mockReset();
	hermetic.restore();
});

/** Make the next run report `killed` only once `complete` is called, after its abort. */
function holdNextRun() {
	const aborted = deferred<void>();
	const completion = deferred<WorkflowRunResult>();
	vi.mocked(runWorkflow).mockImplementationOnce(async ({ signal }) => {
		signal!.addEventListener("abort", () => aborted.resolve(), { once: true });
		return completion.promise;
	});
	const complete = () =>
		completion.resolve({
			status: "killed",
			error: "Workflow aborted.",
			meta,
			progress: [],
			agentCount: 0,
			replayedCount: 0,
		});
	return { aborted: aborted.promise, complete };
}

async function startSession(flags: Record<string, string> = {}) {
	booted = bootPi(flags);
	createSubagentsExtension({ clock })(booted.pi);
	await booted.lifecycle.get("session_start")!({ type: "session_start", reason: "startup" }, context);
}

/** Start a held background run through the tool. */
async function startToolRun() {
	const run = holdNextRun();
	await startSession();
	const result = await booted.tools
		.get("SubagentWorkflow")
		.execute("tc-held", { script }, undefined, undefined, context);
	return { ...run, taskId: /Task ID: (\S+)/.exec(textOf(result))![1]! };
}

const notices = () =>
	booted.pi.sendMessage.mock.calls.filter((call: any[]) => call[0]?.customType === "subagent-notification");

/** Begin shutdown, let it abort the run, and report what had happened before the run settled. */
async function shutDownAcross(run: ReturnType<typeof holdNextRun>, reason: string) {
	let returned = false;
	const shutdown = booted.lifecycle.get("session_shutdown")!({ type: "session_shutdown", reason }, context).then(() => {
		returned = true;
	});
	await run.aborted;
	await flush();
	const returnedBeforeCompletion = returned;
	run.complete();
	await shutdown;
	const entriesAtReturn = booted.pi.appendEntry.mock.calls.filter((call: any[]) => call[0] === WORKFLOW_ENTRY_TYPE);
	await flush();
	return { returnedBeforeCompletion, entriesAtReturn };
}

it("joins an aborted run on quit, so its completion arms no notice timer after shutdown", async () => {
	const run = await startToolRun();

	const { returnedBeforeCompletion } = await shutDownAcross(run, "quit");

	expect(returnedBeforeCompletion, "shutdown must wait for the aborted run to settle").toBe(false);
	expect(clock.pending, "no notice timer may outlive shutdown").toBe(0);
	clock.advance(60_000);
	expect(notices()).toEqual([]);
});

it("spools an aborted run's Stopped notice on a session switch instead of sending it", async () => {
	const run = await startToolRun();

	await shutDownAcross(run, "new");

	expect(clock.pending).toBe(0);
	clock.advance(60_000);
	expect(notices()).toEqual([]);
	expect(drainDetached(sessionFile)).toEqual([
		expect.objectContaining({
			content: expect.stringContaining("<status>Stopped</status>"),
			details: expect.objectContaining({ id: run.taskId }),
		}),
	]);
});

/** Two held tool runs; shutdown aborts both, the first settles and the hold elapses before the second. */
async function shutDownAcrossTwo(reason: string) {
	const first = holdNextRun();
	const second = holdNextRun();
	await startSession();
	for (const id of ["tc-1", "tc-2"])
		await booted.tools.get("SubagentWorkflow").execute(id, { script }, undefined, undefined, context);
	const shutdown = booted.lifecycle.get("session_shutdown")!({ type: "session_shutdown", reason }, context);
	await Promise.all([first.aborted, second.aborted]);
	first.complete();
	await flush();
	clock.advance(NOTIFICATION_HOLD_MS * 2);
	const sentBeforeSecond = notices().length;
	second.complete();
	await shutdown;
	return { sentBeforeSecond };
}

it("holds a Stopped notice while shutdown waits for another run, then spools it on a switch", async () => {
	const { sentBeforeSecond } = await shutDownAcrossTwo("new");

	expect(sentBeforeSecond, "no notice may be sent into the closing session").toBe(0);
	expect(clock.pending).toBe(0);
	const [spooled, ...rest] = drainDetached(sessionFile);
	expect(rest).toEqual([]);
	expect(spooled!.content).toContain("2 background tasks finished.");
	expect(notices()).toEqual([]);
});

it("holds a Stopped notice while shutdown waits for another run, then drops it on quit", async () => {
	const { sentBeforeSecond } = await shutDownAcrossTwo("quit");

	expect(sentBeforeSecond).toBe(0);
	clock.advance(60_000);
	expect(notices()).toEqual([]);
	expect(drainDetached(sessionFile)).toEqual([]);
});

it("refuses a workflow launched through the tool while shutdown waits", async () => {
	const run = await startToolRun();
	const shutdown = booted.lifecycle.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, context);
	await run.aborted;

	const late = await booted.tools.get("SubagentWorkflow").execute("tc-late", { script }, undefined, undefined, context);
	run.complete();
	await shutdown;

	expect(textOf(late)).toBe(WORKFLOW_SHUTDOWN_REFUSAL);
	expect(runWorkflow).toHaveBeenCalledOnce();
	expect(clock.pending).toBe(0);
});

it("refuses a flag-launched workflow while shutdown waits", async () => {
	const flags: Record<string, string> = {};
	const run = holdNextRun();
	booted = bootPi(flags);
	createSubagentsExtension({ clock })(booted.pi);
	const start = booted.lifecycle.get("session_start")!;
	await start({ type: "session_start", reason: "startup" }, context);
	await booted.tools.get("SubagentWorkflow").execute("tc-held", { script }, undefined, undefined, context);
	const shutdown = booted.lifecycle.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, context);
	await run.aborted;

	const path = join(hermetic.dir, "flow.js");
	writeFileSync(path, script);
	flags[WORKFLOW_FILE_FLAG] = path;
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	await start({ type: "session_start", reason: "startup" }, context);
	run.complete();
	await shutdown;

	expect(warn).toHaveBeenCalledWith(`[pi-subagents] ${WORKFLOW_SHUTDOWN_REFUSAL}`);
	expect(runWorkflow).toHaveBeenCalledOnce();
	warn.mockRestore();
});

it("records a flag-launched run's outcome before shutdown returns", async () => {
	const path = join(hermetic.dir, "flow.js");
	writeFileSync(path, script);
	const run = holdNextRun();
	await startSession({ [WORKFLOW_FILE_FLAG]: path });

	const { returnedBeforeCompletion, entriesAtReturn } = await shutDownAcross(run, "quit");

	expect(returnedBeforeCompletion).toBe(false);
	expect(entriesAtReturn).toHaveLength(1);
	expect(entriesAtReturn[0]![1]).toMatchObject({ status: "killed" });
	expect(clock.pending).toBe(0);
});
