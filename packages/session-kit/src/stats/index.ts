/**
 * `/stats`: Claude Code's usage stats pane over every pi session on this machine. A command, not a
 * tool, so Plan mode allows it. Outside the TUI it prints a per-model table instead.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type Clock, realClock } from "../clock.ts";
import type { KitConfig } from "../config.ts";
import { say } from "../output.ts";
import { StatsView, summary } from "./component.ts";
import { freshnessLines } from "./freshness.ts";
import { agentDir, type Loaded } from "./load.ts";
import { type Combined, coverageLabel, loadCombined } from "./snapshot.ts";

const STATUS_KEY = "session-kit:stats";
export const MESSAGE_TYPE = "session-kit:stats";

/** What could not be read, so partial totals never pass for complete ones. */
function problems({ errors, badLines }: Pick<Loaded, "errors" | "badLines">): string[] {
	return [
		...(errors > 0 ? [`/stats: ${errors} local session/cache errors`] : []),
		...(badLines > 0 ? [`/stats: ! ${badLines} unreadable lines`] : []),
	];
}

export function register(
	pi: ExtensionAPI,
	_config: KitConfig,
	options: { agentDir?: string; homeDir?: string; clock?: Clock } = {},
): void {
	const clock = options.clock ?? realClock;
	pi.registerCommand("stats", {
		description: "Usage stats: activity heatmap, tokens per day and per-model breakdown across all sessions",
		async handler(args: string, ctx: ExtensionCommandContext) {
			if (args.trim()) {
				ctx.ui.notify("usage: /stats", "warning");
				return;
			}
			const tui = ctx.mode === "tui";
			if (tui) ctx.ui.setStatus(STATUS_KEY, "stats: loading...");
			let loaded: Combined;
			try {
				loaded = await loadCombined(
					options.agentDir ?? agentDir(options.homeDir),
					tui ? (done, total) => ctx.ui.setStatus(STATUS_KEY, `stats: loading ${done}/${total}...`) : undefined,
				);
			} catch (error) {
				say(pi, ctx, MESSAGE_TYPE, `/stats: ${(error as Error).message}`, "error");
				return;
			} finally {
				if (tui) ctx.ui.setStatus(STATUS_KEY, undefined);
			}

			const damage = [...problems(loaded), ...loaded.coverage.problems.map((p) => `/stats: ${p}`)];
			const coverage = coverageLabel(loaded.coverage);
			const freshness = freshnessLines(loaded.coverage, clock.now());
			if (!tui) {
				say(
					pi,
					ctx,
					MESSAGE_TYPE,
					[summary(loaded.calls.filter((c) => c.ms <= clock.now())), coverage, ...freshness, ...damage].join("\n"),
					"info",
				);
				return;
			}
			for (const line of damage) ctx.ui.notify(line, "warning");
			if (loaded.calls.length === 0) {
				ctx.ui.notify(`/stats: no usage recorded yet\n${coverage}\n${freshness.join("\n")}`, "info");
				return;
			}
			const { calls, sessions, badLines } = loaded;
			await ctx.ui.custom<void>(
				(tuiHost, theme, _kb, done) =>
					new StatsView({
						calls,
						sessions,
						badLines,
						coverage,
						freshness,
						now: clock.now(),
						theme,
						rows: () => tuiHost.terminal.rows,
						requestRender: () => tuiHost.requestRender(),
						onClose: () => done(),
					}),
				{ overlay: true, overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 } },
			);
		},
	});
}
