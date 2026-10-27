// Real-host privacy and CPU checks. Runs under Vitest (Node) and `bun test` (Bun): both runtimes ship it.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { readFileSync, realpathSync } from "node:fs";
import { basename } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { createResourceSampler } from "../src/index.js";

const runtime = typeof process.versions.bun === "string" ? `bun ${process.versions.bun}` : `node ${process.version}`;

/** Library maxima, so a busy host fails with explicit coverage instead of silently missing the child. */
const BOUNDS = { maxDurationMs: 5000, maxPids: 16384, maxBytes: 16_777_216 };
const READY_MS = 5000;
const STOP_MS = 2000;

/** argv[0], argv, environment, process title and (Linux) comm all carry the secret. */
const HOSTILE = [
	"const secret = process.env.SAMPLER_SENTINEL;",
	// biome-ignore lint/suspicious/noTemplateCurlyInString: the child evaluates this template itself.
	"process.title = `npm exec ${secret} mcp`;",
	'if (process.platform === "linux") require("node:fs").writeFileSync("/proc/self/comm", secret);',
	'process.stdout.write("ready\\n");',
	"setInterval(() => {}, 1000);",
].join("\n");

/** Ready at once, with no disguise: the negative control fails. */
const READY = 'process.stdout.write("ready\\n"); setInterval(() => {}, 1000);';

/**
 * Spawn only; hand the child to supervise before anything else can throw.
 * @param secret Random sentinel inserted into hostile metadata.
 * @param script Child script, defaulting to the hostile fixture.
 * @param disguise Whether argv[0] should also carry the sentinel.
 * @returns Owned child requiring supervised cleanup.
 */
function launch(secret: string, script = HOSTILE, disguise = true): ChildProcess {
	return spawn(process.execPath, ["-e", script, secret], {
		argv0: disguise ? `npm exec ${secret} mcp` : process.execPath,
		env: { PATH: "/usr/bin:/bin", SAMPLER_SENTINEL: secret },
		stdio: ["ignore", "pipe", "ignore"],
	});
}

/**
 * Inspect this exact child's wait status, never a reusable PID probe.
 * @param child Owned child handle.
 * @returns Whether the runtime has reaped it.
 */
function exited(child: ChildProcess): boolean {
	return child.exitCode !== null || child.signalCode !== null;
}

/**
 * Wait for a child with a bounded timer, like integration/inprocess/support.ts.
 * @param child Owned child handle.
 * @param ms Maximum wait in milliseconds.
 * @returns Whether the child exited before the timeout.
 */
async function exitedWithin(child: ChildProcess, ms: number): Promise<boolean> {
	if (exited(child)) return true;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<false>((resolve) => {
		timer = setTimeout(() => resolve(false), ms);
	});
	try {
		return await Promise.race([once(child, "exit").then(() => true as const), timeout]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * SIGTERM, bounded wait, then SIGKILL and one more bounded wait.
 * @param child Owned child to reap.
 * @returns Cleanup completion; rejects if the child survives SIGKILL.
 */
async function stop(child: ChildProcess): Promise<void> {
	if (child.pid === undefined || exited(child)) return;
	child.kill("SIGTERM");
	if (await exitedWithin(child, STOP_MS)) return;
	child.kill("SIGKILL");
	if (!(await exitedWithin(child, STOP_MS))) throw new Error(`child ${child.pid} survived SIGKILL`);
}

/**
 * Wait for the child's ready line, rejecting on exit, spawn error or timeout.
 * @param child Owned child with piped stdout.
 * @param ms Maximum readiness wait in milliseconds.
 * @returns Readiness completion with listeners/timer removed.
 */
function ready(child: ChildProcess, ms: number): Promise<void> {
	return new Promise((resolve, reject) => {
		let output = "";
		/**
		 * Settle readiness and detach its resources.
		 * @param error Optional readiness failure.
		 * @returns Nothing; settles the enclosing promise.
		 */
		const finish = (error?: Error) => {
			clearTimeout(timer);
			child.stdout?.off("data", data);
			child.off("exit", exit);
			child.off("error", finish);
			if (error) reject(error);
			else resolve();
		};
		/**
		 * Accumulate child readiness output.
		 * @param chunk Stdout bytes.
		 * @returns Nothing; settles once the ready line arrives.
		 */
		const data = (chunk: Buffer) => {
			output += chunk.toString("utf8");
			if (output.includes("ready\n")) finish();
		};
		/** @returns Nothing; reject readiness on early child exit. */
		const exit = () => finish(new Error("child exited before readiness"));
		const timer = setTimeout(() => finish(new Error(`child not ready within ${ms} ms`)), ms);
		child.stdout?.on("data", data);
		child.once("exit", exit);
		child.once("error", finish);
	});
}

/**
 * Format a failure without assuming it is an Error.
 * @param error Caught failure value.
 * @returns Readable failure description.
 */
function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Every step after spawn, readiness included, is followed by reaping the child; a cleanup failure is
 * reported with, never instead of, the step's own error. In-process only: a test worker killed by
 * SIGKILL runs no JavaScript, so nothing here can reap the child then. `reap` is injectable for tests.
 * @param child Owned child handed over immediately after spawn.
 * @param readyMs Readiness timeout in milliseconds.
 * @param body Check to run with the ready child's PID.
 * @param reap Cleanup implementation, defaulting to bounded termination/reaping.
 * @returns Body result after cleanup; primary and cleanup failures are preserved.
 */
async function supervise<T>(
	child: ChildProcess,
	readyMs: number,
	body: (pid: number) => Promise<T>,
	reap: (child: ChildProcess) => Promise<void> = stop,
): Promise<T> {
	let outcome: { value: T } | { error: unknown };
	try {
		await ready(child, readyMs);
		outcome = { value: await body(child.pid as number) };
	} catch (error) {
		outcome = { error };
	}
	try {
		await reap(child);
	} catch (cleanup) {
		if (!("error" in outcome)) throw cleanup;
		throw new AggregateError(
			[outcome.error, cleanup],
			`${message(outcome.error)}; cleanup also failed: ${message(cleanup)}`,
		);
	}
	if ("error" in outcome) throw outcome.error;
	return outcome.value;
}

/**
 * Confirm the pre-0.1.1 name sources actually leak, establishing the negative control.
 * @param pid Ready hostile child's PID.
 * @param secret Expected sentinel in mutable metadata.
 * @returns Whether the historical source exposes it.
 */
function legacySourceLeaks(pid: number, secret: string): boolean {
	if (process.platform === "linux") return readFileSync(`/proc/${pid}/comm`, "utf8").trim() === secret.slice(0, 15);
	return execFileSync("/bin/ps", ["-c", "-o", "comm=", "-p", String(pid)], {
		encoding: "utf8",
		timeout: STOP_MS,
	}).includes(secret);
}

/**
 * Perform real cleanup then inject a deterministic cleanup failure.
 * @param child Owned child to reap.
 * @returns A rejected promise after the child is reaped.
 */
async function failingReap(child: ChildProcess): Promise<void> {
	await stop(child);
	throw new Error("injected cleanup failure");
}

/**
 * Run the negative control, then privacy assertions against the actual sampler.
 * @param pid Ready hostile child's PID, required to appear in the bounded snapshot.
 * @param secret Sentinel whose twelve-character fragments must remain absent.
 * @returns Check completion after sampler disposal; rejects on privacy/coverage failure.
 */
async function privacy(pid: number, secret: string): Promise<void> {
	if (!legacySourceLeaks(pid, secret)) throw new Error("0.1.0 name source does not carry the secret");
	const sampler = createResourceSampler(BOUNDS);
	try {
		const snapshot = await sampler.sample();
		const serialized = JSON.stringify(snapshot);
		// 12 hex characters: any comm-length (15 byte) or p_comm (16 byte) fragment of the secret.
		for (let i = 0; i + 12 <= secret.length; i++) expect(serialized).not.toContain(secret.slice(i, i + 12));
		const own = snapshot.processes.find((entry) => entry.pid === pid);
		if (!own) throw new Error(`child ${pid} not observed within sampler bounds: ${JSON.stringify(snapshot.coverage)}`);
		const names = [process.execPath, realpathSync(process.execPath)].map((path) =>
			process.platform === "darwin" ? basename(path).slice(0, 16) : basename(path),
		);
		expect(names).toContain(own.name);
		for (const reason of snapshot.coverage.reasons) expect(reason).toMatch(/^[a-z-]+$/);
		console.info(JSON.stringify({ runtime, childName: own.name, coverage: snapshot.coverage }));
	} finally {
		await sampler.dispose();
	}
}

describe(`actual sampler on ${runtime}`, () => {
	it("never reports argv, environment, process title or writable comm, even for a hostile process", async () => {
		const secret = randomBytes(16).toString("hex");
		const child = launch(secret);
		await supervise(child, READY_MS, (pid) => privacy(pid, secret));
		expect(exited(child)).toBe(true);
	}, 20_000);
	it("reaps a child that never becomes ready", async () => {
		const child = launch(randomBytes(16).toString("hex"), "setInterval(() => {}, 1000);");
		await expect(supervise(child, 300, async () => {})).rejects.toThrow("child not ready within 300 ms");
		expect(child.signalCode).toBe("SIGTERM");
	}, 10_000);
	it("reaps the child when the negative control fails", async () => {
		const secret = randomBytes(16).toString("hex");
		const child = launch(secret, READY, false);
		await expect(supervise(child, READY_MS, (pid) => privacy(pid, secret))).rejects.toThrow(
			"0.1.0 name source does not carry the secret",
		);
		expect(child.signalCode).toBe("SIGTERM");
	}, 15_000);
	it("escalates to SIGKILL for a child that ignores SIGTERM", async () => {
		const secret = randomBytes(16).toString("hex");
		// The handler is installed before `ready`, so SIGTERM really is ignored.
		const script = 'process.on("SIGTERM", () => {}); process.stdout.write("ready\\n"); setInterval(() => {}, 1000);';
		const child = launch(secret, script, false);
		await expect(supervise(child, READY_MS, (pid) => privacy(pid, secret))).rejects.toThrow(
			"0.1.0 name source does not carry the secret",
		);
		expect(child.signalCode).toBe("SIGKILL");
	}, 15_000);
	it("reports a cleanup failure with, never instead of, the primary error", async () => {
		const child = launch(randomBytes(16).toString("hex"), READY, false);
		const primary = new Error("primary");
		const failure = await supervise(
			child,
			READY_MS,
			async () => {
				throw primary;
			},
			failingReap,
		).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(AggregateError);
		expect((failure as AggregateError).errors[0]).toBe(primary);
		expect((failure as AggregateError).message).toBe("primary; cleanup also failed: injected cleanup failure");
		expect(child.signalCode).toBe("SIGTERM");
	}, 10_000);
	it("reports a cleanup failure alone when the body succeeded", async () => {
		const child = launch(randomBytes(16).toString("hex"), READY, false);
		await expect(supervise(child, READY_MS, async () => {}, failingReap)).rejects.toThrow(/^injected cleanup failure$/);
		expect(child.signalCode).toBe("SIGTERM");
	}, 10_000);
	it("measures host CPU from the second sample on, without stale runtime counters", async () => {
		const sampler = createResourceSampler({ maxDurationMs: 2000 });
		try {
			const states = [];
			for (let i = 0; i < 3; i++) {
				if (i > 0) await delay(250);
				const snapshot = await sampler.sample();
				states.push(snapshot.cpu);
				if (
					process.platform === "darwin" &&
					(process.versions.bun || Number(process.versions.node.split(".")[0]) >= 26)
				) {
					const own = snapshot.processes.find((p) => p.pid === process.pid);
					expect(own?.cpu.state).toBe(i === 0 ? "warming" : "available");
					expect(own?.footprint?.state).toBe("available");
				}
			}
			expect(states[0]?.state).toBe("warming");
			for (const cpu of states.slice(1)) {
				expect(cpu?.state).toBe("available");
				if (cpu?.state === "available") expect(cpu.value).toBeGreaterThanOrEqual(0);
				if (cpu?.state === "available") expect(cpu.value).toBeLessThanOrEqual(100);
			}
			console.info(JSON.stringify({ runtime, cpu: states }));
		} finally {
			await sampler.dispose();
		}
	});
});
