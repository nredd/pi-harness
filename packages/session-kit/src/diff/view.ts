/** Pure helpers for the `/diff` overlay: sanitising, width fitting, scroll math, layout. */

import { sliceByColumn, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export const TAB_WIDTH = 4;
export const ELLIPSIS = "…";

/** Make arbitrary file text safe for a terminal: C0/C1 controls become `^X`, tabs expand. */
export function sanitize(text: string, tabWidth = TAB_WIDTH): string {
	let out = "";
	let col = 0;
	for (const ch of text) {
		const code = ch.codePointAt(0) ?? 0;
		if (ch === "\t") {
			const pad = tabWidth - (col % tabWidth);
			out += " ".repeat(pad);
			col += pad;
		} else if (code < 0x20) {
			out += `^${String.fromCharCode(code + 64)}`;
			col += 2;
		} else if (code === 0x7f) {
			out += "^?";
			col += 2;
		} else if (code >= 0x80 && code < 0xa0) {
			out += "?";
			col += 1;
		} else if (code === 0x2028 || code === 0x2029) {
			out += "?";
			col += 1;
		} else {
			out += ch;
			col += visibleWidth(ch);
		}
	}
	return out;
}

/** Exactly `width` columns: truncated with an ellipsis when too long, space padded when short. */
export function fitCols(text: string, width: number): string {
	if (width <= 0) return "";
	return truncateToWidth(text, width, ELLIPSIS, true);
}

/** Columns `[from, from + width)` of plain text, padded to `width`. Never splits a wide char. */
export function window(text: string, from: number, width: number): string {
	if (width <= 0) return "";
	const slice = from > 0 ? sliceByColumn(text, from, width, true) : text;
	return fitCols(slice, width);
}

/** Shorten a path from the left so the file name stays visible: `…/dir/file.ts`. */
export function fitPathLeft(path: string, width: number): string {
	if (width <= 0) return "";
	const w = visibleWidth(path);
	if (w <= width) return fitCols(path, width);
	if (width === 1) return ELLIPSIS;
	return fitCols(`${ELLIPSIS}${sliceByColumn(path, w - (width - 1), width - 1, true)}`, width);
}

export function clamp(n: number, lo: number, hi: number): number {
	return Math.max(lo, Math.min(hi, n));
}

/** Largest valid scroll offset for `total` lines in a `viewport`-line window. */
export function maxScroll(total: number, viewport: number): number {
	return Math.max(0, total - Math.max(1, viewport));
}

export function clampScroll(offset: number, total: number, viewport: number): number {
	return clamp(offset, 0, maxScroll(total, viewport));
}

/** Lines moved by PgUp/PgDn: a window minus one line of overlap. */
export function pageSize(viewport: number): number {
	return Math.max(1, viewport - 1);
}

/** First visible list row so that `selected` is visible in `viewport` rows, keeping `top` when possible. */
export function listTop(top: number, selected: number, total: number, viewport: number): number {
	const h = Math.max(1, viewport);
	let t = top;
	if (selected < t) t = selected;
	else if (selected >= t + h) t = selected - h + 1;
	return clamp(t, 0, Math.max(0, total - h));
}

export interface Layout {
	left: number;
	sep: number;
	right: number;
}

/** Split the width between file list, separator and patch. Always sums to `width`. */
export function layout(width: number): Layout {
	if (width < 24) return { left: 0, sep: 0, right: Math.max(0, width) };
	const left = clamp(Math.floor(width * 0.28), 14, 44);
	return { left, sep: 1, right: width - left - 1 };
}
