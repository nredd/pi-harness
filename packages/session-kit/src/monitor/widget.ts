/** Quiet above-editor summary of running monitors. */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatDuration } from "./messages.ts";
import type { MonitorInfo } from "./types.ts";

export const WIDGET_KEY = "session-kit:monitors";
const TICK_MS = 1_000;

type WidgetTheme = Pick<Theme, "fg">;

function monitorSummary(info: MonitorInfo, now: number): string {
	return `${info.name} ${formatDuration(now - info.startedAt)} ${info.lines} lines last: ${info.lastLine ?? "(no output)"}`;
}

/** Render one compact summary, favouring the newest monitor when all do not fit. */
export function formatSummary(infos: MonitorInfo[], now: number, width: number, theme: WidgetTheme): string[] {
	if (infos.length === 0) return [];
	const count = `${infos.length} monitor${infos.length === 1 ? "" : "s"}`;
	const all = `● ${count}  ${infos.map((info) => monitorSummary(info, now)).join("  ")}`;
	if (visibleWidth(all) <= width) return [theme.fg("success", "●") + theme.fg("muted", all.slice(1))];
	const newest = infos.reduce((latest, info) => (info.startedAt > latest.startedAt ? info : latest));
	const compact = `● ${count}  ${monitorSummary(newest, now)}`;
	return [truncateToWidth(theme.fg("success", "●") + theme.fg("muted", compact.slice(1)), width, "…")];
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
					render: (width: number) => formatSummary(this.running(), Date.now(), width, theme),
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
