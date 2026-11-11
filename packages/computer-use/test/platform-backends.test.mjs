// Platform backends and the `platform/index.ts` facade over faked helper clients (nredd/pi-harness#707, Refs #645).
import assert from "node:assert/strict";
import { beforeEach, describe, test, vi } from "vitest";
import { REQUIRED_PLATFORM_INVARIANTS } from "../src/platform/architecture.ts";

const fakes = vi.hoisted(() => {
	const helper = () => ({ command: vi.fn(), ensureInstalled: vi.fn(async () => undefined), dispose: vi.fn() });
	return {
		macos: { ...helper(), ensureDaemon: vi.fn(), ensureProtocol: vi.fn(), restart: vi.fn() },
		glow: { close: vi.fn(async () => undefined), setActive: vi.fn(async () => undefined) },
		linux: helper(),
		resetLinux: vi.fn(),
		windows: helper(),
	};
});

vi.mock("../src/platform/macos/helper.ts", () => ({
	macosHelper: fakes.macos,
	macosActivityGlow: fakes.glow,
	HELPER_APP_PATH: "/fake/pi-computer-use.app",
	runProcess: vi.fn(),
}));
vi.mock("../src/platform/linux/helper.ts", () => ({
	LINUX_HELPER_PROTOCOL_VERSION: 4,
	linuxHelper: fakes.linux,
	resetLinuxHelper: fakes.resetLinux,
}));
vi.mock("../src/platform/windows/helper.ts", () => ({
	WINDOWS_HELPER_PROTOCOL_VERSION: 4,
	windowsHelper: fakes.windows,
}));

const { platformBackendForRuntime } = await import("../src/platform/index.ts");
const { macosBackend, normalizeTarget } = await import("../src/platform/macos/backend.ts");
const { effectiveBlockedBundleIds, getComputerUseConfig } = await import("../src/config.ts");
const { wslProbe } = await import("../src/platform/linux/wsl.ts");

const signal = new AbortController().signal;
const diagnostics = (over = {}) => ({ protocolVersion: 4, architectureVersion: 1, invariants: [...REQUIRED_PLATFORM_INVARIANTS], accessibility: true, ...over });
const lastCall = (fake) => fake.command.mock.calls.at(-1);
const rejectsWith = (promise, pattern) => assert.rejects(promise, pattern);

beforeEach(() => {
	for (const fake of [fakes.macos, fakes.linux, fakes.windows]) {
		fake.command.mockReset();
		fake.ensureInstalled.mockClear();
	}
	fakes.windows.dispose.mockClear();
	fakes.resetLinux.mockClear();
	fakes.glow.close.mockClear();
	fakes.glow.setActive.mockClear();
});

describe("macOS backend", () => {
	test("listApps keeps valid pids, defaults names and accepts both payload shapes", async () => {
		const raw = [
			{ pid: 10.9, appName: "Safari", bundleId: "com.apple.Safari", isFrontmost: true },
			{ pid: "12" },
			{ pid: 0, appName: "zero" },
			{ pid: -3, appName: "negative" },
			{ appName: "no pid" },
			null,
		];
		const expected = [
			{ appName: "Safari", bundleId: "com.apple.Safari", pid: 10, isFrontmost: true },
			{ appName: "Unknown App", bundleId: undefined, pid: 12, isFrontmost: false },
		];
		fakes.macos.command.mockResolvedValueOnce(raw);
		assert.deepEqual(await macosBackend.listApps(signal), expected);
		assert.deepEqual(lastCall(fakes.macos), ["listApps", {}, { signal }]);
		fakes.macos.command.mockResolvedValueOnce({ apps: raw });
		assert.deepEqual(await macosBackend.listApps(), expected);
		for (const bad of [undefined, null, {}, { apps: "nope" }, "text"]) {
			fakes.macos.command.mockResolvedValueOnce(bad);
			assert.deepEqual(await macosBackend.listApps(), []);
		}
	});

	test("listRoots parses full payloads", async () => {
		fakes.macos.command.mockResolvedValueOnce({ roots: [{
			kind: "sheet", rootRef: "r1", windowRef: "w1", windowId: 5.7, pid: 9.2, appName: "App", bundleId: "b.id", title: "T",
			role: "AXWindow", subrole: "AXDialog", framePoints: { x: "1", y: 2, w: 30, h: 40 }, scaleFactor: 2, zOrder: 3.9,
			isMinimized: true, isOnscreen: "true", isMain: 1, isFocused: true, isModal: true, metadata: { k: 1 },
		}] });
		assert.deepEqual(await macosBackend.listRoots({}), [{
			kind: "sheet", rootRef: "r1", windowRef: "w1", windowId: 5, pid: 9, appName: "App", bundleId: "b.id", title: "T",
			role: "AXWindow", subrole: "AXDialog", framePoints: { x: 1, y: 2, w: 30, h: 40 }, scaleFactor: 2, zOrder: 3,
			isMinimized: true, isOnscreen: true, isMain: true, isFocused: true, isModal: true, metadata: { k: 1 },
		}]);
	});

	test("listRoots defaults malformed and partial payloads", async () => {
		fakes.macos.command.mockResolvedValueOnce([
			{ kind: "bogus", windowRef: "only-window", framePoints: { w: 0, h: -5 }, scaleFactor: 0.2, metadata: null },
			{ rootRef: "only-root", metadata: "str", windowId: "x", pid: Number.NaN, framePoints: null },
			null,
		]);
		const roots = await macosBackend.listRoots({});
		assert.equal(roots.length, 3);
		assert.deepEqual(roots[0], {
			kind: "window", rootRef: "only-window", windowRef: "only-window", windowId: undefined, pid: undefined, appName: undefined,
			bundleId: undefined, title: "", role: undefined, subrole: undefined, framePoints: { x: 0, y: 0, w: 1, h: 1 }, scaleFactor: 1,
			zOrder: 0, isMinimized: false, isOnscreen: false, isMain: false, isFocused: false, isModal: false, metadata: {},
		});
		assert.equal(roots[1].rootRef, "only-root");
		assert.equal(roots[1].windowRef, "only-root");
		assert.deepEqual(roots[1].metadata, {});
		assert.deepEqual(roots[1].framePoints, { x: 0, y: 0, w: 1, h: 1 });
		assert.equal(roots[2].kind, "window");
		assert.equal(roots[2].rootRef, undefined);
		for (const bad of [undefined, {}, { roots: 1 }]) {
			fakes.macos.command.mockResolvedValueOnce(bad);
			assert.deepEqual(await macosBackend.listRoots({}), []);
		}
	});

	test("listRoots forwards only a finite pid and a non-blank trimmed title", async () => {
		fakes.macos.command.mockResolvedValue([]);
		await macosBackend.listRoots({ pid: 42.8, title: "  Doc  " }, signal);
		assert.deepEqual(lastCall(fakes.macos), ["listRoots", { pid: 42, title: "Doc" }, { signal }]);
		await macosBackend.listRoots({ pid: Number.NaN, title: "   " });
		assert.deepEqual(lastCall(fakes.macos)[1], {});
		await macosBackend.listRoots({});
		assert.deepEqual(lastCall(fakes.macos)[1], {});
	});

	test("getFrontmost normalizes the helper reply and rejects a missing pid", async () => {
		fakes.macos.command.mockResolvedValueOnce({ pid: 7.5, appName: "Pages", bundleId: "b", windowTitle: "Doc", windowId: 3.9 });
		assert.deepEqual(await macosBackend.getFrontmost(signal), { appName: "Pages", bundleId: "b", pid: 7, windowTitle: "Doc", windowId: 3 });
		assert.deepEqual(lastCall(fakes.macos), ["getFrontmost", {}, { signal }]);
		fakes.macos.command.mockResolvedValueOnce({ pid: 8, windowId: "nope" });
		assert.deepEqual(await macosBackend.getFrontmost(), { appName: "Unknown App", bundleId: undefined, pid: 8, windowTitle: undefined, windowId: undefined });
		for (const bad of [{ pid: 0 }, { pid: -1 }, {}, undefined]) {
			fakes.macos.command.mockResolvedValueOnce(bad);
			await rejectsWith(macosBackend.getFrontmost(), /No frontmost app was available/);
		}
	});

	test("normalizeTarget emits windowId only when positive and prefers windowRef over rootRef", () => {
		assert.deepEqual(normalizeTarget({ pid: 1, windowId: 4.9, rootRef: "r", windowRef: "w" }), { pid: 1, windowId: 4, windowRef: "w" });
		assert.deepEqual(normalizeTarget({ pid: 1, windowId: 0, rootRef: "r" }), { pid: 1, windowRef: "r" });
		assert.deepEqual(normalizeTarget({ pid: 1, windowId: Number.NaN }), { pid: 1 });
	});

	test("delegations forward arguments to the helper commands", async () => {
		const options = { timeoutMs: 5, signal };
		fakes.macos.command.mockResolvedValue({ ok: 1 });
		assert.deepEqual(await macosBackend.focusWindow({ pid: 1, rootRef: "r" }, signal), { ok: 1 });
		assert.deepEqual(lastCall(fakes.macos), ["focusWindow", { pid: 1, windowRef: "r" }, { signal }]);

		fakes.macos.command.mockResolvedValueOnce({ lookId: "L1" });
		const look = await macosBackend.observe({ target: { pid: 1, rootRef: "r" }, baseLookId: "b", maxDimension: 9, readText: "auto", scopeRef: "s", includeImage: false }, options);
		assert.equal(look.lookId, "L1");
		assert.deepEqual(lastCall(fakes.macos), ["look", { baseLookId: "b", pid: 1, windowRef: "r", maxDimension: 9, readText: "auto", scopeRef: "s", includeImage: false }, options]);

		const plain = { target: { pid: 1 }, action: "click" };
		const focus = { target: { focus: { pid: 2 } }, params: { x: 1 } };
		await macosBackend.act(plain, options);
		let [command, args, passed] = lastCall(fakes.macos);
		assert.equal(command, "act");
		assert.deepEqual(args.target, { pid: 1 });
		assert.equal(args.cursorOverlay, getComputerUseConfig().cursor_overlay);
		assert.deepEqual(args.blockedBundleIds, effectiveBlockedBundleIds());
		assert.ok(args.blockedBundleIds.length > 0);
		assert.equal(passed, options);
		await macosBackend.act(focus);
		args = lastCall(fakes.macos)[1];
		assert.deepEqual(args.target, { pid: 2 });
		assert.deepEqual(args.params, { x: 1, preserveFocus: true });

		await macosBackend.actBatch([plain, focus], options);
		[command, args, passed] = lastCall(fakes.macos);
		assert.equal(command, "actBatch");
		assert.equal(args.actions.length, 2);
		assert.deepEqual(args.actions[1].params, { x: 1, preserveFocus: true });
		assert.deepEqual(args.actions[0].blockedBundleIds, args.actions[1].blockedBundleIds);
		assert.equal(passed, options);

		await macosBackend.readText({ rootRef: "r", offset: 1 }, options);
		assert.deepEqual(lastCall(fakes.macos), ["axReadText", { rootRef: "r", offset: 1 }, options]);
		await macosBackend.waitFor({ pid: 1, rootRef: "r", windowId: 3 }, options);
		assert.deepEqual(lastCall(fakes.macos), ["axWaitFor", { pid: 1, windowId: 3, windowRef: "r" }, options]);
	});

	test("shutdown closes the glow and setActivity toggles it", async () => {
		await macosBackend.shutdown();
		assert.equal(fakes.glow.close.mock.calls.length, 1);
		await macosBackend.setActivity(true);
		assert.deepEqual(fakes.glow.setActive.mock.calls, [[true]]);
	});
});

describe("Windows backend", () => {
	const backend = platformBackendForRuntime("win32");

	test("classifies browsers from process names", () => {
		const table = [
			["chrome.exe", "chrome"], ["Chromium", "chrome"], ["msedge.EXE", "edge"], ["edge", "edge"], ["brave", "brave"], ["brave-browser", "brave"],
			["firefox.exe", "firefox"], ["vivaldi", "vivaldi"], ["opera", "opera"], ["opera_gx.exe", "opera"], ["notepad.exe", false],
		];
		for (const [name, kind] of table) {
			assert.equal(backend.isBrowserApp(name), kind !== false, name);
			assert.equal(backend.isChromeFamilyApp(name), ["chrome", "edge", "brave"].includes(kind), name);
		}
	});

	test("listRoots parses payload variants and filters by title", async () => {
		fakes.windows.command.mockResolvedValue({ roots: [
			{ kind: "dialog", ref: "ref1", processName: "Word.exe", pid: 4.4, bounds: { x: 1, y: 2, width: 30, height: 40 }, title: " Report ", isFocused: true, scaleFactor: 1.5, metadata: { a: 1 } },
			{ kind: "sheet", windowRef: "w2", framePoints: { x: 5, y: 6, w: 7, h: 8 }, isOnscreen: false, isMain: false, isFocused: true },
			null,
		] });
		const roots = await backend.listRoots({ pid: 9.7 }, signal);
		assert.deepEqual(lastCall(fakes.windows), ["listRoots", { pid: 9 }, { signal }]);
		assert.deepEqual(roots[0], {
			kind: "dialog", rootRef: "ref1", windowRef: "ref1", windowId: undefined, pid: 4, appName: "Word.exe", bundleId: undefined, title: " Report ",
			role: undefined, subrole: undefined, zOrder: 0, framePoints: { x: 1, y: 2, w: 30, h: 40 }, scaleFactor: 1.5, isOnscreen: true,
			isFocused: true, isMinimized: false, isMain: true, isModal: false, metadata: { a: 1 },
		});
		assert.equal(roots[1].kind, "window");
		assert.equal(roots[1].isOnscreen, false);
		assert.equal(roots[1].isMain, false);
		assert.equal(roots[1].zOrder, 1);
		assert.equal(roots[1].windowRef, "w2");
		assert.equal(roots[2].kind, "window");
		assert.deepEqual(roots[2].framePoints, { x: 0, y: 0, w: 1, h: 1 });
		assert.deepEqual((await backend.listRoots({ title: "REPORT" })).map((r) => r.rootRef), ["ref1"]);
		assert.equal((await backend.listRoots({ title: "  " })).length, 3);
		assert.equal((await backend.listRoots({ title: "absent" })).length, 0);
		assert.deepEqual(lastCall(fakes.windows)[1], {});
		for (const kind of ["menu", "popover", "window"]) {
			fakes.windows.command.mockResolvedValueOnce([{ kind }]);
			assert.equal((await backend.listRoots({}))[0].kind, kind);
		}
		for (const bad of [undefined, {}, { roots: 0 }]) {
			fakes.windows.command.mockResolvedValueOnce(bad);
			assert.deepEqual(await backend.listRoots({}), []);
		}
	});

	test("listApps dedupes by pid and getFrontmost picks the focused root", async () => {
		fakes.windows.command.mockResolvedValue([
			{ pid: 1, appName: "A", bundleId: "a.id", title: "t1" },
			{ pid: 1, appName: "A dup" },
			{ appName: "no pid" },
			{ pid: 2, isFocused: true, title: "t2", windowId: 8, rootRef: "r2" },
		]);
		assert.deepEqual(await backend.listApps(signal), [
			{ appName: "A", bundleId: "a.id", pid: 1, isFrontmost: false },
			{ appName: "Unknown", bundleId: undefined, pid: 2, isFrontmost: true },
		]);
		assert.deepEqual(lastCall(fakes.windows), ["listRoots", {}, { signal }]);
		assert.deepEqual(await backend.getFrontmost(), { appName: "Unknown", bundleId: undefined, pid: 2, windowTitle: "t2", windowId: 8, rootRef: "r2" });
		fakes.windows.command.mockResolvedValue([{ pid: 3, appName: "First", title: "x" }]);
		assert.equal((await backend.getFrontmost()).appName, "First");
		for (const roots of [[], [{ title: "no pid" }]]) {
			fakes.windows.command.mockResolvedValue(roots);
			await rejectsWith(backend.getFrontmost(), /No frontmost window was available\./);
		}
	});

	test("ensureReady validates protocol and architecture then stamps the state", async () => {
		fakes.windows.command.mockResolvedValue(diagnostics());
		const state = await backend.ensureReady({}, { lastPermissionCheckAt: 0, keep: true }, signal);
		assert.equal(state.keep, true);
		assert.ok(state.lastPermissionCheckAt > 0);
		assert.equal(state.helperDiagnostics.protocolVersion, 4);
		assert.deepEqual(lastCall(fakes.windows), ["diagnostics", {}, { signal, timeoutMs: 5_000 }]);
		fakes.windows.command.mockResolvedValue(diagnostics({ protocolVersion: 3 }));
		await rejectsWith(backend.ensureReady({}, { lastPermissionCheckAt: 0 }), /expected 4, got 3/);
		fakes.windows.command.mockResolvedValue(undefined);
		await rejectsWith(backend.ensureReady({}, { lastPermissionCheckAt: 0 }), /got unknown/);
		fakes.windows.command.mockResolvedValue(diagnostics({ architectureVersion: 0 }));
		await rejectsWith(backend.ensureReady({}, { lastPermissionCheckAt: 0 }), /Windows helper architecture mismatch/);
	});

	test("delegations forward arguments to the helper commands", async () => {
		const options = { timeoutMs: 5, signal };
		fakes.windows.command.mockResolvedValue({ lookId: "W1" });
		backend.shutdown();
		assert.equal(fakes.windows.dispose.mock.calls.length, 1);
		await backend.focusWindow({ pid: 1 }, signal);
		assert.deepEqual(lastCall(fakes.windows), ["focusWindow", { pid: 1 }, { signal }]);
		const look = await backend.observe({ target: { pid: 1 }, baseLookId: "b", maxDimension: 9, readText: "never", scopeRef: "s", includeImage: true }, options);
		assert.equal(look.lookId, "W1");
		assert.deepEqual(lastCall(fakes.windows), ["look", { pid: 1, baseLookId: "b", maxDimension: 9, readText: "never", scopeRef: "s", includeImage: true }, options]);
		const plain = { target: { pid: 1 }, action: "click" };
		const focus = { target: { focus: { pid: 2 } }, params: { y: 1 } };
		await backend.act(plain, options);
		assert.deepEqual(lastCall(fakes.windows), ["act", plain, options]);
		await backend.act(focus);
		assert.deepEqual(lastCall(fakes.windows)[1], { target: { pid: 2 }, params: { y: 1, preserveFocus: true } });
		await backend.actBatch([plain, focus], options);
		assert.deepEqual(lastCall(fakes.windows), ["actBatch", { actions: [plain, { target: { pid: 2 }, params: { y: 1, preserveFocus: true } }] }, options]);
		await backend.readText({ rootRef: "r" }, options);
		assert.deepEqual(lastCall(fakes.windows), ["uiaReadText", { rootRef: "r" }, options]);
		await backend.waitFor({ rootRef: "r" }, options);
		assert.deepEqual(lastCall(fakes.windows), ["uiaWaitFor", { rootRef: "r" }, options]);
		assert.equal(await backend.openBrowserLocation({ appName: "chrome" }, "https://x.test", signal), true);
		assert.deepEqual(lastCall(fakes.windows), ["openBrowserLocation", { appName: "chrome", url: "https://x.test" }, { signal, timeoutMs: 10_000 }]);
	});
});

describe("Linux backend", () => {
	const backend = platformBackendForRuntime("linux");
	const noWsl = { env: () => ({}), hasInteropEntry: () => false, procVersion: () => "Linux version 6 generic" };
	const original = { ...wslProbe };
	beforeEach(() => {
		Object.assign(wslProbe, noWsl);
		return () => Object.assign(wslProbe, original);
	});

	test("classifies browsers from process and desktop names", () => {
		const chromium = ["chrome", "/usr/bin/google-chrome-stable", "chromium-browser.desktop", "microsoft-edge", "brave", "vivaldi-stable", "opera"];
		for (const name of chromium) {
			assert.equal(backend.isBrowserApp(name), true, name);
			assert.equal(backend.isChromeFamilyApp(name), true, name);
		}
		for (const name of ["firefox", "firefox-esr"]) {
			assert.equal(backend.isBrowserApp(name), true, name);
			assert.equal(backend.isChromeFamilyApp(name), false, name);
		}
		assert.equal(backend.isBrowserApp("gedit"), false);
	});

	test("listRoots parses payload variants, filters by title and hints on empty", async () => {
		fakes.linux.command.mockResolvedValue({ roots: [
			{ kind: "sheet", desktopId: "org.gnome.Gedit", processName: "gedit", pid: 3, title: "Notes", bounds: { x: 1, y: 2, width: 3, height: 4 }, isFocused: true },
			{ kind: "nope", ref: "r2", isOnscreen: false },
			null,
		] });
		const roots = await backend.listRoots({ pid: 1.2 }, signal);
		assert.deepEqual(lastCall(fakes.linux), ["listRoots", { pid: 1 }, { signal }]);
		assert.equal(roots[0].kind, "sheet");
		assert.equal(roots[0].bundleId, "org.gnome.Gedit");
		assert.equal(roots[0].appName, "gedit");
		assert.deepEqual(roots[0].framePoints, { x: 1, y: 2, w: 3, h: 4 });
		assert.equal(roots[0].isMain, true);
		assert.equal(roots[1].kind, "window");
		assert.equal(roots[1].rootRef, "r2");
		assert.equal(roots[1].isOnscreen, false);
		assert.equal(roots[1].zOrder, 1);
		assert.deepEqual((await backend.listRoots({ title: "note" })).map((r) => r.rootRef), [undefined]);
		assert.equal((await backend.listRoots({ title: "  " })).length, 3);
		assert.deepEqual(lastCall(fakes.linux)[1], {});
		for (const kind of ["menu", "dialog", "popover"]) {
			fakes.linux.command.mockResolvedValueOnce([{ kind }]);
			assert.equal((await backend.listRoots({}))[0].kind, kind);
		}
		for (const bad of [undefined, {}, { roots: "x" }]) {
			fakes.linux.command.mockResolvedValueOnce(bad);
			assert.deepEqual(await backend.listRoots({}), []);
		}
		assert.equal(backend.emptyRootsHint(), undefined);
	});

	test("listApps dedupes by pid and getFrontmost explains empty and pid-less roots", async () => {
		fakes.linux.command.mockResolvedValue([{ pid: 1, appName: "A" }, { pid: 1 }, { pid: 2, isFocused: true, title: "t", windowId: 4, rootRef: "r" }, { title: "none" }]);
		assert.deepEqual(await backend.listApps(signal), [
			{ appName: "A", bundleId: undefined, pid: 1, isFrontmost: false },
			{ appName: "Unknown", bundleId: undefined, pid: 2, isFrontmost: true },
		]);
		assert.deepEqual(await backend.getFrontmost(), { appName: "Unknown", bundleId: undefined, pid: 2, windowTitle: "t", windowId: 4, rootRef: "r" });
		fakes.linux.command.mockResolvedValue([{ pid: 5, appName: "First" }]);
		assert.equal((await backend.getFrontmost()).appName, "First");
		fakes.linux.command.mockResolvedValue([{ title: "no pid" }]);
		await rejectsWith(backend.getFrontmost(), (error) => error.message === "No frontmost window was available.");
		fakes.linux.command.mockResolvedValue([]);
		await rejectsWith(backend.getFrontmost(), (error) => error.message === "No frontmost window was available.");
		Object.assign(wslProbe, { env: () => ({ WSL_DISTRO_NAME: "Ubuntu" }) });
		await rejectsWith(backend.getFrontmost(), /No frontmost window was available\. Running under WSL2/);
		fakes.linux.command.mockResolvedValue([{ title: "no pid" }]);
		await rejectsWith(backend.getFrontmost(), (error) => error.message === "No frontmost window was available.");
		assert.match(backend.emptyRootsHint(), /WSL2/);
	});

	test("ensureReady validates protocol, architecture and accessibility", async () => {
		fakes.linux.command.mockResolvedValue(diagnostics());
		const state = await backend.ensureReady({}, { lastPermissionCheckAt: 0, keep: 1 }, signal);
		assert.equal(state.keep, 1);
		assert.ok(state.lastPermissionCheckAt > 0);
		assert.deepEqual(lastCall(fakes.linux), ["diagnostics", {}, { signal, timeoutMs: 5_000 }]);
		fakes.linux.command.mockResolvedValue(diagnostics({ protocolVersion: 9 }));
		await rejectsWith(backend.ensureReady({}, { lastPermissionCheckAt: 0 }), /expected 4, got 9/);
		fakes.linux.command.mockResolvedValue(undefined);
		await rejectsWith(backend.ensureReady({}, { lastPermissionCheckAt: 0 }), /got unknown/);
		fakes.linux.command.mockResolvedValue(diagnostics({ invariants: [] }));
		await rejectsWith(backend.ensureReady({}, { lastPermissionCheckAt: 0 }), /Linux helper does not satisfy/);
		fakes.linux.command.mockResolvedValue(diagnostics({ accessibility: false }));
		await rejectsWith(backend.ensureReady({}, { lastPermissionCheckAt: 0 }), /AT-SPI/);
		fakes.linux.command.mockResolvedValue(diagnostics({ accessibility: undefined }));
		await backend.ensureReady({}, { lastPermissionCheckAt: 0 });
	});

	test("delegations forward arguments to the helper commands", async () => {
		const options = { timeoutMs: 5, signal };
		fakes.linux.command.mockResolvedValue({ lookId: "X1" });
		backend.shutdown();
		assert.equal(fakes.resetLinux.mock.calls.length, 1);
		await backend.focusWindow({ pid: 1 }, signal);
		assert.deepEqual(lastCall(fakes.linux), ["focusWindow", { pid: 1 }, { signal }]);
		const look = await backend.observe({ target: { pid: 1 }, baseLookId: "b", maxDimension: 9, readText: "always", scopeRef: "s", includeImage: false }, options);
		assert.equal(look.lookId, "X1");
		assert.deepEqual(lastCall(fakes.linux), ["look", { pid: 1, baseLookId: "b", maxDimension: 9, readText: "always", scopeRef: "s", includeImage: false }, options]);
		const plain = { target: { pid: 1 }, action: "click" };
		const focus = { target: { focus: { pid: 2 } }, params: { y: 1 } };
		await backend.act(plain, options);
		assert.deepEqual(lastCall(fakes.linux), ["act", plain, options]);
		await backend.act(focus);
		assert.deepEqual(lastCall(fakes.linux)[1], { target: { pid: 2 }, params: { y: 1, preserveFocus: true } });
		await backend.actBatch([plain, focus], options);
		assert.deepEqual(lastCall(fakes.linux), ["actBatch", { actions: [plain, { target: { pid: 2 }, params: { y: 1, preserveFocus: true } }] }, options]);
		await backend.readText({ rootRef: "r" }, options);
		assert.deepEqual(lastCall(fakes.linux), ["atspiReadText", { rootRef: "r" }, options]);
		await backend.waitFor({ rootRef: "r" }, options);
		assert.deepEqual(lastCall(fakes.linux), ["atspiWaitFor", { rootRef: "r" }, options]);
		assert.equal(await backend.openBrowserLocation({ appName: "firefox" }, "https://x.test", signal), true);
		assert.deepEqual(lastCall(fakes.linux), ["openBrowserLocation", { appName: "firefox", url: "https://x.test" }, { signal, timeoutMs: 10_000 }]);
	});
});

describe("platform facade", () => {
	test("selects the backend per runtime platform", () => {
		assert.equal(platformBackendForRuntime("darwin").name, "macos");
		assert.equal(platformBackendForRuntime("win32").name, "windows");
		assert.equal(platformBackendForRuntime("linux").name, "linux");
	});

	test("the macOS facade delegates every operation to the macOS backend", async () => {
		const backend = platformBackendForRuntime("darwin");
		fakes.macos.command.mockResolvedValue([]);
		await backend.shutdown();
		await backend.setActivity(false);
		assert.deepEqual(fakes.glow.setActive.mock.calls, [[false]]);
		await backend.listApps();
		await backend.listRoots({});
		fakes.macos.command.mockResolvedValue({ pid: 1, lookId: "L" });
		await backend.getFrontmost();
		await backend.focusWindow({ pid: 1 });
		await backend.observe({ target: { pid: 1 } });
		await backend.act({ target: { pid: 1 } });
		await backend.actBatch([]);
		await backend.readText({});
		await backend.waitFor({});
		assert.deepEqual(fakes.macos.command.mock.calls.map(([command]) => command), [
			"listApps", "listRoots", "getFrontmost", "focusWindow", "look", "act", "actBatch", "axReadText", "axWaitFor",
		]);
		assert.equal(backend.isBrowserApp("Safari"), true);
		assert.equal(backend.isChromeFamilyApp("Safari"), false);
		assert.equal(backend.isChromeFamilyApp("Google Chrome"), true);
		assert.equal(await backend.openBrowserLocation({ appName: "Firefox" }, "https://x.test"), false);
	});

	test("an unsupported platform rejects every operation naming the platform", async () => {
		const backend = platformBackendForRuntime("freebsd");
		assert.equal(backend.name, "linux");
		const message = /does not support platform 'freebsd' yet\./;
		for (const method of ["ensureReady", "listApps", "listRoots", "getFrontmost", "focusWindow", "observe", "act", "readText", "waitFor", "openBrowserLocation"]) {
			await rejectsWith(backend[method](), message);
		}
		assert.throws(() => backend.isBrowserApp("x"), message);
		assert.throws(() => backend.isChromeFamilyApp("x"), message);
	});
});
