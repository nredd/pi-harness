/**
 * The real subagents lifecycle events drive todo's agent-state reducer (#444, #867): a queued resume is
 * tracked without a stale `created` winning, and an RPC spawn's wake eligibility reaches the todo notice.
 * The event-only halves stay in `packages/subagents/tests/lifecycle-identity.test.ts`.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type * as AgentRunner from "../../packages/subagents/src/agent-runner.ts";
import { formatInProgressNotice } from "../../packages/todo/plan-hooks.ts";
import { agentLookup, agentStateFor, applyAgentEvent, forgetAgents } from "../../packages/todo/state/agents.ts";

vi.mock("../../packages/subagents/src/agent-runner.ts", async () => {
	const actual = await vi.importActual<typeof AgentRunner>("../../packages/subagents/src/agent-runner.ts");
	return { ...actual, resumeAgent: vi.fn(), runAgent: vi.fn() };
});

import { resumeAgent, runAgent } from "../../packages/subagents/src/agent-runner.ts";
import { registerAgents } from "../../packages/subagents/src/agent-types.ts";
import { bootPi, ctx, flush, startSession } from "../../packages/subagents/tests/fixtures/boot-extension.ts";
import subagentsExtension from "../../packages/subagents/tests/fixtures/home-extension.ts";
import { runnerResolution } from "../../packages/subagents/tests/fixtures/runner-resolution.ts";

const PARENT = { provider: "anthropic", id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" };
const MANAGER = Symbol.for("pi-subagents:manager");

let cwd: string;
let saved: { cwd: string; agentDir?: string };

beforeEach(() => {
	saved = { cwd: process.cwd(), agentDir: process.env.PI_CODING_AGENT_DIR };
	cwd = mkdtempSync(join(tmpdir(), "todo-subagent-lifecycle-"));
	process.chdir(cwd);
	process.env.PI_CODING_AGENT_DIR = join(cwd, "agent-dir");
	mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "agents", "scout.md"), "---\ndescription: scout\ntools: read\n---\nscout.\n");
	mkdirSync(join(cwd, "agent-dir"), { recursive: true });
	vi.mocked(runAgent).mockReset();
	vi.mocked(resumeAgent).mockReset();
});

afterEach(() => {
	Reflect.deleteProperty(globalThis, MANAGER);
	process.chdir(saved.cwd);
	if (saved.agentDir == null) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = saved.agentDir;
	registerAgents(new Map());
	rmSync(cwd, { recursive: true, force: true });
});

/** A parent context whose model registry knows only the parent model. */
function parentCtx() {
	return ctx({
		model: PARENT,
		cwd,
		modelRegistry: {
			find: (provider: string, id: string) => (provider === PARENT.provider && id === PARENT.id ? PARENT : undefined),
			getAll: () => [PARENT],
			getAvailable: () => [PARENT],
		},
	});
}

async function boot() {
	const b = bootPi();
	subagentsExtension(b.pi);
	await startSession(b.lifecycle, true);
	return b;
}

const eventsNamed = (pi: ReturnType<typeof bootPi>["pi"], name: string): { id: string }[] =>
	pi.events.emit.mock.calls.filter((call: unknown[]) => call[0] === name).map((call: unknown[]) => call[1]);

const spawnId = (result: { content: { text?: string }[] }): string =>
	/Agent ID: (\S+)/.exec(result.content.map((c) => c.text ?? "").join(""))?.[1] ?? "";

it.each(["done", "failed"])(
	"tracks a queued background resume after %s without accepting a stale created",
	async (outcome) => {
		writeFileSync(join(cwd, "agent-dir", "subagents.json"), JSON.stringify({ maxConcurrent: 1 }));
		const { pi, tools } = await boot();
		pi.events.emit.mockImplementation((channel: string, data: unknown) => applyAgentEvent("resume-s1", channel, data));
		const resolve = runnerResolution();
		vi.mocked(runAgent)
			.mockImplementationOnce(async (context, type, prompt, options) => {
				const result = await resolve(context, type, prompt, options);
				if (outcome === "failed") throw new Error("first run failed");
				return result;
			})
			.mockImplementation(runnerResolution({ hold: true }));
		const spawn = (name: string) =>
			tools
				.get("Agent")
				.execute(
					"tc",
					{ prompt: "go", description: name, subagent_type: "scout", name, run_in_background: true },
					undefined,
					undefined,
					parentCtx(),
				);
		const first = await spawn("Auth Audit");
		await flush();
		const id = spawnId(first);
		expect(agentStateFor("resume-s1", "auth-audit")).toBe(outcome);
		const stale = eventsNamed(pi, "subagents:created").find((event) => event.id === id);
		pi.events.emit("subagents:created", stale);
		expect(agentStateFor("resume-s1", "auth-audit")).toBe(outcome);
		await spawn("Blocker");
		await flush();
		const before = eventsNamed(pi, "subagents:created").length;
		await tools
			.get("Agent")
			.execute(
				"resume",
				{ prompt: "again", description: "resume", subagent_type: "scout", resume: id, run_in_background: true },
				undefined,
				undefined,
				parentCtx(),
			);
		const manager = Reflect.get(globalThis, MANAGER) as { getRecord(id: string): { status: string } };
		expect(manager.getRecord(id).status).toBe("queued");
		expect(eventsNamed(pi, "subagents:created")).toHaveLength(before + 1);
		expect(agentStateFor("resume-s1", "auth-audit")).toBe("queued");
		expect(agentLookup("resume-s1").wakesParent?.("auth-audit")).toBe(true);
		forgetAgents("resume-s1");
	},
);

it.each([false, true])("classifies actual RPC completion wake eligibility: background=%s", async (isBackground) => {
	const b = bootPi();
	const handlers = new Map<string, ((data: unknown) => void)[]>();
	b.pi.events.on.mockImplementation((name: string, handler: (data: unknown) => void) => {
		handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		return () => {};
	});
	b.pi.events.emit.mockImplementation((name: string, data: unknown) => {
		applyAgentEvent("rpc-wake", name, data);
		for (const handler of handlers.get(name) ?? []) handler(data);
	});
	subagentsExtension(b.pi);
	await startSession(b.lifecycle, true, { model: PARENT, modelRegistry: parentCtx().modelRegistry });
	let finish: ((result: Awaited<ReturnType<typeof runAgent>>) => void) | undefined;
	vi.mocked(runAgent).mockImplementation((_context, _type, _prompt, options) => {
		const session = { dispose: vi.fn(), messages: [], model: PARENT };
		options?.onSessionCreated?.(session as never);
		return new Promise((resolve) => {
			finish = resolve;
		});
	});
	let id = "";
	b.pi.events.on("subagents:rpc:spawn:reply:wake", (reply: { data: { id: string } }) => {
		id = reply.data.id;
	});
	b.pi.events.emit("subagents:rpc:spawn", {
		requestId: "wake",
		type: "scout",
		prompt: "go",
		options: { description: "rpc", isBackground },
	});
	await flush();
	expect(id).not.toBe("");
	const state = { tasks: [{ id: 1, subject: "Audit", status: "in_progress", owner: id }], nextId: 2 } as never;
	const notice = formatInProgressNotice(state, agentLookup("rpc-wake"));
	finish?.({
		responseText: "done",
		session: { dispose: vi.fn(), messages: [], model: PARENT },
		aborted: false,
		steered: false,
	} as never);
	await flush();
	const manager = Reflect.get(globalThis, MANAGER) as { getRecord(id: string): { resultConsumed?: boolean } };
	expect(Boolean(manager.getRecord(id).resultConsumed)).toBe(!isBackground);
	expect(notice?.level).toBe(isBackground ? "info" : "warning");
	forgetAgents("rpc-wake");
});
