import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

// Bun caches os.homedir(): isolate HOME at spawn, never by mutating it in Bun.
const engine = process.argv[2];
if (engine !== "bun" && engine !== "node") throw new Error("Expected engine: node or bun");
const home = mkdtempSync(join(tmpdir(), "pi-bun-vitest-"));
const start = performance.now();
let status = 1;
try {
	const result = spawnSync(
		engine === "node" ? process.execPath : "bun",
		[
			...(engine === "bun" ? ["--bun"] : []),
			fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url)),
			"run",
			...process.argv.slice(3),
		],
		{
			stdio: "inherit",
			env: { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config") },
		},
	);
	if (result.error) throw result.error;
	status = result.status ?? 1;
} finally {
	rmSync(home, { recursive: true, force: true });
	const timing = `${process.platform} | ${basename(process.cwd())} | ${((performance.now() - start) / 1000).toFixed(2)} s | exit ${status}`;
	console.log(`${engine} Vitest timing: ${timing}`);
	if (process.env.GITHUB_STEP_SUMMARY)
		appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n${engine} Vitest timing: ${timing}\n`);
}
process.exitCode = status;
