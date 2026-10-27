/** Shared lifecycle contracts for the real exported runners, without unifying their capture APIs. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { run } from "../../packages/dev-tools/src/core/process.ts";
import { spawnMonitor } from "../../packages/session-kit/src/monitor/process.ts";

interface Outcome {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
}

interface Runner {
	name: string;
	execute(script: string, cwd: string, terminateOnReady?: boolean): Promise<Outcome>;
}

/** Adapt only return/capture shapes; spawning and cleanup remain the production implementations. */
const runners: Runner[] = [
	{
		name: "dev-tools",
		async execute(script, cwd, terminateOnReady = false) {
			const controller = new AbortController();
			const result = await run({
				cmd: process.execPath,
				args: ["-e", script],
				cwd,
				// Startup has a failure backstop, but TERM is triggered by the post-handler marker.
				timeoutMs: terminateOnReady ? 10_000 : 1_000,
				signal: controller.signal,
				onStderrLine: (line) => {
					if (terminateOnReady && line === "ready") controller.abort();
				},
			});
			return {
				stdout: result.stdout,
				stderr: result.stderr,
				exitCode: result.exitCode,
				signal: result.termSignal,
			};
		},
	},
	{
		name: "session-kit",
		async execute(script, cwd, terminateOnReady = false) {
			let stdout = "";
			let stderr = "";
			let markReady: () => void = () => {};
			const ready = new Promise<void>((resolve) => {
				markReady = resolve;
			});
			const monitor = await spawnMonitor([process.execPath, "-e", script], {
				cwd,
				onStdout: (chunk) => {
					stdout += chunk.toString();
				},
				onStderr: (chunk) => {
					stderr += chunk.toString();
					if (stderr.split("\n").includes("ready")) markReady();
				},
			});
			const watchdog = setTimeout(() => monitor.terminate(), terminateOnReady ? 10_000 : 1_000);
			try {
				if (terminateOnReady) {
					await Promise.race([
						ready,
						monitor.exited.then(() => {
							throw new Error("Fixture exited before publishing TERM-handler readiness");
						}),
					]);
					monitor.terminate();
				}
				const result = await monitor.exited;
				return { stdout, stderr, ...result };
			} finally {
				clearTimeout(watchdog);
			}
		},
	},
];

/** Probe only the disposable descendant; unexpected signal errors must fail the test. */
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
		throw error;
	}
}

/** SIGKILL the fixture's own process group; an already-empty group is fine, anything else is not. */
function killGroup(leader: number): void {
	try {
		process.kill(-leader, "SIGKILL");
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
	}
}

/** Validate identities before using them to clean up a failed fixture. */
function identity(stdout: string): { leader: number; child: number } {
	const value: unknown = JSON.parse(stdout);
	assert.ok(value !== null && typeof value === "object");
	assert.ok(
		"leader" in value && typeof value.leader === "number" && Number.isInteger(value.leader) && value.leader > 1,
	);
	assert.ok("child" in value && typeof value.child === "number" && Number.isInteger(value.child) && value.child > 1);
	return { leader: value.leader, child: value.child };
}

for (const runner of runners) {
	for (const inheritPipes of [false, true]) {
		test(`${runner.name}: normal leader exit cleans descendants (${inheritPipes ? "inherited" : "closed"} pipes)`, {
			timeout: 15_000,
		}, async (context) => {
			const cwd = await mkdtemp(join(tmpdir(), "pi-lifecycle-"));
			context.after(() => rm(cwd, { recursive: true, force: true }));
			const script = `
const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { stdio: ${inheritPipes ? '["ignore", "inherit", "inherit"]' : '"ignore"'} });
child.unref();
console.log(JSON.stringify({leader: process.pid, child: child.pid}));
`;
			const result = await runner.execute(script, cwd);
			const owned = identity(result.stdout);
			// Registered only after the fixture proved its own group; a failing assertion still reaps it.
			context.after(() => killGroup(owned.leader));
			assert.equal(result.exitCode, 0);
			const deadline = Date.now() + 1_000;
			while (alive(owned.child) && Date.now() < deadline) await delay(10);
			assert.equal(alive(owned.child), false, "descendant outlived its completed command");
		});
	}

	test(`${runner.name}: keeps nonzero status and separate streams`, {
		timeout: 15_000,
	}, async (context) => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-lifecycle-"));
		context.after(() => rm(cwd, { recursive: true, force: true }));
		const result = await runner.execute(
			'process.stdout.write("out\\n"); process.stderr.write("err\\n"); process.exitCode = 7;',
			cwd,
		);
		assert.deepEqual(result, {
			stdout: "out\n",
			stderr: "err\n",
			exitCode: 7,
			signal: null,
		});
	});

	test(`${runner.name}: escalates termination when the leader ignores SIGTERM`, {
		timeout: 15_000,
	}, async (context) => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-lifecycle-"));
		context.after(() => rm(cwd, { recursive: true, force: true }));
		const result = await runner.execute(
			'process.on("SIGTERM", () => {}); process.stderr.write("ready\\n"); setTimeout(() => {}, 10000);',
			cwd,
			true,
		);
		assert.equal(result.stderr, "ready\n", "Fixture must publish readiness after installing its TERM handler");
		assert.equal(result.exitCode, null);
		assert.equal(result.signal, "SIGKILL");
	});
}
