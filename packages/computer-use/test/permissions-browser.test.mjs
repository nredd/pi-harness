// Permission flow, macOS readiness and the AppleScript browser bridge over faked helpers (nredd/pi-harness#707, Refs #645).
import assert from "node:assert/strict";
import { beforeEach, describe, test, vi } from "vitest";
import { REQUIRED_PLATFORM_INVARIANTS } from "../src/platform/architecture.ts";

const fakes = vi.hoisted(() => ({
	macos: { command: vi.fn(), ensureInstalled: vi.fn(), ensureDaemon: vi.fn(), ensureProtocol: vi.fn(), restart: vi.fn() },
	runProcess: vi.fn(),
}));

vi.mock("../src/platform/macos/helper.ts", () => ({
	macosHelper: fakes.macos,
	HELPER_APP_PATH: "/fake/pi-computer-use.app",
	runProcess: fakes.runProcess,
}));

const { ensurePermissions } = await import("../src/permissions.ts");
const { ensureMacosReady } = await import("../src/platform/macos/permissions.ts");
const { isBrowserApp, isChromeFamilyApp, openBrowserLocationWithAppleScript } = await import("../src/platform/macos/browser.ts");

const kinds = [
	{ kind: "accessibility", openOption: "Open A" },
	{ kind: "screenRecording", openOption: "Open S" },
];
const status = (accessibility, screenRecording) => ({ accessibility, screenRecording });

/** A UI context whose `select` replays `choices` and records every prompt and notification. */
function makeCtx(choices, hasUI = true) {
	const queue = [...choices];
	const ctx = {
		hasUI,
		prompts: [],
		notices: [],
		ui: {
			select: vi.fn(async (prompt, options, opts) => {
				ctx.prompts.push({ prompt, options, opts });
				return queue.shift();
			}),
			notify: vi.fn((message, level) => ctx.notices.push([message, level])),
		},
	};
	return ctx;
}

/** A bridge whose `checkPermissions` replays `statuses`, repeating the last one. */
function makeBridge(statuses, over = {}) {
	const queue = [...statuses];
	return {
		kinds,
		copy: {
			nonInteractiveError: (path) => `non-interactive ${path}`,
			prompt: vi.fn((current, path, hint) => `prompt ${JSON.stringify(current)} ${path} ${hint ?? "-"}`),
			incompleteError: (path) => `incomplete ${path}`,
			readyMessage: "ready!",
			stillMissing: (missing) => `missing ${missing.join(",")}`,
		},
		checkPermissions: vi.fn(async () => (queue.length > 1 ? queue.shift() : queue[0])),
		registerPermissions: vi.fn(async () => undefined),
		openPermissionPane: vi.fn(async () => undefined),
		restartHelper: vi.fn(async () => undefined),
		...over,
	};
}

describe("ensurePermissions", () => {
	test("returns granted status without prompting or registering", async () => {
		const bridge = makeBridge([status(true, true)]);
		const ctx = makeCtx([], false);
		assert.deepEqual(await ensurePermissions(ctx, bridge, "/h"), status(true, true));
		assert.equal(bridge.registerPermissions.mock.calls.length, 0);
	});

	test("treats a non-true value as not granted and rejects without a UI", async () => {
		const bridge = makeBridge([{ accessibility: "true", screenRecording: true }]);
		await assert.rejects(ensurePermissions(makeCtx([], false), bridge, "/h"), /non-interactive \/h/);
		assert.equal(bridge.registerPermissions.mock.calls.length, 0);
	});

	test("registers once, offers only missing panes, opens one and rechecks to ready", async () => {
		const signal = new AbortController().signal;
		const bridge = makeBridge([status(false, true), status(false, true), status(true, true)], { permissionHint: "HINT", registerPermissions: vi.fn(async () => { throw new Error("register failed"); }) });
		const ctx = makeCtx(["Open A", "Recheck (restarts helper)", "Recheck (restarts helper)"]);
		assert.deepEqual(await ensurePermissions(ctx, bridge, "/h", signal), status(true, true));
		assert.equal(bridge.registerPermissions.mock.calls.length, 1);
		assert.deepEqual(bridge.registerPermissions.mock.calls[0], [signal]);
		assert.deepEqual(ctx.prompts[0].options, ["Open A", "Recheck (restarts helper)", "Cancel"]);
		assert.equal(ctx.prompts[0].opts.signal, signal);
		assert.match(ctx.prompts[0].prompt, /\/h HINT$/);
		assert.deepEqual(bridge.openPermissionPane.mock.calls, [["accessibility", signal]]);
		assert.equal(bridge.restartHelper.mock.calls.length, 2);
		assert.deepEqual(ctx.notices, [["missing accessibility", "warning"], ["ready!", "info"]]);
	});

	test("offers both panes when both are missing and opens the selected one", async () => {
		const bridge = makeBridge([status(false, false)]);
		const ctx = makeCtx(["Open S", "Cancel"]);
		await assert.rejects(ensurePermissions(ctx, bridge, "/h"), /incomplete \/h/);
		assert.deepEqual(ctx.prompts[0].options, ["Open A", "Open S", "Recheck (restarts helper)", "Cancel"]);
		assert.deepEqual(bridge.openPermissionPane.mock.calls, [["screenRecording", undefined]]);
		assert.equal(bridge.restartHelper.mock.calls.length, 0);
	});

	test("a dismissed prompt is incomplete and an aborted signal stops the loop", async () => {
		await assert.rejects(ensurePermissions(makeCtx([undefined]), makeBridge([status(true, false)]), "/h"), /incomplete \/h/);
		const controller = new AbortController();
		const bridge = makeBridge([status(false, false)], { registerPermissions: vi.fn(async () => controller.abort()) });
		const ctx = makeCtx([]);
		await assert.rejects(ensurePermissions(ctx, bridge, "/h", controller.signal), /Operation aborted\./);
		assert.equal(ctx.ui.select.mock.calls.length, 0);
	});
});

describe("ensureMacosReady", () => {
	const readyState = { lastPermissionCheckAt: 0 };
	const goodDiagnostics = { architectureVersion: 1, invariants: [...REQUIRED_PLATFORM_INVARIANTS], pid: 1 };
	const reply = (over = {}) => ({ accessibility: true, screenRecordingCapturable: true, screenRecordingPreflight: true, ...over });

	beforeEach(() => {
		for (const fake of Object.values(fakes.macos)) fake.mockReset();
		fakes.macos.ensureDaemon.mockResolvedValue(true);
		fakes.macos.ensureProtocol.mockResolvedValue(goodDiagnostics);
		fakes.macos.command.mockImplementation(async (command) => (command === "checkPermissions" ? reply() : {}));
	});

	const checks = () => fakes.macos.command.mock.calls.filter(([command]) => command === "checkPermissions");

	test("fails when the daemon does not start or the architecture is wrong", async () => {
		const signal = new AbortController().signal;
		fakes.macos.ensureDaemon.mockResolvedValueOnce(false);
		await assert.rejects(ensureMacosReady(makeCtx([]), readyState, signal), /daemon did not start\. Helper app: \/fake\/pi-computer-use\.app/);
		assert.deepEqual(fakes.macos.ensureInstalled.mock.calls, [[signal]]);
		fakes.macos.ensureProtocol.mockResolvedValueOnce({ ...goodDiagnostics, architectureVersion: 7 });
		await assert.rejects(ensureMacosReady(makeCtx([]), readyState), /macOS helper architecture mismatch/);
	});

	test("checks granted permissions and parses the attribution source", async () => {
		fakes.macos.command.mockResolvedValueOnce(reply({ screenRecordingPreflight: false, source: {
			attribution: "helper-app", pid: 12.5, parentPid: 0, executablePath: "/x/bridge", parentPath: "/p", parentBundleId: "b.id", macOS: "15.1",
		} }));
		const signal = new AbortController().signal;
		const before = Date.now();
		const next = await ensureMacosReady(makeCtx([], false), readyState, signal);
		assert.deepEqual(next.permissionStatus, {
			accessibility: true, screenRecording: true, screenRecordingPreflight: false,
			source: { attribution: "helper-app", pid: 12, parentPid: undefined, executablePath: "/x/bridge", parentPath: "/p", parentBundleId: "b.id", os: "15.1" },
		});
		assert.deepEqual(next.helperDiagnostics, goodDiagnostics);
		assert.ok(next.lastPermissionCheckAt >= before);
		assert.deepEqual(checks()[0], ["checkPermissions", {}, { signal }]);
	});

	test("uses the cached grant for 2s but re-checks when stale or incomplete", async () => {
		const fresh = { permissionStatus: status(true, true), lastPermissionCheckAt: Date.now() };
		const cached = await ensureMacosReady(makeCtx([], false), fresh);
		assert.equal(checks().length, 0);
		assert.deepEqual(cached, { ...fresh, helperDiagnostics: goodDiagnostics });
		await ensureMacosReady(makeCtx([], false), { ...fresh, lastPermissionCheckAt: Date.now() - 5_000 });
		assert.equal(checks().length, 1);
		await ensureMacosReady(makeCtx([], false), { permissionStatus: status(true, false), lastPermissionCheckAt: Date.now() });
		await ensureMacosReady(makeCtx([], false), { permissionStatus: status(false, true), lastPermissionCheckAt: Date.now() });
		await ensureMacosReady(makeCtx([], false), { lastPermissionCheckAt: Date.now() });
		assert.equal(checks().length, 4);
	});

	test("a missing grant without a UI explains the setup", async () => {
		fakes.macos.command.mockResolvedValue(reply({ accessibility: false, source: "not an object" }));
		await assert.rejects(ensureMacosReady(makeCtx([], false), readyState), (error) => /requires an interactive session/.test(error.message) && /Helper path: \/fake\/pi-computer-use\.app/.test(error.message) && /Accessibility and Screen Recording/.test(error.message));
	});

	test("a missing grant prompts, registers, opens panes, restarts and finishes after recheck", async () => {
		const signal = new AbortController().signal;
		let granted = false;
		const ctx = makeCtx(["Open Accessibility Settings (missing)", "Open Screen Recording Settings (missing)", "Recheck (restarts helper)", "Recheck (restarts helper)"]);
		fakes.macos.command.mockImplementation(async (command) => {
			if (command === "checkPermissions") return reply({ accessibility: granted, screenRecordingCapturable: granted, screenRecordingPreflight: true });
			return {};
		});
		fakes.macos.restart.mockImplementationOnce(async () => undefined).mockImplementationOnce(async () => { granted = true; });
		const next = await ensureMacosReady(ctx, readyState, signal);
		assert.equal(next.permissionStatus.accessibility, true);
		const commands = fakes.macos.command.mock.calls.map(([command]) => command);
		assert.deepEqual(commands.filter((command) => command !== "checkPermissions"), ["registerPermissions", "openPermissionPane", "openPermissionPane"]);
		assert.deepEqual(fakes.macos.command.mock.calls.find(([command]) => command === "registerPermissions"), ["registerPermissions", {}, { signal, timeoutMs: 15_000 }]);
		assert.deepEqual(fakes.macos.command.mock.calls.filter(([command]) => command === "openPermissionPane").map(([, args]) => args), [{ kind: "accessibility" }, { kind: "screenRecording" }]);
		assert.deepEqual(fakes.macos.restart.mock.calls, [[signal], [signal]]);
		assert.deepEqual(ctx.notices, [["Still missing after restart: accessibility and screenRecording. If these permissions were enabled before this install/update, macOS invalidated the old grants because pi-computer-use.app was re-signed. Re-enable both toggles for the newly signed helper. If a toggle is already on, switch it off and on again. Then choose Recheck again.", "warning"], ["pi-computer-use is ready.", "info"]]);
		assert.match(ctx.prompts[0].prompt, /^pi-computer-use needs macOS permissions for its helper app\.\nAccessibility: missing; Screen Recording: missing; \(Screen Recording reads granted/);
	});

	test("the prompt reports a failed capture probe and the caller-attribution warning", async () => {
		fakes.macos.command.mockResolvedValue(reply({ screenRecordingCapturable: false, source: { attribution: "caller", executablePath: "/x/bridge" } }));
		const ctx = makeCtx(["Cancel"]);
		await assert.rejects(ensureMacosReady(ctx, readyState), /setup is incomplete\. Grant Accessibility/);
		const { prompt } = ctx.prompts[0];
		assert.match(prompt, /Accessibility: granted; Screen Recording: missing; \(Screen Recording reads granted in the TCC database but a live capture probe failed/);
		assert.match(prompt, /Helper: pi-computer-use\.app \(\/fake\/pi-computer-use\.app\)\nWarning: the helper is not running as the installed pi-computer-use\.app \(executable: \/x\/bridge\)/);
		assert.match(prompt, /Important: If these permissions were enabled before/);
		assert.match(prompt, /enable its toggle, then choose Recheck\.$/);
		fakes.macos.command.mockResolvedValue(reply({ accessibility: false, source: { attribution: "caller" } }));
		const unknown = makeCtx(["Cancel"]);
		await assert.rejects(ensureMacosReady(unknown, readyState), /incomplete/);
		assert.match(unknown.prompts[0].prompt, /\(executable: unknown\)/);
	});

	test("no hint for the canonical helper and no capture-probe line when preflight also fails", async () => {
		fakes.macos.command.mockResolvedValue(reply({ accessibility: false, screenRecordingCapturable: false, screenRecordingPreflight: false, source: { attribution: "helper-app" } }));
		const ctx = makeCtx(["Cancel"]);
		await assert.rejects(ensureMacosReady(ctx, readyState), /incomplete/);
		assert.doesNotMatch(ctx.prompts[0].prompt, /Warning: the helper is not running|live capture probe/);
		fakes.macos.command.mockResolvedValue(reply({ accessibility: false }));
		const bare = makeCtx(["Cancel"]);
		await assert.rejects(ensureMacosReady(bare, readyState), /incomplete/);
		assert.doesNotMatch(bare.prompts[0].prompt, /Warning: the helper is not running/);
	});
});

describe("browser bridge", () => {
	beforeEach(() => fakes.runProcess.mockReset());

	test("recognizes browsers by bundle id or case-insensitive name", () => {
		assert.equal(isBrowserApp("whatever", "com.apple.Safari"), true);
		assert.equal(isBrowserApp("  Firefox "), true);
		assert.equal(isBrowserApp("Notes", "com.apple.Notes"), false);
		assert.equal(isChromeFamilyApp("x", "com.google.Chrome"), true);
		assert.equal(isChromeFamilyApp("Arc"), true);
		assert.equal(isChromeFamilyApp("Safari", "com.apple.Safari"), false);
		assert.equal(isChromeFamilyApp("Firefox", "org.mozilla.firefox"), false);
	});

	test("drives Safari and Chrome-family targets through osascript with escaped values", async () => {
		const signal = new AbortController().signal;
		fakes.runProcess.mockResolvedValue("");
		assert.equal(await openBrowserLocationWithAppleScript({ appName: "Safari", bundleId: "com.apple.Safari" }, 'https://x.test/?q="1"\\', signal), true);
		assert.deepEqual(fakes.runProcess.mock.calls[0], ["osascript", ["-e", 'tell application id "com.apple.Safari" to set URL of front document to "https://x.test/?q=\\"1\\"\\\\"'], 10_000, signal]);
		assert.equal(await openBrowserLocationWithAppleScript({ appName: " safari " }, "u"), true);
		assert.equal(fakes.runProcess.mock.calls[1][1][1], 'tell application " safari " to set URL of front document to "u"');
		assert.equal(await openBrowserLocationWithAppleScript({ appName: "Arc" }, "https://a.test"), true);
		assert.equal(fakes.runProcess.mock.calls[2][1][1], 'tell application "Arc" to set URL of active tab of front window to "https://a.test"');
		assert.equal(await openBrowserLocationWithAppleScript({ appName: "x", bundleId: "com.brave.Browser" }, "u"), true);
		assert.match(fakes.runProcess.mock.calls[3][1][1], /^tell application id "com\.brave\.Browser" to set URL of active tab/);
	});

	test("returns false without running osascript for other apps", async () => {
		assert.equal(await openBrowserLocationWithAppleScript({ appName: "Firefox", bundleId: "org.mozilla.firefox" }, "u"), false);
		assert.equal(fakes.runProcess.mock.calls.length, 0);
	});

	test("appends the Apple Events hint once for JavaScript-disabled errors and passes others through", async () => {
		const target = { appName: "Google Chrome" };
		const disabled = Object.assign(new Error("Executing JavaScript through AppleScript is turned off."), { name: "CustomError" });
		fakes.runProcess.mockRejectedValueOnce(disabled);
		const enhanced = await openBrowserLocationWithAppleScript(target, "u").catch((error) => error);
		assert.notEqual(enhanced, disabled);
		assert.equal(enhanced.name, "CustomError");
		assert.match(enhanced.message, /^Executing JavaScript through AppleScript is turned off\.\n\nBrowser JavaScript Apple Events are disabled for the target browser\. Ask the user to enable "Allow JavaScript from Apple Events"/);
		fakes.runProcess.mockRejectedValueOnce(enhanced);
		assert.equal(await openBrowserLocationWithAppleScript(target, "u").catch((error) => error), enhanced);
		const other = new Error("boom");
		fakes.runProcess.mockRejectedValueOnce(other);
		assert.equal(await openBrowserLocationWithAppleScript(target, "u").catch((error) => error), other);
		fakes.runProcess.mockRejectedValueOnce("plain string");
		const wrapped = await openBrowserLocationWithAppleScript(target, "u").catch((error) => error);
		assert.ok(wrapped instanceof Error);
		assert.equal(wrapped.message, "plain string");
	});
});
