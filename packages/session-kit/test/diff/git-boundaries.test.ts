import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadDiff, runGit, untrackedPatch } from "../../src/diff/git.ts";

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, spawn: vi.fn(actual.spawn) };
});

/** Only the process/pipe boundary is controlled; production cap, termination and parsing still run. */
class Child extends EventEmitter {
	readonly pid = 900_001;
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	exitCode: number | null = null;
}

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "psk-git-boundaries-"));
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.mocked(spawn).mockReset();
	rmSync(root, { recursive: true, force: true });
});

/** Complete one subprocess response on the microtask queue, after runGit installs its listeners. */
function reply(stdout: string, code = 0, stderr = ""): void {
	vi.mocked(spawn).mockImplementationOnce(() => {
		const child = new Child();
		queueMicrotask(() => {
			child.stdout.write(stdout);
			child.stderr.write(stderr);
			child.exitCode = code;
			child.emit("close", code);
		});
		return child as unknown as ChildProcess;
	});
}

describe("diff process and filesystem boundaries", () => {
	it("hard-resolves a capped process with pipes held open, retaining only the exact byte budget", async () => {
		vi.useFakeTimers();
		const child = new Child();
		vi.mocked(spawn).mockReturnValueOnce(child as unknown as ChildProcess);
		const kill = vi.spyOn(process, "kill").mockReturnValue(true);
		const running = runGit([], { cwd: root, maxBytes: 3, timeoutMs: 20_000 });
		child.stdout.write("abcdef");
		expect(kill).toHaveBeenCalledExactlyOnceWith(-child.pid, "SIGTERM");
		await vi.advanceTimersByTimeAsync(3_000);
		const result = await running;
		expect(result).toEqual({
			stdout: Buffer.from("abc"),
			stderr: "",
			code: null,
			truncated: true,
			spawnError: undefined,
		});
		expect(kill.mock.calls).toEqual([
			[-child.pid, "SIGTERM"],
			[-child.pid, "SIGKILL"],
		]);
		expect(child.stdout.destroyed).toBe(true);
		expect(child.stderr.destroyed).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("reports a failed untracked listing instead of representing the result as complete", async () => {
		reply(`${root}\n`);
		reply("HEAD\n");
		reply("");
		reply("", 1, "listing denied\nprivate trailing detail");
		const result = await loadDiff(root);
		expect(result).toEqual({
			ok: true,
			files: [],
			root,
			label: "HEAD",
			notices: ["could not list untracked files: listing denied"],
		});
		expect(vi.mocked(spawn).mock.calls.at(-1)?.[1]).toContain("ls-files");
	});

	it("represents a non-regular untracked path without attempting to read it as a file", async () => {
		mkdirSync(join(root, "directory"));
		expect(await untrackedPatch(root, "directory", 100)).toEqual({
			path: "directory",
			status: "untracked",
			hunkStart: 4,
			additions: 0,
			deletions: 0,
			lines: [
				"diff --git a/directory b/directory",
				"new file (untracked)",
				"--- /dev/null",
				"+++ b/directory",
				"\\ not a regular file",
			],
		});
	});
});
