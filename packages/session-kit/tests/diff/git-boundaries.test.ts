import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadDiff, loadStat, runGit, TOTAL_BYTES, untrackedPatch } from "../../src/diff/git.ts";

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, spawn: vi.fn(actual.spawn) };
});

/** Only the process/pipe boundary is controlled; production cap, termination and parsing still run. */
class Child extends EventEmitter {
	pid: number | undefined = 900_001;
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

/** Fail one spawn the way node does for a missing binary: an async `error`, never `close`. */
function spawnFails(message: string): void {
	vi.mocked(spawn).mockImplementationOnce(() => {
		const child = new Child();
		child.pid = undefined;
		queueMicrotask(() => child.emit("error", new Error(message)));
		return child as unknown as ChildProcess;
	});
}

describe("diff process and filesystem boundaries", () => {
	it("ignores a timeout for a child that never got a pid and resolves on close", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const child = new Child();
		child.pid = undefined;
		vi.mocked(spawn).mockReturnValueOnce(child as unknown as ChildProcess);
		const kill = vi.spyOn(process, "kill").mockReturnValue(true);
		const running = runGit([], { cwd: root, timeoutMs: 10 });
		await vi.advanceTimersByTimeAsync(10);
		expect(kill).not.toHaveBeenCalled();
		child.emit("close", 0);
		expect(await running).toMatchObject({ code: 0, truncated: false });
	});

	it("stops once, drops output after the cap and bounds stderr", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const child = new Child();
		vi.mocked(spawn).mockReturnValueOnce(child as unknown as ChildProcess);
		const kill = vi.spyOn(process, "kill").mockReturnValue(true);
		const running = runGit([], { cwd: root, maxBytes: 3, timeoutMs: 500 });
		child.stderr.write("e".repeat(5000));
		child.stderr.write("dropped");
		child.stdout.write("abcdef");
		child.stdout.write("ghi");
		// The timeout lands inside the kill grace and must not signal the group a second time.
		await vi.advanceTimersByTimeAsync(500);
		expect(kill.mock.calls).toEqual([[-900_001, "SIGTERM"]]);
		child.emit("close", null);
		await vi.advanceTimersByTimeAsync(2_000);
		const result = await running;
		expect(result.stdout.toString()).toBe("abc");
		expect(result.stderr).toBe("e".repeat(5000));
		expect(kill.mock.calls).toEqual([
			[-900_001, "SIGTERM"],
			[-900_001, "SIGKILL"],
		]);
	});

	it("reports git that cannot be spawned for the repo lookup and for the diff itself", async () => {
		spawnFails("spawn git ENOENT");
		expect(await loadDiff(root)).toEqual({ ok: false, error: "cannot run git: spawn git ENOENT" });
		reply(`${root}\n`);
		reply("HEAD\n");
		spawnFails("spawn git EACCES");
		expect(await loadDiff(root)).toEqual({ ok: false, error: "cannot run git: spawn git EACCES" });
	});

	it("fails clearly when neither HEAD nor the empty tree resolves", async () => {
		reply(`${root}\n`);
		reply("", 1);
		reply("", 128, "fatal: hash-object failed");
		expect(await loadDiff(root)).toEqual({ ok: false, error: "cannot resolve HEAD or the empty tree" });
		reply(`${root}\n`);
		reply("", 1);
		reply("");
		expect(await loadStat(root)).toEqual({ ok: false, error: "cannot resolve HEAD or the empty tree" });
	});

	it("falls back to the exit code when a failed diff prints no stderr", async () => {
		reply(`${root}\n`);
		reply("HEAD\n");
		reply("", 129);
		expect(await loadDiff(root)).toEqual({ ok: false, error: "git diff exited with 129" });
		reply(`${root}\n`);
		reply("HEAD\n");
		reply("", 129);
		expect(await loadStat(root)).toEqual({ ok: false, error: "git diff exited with 129" });
	});

	it("marks the last whole-output-cut file when the per-file cap did not already", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const kill = vi.spyOn(process, "kill").mockReturnValue(true);
		reply(`${root}\n`);
		reply("HEAD\n");
		const child = new Child();
		vi.mocked(spawn).mockReturnValueOnce(child as unknown as ChildProcess);
		reply("");
		const running = loadDiff(root);
		await vi.advanceTimersByTimeAsync(0);
		const patch = (i: number) => `diff --git a/f${i} b/f${i}\n--- a/f${i}\n+++ b/f${i}\n@@ -1 +1 @@\n-a\n+b\n`;
		let text = "";
		for (let i = 0; text.length <= TOTAL_BYTES; i++) text += patch(i);
		child.stdout.write(text);
		expect(kill).toHaveBeenCalledExactlyOnceWith(-900_001, "SIGTERM");
		await vi.advanceTimersByTimeAsync(3_000);
		const result = await running;
		if (!result.ok) throw new Error(result.error);
		expect(result.notices).toEqual(["diff output cut at 2MB; later files are missing"]);
		expect(result.files.at(-1)?.notice).toBe("patch cut by the total output cap");
		expect(result.files.at(-2)?.notice).toBeUndefined();
	});
	it("hard-resolves a capped process with pipes held open, retaining only the exact byte budget", async () => {
		vi.useFakeTimers();
		const child = new Child();
		vi.mocked(spawn).mockReturnValueOnce(child as unknown as ChildProcess);
		const kill = vi.spyOn(process, "kill").mockReturnValue(true);
		const running = runGit([], { cwd: root, maxBytes: 3, timeoutMs: 20_000 });
		child.stdout.write("abcdef");
		expect(kill).toHaveBeenCalledExactlyOnceWith(-900_001, "SIGTERM");
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
			[-900_001, "SIGTERM"],
			[-900_001, "SIGKILL"],
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
