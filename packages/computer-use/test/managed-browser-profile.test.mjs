import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, test, vi } from "vitest";
import { shutdownComputerUseSession, testing } from "../src/bridge.ts";

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
 * Wait until a path no longer exists.
 * @param {string} target Path expected to disappear.
 * @param {number} timeoutMs Failure backstop.
 * @returns {Promise<void>} Resolves once `target` is gone.
 * @throws {import('node:assert').AssertionError} If `target` still exists at the deadline.
 */
async function waitForRemoval(target, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (fs.existsSync(target) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
	assert(!fs.existsSync(target), `managed browser profile ${target} outlived the browser`);
}

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
		for (const name of ["TMPDIR", "FAKE_BROWSER_LOG", "FAKE_BROWSER_IGNORE_SIGTERM", "PI_COMPUTER_USE_CHROME_EXECUTABLE", "PI_COMPUTER_USE_CDP_PORT"]) saved[name] = process.env[name];
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
		const created = fs.readdirSync(tmp).filter((entry) => !before.has(entry));
		assert.equal(created.length, 1, `expected one new profile dir, got ${created.join(", ")}`);
		assert.equal(process.env.PI_COMPUTER_USE_CDP_PORT, undefined, "aborted launch left its CDP port configured");
		await waitForRemoval(path.join(tmp, created[0]), 5_000);
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
