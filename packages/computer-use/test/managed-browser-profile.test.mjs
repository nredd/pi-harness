import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, test, vi } from "vitest";
import { executeFind, executeLaunchBrowser, shutdownComputerUseSession, testing } from "../src/bridge.ts";
import { currentPlatformBackend } from "../src/platform/index.ts";
import { ResourceScheduler } from "../src/runtime.ts";
import { deferred, within } from "../scripts/check-async.mjs";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const FAKE_BROWSER = fileURLToPath(new URL("./fixtures/fake-browser.mjs", import.meta.url));
const BRIDGE_URL = pathToFileURL(path.join(PACKAGE_DIR, "src/bridge.ts")).href;
const CHILD_TIMEOUT_MS = 15_000;

// Runs in a separate Pi-like process that exits as soon as it is done, so nothing keeps the event loop
// alive for a late `close` event. `shutdown` quits normally after session shutdown; `exit` calls
// `process.exit()` with the browser still running, as a hard quit would. Prints the profile dir and
// whether it still existed when session shutdown returned.
const CHILD_SCRIPT = `
import fs from "node:fs";
import { shutdownComputerUseSession, testing } from ${JSON.stringify(BRIDGE_URL)};
await testing.performLaunchBrowser({});
const { profile } = JSON.parse(fs.readFileSync(process.env.FAKE_BROWSER_LOG, "utf8"));
if (process.argv[2] === "exit") {
	process.stdout.write(JSON.stringify({ profile }));
	process.exit(0);
}
await shutdownComputerUseSession();
process.stdout.write(JSON.stringify({ profile, existsAfterShutdown: fs.existsSync(profile) }));
`;

/**
 * Run `CHILD_SCRIPT` under tsx and return what it printed.
 * @param {string} script Path of the written child script.
 * @param {"shutdown"|"exit"} mode How the child quits.
 * @returns {Promise<{ profile: string, existsAfterShutdown?: boolean }>} The child's report.
 * @throws {Error} If the child fails, times out or prints no report.
 */
async function runChild(script, mode) {
	const child = spawn(process.execPath, ["--import", "tsx", script, mode], { cwd: PACKAGE_DIR, stdio: ["ignore", "pipe", "inherit"], timeout: CHILD_TIMEOUT_MS });
	let stdout = "";
	child.stdout.on("data", (chunk) => {
		stdout += chunk;
	});
	const [code, signal] = await new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (exitCode, exitSignal) => resolve([exitCode, exitSignal]));
	});
	assert.equal(code, 0, `${mode} child failed (signal ${signal}): ${stdout}`);
	return JSON.parse(stdout);
}

/**
 * Whether anything still answers CDP discovery on `port`, i.e. the fake browser is still running.
 * @param {number} port The browser's debugging port.
 * @returns {Promise<boolean>} True if `/json/version` answered.
 * @throws {never} Connection failures resolve false.
 */
async function cdpAnswers(port) {
	try {
		return (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1_000) })).ok;
	} catch {
		return false;
	}
}

/**
 * Whether anything still accepts TCP connections on `port`, for a fake browser that serves no CDP.
 * @param {number} port The browser's debugging port.
 * @returns {Promise<boolean>} True if a connection was accepted.
 * @throws {never} Connection failures resolve false.
 */
function portListening(port) {
	return new Promise((resolve) => {
		const socket = net.connect({ port, host: "127.0.0.1" });
		socket.setTimeout(1_000);
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.once("error", () => resolve(false));
		socket.once("timeout", () => {
			socket.destroy();
			resolve(false);
		});
	});
}

/**
 * Poll until `check` resolves true.
 * @param {() => Promise<boolean> | boolean} check Condition to wait for.
 * @param {string} message Assertion message at the deadline.
 * @param {number} timeoutMs Failure backstop.
 * @returns {Promise<void>} Resolves once `check` passes.
 * @throws {import('node:assert').AssertionError} If `check` never passes before the deadline.
 */
async function waitUntil(check, message, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	assert.fail(message);
}

describe.skipIf(process.platform === "win32")("managed browser profile", () => {
	const saved = {};
	let scratch;
	let tmp;
	let log;

	beforeAll(() => {
		scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pi-computer-use-cdp-profile-"));
		tmp = path.join(scratch, "tmp");
		fs.mkdirSync(tmp);
		log = path.join(scratch, "argv.json");
		for (const name of ["TMPDIR", "FAKE_BROWSER_LOG", "FAKE_BROWSER_IGNORE_SIGTERM", "FAKE_BROWSER_SIGTERM_LOG", "FAKE_BROWSER_NO_CDP", "FAKE_BROWSER_LAUNCHES", "PI_COMPUTER_USE_CHROME_EXECUTABLE", "PI_COMPUTER_USE_CDP_PORT"]) saved[name] = process.env[name];
		process.env.TMPDIR = tmp;
		process.env.FAKE_BROWSER_LOG = log;
		process.env.PI_COMPUTER_USE_CHROME_EXECUTABLE = FAKE_BROWSER;
		delete process.env.PI_COMPUTER_USE_CDP_PORT;
	});

	afterAll(async () => {
		vi.restoreAllMocks();
		await shutdownComputerUseSession();
		for (const [name, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		if (scratch) {
			fs.chmodSync(tmp, 0o755);
			for (const entry of fs.readdirSync(tmp)) fs.chmodSync(path.join(tmp, entry), 0o755);
			fs.rmSync(scratch, { recursive: true, force: true });
		}
	});

	test("launch uses a private profile dir that ignores a squatted fixed name and is removed on shutdown", async () => {
		// Squat the retired fixed name `pi-chrome-cdp-<port>` read-only, as another account sharing `/tmp`
		// would, for the port `freeTcpPort()` picks: its probe server reaches `listening` before the
		// profile dir is chosen. A launch that still used the fixed name could not write its profile.
		const createServer = net.createServer.bind(net);
		vi.spyOn(net, "createServer").mockImplementation((...args) => {
			const server = createServer(...args);
			server.once("listening", () => fs.mkdirSync(path.join(tmp, `pi-chrome-cdp-${server.address().port}`), { mode: 0o555 }));
			return server;
		});
		const result = await testing.performLaunchBrowser({});
		vi.restoreAllMocks();
		assert.match(result.content[0].text, /Fake|about:blank/, "launch_browser did not observe the managed page");

		const { port, profile } = JSON.parse(fs.readFileSync(log, "utf8"));
		const legacy = path.join(tmp, `pi-chrome-cdp-${port}`);
		assert(fs.existsSync(legacy), "the chosen port's legacy profile dir was not squatted");
		assert.throws(() => fs.accessSync(legacy, fs.constants.W_OK), "squatted legacy profile dir is writable, so this run proves nothing (root?)");
		assert.equal(path.dirname(profile), tmp, "profile dir is not under os.tmpdir()");
		assert.match(path.basename(profile), /^pi-chrome-cdp-[^/]+$/);
		assert.notEqual(profile, legacy, "launch_browser reused the fixed shared-temp profile name");
		assert.equal(fs.statSync(profile).mode & 0o777, 0o700, "profile dir is readable by other accounts");
		assert.equal(fs.statSync(profile).uid, process.getuid(), "profile dir is not owned by this account");

		await shutdownComputerUseSession();
		assert(!fs.existsSync(profile), "session shutdown returned before removing the profile dir");
	});

	test("shutdown SIGKILLs a browser that ignores SIGTERM, then removes its profile", async () => {
		process.env.FAKE_BROWSER_IGNORE_SIGTERM = "1";
		try {
			await testing.performLaunchBrowser({});
		} finally {
			delete process.env.FAKE_BROWSER_IGNORE_SIGTERM;
		}
		const { port, profile } = JSON.parse(fs.readFileSync(log, "utf8"));
		// Waits out the bridge's 5s SIGTERM grace period before it escalates.
		await shutdownComputerUseSession();
		assert(!fs.existsSync(profile), "session shutdown returned before removing the profile dir");
		assert.equal(await cdpAnswers(port), false, "managed browser survived SIGKILL");
	});

	test("a profile that cannot be removed stays tracked, and the exit hook removes it", async () => {
		await testing.performLaunchBrowser({});
		const { profile } = JSON.parse(fs.readFileSync(log, "utf8"));
		// Removing `profile` needs write access to its parent, so shutdown's `rm` fails and is logged.
		fs.chmodSync(tmp, 0o555);
		try {
			await shutdownComputerUseSession();
			assert(fs.existsSync(profile), "profile removal unexpectedly succeeded under a read-only parent (root?)");
		} finally {
			fs.chmodSync(tmp, 0o755);
		}
		testing.removeProfileDirsOnExit();
		assert(!fs.existsSync(profile), "exit hook did not remove the profile dir shutdown could not");

		// The exit hook itself must not throw when removal fails: it logs and moves on.
		await testing.performLaunchBrowser({});
		const { port, profile: stuck } = JSON.parse(fs.readFileSync(log, "utf8"));
		fs.chmodSync(tmp, 0o555);
		try {
			testing.removeProfileDirsOnExit();
		} finally {
			fs.chmodSync(tmp, 0o755);
		}
		assert(fs.existsSync(stuck), "profile removal unexpectedly succeeded under a read-only parent (root?)");
		assert.equal(await cdpAnswers(port), false, "exit hook did not kill the managed browser");
		await shutdownComputerUseSession();
	});

	test("an aborted launch stops the browser and removes its profile", async () => {
		const before = new Set(fs.readdirSync(tmp));
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(testing.performLaunchBrowser({}, controller.signal), /aborted/);
		assert.deepEqual(fs.readdirSync(tmp).filter((entry) => !before.has(entry)), [], "aborted launch returned before removing the profile dir");
		assert.equal(process.env.PI_COMPUTER_USE_CDP_PORT, undefined, "aborted launch left its CDP port configured");
	});

	test("a failed launch and session shutdown restore a CDP port the user had configured", async () => {
		process.env.PI_COMPUTER_USE_CDP_PORT = "9222";
		try {
			const controller = new AbortController();
			controller.abort();
			await assert.rejects(testing.performLaunchBrowser({}, controller.signal), /aborted/);
			assert.equal(process.env.PI_COMPUTER_USE_CDP_PORT, "9222", "aborted launch did not restore the user's CDP port");

			await testing.performLaunchBrowser({});
			const { port } = JSON.parse(fs.readFileSync(log, "utf8"));
			assert.equal(process.env.PI_COMPUTER_USE_CDP_PORT, String(port), "launch did not point CDP at the managed browser");
			await shutdownComputerUseSession();
			assert.equal(process.env.PI_COMPUTER_USE_CDP_PORT, "9222", "session shutdown did not restore the user's CDP port");
		} finally {
			delete process.env.PI_COMPUTER_USE_CDP_PORT;
		}
	});

	test("an aborted launch SIGKILLs a browser that ignores SIGTERM before it returns", async () => {
		fs.rmSync(log, { force: true });
		process.env.FAKE_BROWSER_IGNORE_SIGTERM = "1";
		process.env.FAKE_BROWSER_NO_CDP = "1";
		const controller = new AbortController();
		let launch;
		try {
			launch = testing.performLaunchBrowser({}, controller.signal);
			await waitUntil(() => fs.existsSync(log), "fake browser never started", 5_000);
		} finally {
			delete process.env.FAKE_BROWSER_IGNORE_SIGTERM;
			delete process.env.FAKE_BROWSER_NO_CDP;
		}
		const { port, profile } = JSON.parse(fs.readFileSync(log, "utf8"));
		await waitUntil(() => portListening(port), "fake browser never listened", 5_000);
		controller.abort();
		// Waits out the bridge's 5s SIGTERM grace period before it escalates.
		await assert.rejects(launch, /aborted/);
		assert(!fs.existsSync(profile), "aborted launch returned before removing the profile dir");
		assert.equal(await portListening(port), false, "aborted launch left a SIGTERM-ignoring browser running");
	});

	test("relaunch SIGKILLs a previous browser that ignores SIGTERM and removes its profile", async () => {
		process.env.FAKE_BROWSER_IGNORE_SIGTERM = "1";
		try {
			await testing.performLaunchBrowser({});
		} finally {
			delete process.env.FAKE_BROWSER_IGNORE_SIGTERM;
		}
		const first = JSON.parse(fs.readFileSync(log, "utf8"));
		// Waits out the bridge's 5s SIGTERM grace period before it escalates.
		await testing.performLaunchBrowser({});
		const second = JSON.parse(fs.readFileSync(log, "utf8"));
		assert.notEqual(second.profile, first.profile);
		assert(!fs.existsSync(first.profile), "relaunch left the previous profile dir behind");
		assert.equal(await cdpAnswers(first.port), false, "relaunch left a SIGTERM-ignoring browser running");
		assert.equal(await cdpAnswers(second.port), true, "relaunched browser is not serving CDP");
		await shutdownComputerUseSession();
		assert(!fs.existsSync(second.profile), "session shutdown returned before removing the profile dir");
	});

	test("a launch whose spawn throws removes its profile dir and rethrows the spawn error", async () => {
		// Pins the sync-`spawn` failure path: the profile dir is gone, no CDP port is left set, and the
		// rejection is the spawn error itself. The masking case, a failed removal, needs the profile
		// dir to become unremovable between `mkdtemp` and `spawn`, which has no seam, so this test
		// does not exercise it.
		const before = new Set(fs.readdirSync(tmp));
		// The URL passes the scheme check, but `spawn` rejects the NUL byte synchronously.
		await assert.rejects(testing.performLaunchBrowser({ url: "http://example.test/\0" }), { code: "ERR_INVALID_ARG_VALUE" });
		assert.deepEqual(fs.readdirSync(tmp).filter((entry) => !before.has(entry)), [], "failed spawn left a profile dir behind");
		assert.equal(process.env.PI_COMPUTER_USE_CDP_PORT, undefined, "failed spawn left a CDP port configured");
	});

	/**
	 * Every fake browser recorded in `$FAKE_BROWSER_LAUNCHES` since `launches` was reset.
	 * @param {string} launches Path of the launch log.
	 * @returns {{ port: number, profile: string }[]} One entry per started browser.
	 */
	function launched(launches) {
		return fs.existsSync(launches) ? fs.readFileSync(launches, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
	}

	/**
	 * Assert that no profile dir created since `before` remains and that none of `browsers` is still
	 * running. A browser stopped before it logged its launch never listened, and its profile dir is
	 * still covered by the `before` check.
	 * @param {Set<string>} before Entries of `tmp` before the test launched anything.
	 * @param {{ port: number, profile: string }[]} browsers Browsers that logged a launch.
	 * @param {string} when What just happened, for the assertion message.
	 * @returns {Promise<void>} Resolves once every browser is checked.
	 * @throws {import('node:assert').AssertionError} If a browser or a profile dir survived.
	 */
	async function assertAllGone(before, browsers, when) {
		assert.deepEqual(fs.readdirSync(tmp).filter((entry) => !before.has(entry)), [], `${when} left a profile dir behind`);
		for (const { port, profile } of browsers) {
			assert(!fs.existsSync(profile), `${when} left profile ${profile} behind`);
			assert.equal(await portListening(port), false, `${when} left the browser on port ${port} running`);
		}
	}

	test("concurrent launches leave one browser, and shutdown stops it", async () => {
		const launches = path.join(scratch, "launches.jsonl");
		fs.rmSync(launches, { force: true });
		process.env.FAKE_BROWSER_LAUNCHES = launches;
		const before = new Set(fs.readdirSync(tmp));
		const first = new AbortController();
		try {
			await testing.performLaunchBrowser({});
			const racing = testing.performLaunchBrowser({}, first.signal);
			const winner = testing.performLaunchBrowser({});
			// The second launch stops the first one's browser; abort its CDP wait instead of waiting out 15s.
			await winner;
			first.abort();
			await assert.rejects(racing);
		} finally {
			delete process.env.FAKE_BROWSER_LAUNCHES;
		}
		const browsers = launched(launches);
		const live = browsers.find(({ port }) => String(port) === process.env.PI_COMPUTER_USE_CDP_PORT);
		assert(live, "CDP port does not point at a launched browser");
		assert.equal(await cdpAnswers(live.port), true, "the winning launch's browser is not serving CDP");
		const liveEntries = fs.readdirSync(tmp).filter((entry) => !before.has(entry));
		assert.deepEqual(liveEntries, [path.basename(live.profile)], "concurrent launches left more than one profile dir");
		await assertAllGone(new Set([...before, ...liveEntries]), browsers.filter((entry) => entry !== live), "a concurrent relaunch");
		await shutdownComputerUseSession();
		await assertAllGone(before, browsers, "session shutdown");
		assert.equal(process.env.PI_COMPUTER_USE_CDP_PORT, undefined, "session shutdown left a CDP port configured");
	});

	test("aborting a queued launch never starts another browser", async () => {
		const launches = path.join(scratch, "queued-launches.jsonl");
		fs.rmSync(launches, { force: true });
		process.env.FAKE_BROWSER_LAUNCHES = launches;
		process.env.FAKE_BROWSER_IGNORE_SIGTERM = "1";
		const controller = new AbortController();
		const stoppingController = new AbortController();
		let stopping;
		let queued;
		try {
			await testing.performLaunchBrowser({});
			delete process.env.FAKE_BROWSER_IGNORE_SIGTERM;
			const createServer = net.createServer.bind(net);
			let portProbes = 0;
			vi.spyOn(net, "createServer").mockImplementation((...args) => {
				portProbes++;
				return createServer(...args);
			});
			stopping = testing.performLaunchBrowser({}, stoppingController.signal);
			queued = testing.performLaunchBrowser({}, controller.signal);
			controller.abort();
			await assert.rejects(queued, /aborted/);
			stoppingController.abort();
			await Promise.allSettled([stopping]);
			assert.equal(portProbes, 1, "aborted queued launch began starting another browser");
		} finally {
			controller.abort();
			stoppingController.abort();
			vi.restoreAllMocks();
			delete process.env.FAKE_BROWSER_IGNORE_SIGTERM;
			delete process.env.FAKE_BROWSER_LAUNCHES;
			await Promise.allSettled([stopping, queued]);
			await shutdownComputerUseSession();
		}
	});

	test("tool launch enters the lifecycle before readiness is released to shutdown", async () => {
		const before = new Set(fs.readdirSync(tmp));
		const shutdownDone = deferred();
		const resumeTool = deferred();
		const controller = new AbortController();
		const read = ResourceScheduler.prototype.read;
		const createServer = net.createServer.bind(net);
		let portProbes = 0;
		let shutdown;
		vi.spyOn(currentPlatformBackend, "ensureReady").mockResolvedValue({ lastPermissionCheckAt: 0 });
		vi.spyOn(currentPlatformBackend, "shutdown").mockResolvedValue();
		vi.spyOn(net, "createServer").mockImplementation((...args) => {
			portProbes++;
			return createServer(...args);
		});
		vi.spyOn(ResourceScheduler.prototype, "read").mockImplementation(function (key, work) {
			const scheduled = read.call(this, key, work);
			if (key !== "session-lifecycle") return scheduled;
			return scheduled.then(async (result) => {
				shutdown = shutdownComputerUseSession();
				await shutdown;
				shutdownDone.resolve();
				await resumeTool.promise;
				return result;
			});
		});
		const launch = executeLaunchBrowser("queued", {}, controller.signal, undefined, { cwd: PACKAGE_DIR });
		try {
			await within(shutdownDone.promise, "shutdown after tool readiness", 10_000);
			assert.equal(portProbes, 1, "shutdown overtook the admitted tool launch");
			assert.deepEqual(fs.readdirSync(tmp).filter((entry) => !before.has(entry)), []);
			assert.equal(process.env.PI_COMPUTER_USE_CDP_PORT, undefined);
		} finally {
			controller.abort();
			resumeTool.resolve();
			await Promise.allSettled([launch, shutdown]);
			vi.restoreAllMocks();
			await shutdownComputerUseSession();
		}
	});

	test("tool readiness does not serialize unrelated operations", async () => {
		const firstEntered = deferred();
		const releaseFirst = deferred();
		const secondEntered = deferred();
		let calls = 0;
		vi.spyOn(currentPlatformBackend, "ensureReady").mockResolvedValue({ lastPermissionCheckAt: 0 });
		vi.spyOn(currentPlatformBackend, "listApps").mockImplementation(async () => {
			calls++;
			if (calls === 1) {
				firstEntered.resolve();
				await releaseFirst.promise;
			} else secondEntered.resolve();
			return [];
		});
		const ctx = { cwd: PACKAGE_DIR };
		const first = executeFind("first", { app: "first" }, undefined, undefined, ctx);
		let second;
		try {
			await within(firstEntered.promise, "first tool entering backend");
			second = executeFind("second", { app: "second" }, undefined, undefined, ctx);
			await within(secondEntered.promise, "second tool entering while first is blocked");
		} finally {
			releaseFirst.resolve();
			await Promise.allSettled([first, second]);
			vi.restoreAllMocks();
		}
	});

	test("shutdown during a relaunch waits for it, then stops the new browser", async () => {
		const launches = path.join(scratch, "launches.jsonl");
		fs.rmSync(launches, { force: true });
		process.env.FAKE_BROWSER_LAUNCHES = launches;
		const before = new Set(fs.readdirSync(tmp));
		const controller = new AbortController();
		const termLog = path.join(scratch, "relaunch-sigterm");
		fs.rmSync(termLog, { force: true });
		let relaunch;
		try {
			process.env.FAKE_BROWSER_SIGTERM_LOG = termLog;
			process.env.FAKE_BROWSER_IGNORE_SIGTERM = "1";
			try {
				await testing.performLaunchBrowser({});
			} finally {
				delete process.env.FAKE_BROWSER_IGNORE_SIGTERM;
			}
			const [first] = launched(launches);
			// The relaunch spends the bridge's 5s SIGTERM grace period stopping the first browser.
			relaunch = testing.performLaunchBrowser({}, controller.signal);
			await waitUntil(() => fs.existsSync(termLog), "first browser did not receive SIGTERM", 5_000);
			assert.equal(await portListening(first.port), true, "the relaunch stopped the first browser before shutdown was called");
			await shutdownComputerUseSession();
			assert.equal(await portListening(first.port), false, "session shutdown returned while the relaunch was still stopping the first browser");
			await assertAllGone(before, launched(launches), "session shutdown during a relaunch");
			assert.equal(process.env.PI_COMPUTER_USE_CDP_PORT, undefined, "session shutdown left a CDP port configured");
		} finally {
			delete process.env.FAKE_BROWSER_LAUNCHES;
			delete process.env.FAKE_BROWSER_SIGTERM_LOG;
			controller.abort();
			await Promise.allSettled([relaunch]);
		}
		await assertAllGone(before, launched(launches), "the relaunch that lost to shutdown");
	});

	test("shutdown called right after a launch starts stops the browser that launch starts", async () => {
		const launches = path.join(scratch, "launches.jsonl");
		fs.rmSync(launches, { force: true });
		process.env.FAKE_BROWSER_LAUNCHES = launches;
		const before = new Set(fs.readdirSync(tmp));
		const controller = new AbortController();
		let launch;
		const createServer = net.createServer.bind(net);
		let portProbes = 0;
		vi.spyOn(net, "createServer").mockImplementation((...args) => {
			portProbes++;
			return createServer(...args);
		});
		try {
			// No await between the two calls: the launch is still resolving its executable and port.
			launch = testing.performLaunchBrowser({}, controller.signal);
			await shutdownComputerUseSession();
			assert.equal(portProbes, 1, "shutdown returned before the launch entered the lifecycle");
			await assertAllGone(before, launched(launches), "session shutdown right after a launch call");
			assert.equal(process.env.PI_COMPUTER_USE_CDP_PORT, undefined, "session shutdown left a CDP port configured");
		} finally {
			delete process.env.FAKE_BROWSER_LAUNCHES;
			controller.abort();
			await Promise.allSettled([launch]);
			vi.restoreAllMocks();
		}
		await assertAllGone(before, launched(launches), "the launch that raced shutdown");
		assert.equal(process.env.PI_COMPUTER_USE_CDP_PORT, undefined, "the launch that raced shutdown left a CDP port configured");
	});

	test("a Pi process that quits right after shutdown leaves no profile dir behind", async () => {
		const script = path.join(scratch, "child.mjs");
		fs.writeFileSync(script, CHILD_SCRIPT);
		const { profile, existsAfterShutdown } = await runChild(script, "shutdown");
		assert.equal(existsAfterShutdown, false, "session shutdown returned before removing the profile dir");
		assert(!fs.existsSync(profile), `profile ${profile} survived the Pi process`);
	});

	test("a hard exit without session shutdown kills the browser and removes its profile dir", async () => {
		const script = path.join(scratch, "child.mjs");
		fs.writeFileSync(script, CHILD_SCRIPT);
		const { profile } = await runChild(script, "exit");
		const { port } = JSON.parse(fs.readFileSync(log, "utf8"));
		assert(!fs.existsSync(profile), `profile ${profile} survived a hard exit`);
		assert.equal(await cdpAnswers(port), false, "managed browser outlived the Pi process");
	});
});
