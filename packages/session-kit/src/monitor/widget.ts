/**
 * Above-editor monitors panel, laid out like the Todos and subagents widgets: a disclosure heading
 * (clickable, plus a configurable shortcut), one bulleted row per monitor with flush-right stats,
 * and a fixed-height scroll window. It is display only: passive monitor output still stays in the
 * ring buffer and never enters the transcript or model context.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type TUI, type TuiMouseEvent, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { COLLAPSE_KEY_OFF } from "../config.ts";
import { formatDuration } from "./messages.ts";
import type { MonitorInfo } from "./types.ts";

export const WIDGET_KEY = "session-kit:monitors";
const TICK_MS = 1_000;

type WidgetTheme = Pick<Theme, "fg">;
type Color = Parameters<Theme["fg"]>[0];

export type MonitorState = "running" | "matched" | "failed" | "exited";

const STATE_COLOR: Record<MonitorState, Color> = {
	running: "success",
	matched: "warning",
	failed: "error",
	exited: "dim",
};

/** Bullet state: a running monitor that has matched, a non-clean end, or a clean/requested end. */
export function monitorState(info: MonitorInfo): MonitorState {
	if (info.status === "running") return info.matches > 0 ? "matched" : "running";
	if (info.status === "timeout") return "failed";
	if (info.status === "stopped") return "exited";
	return info.exitCode === 0 && info.signal === null ? "exited" : "failed";
}

/** A slice `[start, end)` of the rows plus which edge hints take a row. */
export interface MonitorWindow {
	start: number;
	end: number;
	above: boolean;
	below: boolean;
	maxOffset: number;
}

/**
 * Window of exactly `budget` rows over `total` monitors from `offset`: each visible edge hint costs
 * a row, so the panel height never changes while scrolling (budget >= 3 keeps every position
 * showing at least one monitor).
 */
export function windowFor(total: number, budget: number, offset: number): MonitorWindow {
	if (total <= budget) return { start: 0, end: total, above: false, below: false, maxOffset: 0 };
	const maxOffset = total - (budget - 1);
	const start = Math.max(0, Math.min(maxOffset, offset));
	if (start === 0) return { start, end: budget - 1, above: false, below: true, maxOffset };
	if (start === maxOffset) return { start, end: total, above: true, below: false, maxOffset };
	return { start, end: start + budget - 2, above: true, below: true, maxOffset };
}

/** `left` truncated first so `right` survives; never wider than `width` (a wrap desyncs pi's diff). */
function rightAlign(left: string, right: string, width: number): string {
	const rightWidth = visibleWidth(right);
	const clamped = truncateToWidth(left, Math.max(0, width - rightWidth - 1), "…");
	const gap = Math.max(1, width - visibleWidth(clamped) - rightWidth);
	return truncateToWidth(clamped + " ".repeat(gap) + right, width, "…");
}

export interface WidgetView {
	collapsed: boolean;
	offset: number;
	/** Row budget including the heading. */
	maxLines: number;
	/** Shortcut shown in the collapsed hint, or `"off"`. */
	collapseKey: string;
	/** Show every row (pi's tool-output expansion) instead of the budget. */
	showAll?: boolean;
}

export interface RenderedWidget {
	lines: string[];
	/** The offset actually used after clamping to the window. */
	offset: number;
	/** Largest scroll offset (0 when everything fits). */
	maxOffset: number;
}

function headingText(infos: MonitorInfo[]): string {
	const running = infos.filter((i) => i.status === "running").length;
	const failed = infos.filter((i) => monitorState(i) === "failed").length;
	const done = infos.length - running - failed;
	const parts = [
		running ? `${running} running` : "",
		failed ? `${failed} failed` : "",
		done ? `${done} done` : "",
	].filter(Boolean);
	return `Monitors (${parts.join(" · ")})`;
}

function rowLine(info: MonitorInfo, now: number, width: number, theme: WidgetTheme): string {
	const bullet = theme.fg(STATE_COLOR[monitorState(info)], "●");
	const last = info.lastLine === undefined || info.lastLine === "" ? "(no output)" : info.lastLine;
	const left = `${bullet} ${info.name}  ${theme.fg("dim", last)}`;
	const elapsed = formatDuration((info.endedAt ?? now) - info.startedAt);
	const stats = theme.fg("dim", `${elapsed} · ${info.lines} ${info.lines === 1 ? "line" : "lines"}`);
	return rightAlign(left, stats, width);
}

/** Pure render: collapsed is heading plus spacer, expanded is a constant-height window. */
export function renderWidget(
	infos: MonitorInfo[],
	now: number,
	width: number,
	theme: WidgetTheme,
	view: WidgetView,
): RenderedWidget {
	if (infos.length === 0) return { lines: [], offset: 0, maxOffset: 0 };
	const anyRunning = infos.some((i) => i.status === "running");
	const color: Color = anyRunning ? "accent" : "dim";
	const disclosure = theme.fg("dim", view.collapsed ? "▸" : "▾");
	const head = `${disclosure} ${theme.fg(color, anyRunning ? "●" : "○")} ${theme.fg(color, headingText(infos))}`;

	if (view.collapsed) {
		const hint = view.collapseKey === COLLAPSE_KEY_OFF ? "collapsed" : `${view.collapseKey} to expand`;
		return { lines: [rightAlign(head, theme.fg("dim", hint), width), ""], offset: 0, maxOffset: 0 };
	}

	const budget = view.showAll ? infos.length : view.maxLines - 1;
	const win = windowFor(infos.length, budget, view.offset);
	const rows: string[] = [];
	if (win.above) rows.push(theme.fg("dim", `↑ ${win.start} more`));
	for (const info of infos.slice(win.start, win.end)) rows.push(rowLine(info, now, Math.max(0, width - 3), theme));
	if (win.below) rows.push(theme.fg("dim", `↓ ${infos.length - win.end} more`));

	const lines = [truncateToWidth(head, width, "…")];
	rows.forEach((row, i) => {
		const connector = theme.fg("dim", i === rows.length - 1 ? "└─" : "├─");
		lines.push(truncateToWidth(`${connector} ${row}`, width, "…"));
	});
	lines.push("");
	return { lines, offset: win.start, maxOffset: win.maxOffset };
}

export interface WidgetOptions {
	maxLines: number;
	collapseKey: string;
	now?: () => number;
}

export class MonitorWidget {
	private ctx: ExtensionContext | undefined;
	private visible = false;
	private tui: TUI | undefined;
	private timer: NodeJS.Timeout | undefined;
	private collapsed = false;
	private offset = 0;
	private maxOffset = 0;

	/** `list` is every retained monitor; the panel shows while at least one is running. */
	constructor(
		private readonly list: () => MonitorInfo[],
		private readonly options: WidgetOptions,
	) {}

	/** Bind to the session's UI; a no-op outside the TUI. */
	attach(ctx: ExtensionContext): void {
		if (ctx.mode === "tui") this.ctx = ctx;
	}

	isVisible(): boolean {
		return this.visible;
	}

	isCollapsed(): boolean {
		return this.collapsed;
	}

	/** Collapse or expand, resetting the scroll position; a full redraw covers the height step. */
	toggle(): void {
		this.collapsed = !this.collapsed;
		this.offset = 0;
		this.tui?.requestRender(true);
	}

	/** Show or hide the widget to match the manager, and repaint. */
	refresh(): void {
		const ctx = this.ctx;
		if (!ctx) return;
		const any = this.list().some((i) => i.status === "running");
		if (any && !this.visible) {
			ctx.ui.setWidget(
				WIDGET_KEY,
				(tui, theme) => {
					this.tui = tui;
					return {
						render: (width: number) => this.render(width, theme),
						handleMouse: (event: TuiMouseEvent) => this.handleMouse(event),
						invalidate() {},
					};
				},
				{ placement: "aboveEditor" },
			);
			this.visible = true;
			this.startTicking();
		} else if (!any && this.visible) {
			this.hide();
		}
		this.tui?.requestRender();
	}

	/** Remove the widget and stop the timer. */
	dispose(): void {
		this.hide();
		this.ctx = undefined;
	}

	private render(width: number, theme: WidgetTheme): string[] {
		const out = renderWidget(this.list(), (this.options.now ?? Date.now)(), width, theme, {
			collapsed: this.collapsed,
			offset: this.offset,
			maxLines: this.options.maxLines,
			collapseKey: this.options.collapseKey,
			showAll: this.ctx?.ui.getToolsExpanded?.() === true,
		});
		this.offset = out.offset;
		this.maxOffset = out.maxOffset;
		return out.lines;
	}

	private handleMouse(event: TuiMouseEvent): { handled: true } | undefined {
		if (event.type === "click" && event.button === "left" && event.y === 0) {
			this.toggle();
			return { handled: true };
		}
		if (event.type !== "wheel" || this.collapsed) return undefined;
		const next = Math.max(0, Math.min(this.maxOffset, this.offset + Math.trunc(event.wheelDelta ?? 0)));
		if (next === this.offset) return undefined;
		this.offset = next;
		this.tui?.requestRender();
		return { handled: true };
	}

	private hide(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		if (this.visible) this.ctx?.ui.setWidget(WIDGET_KEY, undefined);
		this.visible = false;
		this.tui = undefined;
	}

	private startTicking(): void {
		// Collapsed rows show no elapsed time; counts repaint through `refresh` on state changes.
		this.timer = setInterval(() => {
			if (!this.collapsed) this.tui?.requestRender();
		}, TICK_MS);
		this.timer.unref();
	}
}
