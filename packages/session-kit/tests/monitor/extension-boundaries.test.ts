import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { FakeClock } from "@nredd/pi-test-lib/clock";
import { outcomes, toolCall } from "@nredd/pi-test-lib/faux";
import { fauxAssistantMessage } from "@nredd/pi-test-lib/harness";
import { afterEach, expect, it, vi } from "vitest";
import { sweepOrphans } from "../../src/monitor/pidfiles.ts";
import { ControlledProcesses, configFor, ScenarioFixture } from "../fixtures/session.ts";

vi.mock("../../src/monitor/pidfiles.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/monitor/pidfiles.ts")>();
	return { ...actual, sweepOrphans: vi.fn(actual.sweepOrphans) };
});

let fixture: ScenarioFixture | undefined;
afterEach(async () => {
	await fixture?.shutdown();
	fixture?.cleanup();
	fixture = undefined;
	vi.restoreAllMocks();
	vi.mocked(sweepOrphans).mockReset();
});

it("unwritable monitor startup warns and leaves public commands/tools unavailable without spawning", async () => {
	fixture = new ScenarioFixture();
	const blocked = join(fixture.root, "blocked");
	writeFileSync(blocked, "not a directory");
	const notify = vi.fn();
	const clock = new FakeClock();
	const children = new ControlledProcesses(clock);
	const harness = await fixture.start(configFor("monitor"), {
		kit: { monitorRoot: join(blocked, "monitors"), clock, spawnMonitor: children.spawn },
		ui: { notify },
	});
	expect(notify).toHaveBeenCalledWith(expect.stringContaining("/monitor: cannot create"), "warning");
	await harness.session.prompt("/monitor list");
	expect(notify).toHaveBeenLastCalledWith("/monitor: monitors are not available in this session", "warning");
	harness.setResponses([
		toolCall("monitor_start", { argv: ["fixture"], name: "blocked" }),
		fauxAssistantMessage("unavailable"),
	]);
	await harness.session.prompt("start watcher");
	expect(outcomes(harness, "monitor_start")).toEqual([
		{ isError: true, text: "monitors are not available in this session" },
	]);
	expect(children.calls).toEqual([]);
	expect(clock.pending).toBe(0);
});

it.each(["uncertain", "rejected"])(
	"orphan sweep %s warns without disabling the public monitor command",
	async (kind) => {
		fixture = new ScenarioFixture();
		const root = join(fixture.root, "monitors");
		const uncertain = join(root, "retained.json");
		if (kind === "uncertain")
			vi.mocked(sweepOrphans).mockResolvedValueOnce({ killed: [], removed: [], skippedLive: [], failed: [uncertain] });
		else vi.mocked(sweepOrphans).mockRejectedValueOnce(new Error("fixture sweep unavailable"));
		const notify = vi.fn();
		const clock = new FakeClock();
		const children = new ControlledProcesses(clock);
		const harness = await fixture.start(configFor("monitor"), {
			kit: { clock, spawnMonitor: children.spawn },
			ui: { notify },
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(notify).toHaveBeenCalledWith(
			kind === "uncertain"
				? `/monitor: retained uncertain or busy orphan records: ${uncertain}`
				: "/monitor: orphan cleanup failed: Error: fixture sweep unavailable",
			"warning",
		);
		await harness.session.prompt("/monitor list");
		expect(notify).toHaveBeenLastCalledWith("no monitors", "info");
		harness.setResponses([
			toolCall("monitor_start", { argv: ["fixture"], name: "still-usable" }),
			fauxAssistantMessage("started"),
		]);
		await harness.session.prompt("start after sweep");
		expect(outcomes(harness, "monitor_start")[0]).toMatchObject({
			isError: false,
			text: expect.stringContaining("started m1"),
		});
		await harness.session.prompt("/monitor stop all");
		expect(children.last.alive).toBe(false);
		expect(notify).toHaveBeenLastCalledWith("stopped m1", "info");
		expect(clock.pending).toBe(0);
	},
);
