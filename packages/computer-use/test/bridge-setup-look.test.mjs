// `src/bridge.ts` setup, root discovery, target resolution (selector/current/frontmost) and look, via the public tool executors (nredd/pi-harness#709, Refs #645).
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { cdpTabForWindow, listCdpPageContexts } from "../src/cdp.ts";
import * as bridge from "../src/bridge.ts";
import { currentPlatformBackend } from "../src/platform/index.ts";
import { parseLookResponse, serializeOutline } from "../src/outline.ts";
import { desktopRoot, installFakeDesktop, lookPayload, wireButton } from "./support/fake-desktop.mjs";

vi.mock("../src/cdp.ts", async (importOriginal) => ({ ...(await importOriginal()), cdpTabForWindow: vi.fn(async () => undefined), listCdpPageContexts: vi.fn(async () => []) }));

const { executeFind, executeObserve, executeAct, executeInspectUi, executeSearchUi, executeExpandUi, executeWaitFor } = bridge;
const stateOf = (result) => result.details.capture.stateId;

/** The default root: pid 7 `App` / `Main`; `windowRef` and `rootRef` move together unless `rootRef` is given. */
const makeRoot = (over = {}) => {
	const windowRef = "windowRef" in over ? over.windowRef : "ax:w11";
	return desktopRoot({ pid: 7, appName: "App", bundleId: "com.example.app", windowId: 11, zOrder: 0, isFocused: true, windowRef, rootRef: "rootRef" in over ? over.rootRef : windowRef, ...over });
};
const makeNode = (ref, over = {}) => wireButton(ref, over.title ?? ref, over);

let fake;

const call = (executor, params, signal) => fake.call(executor, params, signal);
const textOf = (result) => fake.text(result);
const makeCtx = () => fake.ctx;

beforeEach(async ({ onTestFinished }) => {
	fake = await installFakeDesktop(onTestFinished, { roots: [makeRoot()] });
	fake.frontmost = { appName: "App", bundleId: "com.example.app", pid: 7 };
	fake.tree = ["a", "b", "c"].map((ref) => makeNode(ref));
	fake.image = { jpegBase64: "AAAA", mimeType: "image/jpeg", width: 300, height: 200 };
	await bridge.shutdownComputerUseSession();
});

afterEach(async () => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	cdpTabForWindow.mockReset();
	listCdpPageContexts.mockReset();
	await bridge.shutdownComputerUseSession();
});

describe("setup", () => {
	test("activity toggles reach the backend and tolerate a backend without one", async () => {
		await bridge.setComputerUseActivity(true);
		await bridge.setComputerUseActivity(false);
		assert.deepEqual(fake.activity, [true, false]);
		delete currentPlatformBackend.setActivity;
		await bridge.setComputerUseActivity(true);
		assert.deepEqual(fake.activity, [true, false]);
	});

	test("ensureComputerUseSetup readies the backend, refuses an aborted signal, and diagnostics reach results", async () => {
		await bridge.ensureComputerUseSetup(makeCtx());
		assert.equal(fake.readyCalls, 1);
		const abort = new AbortController();
		abort.abort();
		await assert.rejects(() => bridge.ensureComputerUseSetup(makeCtx(), abort.signal), /Operation aborted\./);
		assert.equal(fake.readyCalls, 1, "an aborted setup must not reach the backend");
		fake.diagnostics = { note: "diag" };
		const result = await call(executeObserve, {});
		assert.deepEqual(result.details.helper, { note: "diag" });
	});

	test("act and search without a prior observation say to observe first", async () => {
		await assert.rejects(() => call(executeAct, { actions: [{ action: "press", ref: "@e2" }] }), /No observation state is available\. Call observe_ui first\./);
		await assert.rejects(() => call(executeSearchUi, { text: "a" }), /No observation state is available/);
		await assert.rejects(() => call(executeAct, { stateId: "nope", actions: [] }), /State 'nope' is unavailable or was evicted/);
	});
});

describe("find_roots", () => {
	const pairingRoot = (over, pairing, sheetCount) => makeRoot({ ...over, metadata: { pairing, sheetCount } });

	test("formats ids, flags, pairing, policy and browser state per root", async () => {
		vi.stubEnv("PI_COMPUTER_USE_BROWSER_USE", "0");
		fake.browserApps.add("Surf");
		fake.roots = [
				pairingRoot({}, { confidence: "exact", score: 95.4 }, 2.9),
				pairingRoot({ windowId: undefined, windowRef: "ax:dlg", kind: "dialog", isModal: true, isFocused: false, isMain: false, isMinimized: true, isOnscreen: false, zOrder: 3 }, { confidence: "low" }, -4),
				pairingRoot({ windowId: undefined, windowRef: undefined, title: "", zOrder: 4, isFocused: false, isMain: false }, { confidence: "weird" }, Number.NaN),
				pairingRoot({ windowId: 12, windowRef: "ax:w12", zOrder: 5, isFocused: false, isMain: false }, "bogus"),
				pairingRoot({ windowId: 13, windowRef: "ax:w13", zOrder: 6, isFocused: false, isMain: false }, { confidence: "high", score: 80 }),
				makeRoot({ windowId: 14, windowRef: "ax:w14", title: "Quiet", zOrder: 9, isFocused: false, isMain: false, isOnscreen: false }),
			makeRoot({ pid: 8, appName: "Vault", bundleId: "com.apple.keychainaccess", windowId: 21, windowRef: "ax:v", title: "Keys", zOrder: 7 }),
			makeRoot({ pid: 9, appName: "Surf", bundleId: "com.example.surf", windowId: 31, windowRef: "ax:s", title: "Page", zOrder: 8 }),
		];
		const result = await call(executeFind, { app: undefined, bundleId: "" });
		const lines = textOf(result).split("\n");
		assert.match(lines[0], /^Found 8 matching roots; returned 8\./);
		const line = (needle) => lines.find((entry) => entry.includes(needle));
		assert.match(line("— Main (z 0"), /windowId 11, frame 0,0 300x200, pairing exact\/95, focused, main, sheets=2, onscreen\)$/);
		assert.match(line("nativeRootRef ax:dlg"), /dialog App pid 7 — Main \(z 3, nativeRootRef ax:dlg, frame 0,0 300x200, pairing low\/-Infinity, modal, minimized\)$/);
		assert.match(line("unstable root id"), /— \(untitled\) \(z 4, unstable root id, frame 0,0 300x200, onscreen\)$/);
		assert.match(line("windowId 12"), /z 5, windowId 12, frame 0,0 300x200, onscreen\)$/, "non-object pairing is dropped");
		assert.match(line("windowId 13"), /pairing high\/80, onscreen\)$/);
		assert.match(line("— Quiet"), /\(z 9, windowId 14, frame 0,0 300x200\)$/, "no flags, no trailing comma");
		assert.match(line("Vault pid 8"), /onscreen, blocked\)$/);
		assert.match(line("Surf pid 9"), /onscreen, browser_use_disabled\)$/);
		const byId = new Map(result.details.windows.map((window) => [window.windowId ?? window.nativeWindowRef ?? "none", window]));
		assert.equal(byId.get(11).sheetCount, 2);
		assert.equal(byId.get("ax:dlg").sheetCount, 0, "negative sheet counts clamp to 0");
		assert.equal(byId.get("none").sheetCount, undefined);
		assert.equal(byId.get(21).blocked, true);
		assert.equal(byId.get(31).browserUseAllowed, false);
	});

	test("without filters it lists every platform root, skipping pid-less ones and naming anonymous apps", async () => {
		fake.roots = [makeRoot({ pid: 0, windowId: 40, windowRef: "ax:z" }), makeRoot({ pid: 5, appName: undefined, windowId: 50, windowRef: "ax:w50" })];
		const text = textOf(await call(executeFind, {}));
		assert.match(text, /Found 1 matching root;/);
		assert.match(text, /Unknown App pid 5/);
	});

	test("app, bundle, pid and kind filters narrow by exact normalized match", async () => {
		fake.apps = [
			{ appName: "App", pid: 7, bundleId: "com.example.app" },
			{ appName: "Other", pid: 8 },
		];
		fake.roots = [makeRoot(), makeRoot({ pid: 8, appName: "Other", bundleId: undefined, windowId: 21, windowRef: "ax:o", title: "Side", kind: "dialog", isFocused: false, zOrder: 1 })];
		const found = async (query) => (await call(executeFind, query)).details.windows.map((window) => window.pid);
		assert.deepEqual(await found({ app: " APP " }), [7]);
		assert.deepEqual(await found({ bundleId: "COM.EXAMPLE.APP" }), [7]);
		assert.deepEqual(await found({ pid: 8 }), [8]);
		assert.deepEqual(await found({ kind: "dialog", app: "other" }), [8]);
		assert.deepEqual(await found({ pid: 7, app: "Other" }), []);
		assert.deepEqual(await found({ pid: 99 }), []);
		assert.deepEqual(await found({ bundleId: "com.example.app", app: "Other" }), []);
		assert.deepEqual(await found({ bundleId: "com.missing" }), []);
	});

	test("empty results explain themselves and surface the platform hint", async () => {
		const filtered = textOf(await call(executeFind, { app: "Missing" }));
		assert.equal(filtered, "No roots matched the supplied filters.");
		fake.roots = [];
		assert.equal(textOf(await call(executeFind, {})), "No roots are currently visible to pi-computer-use.");
		currentPlatformBackend.emptyRootsHint = () => "Grant access.";
		assert.equal(textOf(await call(executeFind, {})), "No roots are currently visible to pi-computer-use. Grant access.");
		assert.equal(textOf(await call(executeFind, { text: "x" })), "No roots matched the supplied filters. Grant access.");
	});

	test("browser pages from CDP are listed with their url, and a failing CDP listing is ignored", async () => {
		listCdpPageContexts.mockResolvedValueOnce([
			{ contextId: "browser:p1", title: "Docs", url: "https://example.com/docs" },
			{ contextId: "browser:p2", title: "", url: "about:blank" },
		]);
		const result = await call(executeFind, { app: "browser" });
		const lines = textOf(result).split("\n");
		assert.ok(lines.includes('- @r1 browser_page "Docs" — https://example.com/docs'), lines.join("\n"));
		assert.ok(lines.includes('- @r2 browser_page "about:blank" — about:blank'));
		assert.deepEqual(result.details.windows.map((window) => window.kind), ["browser_page", "browser_page"]);
		listCdpPageContexts.mockResolvedValueOnce([{ contextId: "browser:p3", title: "", url: "" }]);
		assert.ok(textOf(await call(executeFind, { app: "browser" })).split("\n").includes('- @r3 browser_page ""'));
		listCdpPageContexts.mockRejectedValueOnce(new Error("cdp down"));
		assert.equal(textOf(await call(executeFind, { app: "browser" })), "No roots matched the supplied filters.");
		vi.stubEnv("PI_COMPUTER_USE_BROWSER_USE", "0");
		listCdpPageContexts.mockClear();
		await call(executeFind, { app: "browser" });
		assert.equal(listCdpPageContexts.mock.calls.length, 0, "browser_use off must not list pages");
	});

	test("repeat discovery reuses a root's @r ref", async () => {
		const first = await call(executeFind, { app: "App" });
		const second = await call(executeFind, { app: "App" });
		assert.equal(first.details.windows[0].windowRef, "@r1");
		assert.equal(second.details.windows[0].windowRef, "@r1");
	});
});

describe("observe selection by @r ref", () => {
	test("observes the discovered root and records its identity", async () => {
		await call(executeFind, { app: "App" });
		const result = await call(executeObserve, { root: "@r1", mode: "semantic" });
		assert.equal(result.details.target.windowRef, "@r1");
		assert.match(textOf(result), /^Observed semantic @r1 App — Main\./);
		assert.deepEqual(fake.looks[0].target, { pid: 7, windowId: 11, rootRef: "ax:w11", windowRef: "ax:w11" });
	});

	test("rejects non-@r selectors and refs this session never issued", async () => {
		await assert.rejects(() => call(executeObserve, { root: "Main" }), /exact @r ref issued by find_roots/);
		for (const root of [11, 0, null, false]) {
			await assert.rejects(() => call(executeObserve, { root }), /exact @r ref issued by find_roots/, `a direct caller's ${root} root must not fall back to the frontmost window`);
		}
		await assert.rejects(() => call(executeObserve, { root: "@r9" }), /Root ref '@r9' is not available in this session\. Call find_roots first\./);
		assert.equal(fake.looks.length, 0);
	});

	test("re-finds a moved root by window id, native ref, then title, and calls a vanished one stale", async () => {
		fake.roots = [makeRoot({ windowId: undefined, windowRef: "ax:n", title: "Native" }), makeRoot({ windowId: 12, windowRef: "ax:w12", title: "Byid", zOrder: 1, isFocused: false })];
		const found = await call(executeFind, {});
		const ref = (title) => found.details.windows.find((window) => window.windowTitle === title).windowRef;
		// by windowId: the ref'd root changed native ref and title but kept its id
		fake.roots = [makeRoot({ windowId: 12, windowRef: "ax:renamed", title: "Retitled" })];
		assert.equal((await call(executeObserve, { root: ref("Byid"), mode: "semantic" })).details.target.windowId, 12);
		// by native ref: no windowId on the ref, title changed
		fake.roots = [makeRoot({ windowId: 55, windowRef: "ax:n", title: "Changed" })];
		assert.equal((await call(executeObserve, { root: ref("Native"), mode: "semantic" })).details.target.windowId, 55);
		// by title: new id and native ref
		fake.roots = [makeRoot({ windowId: 66, windowRef: "ax:fresh", title: "  native " })];
		assert.equal((await call(executeObserve, { root: ref("Native"), mode: "semantic" })).details.target.windowId, 66);
		fake.roots = [makeRoot({ windowId: 77, windowRef: "ax:else", title: "Else" })];
		await assert.rejects(() => call(executeObserve, { root: ref("Native") }), /is stale\. Call find_roots again and choose a current window\./);
	});

	test("an untitled ref falls back to the (untitled) title match", async () => {
		fake.roots = [makeRoot({ windowId: undefined, windowRef: "ax:u", title: "" })];
		await call(executeFind, {});
		fake.roots = [makeRoot({ windowId: 88, windowRef: "ax:u2", title: "" })];
		assert.equal((await call(executeObserve, { root: "@r1", mode: "semantic" })).details.target.windowId, 88);
	});

	test("a ref to a root with no stable id falls back to its title", async () => {
		fake.roots = [makeRoot({ windowId: undefined, windowRef: undefined, title: "Loose" })];
		await call(executeFind, {});
		fake.roots = [makeRoot({ windowId: 90, windowRef: "ax:fresh", title: "Loose" })];
		assert.equal((await call(executeObserve, { root: "@r1", mode: "semantic" })).details.target.windowId, 90);
	});

	test("re-selecting the current root re-resolves it through the current-target path", async () => {
		await call(executeFind, {});
		const first = await call(executeObserve, { root: "@r1", mode: "semantic" });
		fake.roots = [makeRoot({ windowId: 11, windowRef: "ax:moved" })];
		const again = await call(executeObserve, { root: "@r1", mode: "semantic", stateId: stateOf(first) });
		assert.equal(again.details.target.nativeWindowRef, "ax:moved");
	});

	test("a blocked or browser-disabled ref is refused before any capture", async () => {
		vi.stubEnv("PI_COMPUTER_USE_BLOCKED_APPS", "com.example.vault");
		fake.apps = [{ appName: "Vault", pid: 8, bundleId: "com.example.vault" }];
		fake.roots = [makeRoot({ pid: 8, appName: "Vault", bundleId: "com.example.vault", windowId: 21, windowRef: "ax:v" })];
		await call(executeFind, {});
		await assert.rejects(() => call(executeObserve, { root: "@r1" }), /app_blocked: 'Vault' \(com\.example\.vault\) is blocked by pi-computer-use policy/);
		vi.stubEnv("PI_COMPUTER_USE_BROWSER_USE", "0");
		fake.browserApps.add("Surf");
		fake.apps = [{ appName: "Surf", pid: 9, bundleId: "com.example.surf" }];
		fake.roots = [makeRoot({ pid: 9, appName: "Surf", bundleId: "com.example.surf", windowId: 31, windowRef: "ax:s" })];
		await call(executeFind, {});
		await assert.rejects(() => call(executeObserve, { root: "@r2" }), /Browser use is disabled by pi-computer-use config, so 'Surf' cannot be controlled/);
		assert.equal(fake.looks.length, 0);
	});
});

describe("observe frontmost resolution", () => {
	const two = () => {
		fake.roots = [
			makeRoot({ windowId: 11, windowRef: "ax:a", title: "Alpha", isFocused: true }),
			makeRoot({ windowId: 12, windowRef: "ax:b", title: "Beta", isFocused: false, isMain: false, zOrder: 1 }),
		];
	};
	const observedTitle = async () => (await call(executeObserve, { mode: "semantic" })).details.target.windowTitle;

	test("prefers the frontmost window id, then its title, then the best-scored root", async () => {
		two();
		fake.frontmost = { appName: "App", bundleId: "com.example.app", pid: 7, windowId: 12, windowTitle: "Alpha" };
		assert.equal(await observedTitle(), "Beta");
		fake.frontmost = { appName: "App", bundleId: "com.example.app", pid: 7, windowTitle: " beta " };
		assert.equal(await observedTitle(), "Beta");
		fake.frontmost = { appName: "App", bundleId: "com.example.app", pid: 7, windowId: 999, windowTitle: "Gone" };
		assert.equal(await observedTitle(), "Alpha");
		fake.frontmost = { appName: "App", bundleId: "com.example.app", pid: 7 };
		assert.equal(await observedTitle(), "Alpha");
	});

	test("an app the platform did not list is described by the frontmost report", async () => {
		fake.apps = [];
		fake.frontmost = { appName: "Ghost", pid: 7 };
		const result = await call(executeObserve, { mode: "semantic" });
		assert.equal(result.details.target.app, "Ghost");
		assert.equal(result.details.target.bundleId, undefined);
	});

	test("no frontmost root is a readable error", async () => {
		fake.roots = [];
		await assert.rejects(() => call(executeObserve, {}), /No frontmost controllable root was found\. Open an app window and call observe_ui again\./);
	});

	test("a frontmost browser obeys browser_use and a frontmost blocked app fails closed", async () => {
		fake.browserApps.add("App");
		vi.stubEnv("PI_COMPUTER_USE_BROWSER_USE", "0");
		await assert.rejects(() => call(executeObserve, {}), /Browser use is disabled/);
		vi.stubEnv("PI_COMPUTER_USE_BROWSER_USE", "1");
		assert.equal((await call(executeObserve, { mode: "semantic" })).details.tool, "observe_ui");
		vi.stubEnv("PI_COMPUTER_USE_BLOCKED_APPS", "COM.EXAMPLE.APP");
		fake.looks.length = 0;
		await assert.rejects(() => call(executeObserve, {}), /app_blocked: 'App' \(com\.example\.app\) is blocked/);
		assert.equal(fake.looks.length, 0, "a blocked app must never be captured");
	});

	test("a frontmost root without a stable id is unobservable", async () => {
		fake.roots = [makeRoot({ windowId: undefined, windowRef: undefined })];
		await assert.rejects(() => call(executeObserve, {}), /The current controlled window is no longer available\. Call observe_ui to choose a new target window\.$/);
	});
});

describe("observe with a saved state re-resolves the current root", () => {
	/** Observe once, return the state id to hydrate later. */
	const seed = async (roots, extra = {}) => {
		fake.roots = roots;
		const first = await call(executeObserve, { mode: "semantic", ...extra });
		fake.looks.length = 0;
		return stateOf(first);
	};
	const again = async (stateId) => await call(executeObserve, { mode: "semantic", stateId });

	test("tracks the root by native ref, then by window id", async () => {
		const byRef = await seed([makeRoot({ windowId: 11, windowRef: "ax:a" })]);
		fake.roots = [makeRoot({ windowId: 12, windowRef: "ax:a", title: "New" })];
		assert.equal((await again(byRef)).details.target.windowId, 12);
		const byId = await seed([makeRoot({ windowId: 21, windowRef: undefined, title: "Same" })]);
		fake.roots = [makeRoot({ windowId: 21, windowRef: undefined, title: "Other title" })];
		assert.equal((await again(byId)).details.target.windowTitle, "Other title");
	});

	test("with only a title to go on: one exact match wins, ties break by score or fail with candidates", async () => {
		const stateId = await seed([makeRoot({ windowId: undefined, windowRef: "ax:a", title: "Doc" })]);
		fake.roots = [makeRoot({ windowId: undefined, windowRef: "ax:b", title: " doc " }), makeRoot({ windowId: undefined, windowRef: "ax:c", title: "Zzz", zOrder: 1 })];
		assert.equal((await again(stateId)).details.target.nativeWindowRef, "ax:b");
		// two exact titles separated by >= 25 points: the clearly better one wins
		fake.roots = [makeRoot({ windowId: undefined, windowRef: "ax:d", title: "Doc", isFocused: false, isMain: false }), makeRoot({ windowId: undefined, windowRef: "ax:e", title: "Doc", zOrder: 1 })];
		assert.equal((await again(stateId)).details.target.nativeWindowRef, "ax:e");
		// within 25 points: refuse and say which candidates compete, best first
		fake.roots = [
			makeRoot({ windowId: undefined, windowRef: "ax:f", title: "Doc", isMinimized: true, isOnscreen: false }),
			makeRoot({ windowId: undefined, windowRef: "ax:g", title: "Doc", isMinimized: true, isOnscreen: false, isFocused: true, isMain: true, zOrder: 2 }),
			makeRoot({ windowId: undefined, windowRef: "ax:h", title: "Doc", isMinimized: true, isOnscreen: false, isFocused: false, isMain: false, zOrder: 3 }),
			makeRoot({ windowId: undefined, windowRef: "ax:i", title: "Doc", isMinimized: false, isOnscreen: true, isFocused: false, isMain: false, zOrder: 4 }),
			makeRoot({ windowId: undefined, windowRef: "ax:j", title: "Doc", isMinimized: true, isOnscreen: false, isFocused: false, isMain: false, zOrder: 5 }),
		];
		await assert.rejects(() => again(stateId), (error) => {
			assert.match(error.message, /Multiple windows now match 'Doc': Doc \[score=182, focused,main,minimized\]; Doc \[score=182, focused,main,minimized\]; Doc \[score=62, onscreen\]; Doc \[score=2, minimized\]; Doc \[score=2, minimized\]\./);
			return true;
		});
		const flagless = makeRoot({ windowId: undefined, windowRef: "ax:k", title: "Doc", isMinimized: false, isOnscreen: false, isFocused: false, isMain: false });
		fake.roots = [flagless, { ...flagless, windowRef: "ax:l" }];
		await assert.rejects(() => again(stateId), /Doc \[score=42\]; Doc \[score=42\]\./);
	});

	test("without a stable id or title match it falls back to the single or clearly best root", async () => {
		const stateId = await seed([makeRoot({ windowId: undefined, windowRef: "ax:a", title: "" })]);
		fake.roots = [makeRoot({ windowId: undefined, windowRef: "ax:solo", title: "Renamed" })];
		assert.equal((await again(stateId)).details.target.nativeWindowRef, "ax:solo");
		fake.roots = [makeRoot({ windowId: undefined, windowRef: "ax:p", title: "P", isFocused: false, isMain: false }), makeRoot({ windowId: undefined, windowRef: "ax:q", title: "Q", zOrder: 1 })];
		assert.equal((await again(stateId)).details.target.nativeWindowRef, "ax:q");
		fake.roots = [makeRoot({ windowId: undefined, windowRef: "ax:r", title: "R" }), makeRoot({ windowId: undefined, windowRef: "ax:s", title: "S", zOrder: 1 })];
		await assert.rejects(() => again(stateId), /The current controlled window is no longer available/);
	});

	test("a window that disappeared, or one whose id vanished with no stable replacement, is gone", async () => {
		const stateId = await seed([makeRoot()]);
		fake.roots = [];
		await assert.rejects(() => again(stateId), /no longer available/);
		fake.roots = [makeRoot({ windowId: 99, windowRef: "ax:other", title: "Other" })];
		await assert.rejects(() => again(stateId), /no longer available/);
		const untitled = await seed([makeRoot({ windowId: undefined, windowRef: "ax:u", title: "Fixed" })]);
		fake.roots = [makeRoot({ windowId: undefined, windowRef: undefined, title: "Fixed" })];
		await assert.rejects(() => again(untitled), /no longer available/);
	});

	test("a confirmed foreground modal replaces the root, but only for observe", async () => {
		const stateId = await seed([makeRoot()]);
		fake.roots = [makeRoot(), makeRoot({ windowId: 12, windowRef: "ax:m", title: "Sheet", kind: "dialog", isModal: true, isFocused: true, isMain: false, zOrder: -1 })];
		assert.equal((await again(stateId)).details.target.windowTitle, "Sheet");
		await call(executeAct, { stateId, actions: [{ action: "press", ref: "@e2" }] });
		assert.equal(fake.actCalls.at(-1).pid, 7);
		assert.equal(fake.looks.at(-1).target.windowId, 11, "act stays on the root its state belongs to");
	});

	test("with several foreground modals the best-scored one wins", async () => {
		const stateId = await seed([makeRoot()]);
		const modal = (windowRef, windowId, over) => makeRoot({ windowId, windowRef, title: windowRef, kind: "dialog", isModal: true, isFocused: true, isMain: false, zOrder: -1, ...over });
		fake.roots = [makeRoot(), modal("ax:m1", 12, { isFocused: false, zOrder: -2 }), modal("ax:m2", 13, {}), modal("ax:m3", 14, { isFocused: false, zOrder: -3 })];
		assert.equal((await again(stateId)).details.target.windowTitle, "ax:m2");
	});

	test("a state whose app became blocked is refused without a native call", async () => {
		const stateId = await seed([makeRoot()]);
		vi.stubEnv("PI_COMPUTER_USE_BLOCKED_APPS", "com.example.app");
		await assert.rejects(() => again(stateId), /app_blocked: 'App' \(com\.example\.app\)/);
		await assert.rejects(() => call(executeAct, { stateId, actions: [{ action: "press", ref: "@e2" }] }), /app_blocked/);
		assert.equal(fake.looks.length, 0);
		assert.equal(fake.actCalls.length, 0);
	});

	test("browser use turned off after the state was taken refuses the state", async () => {
		const stateId = await seed([makeRoot()]);
		fake.browserApps.add("App");
		vi.stubEnv("PI_COMPUTER_USE_BROWSER_USE", "0");
		await assert.rejects(() => again(stateId), /Browser use is disabled/);
	});
});

describe("stable ids that only appear on re-resolution", () => {
	test("an unstable frontmost root is re-resolved once and observed when the retry is stable", async () => {
		let listings = 0;
		fake.listRootsHook = () => {
			listings++;
			return listings === 1 ? [makeRoot({ windowId: undefined, windowRef: undefined, title: "Settling" })] : [makeRoot({ windowId: 70, windowRef: "ax:settled", title: "Settling" })];
		};
		const result = await call(executeObserve, { mode: "semantic" });
		assert.equal(result.details.target.windowId, 70);
		assert.equal(fake.looks[0].target.windowId, 70);
	});
});

describe("wait_for, search_ui and restored or browser states", () => {
	test("wait_for re-resolves the current root and refreshes the capture, keeping stable refs", async () => {
		const stateId = stateOf(await call(executeObserve, { mode: "semantic" }));
		fake.waitFor = async () => ({ found: true, nodeCount: 4 });
		const waited = await call(executeWaitFor, { stateId, text: "a", timeoutMs: 100 });
		assert.equal(waited.details.found, true);
		assert.equal(fake.looks.at(-1).maxDimension, 900);
		assert.equal(fake.looks.at(-1).includeImage, true);
		assert.notEqual(waited.details.stateId, stateId);
		// the root's window id changes while waiting: the refresh follows it by native ref
		fake.waitFor = async () => {
			fake.roots = [makeRoot({ windowId: 12 })];
			return { found: true };
		};
		await call(executeWaitFor, { stateId: waited.details.stateId, text: "a", timeoutMs: 100 });
		assert.equal(fake.looks.at(-1).target.windowId, 12);
	});

	test("search_ui with no matches re-captures the root with OCR and an image", async () => {
		const stateId = stateOf(await call(executeObserve, { mode: "semantic" }));
		await call(executeSearchUi, { stateId, text: "nothing-like-this" });
		const request = fake.looks.at(-1);
		assert.equal(request.readText, "always");
		assert.equal(request.includeImage, true);
	});

	test("a browser state has no desktop target to re-capture, so search reports no matches", async () => {
		const snapshot = { contextId: "browser:ctx", snapshotId: "B1", targetId: "t", title: "Page", url: "about:blank", capturedAt: 0, text: "", targets: [], outline: serializeOutline(parseLookResponse(lookPayload()).parsedOutline), diagnostics: { cdp: "connected", targetCount: 1 } };
		bridge.testing.runInOperation(() => bridge.testing.browserObservationResult(snapshot, "cdp:t", 0, "observe_ui"));
		const result = await call(executeSearchUi, { stateId: "B1", text: "nothing-like-this" });
		assert.equal(result.details.totalMatches, 0);
		assert.match(textOf(result), /^Found 0 outline matches; returned 0\./);
	});

	test("a restored state without a root ref still names stale refs, without a root hint", async () => {
		const observed = await call(executeObserve, { mode: "semantic" });
		const details = structuredClone(observed.details);
		delete details.target.windowRef;
		bridge.reconstructStateFromBranch({ ...makeCtx(), sessionManager: { getBranch: () => [{ type: "message", message: { role: "toolResult", toolName: "observe_ui", details } }] } });
		await assert.rejects(() => call(executeAct, { stateId: stateOf(observed), actions: [{ action: "press", ref: "@e99" }] }), (error) => {
			assert.match(error.message, /^Outline ref '@e99' is stale or not available for the latest state\. Call observe_ui again and choose a current @e ref\./);
			return true;
		});
	});
});

describe("look and result building", () => {
	const children = (count, over = {}) => Array.from({ length: count }, (_, index) => makeNode(`n${index}`, over));
	const observe = async (payload, params = {}) => {
		fake.lookPayload = () => payload;
		return await call(executeObserve, params);
	};
	const images = (result) => result.content.filter((block) => block.type === "image");

	test("semantic mode never requests an image; visual always attaches one", async () => {
		const semantic = await observe(lookPayload({ image: false }), { mode: "semantic" });
		assert.equal(fake.looks[0].includeImage, false);
		assert.equal(fake.looks[0].readText, "never");
		assert.equal(images(semantic).length, 0);
		assert.equal(semantic.details.imageReason, undefined);
		const visual = await observe(lookPayload(), { mode: "visual" });
		assert.equal(fake.looks[1].maxDimension, 1600);
		assert.equal(fake.looks[1].readText, "always");
		assert.equal(visual.details.imageReason, "fallback_recovery");
		assert.equal(images(visual).length, 1);
		assert.match(textOf(visual), /An image was requested explicitly for visual verification\./);
		const noImage = await observe(lookPayload({ image: false }), { mode: "visual" });
		assert.equal(images(noImage).length, 0, "no image to attach on an outline-only root");
	});

	test("fused mode attaches an image only when the tree is sparse or mostly unlabeled", async () => {
		const sparse = await observe(lookPayload({ children: children(1) }), {});
		assert.equal(fake.looks[0].maxDimension, 900);
		assert.equal(sparse.details.imageReason, "sparse_ax_targets");
		assert.equal(images(sparse).length, 1);
		const bare = await observe(lookPayload({ children: children(6, { title: "", label: "" }) }), {});
		assert.equal(bare.details.imageReason, "unlabeled_ax_targets");
		const rich = await observe(lookPayload({ children: children(4) }), {});
		assert.equal(rich.details.imageReason, undefined);
		assert.equal(images(rich).length, 0);
	});

	test("compact detail lists controls, outline detail folds the tree, and the view names the state", async () => {
		const compact = await observe(lookPayload({ children: children(4, { canPress: true }) }), { mode: "semantic" });
		assert.match(textOf(compact), /^Observed semantic @r1 App — Main\. Returned the latest outline state\.\n[\s\S]*\n\nControls \(4 of 5 nodes/);
		assert.equal(compact.details.view, "full");
		assert.match(textOf(compact), new RegExp(`stateId ${stateOf(compact)}`));
		const outline = await observe(lookPayload({ children: children(4) }), { mode: "semantic", detail: "outline" });
		assert.match(textOf(outline), /\n\nOutline \(5 nodes, stateId /);
		assert.equal(outline.details.detail, "outline");
	});

	test("the controls footer counts the unlabeled controls it hides", async () => {
		const unlabeled = (count) => Array.from({ length: count }, (_, index) => makeNode(`u${index}`, { title: "", label: "", canPress: true }));
		const one = await observe(lookPayload({ children: [...children(3, { canPress: true }), ...unlabeled(1)] }), { mode: "semantic" });
		assert.match(textOf(one), /including 1 unlabeled control\./);
		const many = await observe(lookPayload({ children: [...children(3, { canPress: true }), ...unlabeled(3)] }), { mode: "semantic" });
		assert.match(textOf(many), /including 3 unlabeled controls\./);
	});

	test("a view with no actionable controls says so, and an oversized fold reports truncation", async () => {
		const passive = await observe(lookPayload({ children: children(4, { actions: [], canPress: false }) }), { mode: "semantic" });
		assert.match(textOf(passive), /Outline \(5 nodes, stateId [0-9a-f-]{36}, no actionable controls found\)/);
		const huge = await observe(lookPayload({ children: children(1200, { actions: [], title: "x".repeat(40), label: "x".repeat(40) }) }), { mode: "semantic", detail: "outline" });
		assert.match(textOf(huge), /folded output truncated\)/);
	});

	test("chrome-family targets surface drained console output", async () => {
		fake.chromeApps.add("App");
		const drained = vi.fn(() => [{ level: "log", text: "hi" }, { level: "error", text: "boom" }]);
		cdpTabForWindow.mockResolvedValueOnce({ drainConsole: drained });
		const withConsole = await call(executeObserve, { mode: "semantic" });
		assert.deepEqual(withConsole.details.console, [{ level: "log", text: "hi" }, { level: "error", text: "boom" }]);
		assert.match(textOf(withConsole), /Browser console since the last action:\n\[log\] hi\n\[error\] boom/);
		assert.equal(cdpTabForWindow.mock.calls.at(-1)[0], "Main");
		cdpTabForWindow.mockResolvedValueOnce({ drainConsole: () => [] });
		assert.equal((await call(executeObserve, { mode: "semantic" })).details.console, undefined);
		cdpTabForWindow.mockResolvedValueOnce(undefined);
		assert.equal((await call(executeObserve, { mode: "semantic" })).details.console, undefined);
	});

	test("buildToolResult diffs against a base outline, notes browser waits and defaults an image's mime type", async () => {
		const target = { appName: "App", bundleId: "com.example.app", pid: 7, windowTitle: "Main", windowId: 11, windowRef: "@r1", framePoints: { x: 0, y: 0, w: 1, h: 1 }, scaleFactor: 1 };
		const capture = { stateId: "state-2", width: 300, height: 200, scaleFactor: 1, timestamp: 1 };
		const resultFor = (payload, mutate) => {
			const look = parseLookResponse(payload);
			mutate?.(look);
			return { target, capture, look, outline: look.parsedOutline, activation: { activated: false, unminimized: false, raised: false } };
		};
		const baseResult = resultFor(lookPayload({ lookId: "base", children: children(4) }));
		const next = resultFor(lookPayload({ lookId: "next", children: children(4).map((node, index) => (index === 2 ? { ...node, value: "changed", title: "changed", label: "changed" } : node)) }));
		const execution = { strategy: "look", runtimeMode: "default", variant: "default", stealthCompatible: false };
		const run = (tool, result, base) => bridge.testing.runInOperation(() => bridge.testing.buildToolResult(tool, "Summary.", result, execution, undefined, "auto", base), {});
		const defaulted = await bridge.testing.runInOperation(() => bridge.testing.buildToolResult("observe_ui", "Summary.", baseResult, execution), { currentImageMode: "never" });
		assert.equal(defaulted.details.imageReason, undefined, "the operation's image mode applies when none is passed");
		assert.equal((await bridge.testing.runInOperation(() => bridge.testing.buildToolResult("observe_ui", "Summary.", resultFor(lookPayload({ children: [] })), execution), {})).details.imageReason, "sparse_ax_targets", "auto when the operation has none");
		const diff = await run("observe_ui", next, { stateId: "state-1", outline: baseResult.outline });
		assert.equal(diff.details.view, "diff");
		assert.equal(diff.details.baseStateId, "state-1");
		assert.match(textOf(diff), /Changes \(\d+, state-1 → state-2\):/);
		const same = await run("observe_ui", baseResult, { stateId: "state-1", outline: baseResult.outline });
		assert.match(textOf(same), /\(no element changes\)/);
		fake.browserApps.add("App");
		const waited = await run("wait", baseResult);
		assert.equal(waited.details.imageReason, "browser_wait_verification");
		fake.browserApps.clear();
		assert.equal((await run("wait", baseResult)).details.imageReason, undefined);
		const sparse = resultFor(lookPayload({ children: [] }), (look) => {
			delete look.image.mimeType;
		});
		assert.equal((await run("observe_ui", sparse)).content.find((block) => block.type === "image").mimeType, "image/jpeg");
	});
});

describe("delivery, headless mode and settle", () => {
	const press = async () => {
		const observed = await call(executeObserve, { mode: "semantic" });
		return await call(executeAct, { stateId: stateOf(observed), actions: [{ action: "press", ref: "@e2" }] });
	};

	test("a semantic press goes out as background pid delivery", async () => {
		await press();
		assert.equal(fake.actCalls[0].policy, "background");
		assert.equal(fake.actCalls[0].params.delivery, "pid");
	});

	test("headless mode batches AX-only delivery and settles 120 ms unless the helper reports a delta source", async () => {
		vi.stubEnv("PI_COMPUTER_USE_HEADLESS", "1");
		fake.actBatchResult = { outcome: "worked", performed: { delivery: "ax", transaction: true, actionCount: 1 }, steps: [{ outcome: "worked", performed: { delivery: "ax" } }] };
		const timer = vi.spyOn(globalThis, "setTimeout");
		const result = await press();
		assert.equal(fake.actBatchCalls[0][0].policy, "ax_only");
		assert.equal(result.details.execution.runtimeMode, "stealth");
		assert.ok(timer.mock.calls.some((entry) => entry[1] === 120));
		timer.mockClear();
		fake.actBatchResult = { ...fake.actBatchResult, performed: { delivery: "ax", transaction: true, actionCount: 1, deltaSource: "ax" } };
		await press();
		assert.deepEqual(timer.mock.calls.map((entry) => entry[1]).filter((ms) => ms === 280 || ms === 120), []);
	});

	test("foreground-capable acts settle 280 ms", async () => {
		const timer = vi.spyOn(globalThis, "setTimeout");
		await press();
		assert.ok(timer.mock.calls.some((entry) => entry[1] === 280));
	});
});

describe("outline node helpers through inspect, act and expand", () => {
	const rich = () => lookPayload({
		children: [
			makeNode("a", { subrole: "AXSecure", identifier: "login", title: "Login", label: "Login", canSetValue: true, canPress: true, canFocus: true, canScroll: true, canIncrement: true }),
			makeNode("b", { title: "", label: "", canDecrement: true, pictureOnly: true }),
			makeNode("c", { title: "Group", label: "Group", truncated: true, children: [] }),
		],
	});

	test("inspect_ui labels every capability and an unlabeled picture", async () => {
		fake.lookPayload = rich;
		const stateId = stateOf(await call(executeObserve, { mode: "semantic" }));
		const first = textOf(await call(executeInspectUi, { stateId, ref: "@e2" }));
		assert.match(first, /^@e2 AXButton\/AXSecure id="login" "Login" \[setValue,press,focus,scroll,adjust\]/);
		const picture = textOf(await call(executeInspectUi, { stateId, ref: "@e3" }));
		assert.match(picture, /^@e3 AXButton "\(unlabeled\)" \[adjust,pictureOnly\]/);
	});

	test("a picture-only node is clicked at its centre and cannot be read or expanded semantically", async () => {
		fake.lookPayload = () => lookPayload({ children: [makeNode("pic", { pictureOnly: true, title: "", label: "", actions: [], truncated: true })] });
		const stateId = stateOf(await call(executeObserve, { mode: "semantic" }));
		await call(executeAct, { stateId, actions: [{ action: "click", ref: "@e2" }] });
		assert.deepEqual(fake.actCalls[0].target, { x: 35, y: 20 });
		await assert.rejects(() => call(executeExpandUi, { stateId, ref: "@e2" }), /Outline ref '@e2' is pictureOnly and has no semantic element\. It can be clicked by coordinates/);
	});

	test("expanding a truncated node grafts rect-less children that cannot be clicked", async () => {
		fake.lookPayload = (request) => request.scopeRef === "c"
			? lookPayload({ image: false, children: [makeNode("deep", { pictureOnly: true, actions: [], title: "Deep", label: "Deep" }), makeNode("deep2", { title: "Two", label: "Two" })] })
			: rich();
		const stateId = stateOf(await call(executeObserve, { mode: "semantic" }));
		const expanded = await call(executeExpandUi, { stateId, ref: "@e4" });
		assert.match(textOf(expanded), /Deep/);
		await assert.rejects(() => call(executeAct, { stateId, actions: [{ action: "click", ref: "@e5" }] }), /has no full-look coordinates after scoped expansion\. Re-observe for coordinates\./);
	});

	test("a stale ref names the root to re-observe", async () => {
		const stateId = stateOf(await call(executeObserve, { mode: "semantic" }));
		await call(executeFind, {});
		await assert.rejects(() => call(executeAct, { stateId, actions: [{ action: "press", ref: "@e99" }] }), /Outline ref '@e99' is stale or not available for the latest state\. Call observe_ui\(\{ root: "@r1" \}\) again/);
	});
});

describe("coordinates are checked against the look image", () => {
	const click = async (look, action) => {
		fake.lookPayload = () => look;
		const stateId = stateOf(await call(executeObserve, { mode: "semantic" }));
		return await call(executeAct, { stateId, actions: [action] });
	};

	test("outside the image is refused with the image size", async () => {
		await assert.rejects(() => click(lookPayload(), { action: "click", x: 300, y: 5 }), /Coordinates \(300,5\) are outside the latest look image bounds \(300x200\)\. Call observe_ui again and retry\./);
		await assert.rejects(() => click(lookPayload(), { action: "click", x: -1, y: 5 }), /outside the latest look image bounds/);
		await assert.rejects(() => click(lookPayload(), { action: "click", x: 5, y: 200 }), /outside the latest look image bounds/);
		assert.equal(fake.actCalls.length, 0);
	});

	test("an outline-only root cannot take coordinates", async () => {
		await assert.rejects(() => click(lookPayload({ image: false }), { action: "click", x: 5, y: 5 }), /Coordinates require an image-bearing root\. This look is outline-only/);
	});

	test("a non-finite drag vertex is named by its position", async () => {
		await assert.rejects(() => click(lookPayload(), { action: "drag", path: [{ x: 1, y: 1 }, { x: "nope", y: 2 }] }), /Drag point 2 must be finite numbers\./);
	});

	test("an in-bounds click is delivered", async () => {
		const result = await click(lookPayload(), { action: "click", x: 299, y: 199 });
		assert.equal(fake.actCalls[0].target.x, 299);
		assert.match(textOf(result), /Executed 1 checked UI action/);
	});
});

describe("reconstructStateFromBranch restores discovered roots", () => {
	test("window flags are strict booleans and unknown values are dropped", async () => {
		const entry = (windows) => ({ type: "message", message: { role: "toolResult", toolName: "find_roots", details: { tool: "find_roots", windows } } });
		const ctx = { ...makeCtx(), sessionManager: { getBranch: () => [entry([
			{ windowRef: "@r4", pid: 7, app: "App", windowTitle: "Main", windowId: 11, isMinimized: "yes", isOnscreen: true, isMain: 1, isFocused: true },
			{ windowRef: 5, pid: 7 },
		])] } };
		bridge.reconstructStateFromBranch(ctx);
		const observed = await call(executeObserve, { root: "@r4", mode: "semantic" });
		assert.equal(observed.details.target.windowId, 11);
	});
});
