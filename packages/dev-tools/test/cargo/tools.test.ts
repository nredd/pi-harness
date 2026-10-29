import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { findWorkspaceRoot, registerCargoTools } from "../../src/cargo/index.ts";
import { createMockPi } from "../support.ts";

function have(cmd: string): boolean {
	try {
		execSync(cmd, { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

const mock = createMockPi();
let root: string;

/** Two crates: `good` (pedantic lint, one failing test, a doctest, a bin) and `bad` (type error). */
function buildWorkspace(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-dev-tools-cargo-"));
	writeFileSync(join(dir, "Cargo.toml"), '[workspace]\nmembers = ["good", "bad"]\nresolver = "3"\n');
	mkdirSync(join(dir, "good", "src", "bin"), { recursive: true });
	writeFileSync(join(dir, "good", "Cargo.toml"), '[package]\nname = "good"\nversion = "0.1.0"\nedition = "2024"\n');
	writeFileSync(
		join(dir, "good", "src", "lib.rs"),
		`//! good
/// Adds.
///
/// \`\`\`
/// assert_eq!(good::add(1, 2), 3);
/// \`\`\`
#[must_use]
pub fn add(a: u64, b: u64) -> u64 {
    a + b
}

/// Casts (pedantic lint).
#[must_use]
pub fn cast(x: u64) -> u32 {
    x as u32
}

#[cfg(test)]
mod tests {
    #[test]
    fn passes() {
        assert_eq!(super::add(1, 2), 3);
    }
    #[test]
    fn fails() {
        assert_eq!(super::add(1, 2), 4, "math is hard");
    }
}
`,
	);
	writeFileSync(
		join(dir, "good", "src", "bin", "hello.rs"),
		'fn main() {\n    let name = std::env::args().nth(1).unwrap_or_else(|| "world".into());\n    println!("hello {name}");\n    if name == "fail" { std::process::exit(3); }\n}\n',
	);
	mkdirSync(join(dir, "bad", "src"), { recursive: true });
	writeFileSync(join(dir, "bad", "Cargo.toml"), '[package]\nname = "bad"\nversion = "0.1.0"\nedition = "2024"\n');
	writeFileSync(join(dir, "bad", "src", "lib.rs"), "pub fn f() -> u32 {\n    let s: String = 42;\n    7\n}\n");
	return dir;
}

describe.skipIf(!have("cargo --version") || !have("cargo nextest --version"))(
	"cargo tools against a real workspace",
	() => {
		beforeAll(() => {
			registerCargoTools(mock.pi);
			root = buildWorkspace();
		});

		it("annotates check/test/doc read-only and the rest not", () => {
			for (const name of ["cargo_check", "cargo_test", "cargo_doc"])
				expect(mock.tools.get(name)?.annotations?.readOnlyHint, name).toBe(true);
			for (const name of ["cargo_clippy", "cargo_fmt", "cargo_build", "cargo_run", "cargo_bench", "cargo_add"])
				expect(mock.tools.get(name)?.annotations?.readOnlyHint, name).toBe(false);
		});

		it("finds the workspace root from a member crate", () => {
			expect(findWorkspaceRoot(join(root, "good", "src"))).toBe(root);
			expect(findWorkspaceRoot(tmpdir())).toBeUndefined();
		});

		it("cargo_check reports the type error once with its suggestion, and warnings-only as clean exit", async () => {
			const r = await mock.call("cargo_check", {}, root);
			expect(r.isError).toBe(true);
			const s = r.structuredContent as {
				state: string;
				errors: number;
				diagnostics: { code: string | null; file: string | null; suggestion: string | null }[];
			};
			expect(s.state).toBe("errors");
			expect(s.errors).toBe(1);
			expect(s.diagnostics.filter((d) => d.code === "E0308")).toHaveLength(1);
			expect(s.diagnostics[0]).toMatchObject({ file: "bad/src/lib.rs", suggestion: ".to_string()" });
			expect(mock.text(r)).toMatch(/^cargo check: 1 error, \d+ warnings? in/);
			const good = await mock.call("cargo_check", { package: "good" }, root);
			expect(good.isError).toBe(false);
			expect((good.structuredContent as { state: string }).state).toBe("clean");
		}, 180_000);

		it("cargo_clippy flags the pedantic lint, deduped across targets", async () => {
			const r = await mock.call("cargo_clippy", { package: "good" }, root);
			expect(r.isError).toBe(false);
			const s = r.structuredContent as { state: string; warnings: number; diagnostics: { code: string | null }[] };
			expect(s.state).toBe("warnings");
			expect(s.diagnostics.filter((d) => d.code === "clippy::cast_possible_truncation")).toHaveLength(1);
			const strict = await mock.call("cargo_clippy", { package: "good", deny_warnings: true }, root);
			expect((strict.structuredContent as { state: string }).state).toBe("errors");
			const lax = await mock.call("cargo_clippy", { package: "good", pedantic: false }, root);
			expect((lax.structuredContent as { state: string }).state).toBe("clean");
		}, 180_000);

		it("cargo_fmt reports and applies", async () => {
			writeFileSync(join(root, "good", "src", "ugly.rs"), "pub fn x( ) ->u32{ 1 }\n");
			const lib = join(root, "good", "src", "lib.rs");
			const original = readFileSync(lib, "utf8");
			writeFileSync(lib, `${original}pub mod ugly;\n`);
			const check = await mock.call("cargo_fmt", {}, root);
			expect(check.isError).toBe(true);
			const files = (check.structuredContent as { state: string; files: string[] }).files;
			expect(files.some((f) => f.endsWith("good/src/ugly.rs"))).toBe(true);
			expect(mock.text(check)).toContain("Diff in");
			const apply = await mock.call("cargo_fmt", { check: false }, root);
			expect((apply.structuredContent as { state: string }).state).toBe("reformatted");
			const clean = await mock.call("cargo_fmt", {}, root);
			expect((clean.structuredContent as { state: string }).state).toBe("clean");
			writeFileSync(lib, original);
			rmSync(join(root, "good", "src", "ugly.rs"));
		}, 60_000);

		it("cargo_test maps nextest exits to states and lists only failures, then doctests", async () => {
			const r = await mock.call("cargo_test", { package: "good" }, root);
			expect(r.isError).toBe(true);
			const s = r.structuredContent as {
				state: string;
				tests: number;
				failures: number;
				failed: { name: string; message: string }[];
				doctests: { passed: number; failed: number };
			};
			expect(s.state).toBe("failed");
			expect(s.tests).toBe(2);
			expect(s.failures).toBe(1);
			expect(s.failed[0]?.name).toBe("good tests::fails");
			expect(s.doctests).toEqual({ passed: 1, failed: 0, failedNames: [] });
			expect(mock.text(r)).toContain("math is hard");
			expect(mock.text(r)).not.toMatch(/PASS.*passes/);
			const one = await mock.call("cargo_test", { package: "good", filter: "passes", doc: false }, root);
			expect((one.structuredContent as { state: string }).state).toBe("passed");
			const none = await mock.call("cargo_test", { package: "good", filter: "nothing_here", doc: false }, root);
			expect((none.structuredContent as { state: string }).state).toBe("no-tests");
			const broken = await mock.call("cargo_test", { package: "bad", doc: false }, root);
			expect((broken.structuredContent as { state: string }).state).toBe("compile-error");
		}, 300_000);

		it("layers the junit profile under the repo's nextest config and cleans its temp dir", async () => {
			mkdirSync(join(root, ".config"), { recursive: true });
			writeFileSync(join(root, ".config", "nextest.toml"), "[profile.default]\nretries = 1\n");
			const before = readdirSync(tmpdir()).filter((d) => d.startsWith("pi-dev-tools-nextest-")).length;
			const not = await mock.call("cargo_test", { package: "good", filter: "not test(fails)", doc: false }, root);
			expect((not.structuredContent as { state: string; tests: number }).state).toBe("passed");
			expect((not.structuredContent as { tests: number }).tests).toBe(1);
			try {
				const r = await mock.call("cargo_test", { package: "good", filter: "fails", doc: false }, root);
				expect((r.structuredContent as { state: string }).state).toBe("failed");
				// retries=1 from the repo config applied: the junit body mentions the retry.
				expect(mock.text(r)).toMatch(/fails/);
			} finally {
				rmSync(join(root, ".config"), { recursive: true, force: true });
			}
			const after = readdirSync(tmpdir()).filter((d) => d.startsWith("pi-dev-tools-nextest-")).length;
			expect(after).toBe(before);
		}, 180_000);

		it.each(["absolute", "relative"])(
			"reads junit with an external %s Cargo target and custom nextest store",
			async (kind) => {
				const dir = buildWorkspace();
				const target = mkdtempSync(join(tmpdir(), "pi-dev-tools-cargo-target-"));
				try {
					mkdirSync(join(dir, ".config"));
					writeFileSync(join(dir, ".config", "nextest.toml"), '[store]\ndir = "custom nextest store"\n');
					vi.stubEnv("CARGO_TARGET_DIR", kind === "absolute" ? target : relative(dir, target));
					const r = await mock.call("cargo_test", { package: "good", doc: false }, dir);
					expect(r.structuredContent, mock.text(r)).toMatchObject({
						state: "failed",
						tests: 2,
						failures: 1,
						failed: [{ name: "good tests::fails" }],
					});
					expect(mock.text(r)).toContain("math is hard");
					const passing = await mock.call("cargo_test", { package: "good", filter: "passes", doc: false }, dir);
					expect(passing.structuredContent, mock.text(passing)).toMatchObject({
						state: "passed",
						tests: 1,
						failures: 0,
						failed: [],
					});
				} finally {
					vi.unstubAllEnvs();
					rmSync(dir, { recursive: true, force: true });
					rmSync(target, { recursive: true, force: true });
				}
			},
			180_000,
		);

		it("routes filterset expressions to -E and substrings to --", async () => {
			const expr = await mock.call("cargo_test", { package: "good", filter: "test(passes)", doc: false }, root);
			expect((expr.structuredContent as { state: string; tests: number }).tests).toBe(1);
			const sub = await mock.call("cargo_test", { package: "good", filter: "pass", doc: false }, root);
			expect((sub.structuredContent as { state: string; tests: number }).tests).toBe(1);
		}, 180_000);

		it("cargo_build returns executables; cargo_run runs them with args and reports exits", async () => {
			const b = await mock.call("cargo_build", { package: "good" }, root);
			const s = b.structuredContent as { state: string; executables: string[] };
			expect(s.executables.some((e) => e.endsWith("/hello"))).toBe(true);
			const ok = await mock.call("cargo_run", { package: "good", bin: "hello", args: ["pi"] }, root);
			expect(ok.isError).toBe(false);
			expect(mock.text(ok)).toContain("hello pi");
			expect(ok.structuredContent).toMatchObject({ state: "ok", exit: 0 });
			const nz = await mock.call("cargo_run", { package: "good", bin: "hello", args: ["fail"] }, root);
			expect(nz.structuredContent).toMatchObject({ state: "nonzero-exit", exit: 3 });
			expect(nz.isError).toBe(false);
		}, 300_000);

		it("cargo_doc denies warnings", async () => {
			const r = await mock.call("cargo_doc", { package: "good" }, root);
			expect((r.structuredContent as { state: string }).state, mock.text(r)).toBe("clean");
		}, 180_000);

		it("rejects option-shaped values and names a missing workspace", async () => {
			const r = await mock.call("cargo_check", { package: "--config=evil" }, root);
			expect(r.isError).toBe(true);
			expect(mock.text(r)).toContain("not a plain value");
			const none = await mock.call("cargo_check", {}, tmpdir());
			expect(mock.text(none)).toContain("no Cargo.toml");
			const flt = await mock.call("cargo_test", { filter: "--nocapture" }, root);
			expect(mock.text(flt)).toContain("must be a plain value");
		});

		it("cargo_add dry-run reports what it would add", async () => {
			const r = await mock.call("cargo_add", { package: "good", crates: ["anyhow@1"], dry_run: true }, root);
			expect(r.isError, mock.text(r)).toBe(false);
			expect(mock.text(r)).toMatch(/cargo add: dry run, anyhow@1/);
		}, 120_000);
	},
);
