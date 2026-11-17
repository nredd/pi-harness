import { describe, expect, it } from "vitest";
import type { RunResult } from "../../src/core/index.ts";
import { assertExplicitPaths, assertRef, gitExitText, gitFailure, gitState } from "../../src/git/run.ts";

/** A normal git exit: no signal, no timeout, no abort. */
function exited(exitCode: number, stderr: string, stdout = ""): RunResult {
	return {
		exitCode,
		termSignal: null,
		stdout,
		stderr,
		stdoutDropped: 0,
		stderrDropped: 0,
		timedOut: false,
		aborted: false,
		durationMs: 1,
	};
}

describe("assertExplicitPaths", () => {
	it("refuses an empty list and blank entries before any per-path rule", () => {
		expect(assertExplicitPaths([])).toBe("paths must name at least one file");
		expect(assertExplicitPaths(["a.txt", "  "])).toBe("paths must not be empty");
		expect(assertExplicitPaths(["a.txt", "dir/b.txt"])).toBeUndefined();
	});
});

describe("assertRef", () => {
	it("refuses a blank ref and names it", () => {
		expect(assertRef(" \t", "base")).toBe("base must not be empty");
		expect(assertRef("main", "base")).toBeUndefined();
	});
});

describe("gitState", () => {
	it.each([
		["error: pathspec 'x' did not match any file(s) known to git", "path not tracked"],
		["fatal: The current branch topic has no upstream branch.", "no upstream"],
		[" ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs", "push rejected"],
		["fatal: 'topic' is already checked out at '/r/wt'", "branch checked out elsewhere"],
		["fatal: 'topic' is already used by worktree at '/r/wt'", "branch checked out elsewhere"],
		["fatal: '/r/wt' contains modified or untracked files, use --force to delete it", "dirty worktree"],
		["fatal: '/r/wt' is locked; use 'move -f -f' to override or unlock first", "locked worktree"],
		["fatal: '/r' is a main working tree", "main worktree"],
		["fatal: a branch named 'topic' already exists", "branch exists"],
		["fatal: '/r/wt' already exists", "path exists"],
		["fatal: something new", "exit 128"],
	])("names %j as %s", (stderr, state) => {
		expect(gitState(exited(128, stderr))).toBe(state);
	});
});

describe("gitFailure", () => {
	it("falls back to stdout when git wrote nothing to stderr", () => {
		expect(gitFailure(exited(1, "", "  conflict in a.txt\n"), "git merge")).toBe(
			"git merge: exit 1\nconflict in a.txt",
		);
		expect(gitExitText(exited(1, "", "out\n"), "git merge")).toBe("git merge: exit 1\nout");
		expect(gitFailure(exited(0, ""), "git merge")).toBeUndefined();
	});
});
