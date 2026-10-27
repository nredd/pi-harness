import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const FAILURE_EXIT_STATUS = 1;
const MILLISECONDS_PER_SECOND = 1000;
const TIMING_DECIMAL_PLACES = 2;

// Bun caches os.homedir(): isolate HOME at spawn, never by mutating it in Bun.
const [, , engine, ...vitestArgs] = process.argv;
if (engine !== "bun" && engine !== "node") throw new Error("Expected engine: node or bun");
const home = mkdtempSync(join(tmpdir(), "pi-bun-vitest-"));
const start = performance.now();
let status = FAILURE_EXIT_STATUS;
try {
	const result = spawnSync(
		engine === "node" ? process.execPath : "bun",
		[
			...(engine === "bun" ? ["--bun"] : []),
			fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url)),
			"run",
			...vitestArgs,
		],
		{
			stdio: "inherit",
			env: { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config") },
		},
	);
	if (result.error) throw result.error;
	status = result.status ?? FAILURE_EXIT_STATUS;
} finally {
	rmSync(home, { recursive: true, force: true });
	const timing = `${process.platform} | ${basename(process.cwd())} | ${((performance.now() - start) / MILLISECONDS_PER_SECOND).toFixed(TIMING_DECIMAL_PLACES)} s | exit ${status}`;
	console.log(`${engine} Vitest timing: ${timing}`);
	if (process.env.GITHUB_STEP_SUMMARY)
		appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n${engine} Vitest timing: ${timing}\n`);
}
process.exitCode = status;
