/** Line-oriented JSONL helpers shared by pi's session parser and the other harness readers. */

import { createReadStream, type Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import { nth } from "./nth.ts";

const YIELD_EVERY_LINES = 2000;

export const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function num(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function timeOf(value: unknown): number {
	if (typeof value === "number")
		return Number.isSafeInteger(value) && value > 0 && value <= 8640000000000000 ? value : 0;
	if (typeof value !== "string") return 0;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : 0;
}

/** Cheap structural check for lines that are not parsed: one JSON object per line. */
export function looksLikeObject(line: string): boolean {
	const text = line.trim();
	return text.startsWith("{") && text.endsWith("}");
}

/** A line of only NULs: crash padding (file size extended, data never written) that carries no data. */
export const NUL_PADDING = /^\0+$/;

/**
 * Stream a file's lines into `parser`, yielding to the event loop every 2000 lines so the TUI keeps painting.
 *
 * Lines end at `\n` only, like pi's `loadEntriesFromFile`. `node:readline` would also split on U+2028, U+2029 and a
 * lone `\r`; `JSON.stringify` leaves the first two raw inside strings, so a valid record carrying one would be torn
 * into two bad lines. A trailing `\r` is dropped, which keeps the CRLF handling `readline` had.
 */
export async function feedFile(path: string, parser: { accept(line: string): void }): Promise<void> {
	let n = 0;
	const emit = async (line: string): Promise<void> => {
		parser.accept(line.endsWith("\r") ? line.slice(0, -1) : line);
		if (++n % YIELD_EVERY_LINES === 0) await tick();
	};
	let pending = "";
	for await (const chunk of createReadStream(path, { encoding: "utf8" })) {
		const parts = (chunk as string).split("\n");
		const last = parts.length - 1;
		if (last === 0) {
			pending += nth(parts, 0);
			continue;
		}
		await emit(pending + nth(parts, 0));
		for (let i = 1; i < last; i++) await emit(nth(parts, i));
		pending = nth(parts, last);
	}
	if (pending) await emit(pending);
}

/** Local-only scan location, never transcript data or an exception message. Line 0 means no record was read. */
export interface ScanDiagnostic {
	path: string;
	line: number;
	reason:
		| "invalid-record"
		| "read-directory"
		| "read-file"
		| "write-cache"
		| "cached-invalid-record"
		| "price-fallback";
}

/**
 * Every `*.jsonl` under `root`. A missing root is an empty history; any other directory that cannot
 * be listed (EACCES, ...) is counted in `errors` so partial totals are never presented as complete.
 */
export async function listJsonl(
	root: string,
	onDiagnostic?: (diagnostic: ScanDiagnostic) => void,
): Promise<{ paths: string[]; errors: number }> {
	const out: string[] = [];
	let errors = 0;
	const walk = async (dir: string): Promise<void> => {
		let entries: Dirent[];
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch (error) {
			if (!(dir === root && (error as NodeJS.ErrnoException).code === "ENOENT")) {
				errors++;
				onDiagnostic?.({ path: dir, line: 0, reason: "read-directory" });
			}
			return;
		}
		for (const entry of entries) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) await walk(path);
			else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(path);
		}
	};
	await walk(root);
	return { paths: out.sort(), errors };
}
