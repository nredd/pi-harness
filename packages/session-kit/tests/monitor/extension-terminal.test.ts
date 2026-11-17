import { join } from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-coding-agent/testing";
import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import { outcomes, toolCall } from "@nredd/pi-test-lib/faux";
import { afterEach, expect, it, vi } from "vitest";
import { register } from "../../src/monitor/index.ts";
import { WIDGET_KEY } from "../../src/monitor/widget.ts";
import { ControlledProcesses, configFor } from "../fixtures/session.ts";
import { TerminalFixture } from "../fixtures/terminal.ts";

let terminal: TerminalFixture | undefined;
afterEach(async () => {
	await terminal?.dispose();
	terminal = undefined;
	vi.restoreAllMocks();
});

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
		toolCall("monitor_start", { argv: ["fixture"], name: "first" }),
		fauxAssistantMessage("error surfaced"),
	]);
	await host.harness.session.prompt("first watcher");
	expect(outcomes(host.harness, "monitor_start")[0]).toMatchObject({
		isError: true,
		text: expect.stringContaining("fixture widget adapter failed"),
	});
	expect(children.last.alive).toBe(true);
	host.harness.setResponses([
		toolCall("monitor_start", { argv: ["fixture"], name: "second" }),
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
