/** Line-oriented JSONL helpers shared by pi's session parser and the other harness readers. */

import { createReadStream, type Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setImmediate as tick } from "node:timers/promises";

const YIELD_EVERY_LINES = 2000;

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

/** Stream a file's lines into `parser`, yielding to the event loop every 2000 lines so the TUI keeps painting. */
export async function feedFile(path: string, parser: { accept(line: string): void }): Promise<void> {
	const rl = createInterface({
		input: createReadStream(path, { encoding: "utf8" }),
		crlfDelay: Number.POSITIVE_INFINITY,
	});
	let n = 0;
	for await (const line of rl) {
		parser.accept(line);
		if (++n % YIELD_EVERY_LINES === 0) await tick();
	}
}

/**
 * Every `*.jsonl` under `root`. A missing root is an empty history; any other directory that cannot
 * be listed (EACCES, ...) is counted in `errors` so partial totals are never presented as complete.
 */
export async function listJsonl(root: string): Promise<{ paths: string[]; errors: number }> {
	const out: string[] = [];
	let errors = 0;
	const walk = async (dir: string): Promise<void> => {
		let entries: Dirent[];
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch (error) {
			if (!(dir === root && (error as NodeJS.ErrnoException).code === "ENOENT")) errors++;
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
