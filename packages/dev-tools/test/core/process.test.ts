import { describe, expect, it, vi } from "vitest";
import { run } from "../../src/core/process.ts";

const pidAlive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

describe("run", () => {
	it("captures stdout, stderr and exit code separately", async () => {
		const r = await run({ cmd: "sh", args: ["-c", "echo out; echo err >&2; exit 3"] });
		expect(r.stdout).toBe("out\n");
		expect(r.stderr).toBe("err\n");
		expect(r.exitCode).toBe(3);
		expect(r.timedOut).toBe(false);
		expect(r.aborted).toBe(false);
	});

	it("applies cwd and env", async () => {
		const r = await run({ cmd: "sh", args: ["-c", "pwd; echo $PI_DT_X"], cwd: "/tmp", env: { PI_DT_X: "y" } });
		expect(r.stdout.split("\n")[1]).toBe("y");
		expect(r.stdout.split("\n")[0]).toMatch(/\/tmp$/);
	});

	it("feeds stdin and closes it", async () => {
		const r = await run({ cmd: "cat", args: [], stdin: "hello" });
		expect(r.stdout).toBe("hello");
		expect(r.exitCode).toBe(0);
	});

	it("survives a child that exits before reading stdin", async () => {
		const r = await run({ cmd: "true", args: [], stdin: "x".repeat(1 << 20) });
		expect(r.exitCode).toBe(0);
	});

	it("kills the whole process tree on timeout", async () => {
		const r = await run({
			cmd: "sh",
			args: ["-c", "sleep 30 & echo $!; wait"],
			timeoutMs: 200,
		});
		expect(r.timedOut).toBe(true);
		expect(r.exitCode).toBeNull();
		const grandchild = Number(r.stdout.trim());
		await new Promise((res) => setTimeout(res, 50));
		expect(pidAlive(grandchild)).toBe(false);
	});

	it("escalates to SIGKILL when SIGTERM is ignored", async () => {
		// The trap must be installed before the timeout fires, so give the shell a generous head start
		// and confirm via stderr that it got there.
		let ready = false;
		const t0 = Date.now();
		const r = await run({
			cmd: "sh",
			args: ["-c", "trap '' TERM; echo ready >&2; sleep 30"],
			timeoutMs: 1500,
			onStderrLine: (l) => {
				if (l === "ready") ready = true;
			},
		});
		expect(ready).toBe(true);
		expect(r.timedOut).toBe(true);
		expect(r.termSignal).toBe("SIGKILL");
		// Proves escalation: SIGTERM is ignored and sleep would run 30s. Plain node settles this in
		// 2.3s every time; vitest's between-test bookkeeping has been seen to delay a timer by seconds.
		expect(Date.now() - t0).toBeLessThan(10_000);
	}, 20_000);

	it("does not call a clean exit a timeout when a grandchild holds the pipes", async () => {
		const r = await run({ cmd: "sh", args: ["-c", "(sleep 5 &); exit 0"], timeoutMs: 300 });
		expect(r.exitCode).toBe(0);
		expect(r.timedOut).toBe(false);
	});

	it("honours an abort signal", async () => {
		const ac = new AbortController();
		const p = run({ cmd: "sleep", args: ["30"], signal: ac.signal });
		setTimeout(() => ac.abort(), 100);
		const r = await p;
		expect(r.aborted).toBe(true);
		expect(r.exitCode).toBeNull();
	});

	it("reports an abort before start as aborted, not a spawn error", async () => {
		const ac = new AbortController();
		ac.abort();
		const r = await run({ cmd: "sleep", args: ["30"], signal: ac.signal });
		expect(r.aborted).toBe(true);
		expect(r.spawnError).toBeUndefined();
	});

	it("reports a missing binary as a spawn error", async () => {
		const r = await run({ cmd: "definitely-not-a-binary-zz", args: [] });
		expect(r.exitCode).toBeNull();
		expect(r.timedOut).toBe(false);
		expect(r.spawnError).toMatch(
			process.versions.bun ? /^Executable not found in \$PATH: "definitely-not-a-binary-zz"$/ : /ENOENT/,
		);
	});

	it("caps each stream and counts dropped bytes", async () => {
		const r = await run({
			cmd: "sh",
			args: ["-c", "head -c 5000 /dev/zero | tr '\\0' x; head -c 3000 /dev/zero | tr '\\0' y >&2"],
			maxBytes: 1000,
		});
		expect(r.stdout.length).toBe(1000);
		expect(r.stdoutDropped).toBe(4000);
		expect(r.stderr.length).toBe(1000);
		expect(r.stderrDropped).toBe(2000);
	});

	it("streams stderr lines, strips CR, flushes a final partial line", async () => {
		const lines: string[] = [];
		await run({
			cmd: "sh",
			args: ["-c", "printf 'a\\r\\nb\\nc' >&2"],
			onStderrLine: (l) => lines.push(l),
		});
		expect(lines).toEqual(["a", "b", "c"]);
	});

	it("keeps multibyte characters whole across chunk boundaries", async () => {
		const lines: string[] = [];
		// Two writes with a sleep between them split the UTF-8 sequence for é across chunks.
		await run({
			cmd: "sh",
			args: ["-c", "printf '\\303' >&2; sleep 0.05; printf '\\251\\n' >&2"],
			onStderrLine: (l) => lines.push(l),
		});
		expect(lines).toEqual(["é"]);
	});

	it("keeps a short line after an oversized line in one write", async () => {
		const lines: string[] = [];
		await run({
			cmd: process.execPath,
			args: ["-e", "process.stderr.end('z'.repeat(5000) + '\\ntail\\n')"],
			maxBytes: 100,
			onStderrLine: (line) => lines.push(line),
		});
		expect(lines).toEqual(["tail"]);
	});

	it("bounds the pending line buffer and swallows listener errors", async () => {
		const lines: string[] = [];
		const r = await run({
			cmd: "sh",
			args: ["-c", "head -c 5000 /dev/zero | tr '\\0' z >&2; echo >&2; echo tail >&2"],
			maxBytes: 100,
			onStderrLine: (l) => {
				lines.push(l);
				throw new Error("listener boom");
			},
		});
		expect(r.exitCode).toBe(0);
		expect(lines).toEqual(["tail"]);
	});

	describe("group reaping before resolve", () => {
		/** Make `kill(-pgid, 0)` report a live group for the first `liveProbes` probes (all when Infinity). */
		const simulateAsyncReap = (liveProbes: number) => {
			const real = process.kill.bind(process);
			const probes: number[] = [];
			const spy = vi.spyOn(process, "kill").mockImplementation(((pid: number, sig?: string | number) => {
				if (sig === 0 && pid < 0) {
					probes.push(pid);
					if (probes.length <= liveProbes) return true;
				}
				return real(pid, sig as NodeJS.Signals);
			}) as typeof process.kill);
			return { probes, spy };
		};

		it("does not resolve while a killed group member still answers kill(-pgid, 0)", async () => {
			const { probes, spy } = simulateAsyncReap(3);
			try {
				const r = await run({ cmd: "sh", args: ["-c", "exit 0"] });
				expect(r.exitCode).toBe(0);
				// Three live answers, then ESRCH: run() had to probe the group four times.
				expect(probes).toHaveLength(4);
				expect(new Set(probes).size).toBe(1);
			} finally {
				spy.mockRestore();
			}
		});

		it("gives up after CLOSE_GRACE_MS when the group never disappears", async () => {
			const { probes, spy } = simulateAsyncReap(Number.POSITIVE_INFINITY);
			try {
				const t0 = Date.now();
				const r = await run({ cmd: "sh", args: ["-c", "exit 0"] });
				expect(r.exitCode).toBe(0);
				expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
				expect(probes.length).toBeGreaterThan(2);
			} finally {
				spy.mockRestore();
			}
		}, 10_000);

		it("leaves no group member behind once run() returns", async () => {
			const r = await run({
				cmd: "sh",
				args: ["-c", "trap '' TERM; sleep 30 & echo $$ $!; wait"],
				timeoutMs: 300,
			});
			const [leader = 0, descendant = 0] = r.stdout.trim().split(" ").map(Number);
			expect(leader).toBeGreaterThan(0);
			expect(descendant).toBeGreaterThan(0);
			expect(r.timedOut).toBe(true);
			expect(() => process.kill(-leader, 0)).toThrow(/ESRCH/);
			expect(() => process.kill(descendant, 0)).toThrow(/ESRCH/);
		}, 20_000);
	});
});
