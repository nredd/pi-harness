import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const [, , ...args] = process.argv;
const write = args[0] === "--write";
const paths = write ? args.slice(1) : args;

if (paths.length === 0) throw new Error("Expected one or more Biome paths");

const missing = paths.filter((path) => !existsSync(path));
if (missing.length > 0) {
	console.error(`Biome paths do not exist: ${missing.join(", ")}`);
	process.exitCode = 1;
} else {
	const biome = fileURLToPath(new URL("../node_modules/.bin/biome", import.meta.url));
	const result = spawnSync(biome, ["check", ...(write ? ["--write"] : []), ...paths], { stdio: "inherit" });
	if (result.error) throw result.error;
	process.exitCode = result.status ?? 1;
}
