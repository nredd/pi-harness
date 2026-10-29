import { ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withFileLock } from "../../src/core/filelock.ts";
import { run } from "../../src/core/process.ts";

vi.mock("node:fs", async (original) => {
	const actual = await original<typeof import("node:fs")>();
	return {
		...actual,
		statSync: vi.fn(actual.statSync),
		writeFileSync: vi.fn(actual.writeFileSync),
		rmSync: vi.fn(actual.rmSync),
	};
});
vi.mock("node:child_process", async (original) => ({
	...(await original<typeof import("node:child_process")>()),
	spawn: vi.fn(),
}));
const roots: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function lock() {
	const root = fs.mkdtempSync(join(tmpdir(), "dev-tools-lock-failure-"));
	roots.push(root);
	return join(root, "lock");
}

describe("bounded failure recovery", () => {
	it("settles even when a killed child's pipes never emit close", async () => {
		vi.useFakeTimers();
		const child = new ChildProcess();
		Object.defineProperty(child, "pid", { value: 123456789 });
		Object.defineProperties(child, {
			stdout: { value: new PassThrough() },
			stderr: { value: new PassThrough() },
		});
		vi.mocked(spawn).mockReturnValueOnce(child);
		const kill = vi.spyOn(process, "kill").mockReturnValue(true);
		const pending = run({ cmd: "fixture", args: [], timeoutMs: 10 });
		await vi.runAllTimersAsync();
		expect(await pending).toMatchObject({ timedOut: true, exitCode: null });
		const sigkills = kill.mock.calls.filter(([, signal]) => signal === "SIGKILL");
		expect(sigkills.length).toBeGreaterThan(0);
		for (const [target] of sigkills) expect(target).toBe(-123456789);
	});

	it("propagates acquisition errors without running the critical section", async () => {
		const fn = vi.fn();
		await expect(withFileLock(join(lock(), "absent", "lock"), fn)).rejects.toMatchObject({ code: "ENOENT" });
		expect(fn).not.toHaveBeenCalled();
	});

	it("treats vanished ownerless lock metadata as contention, not an abandoned lock", async () => {
		const dir = lock();
		fs.mkdirSync(dir);
		vi.spyOn(fs, "statSync").mockImplementationOnce(() => {
			throw new Error("vanished");
		});
		await expect(withFileLock(dir, async () => "wrong", { timeoutMs: 0 })).rejects.toThrow("lock-timeout");
		expect(fs.existsSync(dir)).toBe(true);
	});

	it.each(["publication", "removal"])("retains a stale lock if reclaim %s fails", async (failure) => {
		const dir = lock();
		fs.mkdirSync(dir);
		fs.utimesSync(dir, 0, 0);
		if (failure === "publication") {
			vi.spyOn(fs, "writeFileSync").mockImplementationOnce(() => {
				throw new Error("disk full");
			});
		} else {
			vi.spyOn(fs, "rmSync").mockImplementationOnce(() => {
				throw new Error("permission denied");
			});
		}
		await expect(withFileLock(dir, async () => "wrong", { timeoutMs: 0 })).rejects.toThrow("lock-timeout");
		expect(fs.existsSync(dir)).toBe(true);
	});
});
