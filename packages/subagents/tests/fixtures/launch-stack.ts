import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { FakeClock } from "@nredd/pi-test-lib/clock";
import { deferred } from "@nredd/pi-test-lib/deferred";
import { expect, onTestFinished, vi } from "vitest";
import { resumeAgent, runAgent, type ToolActivity } from "../../src/agent-runner.ts";
import { CompletionOutbox } from "../../src/completion-outbox.ts";
import { createSubagentsExtension } from "../../src/index.ts";
import { SubagentScheduler } from "../../src/schedule.ts";
import { FLEET_STATE_ENTRY, FLEET_STATE_VERSION } from "../../src/ui/fleet-state.ts";
import { bootPi, ctx, flush, hermeticDir } from "./boot-extension.ts";

vi.mock("../../src/agent-runner.ts", async (original) => ({
	...(await original<typeof import("../../src/agent-runner.ts")>()),
	runAgent: vi.fn(),
	resumeAgent: vi.fn(),
}));

const WIDTH = 160;
const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	inverse: (text: string) => text,
};
const tui = { requestRender: () => {}, terminal: { columns: WIDTH, rows: 52 } };
interface Component {
	render(width: number): string[];
	handleInput?(key: string): void;
	dispose?(): void;
}

/**
 * Only the host UI and the runner boundary are doubles. Widget factories and overlay components are real.
 *
 * @param settings Extension settings layered over the characterization defaults.
 * @param registerCleanup Where the shutdown and leak checks run; a test's own `onTestFinished` by default.
 */
export async function bootLaunchStack(
	settings: Record<string, unknown> = {},
	registerCleanup: (cleanup: () => Promise<void>) => void = onTestFinished,
) {
	const env = hermeticDir({
		settings: {
			agentMentions: "direct",
			widgetMode: "all",
			fleetView: true,
			schedulingEnabled: true,
			workflowsEnabled: true,
			outputTranscript: true,
			rememberAgents: false,
			...settings,
		},
	});
	const boot = bootPi({}, { deliverEvents: true });
	const clock = new FakeClock();
	const widgets = new Map<string, Component>();
	const overlays: { component: Component; close(): void }[] = [];
	const select = vi.fn<(_title: string, choices: string[]) => Promise<string | undefined>>();
	const input = vi.fn<() => Promise<string | undefined>>();
	const context = ctx({
		cwd: env.dir,
		hasUI: true,
		isProjectTrusted: () => true,
		sessionManager: {
			...ctx().sessionManager,
			getBranch: () => [
				{ type: "custom", customType: FLEET_STATE_ENTRY, data: { version: FLEET_STATE_VERSION, collapsed: false } },
			],
		},
		ui: {
			...ctx().ui,
			select,
			input,
			onTerminalInput: () => () => {},
			getEditorText: () => "",
			setWidget: (name: string, factory?: (t: typeof tui, th: typeof theme) => Component) => {
				if (factory) widgets.set(name, factory(tui, theme));
				else widgets.delete(name);
			},
			custom: (
				factory: (t: typeof tui, th: typeof theme, kb: undefined, done: () => void) => Component,
				options?: { onHandle?: (handle: { setHidden(): void }) => void },
			) =>
				new Promise<void>((resolve) => {
					const close = () => {
						component.dispose?.();
						resolve();
					};
					const component = factory(tui, theme, undefined, resolve);
					overlays.push({ component, close });
					options?.onHandle?.({ setHidden: () => {} });
				}),
		},
	});
	const sessions = new Map<AgentSession, string>();
	const held: ReturnType<typeof deferred<void>>[] = [];
	const commands: Promise<unknown>[] = [];
	let pending: ReturnType<typeof holdAt> | undefined;
	let waitForAgents: (() => Promise<void>) | undefined;
	function closeOverlays() {
		for (const overlay of overlays.splice(0).reverse()) overlay.close();
	}
	registerCleanup(async () => {
		try {
			closeOverlays();
			for (const gate of held) gate.resolve();
			// Let completions schedule their notices before shutdown cancels those timers.
			await waitForAgents?.();
			await boot.lifecycle.get("session_shutdown")?.({ reason: "quit" }, context);
			await Promise.allSettled(commands);
			expect(clock.pending, "launch stack must cancel all fake-clock timers on shutdown").toBe(0);
		} finally {
			vi.mocked(runAgent).mockReset();
			vi.mocked(resumeAgent).mockReset();
			env.restore();
		}
	});

	// Observe the real scheduler's lifecycle call to obtain its real manager, including owned records.
	const start = vi.spyOn(SubagentScheduler.prototype, "start");
	const startup = await (async () => {
		try {
			createSubagentsExtension({ clock })(boot.pi);
			await boot.lifecycle.get("session_start")!({ type: "session_start", reason: "startup" }, context);
			const scheduler = start.mock.contexts[0];
			const call = start.mock.calls[0];
			if (!(scheduler instanceof SubagentScheduler) || !call) throw new Error("Scheduler did not bind to the session");
			return { scheduler, manager: call[2] };
		} finally {
			start.mockRestore();
		}
	})();
	const { manager, scheduler } = startup;
	waitForAgents = () => manager.waitForAll();

	/** Arm one attempt; release it explicitly so assertions run while the tool is in flight. */
	function holdAt({ turn, tool }: { turn: number; tool: string }) {
		if (pending) throw new Error("Previous launch never reached the runner");
		const release = deferred<void>();
		const started = deferred<{
			id: string;
			session: AgentSession;
			dispatchToolActivity: (activity: ToolActivity) => void;
		}>();
		held.push(release);
		const gate = { turn, tool, started, release: () => release.resolve(), released: release.promise };
		pending = gate;
		return gate;
	}

	async function runHeld(
		session: AgentSession,
		prompt: string,
		options: Parameters<typeof resumeAgent>[2],
		id: string,
	) {
		const gate = pending;
		if (!gate) throw new Error("Arm holdAt before launching an agent");
		pending = undefined;
		const messages = session.messages;
		messages.push({ role: "user", content: prompt, timestamp: clock.now() });
		options.onTurnEnd?.(gate.turn);
		messages.push({
			role: "assistant",
			content: [{ type: "toolCall", id: gate.tool, name: gate.tool, arguments: {} }],
		} as AgentSession["messages"][number]);
		// Record dispatch before the manager forwards activity to any tracker.
		const dispatchToolActivity = vi.fn(options.onToolActivity);
		dispatchToolActivity({ type: "start", toolName: gate.tool });
		gate.started.resolve({ id, session, dispatchToolActivity });
		await gate.released;
		dispatchToolActivity({ type: "end", toolName: gate.tool });
	}

	vi.mocked(runAgent).mockImplementation(async (_ctx, type, prompt, options) => {
		const id = options.agentId!;
		const file = options.resumeSessionFile ?? join(env.dir, `${id}.jsonl`);
		if (!options.resumeSessionFile) writeFileSync(file, "");
		const session = {
			messages: [],
			subscribe: () => () => {},
			dispose: () => {},
			sessionManager: { getSessionFile: () => file },
			getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheWrite: 0 } }),
		} as unknown as AgentSession;
		sessions.set(session, id);
		options.onSessionCreated?.(session);
		await runHeld(session, prompt, { ...options, type }, id);
		return { responseText: "finished fixture", session, aborted: false, steered: false };
	});
	vi.mocked(resumeAgent).mockImplementation(async (session, prompt, options) => {
		await runHeld(session, prompt, options, sessions.get(session)!);
		return { text: "finished fixture", aborted: false, steered: false };
	});

	const widget = () => widgets.get("agents")?.render(WIDTH) ?? [];
	const fleet = () => widgets.get("fleet")?.render(WIDTH) ?? [];
	function renderRow(id: string) {
		const desc = manager.getRecord(id)!.description;
		const lines = widget();
		const index = lines.findIndex((line) => line.includes(desc));
		return {
			widget: index < 0 ? "" : lines.slice(index, index + 2).join("\n"),
			fleet: fleet().find((line) => line.includes(desc)) ?? "",
		};
	}
	function expectTracked(id: string, { turn, tool }: { turn: number; tool: string }) {
		const row = renderRow(id);
		expect(row.widget).toContain(`↻${turn}`);
		expect(row.widget).toContain(tool);
		expect(row.fleet).toMatch(/running/i);
	}
	function expectOwnerScoped(id: string) {
		expect(renderRow(id)).toEqual({ widget: "", fleet: "" });
		expect(registry.getRecord(id)).toBeUndefined();
	}
	function command() {
		const task: Promise<unknown> = boot.commands.get("agents").handler("", context);
		commands.push(task);
		return task;
	}
	async function openViewer(id: string, inspectWorkflow?: (lines: string[]) => void) {
		const record = manager.getRecord(id)!;
		const base = overlays.length;
		if (record.workflowId) {
			select.mockImplementationOnce(async (_title, choices) => choices.find((c) => c.startsWith("Workflows (")));
			void command();
			await flush();
			const dialog = overlays[base]!.component;
			const lines = dialog.render(WIDTH);
			expect(lines.at(-1)).toContain("c convo");
			inspectWorkflow?.(lines);
			dialog.handleInput?.("c");
		} else {
			select.mockImplementationOnce(async (_title, choices) => choices.find((c) => c.startsWith("Running agents (")));
			select.mockImplementationOnce(async (_title, choices) => choices.find((c) => c.includes(record.description)));
			void command();
		}
		await flush();
		const viewer = overlays.at(-1)!.component;
		expect(viewer.constructor.name).toBe("ConversationViewer");
		return viewer.render(WIDTH).join("\n");
	}
	async function expectUntrackedTopLevel(id: string, { tool }: { tool: string }) {
		const row = renderRow(id);
		expect(row.widget).toContain("thinking…");
		expect(row.widget).not.toContain(tool);
		expect(row.widget).not.toContain("↻");
		expect(row.fleet).toMatch(/running/i);
		expect(await openViewer(id)).toContain(`[Tool: ${tool}]`);
	}
	const registry = Reflect.get(globalThis, Symbol.for("pi-subagents:manager")) as {
		spawn: typeof manager.spawn;
		getRecord: typeof manager.getRecord;
	};
	function execute(name: string, params: object, onUpdate?: (result: unknown) => void): Promise<any> {
		return boot.tools.get(name).execute("launch-case", params, undefined, onUpdate, context);
	}
	const agent = (params: object = {}, onUpdate?: (result: unknown) => void) =>
		execute(
			"Agent",
			{
				prompt: "perform the launch characterization",
				description: "launch subject",
				subagent_type: "general-purpose",
				...params,
			},
			onUpdate,
		);
	const mention = (text: string) =>
		boot.lifecycle.get("input")!({ type: "input", text, source: "interactive" }, context);
	return {
		...boot,
		agent,
		clock,
		closeOverlays,
		command,
		context,
		execute,
		expectOwnerScoped,
		expectTracked,
		expectUntrackedTopLevel,
		fleet,
		holdAt,
		input,
		manager,
		mention,
		openViewer,
		registry,
		renderRow,
		scheduler,
		select,
		widget,
	};
}

export const heldTool = { turn: 3, tool: "inspect_fixture" };

type LaunchStack = Awaited<ReturnType<typeof bootLaunchStack>>;

/** The launch a lane's warm-up drives; `kind` names it in a hook failure. */
export interface WarmLaunch {
	kind: string;
	/** Starts the attempt against a fresh stack; settles once the tool has answered. */
	start(stack: LaunchStack): Promise<{
		isError?: boolean;
		content?: { type: string; text?: string }[];
		details?: { taskId?: string };
	}>;
}

/** A background `Agent` call, the warm-up unless the lane says otherwise. */
const agentLaunch: WarmLaunch = { kind: "Agent", start: (stack) => stack.agent({ run_in_background: true }) };

/** A one-child workflow, the launch `characterize-workflow.test.ts` warms. */
export const workflowLaunch: WarmLaunch = {
	kind: "SubagentWorkflow",
	start: (stack) =>
		stack.execute("SubagentWorkflow", {
			script: 'export const meta = { name: "warm-up", description: "launch warm-up" };\nawait agent("warm-up child");',
		}),
};

/** Under Vitest's default 10 s `hookTimeout`, so a stuck phase names itself instead of the bare hook timeout. */
const WARM_UP_DEADLINE_MS = 9_000;

/**
 * Drive one launch to the runner, let it settle and shut its stack down, for a lane's `beforeAll`.
 *
 * The first launch in a test process runs the host path cold. Measured under Bun: the workflow
 * worker's boot took ~100 ms on the first launch vs ~10 ms warm, and `char:10` ran 125-175 ms cold
 * vs 20-30 ms warm. Paying that here keeps it out of every case's 5 s timeout. The original 5 s
 * timeouts in #1245 (including `char:15`) were NOT reproduced under load, so this is a mitigation
 * of the measured cold cost, not a verified fix for them.
 *
 * A workflow is awaited to its completion notice before teardown, so the warm-up drives a run that
 * finished rather than one shutdown aborted (shutdown joins an aborted run too, #1257).
 *
 * @param launch What to warm; failures read `warm-up <kind>: <phase>`.
 */
export async function warmLaunchStack({ kind, start }: WarmLaunch = agentLaunch) {
	const cleanups: (() => Promise<void>)[] = [];
	// A run's completion notice is added only after its worker thread is down.
	const noticed = new Set<string>();
	let onNotice = () => {};
	const add = CompletionOutbox.prototype.add;
	const notices = vi.spyOn(CompletionOutbox.prototype, "add").mockImplementation(function (
		this: CompletionOutbox,
		item,
	) {
		add.call(this, item);
		for (const id of item.ids) noticed.add(id);
		onNotice();
	});
	const failed = (what: string, error: unknown) =>
		new Error(`warm-up ${kind}: ${what}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
	let stuck = "";
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expired = new Error();
	const deadline = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			expired.message = `warm-up ${kind}: ${stuck}`;
			reject(expired);
		}, WARM_UP_DEADLINE_MS);
	});
	/** Bound one phase by the shared deadline; a failure names the launch kind and the phase. */
	async function phase<T>(name: string, ifStuck: string, work: Promise<T>): Promise<T> {
		stuck = `${ifStuck} (${name})`;
		try {
			return await Promise.race([work, deadline]);
		} catch (error) {
			throw error === expired ? expired : failed(name, error);
		}
	}
	try {
		const stack = await phase(
			"booting the stack",
			"stack never booted",
			bootLaunchStack({}, (cleanup) => cleanups.push(cleanup)),
		);
		const gate = stack.holdAt(heldTool);
		const result = await phase("launching", "launch never answered", start(stack));
		if (result.isError) {
			const text = result.content?.map((part) => part.text ?? "").join("\n");
			throw new Error(`warm-up ${kind}: launch answered with error: ${text}`);
		}
		await phase("waiting for held runner", "runner never reached", expectHeld(gate));
		gate.release();
		const taskId = result.details?.taskId;
		if (taskId !== undefined) {
			const settled = new Promise<void>((resolve) => {
				onNotice = () => noticed.has(taskId) && resolve();
				onNotice();
			});
			await phase("waiting for its completion notice", "workflow never settled", settled);
		}
	} finally {
		clearTimeout(timer);
		try {
			// Unbounded by the deadline: an expired warm-up still shuts its stack down; the hook timeout bounds it.
			for (const cleanup of cleanups)
				await cleanup().catch((error: unknown) => Promise.reject(failed("tearing down", error)));
		} finally {
			notices.mockRestore();
		}
	}
}

export async function expectHeld(gate: ReturnType<LaunchStack["holdAt"]>) {
	const attempt = await gate.started.promise;
	expect(attempt.dispatchToolActivity, "runner must dispatch the held tool start").toHaveBeenCalledWith({
		type: "start",
		toolName: gate.tool,
	});
	return attempt.id;
}
