/** Quota admission is router-owned waiting, not a reason for another kit turn. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { register as registerGoal, WAKE_MS } from "../../src/goal/index.ts";
import { GOAL_ENTRY, GOAL_TOOL } from "../../src/goal/state.ts";
import { register as registerLoop } from "../../src/loop/index.ts";
import { coordination } from "../../src/shared.ts";
import { CONFIG, type Fake, fakePi } from "./fake-pi.ts";

async function boot(goalFirst = true, child = false): Promise<Fake> {
	const fake = fakePi(child ? { sessionName: "general-purpose#1a2b3c4d" } : {});
	for (const register of goalFirst ? [registerGoal, registerLoop] : [registerLoop, registerGoal])
		register(fake.pi, CONFIG);
	await fake.emit("session_start");
	return fake;
}

const command = (fake: Fake, name: string, args: string) => fake.commands.get(name)?.(args, fake.ctx);
const goal = (fake: Fake) =>
	(
		fake.entries.filter((e) => e.customType === GOAL_ENTRY).at(-1)?.data as {
			goal?: { status: string; reason?: string };
		}
	)?.goal;
const parked = (fake: Fake, id = "quota-job", patch = {}, type = "added") =>
	fake.events.emit("subagents:scheduled", { type, job: { id, quotaParked: true, enabled: true, ...patch } });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("quota admission coordination", () => {
	it.each([true, false])(
		"pauses both features immediately regardless of registration order (%s)",
		async (goalFirst) => {
			const fake = await boot(goalFirst);
			await command(fake, "goal", "ship it");
			await command(fake, "loop", "30s ping");
			parked(fake);
			expect(goal(fake)).toMatchObject({ status: "paused", reason: "quota parked" });
			expect(fake.state.activeTools).not.toContain(GOAL_TOOL);
			expect(coordination(fake.pi).goalActive).toBe(false);
			expect(await fake.settle()).toBeUndefined();
			await vi.advanceTimersByTimeAsync(90_000);
			expect(fake.sent).toHaveLength(1);
			await command(fake, "loop", "list");
			expect(fake.notices.at(-1)?.message).toContain("0/50 runs, 0 skipped: ping [paused: quota parked]");
		},
	);

	it("cancels an armed goal wake and refuses premature resume or replacement", async () => {
		const fake = await boot();
		await command(fake, "goal", "ship it");
		await command(fake, "loop", "30s ping");
		fake.events.emit("subagents:created", { id: "child", isBackground: true });
		await fake.settle();
		await fake.emit("agent_settled");
		fake.events.emit("subagents:completed", { id: "child" });
		parked(fake);
		await command(fake, "goal", "resume");
		await command(fake, "goal", "new work");
		await command(fake, "loop", "resume");
		await command(fake, "loop", "30s another");
		await vi.advanceTimersByTimeAsync(WAKE_MS + 90_000);
		expect(fake.sent).toHaveLength(1);
		expect(goal(fake)).toMatchObject({ status: "paused", reason: "quota parked" });
		expect(fake.notices.filter((n) => n.message.includes("still parked"))).toHaveLength(3);
	});

	it.each(["removed", "fired", "error", "disabled", "running", "ordinary"])(
		"releases %s jobs without automatic resume, retaining other parked jobs",
		async (transition) => {
			const fake = await boot();
			await command(fake, "goal", "ship it");
			await command(fake, "loop", "30s ping");
			parked(fake, "a");
			parked(fake, "b", {}, "updated");
			parked(fake, "b", {}, "updated");
			expect(coordination(fake.pi).quotaParked.size).toBe(2);
			if (transition === "disabled") parked(fake, "a", { enabled: false }, "updated");
			else if (transition === "running") parked(fake, "a", { lastStatus: "running" }, "updated");
			else if (transition === "ordinary") parked(fake, "a", { quotaParked: false }, "updated");
			else fake.events.emit("subagents:scheduled", { type: transition, jobId: "a", agentId: "agent" });
			expect([...coordination(fake.pi).quotaParked]).toEqual(["b"]);
			await command(fake, "goal", "resume");
			expect(goal(fake)?.status).toBe("paused");
			fake.events.emit("subagents:scheduled", { type: "removed", jobId: "b" });
			await vi.advanceTimersByTimeAsync(90_000);
			expect(fake.sent).toHaveLength(1);
			await command(fake, "loop", "resume");
			await vi.advanceTimersByTimeAsync(30_000);
			expect(fake.sent.at(-1)?.text).toBe("ping");
			await command(fake, "goal", "resume");
			expect(goal(fake)?.status).toBe("active");
		},
	);

	it("ignores ordinary schedules and malformed bus data", async () => {
		const fake = await boot();
		await command(fake, "goal", "ship it");
		for (const data of [null, {}, { type: "added", job: null }, { type: "added", job: { quotaParked: true } }])
			fake.events.emit("subagents:scheduled", data);
		parked(fake, "ordinary", { quotaParked: false });
		expect(coordination(fake.pi).quotaParked.size).toBe(0);
		expect(goal(fake)?.status).toBe("active");
	});

	it("pauses both on the canonical direct Agent admission refusal, not generic tool errors", async () => {
		const fake = await boot();
		await command(fake, "goal", "ship it");
		await command(fake, "loop", "30s ping");
		const refusal =
			"Subscription quota for router/spike is exhausted; it resets at an unknown time. The agent was not started.";
		for (const [toolName, isError, text] of [
			["bash", true, refusal],
			["Agent", false, refusal],
			["Agent", true, "quota generic failure"],
		]) {
			await fake.emit("tool_execution_end", { toolName, isError, result: { content: [{ type: "text", text }] } });
			expect(goal(fake)?.status).toBe("active");
		}
		await fake.emit("tool_execution_end", {
			toolName: "Agent",
			isError: true,
			result: { content: [{ type: "text", text: refusal }] },
		});
		expect(goal(fake)).toMatchObject({ status: "paused", reason: "quota refused" });
		expect(await fake.settle()).toBeUndefined();
		await vi.advanceTimersByTimeAsync(90_000);
		expect(fake.sent).toHaveLength(1);
		await command(fake, "loop", "list");
		expect(fake.notices.at(-1)?.message).toContain("paused: quota refused");
		await command(fake, "goal", "resume");
		expect(goal(fake)?.status).toBe("active");
	});

	it("clears subscriptions and parked state on session lifecycle, not across runtimes or children", async () => {
		const a = await boot();
		const b = await boot();
		const child = await boot(true, true);
		parked(a);
		parked(child);
		expect(coordination(a.pi).quotaParked.size).toBe(1);
		expect(coordination(b.pi).quotaParked.size).toBe(0);
		expect(coordination(child.pi).quotaParked.size).toBe(0);
		expect(child.events.listenerCount()).toBe(0);
		await a.emit("session_start");
		expect(coordination(a.pi).quotaParked.size).toBe(0);
		parked(a);
		await a.emit("session_shutdown");
		expect(coordination(a.pi).quotaParked.size).toBe(0);
		expect(a.events.listenerCount()).toBe(0);
	});
});
