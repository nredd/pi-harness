/**
 * `/diff [ref]`: read-only overlay over `git diff` (work tree + index vs HEAD, or vs `ref`) plus
 * untracked files. A command, not a tool, so Plan mode allows it. Outside the TUI it prints the
 * `--stat` instead.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { KitConfig } from "../config.ts";
import { say } from "../output.ts";
import { DiffView } from "./component.ts";
import { loadDiff, loadStat } from "./git.ts";

const STATUS_KEY = "session-kit:diff";
export const MESSAGE_TYPE = "session-kit:diff";

export function register(pi: ExtensionAPI, _config: KitConfig): void {
	pi.registerCommand("diff", {
		description: "Browse the git diff (work tree + staged vs HEAD, or vs <ref>) and untracked files",
		async handler(args: string, ctx: ExtensionCommandContext) {
			const words = args.trim().split(/\s+/).filter(Boolean);
			if (words.length > 1) {
				ctx.ui.notify("usage: /diff [ref]", "warning");
				return;
			}
			const ref = words[0];

			if (ctx.mode !== "tui") {
				const stat = await loadStat(ctx.cwd, ref);
				if (!stat.ok) say(pi, ctx, MESSAGE_TYPE, `/diff: ${stat.error}`, "error");
				else say(pi, ctx, MESSAGE_TYPE, stat.text || "/diff: no changes", "info");
				return;
			}

			ctx.ui.setStatus(STATUS_KEY, "diff: loading...");
			let loaded: Awaited<ReturnType<typeof loadDiff>>;
			try {
				loaded = await loadDiff(ctx.cwd, ref);
			} finally {
				ctx.ui.setStatus(STATUS_KEY, undefined);
			}
			if (!loaded.ok) {
				ctx.ui.notify(`/diff: ${loaded.error}`, "error");
				return;
			}
			if (loaded.files.length === 0) {
				ctx.ui.notify(`/diff: no changes vs ${loaded.label}`, "info");
				return;
			}
			const { files, label, notices } = loaded;
			await ctx.ui.custom<void>(
				(tui, theme, _kb, done) =>
					new DiffView({
						files,
						label,
						notices,
						theme,
						rows: () => tui.terminal.rows,
						requestRender: () => tui.requestRender(),
						onClose: () => done(),
					}),
				{ overlay: true, overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 } },
			);
		},
	});
}
