/** Standalone data-only CLI. Bundles the parser; never imports Pi or the private extension entrypoint. */
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { agentDir } from "../agent-dir.ts";
import { HARNESSES, type Harness, sessionsDir } from "./load.ts";
import { cleanRecovery, ExportRefusal, exportStats, IncompleteScan, importStats } from "./snapshot.ts";
import { reportSubagents } from "./subagents.ts";

const USAGE =
	"usage: export --agent-dir DIR --output OUT [--sessions-dir DIR] [--harness pi,claude,codex,opencode] " +
	"[--claude-dir DIR] [--codex-dir DIR] [--opencode-db FILE] [--replace-harnesses] | import --agent-dir DIR --input REPO | " +
	"clean-recovery --agent-dir DIR --output OUT | subagents [--agent-dir DIR] [--sessions-dir DIR]\n" +
	"  clean-recovery: remove frozen recovery shard files the active snapshot fully covers; never part of an export\n" +
	"  --replace-harnesses: publish this scan as a replacement generation, bypassing the narrower-set, " +
	"unreadable-history, missing-manifest and later-month safeguards and unfreezing recovery files; drops " +
	"published history absent from the scan (sealed months included). Viewers holding a snapshot newer than " +
	"the replacement keep it until this machine exports a later one\n" +
	"  A clock behind the last published export in its month still publishes, just after it, with a warning";
const FLAGS = [
	"--agent-dir",
	"--output",
	"--input",
	"--sessions-dir",
	"--harness",
	"--claude-dir",
	"--codex-dir",
	"--opencode-db",
];
/** Flags without a value. */
const SWITCHES = ["--replace-harnesses"];
/** The only flags the read-only `subagents` report accepts. */
const SUBAGENTS_FLAGS = ["--agent-dir", "--sessions-dir"];
/** Flags that only an export accepts. */
const EXPORT_ONLY = [...SWITCHES, "--sessions-dir", "--harness", "--claude-dir", "--codex-dir", "--opencode-db"];

/** `pi,claude` -> harness names; anything unknown or repeated is a usage error. */
function harnessList(value: string): Harness[] {
	const names = value.split(",");
	if (new Set(names).size !== names.length || !names.every((n): n is Harness => HARNESSES.includes(n as Harness)))
		throw new Error(USAGE);
	return names as Harness[];
}

/** Parse the portable CLI argv, run its selected operation, and report JSON to stdout. */
export async function main(): Promise<void> {
	const [command, ...args] = process.argv.slice(2);
	const options = new Map<string, string>();
	for (let i = 0; i < args.length; i++) {
		const flag = args[i];
		if (!flag || options.has(flag)) throw new Error(USAGE);
		if (command === "subagents" && !SUBAGENTS_FLAGS.includes(flag))
			throw new Error(`usage: flag '${flag}' is not valid for subagents; valid flags: ${SUBAGENTS_FLAGS.join(", ")}`);
		if (SWITCHES.includes(flag)) {
			options.set(flag, "");
			continue;
		}
		const value = args[++i];
		if (!value || value.startsWith("--") || !FLAGS.includes(flag)) throw new Error(USAGE);
		options.set(flag, value);
	}
	const dir = resolve(options.get("--agent-dir") ?? agentDir());
	const output = options.get("--output");
	const input = options.get("--input");
	if (command === "subagents") {
		const result = await reportSubagents(resolve(options.get("--sessions-dir") ?? sessionsDir(dir)));
		console.log(JSON.stringify(result));
	} else if (command === "export" && output !== undefined && input === undefined) {
		const path = (flag: string): string | undefined => {
			const value = options.get(flag);
			return value ? resolve(value) : undefined;
		};
		const harnesses = options.get("--harness");
		const result = await exportStats(dir, resolve(output), path("--sessions-dir"), {
			harnesses: harnesses === undefined ? undefined : harnessList(harnesses),
			replaceHarnesses: options.has("--replace-harnesses"),
			roots: { claude: path("--claude-dir"), codex: path("--codex-dir"), opencode: path("--opencode-db") },
		});
		console.log(JSON.stringify(result));
		for (const warning of result.warnings ?? []) console.error(warning);
		for (const [name, status] of Object.entries(result.harnesses ?? {})) {
			if (status.failed)
				console.error(
					`${name}: scan incomplete (${status.consecutiveFailures} in a row), ${status.failed === "kept" ? "kept what was last published" : "last published contents unreadable, dropped"}`,
				);
		}
	} else if (
		command === "clean-recovery" &&
		// Deleting files never falls back to the default installation: name it.
		options.has("--agent-dir") &&
		output !== undefined &&
		input === undefined &&
		!EXPORT_ONLY.some((f) => options.has(f))
	) {
		const result = await cleanRecovery(dir, resolve(output));
		console.log(JSON.stringify(result));
		// A cleanup that exits 1 here has no refusal code, so no warning may look like a trailer either.
		for (const warning of result.warnings ?? []) console.error(oneLine(warning));
		// A cleanup the manifest changed under did not finish: say so in the exit code too.
		if (result.kept.some((k) => k.reason === "changed")) process.exitCode = 1;
	} else if (
		command === "import" &&
		input !== undefined &&
		output === undefined &&
		!EXPORT_ONLY.some((f) => options.has(f))
	) {
		const result = await importStats(dir, resolve(input));
		console.log(JSON.stringify(result));
		for (const s of result.stale)
			console.error(`${s.machineId}: ${s.harness} not read cleanly since ${new Date(s.lastGoodAt).toISOString()}`);
		if (result.problems.length) {
			console.error(result.problems.join("\n"));
			process.exitCode = 1;
		}
	} else throw new Error(USAGE);
}
/** Escape line breaks and every other control character, so a diagnostic stays one line. */
const oneLine = (text: string): string =>
	text.replace(/[\p{Cc}\u2028\u2029]/gu, (c) => {
		const named: Record<string, string> = { "\n": "\\n", "\r": "\\r", "\t": "\\t" };
		return named[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`;
	});
/**
 * Run `main`, converting failures to one diagnostic and a nonzero process exit code. An export refusal
 * ends with one fixed `pi-stats-refusal: {"code":...}` line; no such line means the cause is unclassified.
 * Diagnostics can quote raw paths, so each is escaped to one line and a path holding a newline cannot
 * forge the trailer. Only the fixed usage text and the JSON-quoted scan protocol keep their line breaks.
 */
export async function run(): Promise<void> {
	try {
		await main();
	} catch (error) {
		const message = error instanceof Error ? error.message : "Stats operation failed";
		console.error(message === USAGE || error instanceof IncompleteScan ? message : oneLine(message));
		if (error instanceof ExportRefusal) console.error(`pi-stats-refusal: ${JSON.stringify({ code: error.refusal })}`);
		process.exitCode = 1;
	}
}

/** Importers may supply an absent or unresolvable entrypoint, which must not prevent import. */
function isEntrypoint(): boolean {
	try {
		return !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
	} catch {
		return false;
	}
}

if (isEntrypoint()) void run();
