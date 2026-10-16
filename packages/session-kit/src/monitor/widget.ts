/** One widget row per running monitor (TUI only). Renders live from the manager, never from copies. */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { formatDuration } from "./messages.ts";
import type { MonitorInfo } from "./types.ts";

export const WIDGET_KEY = "session-kit:monitors";
const TICK_MS = 1_000;

export function formatRow(info: MonitorInfo, now: number, theme: Pick<Theme, "fg">): string {
	const parts = [
		theme.fg("success", "●"),
		` ${theme.fg("accent", info.name)}`,
		theme.fg("muted", `  ${info.id}  ${formatDuration(now - info.startedAt)}  ${info.lines} lines`),
	];
	if (info.match) parts.push(theme.fg("muted", `  match /${info.match}/`));
	else if (info.wake) parts.push(theme.fg("muted", "  wake"));
	return parts.join("");
}

export class MonitorWidget {
	private ctx: ExtensionContext | undefined;
	private visible = false;
	private requestRender: (() => void) | undefined;
	private timer: NodeJS.Timeout | undefined;

	constructor(private readonly running: () => MonitorInfo[]) {}

	/** Bind to the session's UI; a no-op outside the TUI. */
	attach(ctx: ExtensionContext): void {
		if (ctx.mode === "tui") this.ctx = ctx;
	}

	/** Show or hide the widget to match the manager, and repaint. */
	refresh(): void {
		const ctx = this.ctx;
		if (!ctx) return;
		const any = this.running().length > 0;
		if (any && !this.visible) {
			ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
				this.requestRender = () => tui.requestRender();
				return {
					render: (width: number) =>
						this.running().map((info) => truncateToWidth(formatRow(info, Date.now(), theme), width, "…")),
					invalidate() {},
				};
			});
			this.visible = true;
			this.startTicking();
		} else if (!any && this.visible) {
			this.hide();
		}
		this.requestRender?.();
	}

	/** Remove the widget and stop the timer. */
	dispose(): void {
		this.hide();
		this.ctx = undefined;
	}

	private hide(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		if (this.visible) this.ctx?.ui.setWidget(WIDGET_KEY, undefined);
		this.visible = false;
		this.requestRender = undefined;
	}

	private startTicking(): void {
		this.timer = setInterval(() => this.requestRender?.(), TICK_MS);
		this.timer.unref();
	}
}
