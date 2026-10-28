import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-coding-agent/testing";
import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, expect, it, vi } from "vitest";
import { register } from "../../src/monitor/index.ts";
import { sweepOrphans } from "../../src/monitor/pidfiles.ts";
import { WIDGET_KEY } from "../../src/monitor/widget.ts";
import {
	ControlledProcesses,
	configFor,
	FakeClock,
	outcomes,
	ScenarioFixture,
	TerminalFixture,
	tool,
} from "../scenarios/support.ts";

vi.mock("../../src/monitor/pidfiles.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/monitor/pidfiles.ts")>();
	return { ...actual, sweepOrphans: vi.fn(actual.sweepOrphans) };
});

let fixture: ScenarioFixture | undefined;
let terminal: TerminalFixture | undefined;
afterEach(async () => {
	await terminal?.dispose();
	await fixture?.shutdown();
	fixture?.cleanup();
	fixture = undefined;
	terminal = undefined;
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
		tool("monitor_start", { argv: ["fixture"], name: "blocked" }),
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
			tool("monitor_start", { argv: ["fixture"], name: "still-usable" }),
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

it("surfaces an unexpected widget adapter error, retains owned children for cleanup, and refreshes the live widget theme", async () => {
	terminal = new TerminalFixture();
	const own = terminal;
	vi.spyOn(Date, "now").mockImplementation(() => own.clock.now());
	const children = new ControlledProcesses(own.clock);
	let failWidget = true;
	let recolor = false;
	let mounted: Component | undefined;
	const monitor: ExtensionFactory = (pi) =>
		register(pi, configFor("monitor"), join(own.root, "monitors"), { clock: own.clock, spawnMonitor: children.spawn });
	const observe: ExtensionFactory = (pi) => {
		pi.on("session_start", (_event, ctx) => {
			const setWidget = ctx.ui.setWidget.bind(ctx.ui);
			ctx.ui.setWidget = (key, content, options) => {
				if (typeof content !== "function") return setWidget(key, content, options);
				if (key !== WIDGET_KEY) return setWidget(key, content, options);
				if (failWidget) {
					failWidget = false;
					throw new Error("fixture widget adapter failed");
				}
				setWidget(
					key,
					(tui, theme) => {
						const liveTheme = new Proxy(theme, {
							get(target, name, receiver) {
								if (name === "fg")
									return (...args: Parameters<typeof theme.fg>) =>
										`${recolor ? "\u001b[35m" : ""}${target.fg(...args)}`;
								return Reflect.get(target, name, receiver);
							},
						});
						mounted = content(tui, liveTheme);
						return mounted;
					},
					options,
				);
			};
		});
	};
	const host = await terminal.startTerminal(configFor(), { extensionFactories: [monitor, observe] });
	host.harness.setResponses([
		tool("monitor_start", { argv: ["fixture"], name: "first" }),
		fauxAssistantMessage("error surfaced"),
	]);
	await host.harness.session.prompt("first watcher");
	expect(outcomes(host.harness, "monitor_start")[0]).toMatchObject({
		isError: true,
		text: expect.stringContaining("fixture widget adapter failed"),
	});
	expect(children.last.alive).toBe(true);
	host.harness.setResponses([
		tool("monitor_start", { argv: ["fixture"], name: "second" }),
		fauxAssistantMessage("recovered"),
	]);
	await host.harness.session.prompt("second watcher");
	await host.settle();
	expect(outcomes(host.harness, "monitor_start").at(-1)?.isError).toBe(false);
	if (!mounted) throw new Error("No mounted monitor widget");
	const before = mounted.render(100);
	expect(before.join("\n")).toContain("first");
	expect(before.join("\n")).toContain("second");
	recolor = true;
	mounted.invalidate();
	const after = mounted.render(100);
	expect(after).not.toEqual(before);
	expect(after.map(visibleWidth)).toEqual(before.map(visibleWidth));
	await terminal.dispose();
	expect(children.children.map((child) => child.alive)).toEqual([false, false]);
	expect(terminal.clock.pending).toBe(0);
});
