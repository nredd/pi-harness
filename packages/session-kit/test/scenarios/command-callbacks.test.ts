import { fauxAssistantMessage, type Harness } from "@earendil-works/pi-coding-agent/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ControlledProcesses,
	configFor,
	FakeClock,
	goalStates,
	ScenarioFixture,
	spoken,
	tick,
	tool,
} from "./support.ts";

let fixture: ScenarioFixture;
let clock: FakeClock;
const notify = vi.fn();
beforeEach(() => {
	fixture = new ScenarioFixture();
	clock = new FakeClock();
	notify.mockReset();
});
afterEach(async () => {
	await fixture.shutdown();
	expect(clock.pending).toBe(0);
	fixture.cleanup();
});

/** Ask the real extension runner's public command registry, exactly as an autocomplete host does. */
async function completions(harness: Harness, name: string, prefix: string) {
	const command = harness.session.extensionRunner.getCommand(name);
	if (!command?.getArgumentCompletions) throw new Error(`Missing completion provider: ${name}`);
	return command.getArgumentCompletions(prefix);
}

/** Execute the unique suggested command rather than merely checking the callback was invoked. */
async function choose(harness: Harness, name: string, prefix: string): Promise<void> {
	const items = await completions(harness, name, prefix);
	expect(items).toHaveLength(1);
	const selected = items?.[0];
	if (!selected) throw new Error(`No completion for ${name} ${prefix}`);
	expect(selected.label).toBe(selected.value);
	await harness.session.prompt(`/${name} ${selected.value}`);
}

describe("public command completion routing", () => {
	it("routes goal suggestions to persisted pause, resume, status and clear outcomes", async () => {
		const harness = await fixture.start(configFor("goal"), { kit: { clock }, ui: { notify } });
		expect(await completions(harness, "goal", "not-a-command")).toBeNull();
		expect((await completions(harness, "goal", ""))?.map((item) => item.value)).toEqual([
			"status",
			"pause",
			"resume",
			"clear",
		]);
		await harness.session.prompt("/goal callback objective --turns 3");
		await choose(harness, "goal", "pa");
		expect(goalStates(harness).at(-1)).toMatchObject({
			status: "paused",
			objective: "callback objective",
			reason: "paused by user",
		});
		await choose(harness, "goal", "res");
		expect(goalStates(harness).at(-1)).toMatchObject({ status: "active", objective: "callback objective" });
		await choose(harness, "goal", "sta");
		expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("callback objective"), "info");
		await choose(harness, "goal", "cl");
		expect(goalStates(harness).at(-1)).toBeNull();
		expect(notify).toHaveBeenLastCalledWith("goal cleared", "info");
		expect(spoken(harness)).toEqual([]);
	});

	it("routes loop suggestions without sending list/stop as prompts or retaining stopped timers", async () => {
		const harness = await fixture.start(configFor("loop"), { kit: { clock }, ui: { notify } });
		expect(await completions(harness, "loop", "not-a-command")).toBeNull();
		expect((await completions(harness, "loop", ""))?.map((item) => item.value)).toEqual(["list", "stop", "resume"]);
		await harness.session.prompt("/loop 30s callback ping --max 2");
		await choose(harness, "loop", "li");
		expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("callback ping"), "info");
		await choose(harness, "loop", "res");
		expect(notify).toHaveBeenLastCalledWith("resumed 1", "info");
		harness.setResponses([fauxAssistantMessage("tick received")]);
		await tick(harness, clock);
		expect(spoken(harness)).toEqual(["tick received"]);
		await choose(harness, "loop", "st");
		expect(notify).toHaveBeenLastCalledWith("stopped 1", "info");
		expect(clock.pending).toBe(0);
		await choose(harness, "loop", "li");
		expect(notify).toHaveBeenLastCalledWith("no loops", "info");
	});

	it("suggests only running monitor IDs and stops the selected child, not its neighbor", async () => {
		const processes = new ControlledProcesses(clock);
		const harness = await fixture.start(configFor("monitor"), {
			kit: { clock, spawnMonitor: processes.spawn },
			ui: { notify },
		});
		harness.setResponses([
			tool("monitor_start", { argv: ["/controlled/watcher"], name: "alpha" }),
			tool("monitor_start", { argv: ["/controlled/watcher"], name: "beta" }),
			fauxAssistantMessage("watching"),
		]);
		await harness.session.prompt("watch both");
		expect(processes.children).toHaveLength(2);
		expect((await completions(harness, "monitor", "stop"))?.map((item) => item.value)).toEqual([
			"stop all",
			"stop m1",
			"stop m2",
		]);
		expect(await completions(harness, "monitor", "unknown")).toEqual([]);
		await choose(harness, "monitor", "stop m1");
		expect(processes.children.map((child) => child.alive)).toEqual([false, true]);
		expect(notify).toHaveBeenLastCalledWith(expect.stringContaining('stopped m1 "alpha"'), "info");
		expect((await completions(harness, "monitor", "stop"))?.map((item) => item.value)).toEqual(["stop all", "stop m2"]);
		await choose(harness, "monitor", "stop all");
		expect(processes.children.map((child) => child.alive)).toEqual([false, false]);
		expect(notify).toHaveBeenLastCalledWith("stopped m2", "info");
	});
});
