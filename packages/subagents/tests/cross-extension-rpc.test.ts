import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTestTempDir } from "@nredd/pi-test-lib/temp-dir";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRef } from "../src/agent-ref.ts";
import {
	type EventBus,
	PROTOCOL_VERSION,
	type RpcDeps,
	registerRpcHandlers,
	type SpawnCapable,
} from "../src/cross-extension-rpc.ts";
import { isScopeModelsEnabled, setScopeModelsEnabled } from "../src/model-scope.ts";
import { PLAN_MODE_STATE_QUERY, planSteerRefusal } from "../src/plan-mode-children.ts";

/** What the manager's resolver answers for `agent-42`: `state` with a record of `fields`, or a recordless state. */
function refTo(state: AgentRef["state"], fields: object = {}): AgentRef {
	const base = { requested: "agent-42", latest: "agent-42", via: "id" as const };
	const record = { id: "agent-42", ...fields } as any;
	if (state === "live" || state === "queued") return { ...base, state, record, home: "manager" };
	if (state === "retained") return { ...base, state, record, resume: { mode: "in-place" } };
	if (state === "saved") return { ...base, state, resume: { mode: "none", why: "historical" } };
	if (state === "workflow-owned") return { ...base, state, owner: { kind: "child", record } };
	return { ...base, via: "none", state };
}

/** Simple in-process event bus for testing. */
function createEventBus(): EventBus {
	const listeners = new Map<string, Set<(data: unknown) => void>>();
	return {
		on(event, handler) {
			if (!listeners.has(event)) listeners.set(event, new Set());
			listeners.get(event)!.add(handler);
			return () => {
				listeners.get(event)?.delete(handler);
			};
		},
		emit(event, data) {
			for (const handler of listeners.get(event) ?? []) handler(data);
		},
	};
}

describe("cross-extension RPC", () => {
	let events: EventBus;
	let manager: SpawnCapable;
	let ctx: object | undefined;
	let deps: RpcDeps;

	beforeEach(() => {
		events = createEventBus();
		manager = {
			spawn: vi.fn().mockReturnValue("agent-42"),
			awaitStartup: vi.fn().mockResolvedValue(undefined),
			abort: vi.fn().mockReturnValue(true),
			resolve: vi.fn().mockReturnValue(refTo("live")),
			hasRecord: vi.fn().mockReturnValue(false),
			markRead: vi.fn(),
			steer: vi.fn().mockReturnValue(true),
		};
		ctx = { session: true };
		deps = { events, pi: { events }, getCtx: () => ctx, manager };
	});

	// --- ping ---

	describe("ping RPC", () => {
		it("replies with protocol version", async () => {
			registerRpcHandlers(deps);
			const reply = vi.fn();
			events.on("subagents:rpc:ping:reply:req-1", reply);
			events.emit("subagents:rpc:ping", { requestId: "req-1" });

			await vi.waitFor(() => expect(reply).toHaveBeenCalled());
			expect(reply).toHaveBeenCalledWith({ success: true, data: { version: PROTOCOL_VERSION } });
		});

		it("replies with the stringified value when a handler throws a non-Error", async () => {
			(manager.resolve as ReturnType<typeof vi.fn>).mockImplementation(() => {
				throw "plain failure";
			});
			registerRpcHandlers(deps);
			const reply = vi.fn();
			events.on("subagents:rpc:stop:reply:req-st-str", reply);
			events.emit("subagents:rpc:stop", { requestId: "req-st-str", agentId: "agent-42" });

			await vi.waitFor(() => expect(reply).toHaveBeenCalled());
			expect(reply).toHaveBeenCalledWith({ success: false, error: "plain failure" });
		});

		it("scopes replies — other requestIds do not receive it", async () => {
			registerRpcHandlers(deps);
			const wrongReply = vi.fn();
			events.on("subagents:rpc:ping:reply:req-other", wrongReply);
			events.emit("subagents:rpc:ping", { requestId: "req-1" });

			await new Promise((r) => setTimeout(r, 20));
			expect(wrongReply).not.toHaveBeenCalled();
		});

		it("unsub stops responding to pings", async () => {
			const { unsubPing } = registerRpcHandlers(deps);
			unsubPing();

			const reply = vi.fn();
			events.on("subagents:rpc:ping:reply:req-1", reply);
			events.emit("subagents:rpc:ping", { requestId: "req-1" });

			await new Promise((r) => setTimeout(r, 20));
			expect(reply).not.toHaveBeenCalled();
		});
	});

	// --- spawn ---

	describe("spawn RPC", () => {
		it("returns agent id on success", async () => {
			registerRpcHandlers(deps);
			const reply = vi.fn();
			events.on("subagents:rpc:spawn:reply:req-s1", reply);
			events.emit("subagents:rpc:spawn", {
				requestId: "req-s1",
				type: "general-purpose",
				prompt: "do stuff",
			});

			await vi.waitFor(() => expect(reply).toHaveBeenCalled());
			expect(reply).toHaveBeenCalledWith({ success: true, data: { id: "agent-42" } });
			expect(manager.spawn).toHaveBeenCalledWith(deps.pi, ctx, "general-purpose", "do stuff", {});
		});

		it("passes options through to manager.spawn", async () => {
			registerRpcHandlers(deps);
			const reply = vi.fn();
			events.on("subagents:rpc:spawn:reply:req-s2", reply);
			events.emit("subagents:rpc:spawn", {
				requestId: "req-s2",
				type: "Explore",
				prompt: "find it",
				options: { description: "search", isBackground: true, maxTurns: 0 },
			});

			await vi.waitFor(() => expect(reply).toHaveBeenCalled());
			expect(manager.spawn).toHaveBeenCalledWith(deps.pi, ctx, "Explore", "find it", {
				description: "search",
				isBackground: true,
				maxTurns: 0,
			});
		});

		it.each(["3", Number.NaN, Infinity])("rejects an invalid maxTurns of %s before spawning", async (maxTurns) => {
			registerRpcHandlers(deps);
			const reply = vi.fn();
			events.on("subagents:rpc:spawn:reply:req-cap", reply);
			events.emit("subagents:rpc:spawn", {
				requestId: "req-cap",
				type: "general-purpose",
				prompt: "x",
				options: { maxTurns },
			});

			await vi.waitFor(() =>
				expect(reply).toHaveBeenCalledWith({ success: false, error: "maxTurns must be a finite number" }),
			);
			expect(manager.spawn).not.toHaveBeenCalled();
		});

		it.each([null, undefined])("treats maxTurns %s as omitted", async (maxTurns) => {
			registerRpcHandlers(deps);
			const reply = vi.fn();
			events.on("subagents:rpc:spawn:reply:req-null", reply);
			events.emit("subagents:rpc:spawn", {
				requestId: "req-null",
				type: "general-purpose",
				prompt: "x",
				options: { maxTurns },
			});

			await vi.waitFor(() => expect(reply).toHaveBeenCalledWith({ success: true, data: { id: "agent-42" } }));
			expect(manager.spawn).toHaveBeenCalledTimes(1);
		});

		it("returns error when no active session", async () => {
			ctx = undefined;
			registerRpcHandlers(deps);
			const reply = vi.fn();
			events.on("subagents:rpc:spawn:reply:req-s3", reply);
			events.emit("subagents:rpc:spawn", {
				requestId: "req-s3",
				type: "general-purpose",
				prompt: "x",
			});

			await vi.waitFor(() => expect(reply).toHaveBeenCalled());
			expect(reply).toHaveBeenCalledWith({ success: false, error: "No active session" });
			expect(manager.spawn).not.toHaveBeenCalled();
		});

		it("returns error when manager.spawn throws", async () => {
			(manager.spawn as ReturnType<typeof vi.fn>).mockImplementation(() => {
				throw new Error("unknown agent type");
			});
			registerRpcHandlers(deps);
			const reply = vi.fn();
			events.on("subagents:rpc:spawn:reply:req-s4", reply);
			events.emit("subagents:rpc:spawn", {
				requestId: "req-s4",
				type: "bad-type",
				prompt: "x",
			});

			await vi.waitFor(() => expect(reply).toHaveBeenCalled());
			expect(reply).toHaveBeenCalledWith({ success: false, error: "unknown agent type" });
		});

		it("returns error when the agent fails to start after spawn returns", async () => {
			// With isolation: "worktree" the agent is not running when spawn() hands
			// back an id — the repo copy is an awaited git call. A failure there has
			// to be an error envelope, not an id for an agent that never ran.
			(manager.awaitStartup as ReturnType<typeof vi.fn>).mockRejectedValue(
				new Error('Cannot run with isolation: "worktree"'),
			);
			registerRpcHandlers(deps);
			const reply = vi.fn();
			events.on("subagents:rpc:spawn:reply:req-s4b", reply);
			events.emit("subagents:rpc:spawn", {
				requestId: "req-s4b",
				type: "general-purpose",
				prompt: "x",
				options: { isolation: "worktree" },
			});

			await vi.waitFor(() => expect(reply).toHaveBeenCalled());
			expect(reply).toHaveBeenCalledWith({
				success: false,
				error: 'Cannot run with isolation: "worktree"',
			});
			expect(manager.awaitStartup).toHaveBeenCalledWith("agent-42");
		});

		it("scopes replies — other requestIds do not receive it", async () => {
			registerRpcHandlers(deps);
			const wrongReply = vi.fn();
			const rightReply = vi.fn();
			events.on("subagents:rpc:spawn:reply:req-other", wrongReply);
			events.on("subagents:rpc:spawn:reply:req-s5", rightReply);
			events.emit("subagents:rpc:spawn", {
				requestId: "req-s5",
				type: "general-purpose",
				prompt: "x",
			});

			await vi.waitFor(() => expect(rightReply).toHaveBeenCalled());
			expect(wrongReply).not.toHaveBeenCalled();
		});

		it("unsub stops responding to spawns", async () => {
			const { unsubSpawn } = registerRpcHandlers(deps);
			unsubSpawn();

			const reply = vi.fn();
			events.on("subagents:rpc:spawn:reply:req-s6", reply);
			events.emit("subagents:rpc:spawn", {
				requestId: "req-s6",
				type: "general-purpose",
				prompt: "x",
			});

			// Give any potential async handler time to fire
			await new Promise((r) => setTimeout(r, 20));
			expect(reply).not.toHaveBeenCalled();
		});
	});

	// --- stop ---

	describe("stop RPC", () => {
		/** Stop `agentId` once the resolver answers `ref`; the reply. */
		const stopAs = async (ref: AgentRef, agentId = "agent-42") => {
			(manager.resolve as ReturnType<typeof vi.fn>).mockReturnValue(ref);
			const requestId = `req-st-${(manager.resolve as ReturnType<typeof vi.fn>).mock.calls.length}`;
			const reply = vi.fn();
			events.on(`subagents:rpc:stop:reply:${requestId}`, reply);
			events.emit("subagents:rpc:stop", { requestId, agentId });
			await vi.waitFor(() => expect(reply).toHaveBeenCalled());
			return reply.mock.calls[0]?.[0];
		};

		// The default double resolves a live agent of the session's own, the case
		// the ownership guard must let through. A handle stops the record it names.
		it("returns success when agent is aborted", async () => {
			registerRpcHandlers(deps);
			expect(await stopAs(refTo("live"), "@explore")).toEqual({ success: true });
			expect(manager.resolve).toHaveBeenCalledWith("@explore");
			expect(manager.abort).toHaveBeenCalledWith("agent-42");
		});

		// "Not running" is a record that exists but has settled: retained, or one
		// `abort` refuses because it settled after the lookup.
		it("says so when the agent exists but has already finished", async () => {
			registerRpcHandlers(deps);
			expect(await stopAs(refTo("retained"))).toEqual({ success: false, error: "Agent is not running" });
			expect(manager.abort).not.toHaveBeenCalled();
			(manager.abort as ReturnType<typeof vi.fn>).mockReturnValue(false);
			expect(await stopAs(refTo("queued"))).toEqual({ success: false, error: "Agent is not running" });
		});

		it("returns error when the agent is unknown to the manager", async () => {
			registerRpcHandlers(deps);
			const runRef = { ...refTo("workflow-owned"), owner: { kind: "run", task: {} } } as AgentRef;
			for (const ref of [refTo("unknown"), refTo("saved"), runRef])
				expect(await stopAs(ref)).toEqual({ success: false, error: "Agent not found" });
			expect(manager.abort).not.toHaveBeenCalled();
		});

		// A nested child and a workflow's agent both have an owner that is waiting
		// on them, so an id that leaked to another extension must not let it abort
		// one out from under that owner. The session cannot see a nested child, so
		// it is refused off the record existing at all.
		it("refuses to stop another agent's nested child or a workflow's agent", async () => {
			registerRpcHandlers(deps);
			const owned = { success: false, error: "Agent is owned by another agent or workflow" };
			expect(await stopAs(refTo("workflow-owned"))).toEqual(owned);
			(manager.hasRecord as ReturnType<typeof vi.fn>).mockReturnValue(true);
			expect(await stopAs(refTo("unknown"), "agent-child")).toEqual(owned);
			expect(manager.hasRecord).toHaveBeenCalledWith("agent-child");
			expect(manager.abort).not.toHaveBeenCalled();
		});

		it("scopes replies — other requestIds do not receive it", async () => {
			registerRpcHandlers(deps);
			const wrongReply = vi.fn();
			const rightReply = vi.fn();
			events.on("subagents:rpc:stop:reply:req-other", wrongReply);
			events.on("subagents:rpc:stop:reply:req-st3", rightReply);
			events.emit("subagents:rpc:stop", { requestId: "req-st3", agentId: "agent-42" });

			await vi.waitFor(() => expect(rightReply).toHaveBeenCalled());
			expect(wrongReply).not.toHaveBeenCalled();
		});

		it("unsub stops responding to stop requests", async () => {
			const { unsubStop } = registerRpcHandlers(deps);
			unsubStop();

			const reply = vi.fn();
			events.on("subagents:rpc:stop:reply:req-st4", reply);
			events.emit("subagents:rpc:stop", { requestId: "req-st4", agentId: "agent-42" });

			await new Promise((r) => setTimeout(r, 20));
			expect(reply).not.toHaveBeenCalled();
		});
	});

	// --- consume ---

	describe("consume RPC", () => {
		/** Consume once the resolver answers `ref`; the reply. */
		const consumeAs = async (ref: AgentRef) => {
			(manager.resolve as ReturnType<typeof vi.fn>).mockReturnValue(ref);
			const requestId = `req-c-${(manager.resolve as ReturnType<typeof vi.fn>).mock.calls.length}`;
			const reply = vi.fn();
			events.on(`subagents:rpc:consume:reply:${requestId}`, reply);
			events.emit("subagents:rpc:consume", { requestId, agentId: "agent-42" });
			await vi.waitFor(() => expect(reply).toHaveBeenCalled());
			return reply.mock.calls[0]?.[0];
		};

		it("returns success when the result is consumed", async () => {
			registerRpcHandlers(deps);
			const ref = refTo("retained", { status: "completed" });
			expect(await consumeAs(ref)).toEqual({ success: true });
			expect(manager.resolve).toHaveBeenCalledWith("agent-42");
			expect(manager.markRead).toHaveBeenCalledExactlyOnceWith((ref as { record: object }).record);
		});

		// Same guard as get_subagent_result: a workflow's child is its run's, not the caller's to read.
		it("returns an error when the agent is unknown, still running, or a workflow's", async () => {
			registerRpcHandlers(deps);
			for (const state of ["unknown", "live", "queued", "saved", "workflow-owned"] as const)
				expect(await consumeAs(refTo(state))).toEqual({ success: false, error: "Agent not found or still running" });
			expect(manager.markRead).not.toHaveBeenCalled();
		});

		it("unsub stops responding to consume requests", async () => {
			const { unsubConsume } = registerRpcHandlers(deps);
			unsubConsume();

			const reply = vi.fn();
			events.on("subagents:rpc:consume:reply:req-c3", reply);
			events.emit("subagents:rpc:consume", { requestId: "req-c3", agentId: "agent-42" });

			await new Promise((r) => setTimeout(r, 20));
			expect(reply).not.toHaveBeenCalled();
			expect(manager.resolve).not.toHaveBeenCalled();
		});
	});

	// --- steer ---

	describe("steer RPC", () => {
		it("delivers a message to a running top-level agent", async () => {
			registerRpcHandlers(deps);
			const reply = vi.fn();
			events.on("subagents:rpc:steer:reply:req-m1", reply);
			events.emit("subagents:rpc:steer", {
				requestId: "req-m1",
				agentId: "agent-42",
				message: "also failing: check_suite on 839ab295",
			});

			await vi.waitFor(() => expect(reply).toHaveBeenCalled());
			expect(reply).toHaveBeenCalledWith({ success: true });
			expect(manager.steer).toHaveBeenCalledWith("agent-42", "also failing: check_suite on 839ab295");
		});

		it("returns error when the agent is unknown to the manager", async () => {
			(manager.resolve as ReturnType<typeof vi.fn>).mockReturnValue(refTo("unknown"));
			registerRpcHandlers(deps);
			const reply = vi.fn();
			events.on("subagents:rpc:steer:reply:req-m2", reply);
			events.emit("subagents:rpc:steer", { requestId: "req-m2", agentId: "nonexistent", message: "x" });

			await vi.waitFor(() => expect(reply).toHaveBeenCalled());
			expect(reply).toHaveBeenCalledWith({ success: false, error: "Agent not found" });
			expect(manager.steer).not.toHaveBeenCalled();
		});

		// Same ownership stance as stop: an agent another agent or a workflow is
		// waiting on is not this RPC's to redirect.
		it("refuses to steer another agent's nested child or a workflow's agent", async () => {
			(manager.resolve as ReturnType<typeof vi.fn>).mockReturnValue(refTo("workflow-owned"));
			registerRpcHandlers(deps);
			const reply = vi.fn();
			events.on("subagents:rpc:steer:reply:req-m3", reply);
			events.emit("subagents:rpc:steer", { requestId: "req-m3", agentId: "agent-42", message: "x" });

			await vi.waitFor(() => expect(reply).toHaveBeenCalled());
			expect(reply).toHaveBeenCalledWith({ success: false, error: "Agent is owned by another agent or workflow" });
			expect(manager.steer).not.toHaveBeenCalled();
		});

		// A retained record, or one that settled after the lookup so `steer` refuses it.
		it("says so when the agent has already finished", async () => {
			(manager.steer as ReturnType<typeof vi.fn>).mockReturnValue(false);
			registerRpcHandlers(deps);
			const reply = vi.fn();
			events.on("subagents:rpc:steer:reply:req-m4", reply);
			events.emit("subagents:rpc:steer", { requestId: "req-m4", agentId: "agent-42", message: "x" });

			await vi.waitFor(() => expect(reply).toHaveBeenCalled());
			expect(reply).toHaveBeenCalledWith({ success: false, error: "Agent is not running" });
			expect(manager.steer).toHaveBeenCalledWith("agent-42", "x");
		});

		it("rejects a whitespace-only message before touching the manager", async () => {
			registerRpcHandlers(deps);
			const reply = vi.fn();
			events.on("subagents:rpc:steer:reply:req-m5", reply);
			events.emit("subagents:rpc:steer", { requestId: "req-m5", agentId: "agent-42", message: "   " });

			await vi.waitFor(() => expect(reply).toHaveBeenCalled());
			expect(reply).toHaveBeenCalledWith({ success: false, error: "Steer message must be a non-empty string" });
			expect(manager.steer).not.toHaveBeenCalled();
		});

		it("rejects a non-string message before touching the manager", async () => {
			registerRpcHandlers(deps);
			const reply = vi.fn();
			events.on("subagents:rpc:steer:reply:req-m7", reply);
			events.emit("subagents:rpc:steer", { requestId: "req-m7", agentId: "agent-42", message: 42 });

			await vi.waitFor(() => expect(reply).toHaveBeenCalled());
			expect(reply).toHaveBeenCalledWith({ success: false, error: "Steer message must be a non-empty string" });
			expect(manager.steer).not.toHaveBeenCalled();
		});

		describe("while Plan mode answers on the bus", () => {
			/** The record the manager reports for `agent-42`. */
			const withRecord = (record: { status: string; planGate?: object }) =>
				(manager.resolve as ReturnType<typeof vi.fn>).mockReturnValue(
					refTo(record.status === "queued" ? "queued" : record.status === "running" ? "live" : "retained", record),
				);
			/** Answer Plan's state query like pi-plan-mode, active with a policy that refuses `write`. */
			const planning = (active: boolean) =>
				events.on(PLAN_MODE_STATE_QUERY, (data) => {
					(data as { reply: (state: unknown) => void }).reply({
						version: 1,
						active,
						sessionId: "s",
						evaluate: ({ toolName }: { toolName: string }) => (toolName === "write" ? "blocked" : undefined),
					});
				});
			const steer = async (requestId: string) => {
				registerRpcHandlers(deps);
				const reply = vi.fn();
				events.on(`subagents:rpc:steer:reply:${requestId}`, reply);
				events.emit("subagents:rpc:steer", { requestId, agentId: "agent-42", message: "EDIT EVERYTHING" });
				await vi.waitFor(() => expect(reply).toHaveBeenCalled());
				return reply.mock.calls[0]?.[0];
			};

			it.each(["running", "queued"])("refuses a %s agent with no Plan policy", async (status) => {
				withRecord({ status });
				planning(true);
				expect(await steer(`req-p-${status}`)).toEqual({ success: false, error: planSteerRefusal("agent-42") });
				expect(manager.steer).not.toHaveBeenCalled();
			});

			it("refuses when Plan answers malformed, which never counts as off", async () => {
				withRecord({ status: "running" });
				events.on(PLAN_MODE_STATE_QUERY, (data) =>
					(data as { reply: (state: unknown) => void }).reply({ version: 2, active: false }),
				);
				expect(await steer("req-p-skew")).toEqual({ success: false, error: planSteerRefusal("agent-42") });
				expect(manager.steer).not.toHaveBeenCalled();
			});

			it("steers an agent already running under Plan's policy", async () => {
				withRecord({ status: "running", planGate: { policy: () => undefined } });
				planning(true);
				expect(await steer("req-p-gated")).toEqual({ success: true });
				expect(manager.steer).toHaveBeenCalledWith("agent-42", "EDIT EVERYTHING");
			});

			it("steers when Plan answers that it is off", async () => {
				withRecord({ status: "running" });
				planning(false);
				expect(await steer("req-p-off")).toEqual({ success: true });
				expect(manager.steer).toHaveBeenCalledOnce();
			});

			it("reports a settled agent as not running rather than as a Plan refusal", async () => {
				withRecord({ status: "completed" });
				(manager.steer as ReturnType<typeof vi.fn>).mockReturnValue(false);
				planning(true);
				expect(await steer("req-p-done")).toEqual({ success: false, error: "Agent is not running" });
				expect(manager.steer).not.toHaveBeenCalled();
			});
		});

		it("unsub stops responding to steer requests", async () => {
			const { unsubSteer } = registerRpcHandlers(deps);
			unsubSteer();

			const reply = vi.fn();
			events.on("subagents:rpc:steer:reply:req-m6", reply);
			events.emit("subagents:rpc:steer", { requestId: "req-m6", agentId: "agent-42", message: "x" });

			await new Promise((r) => setTimeout(r, 20));
			expect(reply).not.toHaveBeenCalled();
		});
	});

	// --- concurrent requests ---

	describe("concurrent requests", () => {
		it("handles multiple simultaneous spawn requests independently", async () => {
			let callCount = 0;
			(manager.spawn as ReturnType<typeof vi.fn>).mockImplementation(() => `agent-${++callCount}`);
			registerRpcHandlers(deps);

			const reply1 = vi.fn();
			const reply2 = vi.fn();
			events.on("subagents:rpc:spawn:reply:req-a", reply1);
			events.on("subagents:rpc:spawn:reply:req-b", reply2);

			events.emit("subagents:rpc:spawn", { requestId: "req-a", type: "Explore", prompt: "first" });
			events.emit("subagents:rpc:spawn", { requestId: "req-b", type: "Plan", prompt: "second" });

			await vi.waitFor(() => {
				expect(reply1).toHaveBeenCalled();
				expect(reply2).toHaveBeenCalled();
			});

			expect(reply1).toHaveBeenCalledWith({ success: true, data: { id: "agent-1" } });
			expect(reply2).toHaveBeenCalledWith({ success: true, data: { id: "agent-2" } });
		});
	});

	// --- model override resolution (regression for cross-extension callers
	//     that forward a serializable string instead of a Model object) ---

	describe("spawn RPC model override", () => {
		const fakeModel = { id: "gpt-5.5", provider: "openai-codex", name: "GPT 5.5" };
		const registry = {
			find: (provider: string, id: string) =>
				provider === fakeModel.provider && id === fakeModel.id ? fakeModel : null,
			getAll: () => [fakeModel],
			getAvailable: () => [fakeModel],
		};

		beforeEach(() => {
			ctx = { session: true, modelRegistry: registry };
			deps = { events, pi: { events }, getCtx: () => ctx, manager };
		});

		it("validates a string model and preserves its original request for shared spawn", async () => {
			registerRpcHandlers(deps);
			const reply = vi.fn();
			events.on("subagents:rpc:spawn:reply:req-m1", reply);
			events.emit("subagents:rpc:spawn", {
				requestId: "req-m1",
				type: "general-purpose",
				prompt: "x",
				options: { model: "openai-codex/gpt-5.5" },
			});

			await vi.waitFor(() => expect(reply).toHaveBeenCalled());
			expect(reply).toHaveBeenCalledWith({ success: true, data: { id: "agent-42" } });
			expect(manager.spawn).toHaveBeenCalledWith(deps.pi, ctx, "general-purpose", "x", {
				model: "openai-codex/gpt-5.5",
			});
		});

		it("passes a Model object through unchanged", async () => {
			registerRpcHandlers(deps);
			const reply = vi.fn();
			events.on("subagents:rpc:spawn:reply:req-m2", reply);
			events.emit("subagents:rpc:spawn", {
				requestId: "req-m2",
				type: "general-purpose",
				prompt: "x",
				options: { model: fakeModel },
			});

			await vi.waitFor(() => expect(reply).toHaveBeenCalled());
			expect(manager.spawn).toHaveBeenCalledWith(deps.pi, ctx, "general-purpose", "x", { model: fakeModel });
		});

		it("surfaces a clear error when the model string can't be resolved", async () => {
			registerRpcHandlers(deps);
			const reply = vi.fn();
			events.on("subagents:rpc:spawn:reply:req-m3", reply);
			events.emit("subagents:rpc:spawn", {
				requestId: "req-m3",
				type: "general-purpose",
				prompt: "x",
				options: { model: "nope/does-not-exist" },
			});

			await vi.waitFor(() => expect(reply).toHaveBeenCalled());
			const call = (reply as ReturnType<typeof vi.fn>).mock.calls[0]![0];
			expect(call.success).toBe(false);
			expect(call.error).toMatch(/Model not found/);
			expect(manager.spawn).not.toHaveBeenCalled();
		});

		it("treats an explicit null model as no override at all", async () => {
			// A JSON-forwarding caller can serialize an unset field as null. The
			// runner reads `options.model ?? default`, so null means "inherit" —
			// it must not be resolved, scope-checked, or dereferenced.
			registerRpcHandlers(deps);
			const reply = vi.fn();
			events.on("subagents:rpc:spawn:reply:req-m5", reply);
			events.emit("subagents:rpc:spawn", {
				requestId: "req-m5",
				type: "general-purpose",
				prompt: "x",
				options: { model: null },
			});

			await vi.waitFor(() => expect(reply).toHaveBeenCalled());
			expect(reply).toHaveBeenCalledWith({ success: true, data: { id: "agent-42" } });
			expect(manager.spawn).toHaveBeenCalledWith(deps.pi, ctx, "general-purpose", "x", { model: null });
		});

		it("errors when ctx has no modelRegistry but a string model is given", async () => {
			ctx = { session: true }; // no modelRegistry
			registerRpcHandlers(deps);
			const reply = vi.fn();
			events.on("subagents:rpc:spawn:reply:req-m4", reply);
			events.emit("subagents:rpc:spawn", {
				requestId: "req-m4",
				type: "general-purpose",
				prompt: "x",
				options: { model: "openai-codex/gpt-5.5" },
			});

			await vi.waitFor(() => expect(reply).toHaveBeenCalled());
			const call = (reply as ReturnType<typeof vi.fn>).mock.calls[0]![0];
			expect(call.success).toBe(false);
			expect(call.error).toMatch(/modelRegistry is unavailable/);
			expect(manager.spawn).not.toHaveBeenCalled();
		});
	});
	// --- scopeModels on the RPC spawn path (#240): an override on the RPC
	//     payload is an orchestrator-level choice, so it gets the Agent tool's
	//     hard error rather than reaching the spawn on an out-of-scope model. ---

	describe("spawn RPC model scope", () => {
		const ALLOWED = { id: "gpt-5.5", provider: "openai-codex", name: "GPT 5.5" };
		const BLOCKED = { id: "claude-sonnet-4", provider: "anthropic", name: "Claude Sonnet 4" };
		const MODELS = [ALLOWED, BLOCKED];
		const registry = {
			find: (provider: string, id: string) => MODELS.find((m) => m.provider === provider && m.id === id) ?? null,
			getAll: () => MODELS,
			getAvailable: () => MODELS,
		};

		let projectDir: string;
		let agentDir: string;
		let prevAgentDir: string | undefined;
		let prevEnabled: boolean;

		beforeEach(({ onTestFinished }) => {
			// resolveEnabledModels memoizes on (patterns, mtime+size of both settings
			// files) — a fresh project dir per test keeps one case's allowlist from
			// being served to the next. Same harness as test/model-scope.test.ts.
			projectDir = makeTestTempDir("pi-rpc-scope-project-", onTestFinished);
			agentDir = makeTestTempDir("pi-rpc-scope-global-", onTestFinished);
			prevAgentDir = process.env.PI_CODING_AGENT_DIR;
			process.env.PI_CODING_AGENT_DIR = agentDir;
			prevEnabled = isScopeModelsEnabled();
			mkdirSync(join(projectDir, ".pi"), { recursive: true });
			writeFileSync(
				join(projectDir, ".pi", "settings.json"),
				JSON.stringify({ enabledModels: ["openai-codex/gpt-5.5"] }),
			);
			setScopeModelsEnabled(true);
			ctx = { session: true, cwd: projectDir, modelRegistry: registry };
			deps = { events, pi: { events }, getCtx: () => ctx, manager };
		});

		afterEach(() => {
			setScopeModelsEnabled(prevEnabled); // module-global — restore for other suites
			if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
		});

		async function spawn(requestId: string, model: unknown) {
			registerRpcHandlers(deps);
			const reply = vi.fn();
			events.on(`subagents:rpc:spawn:reply:${requestId}`, reply);
			events.emit("subagents:rpc:spawn", {
				requestId,
				type: "general-purpose",
				prompt: "x",
				options: { model },
			});
			await vi.waitFor(() => expect(reply).toHaveBeenCalled());
			return (reply as ReturnType<typeof vi.fn>).mock.calls[0]![0];
		}

		it("refuses an out-of-scope string override, listing what is allowed", async () => {
			// The reported case: a bare "sonnet" fuzzy-resolves across providers, so
			// only the RESOLVED model can be compared against enabledModels.
			const call = await spawn("req-sc1", "sonnet");
			expect(call.success).toBe(false);
			expect(call.error).toMatch(/Model not in scope/);
			expect(call.error).toContain('"sonnet"');
			expect(call.error).toContain("  openai-codex/gpt-5.5");
			expect(manager.spawn).not.toHaveBeenCalled();
		});

		it("refuses an out-of-scope Model object override too", async () => {
			const call = await spawn("req-sc2", BLOCKED);
			expect(call.success).toBe(false);
			expect(call.error).toMatch(/Model not in scope/);
			expect(call.error).toContain('"anthropic/claude-sonnet-4"');
			expect(manager.spawn).not.toHaveBeenCalled();
		});

		it("spawns normally when the override is in scope", async () => {
			const call = await spawn("req-sc3", "openai-codex/gpt-5.5");
			expect(call).toEqual({ success: true, data: { id: "agent-42" } });
			expect(manager.spawn).toHaveBeenCalledWith(deps.pi, ctx, "general-purpose", "x", {
				model: "openai-codex/gpt-5.5",
			});
		});

		it("does not check scope while the setting is off", async () => {
			setScopeModelsEnabled(false);
			const call = await spawn("req-sc4", "sonnet");
			expect(call).toEqual({ success: true, data: { id: "agent-42" } });
			expect(manager.spawn).toHaveBeenCalledWith(deps.pi, ctx, "general-purpose", "x", { model: "sonnet" });
		});
	});
});
