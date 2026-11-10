// Blocked apps (`app_blocked`) and locked sessions (`screen_locked`) fail closed (nredd/pi-harness#646).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "vitest";

const ENV = "PI_COMPUTER_USE_BLOCKED_APPS";
const SYSTEM_AGENTS = ["com.apple.SecurityAgent", "com.apple.loginwindow", "com.apple.coreservices.uiagent", "com.apple.ScreenSaver.Engine"];

afterEach(() => {
	delete process.env[ENV];
});

test("blocked_apps config: defaults, user JSON, env and the always-blocked system agents", async ({ onTestFinished }) => {
	const { DEFAULT_BLOCKED_APPS, ALWAYS_BLOCKED_BUNDLE_IDS, loadComputerUseConfig, isBlockedBundleId, effectiveBlockedBundleIds } = await import("../src/config.ts");
	assert.deepEqual([...ALWAYS_BLOCKED_BUNDLE_IDS], SYSTEM_AGENTS);
	const agentDir = mkdtempSync(path.join(os.tmpdir(), "cu-agent-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	onTestFinished(() => {
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
	});
	mkdirSync(path.join(agentDir, "extensions"));
	const userFile = path.join(agentDir, "extensions", "pi-computer-use.json");
	const cwd = mkdtempSync(path.join(os.tmpdir(), "cu-policy-"));
	const load = () => loadComputerUseConfig(cwd);
	const list = () => load().config.blocked_apps;

	assert.deepEqual(list(), [...DEFAULT_BLOCKED_APPS], "default list applies with no config");
	for (const id of ["com.apple.keychainaccess", "com.1password.1password", "com.apple.Terminal", "com.googlecode.iterm2"]) assert.ok(isBlockedBundleId(id), id);
	assert.ok(isBlockedBundleId("COM.APPLE.TERMINAL"), "match is case-insensitive");
	assert.ok(!isBlockedBundleId("com.apple.TextEdit") && !isBlockedBundleId(undefined));

	writeFileSync(userFile, JSON.stringify({ blocked_apps: ["com.example.Vault", " com.example.Vault "] }));
	assert.deepEqual(list(), ["com.example.Vault"], "user JSON list replaces the default, trimmed and deduplicated");
	assert.ok(isBlockedBundleId("com.example.vault") && !isBlockedBundleId("com.apple.Terminal"));

	process.env[ENV] = "com.example.A, com.example.B";
	assert.deepEqual(list(), ["com.example.A", "com.example.B"], "env overrides the user file");

	// Blank env is unset, never an opt-out; only `none` opts out.
	for (const blank of ["", "   ", ",", " , ,"]) {
		process.env[ENV] = blank;
		writeFileSync(userFile, "{}");
		assert.deepEqual(list(), [...DEFAULT_BLOCKED_APPS], `blank env ${JSON.stringify(blank)} keeps the defaults`);
	}
	process.env[ENV] = " None ";
	assert.deepEqual(list(), []);
	assert.ok(!isBlockedBundleId("com.apple.Terminal"));
	assert.deepEqual(effectiveBlockedBundleIds(), SYSTEM_AGENTS);
	delete process.env[ENV];

	// Only a literal [] in the USER file opts out.
	writeFileSync(userFile, JSON.stringify({ blocked_apps: [] }));
	assert.deepEqual(list(), []);
	assert.deepEqual(load().blockedAppsErrors, []);
	for (const id of SYSTEM_AGENTS) assert.ok(isBlockedBundleId(id), id);
	writeFileSync(userFile, "{}");
	loadComputerUseConfig(cwd);
});

test("blocked_apps: invalid entries are a config error that keeps the defaults", async ({ onTestFinished }) => {
	const { DEFAULT_BLOCKED_APPS, loadComputerUseConfig } = await import("../src/config.ts");
	const agentDir = mkdtempSync(path.join(os.tmpdir(), "cu-agent-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	onTestFinished(() => {
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
	});
	mkdirSync(path.join(agentDir, "extensions"));
	const userFile = path.join(agentDir, "extensions", "pi-computer-use.json");
	const cwd = mkdtempSync(path.join(os.tmpdir(), "cu-policy-"));
	for (const bad of [[{ id: "com.example.Vault" }], [123], [" "], [""], ["com.example.Vault", 7], "com.example.Vault", { a: 1 }]) {
		writeFileSync(userFile, JSON.stringify({ blocked_apps: bad }));
		const loaded = loadComputerUseConfig(cwd);
		assert.deepEqual(loaded.config.blocked_apps, [...DEFAULT_BLOCKED_APPS], `${JSON.stringify(bad)} keeps defaults`);
		assert.equal(loaded.blockedAppsErrors.length, 1, JSON.stringify(bad));
		assert.match(loaded.blockedAppsErrors[0], /blocked_apps/);
	}
	writeFileSync(userFile, "{}");
	loadComputerUseConfig(cwd);
});

test("project config can only add to blocked_apps, never remove", async ({ onTestFinished }) => {
	const { DEFAULT_BLOCKED_APPS, loadComputerUseConfig, isBlockedBundleId } = await import("../src/config.ts");
	const agentDir = mkdtempSync(path.join(os.tmpdir(), "cu-agent-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	onTestFinished(() => {
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
	});
	const cwd = mkdtempSync(path.join(os.tmpdir(), "cu-policy-"));
	mkdirSync(path.join(cwd, ".pi"));
	const projectFile = path.join(cwd, ".pi", "computer-use.json");
	const list = () => loadComputerUseConfig(cwd).config.blocked_apps;

	writeFileSync(projectFile, JSON.stringify({ blocked_apps: [] }));
	assert.deepEqual(list(), [...DEFAULT_BLOCKED_APPS], "project [] cannot opt out");
	writeFileSync(projectFile, JSON.stringify({ blocked_apps: ["com.example.Vault", "com.apple.Terminal"] }));
	assert.deepEqual(list(), [...DEFAULT_BLOCKED_APPS, "com.example.Vault"], "project ids are unioned");
	assert.ok(isBlockedBundleId("com.example.vault"));
	writeFileSync(projectFile, JSON.stringify({ blocked_apps: [123] }));
	const loaded = loadComputerUseConfig(cwd);
	assert.deepEqual(loaded.config.blocked_apps, [...DEFAULT_BLOCKED_APPS]);
	assert.equal(loaded.blockedAppsErrors.length, 1, "invalid project entries are surfaced");

	// Over a user opt-out, a project can only add its own ids.
	mkdirSync(path.join(agentDir, "extensions"));
	writeFileSync(path.join(agentDir, "extensions", "pi-computer-use.json"), JSON.stringify({ blocked_apps: [] }));
	writeFileSync(projectFile, JSON.stringify({ blocked_apps: ["com.example.Vault"] }));
	assert.deepEqual(list(), ["com.example.Vault"]);
	writeFileSync(path.join(agentDir, "extensions", "pi-computer-use.json"), "{}");
	loadComputerUseConfig(cwd);
});

test("Swift system-agent list mirrors the TypeScript list", async () => {
	const swift = readFileSync(new URL("../native/macos/bridge.swift", import.meta.url), "utf8");
	const body = swift.match(/let alwaysBlockedBundleIds: \[String\] = \[([\s\S]*?)\]/)?.[1] ?? "";
	assert.deepEqual([...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]), SYSTEM_AGENTS);
	assert.match(swift, /lockedSessionRefusal\(cmd: cmd, session: CGSessionCopyCurrentDictionary\(\)/, "helper must refuse UI commands while locked");
	assert.match(swift, /guard let app, isBlockedBundleId\(app\.bundleIdentifier, blocked: blocked\) else \{ return \}/, "helper must refuse blocked apps for keys and pointer input");
	assert.match(swift, /SCContentFilter\(display: display, excludingApplications: excluded, exceptingWindows: \[\]\)/, "display capture must exclude blocked apps");
	assert.match(swift, /AXUIElementCopyElementAtPosition\(AXUIElementCreateSystemWide\(\)/, "pointer input must also hit-test through accessibility");
	assert.match(swift, /return \("screen_locked", "screen_locked:/);
	assert.match(swift, /code: "app_blocked"/);
});

test("act_ui, observe_ui and find_roots enforce blocked_apps at the platform backend seam", async ({ onTestFinished }) => {
	const { currentPlatformBackend } = await import("../src/platform/index.ts");
	const { executeFind, executeObserve, executeAct, executeReadText } = await import("../src/bridge.ts");
	const { parseLookResponse } = await import("../src/outline.ts");
	const original = { ...currentPlatformBackend };
	onTestFinished(() => {
		Object.assign(currentPlatformBackend, original);
	});

	const window = (bundleId, pid) => ({
		kind: "window",
		rootRef: `ax:w${pid}`,
		windowRef: `ax:w${pid}`,
		windowId: pid * 100,
		pid,
		appName: bundleId.split(".").at(-1),
		bundleId,
		title: "Main",
		zOrder: pid,
		framePoints: { x: 0, y: 0, w: 300, h: 200 },
		scaleFactor: 1,
		isOnscreen: true,
		isFocused: pid === 2,
		isMinimized: false,
		isMain: true,
		isModal: false,
	});
	const roots = [window("com.example.Safe", 1), window("com.apple.Terminal", 2), window("com.apple.SecurityAgent", 3)];
	const calls = { observe: 0, act: 0 };
	const look = () => parseLookResponse({
		lookId: `look${++calls.observe}`,
		capturedAt: 1,
		window: { windowId: 100, rootRef: "ax:w1", kind: "window", framePoints: roots[0].framePoints, scaleFactor: 1, isModal: false, role: "AXWindow", subrole: "AXStandardWindow", metadata: {} },
		outline: { ref: "w", wireRef: "w", role: "AXWindow", subrole: "AXStandardWindow", title: "Main", label: "", value: "", actions: [], rect: { x: 0, y: 0, w: 300, h: 200 }, children: [{ ref: "b", wireRef: "b", role: "AXButton", subrole: "", title: "Go", label: "Go", value: "", actions: ["AXPress"], rect: { x: 10, y: 10, w: 50, h: 20 }, children: [] }] },
		timings: { captureMs: 0, describeMs: 0, readTextMs: 0 },
	});
	Object.assign(currentPlatformBackend, {
		ensureReady: async () => ({ permissionStatus: { accessibility: true, screenRecording: true }, lastPermissionCheckAt: Date.now() }),
		listApps: async () => roots.map((r) => ({ appName: r.appName, bundleId: r.bundleId, pid: r.pid, isFrontmost: r.isFocused })),
		listRoots: async (query) => (query?.pid ? roots.filter((r) => r.pid === query.pid) : roots),
		getFrontmost: async () => ({ appName: "Terminal", bundleId: "com.apple.Terminal", pid: 2, windowId: 200 }),
		observe: async () => look(),
		act: async () => {
			calls.act += 1;
			return { outcome: "worked", performed: { delivery: "pid" } };
		},
		actBatch: async () => {
			calls.act += 1;
			return { outcome: "worked", performed: { delivery: "pid", transaction: true, actionCount: 1 }, steps: [{ outcome: "worked" }] };
		},
	});
	const ctx = { cwd: mkdtempSync(path.join(os.tmpdir(), "cu-policy-")), hasUI: false, ui: { notify() {} }, sessionManager: { getBranch: () => [] } };
	const call = (fn, params) => fn("t", params, undefined, undefined, ctx);
	const text = (r) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
	const blocked = (code) => (error) => error.code === code && error.message.startsWith(`${code}:`);

	// find_roots marks blocked roots; allowed ones stay unmarked.
	const found = await call(executeFind, {});
	assert.equal(found.details.windows.length, 3);
	assert.deepEqual(found.details.windows.map((w) => [w.app, w.blocked]).sort(), [["SecurityAgent", true], ["Terminal", true], ["Safe", false]].sort());
	assert.match(text(found), /Terminal .*blocked\)/);
	assert.ok(!/Safe[^\n]*blocked/.test(text(found)), "allowed root must not be flagged");

	// observe_ui of a blocked root fails with app_blocked before any native look.
	const refOf = (app) => found.details.windows.find((w) => w.app === app).windowRef;
	await assert.rejects(() => call(executeObserve, { root: refOf("Terminal") }), blocked("app_blocked"));
	await assert.rejects(() => call(executeObserve, { root: refOf("SecurityAgent") }), blocked("app_blocked"));
	assert.equal(calls.observe, 0, "a blocked target never reaches the helper");
	// ...including the implicit frontmost target.
	await assert.rejects(() => call(executeObserve, {}), blocked("app_blocked"));
	assert.equal(calls.observe, 0);

	// act_ui re-checks the target, so a blocklist that grows after observe_ui stops delivery.
	const observed = await call(executeObserve, { root: refOf("Safe"), mode: "semantic" });
	assert.equal(calls.observe, 1);
	const stateId = text(observed).match(/stateId ([0-9a-f-]{36})/)[1];
	const press = { stateId, actions: [{ action: "press", ref: text(observed).match(/(@e\d+) button/)[1] }] };
	process.env[ENV] = "com.example.Safe";
	await assert.rejects(() => call(executeAct, press), blocked("app_blocked"));
	assert.equal(calls.act, 0, "blocked act_ui must not deliver input");
	const readCalls = [];
	currentPlatformBackend.readText = async (request) => {
		readCalls.push(request);
		return { text: "secret", offset: 0, limit: 10, totalChars: 6, hasMore: false };
	};
	await assert.rejects(() => call(executeReadText, { stateId, ref: text(observed).match(/(@e\d+) button/)[1] }), blocked("app_blocked"));
	assert.equal(readCalls.length, 0, "blocked read_text must not reach the helper");
	assert.ok((await call(executeFind, { app: "Safe" })).details.windows.every((w) => w.blocked), "find_roots reflects the new list");

	// Opt-out: `none` allows Terminal again, system agents stay blocked.
	process.env[ENV] = "none";
	await call(executeObserve, { root: refOf("Terminal"), mode: "semantic" });
	await assert.rejects(() => call(executeObserve, { root: refOf("SecurityAgent") }), blocked("app_blocked"));
});

test.skipIf(process.platform !== "darwin")("desktop_input sends the effective blocklist and surfaces the helper's coded refusals", async ({ onTestFinished }) => {
	const { macosHelper } = await import("../src/platform/macos/helper.ts");
	const { HelperCommandError } = await import("../src/platform/macos/helper.ts");
	const { loadComputerUseConfig } = await import("../src/config.ts");
	const { executeDesktopInput } = await import("../src/desktop.ts");
	const command = macosHelper.command;
	onTestFinished(() => {
		macosHelper.command = command;
	});
	process.env[ENV] = "com.example.Vault";
	loadComputerUseConfig(mkdtempSync(path.join(os.tmpdir(), "cu-policy-")));
	const sent = [];
	macosHelper.command = async (name, args) => {
		sent.push({ name, args });
		throw new HelperCommandError("app_blocked: 'Vault' is blocked", "app_blocked");
	};
	for (const params of [{ action: "activateApp", app: "Vault" }, { action: "typeText", text: "x" }, { action: "click", x: 1, y: 2 }]) {
		await assert.rejects(() => executeDesktopInput("d", params), (error) => error.code === "app_blocked");
	}
	assert.equal(sent.length, 3);
	for (const { args } of sent) assert.deepEqual(args.blockedBundleIds, [...SYSTEM_AGENTS, "com.example.Vault"]);

	// desktop_screenshot sends it too, so the helper can exclude the blocked apps from the capture.
	sent.length = 0;
	const { executeDesktopScreenshot } = await import("../src/desktop.ts");
	macosHelper.command = async (name, args) => {
		sent.push({ name, args });
		return { displays: [{ index: 0, isMain: true, frame: { x: 0, y: 0, w: 100, h: 100 } }], display: 0, frame: { x: 0, y: 0, w: 100, h: 100 }, image: { jpegBase64: "", width: 100, height: 100 } };
	};
	await executeDesktopScreenshot("d", {}, undefined, undefined, undefined);
	assert.equal(sent[0].name, "captureDisplay");
	assert.deepEqual(sent[0].args.blockedBundleIds, [...SYSTEM_AGENTS, "com.example.Vault"]);
});
