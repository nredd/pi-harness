/** The `/diff` overlay: file list on the left, scrollable themed patch on the right. Read-only. */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { classifyLines, type DiffFile, type FileStatus, type LineKind } from "./parse.ts";
import {
	clamp,
	clampScroll,
	fitCols,
	fitPathLeft,
	layout,
	listTop,
	maxScroll,
	pageSize,
	sanitize,
	window,
} from "./view.ts";

type ThemeLike = Pick<Theme, "fg" | "bg" | "bold">;

export interface DiffViewOptions {
	files: DiffFile[];
	label: string;
	theme: ThemeLike;
	/** Current terminal height. */
	rows: () => number;
	requestRender: () => void;
	onClose: () => void;
	notices?: string[];
}

const STATUS_LETTER: Record<FileStatus, string> = {
	modified: "M",
	added: "A",
	deleted: "D",
	renamed: "R",
	copied: "C",
	binary: "B",
	mode: "T",
	untracked: "?",
};

const HELP = [
	" j/k scroll  n/p file  g/G top/bottom  PgUp/PgDn  </> pan  q close",
	" j/k n/p g/G PgUp/PgDn q",
	" j/k n/p q",
	" q",
];

interface Row {
	text: string;
	kind: LineKind | "notice";
}

export class DiffView implements Component {
	private selected = 0;
	private readonly scroll: number[];
	private hscroll = 0;
	private listScroll = 0;
	private bodyHeight = 1;
	private readonly rowCache = new Map<number, { kinds: LineKind[]; plain: string[] }>();

	constructor(private readonly o: DiffViewOptions) {
		this.scroll = o.files.map(() => 0);
	}

	invalidate(): void {
		// Nothing themed is cached: every render rebuilds colours from the live theme.
	}

	// --- state -------------------------------------------------------------------------------

	get selectedIndex(): number {
		return this.selected;
	}

	get scrollOffset(): number {
		return this.scroll[this.selected] ?? 0;
	}

	private rowsFor(index: number): Row[] {
		const file = this.o.files[index];
		if (!file) return [];
		let cached = this.rowCache.get(index);
		if (!cached) {
			cached = { kinds: classifyLines(file), plain: file.lines.map((l) => sanitize(l)) };
			this.rowCache.set(index, cached);
		}
		const rows: Row[] = cached.plain.map((text, i) => ({ text, kind: cached?.kinds[i] ?? "context" }));
		if (file.notice) rows.push({ text: `... ${file.notice}`, kind: "notice" });
		return rows;
	}

	private total(): number {
		const file = this.o.files[this.selected];
		return file ? file.lines.length + (file.notice ? 1 : 0) : 0;
	}

	private setScroll(value: number): void {
		this.scroll[this.selected] = clampScroll(value, this.total(), this.bodyHeight);
	}

	private selectFile(index: number): void {
		this.selected = clamp(index, 0, Math.max(0, this.o.files.length - 1));
		this.hscroll = 0;
		this.setScroll(this.scrollOffset);
	}

	// --- input -------------------------------------------------------------------------------

	handleInput(data: string): void {
		const off = this.scrollOffset;
		const page = pageSize(this.bodyHeight);
		if (data === "q" || matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.o.onClose();
			return;
		}
		if (data === "j" || matchesKey(data, Key.down)) this.setScroll(off + 1);
		else if (data === "k" || matchesKey(data, Key.up)) this.setScroll(off - 1);
		else if (matchesKey(data, Key.pageDown) || data === " ") this.setScroll(off + page);
		else if (matchesKey(data, Key.pageUp)) this.setScroll(off - page);
		else if (data === "g" || matchesKey(data, Key.home)) this.setScroll(0);
		else if (data === "G" || matchesKey(data, Key.shift("g")) || matchesKey(data, Key.end)) {
			this.setScroll(maxScroll(this.total(), this.bodyHeight));
		} else if (data === "n") this.selectFile(this.selected + 1);
		else if (data === "p") this.selectFile(this.selected - 1);
		else if (data === "l" || matchesKey(data, Key.right)) this.hscroll += 8;
		else if (data === "h" || matchesKey(data, Key.left)) this.hscroll = Math.max(0, this.hscroll - 8);
		else return;
		this.o.requestRender();
	}

	// --- render ------------------------------------------------------------------------------

	render(width: number): string[] {
		const w = Math.max(1, Math.floor(width));
		const rows = Math.max(3, Math.floor(this.o.rows()));
		this.bodyHeight = Math.max(1, rows - 2);
		this.setScroll(this.scrollOffset);
		const lay = layout(w);
		const out: string[] = [this.title(w)];

		const patch = this.rowsFor(this.selected);
		const off = this.scrollOffset;
		this.listScroll = listTop(this.listScroll, this.selected, this.o.files.length, this.bodyHeight);
		const sep = this.o.theme.fg("borderMuted", "│");

		for (let y = 0; y < this.bodyHeight; y++) {
			const right = this.patchCell(patch[off + y], lay.right);
			if (lay.left === 0) {
				out.push(right);
				continue;
			}
			out.push(this.listCell(this.listScroll + y, lay.left) + sep + right);
		}
		out.push(this.help(w, patch.length, off));
		return out.map((line) => truncateToWidth(line, w, ""));
	}

	private title(width: number): string {
		const files = this.o.files;
		const add = files.reduce((n, f) => n + f.additions, 0);
		const del = files.reduce((n, f) => n + f.deletions, 0);
		const t = this.o.theme;
		const plain = ` /diff ${sanitize(this.o.label)}  ${files.length} file${files.length === 1 ? "" : "s"}  +${add} -${del}`;
		const extra = this.o.notices?.length ? `  ! ${sanitize(this.o.notices.join("; "))}` : "";
		return t.bold(t.fg("accent", fitCols(plain + extra, width)));
	}

	private listCell(index: number, width: number): string {
		const file = this.o.files[index];
		if (!file) return " ".repeat(width);
		const t = this.o.theme;
		const letter = STATUS_LETTER[file.status];
		const color =
			file.status === "added" || file.status === "untracked"
				? "toolDiffAdded"
				: file.status === "deleted"
					? "toolDiffRemoved"
					: "accent";
		const path = fitPathLeft(sanitize(file.path), Math.max(0, width - 3));
		if (index === this.selected) return t.bg("selectedBg", t.bold(fitCols(` ${letter} ${path}`, width)));
		// colour only the status letter; the path stays plain
		return fitCols(` ${t.fg(color, letter)} ${path}`, width);
	}

	private patchCell(row: Row | undefined, width: number): string {
		if (!row) return " ".repeat(Math.max(0, width));
		const t = this.o.theme;
		const text = window(row.text, this.hscroll, width);
		switch (row.kind) {
			case "added":
				return t.fg("toolDiffAdded", text);
			case "removed":
				return t.fg("toolDiffRemoved", text);
			case "hunk":
				return t.fg("accent", text);
			case "meta":
				return t.fg("muted", text);
			case "notice":
				return t.fg("warning", text);
			default:
				return t.fg("toolDiffContext", text);
		}
	}

	private help(width: number, total: number, off: number): string {
		const t = this.o.theme;
		const pos = ` ${this.selected + 1}/${this.o.files.length}  ${total === 0 ? 0 : off + 1}-${Math.min(total, off + this.bodyHeight)}/${total} `;
		const keys = HELP.find((h) => h.length + pos.length <= width) ?? "";
		const gap = Math.max(0, width - keys.length - pos.length);
		return t.fg("muted", fitCols(`${keys}${" ".repeat(gap)}${pos}`, width));
	}
}
