/**
 * Read usage from every other harness on this machine.
 *
 * Everything here is a local file read: no network, no credential file, no writes outside this
 * package's own cache (`<agentDir>/pi-session-kit/stats-harness-cache.json`).
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { agentDir } from "../../agent-dir.ts";
import { readClaude } from "./claude.ts";
import { readCodex } from "./codex.ts";
import { asRecordOf, emptyScan, type HarnessScan } from "./common.ts";
import { type LoadSqlite, loadNodeSqlite, readOpenCode } from "./opencode.ts";
import { type HarnessCache, isParsedFile, type ParsedFile } from "./scan.ts";

export type ExternalHarness = "claude" | "codex" | "opencode";
export const EXTERNAL_HARNESSES: readonly ExternalHarness[] = ["claude", "codex", "opencode"];

/** v2: Claude and Codex calls carry a `null` cost instead of 0. v3: quota readings carry an `account`. */
const CACHE_VERSION = 3;

export const harnessCachePath = (dir = agentDir()): string => join(dir, "pi-session-kit", "stats-harness-cache.json");

/** Where each harness keeps its data: explicit option, then its own environment variable, then the default. */
export interface HarnessRoots {
	/** Claude Code config dir (`CLAUDE_CONFIG_DIR`, default `~/.claude`). */
	claude: string;
	/** Codex home (`CODEX_HOME`, default `~/.codex`). */
	codex: string;
	/** The OpenCode database file (`OPENCODE_DB`, else `$XDG_DATA_HOME/opencode/opencode.db`). */
	opencode: string;
}

export function harnessRoots(
	env: Record<string, string | undefined> = process.env,
	home = homedir(),
	overrides: Partial<HarnessRoots> = {},
): HarnessRoots {
	const data = env.XDG_DATA_HOME || join(home, ".local", "share");
	return {
		claude: overrides.claude ?? (env.CLAUDE_CONFIG_DIR || join(home, ".claude")),
		codex: overrides.codex ?? (env.CODEX_HOME || join(home, ".codex")),
		opencode: overrides.opencode ?? (env.OPENCODE_DB || join(data, "opencode", "opencode.db")),
	};
}

/** Cached records, dropping any that do not have exactly the expected shape (they are re-parsed). */
export async function readHarnessCache(path: string): Promise<HarnessCache> {
	let doc: unknown;
	try {
		doc = JSON.parse(await readFile(path, "utf8"));
	} catch {
		return {};
	}
	const cache: HarnessCache = {};
	const record = asRecordOf(doc);
	if (record.version !== CACHE_VERSION) return cache;
	for (const [harness, files] of Object.entries(asRecordOf(record.harnesses)))
		cache[harness] = Object.fromEntries(
			Object.entries(asRecordOf(files)).filter((entry): entry is [string, ParsedFile] => isParsedFile(entry[1])),
		);
	return cache;
}

/** Atomic write: a crash mid-write never leaves a truncated cache behind. */
export async function writeHarnessCache(path: string, cache: HarnessCache): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.${randomUUID()}.tmp`;
	await writeFile(tmp, JSON.stringify({ version: CACHE_VERSION, harnesses: cache }));
	await rename(tmp, path);
}

export interface HarnessLoadOptions {
	/** Which harnesses to read; default all three. */
	harnesses?: readonly ExternalHarness[];
	roots?: Partial<HarnessRoots>;
	env?: Record<string, string | undefined>;
	home?: string;
	/** Cache file; default under the agent dir. */
	cache?: string;
	loadSqlite?: LoadSqlite;
	/** The installation's secret salt for account discriminators. Never exported. */
	salt: string;
}

/** One scan per requested harness. A failing harness never hides the others. */
export async function loadHarnesses(options: HarnessLoadOptions): Promise<Record<ExternalHarness, HarnessScan>> {
	const wanted = new Set(options.harnesses ?? EXTERNAL_HARNESSES);
	const roots = harnessRoots(options.env, options.home, options.roots);
	const cachePath = options.cache ?? harnessCachePath();
	const cache = await readHarnessCache(cachePath);
	const before = JSON.stringify(cache);
	const scans = {
		claude: wanted.has("claude") ? await readClaude(roots.claude, cache) : emptyScan(false),
		codex: wanted.has("codex") ? await readCodex(roots.codex, cache, options.salt) : emptyScan(false),
		opencode: wanted.has("opencode")
			? await readOpenCode(roots.opencode, options.loadSqlite ?? loadNodeSqlite)
			: emptyScan(false),
	};
	if (JSON.stringify(cache) !== before) {
		try {
			await writeHarnessCache(cachePath, cache);
		} catch {
			// The view still renders, but a producer must not claim durable history.
			for (const h of wanted) if (h !== "opencode") scans[h].problems.push(`${h}: cache not written`);
		}
	}
	return scans;
}
