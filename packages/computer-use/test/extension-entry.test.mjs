// `extensions/computer-use.ts` registration, `/computer-use` status and lifecycle hooks against a recording ExtensionAPI (nredd/pi-harness#703, Refs #645).
// The host platform is a seam (`process.platform` is redefined per case) so the darwin-only arms run on every OS.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRecordingPi } from "@nredd/pi-test-lib/pi";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import * as bridge from "../src/bridge.ts";
import { DEFAULT_BLOCKED_APPS } from "../src/config.ts";
import extension, { COMPUTER_USE_TOOLS, DESKTOP_TOOLS } from "../extensions/computer-use.ts";

vi.mock("../src/bridge.ts", async (importOriginal) => ({
	...(await importOriginal()),
	ensureComputerUseSetup: vi.fn(async () => undefined),
	reconstructStateFromBranch: vi.fn(),
	setComputerUseActivity: vi.fn(async () => undefined),
	shutdownComputerUseSession: vi.fn(async () => undefined),
}));

const realPlatform = Object.getOwnPropertyDescriptor(process, "platform");
const setPlatform = (value) => Object.defineProperty(process, "platform", { ...realPlatform, value });

const ENV_KEYS = Object.keys(process.env).filter((key) => key.startsWith("PI_COMPUTER_USE_"));
let savedEnv;
let savedAgentDir;
let root;

/** A context that records `ui.notify`; `cwd` is the temp project directory. */
function fakeCtx(over = {}) {
	const notes = [];
	return { cwd: path.join(root, "project"), hasUI: true, ui: { notify: (message, level) => notes.push({ message, level }) }, notes, ...over };
}

const writeProjectConfig = (value) => {
	mkdirSync(path.join(root, "project", ".pi"), { recursive: true });
	writeFileSync(path.join(root, "project", ".pi", "computer-use.json"), typeof value === "string" ? value : JSON.stringify(value));
};
const writeUserConfig = (value) => {
	mkdirSync(path.join(root, "agent", "extensions"), { recursive: true });
	writeFileSync(path.join(root, "agent", "extensions", "pi-computer-use.json"), JSON.stringify(value));
};

beforeEach(() => {
	savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
	for (const key of ENV_KEYS) delete process.env[key];
	savedAgentDir = process.env.PI_CODING_AGENT_DIR;
	root = mkdtempSync(path.join(os.tmpdir(), "cu-ext-"));
	mkdirSync(path.join(root, "project"), { recursive: true });
	process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
	vi.clearAllMocks();
	// `clearAllMocks` keeps implementations: re-apply the defaults so a `mockRejectedValue` cannot leak into the next test.
	for (const name of ["ensureComputerUseSetup", "setComputerUseActivity", "shutdownComputerUseSession"]) bridge[name].mockReset().mockResolvedValue(undefined);
	bridge.reconstructStateFromBranch.mockReset();
});

afterEach(() => {
	Object.defineProperty(process, "platform", realPlatform);
	for (const key of Object.keys(process.env)) if (key.startsWith("PI_COMPUTER_USE_")) delete process.env[key];
	for (const [key, value] of Object.entries(savedEnv)) if (value !== undefined) process.env[key] = value;
	if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
	rmSync(root, { recursive: true, force: true });
});

describe("registration", () => {
	test("non-darwin hosts register only the app and browser tools", () => {
		setPlatform("linux");
		const pi = createRecordingPi();
		extension(pi.pi);
		assert.deepEqual([...pi.tools.values()].map((tool) => tool.name), COMPUTER_USE_TOOLS.map((tool) => tool.name));
		assert.equal(pi.tools.size, 11);
		assert.ok([...pi.commands.keys()].includes("computer-use"));
		assert.deepEqual([...pi.handlers.keys()].sort(), ["agent_end", "session_shutdown", "session_start", "tool_execution_start"]);
	});

	test("darwin additionally registers the desktop tools", () => {
		setPlatform("darwin");
		const pi = createRecordingPi();
		extension(pi.pi);
		assert.deepEqual([...pi.tools.values()].map((tool) => tool.name).slice(-2), ["desktop_screenshot", "desktop_input"]);
		assert.deepEqual(DESKTOP_TOOLS.map((tool) => tool.name), ["desktop_screenshot", "desktop_input"]);
		assert.equal(pi.tools.size, 13);
		for (const tool of pi.tools.values()) assert.equal(tool.parameters.type, "object", `${tool.name} root schema`);
	});
});

describe("/computer-use", () => {
	const run = async (ctx = fakeCtx()) => {
		const pi = createRecordingPi();
		extension(pi.pi);
		await pi.commands.get("computer-use").handler("", ctx);
		assert.equal(ctx.notes.length, 1);
		assert.equal(ctx.notes[0].level, "info");
		return ctx.notes[0].message;
	};

	test("defaults: everything enabled but the glow, default blocklist, no sources", async () => {
		const text = await run();
		assert.equal(
			text,
			[
				"pi-computer-use configuration",
				"browser_use: enabled",
				"managed_browser: chrome",
				"headless: disabled",
				"cursor_overlay: enabled",
				"activity_glow: disabled",
				`blocked_apps: ${DEFAULT_BLOCKED_APPS.join(", ")} (system authentication agents are always blocked)`,
				"",
				"Sources:",
				`- ${path.join(root, "agent", "extensions", "pi-computer-use.json")}: not found`,
				`- ${path.join(root, "project", ".pi", "computer-use.json")}: not found`,
				"- env overrides: none",
			].join("\n"),
		);
	});

	test("user file flips every flag, empties the blocklist and the env override is listed", async () => {
		writeUserConfig({ computer_use: { browser_use: "off", headless: "on", cursor_overlay: 0, activity_glow: "enabled", managed_browser: "helium", blocked_apps: [] } });
		process.env.PI_COMPUTER_USE_BROWSER_USE = "1";
		const text = await run();
		assert.match(text, /^browser_use: enabled$/m, "env wins over the user file");
		assert.match(text, /^managed_browser: helium$/m);
		assert.match(text, /^headless: enabled$/m);
		assert.match(text, /^cursor_overlay: disabled$/m);
		assert.match(text, /^activity_glow: enabled$/m);
		assert.match(text, /^blocked_apps: \(none\) \(system authentication agents/m);
		assert.match(text, /pi-computer-use\.json: loaded$/m);
		assert.match(text, /^- env overrides: browser_use$/m);
	});

	test("a disabled browser_use is reported", async () => {
		writeUserConfig({ browser_use: false });
		assert.match(await run(), /^browser_use: disabled$/m);
	});

	test("rejected blocked_apps and an unreadable project file are reported", async () => {
		writeUserConfig({ blocked_apps: "com.example.vault" });
		writeProjectConfig("{ not json");
		const text = await run();
		assert.match(text, /^blocked_apps error: .*pi-computer-use\.json: blocked_apps must be an array of bundle id strings; keeping the current list$/m);
		assert.match(text, /computer-use\.json: error: .+$/m);
		assert.match(text, new RegExp(`^blocked_apps: ${DEFAULT_BLOCKED_APPS[0].replaceAll(".", "\\.")}`, "m"), "defaults stay in force");
	});
});

describe("session_start", () => {
	test("headless of a UI-less session loads config and restores state without setup", async () => {
		writeProjectConfig({ headless: true });
		const pi = createRecordingPi();
		extension(pi.pi);
		const ctx = fakeCtx({ hasUI: false });
		await pi.handlers.get("session_start")[0]({}, ctx);
		assert.deepEqual(bridge.reconstructStateFromBranch.mock.calls, [[ctx]]);
		assert.equal(bridge.ensureComputerUseSetup.mock.calls.length, 0);
		await pi.commands.get("computer-use").handler("", ctx);
		assert.match(ctx.notes[0].message, /^headless: enabled$/m);
	});

	test("UI sessions run setup and surface its failure as a warning", async () => {
		const pi = createRecordingPi();
		extension(pi.pi);
		const ok = fakeCtx();
		await pi.handlers.get("session_start")[0]({}, ok);
		assert.deepEqual(bridge.ensureComputerUseSetup.mock.calls, [[ok]]);
		assert.deepEqual(ok.notes, []);

		bridge.ensureComputerUseSetup.mockRejectedValueOnce(new Error("helper missing"));
		const failed = fakeCtx();
		await pi.handlers.get("session_start")[0]({}, failed);
		assert.deepEqual(failed.notes, [{ message: "helper missing", level: "warning" }]);

		bridge.ensureComputerUseSetup.mockRejectedValueOnce("plain string");
		const odd = fakeCtx();
		await pi.handlers.get("session_start")[0]({}, odd);
		assert.deepEqual(odd.notes, [{ message: "plain string", level: "warning" }]);
	});
});

describe("activity glow lifecycle", () => {
	const start = async (pi, over = {}) => {
		await pi.handlers.get("session_start")[0]({}, fakeCtx({ hasUI: false, ...over }));
	};
	const glowCalls = () => bridge.setComputerUseActivity.mock.calls.map(([active]) => active);

	test("a computer-use tool on darwin with the glow enabled turns it on once, agent_end turns it off", async () => {
		setPlatform("darwin");
		writeProjectConfig({ activity_glow: true });
		const pi = createRecordingPi();
		extension(pi.pi);
		await start(pi);
		await pi.handlers.get("agent_end")[0]({});
		assert.deepEqual(glowCalls(), [], "agent_end before any glow is a no-op");

		await pi.handlers.get("tool_execution_start")[0]({ toolName: "observe_ui" });
		assert.deepEqual(glowCalls(), [true]);
		await pi.handlers.get("agent_end")[0]({});
		await pi.handlers.get("agent_end")[0]({});
		assert.deepEqual(glowCalls(), [true, false], "the second agent_end is a no-op");
	});

	test.each([
		["off darwin", "linux", { activity_glow: true }, "observe_ui"],
		["headless", "darwin", { activity_glow: true, headless: true }, "observe_ui"],
		["glow disabled", "darwin", {}, "observe_ui"],
		["a foreign tool", "darwin", { activity_glow: true }, "bash"],
		["a desktop tool", "darwin", { activity_glow: true }, "desktop_input"],
	])("%s never starts the glow", async (_name, platform, config, toolName) => {
		setPlatform(platform);
		writeProjectConfig(config);
		const pi = createRecordingPi();
		extension(pi.pi);
		await start(pi);
		await pi.handlers.get("tool_execution_start")[0]({ toolName });
		await pi.handlers.get("agent_end")[0]({});
		assert.deepEqual(glowCalls(), []);
	});

	test("helper failures while toggling the glow are swallowed", async () => {
		setPlatform("darwin");
		writeProjectConfig({ activity_glow: true });
		bridge.setComputerUseActivity.mockRejectedValue(new Error("helper gone"));
		const pi = createRecordingPi();
		extension(pi.pi);
		await start(pi);
		await pi.handlers.get("tool_execution_start")[0]({ toolName: "find_roots" });
		await pi.handlers.get("agent_end")[0]({});
		await pi.handlers.get("agent_end")[0]({});
		assert.deepEqual(glowCalls(), [true, false], "the flag is cleared even though the off call failed");
	});

	test("session_shutdown always clears the glow and releases the session", async () => {
		setPlatform("darwin");
		writeProjectConfig({ activity_glow: true });
		const pi = createRecordingPi();
		extension(pi.pi);
		await start(pi);
		await pi.handlers.get("tool_execution_start")[0]({ toolName: "act_ui" });
		await pi.handlers.get("session_shutdown")[0]({});
		assert.deepEqual(glowCalls(), [true, false]);
		assert.equal(bridge.shutdownComputerUseSession.mock.calls.length, 1);
		await pi.handlers.get("agent_end")[0]({});
		assert.deepEqual(glowCalls(), [true, false], "shutdown reset the active flag");
	});

	test("session_shutdown still releases the session when the glow call fails", async () => {
		bridge.setComputerUseActivity.mockRejectedValueOnce(new Error("helper gone"));
		const pi = createRecordingPi();
		extension(pi.pi);
		await pi.handlers.get("session_shutdown")[0]({});
		assert.equal(bridge.shutdownComputerUseSession.mock.calls.length, 1);
	});
});
