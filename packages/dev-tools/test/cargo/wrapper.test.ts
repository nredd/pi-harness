import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerCargoTools } from "../../src/cargo/index.ts";
import { withLock } from "../../src/core/index.ts";
import { createMockPi } from "../support.ts";
import { wrapperFixture } from "../wrapper-fixture.ts";

const fixtures: ReturnType<typeof wrapperFixture>[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	for (const fixture of fixtures.splice(0)) fixture.cleanup();
});
function setup() {
	const fixture = wrapperFixture("Cargo.toml");
	fixtures.push(fixture);
	const mock = createMockPi();
	registerCargoTools(mock.pi, { cargoBin: fixture.bin, rustupBin: fixture.bin });
	return { ...fixture, ...mock };
}

describe("cargo executable boundary", () => {
	it("maps abnormal exits and noncompiler failures for every wrapper", async () => {
		const f = setup();
		for (const name of ["check", "clippy", "fmt", "test", "build", "run", "doc", "bench", "add"]) {
			f.script('process.kill(process.pid, "SIGTERM");');
			const result = await f.call(`cargo_${name}`, name === "add" ? { crates: ["local"] } : {}, f.root);
			expect(result.isError, name).toBe(true);
			expect(f.text(result), name).toContain("SIGTERM");
		}
		f.script('console.error("manifest rejected"); process.exit(2);');
		for (const name of ["check", "fmt", "test", "add"]) {
			const result = await f.call(`cargo_${name}`, name === "add" ? { crates: ["local"] } : {}, f.root);
			expect(result.isError).toBe(true);
			expect(f.text(result)).toContain("manifest rejected");
		}
	});

	it("keeps progress, capped diagnostics, rustup argv and feature options", async () => {
		const f = setup();
		const diagnostic = (level: string, message: string) => ({
			reason: "compiler-message",
			message: { level, message, code: null, spans: [], children: [] },
		});
		f.script(`require('node:fs').writeFileSync('args.json', JSON.stringify(process.argv.slice(2)));
console.error('Blocking waiting for file lock'); console.error('   Compiling fixture');
console.log(${JSON.stringify(JSON.stringify(diagnostic("warning", "warning")))});
console.log(${JSON.stringify(JSON.stringify(diagnostic("error", "error")))});`);
		const updates: unknown[] = [];
		const tool = f.tools.get("cargo_check");
		const result = await tool?.execute(
			"id",
			{ toolchain: "stable", features: ["a", "b"], limit: 1 },
			undefined,
			((value: unknown) => updates.push(value)) as never,
			{ cwd: f.root },
		);
		expect(result).toMatchObject({ isError: true, structuredContent: { errors: 1, warnings: 1 } });
		expect(JSON.stringify(result)).toContain("... 1 more");
		expect(JSON.stringify(updates)).toContain("build-directory lock");
		expect(JSON.stringify(updates)).toContain("Compiling fixture");
		expect(JSON.parse(readFileSync(join(f.root, "args.json"), "utf8"))).toEqual([
			"run",
			"stable",
			"cargo",
			"check",
			"--message-format=json-diagnostic-short",
			"--features",
			"a,b",
			"--all-targets",
		]);
	});

	it("reports missing junit and doctest runner errors without inventing counts", async () => {
		const f = setup();
		f.script(`if (process.argv[2] === 'test') { console.error('doctest launcher broken'); process.exit(2); }`);
		const result = await f.call("cargo_test", {}, f.root);
		expect(f.text(result)).toContain("wrote no junit");
		expect(f.text(result)).toContain("doctests: cargo exited 2");
		expect(result.structuredContent).toMatchObject({ tests: 0, doctests: { passed: 0, failed: 0 } });
	});

	it("does not invent doctests for binaries, and lets a doctest failure turn a pass red", async () => {
		const f = setup();
		f.script(`if (process.argv[2] === 'test') { console.error('no library targets found'); process.exit(101); }`);
		const binary = await f.call("cargo_test", {}, f.root);
		expect(binary.structuredContent).toMatchObject({ state: "passed", doctests: null });
		const filtered = await f.call("cargo_test", { filter: "fixture" }, f.root);
		expect(f.text(filtered)).toContain("doctests: skipped (a filter is set)");
		expect(filtered.structuredContent).toMatchObject({ state: "passed", doctests: null });
		f.script(
			`if (process.argv[2] === 'test') { console.log('test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s'); process.exit(101); }`,
		);
		const failed = await f.call("cargo_test", {}, f.root);
		expect(failed.isError).toBe(true);
		expect(failed.structuredContent).toMatchObject({ state: "failed", doctests: { passed: 0, failed: 1 } });
	});

	it("reads nested fresh criterion estimates, ignores stale results, and bounds raw failures", async () => {
		const f = setup();
		const target = join(f.root, "custom-target");
		const criterion = join(target, "criterion");
		// Keep the freshness cutoff fixed while the executable starts on a loaded host.
		vi.spyOn(Date, "now").mockReturnValue(Date.now());
		const estimate = { mean: { point_estimate: 1000, confidence_interval: { lower_bound: 900, upper_bound: 1100 } } };
		for (const [name, change, stale] of [
			["group/z", true, false],
			["a", false, false],
			["old", false, true],
		] as const) {
			const dir = join(criterion, name, "new");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "estimates.json"), JSON.stringify(estimate));
			if (change) {
				mkdirSync(join(criterion, name, "change"));
				writeFileSync(
					join(criterion, name, "change", "estimates.json"),
					JSON.stringify({ mean: { point_estimate: 0.1 } }),
				);
			}
			if (stale) utimesSync(join(dir, "estimates.json"), 0, 0);
		}
		mkdirSync(join(criterion, "report"));
		writeFileSync(join(criterion, "file"), "ignored");
		f.script('require("node:fs").writeFileSync("args.json", JSON.stringify(process.argv.slice(2)));');
		vi.stubEnv("CARGO_TARGET_DIR", "custom-target");
		const result = await f.call(
			"cargo_bench",
			{ package: "fixture", save_baseline: "now", baseline: "old", filter: "group" },
			f.root,
		);
		expect(result.structuredContent).toEqual({
			state: "ok",
			estimates: [
				{ name: "a", meanNs: 1000, lowerNs: 900, upperNs: 1100, changePct: null },
				{ name: "group/z", meanNs: 1000, lowerNs: 900, upperNs: 1100, changePct: 10 },
			],
		});
		expect(f.text(result)).toContain("change +10.00%");
		expect(JSON.parse(readFileSync(join(f.root, "args.json"), "utf8"))).toEqual([
			"bench",
			"-p",
			"fixture",
			"--benches",
			"--",
			"--save-baseline",
			"now",
			"--baseline",
			"old",
			"group",
		]);
		vi.stubEnv("CARGO_TARGET_DIR", "");
		f.script('console.error("bench failed"); process.exit(1);');
		const failed = await f.call("cargo_bench", { bench: "named" }, f.root);
		expect(failed.structuredContent).toEqual({ state: "failed", estimates: [] });
		expect(f.text(failed)).toContain("no criterion estimates found");
		expect(f.text(failed)).toContain("bench failed");
	});

	it("cancels a queued call without starting an executable", async () => {
		const f = setup();
		f.script('require("node:fs").writeFileSync("started", "wrong"); throw new Error("must not start");');
		const controller = new AbortController();
		const updates: unknown[] = [];
		await withLock(`cargo:${f.root}`, async () => {
			const pending = f.tools
				.get("cargo_check")
				?.execute("id", {}, controller.signal, ((value: unknown) => updates.push(value)) as never, { cwd: f.root });
			controller.abort();
			expect(await pending).toMatchObject({ isError: true });
		});
		expect(JSON.stringify(updates)).toContain("queued behind");
		expect(existsSync(join(f.root, "started"))).toBe(false);
	});
});
