import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { FakeClock } from "@nredd/pi-test-lib/clock";
import { deferred } from "@nredd/pi-test-lib/deferred";
import { expect, onTestFinished, vi } from "vitest";
import { resumeAgent, runAgent } from "../../src/agent-runner.ts";
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

/** Only the host UI and the runner boundary are doubles. Widget factories and overlay components are real. */
export async function bootLaunchStack(settings: Record<string, unknown> = {}) {
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
	onTestFinished(async () => {
		try {
			for (const overlay of overlays.reverse()) overlay.close();
			for (const gate of held) gate.resolve();
			await boot.lifecycle.get("session_shutdown")?.({ reason: "quit" }, context);
			await Promise.allSettled(commands);
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

	/** Arm one attempt; release it explicitly so assertions run while the tool is in flight. */
	function holdAt({ turn, tool }: { turn: number; tool: string }) {
		if (pending) throw new Error("Previous launch never reached the runner");
		const release = deferred<void>();
		const started = deferred<{ id: string; turnMessages: AgentSession["messages"] }>();
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
		const turnStart = messages.length;
		messages.push({
			role: "assistant",
			content: [{ type: "toolCall", id: gate.tool, name: gate.tool, arguments: {} }],
		} as AgentSession["messages"][number]);
		options.onToolActivity?.({ type: "start", toolName: gate.tool });
		gate.started.resolve({ id, turnMessages: messages.slice(turnStart) });
		await gate.released;
		options.onToolActivity?.({ type: "end", toolName: gate.tool });
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
		command,
		context,
		execute,
		expectOwnerScoped,
		expectTracked,
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

export async function expectHeld(gate: ReturnType<Awaited<ReturnType<typeof bootLaunchStack>>["holdAt"]>) {
	const attempt = await gate.started.promise;
	expect(attempt.turnMessages, "runner must reach the held tool, even for untracked launches").toContainEqual(
		expect.objectContaining({
			role: "assistant",
			content: [expect.objectContaining({ type: "toolCall", name: gate.tool })],
		}),
	);
	return attempt.id;
}
