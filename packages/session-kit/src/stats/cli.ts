/** Standalone data-only CLI. Bundles the parser; never imports Pi or the private extension entrypoint. */
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { agentDir } from "../agent-dir.ts";
import { HARNESSES, type Harness } from "./load.ts";
import { exportStats, importStats } from "./snapshot.ts";

const USAGE =
	"usage: export --agent-dir DIR --output OUT [--sessions-dir DIR] [--harness pi,claude,codex,opencode] " +
	"[--claude-dir DIR] [--codex-dir DIR] [--opencode-db FILE] [--replace-harnesses] | import --agent-dir DIR --input REPO";
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
	if (command === "export" && output !== undefined && input === undefined) {
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
/** Run `main`, converting failures to one diagnostic and a nonzero process exit code. */
export async function run(): Promise<void> {
	try {
		await main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : "Stats operation failed");
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
