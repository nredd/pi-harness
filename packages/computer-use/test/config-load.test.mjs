// `src/config.ts` file, env and `blocked_apps` loading: every boolean spelling, bad shapes and missing files (nredd/pi-harness#703, Refs #645).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as nodeFs from "node:fs";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import {
	ALWAYS_BLOCKED_BUNDLE_IDS,
	DEFAULT_BLOCKED_APPS,
	effectiveBlockedBundleIds,
	getComputerUseConfig,
	getLoadedComputerUseConfig,
	isBlockedBundleId,
	isBrowserUseEnabled,
	isHeadlessMode,
	loadComputerUseConfig,
} from "../src/config.ts";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal();
	return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

const ENV_KEYS = ["BROWSER_USE", "HEADLESS", "CURSOR_OVERLAY", "DESKTOP_CONTROL", "ACTIVITY_GLOW", "MANAGED_BROWSER", "BLOCKED_APPS"].map((name) => `PI_COMPUTER_USE_${name}`);
let saved;
let savedAgentDir;
let root;
const cwd = () => path.join(root, "project");

const writeJson = (file, value) => {
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
};
const userFile = () => path.join(root, "agent", "extensions", "pi-computer-use.json");
const projectFile = () => path.join(cwd(), ".pi", "computer-use.json");

beforeEach(() => {
	saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
	for (const key of ENV_KEYS) delete process.env[key];
	savedAgentDir = process.env.PI_CODING_AGENT_DIR;
	root = mkdtempSync(path.join(os.tmpdir(), "cu-config-"));
	mkdirSync(cwd(), { recursive: true });
	process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
});

afterEach(() => {
	for (const key of ENV_KEYS) {
		if (saved[key] === undefined) delete process.env[key];
		else process.env[key] = saved[key];
	}
	if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
	rmSync(root, { recursive: true, force: true });
	loadComputerUseConfig(path.join(os.tmpdir(), "cu-config-reset"));
});

describe("defaults", () => {
	test("no files and no env give the documented defaults", () => {
		const loaded = loadComputerUseConfig(cwd());
		assert.deepEqual(loaded.config, { browser_use: true, headless: false, cursor_overlay: true, desktop_control: true, activity_glow: false, managed_browser: "chrome", blocked_apps: [...DEFAULT_BLOCKED_APPS] });
		assert.deepEqual(loaded.sources.map(({ path: p, exists }) => [p, exists]), [[userFile(), false], [projectFile(), false]]);
		assert.deepEqual(loaded.env, {});
		assert.deepEqual(loaded.blockedAppsErrors, []);
		assert.equal(getLoadedComputerUseConfig(), loaded);
		assert.equal(getComputerUseConfig(), loaded.config);
		assert.equal(isHeadlessMode(), false);
		assert.equal(isBrowserUseEnabled(), true);
	});
});

describe("boolean spellings", () => {
	const TRUE = [true, 1, "1", "true", "TRUE", " yes ", "on", "Enabled"];
	const FALSE = [false, 0, "0", "false", "No", "off", " OFF", "disabled"];
	const IGNORED = [2, -1, "maybe", "", null, [], {}, undefined];

	test.each([
		["file", (key, value) => writeJson(projectFile(), { [key]: value })],
		["wrapped file", (key, value) => writeJson(projectFile(), { computer_use: { [key]: value } })],
	])("%s: truthy and falsy spellings flip every flag", (_name, write) => {
		for (const key of ["browser_use", "headless", "cursor_overlay", "desktop_control", "activity_glow"]) {
			for (const value of TRUE) {
				write(key, value);
				assert.equal(loadComputerUseConfig(cwd()).config[key], true, `${key}=${JSON.stringify(value)}`);
			}
			for (const value of FALSE) {
				write(key, value);
				assert.equal(loadComputerUseConfig(cwd()).config[key], false, `${key}=${JSON.stringify(value)}`);
			}
		}
	});

	test("unrecognised values leave the default alone", () => {
		for (const value of IGNORED) {
			writeJson(projectFile(), { browser_use: value, headless: value, cursor_overlay: value, desktop_control: value, activity_glow: value });
			const { config } = loadComputerUseConfig(cwd());
			assert.deepEqual([config.browser_use, config.headless, config.cursor_overlay, config.desktop_control, config.activity_glow], [true, false, true, true, false], JSON.stringify(value));
		}
	});

	test("env spellings override files and are reported", () => {
		writeJson(projectFile(), { browser_use: true, headless: false, activity_glow: false, cursor_overlay: true, desktop_control: true });
		process.env.PI_COMPUTER_USE_BROWSER_USE = "off";
		process.env.PI_COMPUTER_USE_HEADLESS = "yes";
		process.env.PI_COMPUTER_USE_CURSOR_OVERLAY = "0";
		process.env.PI_COMPUTER_USE_DESKTOP_CONTROL = "false";
		process.env.PI_COMPUTER_USE_ACTIVITY_GLOW = "ENABLED";
		const loaded = loadComputerUseConfig(cwd());
		assert.deepEqual(loaded.env, { browser_use: false, headless: true, cursor_overlay: false, desktop_control: false, activity_glow: true });
		assert.deepEqual([loaded.config.browser_use, loaded.config.headless, loaded.config.cursor_overlay, loaded.config.desktop_control, loaded.config.activity_glow], [false, true, false, false, true]);
		assert.equal(isHeadlessMode(), true);
		assert.equal(isBrowserUseEnabled(), false);
		process.env.PI_COMPUTER_USE_HEADLESS = "perhaps";
		assert.equal("headless" in loadComputerUseConfig(cwd()).env, false, "an unparseable env value is ignored");
	});
});

describe("managed_browser", () => {
	test("file and env accept only the known browsers", () => {
		writeJson(projectFile(), { managed_browser: "helium" });
		assert.equal(loadComputerUseConfig(cwd()).config.managed_browser, "helium");
		writeJson(projectFile(), { managed_browser: "firefox" });
		assert.equal(loadComputerUseConfig(cwd()).config.managed_browser, "chrome");
		process.env.PI_COMPUTER_USE_MANAGED_BROWSER = "helium";
		assert.equal(loadComputerUseConfig(cwd()).config.managed_browser, "helium");
		process.env.PI_COMPUTER_USE_MANAGED_BROWSER = "safari";
		assert.equal(loadComputerUseConfig(cwd()).config.managed_browser, "chrome");
	});
});

describe("unreadable and oddly shaped files", () => {
	test("invalid JSON is a per-source error and the defaults stand", () => {
		writeJson(userFile(), "{ nope");
		const loaded = loadComputerUseConfig(cwd());
		assert.equal(loaded.sources[0].exists, true);
		assert.match(loaded.sources[0].error, /JSON/);
		assert.equal(loaded.sources[1].exists, false);
		assert.equal(loaded.config.headless, false);
	});

	test("a directory where the file should be is an error, not a crash", () => {
		mkdirSync(projectFile(), { recursive: true });
		const source = loadComputerUseConfig(cwd()).sources[1];
		assert.equal(source.exists, true);
		assert.match(source.error, /EISDIR|illegal operation/);
	});

	test("a non-Error thrown while reading is reported as text", () => {
		writeJson(projectFile(), {});
		nodeFs.readFileSync.mockImplementationOnce(() => {
			throw "disk on fire";
		});
		const source = loadComputerUseConfig(cwd()).sources[1];
		assert.deepEqual([source.exists, source.error], [true, "disk on fire"]);
	});

	test.each([["null", "null"], ["a number", "5"], ["a string", '"headless"'], ["an array root", "[true]"]])("%s root is ignored", (_name, body) => {
		writeJson(projectFile(), body);
		const loaded = loadComputerUseConfig(cwd());
		assert.equal(loaded.sources[1].error, undefined);
		assert.deepEqual(loaded.sources[1].values, {});
		assert.deepEqual(loaded.config.blocked_apps, [...DEFAULT_BLOCKED_APPS]);
	});

	test("a non-object `computer_use` wrapper falls back to the root keys", () => {
		writeJson(projectFile(), { computer_use: "x", headless: true });
		assert.equal(loadComputerUseConfig(cwd()).config.headless, true);
	});
});

describe("blocked_apps", () => {
	test("the user file replaces the defaults, trimming and de-duplicating", () => {
		writeJson(userFile(), { blocked_apps: [" com.example.a ", "com.example.a", "com.example.b"] });
		const loaded = loadComputerUseConfig(cwd());
		assert.deepEqual(loaded.config.blocked_apps, ["com.example.a", "com.example.b"]);
		assert.deepEqual(loaded.blockedAppsErrors, []);
		assert.equal(isBlockedBundleId("COM.EXAMPLE.B"), true, "case-insensitive");
		assert.equal(isBlockedBundleId("com.apple.Terminal"), false, "defaults were replaced");
		assert.equal(isBlockedBundleId(undefined), false);
		assert.equal(isBlockedBundleId(""), false);
	});

	test("a literal empty user list opts out of the defaults but not the system agents", () => {
		writeJson(userFile(), { computer_use: { blocked_apps: [] } });
		loadComputerUseConfig(cwd());
		assert.deepEqual(getComputerUseConfig().blocked_apps, []);
		assert.deepEqual(effectiveBlockedBundleIds(), [...ALWAYS_BLOCKED_BUNDLE_IDS]);
		assert.equal(isBlockedBundleId("com.apple.SecurityAgent"), true);
	});

	test("project file and env only ever add", () => {
		writeJson(userFile(), { blocked_apps: ["com.example.a"] });
		writeJson(projectFile(), { blocked_apps: ["com.example.p", "com.example.a"] });
		process.env.PI_COMPUTER_USE_BLOCKED_APPS = " com.example.e ,, com.example.p , ";
		const loaded = loadComputerUseConfig(cwd());
		assert.deepEqual(loaded.config.blocked_apps, ["com.example.a", "com.example.p", "com.example.e"]);
		assert.deepEqual(loaded.sources[1].blockedAppsAdd, ["com.example.p", "com.example.a"]);

		writeJson(projectFile(), { blocked_apps: [] });
		process.env.PI_COMPUTER_USE_BLOCKED_APPS = " , ";
		assert.deepEqual(loadComputerUseConfig(cwd()).config.blocked_apps, ["com.example.a"], "a blank env and an empty project list change nothing");
	});

	test.each([
		["not an array", "com.example.a", /blocked_apps must be an array of bundle id strings/],
		["null", null, /blocked_apps must be an array/],
		["one bad entry", ["com.example.a", 5], /blocked_apps has 1 invalid entry \(each must be a non-blank string\)/],
		["several bad entries", [" ", {}, "ok"], /blocked_apps has 2 invalid entries/],
	])("%s is reported and the current list stays", (_name, value, message) => {
		for (const [file, scope] of [[userFile(), "user"], [projectFile(), "project"]]) {
			writeJson(userFile(), {});
			writeJson(projectFile(), {});
			writeJson(file, { blocked_apps: value });
			const loaded = loadComputerUseConfig(cwd());
			assert.equal(loaded.blockedAppsErrors.length, 1, scope);
			assert.match(loaded.blockedAppsErrors[0], new RegExp(`^${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: `));
			assert.match(loaded.blockedAppsErrors[0], message);
			assert.match(loaded.blockedAppsErrors[0], /; keeping the current list$/);
			assert.deepEqual(loaded.config.blocked_apps, [...DEFAULT_BLOCKED_APPS], scope);
			assert.equal("blockedAppsError" in loaded.sources[scope === "user" ? 0 : 1], false, "the per-file error key is not leaked into sources");
		}
	});
});
