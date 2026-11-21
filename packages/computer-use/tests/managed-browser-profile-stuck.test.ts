// A persistent managed browser that survives SIGKILL keeps its profile locked (#674).
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeTestTempDir } from "@nredd/pi-test-lib/temp-dir";
import { afterEach, beforeEach, test, vi } from "vitest";

const spawned = vi.hoisted(() => ({
	children: [] as ChildProcess[],
	onSpawn: undefined as ((child: ChildProcess) => void) | undefined,
	safeAncestors: new Set<string>(),
}));
vi.mock("node:child_process", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:child_process")>();
	return {
		...original,
		spawn: vi.fn((...args: Parameters<typeof original.spawn>) => {
			const child = original.spawn(...args);
			spawned.children.push(child);
			spawned.onSpawn?.(child);
			return child;
		}),
	};
});
vi.mock("node:fs", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:fs")>();
	return {
		...original,
		lstatSync: (...args: Parameters<typeof original.lstatSync>) => {
			const info = original.lstatSync(...args) as import("node:fs").Stats;
			// The test's temp ancestry is safe by construction, independent of mount permissions.
			if (spawned.safeAncestors.has(String(args[0]))) Object.assign(info, { uid: process.getuid?.(), mode: 0o40700 });
			return info;
		},
	};
});

const { shutdownComputerUseSession, testing } = await import("../src/bridge.ts");
const { loadComputerUseConfig } = await import("../src/config.ts");
const { currentPlatformBackend } = await import("../src/platform/index.ts");
const { applyOutputEnvelope, readStoredOutput } = await import("../src/output.ts");
const FAKE_BROWSER = fileURLToPath(new URL("../test/fixtures/fake-browser.mjs", import.meta.url));
let scratch: string;
let profile: string;

beforeEach(({ onTestFinished }) => {
	spawned.onSpawn = undefined;
	// Platform seam: POSIX validation runs on every host.
	vi.spyOn(process, "platform", "get").mockReturnValue("linux");
	const temp = fs.realpathSync(os.tmpdir());
	for (let ancestor = temp; ; ancestor = path.dirname(ancestor)) {
		spawned.safeAncestors.add(ancestor);
		if (path.dirname(ancestor) === ancestor) break;
	}
	scratch = fs.realpathSync(makeTestTempDir("pi-cu-persistent-stuck-", onTestFinished, { baseDir: temp }));
	vi.stubEnv("TMPDIR", scratch);
	vi.stubEnv("FAKE_BROWSER_LOG", path.join(scratch, "launch.json"));
	vi.stubEnv("PI_COMPUTER_USE_CHROME_EXECUTABLE", FAKE_BROWSER);
	vi.stubEnv("PI_COMPUTER_USE_CDP_PORT", "");
	profile = fs.realpathSync(makeTestTempDir("persistent-", onTestFinished, { baseDir: scratch }));
	const agent = path.join(scratch, "agent");
	fs.mkdirSync(path.join(agent, "extensions"), { recursive: true });
	fs.writeFileSync(
		path.join(agent, "extensions/pi-computer-use.json"),
		JSON.stringify({ managed_browser_profile: profile }),
	);
	vi.stubEnv("PI_CODING_AGENT_DIR", agent);
	loadComputerUseConfig(scratch);
});
afterEach(async () => {
	vi.useRealTimers();
	await shutdownComputerUseSession();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	loadComputerUseConfig(scratch);
});

/** Advance both bounded shutdown waits without spending ten real seconds. */
async function advanceShutdown(): Promise<void> {
	for (let tick = 0; tick < 120; tick++) {
		await vi.advanceTimersByTimeAsync(100);
		await new Promise((resolve) => setImmediate(resolve));
	}
}

/** Reap the real fixture child after simulating an unkillable process. */
async function reap(child: ChildProcess, kill: ChildProcess["kill"]): Promise<void> {
	vi.useRealTimers();
	const closed = new Promise((resolve) => child.once("close", resolve));
	kill("SIGKILL");
	await closed;
}

test("an unkillable persistent browser retains its lease but clears state and shuts down the backend", async () => {
	const result = await testing.performLaunchBrowser({});
	const stateId = result.details.stateId;
	assert(testing.savedState(stateId));
	const stored = applyOutputEnvelope("evaluate_browser", {
		content: [{ type: "text", text: "disposable output".repeat(4096) }],
		details: {},
	});
	const output = stored.content[0];
	assert(output.type === "text");
	const match = /ref: "(@o\d+)"/.exec(output.text);
	assert(match);
	const outputRef = match[1];
	assert(readStoredOutput(outputRef, 0));
	const backendShutdown = vi.spyOn(currentPlatformBackend, "shutdown").mockResolvedValue();
	const child = spawned.children.at(-1) as ChildProcess;
	const realKill = child.kill.bind(child);
	child.kill = () => true;
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	const shutdown = assert.rejects(shutdownComputerUseSession(), /did not stop/);
	try {
		await advanceShutdown();
		await shutdown;
		assert(fs.existsSync(path.join(profile, ".pi-computer-use.lock")));
		assert.equal(backendShutdown.mock.calls.length, 1);
		assert.equal(testing.savedState(stateId), undefined);
		assert.equal(readStoredOutput(outputRef, 0), undefined);
		assert.equal(process.env.PI_COMPUTER_USE_CDP_PORT, "");
	} finally {
		await reap(child, realKill);
	}
});

test("readiness failure remains primary when stopping the persistent browser also fails", async () => {
	const abort = new AbortController();
	let realKill: ChildProcess["kill"] | undefined;
	spawned.onSpawn = (child) => {
		realKill = child.kill.bind(child);
		child.kill = () => true;
		abort.abort();
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	};
	const launch = testing.performLaunchBrowser({}, abort.signal).then(
		() => assert.fail("the aborted launch must reject"),
		(error: Error) => error,
	);
	try {
		// Await the real spawn before driving fake timers; no timer controls filesystem/port allocation.
		await vi.waitFor(() => assert(spawned.onSpawn && abort.signal.aborted));
		await advanceShutdown();
		const error = await launch;
		assert.equal(error.message, "Browser launch was aborted.");
		assert(error.cause instanceof Error);
		assert.match(error.cause.message, /did not stop/);
		assert(fs.existsSync(path.join(profile, ".pi-computer-use.lock")));
	} finally {
		assert(realKill);
		await reap(spawned.children.at(-1) as ChildProcess, realKill);
	}
});
