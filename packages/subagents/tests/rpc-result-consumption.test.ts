/**
 * rpc-result-consumption.test.ts — pi-tasks#62.
 *
 * An RPC-spawned background agent (pi-tasks' `TaskExecute`) is not part of any
 * join group, so it nudges the parent individually when it finishes. The caller
 * joins it on the `subagents:completed` event instead — and used to have no way
 * to say the result had been read, because `get_subagent_result`, the only
 * consuming path, is a tool the *parent model* calls, not something reachable
 * over the bus. The held notification therefore landed on top of an answer the
 * parent had already given, costing a turn to dismiss.
 *
 * `subagents:rpc:consume` closes that: it is the bus-side half of what
 * `get_subagent_result` does when it hands a result back. These tests drive the
 * real extension, so what they pin is the actual delivery path — the notification
 * fires for an unjoined agent, and does not for a consumed one.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTestTempDir } from "@nredd/pi-test-lib/temp-dir";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.ts", async () => {
	const actual = await vi.importActual<typeof import("../src/agent-runner.ts")>("../src/agent-runner.ts");
	return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.ts";
import { bootPi } from "./fixtures/boot-extension.ts";
import subagentsExtension from "./fixtures/home-extension.ts";

/** pi-subagents holds a completion notification for NUDGE_HOLD_MS (200ms). */
const PAST_THE_HOLD_MS = 400;

function ctx() {
	return {
		hasUI: false,
		ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn(), addAutocompleteProvider: vi.fn() },
		cwd: process.cwd(),
		model: undefined,
		modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
		sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
		getSystemPrompt: vi.fn(() => "parent"),
	} as any;
}

const notifications = (pi: any): unknown[] =>
	pi.sendMessage.mock.calls.filter((c: any[]) => c[0]?.customType === "subagent-notification");

describe("subagents:rpc:consume", () => {
	let tmpDir: string;
	let agentDir: string;
	let prevCwd: string;
	let prevAgentDir: string | undefined;
	let shutdown: (() => Promise<void>) | undefined;

	beforeEach(({ onTestFinished }) => {
		tmpDir = makeTestTempDir("pi-consume-", onTestFinished);
		agentDir = makeTestTempDir("pi-consume-agentdir-", onTestFinished);
		prevAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		prevCwd = process.cwd();
		mkdirSync(join(tmpDir, ".pi"), { recursive: true });
		writeFileSync(
			join(tmpDir, ".pi", "subagents.json"),
			JSON.stringify({ schedulingEnabled: false, outputTranscript: false }),
		);
		process.chdir(tmpDir);
	});

	afterEach(async () => {
		await shutdown?.();
		shutdown = undefined;
		delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
		process.chdir(prevCwd);
		if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
		vi.restoreAllMocks();
	});

	/** Boot the real extension with its RPC handlers bound, as session_start does. */
	async function boot() {
		const booted = bootPi({}, { deliverEvents: true });
		subagentsExtension(booted.pi);
		await booted.lifecycle.get("session_start")!({}, ctx());
		shutdown = () => booted.lifecycle.get("session_shutdown")!();
		return booted;
	}

	/** Spawn a background agent over the bus, the way pi-tasks' TaskExecute does. */
	async function spawnOverRpc(bus: ReturnType<typeof bootPi>["bus"], requestId: string): Promise<string> {
		let id = "";
		bus.on(`subagents:rpc:spawn:reply:${requestId}`, (reply: any) => {
			id = reply.data.id;
		});
		bus.emit("subagents:rpc:spawn", {
			requestId,
			type: "general-purpose",
			prompt: "go",
			options: { description: "task #1", isBackground: true },
		});
		await vi.waitFor(() => expect(id).toBeTruthy());
		return id;
	}

	it("notifies for an RPC-spawned agent nobody consumed", async () => {
		// The behaviour that makes the notification worth keeping: an unread result
		// is the caller's only signal that the agent finished.
		vi.mocked(runAgent).mockResolvedValue({ responseText: "TASK_EXECUTE_AGENT_OK" } as any);
		const { pi, bus } = await boot();

		await spawnOverRpc(bus, "req-spawn-1");
		await new Promise((r) => setTimeout(r, PAST_THE_HOLD_MS));

		expect(notifications(pi)).toHaveLength(1);
	});

	it("suppresses the notification once the caller consumes the result", async () => {
		vi.mocked(runAgent).mockResolvedValue({ responseText: "TASK_EXECUTE_AGENT_OK" } as any);
		const { pi, bus } = await boot();

		// Join the agent the way pi-tasks does — off the lifecycle event, not the tool.
		bus.on("subagents:completed", (data: unknown) => {
			bus.emit("subagents:rpc:consume", { requestId: "req-consume", agentId: (data as { id: string }).id });
		});

		await spawnOverRpc(bus, "req-spawn-2");
		await new Promise((r) => setTimeout(r, PAST_THE_HOLD_MS));

		expect(notifications(pi)).toEqual([]);
	});

	it("refuses to consume an agent that is still running", async () => {
		vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}) as any);
		const { bus } = await boot();

		const id = await spawnOverRpc(bus, "req-spawn-3");
		const reply = vi.fn();
		bus.on("subagents:rpc:consume:reply:req-consume-running", reply);
		bus.emit("subagents:rpc:consume", { requestId: "req-consume-running", agentId: id });

		await vi.waitFor(() => expect(reply).toHaveBeenCalled());
		expect(reply).toHaveBeenCalledWith({ success: false, error: "Agent not found or still running" });
	});

	it("reports an unknown agent rather than silently succeeding, and an owned one as owned", async () => {
		vi.mocked(runAgent).mockResolvedValue({ responseText: "TASK_EXECUTE_AGENT_OK" } as any);
		const { bus } = await boot();
		const ask = async (channel: string, agentId: string) => {
			const requestId = `req-${channel}-${agentId}`;
			const reply = vi.fn();
			bus.on(`subagents:rpc:${channel}:reply:${requestId}`, reply);
			bus.emit(`subagents:rpc:${channel}`, { requestId, agentId, message: "hi" });
			await vi.waitFor(() => expect(reply).toHaveBeenCalled());
			return reply.mock.calls[0]?.[0];
		};
		const missing = { success: false, error: "Agent not found or still running" };
		expect(await ask("consume", "no-such-agent")).toEqual(missing);

		// Settled, then handed to a parent agent: the session cannot see it, but the
		// manager holds it, so its exact id is refused as owned rather than missing.
		const id = await spawnOverRpc(bus, "req-spawn-4");
		const record = (globalThis as any)[Symbol.for("pi-subagents:manager")].getRecord(id);
		await vi.waitFor(() => expect(record.status).toBe("completed"));
		record.parentAgentId = "someone-else";
		expect(await ask("consume", id)).toEqual(missing);
		for (const channel of ["stop", "steer"])
			expect(await ask(channel, id)).toEqual({ success: false, error: "Agent is owned by another agent or workflow" });
	});
});
