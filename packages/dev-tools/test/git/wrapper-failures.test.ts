import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
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
afterEach(() => {
	vi.clearAllMocks();
	vi.unstubAllEnvs();
});

it("returns body-validation and unreadable-HEAD errors without claiming a push", async () => {
	const f = wrapperFixture("Cargo.toml");
	try {
		for (const [key, value] of Object.entries({
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_TEMPLATE_DIR: "",
		}))
			vi.stubEnv(key, value);
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
		vi.mocked(git).mockImplementation(actual.git);
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
