/**
 * todo-overlay.ts — Persistent widget showing todo list above the editor.
 *
 * Lifecycle controller for Pi's `setWidget` contract: factory-form
 * registration in widgetContainerAbove, register-once + requestRender()
 * refresh, a mouse-wheel scrollable window (default 12 content rows via
 * getMaxWidgetLines(); plus a trailing spacer row so the widget renders up
 * to 13 lines) over ALL todos, Pi tool-output expansion awareness, auto-hide
 * when empty.
 *
 * Reads live state via `getRenderState()` (the ctx-less foreground slot) at render
 * time — NEVER `replayFromBranch` from `tool_execution_end` (branch is stale;
 * `message_end` runs after).
 */

import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { type TUI, type TuiMouseEvent, truncateToWidth } from "@earendil-works/pi-tui";
import { getMaxWidgetLines } from "./config.ts";
import { formatProgress, t } from "./state/i18n-bridge.ts";
import { selectHasActive, selectVisibleTasks } from "./state/selectors.ts";
import { getRenderState } from "./state/store.ts";
import { formatOverlayTaskLine } from "./view/format.ts";

const WIDGET_KEY = "rpiv-todos";

// English fallbacks for localized overlay chrome strings.
const OVERLAY_HEADING = "Todos";
const OVERLAY_ABOVE = "above";
const OVERLAY_BELOW = "below";

/** A slice of the todo list: `[start, end)` plus which edge hints take a row. */
interface TodoWindow {
	start: number;
	end: number;
	above: boolean;
	below: boolean;
}

/**
 * Window of `budget` rows over `total` todos starting at `offset`. Overflowing
 * lists spend one row per visible edge hint, so the widget is always exactly
 * `budget` rows tall. `maxOffset` is the last start index (no hint below).
 */
export function windowFor(total: number, budget: number, offset: number): TodoWindow & { maxOffset: number } {
	if (total <= budget) return { start: 0, end: total, above: false, below: false, maxOffset: 0 };
	const maxOffset = total - (budget - 1);
	const start = Math.max(0, Math.min(maxOffset, offset));
	if (start === 0) return { start, end: budget - 1, above: false, below: true, maxOffset };
	if (start === maxOffset) return { start, end: total, above: true, below: false, maxOffset };
	return { start, end: start + budget - 2, above: true, below: true, maxOffset };
}

export class TodoOverlay {
	constructor(private readonly homeDir?: string) {}

	private uiCtx: ExtensionUIContext | undefined;
	private widgetRegistered = false;
	private tui: TUI | undefined;
	private collapsed = false;
	private scrollOffset = 0;
	private lastActiveId: number | undefined;

	setUICtx(ctx: ExtensionUIContext): void {
		// Identity-compare so repeat session_start handlers are idempotent;
		// on identity change (/reload) invalidate so update() re-registers.
		if (ctx !== this.uiCtx) {
			this.uiCtx = ctx;
			this.widgetRegistered = false;
			this.tui = undefined;
		}
	}

	update(): void {
		if (!this.uiCtx) return;
		if (selectVisibleTasks(getRenderState()).length === 0) {
			if (this.widgetRegistered) {
				this.uiCtx.setWidget(WIDGET_KEY, undefined);
				this.widgetRegistered = false;
				this.tui = undefined;
			}
			return;
		}

		if (!this.widgetRegistered) {
			this.uiCtx.setWidget(
				WIDGET_KEY,
				(tui, factoryTheme) => {
					this.tui = tui;
					return {
						render: (width: number) => this.renderWidget(this.uiCtx?.theme ?? factoryTheme, width),
						handleMouse: (event: TuiMouseEvent) => this.handleMouse(event),
						invalidate: () => {
							// No rendered strings are cached. Pi invalidates on theme changes;
							// the next render reads uiCtx.theme.
						},
					};
				},
				{ placement: "aboveEditor" },
			);
			this.widgetRegistered = true;
		} else {
			this.tui?.requestRender();
		}
	}

	/** Start collapsed (no redraw: called before the widget is first registered). */
	collapse(): void {
		this.collapsed = true;
		this.scrollOffset = 0;
	}

	toggleCollapse(): void {
		this.collapsed = !this.collapsed;
		this.scrollOffset = 0;
		// Forced full redraw on the collapsed↔expanded height step, mirroring the
		// lane-dock's requestRender(shapeChanged); distinct from the non-forced
		// requestRender() refresh path in update().
		this.tui?.requestRender(true);
	}

	isRegistered(): boolean {
		return this.widgetRegistered;
	}

	private handleMouse(event: TuiMouseEvent): { handled: true } | undefined {
		if (event.type === "wheel") return this.scrollBy(event.wheelDelta ?? 0);
		if (event.type !== "click" || event.button !== "left" || event.y !== 0) return undefined;
		this.toggleCollapse();
		return { handled: true };
	}

	/** Rows the list may show: everything under tool-output expansion, else the configured budget. */
	private bodyBudget(total: number): number {
		return this.uiCtx?.getToolsExpanded?.() === true ? total : getMaxWidgetLines(this.homeDir) - 1;
	}

	/**
	 * Scroll by `delta` rows (negative = up). Handled only when the window moved,
	 * so a wheel at either limit (or over a list that fits) falls through to the
	 * transcript.
	 */
	private scrollBy(delta: number): { handled: true } | undefined {
		if (this.collapsed || delta === 0) return undefined;
		const total = selectVisibleTasks(getRenderState()).length;
		const { start, maxOffset } = windowFor(total, this.bodyBudget(total), this.scrollOffset);
		const next = Math.max(0, Math.min(maxOffset, start + Math.trunc(delta)));
		if (next === start) return undefined;
		this.scrollOffset = next;
		this.tui?.requestRender();
		return { handled: true };
	}

	private renderWidget(theme: Theme, width: number): string[] {
		const state = getRenderState();
		const tasks = selectVisibleTasks(state);
		if (tasks.length === 0) return [];

		const truncate = (line: string): string => truncateToWidth(line, width, "…");
		const hasActive = selectHasActive(state);

		const headingColor = hasActive ? "accent" : "dim";
		const headingIcon = hasActive ? "●" : "○";
		// Counts come from the full state, so every todo is accounted for.
		// Only the in-progress segment takes the warning color (same as its `◐` marker).
		const paint = (kind: "base" | "warning", text: string): string =>
			theme.fg(kind === "warning" ? "warning" : headingColor, text);
		const headingText = [
			paint("base", `${t("overlay.heading", OVERLAY_HEADING)} (`),
			formatProgress(state, paint),
			paint("base", ")"),
		].join("");
		const disclosure = this.collapsed ? "▸" : "▾";
		const heading = truncate(`${theme.fg("dim", disclosure)} ${theme.fg(headingColor, headingIcon)} ${headingText}`);

		// Collapsed view keeps only the clickable heading and the trailing spacer.
		if (this.collapsed) return this.withTrailingSpacer([heading]);

		// Budget for content rows (heading + tasks). The rendered widget is one line
		// taller — withTrailingSpacer() appends a blank row below the panel. Pi's
		// global tool-output expansion mode is read on every render so its
		// expand/collapse shortcut also expands this live widget.
		const budget = this.bodyBudget(tasks.length);
		this.followActiveTask(tasks, budget);
		const win = windowFor(tasks.length, budget, this.scrollOffset);
		this.scrollOffset = win.start;

		const rows: string[] = [];
		if (win.above) {
			rows.push(theme.fg("dim", `↑ ${win.start} ${t("overlay.above", OVERLAY_ABOVE)}`));
		}
		for (const task of tasks.slice(win.start, win.end)) rows.push(formatOverlayTaskLine(task, theme, true));
		if (win.below) {
			rows.push(theme.fg("dim", `↓ ${tasks.length - win.end} ${t("overlay.below", OVERLAY_BELOW)}`));
		}

		const lines = [heading];
		rows.forEach((row, i) => {
			const connector = i === rows.length - 1 ? "└─" : "├─";
			lines.push(truncate(`${theme.fg("dim", connector)} ${row}`));
		});
		return this.withTrailingSpacer(lines);
	}

	/**
	 * Bring the first in_progress task into view when it changes, so progress is
	 * visible without scrolling. A manual scroll sticks until the active task moves.
	 */
	private followActiveTask(tasks: readonly { id: number; status: string }[], budget: number): void {
		const active = tasks.findIndex((task) => task.status === "in_progress");
		const activeId = active === -1 ? undefined : tasks[active].id;
		if (activeId === this.lastActiveId) return;
		this.lastActiveId = activeId;
		if (active === -1) return;
		const win = windowFor(tasks.length, budget, this.scrollOffset);
		if (active >= win.start + (win.above ? 1 : 0) && active < win.end) return;
		this.scrollOffset = Math.max(0, active - 1);
	}

	/**
	 * Append a trailing blank line so the overlay isn't flush against the
	 * editor box. Pi's host adds a leading spacer above the widget but none
	 * below, which leaves the last "└─" row (or the "↓ N below" hint) glued
	 * to the input box. The empty string gives the "Todos" panel a little
	 * breathing room.
	 */
	private withTrailingSpacer(lines: string[]): string[] {
		if (lines.length === 0) return lines;
		lines.push("");
		return lines;
	}

	dispose(): void {
		if (this.uiCtx) this.uiCtx.setWidget(WIDGET_KEY, undefined);
		this.widgetRegistered = false;
		this.tui = undefined;
		this.uiCtx = undefined;
		this.collapsed = false;
		this.scrollOffset = 0;
		this.lastActiveId = undefined;
	}
}
