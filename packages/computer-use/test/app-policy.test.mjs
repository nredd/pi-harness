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

	// Env is additive: a repo can set it (.envrc, launch script), so it can add ids but never remove one.
	writeFileSync(userFile, "{}");
	process.env[ENV] = "com.example.A, com.example.B";
	assert.deepEqual(list(), [...DEFAULT_BLOCKED_APPS, "com.example.A", "com.example.B"], "env is unioned into the defaults");
	writeFileSync(userFile, JSON.stringify({ blocked_apps: ["com.example.Vault"] }));
	assert.deepEqual(list(), ["com.example.Vault", "com.example.A", "com.example.B"], "env is unioned into the user file list");
	for (const blank of ["", "   ", ",", " , ,"]) {
		process.env[ENV] = blank;
		assert.deepEqual(list(), ["com.example.Vault"], `blank env ${JSON.stringify(blank)} is unset`);
	}
	// `none` is not an opt-out: it is just an (inert) id.
	writeFileSync(userFile, "{}");
	for (const none of ["none", " None "]) {
		process.env[ENV] = none;
		assert.ok(list().length >= DEFAULT_BLOCKED_APPS.length, `env ${none} must not shrink the list`);
		assert.ok(isBlockedBundleId("com.apple.Terminal"), `env ${none} must not opt out`);
	}
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
	assert.match(swift, /keyboardTargetRefusalPid\(frontmostPid: NSWorkspace\.shared\.frontmostApplication\?\.processIdentifier, focusedPid: systemFocusedPid()/, "helper must refuse blocked frontmost or focused apps for keys");
	assert.match(swift, /case "type", "key":\n\t\t\ttry refuseBlockedKeyboard\(\)/, "helper must refuse blocked apps before typing or keys");
	assert.equal(swift.match(/try refuseBlockedKeyboardAfterFocus\(preserveFocus: preserveFocus\)/g)?.length, 3, "act typeText, paste and keypress must refuse a blocked focused app under HID delivery");
	assert.match(swift, /try refuseBlockedKeyboardAfterFocus\(preserveFocus: preserveFocus\)\n\t+let restored = try withTemporaryClipboard/, "paste must refuse a blocked focused app before it touches the clipboard");
	const pasteBody = swift.match(/let restored = try withTemporaryClipboard\(text\) \{[\s\S]*?\n\t\t\t\}\n/)?.[0] ?? "";
	const recheckAt = pasteBody.indexOf("try refuseBlockedKeyboardTarget(blocked: blockedBundleIdList(request))");
	assert.ok(recheckAt > 0 && recheckAt < pasteBody.indexOf("try postKeyCode("), "paste must re-check the focused app after the clipboard snapshot and right before cmd+v");
	assert.match(swift, /return try withRestoredClipboard\(write: \{[\s\S]*?\}, restore: restore, body: body\)/, "the temporary clipboard must restore on every exit, including a refusal in the body");
	const restoreHelper = swift.match(/func withRestoredClipboard[\s\S]*?\n\}\n/)?.[0] ?? "";
	assert.match(restoreHelper, /catch \{\n\t\t_ = restore\(\)\n\t\tthrow error/, "a throwing write or body restores the clipboard before rethrowing");
	assert.match(swift, /if delivery == "hid" \{ try refuseBlockedKeyboardAfterFocus\(preserveFocus: false\) \} else \{ focusTargetForPhysicalInput\(\) \}\n\t+_ = AXUIElementSetAttributeValue\(element, kAXFocusedAttribute/, "web setText must wait for focus and refuse a blocked focused app before its HID keys");
	const keyboardHelper = swift.match(/func refuseBlockedKeyboardAfterFocus[\s\S]*?\n\t\t\}\n/)?.[0] ?? "";
	const keyboardOrder = ['guard delivery == "hid"', "focusTargetForPhysicalInput()", "try requireTargetFocus(pid: pid)", "try refuseBlockedKeyboardTarget("].map((needle) => keyboardHelper.indexOf(needle));
	assert.ok(keyboardOrder.every((i) => i >= 0) && keyboardOrder.every((i, n) => n === 0 || i > keyboardOrder[n - 1]), "act keyboard focus must settle on the target before the blocked-app check");
	assert.match(keyboardHelper, /if !preserveFocus \{[\s\S]*?requireTargetFocus[\s\S]*?\}\n\t\t\ttry refuseBlockedKeyboardTarget/, "preserveFocus skips only the focus wait, never the blocked-app check");
	assert.match(swift, /Every vertex, not just the endpoints[\s\S]*?try refuseBlockedPoints\(vertices/, "desktop_input drag must check every path vertex");
	const coordinates = swift.match(/func executeCoordinates[\s\S]*?\n\t\tfunc refreshElement/)?.[0] ?? "";
	const focusAt = coordinates.indexOf("focusTargetForPhysicalInput()");
	const preflightAt = coordinates.indexOf("try preflight(point)");
	assert.ok(focusAt > 0 && preflightAt > focusAt, "executeCoordinates must focus, then preflight");
	assert.ok(!coordinates.slice(0, preflightAt).includes("refuseBlocked"), "act coordinate input must not refuse before focus and preflight");
	for (const post of ["postMouseClick(", "postMouseMove(", "postScrollWheel(", "postMouseDrag("]) {
		const postAt = coordinates.indexOf(`try ${post}`);
		const refuseAt = coordinates.lastIndexOf("try refuseBlockedBeforePost(", postAt);
		assert.ok(refuseAt > preflightAt && postAt > refuseAt, `act coordinate input must refuse a blocked app after preflight and immediately before ${post}`);
		assert.ok(!coordinates.slice(refuseAt, postAt).includes("case "), `the pointer check must sit in the ${post} case`);
	}
	assert.match(coordinates, /try refuseBlockedBeforePost\(points\)/, "act drag must check every vertex");
	assert.match(swift, /guard actPointerRefusalApplies\(delivery: delivery\) else \{ return \}\n\t\t\ttry refuseBlockedPoints\(/, "act pointer refusal is gated on HID delivery");
	assert.match(swift, /private func refuseBlockedPoints[\s\S]*?let windows = onScreenWindowList\(\)[\s\S]*?for \(index, point\) in points\.enumerated\(\)[\s\S]*?windows: windows, axHitTest: hitIndices\.contains\(index\)/, "one window list per action, AX hit test at endpoints only");
	assert.match(swift, /try refuseBlockedPoints\(vertices, blocked: blocked\)/, "desktop_input drag must share the per-action window list");
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
		outline: { ref: "w", wireRef: "w", role: "AXWindow", subrole: "AXStandardWindow", title: "Main", label: "", value: "", actions: [], rect: { x: 0, y: 0, w: 300, h: 200 }, children: [{ ref: "b", wireRef: "b", role: "AXButton", subrole: "", title: "Go", label: "Go", value: "", actions: ["AXPress", "AXShowMenu"], rect: { x: 10, y: 10, w: 50, h: 20 }, children: [] }, { ref: "t", wireRef: "t", role: "AXTextField", subrole: "", title: "Name", label: "Name", value: "abc", actions: [], canSetValue: true, isTextInput: true, rect: { x: 10, y: 40, w: 50, h: 20 }, children: [] }] },
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
	const textRef = text(observed).match(/(@e\d+) textfield/)?.[1] ?? text(observed).match(/(@e\d+) [a-z]*[Tt]ext[a-z]*field/)?.[1];
	const buttonRef = text(observed).match(/(@e\d+) button/)[1];
	assert.ok(textRef, `text field ref missing from:\n${text(observed)}`);
	await assert.rejects(() => call(executeAct, press), blocked("app_blocked"));
	// The new actions go through the same target resolution, so they cannot reach a blocked app either.
	for (const action of [{ action: "secondaryAction", ref: buttonRef, name: "AXShowMenu" }, { action: "selectText", ref: textRef, start: 0, length: 1 }, { action: "paste", ref: textRef, text: "x" }]) {
		await assert.rejects(() => call(executeAct, { stateId, actions: [action] }), blocked("app_blocked"), `${action.action} must refuse a blocked target`);
	}
	assert.equal(calls.act, 0, "blocked act_ui must not deliver input");
	const readCalls = [];
	currentPlatformBackend.readText = async (request) => {
		readCalls.push(request);
		return { text: "secret", offset: 0, limit: 10, totalChars: 6, hasMore: false };
	};
	await assert.rejects(() => call(executeReadText, { stateId, ref: text(observed).match(/(@e\d+) button/)[1] }), blocked("app_blocked"));
	assert.equal(readCalls.length, 0, "blocked read_text must not reach the helper");
	assert.ok((await call(executeFind, { app: "Safe" })).details.windows.every((w) => w.blocked), "find_roots reflects the new list");

	// The env var cannot opt out: `none` leaves Terminal blocked.
	process.env[ENV] = "none";
	await assert.rejects(() => call(executeObserve, { root: refOf("Terminal") }), blocked("app_blocked"));
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
	const { effectiveBlockedBundleIds } = await import("../src/config.ts");
	const expected = effectiveBlockedBundleIds();
	assert.ok(SYSTEM_AGENTS.every((id) => expected.includes(id)) && expected.includes("com.example.Vault"));
	const sent = [];
	macosHelper.command = async (name, args) => {
		sent.push({ name, args });
		throw new HelperCommandError("app_blocked: 'Vault' is blocked", "app_blocked");
	};
	for (const params of [{ action: "activateApp", app: "Vault" }, { action: "typeText", text: "x" }, { action: "click", x: 1, y: 2 }]) {
		await assert.rejects(() => executeDesktopInput("d", params), (error) => error.code === "app_blocked");
	}
	assert.equal(sent.length, 3);
	for (const { args } of sent) assert.deepEqual(args.blockedBundleIds, expected);

	// desktop_screenshot sends it too, so the helper can exclude the blocked apps from the capture.
	sent.length = 0;
	const { executeDesktopScreenshot } = await import("../src/desktop.ts");
	macosHelper.command = async (name, args) => {
		sent.push({ name, args });
		return { displays: [{ index: 0, isMain: true, frame: { x: 0, y: 0, w: 100, h: 100 } }], display: 0, frame: { x: 0, y: 0, w: 100, h: 100 }, image: { jpegBase64: "", width: 100, height: 100 } };
	};
	await executeDesktopScreenshot("d", {}, undefined, undefined, undefined);
	assert.equal(sent[0].name, "captureDisplay");
	assert.deepEqual(sent[0].args.blockedBundleIds, expected);
});

test("macOS act and actBatch send the effective blocklist so coordinate input is checked in the helper", async ({ onTestFinished }) => {
	const { macosHelper } = await import("../src/platform/macos/helper.ts");
	const { macosBackend } = await import("../src/platform/macos/backend.ts");
	const { loadComputerUseConfig } = await import("../src/config.ts");
	const command = macosHelper.command;
	onTestFinished(() => {
		macosHelper.command = command;
	});
	process.env[ENV] = "com.example.Vault";
	loadComputerUseConfig(mkdtempSync(path.join(os.tmpdir(), "cu-policy-")));
	const sent = [];
	macosHelper.command = async (name, args) => {
		sent.push({ name, args });
		return { outcome: "worked", steps: [] };
	};
	const request = { lookId: "l1", pid: 1, target: { kind: "coordinates", x: 1, y: 2 }, policy: "foreground", action: "click", params: { delivery: "hid" } };
	await macosBackend.act(request);
	await macosBackend.actBatch([request, request]);
	const { effectiveBlockedBundleIds } = await import("../src/config.ts");
	const expected = effectiveBlockedBundleIds();
	assert.ok(expected.includes("com.example.Vault"));
	assert.equal(sent[0].name, "act");
	assert.deepEqual(sent[0].args.blockedBundleIds, expected);
	assert.equal(sent[1].name, "actBatch");
	assert.equal(sent[1].args.actions.length, 2);
	for (const action of sent[1].args.actions) assert.deepEqual(action.blockedBundleIds, expected);
});
