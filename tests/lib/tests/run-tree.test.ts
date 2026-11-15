import { expect, it, vi } from "vitest";
import { runTree } from "../src/run-tree.ts";

it("captures output and the exit status of a finished child", async () => {
	const result = await runTree("sh", ["-c", "echo out; echo err >&2; exit 3"], { timeoutMs: 10_000 });
	expect(result).toMatchObject({ status: 3, stdout: "out\n", stderr: "err\n", timedOut: false });
});

it("kills a TERM-resistant descendant holding the pipes, then resolves", async () => {
	const start = performance.now();
	const result = await runTree("sh", ["-c", "trap '' TERM; sleep 30 & echo $!; wait"], { timeoutMs: 300 });
	expect(result.timedOut).toBe(true);
	expect(result.signal).toBe("SIGKILL");
	expect(performance.now() - start).toBeLessThan(8_000);
	const descendant = Number(result.stdout.trim());
	expect(descendant).toBeGreaterThan(0);
	expect(() => process.kill(descendant, 0)).toThrow(/ESRCH/);
});

it("reports a spawn failure instead of hanging", async () => {
	const result = await runTree("/nonexistent/binary", [], { timeoutMs: 10_000 });
	expect(result.error?.message).toMatch(/ENOENT/);
	expect(result.timedOut).toBe(false);
});

it("treats a group that already exited (ESRCH) as dead when the timeout fires", async () => {
	const kill = vi.spyOn(process, "kill").mockImplementation(() => {
		throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
	});
	try {
		const result = await runTree("sh", ["-c", "sleep 0.5"], { timeoutMs: 50 });
		expect(kill).toHaveBeenCalledOnce();
		expect(result).toMatchObject({ timedOut: true, status: 0 });
	} finally {
		kill.mockRestore();
	}
});

it("falls back to killing the leader when signalling the group fails for another reason", async () => {
	const kill = vi.spyOn(process, "kill").mockImplementation(() => {
		throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
	});
	try {
		const result = await runTree("sh", ["-c", "sleep 5"], { timeoutMs: 50 });
		expect(result).toMatchObject({ timedOut: true, signal: "SIGKILL" });
	} finally {
		kill.mockRestore();
	}
});

it("kills only the leader where there are no process groups (win32 path)", async () => {
	const result = await runTree("sh", ["-c", "sleep 5"], { timeoutMs: 50, platform: "win32" });
	expect(result).toMatchObject({ timedOut: true, signal: "SIGKILL" });
});
