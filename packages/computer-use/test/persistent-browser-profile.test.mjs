// Dedicated disposable profiles only. No real browser, account, profile or credential store is used.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { loadComputerUseConfig } from "../src/config.ts";
import { shutdownComputerUseSession, testing } from "../src/bridge.ts";
import { browserSnapshot } from "./support/fake-browser.mjs";

const executable = fileURLToPath(new URL("./fixtures/fake-browser.mjs", import.meta.url));
let root;
let profile;
let saved;
let home;
const keys = ["PI_CODING_AGENT_DIR", "PI_COMPUTER_USE_CHROME_EXECUTABLE", "PI_COMPUTER_USE_CDP_PORT", "FAKE_BROWSER_LOG", "FAKE_BROWSER_NO_CDP", "XDG_CONFIG_HOME"];

/** Write the isolated user-global opt-in, then reload it. */
function configure(value = profile) {
	const file = path.join(root, "agent/extensions/pi-computer-use.json");
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify({ managed_browser_profile: value }));
	loadComputerUseConfig(root);
}

beforeEach(() => {
	saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
	for (const key of keys) delete process.env[key];
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cu-persistent-")));
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

	test.each(["persistent-first", "temporary-first"])("%s keeps each launch's ownership and cleanup independent", async (order) => {
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
	});

	test("another Pi process cannot share a live persistent profile", async () => {
		await testing.performLaunchBrowser({});
		const script = `import { loadComputerUseConfig } from ${JSON.stringify(new URL("../src/config.ts", import.meta.url).href)}; import { testing } from ${JSON.stringify(new URL("../src/bridge.ts", import.meta.url).href)}; loadComputerUseConfig(process.env.TEST_CWD); try { await testing.performLaunchBrowser({}); process.exitCode = 1; } catch (error) { if (!/locked/.test(error.message)) throw error; }`;
		const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: fileURLToPath(new URL("..", import.meta.url)), env: { ...process.env, TEST_CWD: root }, stdio: ["ignore", "ignore", "pipe"], timeout: 15000 });
		let stderr = "";
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
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

	test.each([".pi-computer-use.lock", "SingletonLock", "SingletonCookie", "SingletonSocket"])("refuses existing %s without removing it or starting a browser", async (name) => {
		const lock = path.join(profile, name);
		// Chromium's SingletonLock can be a dangling symlink; lstat, not exists, must detect it.
		if (name === "SingletonLock") fs.symlinkSync("synthetic-host-123", lock);
		else fs.mkdirSync(lock);
		await assert.rejects(testing.performLaunchBrowser({}), /locked|in use/);
		assert(fs.lstatSync(lock));
		assert(!fs.existsSync(process.env.FAKE_BROWSER_LOG));
	});

	test("failed synchronous spawn preserves the profile and releases only Pi's lease", async () => {
		await assert.rejects(testing.performLaunchBrowser({ url: "http://example.test/\0" }), { code: "ERR_INVALID_ARG_VALUE" });
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
		while (!fs.existsSync(process.env.FAKE_BROWSER_LOG) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
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
	for (const fields of [{ title: "Sign in" }, { url: "http://127.0.0.1/signin" }, { targets: [{ role: "textbox", name: "Password" }] }]) {
		const result = testing.browserObservationResult({ ...page, ...fields }, "cdp:synthetic", 0, "navigate_browser");
		assert.equal(result.details.warning, "authentication_required");
		assert.match(result.content[0].text, /Ask the user before any sign-in/);
	}
	const normal = testing.browserObservationResult({ ...page, snapshotId: "synthetic-normal" }, "cdp:synthetic", 0, "observe_ui");
	assert.equal(normal.details.warning, undefined);
});
