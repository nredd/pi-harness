/** Responsive, cached /mon dashboard. Rendering and navigation never collect resources. */
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { fitCols, sanitize } from "../diff/view.ts";
import {
	bytes,
	type MonHistoryPoint,
	type MonProcess,
	type MonSnapshot,
	type MonSort,
	percent,
	SORTS,
	share,
	sortProcesses,
	timeHistory,
	timeHistoryRows,
} from "./model.ts";

export interface MonViewOptions {
	theme: Pick<Theme, "fg" | "bold" | "bg">;
	rows: () => number;
	requestRender: () => void;
	onClose: () => void;
}

type Color = Parameters<Theme["fg"]>[0];

/** Cards need this much room; below it a three-line summary keeps the process list usable. */
const CARD_MIN_WIDTH = 72;
const CARD_MIN_HEIGHT = 17;
const HISTORY_LIMIT = 120;

const HELP = [
	"*Keys",
	" j/k or arrows   select process",
	" PgUp/PgDn       move one page",
	" g/G             first/last",
	" c CPU  m RSS    descending",
	" p PID           ascending",
	" s               cycle sort",
	" ?               back to dashboard",
	" q/Esc           close",
	"",
	"*Reading it",
	" LIVE: the last collection succeeded;",
	" updated HH:MM:SS is when (local).",
	" CPU warming: first interval baseline,",
	" not a stale or failed sample.",
	" CPU is interval usage, not lifetime.",
	" Process CPU can exceed 100% (one core).",
	" -- is unavailable, never zero.",
	" RAM is total minus free, not pressure.",
	" MEM% is RSS over total RAM.",
	" Load 1/5/15 min: not percent.",
	" History: elapsed time, newest right;",
	" dots are gaps, blank is no data yet.",
	"",
	"*Processes",
	" Names are executable files, never",
	" arguments; still untrusted text.",
	" (unknown): no access, e.g. another",
	" user's process on Linux.",
	" macOS keeps 16 bytes of a name;",
	" a trailing … marks a possible cut.",
	" macOS: ps start time is whole seconds,",
	" so process CPU stays -- (sort: RSS).",
	" Lists can be partial; notices say why.",
	" Selection follows identity, not row.",
	" No kill, locks or scheduling.",
];

/** Local wall clock `HH:MM:SS`, display only. */
function clock(ms: number): string {
	const d = new Date(ms);
	return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

/** Single-interaction view; update is the sole ingress for sampler data. */
export class MonView implements Component {
	private snapshot: MonSnapshot | undefined;
	private history: MonHistoryPoint[] = [];
	private lastSuccess: number | undefined;
	private helpScroll = 0;
	private helpPageSize = 1;
	private helpLength = 0;
	private processes: MonProcess[] = [];
	private selected: string | undefined;
	private sort: MonSort = "cpu";
	private sortChosen = false;
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
		// Collector success is independent of CPU: a warming sample still carries fresh memory/processes.
		// A stale snapshot is not a new measurement, so it adds no history point.
		if (snapshot.status === "live") {
			this.lastSuccess = snapshot.capturedAt;
			// Leading samples without a CPU value are "no data yet" (blank), not gaps.
			if (snapshot.cpuPercent !== null || this.history.length > 0) {
				this.history.push({ sampledAtMs: snapshot.sampledAtMs, value: snapshot.cpuPercent });
				if (this.history.length > HISTORY_LIMIT) this.history.shift();
			}
		}
		// Never rank by a column that is unavailable for every row, unless the user asked for it.
		if (!this.sortChosen) this.sort = snapshot.processCpu === "unavailable" ? "rss" : "cpu";
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
		else if (this.help) {
			if (data === "j" || matchesKey(data, Key.down)) this.helpScroll++;
			else if (data === "k" || matchesKey(data, Key.up)) this.helpScroll--;
			else if (matchesKey(data, Key.pageDown)) this.helpScroll += this.helpPageSize;
			else if (matchesKey(data, Key.pageUp)) this.helpScroll -= this.helpPageSize;
			else if (data === "g" || matchesKey(data, Key.home)) this.helpScroll = 0;
			else if (data === "G" || matchesKey(data, Key.end)) this.helpScroll = this.helpLength;
			else return;
			this.helpScroll = Math.max(0, Math.min(this.helpScroll, this.helpLength - this.helpPageSize));
		} else if (data === "c" || data === "m" || data === "p" || data === "s") {
			this.sortChosen = true;
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

	/** `--` reads as absent, not as a value: dim it everywhere. */
	private value(text: string, width: number): string {
		const padded = text.padStart(width);
		return text === "--" ? this.options.theme.fg("dim", padded) : padded;
	}

	/** Host CPU severity, always paired with the number so meaning never depends on color. */
	private cpuColor(value: number | null): Color {
		return value === null ? "dim" : value >= 85 ? "error" : value >= 50 ? "warning" : "success";
	}

	private panel(title: string, lines: string[], width: number): string[] {
		const { theme } = this.options;
		const inner = Math.max(0, width - 2);
		const label = truncateToWidth(`─ ${title} `, inner, "…");
		return [
			theme.fg("border", "╭") +
				theme.fg("accent", label) +
				theme.fg("border", `${"─".repeat(Math.max(0, inner - visibleWidth(label)))}╮`),
			...lines.map((line) => theme.fg("border", "│") + fitCols(line, inner) + theme.fg("border", "│")),
			theme.fg("border", `╰${"─".repeat(inner)}╯`),
		];
	}

	/** `-- warming · 12 logical CPUs` or `36.2% of 12 logical CPUs`; capacity is omitted when compact. */
	private cpuSummary(capacity = true): string {
		const t = this.options.theme;
		const s = this.snapshot;
		const value = s?.cpuPercent ?? null;
		const state = this.cpuState();
		const head =
			value === null
				? t.fg("dim", "--")
				: s?.status === "stale"
					? t.fg("muted", percent(value))
					: t.bold(t.fg(this.cpuColor(value), percent(value)));
		if (!capacity) return `${head}${state}`;
		return `${head}${state} ${t.fg("muted", `${state ? "·" : "of"} ${s?.logicalCpus || "--"} logical CPUs`)}`;
	}

	private loads(): string {
		const load = this.snapshot?.load ?? [];
		return load.length ? load.map((n) => (Number.isFinite(n) ? n.toFixed(2) : "--")).join(" ") : "--";
	}

	private cards(width: number): string[] {
		const s = this.snapshot;
		const t = this.options.theme;
		const leftWidth = Math.floor((width - 2) * 0.58);
		const rightWidth = width - leftWidth - 2;
		const chartWidth = leftWidth - 4;
		const total = s?.memoryTotalBytes ?? null;
		const used = s?.memoryUsedBytes ?? null;
		const ratio = total && used !== null ? Math.max(0, Math.min(1, used / total)) : null;
		const meterWidth = Math.max(1, Math.min(28, rightWidth - 9));
		const full = ratio === null ? 0 : Math.round(ratio * meterWidth);
		const load1 = s?.load[0];
		const perCpu =
			typeof load1 === "number" && Number.isFinite(load1) && s?.logicalCpus ? (load1 / s.logicalCpus).toFixed(2) : "--";
		const cpu = this.panel(
			"CPU / interval",
			[
				` ${this.cpuSummary()}`,
				...timeHistoryRows(this.history, chartWidth, 2).map((row) => ` ${t.fg("accent", row)}`),
				` ${t.fg("dim", this.historyLabel())}`,
			],
			leftWidth,
		);
		const memory = this.panel(
			"MEMORY / load",
			[
				` ${t.bold(bytes(used))} ${t.fg("muted", `/ ${bytes(total)} non-free`)}`,
				` ${t.fg("accent", "━".repeat(full))}${t.fg("borderMuted", "─".repeat(meterWidth - full))} ${ratio === null ? t.fg("dim", "--") : `${Math.round(ratio * 100)}%`}`,
				` ${t.fg("muted", "load")} ${this.loads()}`,
				` ${t.fg("muted", "1/5/15 min ·")} ${perCpu === "--" ? t.fg("dim", perCpu) : perCpu} ${t.fg("muted", "per CPU")}`,
			],
			rightWidth,
		);
		return cpu.map((line, i) => `${line}  ${memory[i] ?? ""}`);
	}

	/** Compact three-line summary when cards do not fit. */
	private summary(width: number): string[] {
		const s = this.snapshot;
		const t = this.options.theme;
		const total = s?.memoryTotalBytes ?? null;
		const used = s?.memoryUsedBytes ?? null;
		const ram = `${bytes(used)}/${bytes(total)}`;
		return [
			` ${t.fg("muted", "CPU")} ${this.cpuSummary(false)}  ${t.fg("muted", "RAM")} ${ram}  ${t.fg("muted", "load")} ${this.loads().split(" ")[0]}`,
			` ${t.fg("accent", timeHistory(this.history, width - 2))}`,
			` ${t.fg("dim", this.historyLabel())}`,
		];
	}

	/** Why host CPU reads `--`; textual, so meaning never depends on color. */
	private cpuState(): string {
		if (this.snapshot?.status === "stale") return ` ${this.options.theme.fg("muted", "last value")}`;
		const state = this.snapshot?.cpuState;
		return state === "warming" || state === "unavailable" ? ` ${this.options.theme.fg("warning", state)}` : "";
	}

	private historyLabel(): string {
		const span = Math.max(0, (this.history.at(-1)?.sampledAtMs ?? 0) - (this.history[0]?.sampledAtMs ?? 0));
		return `0..100% · ${(span / 1000).toFixed(1)}s span · time →`;
	}

	/** Title, collector state, and when the shown data was collected. */
	private header(width: number): string {
		const t = this.options.theme;
		const status = this.snapshot?.status ?? "waiting";
		const [mark, color]: [string, Color] =
			status === "live" ? ["●", "success"] : status === "stale" ? ["▲", "warning"] : ["○", "warning"];
		const left =
			t.bold(t.fg("accent", " MON")) +
			`  ${t.fg(color, `${mark} ${status.toUpperCase()}`)}` +
			// Narrow terminals keep freshness over the tagline.
			(width >= 60 ? t.fg("dim", "  local resources · read only") : "");
		const scan = this.snapshot?.scanMs;
		const parts: string[] = [];
		if (this.lastSuccess !== undefined)
			parts.push(
				width >= 60
					? `${status === "stale" ? "last ok" : "updated"} ${clock(this.lastSuccess)}`
					: clock(this.lastSuccess),
			);
		if (width >= 80 && typeof scan === "number" && Number.isFinite(scan) && status === "live")
			parts.push(`scan ${Math.round(scan)}ms`);
		const right = parts.length ? t.fg("muted", `${parts.join(" · ")} `) : "";
		const gap = width - visibleWidth(left) - visibleWidth(right);
		return gap >= 2 ? `${left}${" ".repeat(gap)}${right}` : left;
	}

	private footer(width: number): string {
		const t = this.options.theme;
		const keys: [string, string][] = this.help
			? [
					["q/Esc", "close"],
					["?", "help"],
					["j/k PgDn", "scroll"],
				]
			: width < 60
				? [
						["q/Esc", "close"],
						["?", "help"],
						["s", "sort"],
					]
				: [
						["q/Esc", "close"],
						["?", "help"],
						["j/k", "move"],
						["PgUp/PgDn", "page"],
						["c/m/p", "sort"],
					];
		return ` ${keys.map(([key, label]) => `${t.fg("accent", key)} ${t.fg("muted", label)}`).join("  ")}`;
	}

	/** Process name cell: dim `(unknown)` for no name, dim `…` where the OS may have cut it. */
	private nameCell(p: MonProcess): string {
		const t = this.options.theme;
		if (p.nameState === "unknown" || p.name === "") return t.fg("dim", "(unknown)");
		const name = sanitize(p.name);
		return p.nameState === "truncated" ? `${name}${t.fg("dim", "…")}` : name;
	}

	render(width: number): string[] {
		const height = Math.max(1, this.options.rows());
		width = Math.max(1, width);
		if (this.cache?.width === width && this.cache.height === height) return this.cache.lines;
		const t = this.options.theme;
		const status = this.snapshot?.status ?? "waiting";
		const footer = this.footer(width);
		if (height === 1) return [fitCols(footer, width)];
		const lines = [this.header(width)];
		if (this.help) {
			const help = HELP.map((line) =>
				line.startsWith("*") ? t.bold(t.fg("accent", ` ${line.slice(1)}`)) : line,
			).flatMap((line) => wrapTextWithAnsi(line, width));
			this.helpPageSize = Math.max(1, height - 3);
			this.helpLength = help.length;
			this.helpScroll = Math.max(0, Math.min(this.helpScroll, help.length - this.helpPageSize));
			lines.push(
				t.fg(
					"accent",
					` HELP ${this.helpScroll + 1}-${Math.min(help.length, this.helpScroll + this.helpPageSize)}/${help.length}`,
				),
			);
			lines.push(...help.slice(this.helpScroll, this.helpScroll + this.helpPageSize));
		} else {
			const notice = this.snapshot?.notice;
			const hint = this.snapshot?.hint;
			const compactNotice = notice?.startsWith("Partial list:")
				? `Partial: ${notice.match(/\(([^)]+)\)/)?.[1] ?? "list incomplete"}`
				: notice?.startsWith("Sampling stopped")
					? "Stopped: reopen to retry"
					: notice;
			const diagnosticRows = Number(status === "stale") + Number(Boolean(notice)) + Number(Boolean(hint));
			if (height >= CARD_MIN_HEIGHT + diagnosticRows && width >= CARD_MIN_WIDTH) lines.push(...this.cards(width));
			else if (height >= 8) {
				// Reserve a process row and actionable warnings before optional history/platform hints.
				const warnings = Number(status === "stale") + Number(Boolean(notice));
				lines.push(...this.summary(width).slice(0, Math.max(1, height - 5 - warnings)));
			}
			if (height >= 8) {
				if (status === "stale")
					lines.push(
						t.fg(
							"warning",
							` Last success: ${this.lastSuccess === undefined ? "none" : new Date(this.lastSuccess).toISOString()}`,
						),
					);
				if (notice) lines.push(t.fg("warning", ` ▲ ${sanitize(width < 60 ? (compactNotice ?? notice) : notice)}`));
				if (hint && lines.length < height - 5) lines.push(t.fg("muted", ` ${sanitize(hint)}`));
			} else if (notice && height >= 6) {
				// One short warning must survive even when there is no room for the metric summary.
				lines.push(t.fg("warning", ` ▲ ${sanitize(compactNotice ?? notice)}`));
			}
			lines.push(
				`${t.bold(t.fg("accent", " PROCESSES"))}  ${t.fg("muted", `${this.processes.length} sampled`)}  ${t.fg("accent", `${this.sort.toUpperCase()} ${this.sort === "pid" ? "↑" : "↓"}`)}`,
			);
			this.table(lines, width, height);
		}
		const clipped = lines.slice(0, height - 1);
		while (clipped.length < height - 1) clipped.push("");
		clipped.push(footer);
		const result = clipped.map((line) => fitCols(line, width));
		this.cache = { width, height, lines: result };
		return result;
	}

	/** Column header, the visible page of rows with a scrollbar when it overflows, and a position line. */
	private table(lines: string[], width: number, height: number): void {
		const t = this.options.theme;
		const compact = width < 60;
		const pidWidth = compact ? 6 : 7;
		const cpuWidth = compact ? 7 : 8;
		const rssWidth = compact ? 6 : 8;
		const memWidth = compact ? 0 : 6;
		// Rows after the header: position line and footer stay reserved.
		this.pageSize = Math.max(1, height - lines.length - 3);
		const overflow = this.processes.length > this.pageSize;
		const rowWidth = width - (overflow ? 1 : 0);
		const nameWidth = Math.max(1, rowWidth - 1 - pidWidth - cpuWidth - rssWidth - memWidth - 2);
		const row = (mark: string, pid: string, cpu: string, rss: string, mem: string, name: string) =>
			fitCols(
				`${mark}${fitCols(pid, pidWidth)}${cpu}${rss}${memWidth ? mem : ""}  ${fitCols(name, nameWidth)}`,
				rowWidth,
			);
		lines.push(
			t.fg(
				"muted",
				row(" ", "PID", "CPU%".padStart(cpuWidth), "RSS".padStart(rssWidth), "MEM%".padStart(memWidth), "NAME"),
			),
		);
		const index = Math.max(
			0,
			this.processes.findIndex((p) => p.identity === this.selected),
		);
		this.scroll = Math.min(this.scroll, Math.max(0, this.processes.length - this.pageSize));
		if (index < this.scroll) this.scroll = index;
		if (index >= this.scroll + this.pageSize) this.scroll = index - this.pageSize + 1;
		const total = this.snapshot?.memoryTotalBytes ?? null;
		const visible = this.processes.slice(this.scroll, this.scroll + this.pageSize);
		const thumbSize = Math.max(1, Math.round((this.pageSize * this.pageSize) / Math.max(1, this.processes.length)));
		const thumbAt = Math.round(
			(this.scroll / Math.max(1, this.processes.length - this.pageSize)) * (this.pageSize - thumbSize),
		);
		visible.forEach((p, i) => {
			const selected = p.identity === this.selected;
			let text = row(
				selected ? t.fg("accent", "▸") : " ",
				String(p.pid),
				this.value(percent(p.cpuPercent).replace("%", ""), cpuWidth),
				this.value(bytes(p.rssBytes), rssWidth),
				this.value(share(p.rssBytes, total), memWidth),
				this.nameCell(p),
			);
			if (selected) text = t.bg("selectedBg", text);
			if (overflow)
				text += i >= thumbAt && i < thumbAt + thumbSize ? t.fg("scrollbarThumb", "┃") : t.fg("scrollbarTrack", "│");
			lines.push(text);
		});
		if (this.processes.length === 0) lines.push(t.fg("dim", " Waiting for process sample..."));
		if (lines.length < height - 1)
			lines.push(
				t.fg(
					"dim",
					` ${this.processes.length ? index + 1 : 0}/${this.processes.length} selected · CPU% 100 = one core${memWidth && total ? ` · MEM% of ${bytes(total)}` : ""}`,
				),
			);
	}
}
