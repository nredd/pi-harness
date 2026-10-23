/** Responsive, cached /mon dashboard. Rendering and navigation never collect resources. */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Key, matchesKey } from "@earendil-works/pi-tui";
import { fitCols, sanitize } from "../diff/view.ts";
import {
	bytes,
	type MonProcess,
	type MonSnapshot,
	type MonSort,
	percent,
	SORTS,
	sortProcesses,
	sparkline,
} from "./model.ts";

export interface MonViewOptions {
	theme: Pick<Theme, "fg" | "bold" | "bg">;
	rows: () => number;
	requestRender: () => void;
	onClose: () => void;
}

/** Single-interaction view; update is the sole ingress for sampler data. */
export class MonView implements Component {
	private snapshot: MonSnapshot | undefined;
	private history: (number | null)[] = [];
	private processes: MonProcess[] = [];
	private selected: string | undefined;
	private sort: MonSort = "cpu";
	private help = false;
	private scroll = 0;
	private pageSize = 1;
	private cache: { width: number; height: number; lines: string[] } | undefined;

	constructor(private readonly options: MonViewOptions) {}

	get state(): { selected: string | undefined; sort: MonSort; historyLength: number; scroll: number } {
		return { selected: this.selected, sort: this.sort, historyLength: this.history.length, scroll: this.scroll };
	}

	update(snapshot: MonSnapshot): void {
		this.snapshot = snapshot;
		this.history.push(snapshot.status === "stale" ? null : snapshot.cpuPercent);
		if (this.history.length > 120) this.history.shift();
		this.reorder();
		this.refresh();
	}

	invalidate(): void {
		this.cache = undefined;
	}

	private refresh(): void {
		this.invalidate();
		this.options.requestRender();
	}

	private reorder(): void {
		const oldIndex = Math.max(
			0,
			this.processes.findIndex((p) => p.identity === this.selected),
		);
		this.processes = sortProcesses(this.snapshot?.processes ?? [], this.sort);
		if (!this.processes.some((p) => p.identity === this.selected)) {
			this.selected = this.processes[Math.min(oldIndex, this.processes.length - 1)]?.identity;
		}
	}

	handleInput(data: string): void {
		if (data === "q" || matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.options.onClose();
			return;
		}
		let index = Math.max(
			0,
			this.processes.findIndex((p) => p.identity === this.selected),
		);
		if (data === "?") this.help = !this.help;
		else if (data === "c" || data === "m" || data === "p" || data === "s") {
			this.sort =
				data === "c"
					? "cpu"
					: data === "m"
						? "rss"
						: data === "p"
							? "pid"
							: (SORTS[(SORTS.indexOf(this.sort) + 1) % SORTS.length] ?? "cpu");
			this.reorder();
		} else {
			if (data === "j" || matchesKey(data, Key.down)) index++;
			else if (data === "k" || matchesKey(data, Key.up)) index--;
			else if (matchesKey(data, Key.pageDown)) index += this.pageSize;
			else if (matchesKey(data, Key.pageUp)) index -= this.pageSize;
			else if (data === "g" || matchesKey(data, Key.home)) index = 0;
			else if (data === "G" || matchesKey(data, Key.end)) index = this.processes.length - 1;
			else return;
			this.selected = this.processes[Math.max(0, Math.min(this.processes.length - 1, index))]?.identity;
		}
		this.refresh();
	}

	private panel(title: string, lines: string[], width: number): string[] {
		const { theme } = this.options;
		const inner = Math.max(0, width - 2);
		return [
			theme.fg("border", "╭") + theme.fg("accent", fitCols(` ${title} `, inner)) + theme.fg("border", "╮"),
			...lines.map((line) => theme.fg("border", "│") + fitCols(line, inner) + theme.fg("border", "│")),
			theme.fg("border", `╰${"─".repeat(inner)}╯`),
		];
	}

	private cards(width: number): string[] {
		const s = this.snapshot;
		const t = this.options.theme;
		const wide = width >= 100;
		const leftWidth = wide ? Math.floor((width - 2) * 0.58) : width;
		const total = s?.memoryTotalBytes ?? null;
		const used = s?.memoryUsedBytes ?? null;
		const ratio = total && used !== null ? Math.max(0, Math.min(1, used / total)) : null;
		const meterWidth = Math.max(1, Math.min(24, (wide ? width - leftWidth - 2 : width) - 8));
		const full = ratio === null ? 0 : Math.round(ratio * meterWidth);
		const cpu = this.panel(
			"CPU / interval",
			[
				` ${t.bold(percent(s?.cpuPercent ?? null))} ${t.fg("muted", `of ${s?.logicalCpus ?? "--"} logical CPUs`)}`,
				` ${t.fg("accent", fitCols(sparkline(this.history, leftWidth - 4), leftWidth - 4))}`,
				` ${t.fg("dim", "scale 0..100% · newest at right")}`,
			],
			leftWidth,
		);
		const memory = this.panel(
			"MEMORY / load",
			[
				` ${t.bold(bytes(used))} ${t.fg("muted", `/ ${bytes(total)} non-free`)}`,
				` ${t.fg("success", "━".repeat(full))}${t.fg("dim", "─".repeat(meterWidth - full))} ${ratio === null ? "--" : `${Math.round(ratio * 100)}%`}`,
				` ${t.fg("muted", "load 1 / 5 / 15")}  ${s?.load.map((n) => (Number.isFinite(n) ? n.toFixed(2) : "--")).join("  ") || "--"}`,
			],
			wide ? width - leftWidth - 2 : width,
		);
		return wide ? cpu.map((line, i) => `${line}  ${memory[i] ?? ""}`) : [...cpu, ...memory];
	}

	render(width: number): string[] {
		const height = Math.max(1, this.options.rows());
		width = Math.max(1, width);
		if (this.cache?.width === width && this.cache.height === height) return this.cache.lines;
		const t = this.options.theme;
		const status = this.snapshot?.status ?? "warming";
		const statusColor = status === "live" ? "success" : "warning";
		const footer = t.fg(
			"muted",
			width < 60 ? " q/Esc close  ? help  s sort" : " q/Esc close  ? help  j/k move  PgUp/PgDn page  c/m/p sort",
		);
		if (height === 1) return [fitCols(footer, width)];
		const lines = [
			t.bold(t.fg("accent", " MON")) +
				`  ${t.fg(statusColor, status.toUpperCase())}` +
				t.fg("dim", width >= 60 ? "  LOCAL RESOURCES / read only" : "  read only"),
		];
		if (this.help) {
			lines.push(
				"",
				t.bold(" Navigation"),
				" j/k or arrows   select process",
				" PgUp/PgDn       move one page",
				" g/G             first/last",
				" c CPU  m RSS    descending",
				" p PID           ascending",
				" s               cycle sort",
				" ?               return to dashboard",
				" q/Esc           close",
				"",
				" CPU is interval usage, not lifetime CPU.",
				" Process CPU can exceed 100% (one core).",
				" -- is unavailable, never zero.",
				" Selection follows identity, not row.",
				" RAM is total minus free, not pressure.",
				" Read only. No kill, locks or scheduling.",
			);
		} else {
			if (height >= 16 && width >= 60) lines.push(...this.cards(width));
			else if (height >= 6) {
				lines.push(
					` CPU ${t.fg("accent", percent(this.snapshot?.cpuPercent ?? null))}  RAM ${bytes(this.snapshot?.memoryUsedBytes ?? null)}/${bytes(this.snapshot?.memoryTotalBytes ?? null)}`,
				);
				lines.push(` ${t.fg("accent", sparkline(this.history, width - 2))}`);
			}
			if (this.snapshot?.notice && height >= 8) lines.push(t.fg("warning", ` ${sanitize(this.snapshot.notice)}`));
			lines.push(
				t.fg(
					"accent",
					` BUSY PROCESSES  ${this.processes.length} total  ${this.sort.toUpperCase()} ${this.sort === "pid" ? "↑" : "↓"}`,
				),
			);
			const compact = width < 60;
			const pidWidth = compact ? 6 : 8;
			const cpuWidth = 8;
			const rssWidth = compact ? 6 : 9;
			const nameWidth = Math.max(1, width - pidWidth - cpuWidth - rssWidth - 3);
			const row = (pid: string, name: string, cpu: string, rss: string) =>
				` ${fitCols(pid, pidWidth)} ${fitCols(name, nameWidth)}${cpu.padStart(cpuWidth)}${rss.padStart(rssWidth)}`;
			lines.push(t.fg("muted", row("PID", "PROCESS", "CPU%", "RSS")));
			this.pageSize = Math.max(1, height - lines.length - 2);
			const index = Math.max(
				0,
				this.processes.findIndex((p) => p.identity === this.selected),
			);
			this.scroll = Math.min(this.scroll, Math.max(0, this.processes.length - this.pageSize));
			if (index < this.scroll) this.scroll = index;
			if (index >= this.scroll + this.pageSize) this.scroll = index - this.pageSize + 1;
			for (const p of this.processes.slice(this.scroll, this.scroll + this.pageSize)) {
				const text = fitCols(row(String(p.pid), sanitize(p.name), percent(p.cpuPercent), bytes(p.rssBytes)), width);
				lines.push(p.identity === this.selected ? t.bg("selectedBg", t.fg("text", text)) : text);
			}
			if (this.processes.length === 0) lines.push(t.fg("dim", " Waiting for process sample..."));
			if (lines.length < height - 1)
				lines.push(
					t.fg(
						"dim",
						` ${this.processes.length ? index + 1 : 0}/${this.processes.length} selected · CPU: one core = 100%`,
					),
				);
		}
		const clipped = lines.slice(0, height - 1);
		while (clipped.length < height - 1) clipped.push("");
		clipped.push(footer);
		const result = clipped.map((line) => fitCols(line, width));
		this.cache = { width, height, lines: result };
		return result;
	}
}
