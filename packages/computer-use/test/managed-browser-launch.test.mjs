// Managed browser executable discovery, the Helium profile and a CDP port that never opens (nredd/pi-harness#712, Refs #645).
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { shutdownComputerUseSession, testing } from "../src/bridge.ts";
import { loadComputerUseConfig } from "../src/config.ts";

const FAKE_BROWSER = fileURLToPath(new URL("./fixtures/fake-browser.mjs", import.meta.url));
const ENV = ["PI_COMPUTER_USE_CHROME_EXECUTABLE", "PI_COMPUTER_USE_HELIUM_EXECUTABLE", "PI_COMPUTER_USE_MANAGED_BROWSER", "PI_COMPUTER_USE_CDP_PORT", "LOCALAPPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "FAKE_BROWSER_NO_CDP", "FAKE_BROWSER_LOG"];

/** Pretend to run on another platform until `vi.restoreAllMocks`. */
const platform = (value) => vi.spyOn(process, "platform", "get").mockReturnValue(value);

describe("managed browser executable discovery", () => {
	const { managedBrowserExecutableCandidates: candidates } = testing;
	let bin;

	beforeEach(() => {
		bin = path.join(os.tmpdir(), "pi-cu-bin");
		for (const name of ENV) vi.stubEnv(name, "");
		vi.stubEnv("PATH", "");
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	test("an override names the only candidate, resolved to an absolute path", () => {
		vi.stubEnv("PI_COMPUTER_USE_CHROME_EXECUTABLE", "rel/chrome");
		vi.stubEnv("PI_COMPUTER_USE_HELIUM_EXECUTABLE", "/opt/h/helium");
		assert.deepEqual(candidates("chrome"), [path.resolve("rel/chrome")]);
		assert.deepEqual(candidates("helium"), ["/opt/h/helium"]);
		vi.stubEnv("PI_COMPUTER_USE_CHROME_EXECUTABLE", "   ");
		assert.notDeepEqual(candidates("chrome"), [path.resolve("   ")], "a blank override is ignored");
	});

	test("macOS looks in /Applications and ~/Applications", () => {
		platform("darwin");
		assert.deepEqual(candidates("chrome"), ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", path.join(os.homedir(), "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome")]);
		assert.deepEqual(candidates("helium"), ["/Applications/Helium.app/Contents/MacOS/Helium", path.join(os.homedir(), "Applications", "Helium.app", "Contents", "MacOS", "Helium")]);
	});

	test("Linux lists the system locations, then PATH entries without duplicates", () => {
		platform("linux");
		vi.stubEnv("PATH", [bin, "", "/usr/bin"].join(path.delimiter));
		assert.deepEqual(candidates("chrome"), [
			"/usr/bin/google-chrome",
			"/usr/bin/google-chrome-stable",
			"/usr/bin/chromium",
			"/usr/bin/chromium-browser",
			"/snap/bin/chromium",
			...["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"].map((name) => path.join(bin, name)),
		]);
		assert.deepEqual(candidates("helium"), [
			"/usr/bin/helium",
			"/usr/bin/helium-browser",
			"/opt/helium/chrome",
			path.join(os.homedir(), ".local", "helium", "chrome"),
			...["helium", "helium-browser"].map((name) => path.join(bin, name)),
		]);
	});

	test("Windows builds its locations from the environment and skips unset variables", () => {
		platform("win32");
		assert.deepEqual(candidates("chrome"), [], "nothing is guessed without LOCALAPPDATA or PROGRAMFILES");
		assert.deepEqual(candidates("helium"), []);
		vi.stubEnv("LOCALAPPDATA", "/local");
		vi.stubEnv("PROGRAMFILES", "/pf");
		vi.stubEnv("PROGRAMFILES(X86)", "/pf86");
		vi.stubEnv("PATH", bin);
		assert.deepEqual(candidates("chrome"), [
			path.join("/local", "Google", "Chrome", "Application", "chrome.exe"),
			path.join("/pf", "Google", "Chrome", "Application", "chrome.exe"),
			path.join("/pf86", "Google", "Chrome", "Application", "chrome.exe"),
			path.join(bin, "chrome.exe"),
		]);
		assert.deepEqual(candidates("helium"), [path.join("/local", "Helium", "Application", "helium.exe"), path.join("/pf", "Helium", "Application", "helium.exe"), path.join(bin, "helium.exe")]);
	});

	test("an unset PATH yields only the platform locations", () => {
		platform("linux");
		vi.stubEnv("PATH", undefined);
		assert.equal(candidates("chrome").length, 5);
	});
});

describe.skipIf(process.platform === "win32")("launch_browser with the managed browser", () => {
	let scratch;
	let tmp;

	beforeEach(() => {
		scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cu-launch-"));
		tmp = path.join(scratch, "tmp");
		fs.mkdirSync(tmp);
		for (const name of ENV) vi.stubEnv(name, "");
		vi.stubEnv("TMPDIR", tmp);
		vi.stubEnv("FAKE_BROWSER_LOG", path.join(scratch, "launch.json"));
	});
	afterEach(async () => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
		loadComputerUseConfig(scratch);
		await shutdownComputerUseSession();
		fs.rmSync(scratch, { recursive: true, force: true });
	});

	/** Select the managed browser the way the environment override does, then reload the config. */
	const useHelium = () => {
		vi.stubEnv("PI_COMPUTER_USE_MANAGED_BROWSER", "helium");
		loadComputerUseConfig(scratch);
	};

	test("a missing browser names the override variable to set", async () => {
		platform("win32");
		vi.stubEnv("PATH", "");
		await assert.rejects(testing.performLaunchBrowser({}), (error) => error.message === "chrome executable was not found. Set PI_COMPUTER_USE_CHROME_EXECUTABLE to its absolute path.");
		useHelium();
		await assert.rejects(testing.performLaunchBrowser({}), (error) => error.message === "helium executable was not found. Set PI_COMPUTER_USE_HELIUM_EXECUTABLE to its absolute path.");
		assert.deepEqual(fs.readdirSync(tmp), [], "no profile dir was created");
	});

	test("an override that is missing or not executable is reported with its path", async () => {
		const missing = path.join(scratch, "no-such-chrome");
		vi.stubEnv("PI_COMPUTER_USE_CHROME_EXECUTABLE", missing);
		await assert.rejects(testing.performLaunchBrowser({}), (error) => error.message === `chrome executable from PI_COMPUTER_USE_CHROME_EXECUTABLE was not found or is not executable: ${missing}.`);
		const plain = path.join(scratch, "plain");
		fs.writeFileSync(plain, "#!/bin/sh\n", { mode: 0o644 });
		useHelium();
		vi.stubEnv("PI_COMPUTER_USE_HELIUM_EXECUTABLE", plain);
		await assert.rejects(testing.performLaunchBrowser({}), (error) => error.message === `helium executable from PI_COMPUTER_USE_HELIUM_EXECUTABLE was not found or is not executable: ${plain}.`);
	});

	test("a relative url is refused before anything starts", async () => {
		await assert.rejects(testing.performLaunchBrowser({ url: "file:///etc/passwd" }), /launch_browser\.url must be an absolute HTTP\(S\) URL\./);
		assert.deepEqual(fs.readdirSync(tmp), []);
	});

	test("the Helium browser launches with its own profile prefix and the requested url", async () => {
		useHelium();
		vi.stubEnv("PI_COMPUTER_USE_HELIUM_EXECUTABLE", FAKE_BROWSER);
		const result = await testing.performLaunchBrowser({ url: "https://example.test/start" });
		assert.match(result.content[0].text, /^launch_browser completed for @r\d+/);
		const { profile } = JSON.parse(fs.readFileSync(path.join(scratch, "launch.json"), "utf8"));
		assert.match(path.basename(profile), /^pi-helium-cdp-/);
		await shutdownComputerUseSession();
		assert.equal(fs.existsSync(profile), false);
	});

	test("a browser that never serves CDP fails the launch, stops the browser and restores the port", async () => {
		vi.stubEnv("PI_COMPUTER_USE_CHROME_EXECUTABLE", FAKE_BROWSER);
		vi.stubEnv("FAKE_BROWSER_NO_CDP", "1");
		// Start virtual deadline acceleration only after the real child records its launch.
		// Otherwise a loaded host can time out and kill it before launch.json ever exists.
		let skew = 0;
		const realNow = Date.now.bind(Date);
		vi.spyOn(Date, "now").mockImplementation(() => realNow() + (fs.existsSync(path.join(scratch, "launch.json")) ? (skew += 6_000) : 0));
		Date.now();
		assert.equal(skew, 0, "timeout fixture clock must not advance before child startup acknowledgement");
		await assert.rejects(testing.performLaunchBrowser({}), /^Error: Managed browser did not expose CDP on port \d+ within 15000ms\.$/);
		assert.equal(process.env.PI_COMPUTER_USE_CDP_PORT, "", "the managed port is not left configured");
		const { profile } = JSON.parse(fs.readFileSync(path.join(scratch, "launch.json"), "utf8"));
		assert.equal(fs.existsSync(profile), false, "the profile dir of the failed launch is removed");
	});
});

describe.skipIf(process.platform === "win32")("managed browser launch edge cases", () => {
	let scratch;
	let tmp;

	beforeEach(() => {
		scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cu-launch-edge-"));
		tmp = path.join(scratch, "tmp");
		fs.mkdirSync(tmp);
		for (const name of ENV) vi.stubEnv(name, "");
		vi.stubEnv("TMPDIR", tmp);
		vi.stubEnv("FAKE_BROWSER_LOG", path.join(scratch, "launch.json"));
		vi.stubEnv("PI_COMPUTER_USE_CHROME_EXECUTABLE", FAKE_BROWSER);
	});
	afterEach(async () => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
		await shutdownComputerUseSession();
		fs.chmodSync(tmp, 0o755);
		fs.rmSync(scratch, { recursive: true, force: true });
	});

	test("a non-ok discovery answer is retried until the browser is ready", async () => {
		const realFetch = globalThis.fetch;
		let probes = 0;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			probes += 1;
			return probes === 1 && String(input).endsWith("/json/version") ? new Response("starting", { status: 503 }) : await realFetch(input, init);
		});
		const result = await testing.performLaunchBrowser({});
		assert.ok(probes >= 2, `probed ${probes} times`);
		assert.match(result.content[0].text, /^launch_browser completed/);
	});

	test("an abort that lands while the browser is being started is honoured before the first CDP probe", async () => {
		const abort = new AbortController();
		const createServer = net.createServer.bind(net);
		// Port allocation happens after the lifecycle step's own abort check, so this abort is first seen by the readiness wait.
		vi.spyOn(net, "createServer").mockImplementation((...args) => {
			const server = createServer(...args);
			server.once("listening", () => abort.abort());
			return server;
		});
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		await assert.rejects(testing.performLaunchBrowser({}, abort.signal), /^Error: Browser launch was aborted\.$/);
		assert.equal(fetchSpy.mock.calls.filter(([input]) => String(input).endsWith("/json/version")).length, 0, "no probe was sent");
		assert.deepEqual(fs.readdirSync(tmp), [], "the profile dir was removed once the browser stopped");
		assert.equal(process.env.PI_COMPUTER_USE_CDP_PORT, "");
	});

	test("a profile that stayed behind does not confuse the lookup for a later browser", async () => {
		await testing.performLaunchBrowser({});
		const { profile: stuck } = JSON.parse(fs.readFileSync(path.join(scratch, "launch.json"), "utf8"));
		fs.chmodSync(tmp, 0o555);
		await shutdownComputerUseSession();
		assert.ok(fs.existsSync(stuck), "removal unexpectedly succeeded under a read-only parent (root?)");
		fs.chmodSync(tmp, 0o755);
		await testing.performLaunchBrowser({});
		const { profile } = JSON.parse(fs.readFileSync(path.join(scratch, "launch.json"), "utf8"));
		await shutdownComputerUseSession();
		assert.equal(fs.existsSync(profile), false, "the later browser's profile is found past the stale entry and removed");
		testing.removeProfileDirsOnExit();
		assert.equal(fs.existsSync(stuck), false);
	});
});
