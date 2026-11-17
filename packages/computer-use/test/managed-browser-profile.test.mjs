import assert from "node:assert/strict";
import { ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, test, vi } from "vitest";
import { executeFind, executeLaunchBrowser, shutdownComputerUseSession, testing } from "../src/bridge.ts";
import { loadComputerUseConfig } from "../src/config.ts";
import { currentPlatformBackend } from "../src/platform/index.ts";
import { ResourceScheduler } from "../src/runtime.ts";
import { deferred, within } from "../tests/fixtures/check-async.mjs";
import { browserSnapshot } from "./support/fake-browser.mjs";

const gate = vi.hoisted(() => ({
	target: "",
	calls: 0,
	release: undefined,
	entered: undefined,
	outcomes: [],
	spawnParent: "",
	spawnError: undefined,
	statTarget: "",
	statCalls: 0,
	statFailureAt: 0,
	afterMkdir: undefined,
	afterLstatSync: undefined,
	afterStat: undefined,
	foreignAncestor: "",
}));
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...actual,
		mkdir: async (...args) => {
			const result = await actual.mkdir(...args);
			gate.afterMkdir?.(String(args[0]));
			return result;
		},
		stat: async (...args) => {
			if (String(args[0]) === gate.statTarget && ++gate.statCalls === gate.statFailureAt) {
				throw Object.assign(new Error("synthetic metadata permission failure"), { code: "EACCES" });
			}
			const info = await actual.stat(...args);
			gate.afterStat?.(String(args[0]));
			return info;
		},
		rm: async (...args) => {
			if (String(args[0]) !== gate.target && !gate.spawnParent) return await actual.rm(...args);
			if (String(args[0]) === gate.target) {
				gate.calls++;
				if (gate.calls === 1) {
					gate.entered();
					await new Promise((resolve) => {
						gate.release = resolve;
					});
				}
			}
			try {
				const result = await actual.rm(...args);
				gate.outcomes.push({ path: String(args[0]), exists: fs.existsSync(args[0]) });
				return result;
			} catch (error) {
				gate.outcomes.push({ path: String(args[0]), exists: fs.existsSync(args[0]), error });
				throw error;
			}
		},
	};
});
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...actual,
		mkdirSync: (...args) => {
			const result = actual.mkdirSync(...args);
			gate.afterMkdir?.(String(args[0]));
			return result;
		},
		lstatSync: (...args) => {
			const info = actual.lstatSync(...args);
			gate.afterLstatSync?.(String(args[0]));
			// Non-root runners cannot chown fixtures to another UID; only this metadata owner field is simulated.
			if (String(args[0]) === gate.foreignAncestor) return Object.assign(info, { uid: process.getuid() + 1 });
			return info;
		},
	};
});
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...actual,
		spawn: (...args) => {
			if (gate.spawnParent) fs.chmodSync(gate.spawnParent, 0o555);
			try {
				return actual.spawn(...args);
			} catch (error) {
				gate.spawnError = error;
				throw error;
			}
		},
	};
});

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
	const child = spawn(process.execPath, ["--import", "tsx", script, mode], {
		cwd: PACKAGE_DIR,
		stdio: ["ignore", "pipe", "inherit"],
		timeout: CHILD_TIMEOUT_MS,
	});
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

describe("temporary profile cleanup race", () => {
	const executable = fileURLToPath(new URL("./fixtures/fake-browser.mjs", import.meta.url));
	let scratch;
	let shutdown;
	afterEach(async () => {
		gate.release?.();
		try {
			await within(Promise.allSettled([shutdown]), "pending profile removal");
			await within(shutdownComputerUseSession(), "test session shutdown");
		} finally {
			vi.unstubAllEnvs();
			if (scratch) {
				fs.chmodSync(scratch, 0o700);
				fs.rmSync(scratch, { recursive: true, force: true });
			}
			gate.outcomes = [];
			gate.spawnParent = "";
			gate.spawnError = undefined;
			gate.target = "";
			gate.entered = undefined;
			gate.release = undefined;
			shutdown = undefined;
		}
	});

	/** Launch the existing POSIX fake-browser executable in an owned temporary parent. */
	async function launch() {
		scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cu-owned-race-")));
		const log = path.join(scratch, "launch.json");
		vi.stubEnv("TMPDIR", scratch);
		vi.stubEnv("PI_COMPUTER_USE_CHROME_EXECUTABLE", executable);
		vi.stubEnv("FAKE_BROWSER_LOG", log);
		vi.stubEnv("PI_COMPUTER_USE_CDP_PORT", "");
		await within(testing.performLaunchBrowser({}), "fake browser launch");
		const { profile } = JSON.parse(fs.readFileSync(log, "utf8"));
		assert.equal(path.dirname(profile), scratch);
		assert.ok(fs.existsSync(profile));
		gate.target = profile;
		gate.calls = 0;
		return profile;
	}

	/** Start real shutdown and wait until its first asynchronous removal reaches the barrier. */
	async function startCleanup() {
		const entered = new Promise((resolve) => {
			gate.entered = resolve;
		});
		shutdown = shutdownComputerUseSession();
		await within(entered, "first actual profile removal");
	}

	test.skipIf(process.platform === "win32")("close and shutdown share the real temporary-profile removal", async () => {
		const profile = await launch();
		await startCleanup();
		// Let the close handler and lifecycle continuation run while the first actual rm is paused.
		for (let index = 0; index < 5; index++) await new Promise((resolve) => setImmediate(resolve));
		const concurrentCalls = gate.calls;
		gate.release();
		await within(shutdown, "shared profile cleanup");
		assert.equal(concurrentCalls, 1, "one temporary profile must never have concurrent removals");
		assert.equal(fs.existsSync(profile), false, "the actual disposable profile is removed");
		assert.deepEqual(
			gate.outcomes.filter((outcome) => outcome.path === profile),
			[{ path: profile, exists: false }],
		);
	});

	test.skipIf(process.platform === "win32")(
		"exit cleanup during an in-flight removal preserves unrelated data",
		async () => {
			const profile = await launch();
			const other = path.join(scratch, "unrelated");
			fs.mkdirSync(other);
			fs.writeFileSync(path.join(other, "marker"), "preserve");
			await startCleanup();
			testing.removeProfileDirsOnExit();
			assert.equal(fs.existsSync(profile), false, "synchronous exit cleanup removes the owned directory");
			assert.equal(fs.readFileSync(path.join(other, "marker"), "utf8"), "preserve");
			gate.release();
			await within(shutdown, "late asynchronous removal after exit cleanup");
			assert.equal(fs.existsSync(profile), false);
			assert.equal(fs.readFileSync(path.join(other, "marker"), "utf8"), "preserve");
		},
	);

	test.skipIf(process.platform === "win32")(
		"failed shared removal stays tracked for synchronous exit retry",
		async () => {
			const profile = await launch();
			await startCleanup();
			for (let index = 0; index < 5; index++) await new Promise((resolve) => setImmediate(resolve));
			fs.chmodSync(scratch, 0o555);
			try {
				assert.throws(() => fs.accessSync(scratch, fs.constants.W_OK), "requires a non-writable parent");
				gate.release();
				await within(shutdown, "failed shared cleanup");
				assert.equal(gate.calls, 1);
				const [outcome] = gate.outcomes.filter((entry) => entry.path === profile);
				assert.equal(outcome.error.code, "EACCES");
				assert.equal(outcome.exists, true, "the failed actual removal retained the directory");
			} finally {
				fs.chmodSync(scratch, 0o700);
			}
			testing.removeProfileDirsOnExit();
			assert.equal(fs.existsSync(profile), false, "exit cleanup retries the failed shared attempt");
		},
	);

	test.skipIf(process.platform === "win32")(
		"a failed real spawn preserves error identity when profile cleanup also fails",
		async () => {
			scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cu-owned-spawn-")));
			vi.stubEnv("TMPDIR", scratch);
			vi.stubEnv("PI_COMPUTER_USE_CHROME_EXECUTABLE", executable);
			vi.stubEnv("PI_COMPUTER_USE_CDP_PORT", "");
			gate.spawnParent = scratch;
			try {
				await assert.rejects(testing.performLaunchBrowser({ url: "http://example.test/\u0000" }), (error) => {
					assert.equal(error, gate.spawnError, "cleanup must not replace the actual spawn error");
					assert.equal(error.code, "ERR_INVALID_ARG_VALUE");
					return true;
				});
				assert.equal(gate.outcomes.length, 1);
				assert.equal(gate.outcomes[0].error.code, "EACCES");
				assert.equal(gate.outcomes[0].exists, true);
				assert.equal(process.env.PI_COMPUTER_USE_CDP_PORT, "");
			} finally {
				fs.chmodSync(scratch, 0o700);
			}
		},
	);
});

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
		for (const name of [
			"TMPDIR",
			"FAKE_BROWSER_LOG",
			"FAKE_BROWSER_IGNORE_SIGTERM",
			"FAKE_BROWSER_SIGTERM_LOG",
			"FAKE_BROWSER_NO_CDP",
			"FAKE_BROWSER_LAUNCHES",
			"PI_COMPUTER_USE_CHROME_EXECUTABLE",
			"PI_COMPUTER_USE_CDP_PORT",
		])
			saved[name] = process.env[name];
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
			server.once("listening", () =>
				fs.mkdirSync(path.join(tmp, `pi-chrome-cdp-${server.address().port}`), { mode: 0o555 }),
			);
			return server;
		});
		const result = await testing.performLaunchBrowser({});
		vi.restoreAllMocks();
		assert.match(result.content[0].text, /Fake|about:blank/, "launch_browser did not observe the managed page");

		const { port, profile } = JSON.parse(fs.readFileSync(log, "utf8"));
		const legacy = path.join(tmp, `pi-chrome-cdp-${port}`);
		assert(fs.existsSync(legacy), "the chosen port's legacy profile dir was not squatted");
		assert.throws(
			() => fs.accessSync(legacy, fs.constants.W_OK),
			"squatted legacy profile dir is writable, so this run proves nothing (root?)",
		);
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

	test("stopping a browser skips another browser's stale tracked profile and still removes its own", async () => {
		// A's profile holds a read-only subdir, so every removal attempt (shutdown's and the `close`
		// listener's, whenever it runs) fails and the entry stays tracked. Stopping B must then walk past
		// that entry, owned by a different process, in `profileDirOf` instead of racing a listener.
		await testing.performLaunchBrowser({});
		const { profile: stale } = JSON.parse(fs.readFileSync(log, "utf8"));
		const locked = path.join(stale, "locked");
		fs.mkdirSync(locked);
		fs.writeFileSync(path.join(locked, "file"), "");
		fs.chmodSync(locked, 0o555);
		try {
			await shutdownComputerUseSession();
			assert(fs.existsSync(stale), "profile removal unexpectedly succeeded under a read-only subdir (root?)");
			await testing.performLaunchBrowser({});
			const { profile } = JSON.parse(fs.readFileSync(log, "utf8"));
			assert.notEqual(profile, stale);
			await shutdownComputerUseSession();
			assert(!fs.existsSync(profile), "session shutdown returned before removing the profile dir");
			assert(fs.existsSync(stale), "stopping B removed A's tracked profile");
		} finally {
			fs.chmodSync(locked, 0o755);
		}
		testing.removeProfileDirsOnExit();
		assert(!fs.existsSync(stale), "exit hook did not remove the stale profile dir");
	});

	test("an aborted launch stops the browser and removes its profile", async () => {
		const before = new Set(fs.readdirSync(tmp));
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(testing.performLaunchBrowser({}, controller.signal), /aborted/);
		assert.deepEqual(
			fs.readdirSync(tmp).filter((entry) => !before.has(entry)),
			[],
			"aborted launch returned before removing the profile dir",
		);
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
			assert.equal(
				process.env.PI_COMPUTER_USE_CDP_PORT,
				String(port),
				"launch did not point CDP at the managed browser",
			);
			await shutdownComputerUseSession();
			assert.equal(
				process.env.PI_COMPUTER_USE_CDP_PORT,
				"9222",
				"session shutdown did not restore the user's CDP port",
			);
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
		// rejection is the spawn error itself. The cleanup race suite also covers a failed removal.
		const before = new Set(fs.readdirSync(tmp));
		// The URL passes the scheme check, but `spawn` rejects the NUL byte synchronously.
		await assert.rejects(testing.performLaunchBrowser({ url: "http://example.test/\0" }), {
			code: "ERR_INVALID_ARG_VALUE",
		});
		assert.deepEqual(
			fs.readdirSync(tmp).filter((entry) => !before.has(entry)),
			[],
			"failed spawn left a profile dir behind",
		);
		assert.equal(process.env.PI_COMPUTER_USE_CDP_PORT, undefined, "failed spawn left a CDP port configured");
	});

	/**
	 * Every fake browser recorded in `$FAKE_BROWSER_LAUNCHES` since `launches` was reset.
	 * @param {string} launches Path of the launch log.
	 * @returns {{ port: number, profile: string }[]} One entry per started browser.
	 */
	function launched(launches) {
		return fs.existsSync(launches)
			? fs
					.readFileSync(launches, "utf8")
					.trim()
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line))
			: [];
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
		assert.deepEqual(
			fs.readdirSync(tmp).filter((entry) => !before.has(entry)),
			[],
			`${when} left a profile dir behind`,
		);
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
		await assertAllGone(
			new Set([...before, ...liveEntries]),
			browsers.filter((entry) => entry !== live),
			"a concurrent relaunch",
		);
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
			assert.deepEqual(
				fs.readdirSync(tmp).filter((entry) => !before.has(entry)),
				[],
			);
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
			assert.equal(
				await portListening(first.port),
				true,
				"the relaunch stopped the first browser before shutdown was called",
			);
			await shutdownComputerUseSession();
			assert.equal(
				await portListening(first.port),
				false,
				"session shutdown returned while the relaunch was still stopping the first browser",
			);
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
		assert.equal(
			process.env.PI_COMPUTER_USE_CDP_PORT,
			undefined,
			"the launch that raced shutdown left a CDP port configured",
		);
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

// Only disposable homes and fake browser processes are used for persistent-profile acceptance.
describe("persistent profile opt-in", () => {
	const executable = fileURLToPath(new URL("./fixtures/fake-browser.mjs", import.meta.url));
	// Use a canonical sticky system temp root, not an unchecked volume or caller-selected TMPDIR ancestor.
	const secureTemp = process.platform === "win32" ? os.tmpdir() : fs.realpathSync("/tmp");
	let root;
	let profile;
	let saved;
	let home;
	const keys = [
		"PI_CODING_AGENT_DIR",
		"PI_COMPUTER_USE_CHROME_EXECUTABLE",
		"PI_COMPUTER_USE_CDP_PORT",
		"FAKE_BROWSER_LOG",
		"FAKE_BROWSER_NO_CDP",
		"XDG_CONFIG_HOME",
		"CHROME_CONFIG_HOME",
	];

	/** Write the isolated user-global opt-in, then reload it. */
	function configure(value = profile) {
		const file = path.join(root, "agent/extensions/pi-computer-use.json");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify({ managed_browser_profile: value }));
		loadComputerUseConfig(root);
	}

	beforeEach(() => {
		gate.afterMkdir = undefined;
		gate.afterLstatSync = undefined;
		gate.afterStat = undefined;
		gate.foreignAncestor = "";
		saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
		for (const key of keys) delete process.env[key];
		root = fs.realpathSync(fs.mkdtempSync(path.join(secureTemp, "cu-persistent-")));
		home = path.join(root, "home");
		fs.mkdirSync(home);
		vi.spyOn(os, "homedir").mockReturnValue(home);
		profile = path.join(home, "dedicated-profile");
		fs.mkdirSync(profile, { mode: 0o700 });
		process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
		process.env.PI_COMPUTER_USE_CHROME_EXECUTABLE = executable;
		process.env.FAKE_BROWSER_LOG = path.join(root, "argv.json");
		configure();
	});

	afterEach(async () => {
		await shutdownComputerUseSession();
		vi.restoreAllMocks();
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		loadComputerUseConfig(path.join(root, "reset"));
		fs.rmSync(root, { recursive: true, force: true });
	});

	describe.skipIf(process.platform === "win32")("persistent managed profile", () => {
		test("reuses an explicit profile, reports executable provenance and preserves contents on shutdown", async () => {
			const sentinel = path.join(profile, "synthetic-session");
			fs.writeFileSync(sentinel, "disposable");
			for (let run = 0; run < 2; run++) {
				const result = await testing.performLaunchBrowser({});
				assert.equal(result.details.executable, executable);
				assert.match(result.content.at(-1).text, /Managed browser executable/);
				assert.equal(JSON.parse(fs.readFileSync(process.env.FAKE_BROWSER_LOG)).profile, profile);
				assert(fs.existsSync(path.join(profile, ".pi-computer-use.lock")));
				await shutdownComputerUseSession();
				assert.equal(fs.readFileSync(sentinel, "utf8"), "disposable");
				assert(!fs.existsSync(path.join(profile, ".pi-computer-use.lock")));
			}
		});

		test.each(["persistent-first", "temporary-first"])(
			"%s keeps each launch's ownership and cleanup independent",
			async (order) => {
				const marker = path.join(profile, "synthetic-session");
				fs.writeFileSync(marker, "preserve");
				const launch = async (persistent) => {
					configure(persistent ? profile : null);
					await testing.performLaunchBrowser({});
					const used = JSON.parse(fs.readFileSync(process.env.FAKE_BROWSER_LOG, "utf8")).profile;
					assert.equal(used === profile, persistent);
					await shutdownComputerUseSession();
					assert.equal(fs.existsSync(used), persistent);
					assert.equal(fs.readFileSync(marker, "utf8"), "preserve");
				};
				await launch(order === "persistent-first");
				await launch(order !== "persistent-first");
			},
		);

		test.each([
			["port", "symlink"],
			["shutdown", "symlink"],
			["lease", "symlink"],
			["port", "directory"],
			["shutdown", "directory"],
			["lease", "directory"],
		])("refuses profile replacement at %s allocation (%s) without writing through it", async (stage, kind) => {
			if (stage === "shutdown") {
				configure(null);
				await testing.performLaunchBrowser({});
				fs.unlinkSync(process.env.FAKE_BROWSER_LOG);
				configure();
			}
			const replacement = path.join(home, "replacement");
			fs.mkdirSync(replacement, { mode: kind === "symlink" ? 0o777 : 0o700 });
			fs.chmodSync(replacement, kind === "symlink" ? 0o777 : 0o700);
			fs.writeFileSync(path.join(replacement, "sentinel"), "unchanged");
			const swap = () => {
				fs.renameSync(profile, `${profile}-original`);
				if (kind === "symlink") fs.symlinkSync(replacement, profile);
				else fs.renameSync(replacement, profile);
			};
			if (stage === "port") {
				const createServer = net.createServer.bind(net);
				vi.spyOn(net, "createServer").mockImplementationOnce((...args) => {
					swap();
					return createServer(...args);
				});
			} else if (stage === "shutdown") {
				const kill = ChildProcess.prototype.kill;
				vi.spyOn(ChildProcess.prototype, "kill").mockImplementationOnce(function (...args) {
					swap();
					return kill.apply(this, args);
				});
			} else {
				gate.afterMkdir = (directory) => {
					if (directory !== path.join(profile, ".pi-computer-use.lock")) return;
					gate.afterMkdir = undefined;
					swap();
				};
			}
			await assert.rejects(testing.performLaunchBrowser({}), /symlink|changed/);
			const actual = kind === "symlink" ? replacement : profile;
			assert.deepEqual(fs.readdirSync(actual), ["sentinel"]);
			assert.equal(fs.readFileSync(path.join(actual, "sentinel"), "utf8"), "unchanged");
			assert.equal(fs.statSync(actual).mode & 0o777, kind === "symlink" ? 0o777 : 0o700);
			assert(!fs.existsSync(process.env.FAKE_BROWSER_LOG));
		});

		test.each(["checkout", "chromium-lock", "lease-symlink", "lease-mode", "profile-mode", "ancestor-mode"])(
			"rechecks %s after lease creation without starting the browser or repairing permissions",
			async (change) => {
				const lease = path.join(profile, ".pi-computer-use.lock");
				const victim = path.join(home, "lease-victim");
				fs.mkdirSync(victim, { mode: 0o700 });
				fs.writeFileSync(path.join(victim, "sentinel"), "unchanged");
				gate.afterMkdir = (directory) => {
					if (directory !== lease) return;
					gate.afterMkdir = undefined;
					if (change === "checkout") fs.writeFileSync(path.join(profile, ".git"), "synthetic worktree");
					else if (change === "chromium-lock")
						fs.symlinkSync("synthetic-host-123", path.join(profile, "SingletonLock"));
					else if (change === "lease-symlink") {
						fs.rmdirSync(lease);
						fs.symlinkSync(victim, lease);
					} else if (change === "lease-mode") fs.chmodSync(lease, 0o755);
					else if (change === "profile-mode") fs.chmodSync(profile, 0o755);
					else fs.chmodSync(home, 0o775);
				};
				await assert.rejects(
					testing.performLaunchBrowser({}),
					/Git checkout|Chromium lock|lease changed|0700|ancestor/,
				);
				assert(!fs.existsSync(process.env.FAKE_BROWSER_LOG));
				assert(!fs.existsSync(path.join(profile, "Local State")));
				assert.deepEqual(fs.readdirSync(victim), ["sentinel"]);
				assert.equal(fs.readFileSync(path.join(victim, "sentinel"), "utf8"), "unchanged");
				if (change === "chromium-lock") assert(fs.lstatSync(path.join(profile, "SingletonLock")).isSymbolicLink());
				if (change === "lease-symlink") assert(fs.lstatSync(lease).isSymbolicLink());
				if (change === "lease-mode") assert.equal(fs.statSync(lease).mode & 0o777, 0o755);
				if (change === "profile-mode") {
					assert.equal(fs.statSync(profile).mode & 0o777, 0o755);
					assert(fs.existsSync(lease), "post-creation permission uncertainty must retain the lease");
				}
				if (change === "ancestor-mode") {
					assert.equal(fs.statSync(home).mode & 0o777, 0o775);
					assert(fs.existsSync(lease), "post-creation ancestry uncertainty must retain the lease");
				}
			},
		);

		test.each(["directory", "symlink"])("detects a %s swap during the post-lease refusal policy", async (kind) => {
			const replacement = path.join(home, "late-replacement");
			fs.mkdirSync(replacement, { mode: 0o700 });
			gate.afterStat = (directory) => {
				if (directory !== home || !fs.existsSync(path.join(profile, ".pi-computer-use.lock"))) return;
				gate.afterStat = undefined;
				fs.renameSync(profile, `${profile}-original`);
				if (kind === "symlink") fs.symlinkSync(replacement, profile);
				else fs.renameSync(replacement, profile);
			};
			await assert.rejects(testing.performLaunchBrowser({}), /changed|symlink/);
			assert.deepEqual(fs.readdirSync(kind === "symlink" ? replacement : profile), []);
			assert(!fs.existsSync(process.env.FAKE_BROWSER_LOG));
			assert(fs.existsSync(path.join(`${profile}-original`, ".pi-computer-use.lock")));
		});

		test("does not use or release a replacement lease with otherwise valid metadata", async () => {
			const lease = path.join(profile, ".pi-computer-use.lock");
			gate.afterLstatSync = (directory) => {
				if (directory !== lease) return;
				gate.afterLstatSync = undefined;
				fs.renameSync(lease, `${lease}-original`);
				fs.mkdirSync(lease, { mode: 0o700 });
			};
			await assert.rejects(testing.performLaunchBrowser({}), /lease changed/);
			assert(fs.existsSync(`${lease}-original`));
			assert(fs.existsSync(lease));
			assert(!fs.existsSync(process.env.FAKE_BROWSER_LOG));
		});

		test("refuses foreign lease ownership metadata without removing it", async () => {
			const lease = path.join(profile, ".pi-computer-use.lock");
			gate.foreignAncestor = lease;
			await assert.rejects(testing.performLaunchBrowser({}), /lease changed/);
			assert(fs.existsSync(lease));
			assert.equal(fs.statSync(lease).uid, process.getuid());
			assert(!fs.existsSync(process.env.FAKE_BROWSER_LOG));
		});

		test("refuses changed profile ownership metadata without touching the fixture", async () => {
			gate.foreignAncestor = profile;
			await assert.rejects(testing.performLaunchBrowser({}), /0700/);
			assert.equal(fs.statSync(profile).uid, process.getuid());
			assert.deepEqual(fs.readdirSync(profile), []);
		});

		test.each([0o775, 0o777])("refuses writable non-sticky ancestors (mode %s) without chmod", async (mode) => {
			fs.chmodSync(home, mode);
			await assert.rejects(testing.performLaunchBrowser({}), /ancestor/);
			assert.equal(fs.statSync(home).mode & 0o7777, mode);
			assert.deepEqual(fs.readdirSync(profile), []);
			assert(!fs.existsSync(process.env.FAKE_BROWSER_LOG));
		});

		test("refuses foreign-owned ancestry metadata without touching the fixture", async () => {
			gate.foreignAncestor = home;
			await assert.rejects(testing.performLaunchBrowser({}), /ancestor/);
			assert.equal(fs.statSync(home).uid, process.getuid());
			assert.deepEqual(fs.readdirSync(profile), []);
			assert(!fs.existsSync(process.env.FAKE_BROWSER_LOG));
		});

		test("accepts a current-user sticky writable ancestor without chmod", async () => {
			fs.chmodSync(home, 0o1777);
			assert.equal(await testing.persistentBrowserProfile(profile), profile);
			assert.equal(fs.statSync(home).mode & 0o7777, 0o1777);
		});

		test("another Pi process cannot share a live persistent profile", async () => {
			await testing.performLaunchBrowser({});
			const script = `import { loadComputerUseConfig } from ${JSON.stringify(new URL("../src/config.ts", import.meta.url).href)}; import { testing } from ${JSON.stringify(new URL("../src/bridge.ts", import.meta.url).href)}; loadComputerUseConfig(process.env.TEST_CWD); try { await testing.performLaunchBrowser({}); process.exitCode = 1; } catch (error) { if (!/locked/.test(error.message)) throw error; }`;
			const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
				cwd: fileURLToPath(new URL("..", import.meta.url)),
				env: { ...process.env, TEST_CWD: root },
				stdio: ["ignore", "ignore", "pipe"],
				timeout: 15000,
			});
			let stderr = "";
			child.stderr.on("data", (chunk) => {
				stderr += chunk;
			});
			const code = await new Promise((resolve, reject) => {
				child.once("error", reject);
				child.once("close", resolve);
			});
			assert.equal(code, 0, stderr);
			assert(fs.existsSync(path.join(profile, ".pi-computer-use.lock")));
		});

		test("validates permissions, symlinks, non-directory and checkout paths without changing them", async () => {
			fs.chmodSync(profile, 0o755);
			await assert.rejects(testing.persistentBrowserProfile(profile), /0700/);
			assert.equal(fs.statSync(profile).mode & 0o777, 0o755);
			fs.chmodSync(profile, 0o700);
			const alias = path.join(home, "alias");
			fs.symlinkSync(profile, alias);
			await assert.rejects(testing.persistentBrowserProfile(alias), /symlink/);
			const nested = path.join(profile, "nested");
			fs.mkdirSync(nested, { mode: 0o700 });
			await assert.rejects(testing.persistentBrowserProfile(path.join(alias, "nested")), /symlink/);
			const file = path.join(home, "file");
			fs.writeFileSync(file, "", { mode: 0o700 });
			await assert.rejects(testing.persistentBrowserProfile(file), /real directory/);
			fs.writeFileSync(path.join(home, ".git"), "synthetic worktree marker");
			await assert.rejects(testing.persistentBrowserProfile(profile), /Git checkout/);
		});

		test("refuses native Windows persistence rather than guessing ACL security", async () => {
			vi.spyOn(process, "platform", "get").mockReturnValue("win32");
			await assert.rejects(testing.persistentBrowserProfile(profile), /Windows ACL/);
		});

		test("refuses directory executable overrides without trying an installed browser", async () => {
			process.env.PI_COMPUTER_USE_CHROME_EXECUTABLE = profile;
			await assert.rejects(testing.performLaunchBrowser({}), /not found or is not executable/);
			assert(!fs.existsSync(process.env.FAKE_BROWSER_LOG));
		});

		test("a lease that cannot be released remains fail-closed without deleting profile data", async () => {
			await testing.performLaunchBrowser({});
			const lease = path.join(profile, ".pi-computer-use.lock");
			const blocker = path.join(lease, "synthetic-blocker");
			fs.writeFileSync(blocker, "");
			await shutdownComputerUseSession();
			assert(fs.existsSync(profile));
			assert(fs.existsSync(blocker));
			fs.unlinkSync(blocker);
		});

		test("refuses relative paths, home, default profile trees and their ancestors", async () => {
			await assert.rejects(testing.persistentBrowserProfile("relative"), /absolute/);
			fs.chmodSync(home, 0o700);
			await assert.rejects(testing.persistentBrowserProfile(home), /default browser/);
			const standard = path.join(home, ".config/google-chrome");
			fs.mkdirSync(path.join(standard, "Default"), { recursive: true, mode: 0o700 });
			for (const directory of [path.dirname(standard), standard, path.join(standard, "Default")]) {
				fs.chmodSync(directory, 0o700);
				await assert.rejects(testing.persistentBrowserProfile(directory), /default browser/);
			}
			assert.equal(await testing.persistentBrowserProfile("~/dedicated-profile"), profile);
		});

		test.each(["Chrome", "Chrome Canary", "Chrome Beta", "Chrome Dev"])(
			"rejects macOS %s default and descendants",
			async (channel) => {
				const directory = path.join(home, "Library/Application Support/Google", channel);
				const child = path.join(directory, "Default");
				fs.mkdirSync(child, { recursive: true, mode: 0o700 });
				for (const candidate of [directory, child]) {
					fs.chmodSync(candidate, 0o700);
					await assert.rejects(testing.persistentBrowserProfile(candidate), /default browser/);
				}
			},
		);

		test.each(["parent", "directory"])("rejects canonical macOS defaults through a %s alias", async (aliasKind) => {
			const actual = path.join(home, "relocated");
			fs.mkdirSync(actual, { mode: 0o700 });
			const parent = path.join(home, "Library/Application Support/Google");
			fs.mkdirSync(path.dirname(parent), { recursive: true });
			let candidate;
			if (aliasKind === "parent") {
				fs.symlinkSync(actual, parent);
				candidate = path.join(actual, "Chrome");
				fs.mkdirSync(candidate, { mode: 0o700 });
			} else {
				fs.mkdirSync(parent);
				fs.symlinkSync(actual, path.join(parent, "Chrome"));
				candidate = actual;
			}
			await assert.rejects(testing.persistentBrowserProfile(candidate), /default browser/);
		});

		test.each(["XDG_CONFIG_HOME", "CHROME_CONFIG_HOME", "implicit"])(
			"rejects %s ancestry even when every browser child is relocated",
			async (variable) => {
				const parent = path.join(home, "config-parent");
				const configRoot = variable === "implicit" ? path.join(home, ".config") : path.join(parent, "config");
				fs.mkdirSync(configRoot, { recursive: true, mode: 0o700 });
				fs.chmodSync(path.dirname(configRoot), 0o700);
				const relocated = path.join(root, "relocated-browsers");
				fs.mkdirSync(relocated, { mode: 0o700 });
				for (const name of ["google-chrome", "google-chrome-beta", "google-chrome-unstable", "chromium", "helium"]) {
					fs.symlinkSync(relocated, path.join(configRoot, name));
				}
				if (variable !== "implicit") process.env[variable] = configRoot;
				const nested = path.join(configRoot, "nested");
				fs.mkdirSync(nested, { mode: 0o700 });
				for (const candidate of [configRoot, path.dirname(configRoot), nested, `${configRoot}/nested/../`]) {
					await assert.rejects(testing.persistentBrowserProfile(candidate), /default browser/);
				}
				const alias = path.join(root, "config-root-alias");
				fs.symlinkSync(configRoot, alias);
				await assert.rejects(testing.persistentBrowserProfile(alias), /symlink/);
				if (variable !== "implicit") {
					process.env[variable] = `${alias}/nested/../`;
					await assert.rejects(testing.persistentBrowserProfile(configRoot), /default browser/);
				}
				assert.equal(await testing.persistentBrowserProfile(profile), profile);
			},
		);

		test.each([true, false])(
			"preserves filesystem parent traversal through a symlink (root exists: %s)",
			async (exists) => {
				const declaredParent = path.join(root, "declared-parent");
				const resolvedParent = path.join(root, "resolved-parent");
				fs.mkdirSync(declaredParent, { mode: 0o700 });
				fs.mkdirSync(path.join(resolvedParent, "deep"), { recursive: true, mode: 0o700 });
				fs.chmodSync(resolvedParent, 0o700);
				const alias = path.join(declaredParent, "link");
				fs.symlinkSync(path.join(resolvedParent, "deep"), alias);
				if (exists) fs.mkdirSync(path.join(resolvedParent, "config"), { mode: 0o700 });
				process.env.XDG_CONFIG_HOME = `${alias}/../config`;
				await assert.rejects(testing.persistentBrowserProfile(resolvedParent), /default browser/);
				assert.equal(await testing.persistentBrowserProfile(profile), profile);
			},
		);

		test("resolves relative configuration roots by filesystem ancestry", async () => {
			const configRoot = path.join(home, "relative-config");
			fs.mkdirSync(configRoot, { mode: 0o700 });
			process.env.CHROME_CONFIG_HOME = path.relative(process.cwd(), configRoot);
			await assert.rejects(testing.persistentBrowserProfile(configRoot), /default browser/);
			assert.equal(await testing.persistentBrowserProfile(profile), profile);
		});

		test("retains macOS default-parent protection when all children are symlinked elsewhere", async () => {
			const parent = path.join(home, "Library/Application Support/Google");
			const target = path.join(root, "relocated-macos");
			fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
			fs.mkdirSync(target, { mode: 0o700 });
			for (const channel of ["Chrome", "Chrome Canary", "Chrome Beta", "Chrome Dev"]) {
				fs.symlinkSync(target, path.join(parent, channel));
			}
			await assert.rejects(testing.persistentBrowserProfile(parent), /default browser/);
			assert.equal(await testing.persistentBrowserProfile(profile), profile);
		});

		test.each(["XDG_CONFIG_HOME", "CHROME_CONFIG_HOME"])(
			"honours filesystem case identity for %s",
			async (variable) => {
				const configuredRoot = path.join(home, "Config");
				const alternate = path.join(home, "config");
				fs.mkdirSync(configuredRoot, { mode: 0o700 });
				process.env[variable] = configuredRoot;
				if (fs.existsSync(alternate)) {
					await assert.rejects(testing.persistentBrowserProfile(alternate), /default browser/);
				} else {
					fs.mkdirSync(alternate, { mode: 0o700 });
					assert.equal(await testing.persistentBrowserProfile(alternate), alternate);
				}
			},
		);

		test.each(["XDG_CONFIG_HOME", "CHROME_CONFIG_HOME", "HOME"])(
			"preserves %s alias-parent ancestry",
			async (variable) => {
				const external = fs.realpathSync(fs.mkdtempSync(path.join(secureTemp, "cu-alias-parent-")));
				const originalParent = path.join(root, "alias-parent");
				fs.mkdirSync(originalParent, { mode: 0o700 });
				const alias = path.join(originalParent, "linked-root");
				fs.symlinkSync(external, alias);
				try {
					if (variable === "HOME") vi.spyOn(os, "homedir").mockReturnValue(alias);
					else process.env[variable] = alias;
					await assert.rejects(testing.persistentBrowserProfile(originalParent), /default browser/);
					const dedicated = path.join(external, "fresh-profile");
					fs.mkdirSync(dedicated, { mode: 0o700 });
					if (variable === "HOME") assert.equal(await testing.persistentBrowserProfile(dedicated), dedicated);
					else assert.equal(await testing.persistentBrowserProfile(profile), profile);
				} finally {
					fs.rmSync(external, { recursive: true, force: true });
				}
			},
		);

		test("refuses HOME ancestors even when all default browser directories point outside them", async () => {
			const external = fs.realpathSync(fs.mkdtempSync(path.join(secureTemp, "cu-external-defaults-")));
			try {
				const defaults = [
					".config/google-chrome",
					".config/google-chrome-beta",
					".config/google-chrome-unstable",
					".config/chromium",
					".config/helium",
					"Library/Application Support/Google/Chrome",
					"Library/Application Support/Google/Chrome Canary",
					"Library/Application Support/Google/Chrome Beta",
					"Library/Application Support/Google/Chrome Dev",
					"Library/Application Support/Chromium",
					"Library/Application Support/net.imput.helium",
				];
				for (const relative of defaults) {
					const directory = path.join(home, relative);
					fs.mkdirSync(path.dirname(directory), { recursive: true });
					fs.symlinkSync(external, directory);
				}
				await assert.rejects(testing.persistentBrowserProfile(root), /default browser/);
				assert.equal(await testing.persistentBrowserProfile(profile), profile);
			} finally {
				fs.rmSync(external, { recursive: true, force: true });
			}
		});

		test.each(["XDG_CONFIG_HOME", "CHROME_CONFIG_HOME"])(
			"rejects Chrome channel default roots under %s",
			async (variable) => {
				const configRoot = path.join(home, variable);
				process.env[variable] = configRoot;
				for (const channel of ["google-chrome", "google-chrome-beta", "google-chrome-unstable"]) {
					const directory = path.join(configRoot, channel);
					fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
					await assert.rejects(testing.persistentBrowserProfile(directory), /default browser/);
				}
			},
		);

		test.each([1, 2])("fails closed on metadata failure during root check %s", async (failureAt) => {
			const directory = path.join(home, "metadata-error");
			fs.mkdirSync(directory, { mode: 0o700 });
			process.env.XDG_CONFIG_HOME = directory;
			gate.statTarget = directory;
			gate.statCalls = 0;
			gate.statFailureAt = failureAt;
			try {
				await assert.rejects(testing.persistentBrowserProfile(profile), { code: "EACCES" });
				assert.equal(gate.statCalls, failureAt);
			} finally {
				gate.statTarget = "";
			}
		});

		test("fails closed when a configured root cannot be resolved for a reason other than absence", async () => {
			const file = path.join(home, "not-a-directory");
			fs.writeFileSync(file, "synthetic");
			process.env.XDG_CONFIG_HOME = path.join(file, "child");
			await assert.rejects(testing.persistentBrowserProfile(profile), { code: "ENOTDIR" });
		});

		test("rejects defaults under an aliased implicit configuration directory", async () => {
			const realRoot = path.join(home, "real-config");
			const directory = path.join(realRoot, "google-chrome");
			fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
			fs.symlinkSync(realRoot, path.join(home, ".config"));
			delete process.env.XDG_CONFIG_HOME;
			delete process.env.CHROME_CONFIG_HOME;
			await assert.rejects(testing.persistentBrowserProfile(directory), /default browser/);
		});

		test.each(["XDG_CONFIG_HOME", "CHROME_CONFIG_HOME"])("rejects defaults under an aliased %s", async (variable) => {
			const realRoot = path.join(home, "real-config");
			const alias = path.join(home, "config-alias");
			const directory = path.join(realRoot, "google-chrome");
			fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
			fs.symlinkSync(realRoot, alias);
			process.env[variable] = alias;
			await assert.rejects(testing.persistentBrowserProfile(directory), /default browser/);
		});

		test.each([".pi-computer-use.lock", "SingletonLock", "SingletonCookie", "SingletonSocket"])(
			"refuses existing %s without removing it or starting a browser",
			async (name) => {
				const lock = path.join(profile, name);
				// Chromium's SingletonLock can be a dangling symlink; lstat, not exists, must detect it.
				if (name === "SingletonLock") fs.symlinkSync("synthetic-host-123", lock);
				else fs.mkdirSync(lock);
				await assert.rejects(testing.performLaunchBrowser({}), /locked|in use/);
				assert(fs.lstatSync(lock));
				assert(!fs.existsSync(process.env.FAKE_BROWSER_LOG));
			},
		);

		test("failed synchronous spawn preserves the profile and releases only Pi's lease", async () => {
			await assert.rejects(testing.performLaunchBrowser({ url: "http://example.test/\0" }), {
				code: "ERR_INVALID_ARG_VALUE",
			});
			assert(fs.existsSync(profile));
			assert(!fs.existsSync(path.join(profile, ".pi-computer-use.lock")));
			assert.equal(process.env.PI_COMPUTER_USE_CDP_PORT, undefined);
		});

		test("asynchronous spawn failure releases the lease without deleting the persistent profile", async () => {
			const invalid = path.join(root, "invalid-browser");
			fs.writeFileSync(invalid, "#!/nonexistent-synthetic-interpreter\n", { mode: 0o700 });
			process.env.PI_COMPUTER_USE_CHROME_EXECUTABLE = invalid;
			await assert.rejects(testing.performLaunchBrowser({}), { code: "ENOENT" });
			assert(fs.existsSync(profile));
			assert(!fs.existsSync(path.join(profile, ".pi-computer-use.lock")));
			assert.equal(process.env.PI_COMPUTER_USE_CDP_PORT, undefined);
		});

		test("aborted readiness preserves the profile and restores the previous port", async () => {
			process.env.FAKE_BROWSER_NO_CDP = "1";
			process.env.PI_COMPUTER_USE_CDP_PORT = "9222";
			const controller = new AbortController();
			const launch = testing.performLaunchBrowser({}, controller.signal);
			const deadline = Date.now() + 5000;
			while (!fs.existsSync(process.env.FAKE_BROWSER_LOG) && Date.now() < deadline)
				await new Promise((resolve) => setTimeout(resolve, 20));
			controller.abort();
			await assert.rejects(launch, /aborted/);
			assert(fs.existsSync(profile));
			assert(!fs.existsSync(path.join(profile, ".pi-computer-use.lock")));
			assert.equal(process.env.PI_COMPUTER_USE_CDP_PORT, "9222");
		});

		test("exit hook preserves persistent data and leaves a fail-closed lease", async () => {
			await testing.performLaunchBrowser({});
			testing.removeProfileDirsOnExit();
			assert(fs.existsSync(profile));
			assert(fs.existsSync(path.join(profile, ".pi-computer-use.lock")));
		});
	});

	test("synthetic login walls are marked as heuristics, ordinary pages are not claimed authenticated", async () => {
		const page = await browserSnapshot("synthetic-login", []);
		for (const fields of [
			{ title: "Sign in" },
			{ url: "http://127.0.0.1/signin" },
			{ targets: [{ role: "textbox", name: "Password" }] },
		]) {
			const result = testing.browserObservationResult({ ...page, ...fields }, "cdp:synthetic", 0, "navigate_browser");
			assert.equal(result.details.warning, "authentication_required");
			assert.match(result.content[0].text, /Ask the user before any sign-in/);
		}
		const normal = testing.browserObservationResult(
			{ ...page, snapshotId: "synthetic-normal" },
			"cdp:synthetic",
			0,
			"observe_ui",
		);
		assert.equal(normal.details.warning, undefined);
	});
});
