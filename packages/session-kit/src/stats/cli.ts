/** Standalone data-only CLI. Bundles the parser; never imports Pi or the private extension entrypoint. */
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { agentDir } from "./load.ts";
import { exportStats, importStats } from "./snapshot.ts";

export async function main(): Promise<void> {
	const [command, ...args] = process.argv.slice(2);
	const options = new Map<string, string>();
	for (let i = 0; i < args.length; i += 2) {
		const flag = args[i];
		const value = args[i + 1];
		if (
			!flag ||
			!value ||
			value.startsWith("--") ||
			options.has(flag) ||
			!["--agent-dir", "--output", "--input", "--sessions-dir"].includes(flag)
		)
			throw new Error(
				"usage: export --agent-dir DIR --output OUT [--sessions-dir DIR] | import --agent-dir DIR --input REPO",
			);
		options.set(flag, value);
	}
	const dir = resolve(options.get("--agent-dir") ?? agentDir());
	if (command === "export" && options.has("--output") && !options.has("--input")) {
		const root = options.get("--sessions-dir");
		console.log(
			JSON.stringify(await exportStats(dir, resolve(options.get("--output") ?? ""), root ? resolve(root) : undefined)),
		);
	} else if (
		command === "import" &&
		options.has("--input") &&
		!options.has("--output") &&
		!options.has("--sessions-dir")
	) {
		const result = await importStats(dir, resolve(options.get("--input") ?? ""));
		console.log(JSON.stringify(result));
		if (result.problems.length) {
			console.error(result.problems.join("\n"));
			process.exitCode = 1;
		}
	} else
		throw new Error(
			"usage: export --agent-dir DIR --output OUT [--sessions-dir DIR] | import --agent-dir DIR --input REPO",
		);
}
export async function run(): Promise<void> {
	try {
		await main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : "Stats operation failed");
		process.exitCode = 1;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) void run();
