import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
	vi.stubEnv("CARGO_TARGET_DIR", "");
	const fixture = wrapperFixture("Cargo.toml");
	fixtures.push(fixture);
	const mock = createMockPi();
	registerCargoTools(mock.pi, { cargoBin: fixture.bin, rustupBin: fixture.bin });
	return { ...fixture, ...mock };
}
const fixture = (name: string) => readFileSync(join(import.meta.dirname, "..", "fixtures", "cargo", name), "utf8");
/** `/bin/sh` body that appends its argv, one argument per line and a blank line after each call. */
const RECORD_ARGV = `for a in "$@"; do printf '%s\\n' "$a"; done >> argv.log; echo >> argv.log`;
const argvLog = (root: string): string[][] =>
	readFileSync(join(root, "argv.log"), "utf8")
		.trimEnd()
		.split("\n\n")
		.map((call) => call.split("\n"));
/** nextest body: write `xml` to the junit path the wrapper's tool config names, then exit `code`. */
const nextest = (xml: string, code: number, doc = "") =>
	`const fs = require("node:fs"); const a = process.argv.slice(2);
if (a[0] === "nextest") {
	const cfg = a[a.indexOf("--tool-config-file") + 1].replace(/^pi-dev-tools:/, "");
	fs.writeFileSync(JSON.parse(/path = (.*)/.exec(fs.readFileSync(cfg, "utf8"))[1]), ${JSON.stringify(xml)});
	process.exit(${code});
}
${doc}`;
const TOOLS = ["check", "clippy", "fmt", "test", "build", "run", "doc", "bench", "add"] as const;
const minimal = (name: string) => (name === "add" ? { crates: ["local"] } : {});

describe("cargo executable boundary", () => {
	it("maps abnormal exits and noncompiler failures for every wrapper", async () => {
		// 13 sequential launches: a shell, not a fresh runtime, so the sweep stays cheap under load.
		const f = setup();
		for (const name of ["check", "clippy", "fmt", "test", "build", "run", "doc", "bench", "add"]) {
			f.script("kill -TERM $$", "/bin/sh");
			const result = await f.call(`cargo_${name}`, name === "add" ? { crates: ["local"] } : {}, f.root);
			expect(result.isError, name).toBe(true);
			expect(f.text(result), name).toContain("SIGTERM");
		}
		f.script("echo 'manifest rejected' >&2; exit 2", "/bin/sh");
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

	it("names a missing workspace from either cwd and rejects option-shaped values on every wrapper", async () => {
		const f = setup();
		f.script('require("node:fs").writeFileSync("started", "wrong");', "/bin/sh");
		// `tmpdir()` has no Cargo.toml at or above it, so both the explicit and the session cwd miss.
		for (const name of TOOLS) {
			const explicit = await f.call(`cargo_${name}`, { ...minimal(name), cwd: tmpdir() }, f.root);
			expect(f.text(explicit), name).toBe(`no Cargo.toml found at or above ${tmpdir()}`);
			const session = await f.call(`cargo_${name}`, minimal(name), tmpdir());
			expect(f.text(session), name).toBe(`no Cargo.toml found at or above ${tmpdir()}`);
			const bad = await f.call(`cargo_${name}`, { ...minimal(name), package: "--config=evil" }, f.root);
			expect(bad.isError, name).toBe(true);
			expect(f.text(bad), name).toBe("value '--config=evil' is not a plain value");
		}
		expect(existsSync(join(f.root, "started"))).toBe(false);
	});

	it("maps every optional flag to cargo's argv", async () => {
		const f = setup();
		f.script(RECORD_ARGV, "/bin/sh");
		await f.call("cargo_check", { all_targets: false, all_features: false }, f.root);
		await f.call("cargo_clippy", { fix: true, pedantic: false }, f.root);
		await f.call("cargo_fmt", { package: "good" }, f.root);
		await f.call("cargo_build", { bin: "b", example: "e", release: true }, f.root);
		await f.call("cargo_run", { example: "e", release: true }, f.root);
		await f.call(
			"cargo_add",
			{ crates: ["serde@1"], dev: true, build: true, optional: true, features: ["derive"] },
			f.root,
		);
		await f.call("cargo_test", { no_fail_fast: false, retries: 2, nocapture: true, doc: false }, f.root);
		const [check, clippy, fmt, build, run, add, test] = argvLog(f.root);
		expect(check).toEqual(["check", "--message-format=json-diagnostic-short"]);
		expect(clippy).toEqual([
			"clippy",
			"--message-format=json-diagnostic-short",
			"--all-targets",
			"--all-features",
			"--fix",
			"--allow-dirty",
			"--allow-staged",
		]);
		expect(fmt).toEqual(["fmt", "-p", "good", "--", "--color", "never", "--check"]);
		expect(build).toEqual([
			"build",
			"--message-format=json-diagnostic-short",
			"--all-features",
			"--bin",
			"b",
			"--example",
			"e",
			"--release",
		]);
		expect(run).toEqual(["run", "-q", "--all-features", "--example", "e", "--release"]);
		expect(add).toEqual(["add", "serde@1", "--dev", "--build", "--optional", "--features", "derive"]);
		expect(test?.slice(5)).toEqual(["pi-dev-tools", "--all-features", "--retries", "2", "--nocapture"]);
	});

	it("lists errors before warnings whatever order cargo printed them in", async () => {
		const f = setup();
		const line = (level: string, message: string) =>
			JSON.stringify({
				reason: "compiler-message",
				message: { level, message, code: null, rendered: `src/lib.rs: ${level}: ${message}`, spans: [], children: [] },
			});
		f.script(
			`for (const l of ${JSON.stringify([line("warning", "w1"), line("warning", "w2"), line("error", "e1")])}) console.log(l); process.exit(101);`,
		);
		const result = await f.call("cargo_check", {}, f.root);
		expect(f.text(result).split("\n").slice(1)).toEqual([
			"src/lib.rs: error: e1",
			"src/lib.rs: warning: w1",
			"src/lib.rs: warning: w2",
		]);
		expect(result.structuredContent).toMatchObject({ state: "errors", errors: 1, warnings: 2 });
	});

	it("names a single file cargo fmt would reformat", async () => {
		const f = setup();
		f.script(`process.stdout.write(${JSON.stringify(fixture("fmt-check-one.txt"))}); process.exit(1);`);
		const result = await f.call("cargo_fmt", {}, f.root);
		expect(f.text(result)).toMatch(
			/^cargo fmt: 1 file would be reformatted\n {2}\/private\/tmp\/ws\/dep\/src\/lib\.rs\n/,
		);
		expect(result.structuredContent).toEqual({ state: "would-reformat", files: ["/private/tmp/ws/dep/src/lib.rs"] });
	});

	it("lists nextest's message-less timeout and silent-exit failures and named doctest failures", async () => {
		const f = setup();
		const doctests = `process.stdout.write(${JSON.stringify(fixture("doctest-failed.txt"))}); process.exit(101);`;
		f.script(nextest(fixture("nextest-junit-silent.xml"), 100, doctests));
		const result = await f.call("cargo_test", {}, f.root);
		expect(f.text(result)).toMatch(/^cargo test: failed \(1\/3 passed\) in \d+\.\ds\n/);
		// The failure type names the reason; absent bodies still add no indented detail.
		expect(f.text(result)).toContain(
			"  FAIL good tests::silent_exit: test failure with exit code 1\n  FAIL good tests::hangs: test timeout\ndoctests: 0 passed, 1 failed\n  good/src/lib.rs - add (line 4)",
		);
		expect(result.structuredContent).toMatchObject({
			state: "failed",
			failures: 2,
			failed: [
				{ name: "good tests::silent_exit", message: "test failure with exit code 1" },
				{ name: "good tests::hangs", message: "test timeout" },
			],
			doctests: { passed: 0, failed: 1, failedNames: ["good/src/lib.rs - add (line 4)"] },
		});
	});

	it("reports skipped and errored junit totals and an unfiltered empty run", async () => {
		const f = setup();
		const xml = `<testsuites name="nextest-run" tests="3" skipped="1" failures="0" errors="1"><testsuite name="good">
<testcase name="slow" classname="good"><error message="exec failed" type="exec">could not start</error></testcase>
</testsuite></testsuites>`;
		f.script(nextest(xml, 100));
		const errored = await f.call("cargo_test", { doc: false }, f.root);
		expect(f.text(errored)).toContain("cargo test: failed (2/3 passed, 1 skipped, 1 errored)");
		expect(f.text(errored)).toContain("  FAIL good slow: exec failed\n    could not start");
		f.script(nextest('<testsuites tests="0" failures="0" errors="0" skipped="0"></testsuites>', 4));
		const empty = await f.call("cargo_test", { doc: false }, f.root);
		expect(f.text(empty)).toBe("cargo test: no tests matched");
		expect(empty.structuredContent).toMatchObject({ state: "no-tests", tests: 0 });
	});

	it("separates cargo's compile error from the program's output", async () => {
		const f = setup();
		f.script(`process.stderr.write(${JSON.stringify(fixture("run-compile-error.stderr"))}); process.exit(101);`);
		const result = await f.call("cargo_run", { bin: "broken" }, f.root);
		expect(result.isError).toBe(true);
		expect(result.structuredContent).toEqual({ state: "compile-error", exit: 101, truncated: false });
		expect(f.text(result)).toMatch(
			/^cargo run: compile-error in \d+\.\ds\nstderr:\nerror\[E0308\]: mismatched types\n/,
		);
		expect(f.text(result)).toContain('error: could not compile `good` (bin "broken") due to 1 previous error');
	});

	it("propagates a spawn failure that is not a lock abort", async () => {
		const f = setup();
		f.script(RECORD_ARGV, "/bin/sh");
		// Node and Bun both reject NUL in argv synchronously, before any process exists.
		await expect(f.call("cargo_run", { args: ["a\0b"] }, f.root)).rejects.toThrow(/null bytes|NUL|\\0/i);
		expect(existsSync(join(f.root, "argv.log"))).toBe(false);
	});

	it("falls back to cargo's first line when a path dependency has no version", async () => {
		const f = setup();
		f.script(`process.stderr.write(${JSON.stringify(fixture("add-path.stderr"))});`);
		const result = await f.call("cargo_add", { package: "good", crates: ["dep"] }, f.root);
		expect(f.text(result)).toBe("cargo add: Adding dep (local) to dependencies");
		expect(result.structuredContent).toEqual({ state: "ok", added: [] });
	});

	it("reports a negative criterion change and skips unreadable or deeply nested results correctly", async () => {
		const f = setup();
		const criterion = join(f.root, "target", "criterion");
		vi.spyOn(Date, "now").mockReturnValue(Date.now());
		const estimate = { mean: { point_estimate: 2000, confidence_interval: { lower_bound: 1900, upper_bound: 2100 } } };
		for (const [name, body] of [
			["group/sub/deep", JSON.stringify(estimate)],
			["broken", "{not json"],
		] as const) {
			mkdirSync(join(criterion, name, "new"), { recursive: true });
			writeFileSync(join(criterion, name, "new", "estimates.json"), body);
		}
		mkdirSync(join(criterion, "group/sub/deep", "change"));
		writeFileSync(
			join(criterion, "group/sub/deep", "change", "estimates.json"),
			JSON.stringify({ mean: { point_estimate: -0.25 } }),
		);
		f.script("", "/bin/sh");
		const result = await f.call("cargo_bench", {}, f.root);
		expect(result.structuredContent).toEqual({
			state: "ok",
			estimates: [{ name: "group/sub/deep", meanNs: 2000, lowerNs: 1900, upperNs: 2100, changePct: -25 }],
		});
		expect(f.text(result)).toContain("  group/sub/deep: 2.00 us [1.90 us .. 2.10 us] change -25.00%");
	});
});
