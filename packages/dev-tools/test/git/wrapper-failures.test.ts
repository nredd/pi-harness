import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FileLockFailedError, LockAbortedError, withFileLock } from "../../src/core/index.ts";
import { registerGitTools } from "../../src/git/index.ts";
import { git } from "../../src/git/run.ts";
import { createMockPi } from "../support.ts";
import { wrapperFixture } from "../wrapper-fixture.ts";

vi.mock("../../src/git/run.ts", async (original) => {
	const actual = await original<typeof import("../../src/git/run.ts")>();
	return { ...actual, git: vi.fn(actual.git) };
});
vi.mock("../../src/core/index.ts", async (original) => {
	const actual = await original<typeof import("../../src/core/index.ts")>();
	return { ...actual, withFileLock: vi.fn(actual.withFileLock) };
});
/** Apply to both fixture setup and wrapper children; teardown restores the inherited environment. */
function isolateGitEnvironment() {
	// Git has routing/config variables beyond the familiar GIT_DIR pair, including indexed config keys.
	for (const key of Object.keys(process.env)) if (key.startsWith("GIT_")) vi.stubEnv(key, undefined);
	for (const [key, value] of Object.entries({
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_TEMPLATE_DIR: "",
	}))
		vi.stubEnv(key, value);
}
beforeEach(async () => {
	isolateGitEnvironment();
	const actual = await vi.importActual<typeof import("../../src/git/run.ts")>("../../src/git/run.ts");
	vi.mocked(git).mockImplementation(actual.git);
});
afterEach(() => {
	vi.mocked(git).mockReset();
	vi.clearAllMocks();
	vi.unstubAllEnvs();
});

it.each(["routing", "config-count", "config-parameters"])(
	"confines fixture and wrapper writes despite hostile inherited %s variables",
	async (kind) => {
		const f = wrapperFixture("Cargo.toml");
		try {
			const decoy = join(f.root, "decoy");
			const target = join(f.root, "target");
			const hooks = join(f.root, "external-hooks");
			mkdirSync(hooks);
			const hook = join(hooks, "pre-commit");
			writeFileSync(hook, '#!/bin/sh\nprintf invoked > "$0.ran"\nexit 1\n', { mode: 0o700 });
			const cleanEnv = { ...process.env };
			const cleanGit = (cwd: string, args: string[]) =>
				execFileSync("git", args, { cwd, env: cleanEnv, encoding: "utf8" }).trim();
			cleanGit(f.root, ["init", "-q", "-b", "main", decoy]);
			writeFileSync(join(decoy, "a"), "decoy\n");
			cleanGit(decoy, ["add", "a"]);
			cleanGit(decoy, [
				"-c",
				"user.name=fixture",
				"-c",
				"user.email=fixture@example.invalid",
				"commit",
				"-qm",
				"Decoy initial",
			]);
			cleanGit(decoy, ["config", "core.hooksPath", hooks]);
			const head = cleanGit(decoy, ["rev-parse", "HEAD"]);
			const index = readFileSync(join(decoy, ".git", "index"));
			const config = readFileSync(join(decoy, ".git", "config"));
			const hostile =
				kind === "routing"
					? {
							GIT_DIR: join(decoy, ".git"),
							GIT_WORK_TREE: decoy,
							GIT_COMMON_DIR: join(decoy, ".git"),
							GIT_INDEX_FILE: join(decoy, ".git", "index"),
							GIT_OBJECT_DIRECTORY: join(decoy, ".git", "objects"),
							GIT_ALTERNATE_OBJECT_DIRECTORIES: join(decoy, ".git", "objects"),
							GIT_CONFIG: join(decoy, ".git", "config"),
							GIT_NAMESPACE: "hostile",
						}
					: kind === "config-count"
						? {
								GIT_CONFIG_COUNT: "1",
								GIT_CONFIG_KEY_0: "core.hooksPath",
								GIT_CONFIG_VALUE_0: hooks,
								GIT_CONFIG_KEY_17: "orphaned.key",
								GIT_CONFIG_VALUE_17: "orphaned value",
							}
						: { GIT_CONFIG_PARAMETERS: `'core.hooksPath'='${hooks}'` };
			for (const [key, value] of Object.entries(hostile)) vi.stubEnv(key, value);
			isolateGitEnvironment();
			// Neither init/config nor the wrapper gets an explicit env override: both must inherit the sanitized env.
			execFileSync("git", ["init", "-q", "-b", "main", target]);
			execFileSync("git", ["-C", target, "config", "user.name", "fixture"]);
			execFileSync("git", ["-C", target, "config", "user.email", "fixture@example.invalid"]);
			writeFileSync(join(target, "a"), "target\n");
			const mock = createMockPi();
			registerGitTools(mock.pi);
			const result = await mock.call(
				"git_commit",
				{ subject: "Commit isolated fixture", paths: ["a"], push: false },
				target,
			);
			expect(existsSync(`${hook}.ran`)).toBe(false);
			expect(result.structuredContent, mock.text(result)).toMatchObject({ stage: "done", pushed: false });
			expect(existsSync(join(target, ".git", "objects"))).toBe(true);
			expect(cleanGit(target, ["log", "-1", "--format=%s"])).toBe("Commit isolated fixture");
			expect(cleanGit(target, ["show", "HEAD:a"])).toBe("target");
			expect(cleanGit(decoy, ["rev-parse", "HEAD"])).toBe(head);
			expect(readFileSync(join(decoy, ".git", "index"))).toEqual(index);
			expect(readFileSync(join(decoy, ".git", "config"))).toEqual(config);
			expect(readFileSync(join(decoy, "a"), "utf8")).toBe("decoy\n");
			for (const key of Object.keys(hostile)) expect(process.env[key], key).toBeUndefined();
		} finally {
			f.cleanup();
		}
	},
);

it("returns body-validation and unreadable-HEAD errors without claiming a push", async () => {
	const f = wrapperFixture("Cargo.toml");
	try {
		execFileSync("git", ["init", "-q", "-b", "main", f.root]);
		const mock = createMockPi();
		registerGitTools(mock.pi);
		const invalid = await mock.call(
			"git_commit",
			{ subject: "Validate body", why: "bad\u2014body", paths: ["a"] },
			f.root,
		);
		expect(invalid.structuredContent).toMatchObject({ stage: "validate", sha: null, pushed: false });
		expect(mock.text(invalid)).toContain("commit body must not contain");
		writeFileSync(join(f.root, "a"), "a");
		execFileSync("git", ["-C", f.root, "config", "user.name", "fixture"]);
		execFileSync("git", ["-C", f.root, "config", "user.email", "fixture@example.invalid"]);
		const actual = await vi.importActual<typeof import("../../src/git/run.ts")>("../../src/git/run.ts");
		vi.mocked(git).mockImplementation(async (args, opts) =>
			args[0] === "log"
				? {
						exitCode: 1,
						termSignal: null,
						stdout: "",
						stderr: "HEAD unavailable",
						stdoutDropped: 0,
						stderrDropped: 0,
						timedOut: false,
						aborted: false,
						durationMs: 0,
					}
				: actual.git(args, opts),
		);
		const result = await mock.call("git_commit", { subject: "Commit fixture", paths: ["a"] }, f.root);
		expect(result.structuredContent).toMatchObject({ stage: "commit", pushed: false });
		expect(mock.text(result)).toContain("committed, but could not read HEAD: HEAD unavailable");
		expect(execFileSync("git", ["-C", f.root, "log", "-1", "--format=%s"], { encoding: "utf8" }).trim()).toBe(
			"Commit fixture",
		);
	} finally {
		f.cleanup();
	}
});

it("maps lock failures and queued cancellation, and rethrows unexpected lock defects", async () => {
	const f = wrapperFixture("Cargo.toml");
	try {
		execFileSync("git", ["init", "-q", "-b", "main", f.root]);
		const mock = createMockPi();
		registerGitTools(mock.pi);
		for (const failure of [new LockAbortedError("fixture"), new FileLockFailedError("fixture", "disk full")]) {
			vi.mocked(withFileLock).mockRejectedValueOnce(failure);
			const result = await mock.call("git_worktree_prune", {}, f.root);
			expect(result.isError).toBe(true);
			expect(mock.text(result)).toContain(failure instanceof LockAbortedError ? "aborted while waiting" : "disk full");
		}
		vi.mocked(withFileLock).mockRejectedValueOnce(new Error("unexpected lock defect"));
		await expect(mock.call("git_worktree_prune", {}, f.root)).rejects.toThrow("unexpected lock defect");
	} finally {
		f.cleanup();
	}
});
