/** Shared lifecycle contracts for the real exported runners, without unifying their capture APIs. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { run } from "../../packages/dev-tools/src/core/process.ts";
import { spawnMonitor } from "../../packages/session-kit/src/monitor/process.ts";

const READINESS_WATCHDOG_MS = 10_000;
const COMPLETION_WATCHDOG_MS = 10_000;
const FIXTURE_LIFETIME_MS = 60_000;
const TEST_TIMEOUT_MS = 30_000;
const DESCENDANT_EXIT_TIMEOUT_MS = 1_000;
const PROCESS_POLL_INTERVAL_MS = 10;

interface Outcome {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
}

interface Runner {
	name: string;
	/**
	 * Execute a disposable lifecycle fixture through the real runner.
	 * @param script Node fixture source.
	 * @param cwd Fixture working directory.
	 * @param terminateOnReady Whether the ready marker triggers cancellation.
	 * @returns Captured outcome.
	 * @throws On spawn or readiness failure.
	 */
	execute(script: string, cwd: string, terminateOnReady?: boolean): Promise<Outcome>;
}

/** Adapt only return/capture shapes; spawning and cleanup remain the production implementations. */
const runners: Runner[] = [
	{
		name: "dev-tools",
		/**
		 * Adapt dev-tools capture without changing spawning or cleanup.
		 * @param script Node fixture source.
		 * @param cwd Fixture directory.
		 * @param terminateOnReady Whether to abort on handler readiness.
		 * @returns Captured runner outcome.
		 * @throws On runner failure.
		 */
		async execute(script, cwd, terminateOnReady = false) {
			const controller = new AbortController();
			const result = await run({
				cmd: process.execPath,
				args: ["-e", script],
				cwd,
				// Startup has a failure backstop, but TERM is triggered by the post-handler marker.
				timeoutMs: terminateOnReady ? READINESS_WATCHDOG_MS : COMPLETION_WATCHDOG_MS,
				signal: controller.signal,
				/**
				 * Trigger cancellation only after the handler-ready marker.
				 * @param line Complete stderr line.
				 * @returns Callback completion.
				 * @throws No intentional errors; the runner isolates callback failures.
				 */
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
		/**
		 * Adapt session-kit streams while preserving real lifecycle behavior.
		 * @param script Node fixture source.
		 * @param cwd Fixture directory.
		 * @param terminateOnReady Whether to terminate after handler readiness.
		 * @returns Captured monitor outcome.
		 * @throws On spawn, readiness or early-exit failure.
		 */
		async execute(script, cwd, terminateOnReady = false) {
			let stdout = "";
			let stderr = "";
			/**
			 * Placeholder until the readiness promise captures its resolver.
			 * @returns No-op completion.
			 * @throws No errors.
			 */
			let markReady: () => void = () => {};
			const ready = new Promise<void>(
				/** @returns Stores the readiness resolver. @throws No errors. */
				(resolve) => {
					markReady = resolve;
				},
			);
			const monitor = await spawnMonitor([process.execPath, "-e", script], {
				cwd,
				/**
				 * Capture monitor stdout separately.
				 * @param chunk Stream bytes.
				 * @returns Callback completion.
				 * @throws No intentional errors for valid buffers.
				 */
				onStdout: (chunk) => {
					stdout += chunk.toString();
				},
				/**
				 * Capture stderr and acknowledge complete ready markers.
				 * @param chunk Stream bytes.
				 * @returns Callback completion.
				 * @throws No intentional errors for valid buffers.
				 */
				onStderr: (chunk) => {
					stderr += chunk.toString();
					if (stderr.split("\n").includes("ready")) markReady();
				},
			});
			const watchdog = setTimeout(
				/** @returns Requests bounded monitor termination. @throws On a termination request failure. */
				() => monitor.terminate(),
				terminateOnReady ? READINESS_WATCHDOG_MS : COMPLETION_WATCHDOG_MS,
			);
			try {
				if (terminateOnReady) {
					await Promise.race([
						ready,
						monitor.exited.then(
							/** @returns Never returns. @throws When exit precedes readiness. */
							() => {
								throw new Error("Fixture exited before publishing TERM-handler readiness");
							},
						),
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

/**
 * Probe only the disposable descendant.
 * @param pid Owned descendant PID.
 * @returns Whether it remains observable.
 * @throws On signal errors other than ESRCH.
 */
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
		throw error;
	}
}

/**
 * Validate fixture identities before probe-only post-completion assertions.
 * @param stdout JSON identity record from the fixture.
 * @returns Validated leader and descendant PIDs.
 * @throws If JSON or process identities are malformed.
 */
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
		/**
		 * Verify descendant cleanup after acknowledged normal exit.
		 * @param context Test-owned scratch cleanup.
		 * @returns Completes the descendant lifecycle assertions.
		 * @throws On fixture or assertion failure.
		 */
		const verifyDescendantCleanup = async (context: TestContext) => {
			const cwd = await mkdtemp(join(tmpdir(), "pi-lifecycle-"));
			context.after(
				/** @returns Removes the disposable directory. @throws On removal failure. */
				() => rm(cwd, { recursive: true, force: true }),
			);
			const script = `
const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', 'setTimeout(/** @returns {void} Bounds descendant lifetime after failed cleanup. @throws {never} No errors. */ () => {}, ${FIXTURE_LIFETIME_MS}); process.send("descendant-ready");'], { stdio: ${inheritPipes ? '["ignore", "inherit", "inherit", "ipc"]' : '["ignore", "ignore", "ignore", "ipc"]'} });
console.log(JSON.stringify({leader: process.pid, child: child.pid}));
const watchdog = setTimeout(/** @returns {never} Exits on missing acknowledgment. @throws {never} Terminates the process. */ () => { console.error("Descendant did not acknowledge readiness"); process.exit(99); }, ${READINESS_WATCHDOG_MS});
child.once("message", /** @returns {void} Releases the acknowledged leader. @throws {Error} On unexpected acknowledgment or disconnect failure. */ message => {
  if (message !== "descendant-ready") throw new Error("Unexpected descendant readiness acknowledgment");
  clearTimeout(watchdog);
  console.error(message);
  child.disconnect();
  child.unref(); // Only now may the leader exit naturally, after output drains.
});
`;
			const result = await runner.execute(script, cwd);
			const owned = identity(result.stdout);
			// The runner completed: numeric IDs no longer prove ownership. Probe only,
			// including on assertion failure; never signal a potentially recycled group.
			assert.equal(result.exitCode, 0, result.stderr);
			assert.equal(
				result.stderr,
				"descendant-ready\n",
				"leader must receive the descendant acknowledgment before exit",
			);
			const deadline = Date.now() + DESCENDANT_EXIT_TIMEOUT_MS;
			while (alive(owned.child) && Date.now() < deadline) await delay(PROCESS_POLL_INTERVAL_MS);
			assert.equal(alive(owned.child), false, "descendant outlived its completed command");
			assert.equal(alive(-owned.leader), false, "completed runner left an observable group");
		};
		test(
			`${runner.name}: normal leader exit cleans descendants (${inheritPipes ? "inherited" : "closed"} pipes)`,
			{
				timeout: TEST_TIMEOUT_MS,
			},
			verifyDescendantCleanup,
		);
	}

	/**
	 * Verify the runner preserves nonzero status and separate streams.
	 * @param context Test-owned scratch cleanup.
	 * @returns Completes the output assertions.
	 * @throws On runner or assertion failure.
	 */
	const verifySeparateStreams = async (context: TestContext) => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-lifecycle-"));
		context.after(
			/** @returns Removes the disposable directory. @throws On removal failure. */
			() => rm(cwd, { recursive: true, force: true }),
		);
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
	};
	test(
		`${runner.name}: keeps nonzero status and separate streams`,
		{
			timeout: TEST_TIMEOUT_MS,
		},
		verifySeparateStreams,
	);

	/**
	 * Verify ignored TERM escalates to KILL after readiness.
	 * @param context Test-owned scratch cleanup.
	 * @returns Completes the escalation assertions.
	 * @throws On runner or assertion failure.
	 */
	const verifyEscalation = async (context: TestContext) => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-lifecycle-"));
		context.after(
			/** @returns Removes the disposable directory. @throws On removal failure. */
			() => rm(cwd, { recursive: true, force: true }),
		);
		const result = await runner.execute(
			`process.on("SIGTERM", () => {}); process.stderr.write("ready\\n"); setTimeout(() => {}, ${FIXTURE_LIFETIME_MS});`,
			cwd,
			true,
		);
		assert.equal(result.stderr, "ready\n", "Fixture must publish readiness after installing its TERM handler");
		assert.equal(result.exitCode, null);
		assert.equal(result.signal, "SIGKILL");
	};
	test(
		`${runner.name}: escalates termination when the leader ignores SIGTERM`,
		{
			timeout: TEST_TIMEOUT_MS,
		},
		verifyEscalation,
	);
}
