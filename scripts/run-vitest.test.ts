/**
 * In-process tests for the Vitest launcher's `main`. Only `spawnSync` is faked, so every case runs the
 * real home creation and cleanup; `integration/inprocess/verification/launcher.test.ts` and
 * `scripts/tests/test_coverage_producers.py` keep the real-subprocess coverage of the CLI dispatch.
 */
import assert from "node:assert/strict";
import type { SpawnSyncOptions, SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test, vi } from "vitest";

interface SpawnCall {
	command: string;
	args: readonly string[];
	env: NodeJS.ProcessEnv;
	homeExisted: boolean;
}

const spawn = vi.hoisted(() => ({
	calls: [] as SpawnCall[],
	result: { status: 0, signal: null } as Partial<SpawnSyncReturns<Buffer>>,
}));

vi.mock("node:child_process", () => ({
	spawnSync: (command: string, args: readonly string[], options: SpawnSyncOptions) => {
		const env = options.env ?? {};
		spawn.calls.push({ command, args, env, homeExisted: env.HOME !== undefined && statSync(env.HOME).isDirectory() });
		return spawn.result;
	},
}));

const { dispatch, isolatedHomeEnv, main, toolchainHomeEnv } = await import("./run-vitest.ts");

const VITEST = fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url));
const BUN_COVERAGE = [
	"--coverage",
	"--coverage.provider=istanbul",
	"--coverage.reporter=text",
	"--coverage.reporter=lcov",
	"--coverage.reporter=json-summary",
	"--coverage.reportsDirectory=coverage/bun",
];
const CHILD_STATUS = 7;

beforeEach(() => {
	spawn.calls.length = 0;
	spawn.result = { status: 0, signal: null };
	vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
	vi.restoreAllMocks();
});

/** The single recorded spawn, asserting its isolated home is gone again. */
function onlyCall(): SpawnCall {
	assert.equal(spawn.calls.length, 1);
	const call = spawn.calls[0];
	assert.ok(call);
	assert.ok(call.homeExisted, "the isolated home must exist while the child runs");
	assert.equal(existsSync(call.env.HOME ?? ""), false, "the isolated home must be removed afterwards");
	return call;
}

test("entry dispatch launches only for the entry module and propagates the status", () => {
	const argv = process.argv;
	const exitCode = process.exitCode;
	// `dispatch` passes the real environment; never append a fake timing to a real CI job summary.
	const dir = mkdtempSync(join(tmpdir(), "pi-run-vitest-dispatch-"));
	const summary = join(dir, "summary.md");
	vi.stubEnv("GITHUB_STEP_SUMMARY", summary);
	try {
		process.argv = ["node", "run-vitest.ts", "node"];
		process.exitCode = 0;
		spawn.result = { status: CHILD_STATUS, signal: null };
		dispatch(false);
		assert.equal(spawn.calls.length, 0);
		assert.equal(process.exitCode, 0);
		dispatch(true);
		assert.equal(process.exitCode, CHILD_STATUS);
		assert.equal(onlyCall().command, process.execPath);
		assert.match(readFileSync(summary, "utf8"), new RegExp(`node Vitest timing: .* \\| exit ${CHILD_STATUS}\\n$`));
	} finally {
		process.argv = argv;
		process.exitCode = exitCode;
		vi.unstubAllEnvs();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("node runs Vitest under the current Node with the package arguments unchanged", () => {
	spawn.result = { status: CHILD_STATUS, signal: null };
	assert.equal(main(["node", "--coverage"], { KEEP: "1" }), CHILD_STATUS);
	const call = onlyCall();
	assert.equal(call.command, process.execPath);
	assert.deepEqual(call.args, [VITEST, "run", "--coverage"]);
	assert.equal(call.env.KEEP, "1");
	assert.equal(call.env.JITI_FS_CACHE, "false");
	const home = call.env.HOME ?? "";
	assert.match(home, /pi-bun-vitest-/);
	for (const [name, value] of Object.entries(isolatedHomeEnv(home))) assert.equal(call.env[name], value);
});

test("bun appends the Istanbul coverage arguments after the package arguments", () => {
	assert.equal(main(["bun", "--maxWorkers=1"], {}), 0);
	const call = onlyCall();
	assert.equal(call.command, "bun");
	assert.deepEqual(call.args, ["--bun", VITEST, "run", "--maxWorkers=1", ...BUN_COVERAGE]);
});

test("only the Bun engine marks its child with the pinned-runtime expectation", () => {
	main(["bun"], {});
	assert.equal(onlyCall().env.PI_EXPECT_BUN_RUNTIME, "1");
	spawn.calls.length = 0;
	main(["node"], {});
	assert.equal(onlyCall().env.PI_EXPECT_BUN_RUNTIME, undefined);
});

test("bun keeps a canary's exact coverage opt-out instead of appending coverage", () => {
	main(["bun", "--coverage.enabled=false"], {});
	assert.deepEqual(onlyCall().args, ["--bun", VITEST, "run", "--coverage.enabled=false"]);
});

test("explicit toolchain homes win, otherwise the account's are pinned", () => {
	main(["node"], { CARGO_HOME: "/opt/cargo" });
	const call = onlyCall();
	assert.equal(call.env.CARGO_HOME, "/opt/cargo");
	assert.equal(call.env.RUSTUP_HOME, join(userInfo().homedir, ".rustup"));
	assert.deepEqual(toolchainHomeEnv({}), {
		CARGO_HOME: join(userInfo().homedir, ".cargo"),
		RUSTUP_HOME: join(userInfo().homedir, ".rustup"),
	});
});

test("a signal-killed child exits 1 and the timing lands in the step summary", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-run-vitest-summary-"));
	try {
		const summary = join(dir, "summary.md");
		spawn.result = { status: null, signal: "SIGKILL" };
		assert.equal(main(["node"], { GITHUB_STEP_SUMMARY: summary }), 1);
		onlyCall();
		assert.match(readFileSync(summary, "utf8"), /^\nnode Vitest timing: .* \| exit 1\n$/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a spawn failure is rethrown after the home is removed", () => {
	const failure = new Error("spawn bun ENOENT");
	spawn.result = { status: null, signal: null, error: failure };
	assert.throws(() => main(["bun"], {}), failure);
	onlyCall();
});

test("an unknown or missing engine is rejected before any home is created", () => {
	for (const argv of [["deno", "--coverage"], []]) {
		assert.throws(() => main(argv, {}), /Expected engine: node or bun/);
	}
	assert.equal(spawn.calls.length, 0);
});

test("offline Make gates run both engines without replacing primary coverage", () => {
	const makefile = readFileSync(new URL("../Makefile", import.meta.url), "utf8");
	for (const [target, launcher] of [
		["check-probes", "../../scripts/run-vitest.ts"],
		["check-import-audit", "run-vitest.ts"],
	]) {
		const recipe = makefile.split(`${target}:`)[1]?.split("\n\n")[0];
		assert.ok(recipe);
		assert.ok(recipe.includes(`node ${launcher} node --coverage`));
		assert.ok(recipe.includes(`node ${launcher} bun --coverage.enabled=false`));
		assert.equal(recipe.match(/env -i PATH="\$\$PATH" HOME="\$\$sandbox" PI_OFFLINE=1 PI_NO_LOCAL_LLM=1/g)?.length, 2);
		assert.equal(recipe.match(/trap 'rm -rf "\$\$sandbox"' EXIT/g)?.length, 2);
		assert.doesNotMatch(recipe, /PI_CU_LIVE|PI_COMPUTER_USE_LIVE|\*\.test/);
	}
	if (process.env.PI_EXPECT_BUN_RUNTIME === "1") assert.ok(process.versions.bun, "Bun gate must not fall back to Node");
});
