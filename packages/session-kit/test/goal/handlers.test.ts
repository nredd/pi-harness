// biome-ignore-all lint/suspicious/noExplicitAny: test doubles stand in for pi's large runtime types
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHILD_ENTRY } from "../../src/child.ts";
import { register, turnTokens, WAKE_MS } from "../../src/goal/index.ts";
import { GOAL_ENTRY, GOAL_NUDGE_TYPE, GOAL_TOOL } from "../../src/goal/state.ts";
import { coordination, isPlanModeActive } from "../../src/shared.ts";
import { CONFIG, type Fake, fakePi, setPlanMode } from "./fake-pi.ts";

/** Fresh runtime with the goal feature registered and a session started. */
async function boot(options: Parameters<typeof fakePi>[0] = {}): Promise<Fake> {
	const fake = fakePi(options);
	register(fake.pi, CONFIG);
	await fake.emit("session_start", { reason: "startup" });
	return fake;
}

const goalCmd = (fake: Fake, args: string) => fake.commands.get("goal")?.(args, fake.ctx) as Promise<void>;
const lastGoal = (fake: Fake) => (fake.entries.filter((e) => e.customType === GOAL_ENTRY).at(-1)?.data as any)?.goal;

describe("registration", () => {
	it("registers the command and a never-default-active, non-readonly tool", async () => {
		const fake = await boot();
		expect(fake.commands.has("goal")).toBe(true);
		const tool = fake.tools.get(GOAL_TOOL);
		expect(tool.defaultActive).toBe(false);
		expect(tool.annotations?.readOnlyHint).toBeUndefined();
	});
	it("keeps the tool out of the active set until a goal runs", async () => {
		const fake = await boot();
		expect(fake.state.activeTools).not.toContain(GOAL_TOOL);
		await goalCmd(fake, "ship it");
		expect(fake.state.activeTools).toEqual(["read", "bash", GOAL_TOOL]);
		await goalCmd(fake, "pause");
		expect(fake.state.activeTools).toEqual(["read", "bash"]);
	});
	it("touches no other tool in the allowlist", async () => {
		const fake = await boot({ activeTools: ["a", "b", "c"] });
		await goalCmd(fake, "x");
		await goalCmd(fake, "clear");
		expect(fake.state.activeTools).toEqual(["a", "b", "c"]);
	});
});

describe("/goal command", () => {
	it("starts a goal and kicks off a turn in the TUI", async () => {
		const fake = await boot();
		await goalCmd(fake, "ship it --turns 4");
		expect(lastGoal(fake)).toMatchObject({ objective: "ship it", status: "active", maxTurns: 4 });
		expect(fake.sent).toHaveLength(1);
		expect(fake.sent[0]?.text).toContain("Goal: ship it");
		expect(fake.status.get("session-kit-goal")).toBe("goal 0/4");
		expect(coordination(fake.pi).goalActive).toBe(true);
	});
	it("does not kick off in print mode, where the session dies with the command", async () => {
		const fake = await boot({ mode: "print" });
		fake.ctx.mode = "print";
		await goalCmd(fake, "ship it");
		expect(fake.sent).toHaveLength(0);
		expect(lastGoal(fake).status).toBe("active");
	});
	it("does not kick off while the agent is busy", async () => {
		const fake = await boot({ idle: false });
		await goalCmd(fake, "ship it");
		expect(fake.sent).toHaveLength(0);
	});
	it("reports usage errors", async () => {
		const fake = await boot();
		await goalCmd(fake, "x --turns nope");
		expect(fake.notices.at(-1)?.type).toBe("error");
		expect(lastGoal(fake)).toBeUndefined();
	});
	it("pauses, resumes (with a kickoff), and clears", async () => {
		const fake = await boot();
		await goalCmd(fake, "ship it");
		await goalCmd(fake, "pause");
		expect(lastGoal(fake)).toMatchObject({ status: "paused", reason: "paused by user" });
		expect(coordination(fake.pi).goalActive).toBe(false);
		await goalCmd(fake, "resume");
		expect(lastGoal(fake).status).toBe("active");
		expect(fake.sent.at(-1)?.text).toContain("Resuming goal");
		await goalCmd(fake, "clear");
		expect(lastGoal(fake)).toBeNull();
		expect(fake.status.get("session-kit-goal")).toBeUndefined();
	});
	it("status reports without changing anything", async () => {
		const fake = await boot();
		await goalCmd(fake, "status");
		expect(fake.notices.at(-1)?.message).toContain("no goal");
		expect(fake.entries).toHaveLength(0);
	});
	it("refuses resume of a finished goal and pause with nothing active", async () => {
		const fake = await boot();
		await goalCmd(fake, "pause");
		await goalCmd(fake, "resume");
		expect(fake.notices.map((n) => n.type)).toEqual(["error", "error"]);
	});
});

describe("settle nudge", () => {
	it("returns one hidden continuation, keeping earlier entries", async () => {
		const fake = await boot();
		await goalCmd(fake, "ship it");
		const earlier = { type: "custom_message", customType: "other", content: "x", display: false };
		const result = await fake.settle({ entries: [earlier] });
		expect(result.continue).toBe(true);
		expect(result.entries).toHaveLength(2);
		expect(result.entries[0]).toBe(earlier);
		expect(result.entries[1]).toMatchObject({ type: "custom_message", customType: GOAL_NUDGE_TYPE, display: false });
	});
	it("treats an empty-but-assistant-tailed context as continuable (our draft ends it)", async () => {
		const fake = await boot();
		await goalCmd(fake, "ship it");
		expect(
			(
				await fake.settle({
					context: { canContinue: false, pendingMessages: [], llmMessages: [{ role: "assistant" }] },
				})
			).continue,
		).toBe(true);
	});
	it("never double-continues", async () => {
		const fake = await boot();
		await goalCmd(fake, "ship it");
		expect(await fake.settle({ continue: true })).toBeUndefined();
	});
	it("does not nudge a context with nothing to continue from", async () => {
		const fake = await boot();
		await goalCmd(fake, "ship it");
		expect(
			await fake.settle({ context: { canContinue: false, pendingMessages: [], llmMessages: [{ role: "system" }] } }),
		).toBeUndefined();
	});
	it("yields to queued messages (a subagent notice follow-up)", async () => {
		const fake = await boot();
		await goalCmd(fake, "ship it");
		expect(
			await fake.settle({ context: { canContinue: true, pendingMessages: [{}], llmMessages: [{ role: "user" }] } }),
		).toBeUndefined();
		fake.state.pending = true;
		expect(await fake.settle()).toBeUndefined();
	});
	it("does not nudge without a goal, when paused, or in a child session", async () => {
		const none = await boot();
		expect(await none.settle()).toBeUndefined();
		const paused = await boot();
		await goalCmd(paused, "x");
		await goalCmd(paused, "pause");
		expect(await paused.settle()).toBeUndefined();
	});
	it("stays out of Plan mode and pauses the goal on entering it", async () => {
		const fake = await boot();
		await goalCmd(fake, "ship it");
		setPlanMode(fake, true);
		expect(await fake.settle()).toBeUndefined();
		expect(lastGoal(fake)).toMatchObject({ status: "paused", reason: "plan mode" });
		expect(fake.state.activeTools).not.toContain(GOAL_TOOL);
	});
	it("pauses at before_agent_start when Plan mode was entered between runs", async () => {
		const fake = await boot();
		await goalCmd(fake, "ship it");
		setPlanMode(fake, true);
		await fake.emit("before_agent_start", {});
		expect(lastGoal(fake).status).toBe("paused");
		expect(fake.notices.at(-1)?.message).toContain("Plan mode");
	});
	it("pauses an idle goal after Plan mode was entered then left", async () => {
		const fake = await boot();
		await goalCmd(fake, "ship it");
		setPlanMode(fake, true);
		setPlanMode(fake, false);
		await fake.emit("input", {});
		expect(lastGoal(fake)).toMatchObject({ status: "paused", reason: "plan mode" });
		expect(await fake.settle()).toBeUndefined();
	});
});

describe("Plan mode refusal", () => {
	it("refuses /goal and /goal resume while Plan mode is on", async () => {
		const fake = await boot();
		await goalCmd(fake, "ship it");
		await goalCmd(fake, "pause");
		setPlanMode(fake, true);
		const before = fake.entries.length;
		await goalCmd(fake, "another");
		await goalCmd(fake, "resume");
		expect(fake.entries).toHaveLength(before);
		expect(fake.notices.slice(-2).every((n) => n.type === "error" && n.message.includes("Plan mode"))).toBe(true);
		expect(fake.sent).toHaveLength(1);
		setPlanMode(fake, false);
		await goalCmd(fake, "resume");
		expect(lastGoal(fake).status).toBe("active");
	});
});

describe("budgets", () => {
	it("counts parent turns, stops nudging at the budget and says so", async () => {
		const fake = await boot();
		await goalCmd(fake, "ship it --turns 2");
		await fake.turnEnd();
		expect((await fake.settle())?.continue).toBe(true);
		await fake.turnEnd();
		expect(lastGoal(fake)).toMatchObject({ status: "budget", turns: 2 });
		expect(await fake.settle()).toBeUndefined();
		expect(fake.notices.at(-1)).toMatchObject({ type: "warning" });
		expect(fake.state.activeTools).not.toContain(GOAL_TOOL);
	});
	it("counts tokens from turn_end usage", async () => {
		const fake = await boot();
		await goalCmd(fake, "ship it --tokens 1000");
		await fake.turnEnd({ input: 400, output: 100, cacheWrite: 100 });
		expect(lastGoal(fake)).toMatchObject({ tokens: 600, status: "active" });
		await fake.turnEnd({ input: 400, output: 0, cacheWrite: 0 });
		expect(lastGoal(fake).status).toBe("budget");
	});
	it("does not count turns of a paused goal", async () => {
		const fake = await boot();
		await goalCmd(fake, "x");
		await goalCmd(fake, "pause");
		await fake.turnEnd();
		expect(lastGoal(fake).turns).toBe(0);
	});
	it("turnTokens ignores non-assistant messages", () => {
		expect(turnTokens({ role: "user" })).toBe(0);
		expect(turnTokens(undefined)).toBe(0);
		expect(turnTokens({ role: "assistant", usage: { input: 1, output: 2, cacheWrite: 3 } })).toBe(6);
	});
});

describe("goal_update", () => {
	const run = (fake: Fake, args: { status: string; evidence: string }) =>
		fake.tools.get(GOAL_TOOL).execute("id", args, undefined, undefined, fake.ctx);

	it("refuses complete without evidence and leaves the goal active", async () => {
		const fake = await boot();
		await goalCmd(fake, "ship it");
		await expect(run(fake, { status: "complete", evidence: "  " })).rejects.toThrow(/evidence required/);
		expect(lastGoal(fake).status).toBe("active");
	});
	it("completes with evidence, persists it and deactivates the tool", async () => {
		const fake = await boot();
		await goalCmd(fake, "ship it");
		await run(fake, { status: "complete", evidence: "make test: ok" });
		expect(lastGoal(fake)).toMatchObject({ status: "complete", evidence: "make test: ok" });
		expect(fake.state.activeTools).not.toContain(GOAL_TOOL);
		expect(await fake.settle()).toBeUndefined();
		expect(coordination(fake.pi).goalActive).toBe(false);
	});
	it("blocks with a reason", async () => {
		const fake = await boot();
		await goalCmd(fake, "ship it");
		await run(fake, { status: "blocked", evidence: "no network" });
		expect(lastGoal(fake)).toMatchObject({ status: "blocked", reason: "no network" });
	});
	it("refuses with no active goal", async () => {
		const fake = await boot();
		await expect(run(fake, { status: "complete", evidence: "x" })).rejects.toThrow(/no active goal/);
	});
	it("refuses in a child session", async () => {
		const fake = await boot({ sessionName: "general-purpose#1a2b3c4d" });
		await expect(run(fake, { status: "complete", evidence: "x" })).rejects.toThrow(/subagents/);
	});
});

describe("stops", () => {
	it("pauses on an aborted run, but only once pi has settled", async () => {
		const fake = await boot();
		await goalCmd(fake, "ship it");
		expect(await fake.settle({ outcome: "aborted" })).toBeUndefined();
		expect(lastGoal(fake).status).toBe("active");
		await fake.emit("agent_settled");
		expect(lastGoal(fake)).toMatchObject({ status: "paused", reason: "run aborted" });
	});
	it("pauses on a provider error", async () => {
		const fake = await boot();
		await goalCmd(fake, "ship it");
		await fake.settle({ outcome: "error" });
		await fake.emit("agent_settled");
		expect(lastGoal(fake)).toMatchObject({ status: "paused", reason: "provider error" });
	});
	it("does not pause when a later turn started (retry or router recovery)", async () => {
		const fake = await boot();
		await goalCmd(fake, "ship it");
		await fake.settle({ outcome: "error" });
		await fake.emit("turn_start");
		await fake.emit("agent_settled");
		expect(lastGoal(fake).status).toBe("active");
	});
	it("does not pause when another handler (router) already continued the errored run", async () => {
		const fake = await boot();
		await goalCmd(fake, "ship it");
		await fake.settle({ outcome: "error", continue: true });
		await fake.emit("agent_settled");
		expect(lastGoal(fake).status).toBe("active");
	});
});

describe("persistence and branches", () => {
	it("restores an active goal paused on session_start, with the tool off", async () => {
		const fake = await boot();
		await goalCmd(fake, "ship it");
		await fake.turnEnd();
		fake.state.activeTools = ["read", GOAL_TOOL];
		await fake.emit("session_start", { reason: "resume" });
		expect(fake.status.get("session-kit-goal")).toBe("goal 1/30 120 tok paused");
		expect(fake.state.activeTools).toEqual(["read"]);
		expect(coordination(fake.pi).goalActive).toBe(false);
		expect(await fake.settle()).toBeUndefined();
		await goalCmd(fake, "resume");
		expect(lastGoal(fake)).toMatchObject({ status: "active", turns: 1 });
	});
	it("rebuilds from the new branch on session_tree", async () => {
		const fake = await boot();
		await goalCmd(fake, "ship it");
		fake.entries.length = 0;
		await fake.emit("session_tree");
		expect(fake.status.get("session-kit-goal")).toBeUndefined();
		expect(await fake.settle()).toBeUndefined();
	});
	it("keeps two runtimes independent", async () => {
		const a = await boot();
		const b = await boot();
		await goalCmd(a, "only in a");
		expect(coordination(a.pi).goalActive).toBe(true);
		expect(coordination(b.pi).goalActive).toBe(false);
		expect(await b.settle()).toBeUndefined();
		expect((await a.settle())?.continue).toBe(true);
	});
	it("clears everything at shutdown", async () => {
		const fake = await boot();
		await goalCmd(fake, "ship it");
		await fake.emit("session_shutdown", { reason: "quit" });
		expect(coordination(fake.pi).goalActive).toBe(false);
		expect(fake.events.listenerCount()).toBe(0);
	});
});

describe("child sessions", () => {
	it("hide the tool and act on nothing", async () => {
		const fake = fakePi({ sessionName: "general-purpose#1a2b3c4d", activeTools: ["read", GOAL_TOOL] });
		register(fake.pi, CONFIG);
		await fake.emit("session_start", { reason: "startup" });
		expect(fake.state.activeTools).toEqual(["read"]);
		expect(fake.commands.has("goal")).toBe(false);
		expect(fake.entries.map((entry) => entry.customType)).toEqual([CHILD_ENTRY]);
		expect(await fake.settle()).toBeUndefined();
		await fake.turnEnd();
		expect(fake.entries.map((entry) => entry.customType)).toEqual([CHILD_ENTRY]);
		expect(fake.events.listenerCount()).toBe(0);
	});
	it("never inherit the parent's goal from the bus or entries of another runtime", async () => {
		const parent = await boot();
		await goalCmd(parent, "parent goal");
		const child = fakePi({ sessionName: "Explore#deadbeef" });
		register(child.pi, CONFIG);
		await child.emit("session_start", { reason: "startup" });
		await child.turnEnd();
		expect(await child.settle()).toBeUndefined();
		expect(lastGoal(parent).turns).toBe(0);
	});
});

describe("background subagents", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("skips the nudge while one runs, shows it in the chip, and wakes once it has finished", async () => {
		const fake = await boot();
		await goalCmd(fake, "ship it");
		fake.events.emit("subagents:created", { id: "a", isBackground: true });
		fake.events.emit("subagents:started", { id: "a" });
		expect(await fake.settle()).toBeUndefined();
		await fake.emit("agent_settled");
		await vi.advanceTimersByTimeAsync(WAKE_MS + 100);
		expect(fake.sent.filter((s) => s.text.startsWith("[goal"))).toHaveLength(0);
		fake.events.emit("subagents:completed", { id: "a" });
		// completed but unannounced: still waits for the notice
		expect(await fake.settle()).toBeUndefined();
		fake.emit("message_end", { message: { role: "custom", customType: "subagent-notification" } });
		expect((await fake.settle())?.continue).toBe(true);
	});
	it("wakes itself when a finished agent's notice never comes", async () => {
		const fake = await boot();
		await goalCmd(fake, "ship it");
		fake.events.emit("subagents:created", { id: "a", isBackground: true });
		expect(await fake.settle()).toBeUndefined();
		await fake.emit("agent_settled");
		fake.events.emit("subagents:completed", { id: "a" });
		await vi.advanceTimersByTimeAsync(WAKE_MS + 100);
		expect(fake.sent.at(-1)?.text).toContain("[goal 0/30 turns]");
	});
	it("does not wake into a busy or Plan-mode session", async () => {
		const fake = await boot();
		await goalCmd(fake, "ship it");
		fake.events.emit("subagents:started", { id: "a" });
		await fake.settle();
		await fake.emit("agent_settled");
		fake.events.emit("subagents:completed", { id: "a" });
		fake.state.idle = false;
		await vi.advanceTimersByTimeAsync(WAKE_MS + 100);
		expect(fake.sent).toHaveLength(1);
	});
	it("cancels the wake when a run starts", async () => {
		const fake = await boot();
		await goalCmd(fake, "ship it");
		fake.events.emit("subagents:started", { id: "a" });
		await fake.settle();
		await fake.emit("agent_settled");
		fake.events.emit("subagents:completed", { id: "a" });
		await fake.emit("agent_start");
		await vi.advanceTimersByTimeAsync(WAKE_MS + 100);
		expect(fake.sent).toHaveLength(1);
	});
	it("get_subagent_result counts as the notice", async () => {
		const fake = await boot();
		await goalCmd(fake, "ship it");
		fake.events.emit("subagents:created", { id: "a", isBackground: true });
		fake.events.emit("subagents:completed", { id: "a" });
		await fake.emit("tool_execution_end", { toolName: "get_subagent_result" });
		expect((await fake.settle())?.continue).toBe(true);
	});
});

describe("isPlanModeActive", () => {
	const plan = (enabled: unknown) => ({ type: "custom", customType: "plan-mode-state", data: { enabled } });
	it("follows the latest state entry", () => {
		expect(isPlanModeActive([])).toBe(false);
		expect(isPlanModeActive([plan(true)])).toBe(true);
		expect(isPlanModeActive([plan(true), { type: "message" }, plan(false)])).toBe(false);
		expect(isPlanModeActive([plan("yes")])).toBe(false);
		expect(isPlanModeActive([{ type: "custom", customType: "plan-mode-state" }])).toBe(false);
	});
});
