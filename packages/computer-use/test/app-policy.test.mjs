// Blocked apps (`app_blocked`) and locked sessions (`screen_locked`) fail closed (nredd/pi-harness#646).
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeTestTempDir } from "@nredd/pi-test-lib/temp-dir";
import { afterEach, test, vi } from "vitest";
import { wireButton, wireNode } from "./support/fake-desktop.mjs";

const ENV = "PI_COMPUTER_USE_BLOCKED_APPS";
const SYSTEM_AGENTS = [
	"com.apple.SecurityAgent",
	"com.apple.loginwindow",
	"com.apple.coreservices.uiagent",
	"com.apple.ScreenSaver.Engine",
];

afterEach(() => {
	delete process.env[ENV];
});

test("blocked_apps config: defaults, user JSON, env and the always-blocked system agents", async ({
	onTestFinished,
}) => {
	const { DEFAULT_BLOCKED_APPS, ALWAYS_BLOCKED_BUNDLE_IDS, loadComputerUseConfig, isBlockedBundleId } = await import(
		"../src/config.ts"
	);
	assert.deepEqual([...ALWAYS_BLOCKED_BUNDLE_IDS], SYSTEM_AGENTS);
	assert.deepEqual(
		[...DEFAULT_BLOCKED_APPS],
		[
			"com.apple.keychainaccess",
			"com.apple.Passwords",
			"com.1password.1password",
			"com.1password.1password7",
			"com.agilebits.onepassword7",
			"com.agilebits.onepassword-osx-helper",
			"com.bitwarden.desktop",
			"com.lastpass.LastPass",
			"com.dashlane.dashlanephonefinal",
			"org.keepassxc.keepassxc",
			"com.apple.Terminal",
			"com.googlecode.iterm2",
			"net.kovidgoyal.kitty",
			"com.mitchellh.ghostty",
			"dev.warp.Warp-Stable",
			"co.zeit.hyper",
			"org.alacritty",
			"com.github.wez.wezterm",
		],
	);
	const agentDir = makeTestTempDir("cu-agent-", onTestFinished);
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	onTestFinished(() => {
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
	});
	mkdirSync(path.join(agentDir, "extensions"));
	const userFile = path.join(agentDir, "extensions", "pi-computer-use.json");
	const cwd = makeTestTempDir("cu-policy-", onTestFinished);
	const load = () => loadComputerUseConfig(cwd, "macos");
	const list = () => load().config.blocked_apps;

	assert.deepEqual(list(), [...DEFAULT_BLOCKED_APPS], "default list applies with no config");
	for (const id of [
		"com.apple.keychainaccess",
		"com.1password.1password",
		"com.apple.Terminal",
		"com.googlecode.iterm2",
	])
		assert.ok(isBlockedBundleId(id), id);
	assert.ok(isBlockedBundleId("COM.APPLE.TERMINAL"), "match is case-insensitive");
	assert.ok(!isBlockedBundleId("com.apple.TextEdit") && !isBlockedBundleId(undefined));

	writeFileSync(userFile, JSON.stringify({ blocked_apps: ["com.example.Vault", " com.example.Vault "] }));
	assert.deepEqual(list(), ["com.example.Vault"], "user JSON list replaces the default, trimmed and deduplicated");
	assert.ok(isBlockedBundleId("com.example.vault") && !isBlockedBundleId("com.apple.Terminal"));

	// Env is additive: a repo can set it (.envrc, launch script), so it can add ids but never remove one.
	writeFileSync(userFile, "{}");
	process.env[ENV] = "com.example.A, com.example.B";
	assert.deepEqual(
		list(),
		[...DEFAULT_BLOCKED_APPS, "com.example.A", "com.example.B"],
		"env is unioned into the defaults",
	);
	writeFileSync(userFile, JSON.stringify({ blocked_apps: ["com.example.Vault"] }));
	assert.deepEqual(
		list(),
		["com.example.Vault", "com.example.A", "com.example.B"],
		"env is unioned into the user file list",
	);
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
	const agentDir = makeTestTempDir("cu-agent-", onTestFinished);
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	onTestFinished(() => {
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
	});
	mkdirSync(path.join(agentDir, "extensions"));
	const userFile = path.join(agentDir, "extensions", "pi-computer-use.json");
	const cwd = makeTestTempDir("cu-policy-", onTestFinished);
	for (const bad of [
		[{ id: "com.example.Vault" }],
		[123],
		[" "],
		[""],
		["com.example.Vault", 7],
		"com.example.Vault",
		{ a: 1 },
	]) {
		writeFileSync(userFile, JSON.stringify({ blocked_apps: bad }));
		const loaded = loadComputerUseConfig(cwd, "macos");
		assert.deepEqual(loaded.config.blocked_apps, [...DEFAULT_BLOCKED_APPS], `${JSON.stringify(bad)} keeps defaults`);
		assert.equal(loaded.blockedAppsErrors.length, 1, JSON.stringify(bad));
		assert.match(loaded.blockedAppsErrors[0], /blocked_apps/);
	}
	writeFileSync(userFile, "{}");
	loadComputerUseConfig(cwd);
});

test("project config can only add to blocked_apps, never remove", async ({ onTestFinished }) => {
	const { DEFAULT_BLOCKED_APPS, loadComputerUseConfig, isBlockedBundleId } = await import("../src/config.ts");
	const agentDir = makeTestTempDir("cu-agent-", onTestFinished);
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	onTestFinished(() => {
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
	});
	const cwd = makeTestTempDir("cu-policy-", onTestFinished);
	mkdirSync(path.join(cwd, ".pi"));
	const projectFile = path.join(cwd, ".pi", "computer-use.json");
	const list = () => loadComputerUseConfig(cwd, "macos").config.blocked_apps;

	writeFileSync(projectFile, JSON.stringify({ blocked_apps: [] }));
	assert.deepEqual(list(), [...DEFAULT_BLOCKED_APPS], "project [] cannot opt out");
	writeFileSync(projectFile, JSON.stringify({ blocked_apps: ["com.example.Vault", "com.apple.Terminal"] }));
	assert.deepEqual(list(), [...DEFAULT_BLOCKED_APPS, "com.example.Vault"], "project ids are unioned");
	assert.ok(isBlockedBundleId("com.example.vault"));
	writeFileSync(projectFile, JSON.stringify({ blocked_apps: [123] }));
	const loaded = loadComputerUseConfig(cwd, "macos");
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

function stripSwiftComments(source) {
	// Skip quoted text; keep newlines so the initializer's argument boundaries stay intact.
	const tokens = /"(?:\\[^\n]|[^"\\\n])*"|\/\/[^\n]*|\/\*/g;
	const blockMarkers = /\/\*|\*\//g;
	let cursor = 0;
	let result = "";
	for (let token = tokens.exec(source); token; token = tokens.exec(source)) {
		if (token[0].startsWith('"')) continue;
		if (token[0] === "/*") {
			blockMarkers.lastIndex = tokens.lastIndex;
			let depth = 1;
			while (depth) {
				const marker = blockMarkers.exec(source);
				assert.ok(marker, "unterminated Swift block comment");
				depth += marker[0] === "/*" ? 1 : -1;
			}
			tokens.lastIndex = blockMarkers.lastIndex;
		}
		result += source.slice(cursor, token.index) + source.slice(token.index, tokens.lastIndex).replace(/[^\n]/g, " ");
		cursor = tokens.lastIndex;
	}
	return result + source.slice(cursor);
}

function assertLiveActionBindings(swift) {
	const factory = stripSwiftComments(swift).match(/^\tfunc actionWorld\(\) -> ActWorld \{[\s\S]*?^\t\}/m)?.[0];
	const args = factory?.match(/^\t\treturn ActWorld\(\n([\s\S]*?)^\t\t\)$/m)?.[1];
	assert.ok(args, "expected the live actionWorld ActWorld initializer");
	for (const [binding, helper] of [
		["requireTargetFocus", "requireTargetFocus(pid:)"],
		["refuseBlockedKeyboard", "refuseBlockedKeyboardTarget(blocked:)"],
		["refuseBlockedPoints", "refuseBlockedPoints(_:blocked:)"],
		["snapshotClipboard", "snapshotClipboard"],
		["pasteKeyCode", "{ pasteKeyCode(layoutData: currentKeyboardInputSource().layoutData) }"],
	]) {
		const value = args.match(
			new RegExp(`^\\t{3}(?:(?:requireTargetFocus|snapshotClipboard): [^,\\n]+, )?${binding}: ([^,\\n]+)`, "m"),
		)?.[1];
		assert.equal(value?.trimEnd(), helper, `live actionWorld must bind ${binding} to ${helper}`);
	}
}

test("Swift live binding check rejects helpers left only in comments", () => {
	const original = "refuseBlockedKeyboard: refuseBlockedKeyboardTarget(blocked:),";
	const fixture = [
		"\tfunc actionWorld() -> ActWorld {",
		"\t\treturn ActWorld(",
		"\t\t\trequireTargetFocus: requireTargetFocus(pid:),",
		`\t\t\t${original}`,
		"\t\t\trefuseBlockedPoints: refuseBlockedPoints(_:blocked:),",
		"\t\t\tsnapshotClipboard: snapshotClipboard,",
		"\t\t\tpasteKeyCode: { pasteKeyCode(layoutData: currentKeyboardInputSource().layoutData) }",
		"\t\t)",
		"\t}",
	].join("\n");
	assertLiveActionBindings(fixture);
	for (const comment of [`// ${original}`, `/*\n\t\t\t${original}\n\t\t\t*/`]) {
		const mutant = fixture.replace(original, `${comment}\n\t\t\trefuseBlockedKeyboard: { _ in },`);
		assert.throws(() => assertLiveActionBindings(mutant), /live actionWorld must bind refuseBlockedKeyboard to/);
	}
});

test("Swift system-agent list mirrors the TypeScript list", async () => {
	const swift = readFileSync(new URL("../native/macos/bridge.swift", import.meta.url), "utf8");
	const body = swift.match(/let alwaysBlockedBundleIds: \[String\] = \[([\s\S]*?)\]/)?.[1] ?? "";
	assert.deepEqual(
		[...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]),
		SYSTEM_AGENTS,
	);
	assert.match(
		swift,
		/readSession: @escaping \(\) -> \[String: Any\]\? = \{ CGSessionCopyCurrentDictionary\(\) as\? \[String: Any\] \}/,
		"helper must read the actual session by default",
	);
	assert.match(
		swift,
		/lockedSessionRefusal\(cmd: cmd, session: readSession\(\)\)/,
		"helper must refuse UI commands while locked",
	);
	assert.match(
		swift,
		/keyboardTargetRefusalPid\(frontmostPid: NSWorkspace\.shared\.frontmostApplication\?\.processIdentifier, focusedPid: systemFocusedPid()/,
		"helper must refuse blocked frontmost or focused apps for keys",
	);
	assert.match(
		swift,
		/case "type", "key":\n\t\t\ttry refuseBlockedKeyboard\(\)/,
		"helper must refuse blocked apps before typing or keys",
	);
	assert.equal(
		swift.match(/try refuseBlockedKeyboardAfterFocus\(preserveFocus: preserveFocus\)/g)?.length,
		3,
		"act typeText, paste and keypress must refuse a blocked focused app under HID delivery",
	);
	assert.match(
		swift,
		/try refuseBlockedKeyboardAfterFocus\(preserveFocus: preserveFocus\)\n\t+let clipboard = world\.snapshotClipboard/,
		"paste must refuse a blocked focused app before it touches the clipboard",
	);
	const pasteBody =
		swift.match(
			/let restored = try withRestoredClipboard\(write: clipboard\.write, restore: clipboard\.restore\) \{[\s\S]*?\n\t\t\t\}\n/,
		)?.[0] ?? "";
	const recheckAt = pasteBody.indexOf("try world.refuseBlockedKeyboard(blockedBundleIdList(request))");
	const lookupAt = pasteBody.indexOf("world.pasteKeyCode()");
	const postAt = pasteBody.indexOf("try world.postKeyCode(");
	assertLiveActionBindings(swift);
	assert.ok(
		lookupAt > 0 && recheckAt > lookupAt && postAt > recheckAt,
		"paste must look up the layout key first and re-check the focused app immediately before cmd+v",
	);
	assert.ok(
		!/(?:currentKeyboardInputSource|pasteKeyCode)\(/.test(pasteBody.slice(recheckAt, postAt)),
		"nothing slow may sit between the last blocked-app check and the post",
	);
	assert.match(
		swift,
		/Keep the pasted text off Universal Clipboard[^\n]*\n\t+pasteboard\.prepareForNewContents\(with: \.currentHostOnly\)/,
		"the temporary paste item must stay off Universal Clipboard",
	);
	assert.match(
		swift,
		/else \{ return false \}\n\t+\/\/ Always host-only[^\n]*\n\t+pasteboard\.prepareForNewContents\(with: \.currentHostOnly\)/,
		"the restore must be host-only so a host-only secret is never republished as syncable",
	);
	const restoreHelper = swift.match(/func withRestoredClipboard[\s\S]*?\n\}\n/)?.[0] ?? "";
	assert.match(
		restoreHelper,
		/catch \{\n\t\t_ = restore\(\)\n\t\tthrow error/,
		"a throwing write or body restores the clipboard before rethrowing",
	);
	assert.match(
		swift,
		/if delivery == "hid" \{ try refuseBlockedKeyboardAfterFocus\(preserveFocus: false\) \} else \{ focusTargetForPhysicalInput\(\) \}\n\t+_ = world\.setAttribute\(element, kAXFocusedAttribute/,
		"web setText must wait for focus and refuse a blocked focused app before its HID keys",
	);
	const keyboardHelper = swift.match(/func refuseBlockedKeyboardAfterFocus[\s\S]*?\n\t\t\}\n/)?.[0] ?? "";
	const keyboardOrder = [
		'guard delivery == "hid"',
		"focusTargetForPhysicalInput()",
		"try world.requireTargetFocus(pid)",
		"try world.refuseBlockedKeyboard(",
	].map((needle) => keyboardHelper.indexOf(needle));
	assert.ok(
		keyboardOrder.every((i) => i >= 0) && keyboardOrder.every((i, n) => n === 0 || i > keyboardOrder[n - 1]),
		"act keyboard focus must settle on the target before the blocked-app check",
	);
	assert.match(
		keyboardHelper,
		/if !preserveFocus \{[\s\S]*?requireTargetFocus[\s\S]*?\}\n\t\t\ttry world\.refuseBlockedKeyboard/,
		"preserveFocus skips only the focus wait, never the blocked-app check",
	);
	assert.match(
		swift,
		/Every vertex, not just the endpoints[\s\S]*?try refuseBlockedPoints\(vertices/,
		"desktop_input drag must check every path vertex",
	);
	const coordinates = swift.match(/func executeCoordinates[\s\S]*?\n\t\tfunc refreshElement/)?.[0] ?? "";
	const focusAt = coordinates.indexOf("focusTargetForPhysicalInput()");
	const preflightAt = coordinates.indexOf("try preflight(point)");
	assert.ok(focusAt > 0 && preflightAt > focusAt, "executeCoordinates must focus, then preflight");
	assert.ok(
		!coordinates.slice(0, preflightAt).includes("refuseBlocked"),
		"act coordinate input must not refuse before focus and preflight",
	);
	for (const post of ["postMouseClick(", "postMouseMove(", "postScrollWheel(", "postMouseDrag("]) {
		const postAt = coordinates.indexOf(`try world.${post}`);
		const refuseAt = coordinates.lastIndexOf("try refuseBlockedBeforePost(", postAt);
		assert.ok(
			refuseAt > preflightAt && postAt > refuseAt,
			`act coordinate input must refuse a blocked app after preflight and immediately before ${post}`,
		);
		assert.ok(!coordinates.slice(refuseAt, postAt).includes("case "), `the pointer check must sit in the ${post} case`);
	}
	assert.match(coordinates, /try refuseBlockedBeforePost\(points\)/, "act drag must check every vertex");
	assert.match(
		swift,
		/guard actPointerRefusalApplies\(delivery: delivery\) else \{ return \}\n\t\t\ttry world\.refuseBlockedPoints\(/,
		"act pointer refusal is gated on HID delivery",
	);
	assert.match(
		swift,
		/private func refuseBlockedPoints[\s\S]*?let windows = onScreenWindowList\(\)[\s\S]*?for \(index, point\) in points\.enumerated\(\)[\s\S]*?windows: windows, axHitTest: hitIndices\.contains\(index\)/,
		"one window list per action, AX hit test at endpoints only",
	);
	assert.match(
		swift,
		/try refuseBlockedPoints\(vertices, blocked: blocked\)/,
		"desktop_input drag must share the per-action window list",
	);
	assert.match(
		swift,
		/SCContentFilter\(display: display, excludingApplications: excluded, exceptingWindows: \[\]\)/,
		"display capture must exclude blocked apps",
	);
	assert.match(
		swift,
		/AXUIElementCopyElementAtPosition\(AXUIElementCreateSystemWide\(\)/,
		"pointer input must also hit-test through accessibility",
	);
	assert.match(swift, /return \("screen_locked", "screen_locked:/);
	assert.match(swift, /code: "app_blocked"/);
});

test("act_ui, observe_ui and find_roots enforce blocked_apps at the platform backend seam", async ({
	onTestFinished,
}) => {
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
	const look = () =>
		parseLookResponse({
			lookId: `look${++calls.observe}`,
			capturedAt: 1,
			window: {
				windowId: 100,
				rootRef: "ax:w1",
				kind: "window",
				framePoints: roots[0].framePoints,
				scaleFactor: 1,
				isModal: false,
				role: "AXWindow",
				subrole: "AXStandardWindow",
				metadata: {},
			},
			outline: {
				ref: "w",
				wireRef: "w",
				role: "AXWindow",
				subrole: "AXStandardWindow",
				title: "Main",
				label: "",
				value: "",
				actions: [],
				rect: { x: 0, y: 0, w: 300, h: 200 },
				children: [
					{
						ref: "b",
						wireRef: "b",
						role: "AXButton",
						subrole: "",
						title: "Go",
						label: "Go",
						value: "",
						actions: ["AXPress", "AXShowMenu"],
						rect: { x: 10, y: 10, w: 50, h: 20 },
						children: [],
					},
					{
						ref: "t",
						wireRef: "t",
						role: "AXTextField",
						subrole: "",
						title: "Name",
						label: "Name",
						value: "abc",
						actions: [],
						canSetValue: true,
						isTextInput: true,
						rect: { x: 10, y: 40, w: 50, h: 20 },
						children: [],
					},
				],
			},
			timings: { captureMs: 0, describeMs: 0, readTextMs: 0 },
		});
	Object.assign(currentPlatformBackend, {
		name: "macos",
		ensureReady: async () => ({
			permissionStatus: { accessibility: true, screenRecording: true },
			lastPermissionCheckAt: Date.now(),
		}),
		listApps: async () =>
			roots.map((r) => ({ appName: r.appName, bundleId: r.bundleId, pid: r.pid, isFrontmost: r.isFocused })),
		listRoots: async (query) => (query?.pid ? roots.filter((r) => r.pid === query.pid) : roots),
		getFrontmost: async () => ({ appName: "Terminal", bundleId: "com.apple.Terminal", pid: 2, windowId: 200 }),
		observe: async () => look(),
		act: async () => {
			calls.act += 1;
			return { outcome: "worked", performed: { delivery: "pid" } };
		},
		actBatch: async () => {
			calls.act += 1;
			return {
				outcome: "worked",
				performed: { delivery: "pid", transaction: true, actionCount: 1 },
				steps: [{ outcome: "worked" }],
			};
		},
	});
	const ctx = {
		cwd: makeTestTempDir("cu-policy-", onTestFinished),
		hasUI: false,
		ui: { notify() {} },
		sessionManager: { getBranch: () => [] },
	};
	const call = (fn, params) => fn("t", params, undefined, undefined, ctx);
	const text = (r) =>
		r.content
			.filter((c) => c.type === "text")
			.map((c) => c.text)
			.join("\n");
	const blocked = (code) => (error) => error.code === code && error.message.startsWith(`${code}:`);

	// find_roots marks blocked roots; allowed ones stay unmarked.
	const found = await call(executeFind, {});
	assert.equal(found.details.windows.length, 3);
	assert.deepEqual(
		found.details.windows.map((w) => [w.app, w.blocked]).sort(),
		[
			["SecurityAgent", true],
			["Terminal", true],
			["Safe", false],
		].sort(),
	);
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
	const textRef =
		text(observed).match(/(@e\d+) textfield/)?.[1] ?? text(observed).match(/(@e\d+) [a-z]*[Tt]ext[a-z]*field/)?.[1];
	const buttonRef = text(observed).match(/(@e\d+) button/)[1];
	assert.ok(textRef, `text field ref missing from:\n${text(observed)}`);
	await assert.rejects(() => call(executeAct, press), blocked("app_blocked"));
	// The new actions go through the same target resolution, so they cannot reach a blocked app either. Pinned to a
	// darwin backend so the assertion holds on every host; elsewhere the platform gate refuses them first.
	const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
	const withPlatform = async (platform, fn) => {
		Object.defineProperty(process, "platform", { ...originalPlatform, value: platform });
		try {
			await fn();
		} finally {
			Object.defineProperty(process, "platform", originalPlatform);
		}
	};
	const newActions = [
		{ action: "secondaryAction", ref: buttonRef, name: "AXShowMenu" },
		{ action: "selectText", ref: textRef, start: 0, length: 1 },
		{ action: "paste", ref: textRef, text: "x" },
	];
	await withPlatform("darwin", async () => {
		for (const action of newActions) {
			await assert.rejects(
				() => call(executeAct, { stateId, actions: [action] }),
				blocked("app_blocked"),
				`${action.action} must refuse a blocked target`,
			);
		}
	});
	// On an allowed target, a non-darwin backend has no implementation: coded unsupported_command.
	delete process.env[ENV];
	await withPlatform("linux", async () => {
		for (const action of newActions) {
			await assert.rejects(
				() => call(executeAct, { stateId, actions: [action] }),
				(error) =>
					error.code === "unsupported_command" &&
					new RegExp(`${action.action} is not supported on linux`).test(error.message),
				`${action.action} must be unsupported_command on linux`,
			);
		}
	});
	process.env[ENV] = "com.example.Safe";
	assert.equal(calls.act, 0, "blocked act_ui must not deliver input");
	const readCalls = [];
	currentPlatformBackend.readText = async (request) => {
		readCalls.push(request);
		return { text: "secret", offset: 0, limit: 10, totalChars: 6, hasMore: false };
	};
	await assert.rejects(
		() => call(executeReadText, { stateId, ref: text(observed).match(/(@e\d+) button/)[1] }),
		blocked("app_blocked"),
	);
	assert.equal(readCalls.length, 0, "blocked read_text must not reach the helper");
	assert.ok(
		(await call(executeFind, { app: "Safe" })).details.windows.every((w) => w.blocked),
		"find_roots reflects the new list",
	);

	// The env var cannot opt out: `none` leaves Terminal blocked.
	process.env[ENV] = "none";
	await assert.rejects(() => call(executeObserve, { root: refOf("Terminal") }), blocked("app_blocked"));
});

test.skipIf(process.platform !== "darwin")(
	"desktop_input sends the effective blocklist and surfaces the helper's coded refusals",
	async ({ onTestFinished }) => {
		const { macosHelper } = await import("../src/platform/macos/helper.ts");
		const { HelperCommandError } = await import("../src/platform/macos/helper.ts");
		const { loadComputerUseConfig } = await import("../src/config.ts");
		const { executeDesktopInput } = await import("../src/desktop.ts");
		const command = macosHelper.command;
		onTestFinished(() => {
			macosHelper.command = command;
		});
		process.env[ENV] = "com.example.Vault";
		loadComputerUseConfig(makeTestTempDir("cu-policy-", onTestFinished));
		const { effectiveBlockedBundleIds } = await import("../src/config.ts");
		const expected = effectiveBlockedBundleIds();
		assert.ok(SYSTEM_AGENTS.every((id) => expected.includes(id)) && expected.includes("com.example.Vault"));
		const sent = [];
		macosHelper.command = async (name, args) => {
			sent.push({ name, args });
			throw new HelperCommandError("app_blocked: 'Vault' is blocked", "app_blocked");
		};
		for (const params of [
			{ action: "activateApp", app: "Vault" },
			{ action: "typeText", text: "x" },
			{ action: "click", x: 1, y: 2 },
		]) {
			await assert.rejects(
				() => executeDesktopInput("d", params),
				(error) => error.code === "app_blocked",
			);
		}
		assert.equal(sent.length, 3);
		for (const { args } of sent) assert.deepEqual(args.blockedBundleIds, expected);

		// desktop_screenshot sends it too, so the helper can exclude the blocked apps from the capture.
		sent.length = 0;
		const { executeDesktopScreenshot } = await import("../src/desktop.ts");
		macosHelper.command = async (name, args) => {
			sent.push({ name, args });
			return {
				displays: [{ index: 0, isMain: true, frame: { x: 0, y: 0, w: 100, h: 100 } }],
				display: 0,
				frame: { x: 0, y: 0, w: 100, h: 100 },
				image: { jpegBase64: "", width: 100, height: 100 },
			};
		};
		await executeDesktopScreenshot("d", {}, undefined, undefined, undefined);
		assert.equal(sent[0].name, "captureDisplay");
		assert.deepEqual(sent[0].args.blockedBundleIds, expected);
	},
);

test("macOS act and actBatch send the effective blocklist so coordinate input is checked in the helper", async ({
	onTestFinished,
}) => {
	const { macosHelper } = await import("../src/platform/macos/helper.ts");
	const { macosBackend } = await import("../src/platform/macos/backend.ts");
	const { loadComputerUseConfig } = await import("../src/config.ts");
	const command = macosHelper.command;
	onTestFinished(() => {
		macosHelper.command = command;
	});
	process.env[ENV] = "com.example.Vault";
	loadComputerUseConfig(makeTestTempDir("cu-policy-", onTestFinished));
	const sent = [];
	macosHelper.command = async (name, args) => {
		sent.push({ name, args });
		return { outcome: "worked", steps: [] };
	};
	const request = {
		lookId: "l1",
		pid: 1,
		target: { kind: "coordinates", x: 1, y: 2 },
		policy: "foreground",
		action: "click",
		params: { delivery: "hid" },
	};
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

async function useRootPolicyFixture(platform, helper, roots, onTestFinished) {
	const { currentPlatformBackend, platformBackendForRuntime } = await import("../src/platform/index.ts");
	const bridge = await import("../src/bridge.ts");
	const { executeFind, executeObserve } = bridge;
	const original = { ...currentPlatformBackend };
	const backend = { ...platformBackendForRuntime(platform) };
	const originalCommand = helper.command;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const originalCdpPort = process.env.PI_COMPUTER_USE_CDP_PORT;
	delete process.env.PI_COMPUTER_USE_CDP_PORT;
	const cwd = makeTestTempDir("cu-host-policy-", onTestFinished);
	process.env.PI_CODING_AGENT_DIR = cwd;
	delete process.env[ENV];
	onTestFinished(() => {
		Object.assign(currentPlatformBackend, original);
		helper.command = originalCommand;
		if (originalCdpPort === undefined) delete process.env.PI_COMPUTER_USE_CDP_PORT;
		else process.env.PI_COMPUTER_USE_CDP_PORT = originalCdpPort;
		if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	});
	const calls = [];
	Object.assign(currentPlatformBackend, backend, {
		ensureReady: async (_ctx, state) => {
			calls.push("ensureReady");
			return state;
		},
	});
	helper.command = async (name, args) => {
		calls.push(name);
		if (name === "look") {
			assert.equal(platform, "win32");
			assert.equal(args.blockedApps, undefined);
			assert.equal(args.blockedBundleIds, undefined);
			return {
				lookId: "windows-look",
				window: { rootRef: args.rootRef, framePoints: { x: 0, y: 0, w: 100, h: 100 }, scaleFactor: 1 },
				outline: wireNode("root", "window", "Notes", {
					children: [wireButton("save", "Save"), wireNode("group", "group", "Group", { truncated: true })],
				}),
				readText: { requested: args.readText, executed: false },
			};
		}
		if (name === "uiaReadText") return { text: "safe", offset: 0, limit: 4, totalChars: 4, hasMore: false };
		assert.equal(name, "listRoots");
		assert.deepEqual(Object.keys(args), args.pid ? ["pid"] : [], "never forward the blocklist");
		return { roots: args.pid ? roots.filter((root) => root.pid === args.pid) : roots };
	};
	mkdirSync(path.join(cwd, "extensions"));
	const userFile = path.join(cwd, "extensions", "pi-computer-use.json");
	const ctx = { cwd, hasUI: false, ui: { notify() {} }, sessionManager: { getBranch: () => [] } };
	const call = (executor, params) => executor("t", params, undefined, undefined, ctx);
	const find = async (params = {}) => (await call(executeFind, params)).details.windows;
	const observe = (root, mode = "semantic") => call(executeObserve, { root, mode });
	return { bridge, call, calls, ctx, find, observe, userFile };
}

function policyRoot(pid, appName, processName, bundleId) {
	return {
		kind: "window",
		rootRef: String(pid),
		pid,
		title: appName,
		appName,
		processName,
		bundleId,
		isFocused: pid === 101,
	};
}

test("macOS blocks a known root before failing readiness", async ({ onTestFinished }) => {
	const { currentPlatformBackend } = await import("../src/platform/index.ts");
	const { macosHelper } = await import("../src/platform/macos/helper.ts");
	const root = policyRoot(101, "Terminal", undefined, "com.apple.Terminal");
	const { observe, find, calls } = await useRootPolicyFixture("darwin", macosHelper, [root], onTestFinished);
	const [{ windowRef }] = await find();
	currentPlatformBackend.ensureReady = async () => {
		calls.push("ensureReady");
		throw new Error("readiness failed");
	};
	calls.length = 0;
	await assert.rejects(observe(windowRef), { code: "app_blocked" });
	assert.deepEqual(calls, []);
	await assert.rejects(find(), /readiness failed/);
});

test("Windows blocks known roots by executable before helper calls, not by display name or bundle id", async ({
	onTestFinished,
}) => {
	const { windowsHelper } = await import("../src/platform/windows/helper.ts");
	const roots = [
		policyRoot(101, "Console", "wINDOWStERMINAL.EXE"),
		policyRoot(102, "Elevated UI", "CoNsEnT.ExE"),
		policyRoot(103, "Private vault", "Vault.EXE"),
		policyRoot(104, "Vault.EXE", "safe.exe", "VAULT.exe"),
		policyRoot(105, "WindowsTerminal.exe", "", "WindowsTerminal.exe"),
	];
	const { calls, find, observe, userFile } = await useRootPolicyFixture("win32", windowsHelper, roots, onTestFinished);
	const byPid = (windows, pid) => windows.find((root) => root.pid === pid);
	const discovered = await find();
	assert.equal(byPid(discovered, 101).blocked, true);
	assert.equal(byPid(discovered, 102).blocked, true);
	assert.equal(byPid(discovered, 103).blocked, false);
	assert.equal(byPid(discovered, 105).blocked, true);
	assert.equal(byPid(discovered, 105).identityUnresolved, true);
	assert.equal(byPid(await find({ pid: 101 }), 101).blocked, true);
	calls.length = 0;
	await assert.rejects(observe(byPid(discovered, 101).windowRef), { code: "app_blocked" });
	assert.deepEqual(calls, [], "blocked selection must not reach readiness, discovery, or observation");
	const unresolved = { code: "app_blocked", message: /application identity could not be determined/ };
	await assert.rejects(observe(byPid(discovered, 105).windowRef), unresolved);
	assert.deepEqual(calls, [], "an unidentified saved root must not reach readiness");

	const vault = roots[2];
	vault.processName = "";
	await assert.rejects(observe(byPid(discovered, 103).windowRef), unresolved);
	assert.deepEqual(calls.splice(0), ["ensureReady", "listRoots"], "a fresh lookup must not reuse the prior identity");
	vault.processName = "Vault.EXE";
	await find();
	calls.length = 0;

	writeFileSync(userFile, JSON.stringify({ blocked_apps: ["vAuLt.exe"] }));
	await assert.rejects(observe(byPid(discovered, 103).windowRef), { code: "app_blocked" });
	assert.deepEqual(calls, [], "a newly blocked saved root must not reach the helper");
	const configured = await find();
	assert.equal(byPid(configured, 101).blocked, false, "a user-global list replaces defaults");
	assert.equal(byPid(configured, 102).blocked, true, "always-blocked entries survive replacement");
	assert.equal(byPid(configured, 103).blocked, true);
	assert.equal(byPid(configured, 104).blocked, false, "neither the title nor the bundle id is a Windows identity");
});

test("Windows refuses re-blocked saved-state live operations before readiness", async ({ onTestFinished }) => {
	const { windowsHelper } = await import("../src/platform/windows/helper.ts");
	const roots = [policyRoot(101, "Notes", "notes.exe")];
	const { bridge, call, calls, find, observe, userFile } = await useRootPolicyFixture(
		"win32",
		windowsHelper,
		roots,
		onTestFinished,
	);
	const [{ windowRef }] = await find();
	const {
		details: {
			capture: { stateId },
		},
	} = await observe(windowRef, "fused");
	const { executeAct, executeReadText, executeWaitFor, executeSearchUi, executeExpandUi, executeInspectUi } = bridge;
	const search = (text) => call(executeSearchUi, { stateId, text });
	const expand = (ref) => call(executeExpandUi, { stateId, ref });
	const saveRef = (await search("Save")).details.matches[0].ref;
	const groupRef = (await call(executeInspectUi, { stateId, ref: "@e3" })).details.target.ref;

	writeFileSync(userFile, JSON.stringify({ blocked_apps: ["NOTES.EXE"] }));
	calls.length = 0;
	for (const [name, operation] of [
		["act_ui", () => call(executeAct, { stateId, actions: [{ action: "press", ref: saveRef }] })],
		["read_text", () => call(executeReadText, { stateId, ref: saveRef })],
		["wait_for", () => call(executeWaitFor, { stateId, text: "Save" })],
		["search_ui OCR", () => search("missing")],
		["expand_ui scoped", () => expand(groupRef)],
	]) {
		await assert.rejects(operation, { code: "app_blocked" }, name);
		assert.deepEqual(calls, [], `${name} must not reach readiness or the helper`);
	}
	assert.equal((await search("Save")).details.matches[0].ref, saveRef, "cached query still works");
	assert.match((await expand(saveRef)).content[0].text, /Save/, "cached expansion still works");
	await assert.rejects(search(undefined), /requires text, role, or capability/);
	await assert.rejects(expand(undefined), /ref is required/);
	await assert.rejects(expand("@e99"), /not available/);
	assert.ok(
		calls.every((name) => name === "ensureReady"),
		"cached queries do not look again",
	);
});

test.for(["", "CoNsEnT.ExE"])(
	"Windows re-admits all live saved-state operations after an owner flip to %j",
	async (owner, { onTestFinished }) => {
		const { windowsHelper } = await import("../src/platform/windows/helper.ts");
		const root = { ...policyRoot(101, "Notes", "notes.exe"), windowId: 123 };
		const { bridge, call, calls, find, observe } = await useRootPolicyFixture(
			"win32",
			windowsHelper,
			[root],
			onTestFinished,
		);
		const [{ windowRef }] = await find();
		const {
			details: {
				capture: { stateId },
			},
		} = await observe(windowRef, "fused");
		const { executeObserve, executeAct, executeReadText, executeWaitFor, executeSearchUi, executeExpandUi } = bridge;
		const { ref } = (await call(executeSearchUi, { stateId, text: "Save" })).details.matches[0];
		const input = [
			[executeObserve, { stateId }],
			[executeAct, { stateId, actions: [{ action: "press", ref }] }],
			[executeReadText, { stateId, ref }],
			[executeWaitFor, { stateId, text: "Save" }],
			[executeSearchUi, { stateId, text: "missing" }],
			[executeExpandUi, { stateId, ref: "@e3" }],
		];
		root.processName = owner;
		// Without new discovery, only the fresh identity lookup is allowed, never a look, read or action.
		for (const [execute, args] of input) {
			calls.length = 0;
			await assert.rejects(call(execute, args), { code: "app_blocked" });
			assert.deepEqual(calls, ["ensureReady", "listRoots"]);
		}
		assert.equal((await find())[0].blocked, true);
		calls.length = 0;
		for (const [execute, args] of input) await assert.rejects(call(execute, args), { code: "app_blocked" });
		await assert.rejects(call(executeObserve, { stateId, root: windowRef }), { code: "app_blocked" });
		assert.deepEqual(calls, []);
	},
);

test("Windows refuses an explicitly selected blocked saved owner before failing readiness", async ({
	onTestFinished,
}) => {
	const { currentPlatformBackend } = await import("../src/platform/index.ts");
	const { windowsHelper } = await import("../src/platform/windows/helper.ts");
	const root = { ...policyRoot(101, "Notes", "notes.exe"), windowId: 123 };
	const other = policyRoot(102, "Mail", "mail.exe");
	const { bridge, call, calls, find, observe, userFile } = await useRootPolicyFixture(
		"win32",
		windowsHelper,
		[root, other],
		onTestFinished,
	);
	const [{ windowRef }, { windowRef: otherRef }] = await find();
	const { stateId } = (await observe(windowRef)).details.capture;
	root.processName = "other.exe";
	writeFileSync(userFile, JSON.stringify({ blocked_apps: ["notes.exe"] }));
	const [latest] = await find();
	assert.equal(latest.windowRef, windowRef);
	assert.equal(latest.appId, "other.exe");
	assert.equal(latest.blocked, false);

	currentPlatformBackend.ensureReady = async () => {
		calls.push("ensureReady");
		throw new Error("readiness failed");
	};
	calls.length = 0;
	await assert.rejects(call(bridge.executeObserve, { stateId, root: windowRef }), { code: "app_blocked" });
	assert.deepEqual(calls, [], "the blocked saved owner must not reach readiness or the helper");
	await assert.rejects(call(bridge.executeObserve, { stateId, root: otherRef }), /readiness failed/);
	assert.deepEqual(calls, ["ensureReady"], "an explicitly selected different root does not use the saved owner");
});

test("restores Windows root identity and refuses title rebinding or legacy records", async ({ onTestFinished }) => {
	const { windowsHelper } = await import("../src/platform/windows/helper.ts");
	const root = policyRoot(101, "Notes", "Notes.exe");
	const { bridge, call, calls, ctx, observe } = await useRootPolicyFixture(
		"win32",
		windowsHelper,
		[root],
		onTestFinished,
	);
	const found = await call(bridge.executeFind, {});
	const [{ windowRef }] = found.details.windows;
	const observed = await observe(windowRef);
	const {
		capture: { stateId },
	} = observed.details;
	const entry = ({ details }) =>
		JSON.parse(JSON.stringify({ type: "message", message: { role: "toolResult", toolName: details.tool, details } }));
	const branch = [entry(found), entry(observed)];
	ctx.sessionManager.getBranch = () => branch;
	bridge.reconstructStateFromBranch(ctx);
	root.processName = "notes.EXE";
	assert.equal((await call(bridge.executeReadText, { stateId, ref: "@e2" })).details.text, "safe");
	assert.equal((await observe(windowRef)).details.target.appId, "notes.EXE");
	root.processName = "consent.exe";
	const newest = entry(await call(bridge.executeFind, {}));
	branch.push(newest);
	bridge.reconstructStateFromBranch(ctx);
	calls.length = 0;
	await assert.rejects(observe(windowRef), { code: "app_blocked" });
	assert.deepEqual(calls, []);
	branch.pop();
	bridge.reconstructStateFromBranch(ctx);
	root.processName = "other.exe";
	await assert.rejects(observe(windowRef), { code: "app_blocked", message: /owner identity changed/ });
	root.rootRef = "different";
	await assert.rejects(observe(windowRef), { code: "root_stale", message: /original owner/ });
	delete branch[0].message.details.windows[0].appId;
	delete branch[1].message.details.target.appId;
	bridge.reconstructStateFromBranch(ctx);
	calls.length = 0;
	for (const run of [() => observe(windowRef), () => call(bridge.executeReadText, { stateId, ref: "@e2" })]) {
		await assert.rejects(run, { code: "root_stale", message: /Rediscover it with find_roots/ });
	}
	assert.deepEqual(calls, []);
});

test("matches a Windows basename with leading whitespace", async ({ onTestFinished }) => {
	const { windowsHelper } = await import("../src/platform/windows/helper.ts");
	const roots = [policyRoot(101, "Spaced", " Vault.exe"), policyRoot(102, "Plain", "Vault.exe")];
	const { find, userFile } = await useRootPolicyFixture("win32", windowsHelper, roots, onTestFinished);
	writeFileSync(userFile, JSON.stringify({ blocked_apps: [" VAULT.EXE"] }));
	assert.deepEqual(
		(await find()).map(({ blocked }) => blocked),
		[true, false],
	);
});

test("Windows rejects a blank user blocklist entry and keeps the prior list", async ({ onTestFinished }) => {
	const { windowsHelper } = await import("../src/platform/windows/helper.ts");
	const { loadComputerUseConfig } = await import("../src/config.ts");
	const { ctx, userFile } = await useRootPolicyFixture("win32", windowsHelper, [], onTestFinished);
	const load = () => loadComputerUseConfig(ctx.cwd, "windows");
	const prior = load().config.blocked_apps;
	assert.ok(prior.includes("conhost.exe"));

	writeFileSync(userFile, JSON.stringify({ blocked_apps: [" "] }));
	const loaded = load();
	assert.equal(loaded.blockedAppsErrors.length, 1);
	assert.match(loaded.blockedAppsErrors[0], /blocked_apps.*non-blank string/);
	assert.deepEqual(loaded.config.blocked_apps, prior);
});

test("Windows blocklist lookup does not substitute a macOS bundle alias for a missing executable", async () => {
	const { blockedAppId } = await import("../src/config.ts");
	assert.equal(blockedAppId("windows", { bundleId: "consent.exe" }), undefined);
});

test("Windows defaults and additive project entries match exact owner executable basenames", async ({
	onTestFinished,
}) => {
	const { windowsHelper } = await import("../src/platform/windows/helper.ts");
	const hosts = ["CONHOST.EXE", "openconsole.exe", "WT.EXE", "wsl.exe"];
	const roots = [...hosts, "consent.exe", "PowerShell.EXE", "vault.exe"].map((exe, i) =>
		policyRoot(101 + i, "Window label", exe),
	);
	const { find, userFile } = await useRootPolicyFixture("win32", windowsHelper, roots, onTestFinished);
	const blocked = async () =>
		(await find())
			.filter((root) => root.blocked)
			.map((root) => root.pid)
			.sort();
	assert.deepEqual(await blocked(), [101, 102, 103, 104, 105, 106]);

	const projectDir = path.join(path.dirname(userFile), "..", ".pi");
	mkdirSync(projectDir);
	const projectFile = path.join(projectDir, "computer-use.json");
	writeFileSync(projectFile, JSON.stringify({ blocked_apps: ["VAULT.exe"] }));
	assert.deepEqual(await blocked(), [101, 102, 103, 104, 105, 106, 107], "projects only add to defaults");

	writeFileSync(userFile, JSON.stringify({ blocked_apps: [] }));
	assert.deepEqual(
		await blocked(),
		[105, 107],
		"an empty user list replaces defaults, not always-blocked or project entries",
	);
	writeFileSync(projectFile, JSON.stringify({ blocked_apps: [] }));
	assert.deepEqual(await blocked(), [105], "an empty project list cannot remove always-blocked entries");
	writeFileSync(userFile, JSON.stringify({ blocked_apps: ["powershell", "C:\\Windows\\System32\\powershell.exe"] }));
	assert.deepEqual(await blocked(), [105], "configuration entries are opaque strings");
	writeFileSync(userFile, JSON.stringify({ blocked_apps: ["powershell.exe"] }));
	assert.deepEqual(await blocked(), [105, 106], "exact basename matching ignores case");
});

test("Linux maps the helper name but never treats it as a policy identity", async ({ onTestFinished }) => {
	const { linuxHelper } = await import("../src/platform/linux/helper.ts");
	const { linuxBackend } = await import("../src/platform/linux/backend.ts");
	const { getComputerUseConfig } = await import("../src/config.ts");
	const roots = [policyRoot(101, "Terminal label", "xterm"), policyRoot(102, "Vault label", "my-vault")];
	const previousPort = process.env.PI_COMPUTER_USE_CDP_PORT;
	process.env.PI_COMPUTER_USE_CDP_PORT = "9222";
	const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected CDP discovery"));
	const { find, userFile } = await useRootPolicyFixture("linux", linuxHelper, roots, (cleanup) => {
		onTestFinished(() => {
			cleanup();
			fetch.mockRestore();
			if (previousPort === undefined) delete process.env.PI_COMPUTER_USE_CDP_PORT;
			else process.env.PI_COMPUTER_USE_CDP_PORT = previousPort;
		});
	});
	assert.equal((await linuxBackend.listRoots({}))[0].appId, "xterm");
	assert.equal(
		(await find()).some((root) => root.blocked),
		false,
	);
	assert.equal(fetch.mock.calls.length, 0, "an inherited CDP port must not reach discovery");
	assert.ok(getComputerUseConfig().blocked_apps.includes("xterm"));
	writeFileSync(userFile, JSON.stringify({ blocked_apps: ["my-vault"] }));
	assert.equal(
		(await find()).some((root) => root.blocked),
		false,
	);
});
