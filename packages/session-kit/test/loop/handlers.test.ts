// biome-ignore-all lint/suspicious/noExplicitAny: test doubles stand in for pi's large runtime types
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { register as registerGoal } from "../../src/goal/index.ts";
import { GOAL_ENTRY } from "../../src/goal/state.ts";
import { register } from "../../src/loop/index.ts";
import { CONFIG, type Fake, fakePi, setPlanMode } from "../goal/fake-pi.ts";

async function boot(options: Parameters<typeof fakePi>[0] = {}, withGoal = false): Promise<Fake> {
	const fake = fakePi(options);
	register(fake.pi, CONFIG);
	if (withGoal) registerGoal(fake.pi, CONFIG);
	await fake.emit("session_start", { reason: "startup" });
	return fake;
}

const loopCmd = (fake: Fake, args: string) => fake.commands.get("loop")?.(args, fake.ctx) as Promise<void>;
const last = (fake: Fake) => fake.notices.at(-1)?.message ?? "";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("/loop start and tick", () => {
	it("re-sends the prompt on every interval while idle", async () => {
		const fake = await boot();
		await loopCmd(fake, "30s check the build");
		expect(fake.sent).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(30_000);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(fake.sent.map((s) => s.text)).toEqual(["check the build", "check the build"]);
		expect(fake.sent[0]?.options).toEqual({ expandPromptTemplates: true });
	});
	it("skips a busy tick without queueing, then fires on the next idle one", async () => {
		const fake = await boot();
		await loopCmd(fake, "30s ping");
		fake.state.idle = false;
		await vi.advanceTimersByTimeAsync(90_000);
		expect(fake.sent).toHaveLength(0);
		fake.state.idle = true;
		await vi.advanceTimersByTimeAsync(30_000);
		expect(fake.sent).toHaveLength(1);
		await loopCmd(fake, "list");
		expect(last(fake)).toContain("1/50 runs, 3 skipped");
	});
	it("treats queued messages as busy", async () => {
		const fake = await boot();
		await loopCmd(fake, "30s ping");
		fake.state.pending = true;
		await vi.advanceTimersByTimeAsync(30_000);
		expect(fake.sent).toHaveLength(0);
	});
	it("stops itself at the run cap and says so", async () => {
		const fake = await boot();
		await loopCmd(fake, "30s ping --max 2");
		await vi.advanceTimersByTimeAsync(30_000 * 5);
		expect(fake.sent).toHaveLength(2);
		expect(last(fake)).toContain("finished: 2 runs");
		await loopCmd(fake, "list");
		expect(last(fake)).toBe("no loops");
	});
	it("does not count skipped ticks toward the cap", async () => {
		const fake = await boot();
		await loopCmd(fake, "30s ping --max 2");
		fake.state.idle = false;
		await vi.advanceTimersByTimeAsync(30_000 * 10);
		fake.state.idle = true;
		await vi.advanceTimersByTimeAsync(30_000 * 5);
		expect(fake.sent).toHaveLength(2);
	});
	it("warns about a cold cache only above 5m", async () => {
		const fake = await boot();
		await loopCmd(fake, "5m ping");
		expect(fake.notices.some((n) => n.type === "warning")).toBe(false);
		await loopCmd(fake, "6m ping");
		expect(fake.notices.some((n) => n.type === "warning" && n.message.includes("cold prompt cache"))).toBe(true);
	});
	it("rejects intervals under 30s", async () => {
		const fake = await boot();
		await loopCmd(fake, "29s ping");
		expect(fake.notices.at(-1)?.type).toBe("error");
		await loopCmd(fake, "list");
		expect(last(fake)).toBe("no loops");
	});
	it("unrefs its timers so they never hold the process open", async () => {
		const unref = vi.fn();
		const real = globalThis.setInterval;
		vi.spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void, ms: number) => {
			const timer = real(fn, ms);
			const original = timer.unref.bind(timer);
			timer.unref = () => {
				unref();
				return original();
			};
			return timer;
		}) as any);
		const fake = await boot();
		await loopCmd(fake, "30s ping");
		expect(unref).toHaveBeenCalledOnce();
		vi.restoreAllMocks();
	});
});

describe("/loop list, stop, resume", () => {
	it("lists, stops one, then all", async () => {
		const fake = await boot();
		await loopCmd(fake, "30s one");
		await loopCmd(fake, "1m two");
		await loopCmd(fake, "list");
		expect(last(fake).split("\n")).toHaveLength(2);
		await loopCmd(fake, "stop 1");
		await vi.advanceTimersByTimeAsync(60_000);
		expect(fake.sent.map((s) => s.text)).toEqual(["two"]);
		await loopCmd(fake, "stop all");
		await vi.advanceTimersByTimeAsync(120_000);
		expect(fake.sent).toHaveLength(1);
	});
	it("reports an unknown id", async () => {
		const fake = await boot();
		await loopCmd(fake, "stop 9");
		expect(fake.notices.at(-1)).toMatchObject({ type: "error", message: "no loop 9" });
	});
});

describe("suspension", () => {
	it("suspends ticks in Plan mode without spending runs", async () => {
		const fake = await boot();
		await loopCmd(fake, "30s ping --max 2");
		setPlanMode(fake, true);
		await vi.advanceTimersByTimeAsync(90_000);
		expect(fake.sent).toHaveLength(0);
		setPlanMode(fake, false);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(fake.sent).toHaveLength(1);
	});
	it("does not tick while a goal is active, and resumes ticking after it pauses", async () => {
		const fake = await boot({}, true);
		await loopCmd(fake, "30s ping");
		await fake.commands.get("goal")?.("ship it", fake.ctx);
		fake.sent.length = 0;
		await vi.advanceTimersByTimeAsync(90_000);
		expect(fake.sent).toHaveLength(0);
		await fake.commands.get("goal")?.("pause", fake.ctx);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(fake.sent.map((s) => s.text)).toEqual(["ping"]);
	});
	it("pauses an idle goal when its command follows a Plan-mode excursion", async () => {
		const fake = await boot({}, true);
		await fake.commands.get("goal")?.("ship it", fake.ctx);
		setPlanMode(fake, true);
		setPlanMode(fake, false);
		await loopCmd(fake, "list");
		const goal = fake.entries.filter((entry) => entry.customType === GOAL_ENTRY).at(-1)?.data as {
			goal?: { status?: string; reason?: string };
		};
		expect(goal.goal).toMatchObject({ status: "paused", reason: "plan mode" });
	});
	it("pauses on a provider error and resumes on request", async () => {
		const fake = await boot();
		await loopCmd(fake, "30s ping");
		await fake.settle({ outcome: "error" });
		await fake.emit("agent_settled");
		expect(last(fake)).toContain("provider error");
		await vi.advanceTimersByTimeAsync(60_000);
		expect(fake.sent).toHaveLength(0);
		await loopCmd(fake, "list");
		expect(last(fake)).toContain("[paused: provider error]");
		await loopCmd(fake, "resume");
		await vi.advanceTimersByTimeAsync(30_000);
		expect(fake.sent).toHaveLength(1);
	});
	it("keeps running after an abort (Esc), which is not a quota refusal", async () => {
		const fake = await boot();
		await loopCmd(fake, "30s ping");
		await fake.settle({ outcome: "aborted" });
		await fake.emit("agent_settled");
		await vi.advanceTimersByTimeAsync(30_000);
		expect(fake.sent).toHaveLength(1);
	});
});

describe("lifetime and isolation", () => {
	it("clears every loop at shutdown and on a new session", async () => {
		const fake = await boot();
		await loopCmd(fake, "30s ping");
		await fake.emit("session_shutdown", { reason: "quit" });
		await vi.advanceTimersByTimeAsync(120_000);
		expect(fake.sent).toHaveLength(0);
		await loopCmd(fake, "30s again");
		await fake.emit("session_start", { reason: "new" });
		await vi.advanceTimersByTimeAsync(120_000);
		expect(fake.sent).toHaveLength(0);
	});
	it("keeps two runtimes independent", async () => {
		const a = await boot();
		const b = await boot();
		await loopCmd(a, "30s only a");
		await vi.advanceTimersByTimeAsync(30_000);
		expect(a.sent).toHaveLength(1);
		expect(b.sent).toHaveLength(0);
		await loopCmd(b, "list");
		expect(last(b)).toBe("no loops");
	});
	it("does not register in a child session", async () => {
		const fake = await boot({ sessionName: "general-purpose#1a2b3c4d" });
		expect(fake.commands.has("loop")).toBe(false);
		expect(fake.sent).toHaveLength(0);
		expect(fake.notices).toHaveLength(0);
	});
	it("stops quietly when the context went stale", async () => {
		const fake = await boot();
		await loopCmd(fake, "30s ping");
		fake.ctx.isIdle = () => {
			throw new Error("stale");
		};
		await vi.advanceTimersByTimeAsync(30_000);
		fake.ctx.isIdle = () => true;
		await vi.advanceTimersByTimeAsync(120_000);
		expect(fake.sent).toHaveLength(0);
	});
	it("writes no session entries: loops are never persisted", async () => {
		const fake = await boot();
		await loopCmd(fake, "30s ping");
		await vi.advanceTimersByTimeAsync(30_000);
		expect(fake.entries).toHaveLength(0);
	});
});
