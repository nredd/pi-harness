// `src/bridge.ts` act delivery (request building, retries, root deltas), find_roots listing and read_text, via the public executors (nredd/pi-harness#710, Refs #645).
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import * as bridge from "../src/bridge.ts";
import { currentPlatformBackend } from "../src/platform/index.ts";
import { cdpClickForContext, cdpKeypressForContext, cdpNavigateContext, cdpSnapshotForContext, listCdpPageContexts } from "../src/cdp.ts";
import { parseLookResponse } from "../src/outline.ts";
import { desktopRoot, installFakeDesktop, lookPayload, wireButton, wireNode } from "./support/fake-desktop.mjs";
import { browserSnapshot } from "./support/fake-browser.mjs";

vi.mock("../src/cdp.ts", async (importOriginal) => ({
	...(await importOriginal()),
	listCdpPageContexts: vi.fn(async () => []),
	cdpSnapshotForContext: vi.fn(async () => undefined),
	cdpNavigateContext: vi.fn(async () => true),
	cdpClickForContext: vi.fn(async () => true),
	cdpKeypressForContext: vi.fn(async () => true),
}));

const { executeFind, executeObserve, executeAct, executeReadText, executeNavigateBrowser } = bridge;
const textField = (ref, extra = {}) => wireNode(ref, "AXTextField", ref, { canSetValue: true, isTextInput: true, actions: ["AXPress"], ...extra });

let fake;

const call = (executor, params, signal) => fake.call(executor, params, signal);

/** Observe the fake window and return its state id. */
const observe = async () => (await fake.observe()).stateId;
const act = async (actions, extra = {}) => await call(executeAct, { stateId: await observe(), actions, ...extra });
const policies = () => fake.actCalls.map((request) => request.policy);

/** Pin `process.platform`: the macOS-only actions are refused up front on every other host. */
const withPlatform = async (platform, fn) => {
	const original = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", { ...original, value: platform });
	try {
		return await fn();
	} finally {
		Object.defineProperty(process, "platform", original);
	}
};

beforeEach(async ({ onTestFinished }) => {
	fake = await installFakeDesktop(onTestFinished, { roots: [desktopRoot({ pid: 1 })] });
	fake.tree = [wireButton("go", "Go", { actions: ["AXPress", "AXShowMenu"] }), textField("name"), wireNode("pane", "AXScrollArea", "Pane", { actions: [] }), wireNode("form", "AXGroup", "Form", { actions: ["AXPress"], children: [textField("inner")] })];
	fake.image = { jpegBase64: "AAAA", mimeType: "image/jpeg", width: 300, height: 200 };
	await bridge.shutdownComputerUseSession();
});

afterEach(async () => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	listCdpPageContexts.mockReset();
	cdpSnapshotForContext.mockReset();
	await bridge.shutdownComputerUseSession();
});

describe("act request building", () => {
	test("every action maps onto its wire params with the delivery of its policy", async () => {
		await act([
			{ action: "setText", ref: "@e3", text: "hello" },
			{ action: "typeText", ref: "@e3", text: "typed" },
			{ action: "keypress", ref: "@e3", keys: ["cmd+a"] },
			{ action: "scroll", ref: "@e4", scrollY: 40 },
			{ action: "drag", path: [{ x: 1, y: 1 }, [20, 20]] },
			{ action: "moveMouse", x: 5, y: 6 },
		]);
		assert.deepEqual(fake.actCalls.map((request) => [request.action, request.params]), [
			["setText", { text: "hello", delivery: "pid" }],
			["typeText", { text: "typed", delivery: "pid" }],
			["keypress", { keys: ["cmd+a"], delivery: "pid" }],
			["scroll", { scrollX: 0, scrollY: 40, delivery: "pid" }],
			["drag", { path: [{ x: 1, y: 1 }, { x: 20, y: 20 }], delivery: "pid" }],
			["moveMouse", { delivery: "pid" }],
		]);
		assert.ok(fake.actCalls.every((request) => request.pid === 1 && request.policy === "background"));
	});

	test("paste, selectText and secondaryAction are implemented by the macOS backend only", async () => {
		const actions = [
			{ action: "paste", ref: "@e3", text: "clip" },
			{ action: "selectText", ref: "@e3", start: 1, length: 2 },
			{ action: "secondaryAction", ref: "@e2", name: "AXShowMenu" },
		];
		await withPlatform("darwin", async () => {
			for (const action of actions) await act([action]);
		});
		assert.deepEqual(fake.actCalls.map((request) => [request.action, request.params]), [
			["paste", { text: "clip", delivery: "pid" }],
			["selectText", { start: 1, length: 2, delivery: "pid" }],
			["secondaryAction", { name: "AXShowMenu", delivery: "pid" }],
		]);
		assert.equal(fake.actCalls.every((request) => request.policy === "background"), true);
		fake.actCalls.length = 0;
		await withPlatform("linux", async () => {
			for (const action of actions) {
				await assert.rejects(() => act([action]), (error) => error.code === "unsupported_command" && error.message.startsWith(`${action.action} is not supported on linux`));
			}
		});
		assert.equal(fake.actCalls.length, 0, "an unsupported action never reaches the backend");
	});

	test("strict headless mode refuses synthesized keyboard input on macOS before delivery", async () => {
		vi.stubEnv("PI_COMPUTER_USE_HEADLESS", "1");
		await withPlatform("darwin", async () => {
			for (const action of [{ action: "typeText", ref: "@e3", text: "x" }, { action: "paste", ref: "@e3", text: "x" }, { action: "keypress", keys: ["a"] }]) {
				await assert.rejects(() => act([action]), new RegExp(`${action.action} requires synthesized keyboard input, which strict headless mode prohibits \\(foreground_required\\)`));
			}
		});
		assert.equal(fake.actCalls.length + fake.actBatchCalls.length, 0);
	});

	test("long text widens the transport budget past the command timeout", async () => {
		const budgets = [];
		fake.actHook = (_request, options) => void budgets.push(options.timeoutMs);
		await act([{ action: "press", ref: "@e2" }, { action: "setText", ref: "@e3", text: "x".repeat(10_000) }]);
		assert.equal(budgets[1], 10_000 * 25 + 4_000);
		assert.ok(budgets[0] < budgets[1], "a press uses the plain command timeout");
	});

	test("a helper reply without a valid outcome is rejected", async () => {
		fake.actHook = () => ({ performed: { delivery: "pid" } });
		await assert.rejects(() => act([{ action: "press", ref: "@e2" }]), /Helper act returned an invalid result without an outcome\./);
		fake.actHook = () => ({ outcome: "maybe" });
		await assert.rejects(() => act([{ action: "press", ref: "@e2" }]), /Helper act returned an invalid result without an outcome\./);
	});
});

describe("delivery policy and foreground retries", () => {
	test("typing into the focus a click established is foreground input under the desktop lock", async () => {
		const result = await act([{ action: "click", ref: "@e5" }, { action: "typeText", text: "hi" }]);
		assert.deepEqual(policies(), ["background", "foreground"]);
		assert.equal(fake.actCalls[1].params.delivery, "hid");
		const [click, type] = result.details.execution.steps;
		assert.equal(click.backgroundFirst, true);
		assert.equal(type.backgroundFirst, false, "focus-dependent input skips the background attempt");
		assert.equal(type.deliveryPolicy, "foreground");
	});

	test("a coordinate click needs the foreground and later keyboard actions follow it", async () => {
		await act([{ action: "click", x: 10, y: 10 }, { action: "keypress", keys: ["return"] }]);
		assert.deepEqual(policies(), ["foreground", "foreground"]);
	});

	test("a background typeText that changed nothing is retried once in the foreground", async () => {
		let attempts = 0;
		fake.actHook = () => (++attempts === 1 ? { outcome: "didnt", performed: { delivery: "pid" } } : { outcome: "worked", performed: { delivery: "cgevent" } });
		const result = await act([{ action: "typeText", ref: "@e3", text: "hi" }]);
		assert.deepEqual(policies(), ["background", "foreground"]);
		const [step] = result.details.execution.steps;
		assert.equal(step.escalatedToForeground, true);
		assert.equal(step.escalationReason, "side_effect_free_didnt");
		assert.deepEqual(step.backgroundAttempt, { outcome: "didnt", reason: "Background input produced no observable value change; a foreground retry was safe." });
		assert.equal(step.backgroundFirst, true);
	});

	test("a failed keypress is retried, but a failed paste is never repeated", async () => {
		fake.actHook = () => ({ outcome: "didnt", performed: { delivery: "pid" } });
		await act([{ action: "keypress", ref: "@e3", keys: ["a"] }]);
		assert.deepEqual(policies(), ["background", "foreground"]);
		fake.actCalls.length = 0;
		await withPlatform("darwin", () => act([{ action: "paste", ref: "@e3", text: "once" }]));
		assert.deepEqual(policies(), ["background"], "a slow target may still paste, so a retry could insert twice");
	});

	test("foreground_required from the background attempt escalates and records why", async () => {
		const refused = Object.assign(new Error("needs the foreground"), { code: "foreground_required" });
		fake.actHook = (request) => {
			if (request.policy === "background") throw refused;
			return { outcome: "worked", performed: { delivery: "cgevent" } };
		};
		const result = await act([{ action: "press", ref: "@e2" }]);
		assert.deepEqual(policies(), ["background", "foreground"]);
		const [step] = result.details.execution.steps;
		assert.equal(step.escalationReason, "foreground_required");
		assert.deepEqual(step.backgroundAttempt, { outcome: "foreground_required", reason: "needs the foreground" });
	});

	test("a non-Error foreground_required rejection is reported by its string form", async () => {
		fake.actHook = (request) => {
			if (request.policy === "background") throw Object.assign(Object.create(null), { code: "foreground_required", toString: () => "plain" });
			return { outcome: "worked", performed: { delivery: "cgevent" } };
		};
		const result = await act([{ action: "press", ref: "@e2" }]);
		assert.equal(result.details.execution.steps[0].backgroundAttempt.reason, "plain");
	});

	test("coded helper refusals other than foreground_required are never retried", async () => {
		for (const code of ["app_blocked", "screen_locked", undefined]) {
			fake.actCalls.length = 0;
			fake.actHook = () => {
				throw Object.assign(new Error(`${code}: refused`), { code });
			};
			await assert.rejects(() => act([{ action: "press", ref: "@e2" }]), new RegExp(`${code}: refused`));
			assert.deepEqual(policies(), ["background"], `${code} must not escalate to foreground input`);
		}
	});

	test("without a batch backend, headless acts go out AX-only and never escalate", async () => {
		vi.stubEnv("PI_COMPUTER_USE_HEADLESS", "1");
		delete currentPlatformBackend.actBatch;
		await act([{ action: "press", ref: "@e2" }]);
		assert.deepEqual(policies(), ["ax_only"]);
		fake.actHook = () => {
			throw Object.assign(new Error("needs the foreground"), { code: "foreground_required" });
		};
		await assert.rejects(() => act([{ action: "press", ref: "@e2" }]), /needs the foreground/);
		assert.deepEqual(policies(), ["ax_only", "ax_only"], "strict headless never takes the foreground");
		fake.actHook = () => ({ outcome: "didnt" });
		await withPlatform("linux", () => act([{ action: "keypress", ref: "@e3", keys: ["a"] }]));
		assert.equal(policies().length, 3, "a headless didnt is not retried");
	});

	test("a didnt step stops the transaction", async () => {
		fake.actHook = (request) => (request.action === "press" ? { outcome: "didnt", performed: { delivery: "pid" } } : undefined);
		const result = await act([{ action: "press", ref: "@e2" }, { action: "setText", ref: "@e3", text: "never" }]);
		assert.deepEqual(fake.actCalls.map((request) => request.action), ["press"]);
		assert.equal(result.details.execution.outcome, "didnt");
	});
});

describe("root deltas", () => {
	test("appeared, closed and focused roots are summarised with titles, flags and refs", async () => {
		fake.actResult = {
			outcome: "worked",
			performed: { delivery: "pid" },
			rootDelta: [
				{ change: "appeared", kind: "dialog", title: "Save", ref: "ax:d1", isModal: true, metadata: { sheetCount: 2.9 } },
				{ change: "closed", kind: "sheet", ref: "@r8" },
				{ change: "focused", kind: "window", title: "Main", metadata: { sheetCount: Number.NaN } },
			],
		};
		const text = fake.text(await act([{ action: "press", ref: "@e2" }]));
		assert.match(text, /New root: dialog "Save" \(modal, sheets=2\)\n/);
		assert.match(text, /Root closed: sheet \(@r8\)/);
		assert.match(text, /Root focused: window "Main"(?! \()/);
	});
});

describe("root delta rendering seam", () => {
	test("a native ref that was not normalised to an @r ref is still shown with its @ prefix", async () => {
		const look = parseLookResponse(lookPayload());
		const result = { target: { appName: "App", bundleId: "com.example.app", pid: 7, windowTitle: "Main", windowId: 11, windowRef: "@r1", framePoints: { x: 0, y: 0, w: 1, h: 1 }, scaleFactor: 1 }, capture: { stateId: "s", width: 300, height: 200, scaleFactor: 1, timestamp: 1 }, look, outline: look.parsedOutline, activation: { activated: false, unminimized: false, raised: false } };
		const execution = { strategy: "act", runtimeMode: "default", variant: "default", stealthCompatible: false, rootDelta: [{ change: "appeared", kind: "dialog", pid: 7, ref: "ax:d1" }, { change: "focused", kind: "window", pid: 7, ref: "@r4" }] };
		const built = await bridge.testing.runInOperation(() => bridge.testing.buildToolResult("act_ui", "Summary.", result, execution), {});
		assert.match(fake.text(built), /New root: dialog \(@ax:d1\)\nRoot focused: window \(@r4\)/);
	});
});

describe("find_roots listing", () => {
	test("a text query ranks by app and window title, and an unmatched one explains itself", async () => {
		fake.roots = [desktopRoot({ pid: 1, title: "Notes" }), desktopRoot({ pid: 2, title: "Inbox" })];
		const found = await call(executeFind, { text: "Inbox" });
		assert.deepEqual(found.details.windows.map((window) => window.windowTitle), ["Inbox"]);
		assert.match(fake.text(found), /^Found 1 matching root; returned 1\./);
		const none = await call(executeFind, { text: "Zebra" });
		assert.equal(fake.text(none), "No roots matched the supplied filters.");
		fake.roots = [];
		assert.equal(fake.text(await call(executeFind, {})), "No roots are currently visible to pi-computer-use.");
	});

	test("more than twelve matches are capped with a refinement hint and the platform hint is appended", async () => {
		fake.roots = Array.from({ length: 14 }, (_, index) => desktopRoot({ pid: index + 1, windowId: index + 1 }));
		const found = await call(executeFind, {});
		assert.equal(found.details.returned, 12);
		assert.equal(found.details.hasMore, true);
		assert.match(fake.text(found), /Found 14 matching roots; returned 12\. Refine the filters for additional roots\./);
		fake.roots = [];
		currentPlatformBackend.emptyRootsHint = () => "Grant access.";
		assert.equal(fake.text(await call(executeFind, { kind: "dialog" })), "No roots matched the supplied filters. Grant access.");
		assert.equal(fake.text(await call(executeFind, {})), "No roots are currently visible to pi-computer-use. Grant access.");
	});
});

describe("read_text on a desktop root", () => {
	test("pages through the native reader and forwards the offset", async () => {
		const stateId = await observe();
		fake.readTextResult = async (request) => ({ text: `page@${request.offset}`, offset: request.offset, limit: request.limit, totalChars: 99_999, hasMore: request.offset === 0 });
		const first = await call(executeReadText, { stateId, ref: "@e3" });
		assert.equal(fake.text(first), "page@0");
		assert.deepEqual({ ...first.details, text: undefined }, { tool: "read_text", ref: "@e3", offset: 0, limit: 12_288, totalChars: 99_999, hasMore: true, text: undefined });
		assert.deepEqual([fake.readTexts[0].elementRef, fake.readTexts[0].offset, fake.readTexts[0].limit], ["name", 0, 12_288]);
		const next = await call(executeReadText, { stateId, ref: "@e3", offset: 12_288.9 });
		assert.equal(next.details.hasMore, false);
		assert.equal(fake.readTexts[1].offset, 12_288, "the offset is truncated");
		await call(executeReadText, { stateId, ref: "@e3", offset: -5 });
		assert.equal(fake.readTexts[2].offset, 0, "negative offsets clamp to the start");
	});

	test("an empty page, a missing ref, a stale ref and a pictureOnly node are refused or labelled", async () => {
		const stateId = await observe();
		assert.equal(fake.text(await call(executeReadText, { stateId, ref: "@e3" })), "(empty text slice)");
		await assert.rejects(() => call(executeReadText, { stateId }), /read_text requires ref for desktop contexts/);
		await assert.rejects(() => call(executeReadText, { stateId, ref: "@e99" }), /Outline ref '@e99' is stale or not available for the latest state/);
		assert.equal(fake.readTexts.length, 1);
	});

	test("a blocked app is refused before the native reader", async () => {
		const stateId = await observe();
		vi.stubEnv("PI_COMPUTER_USE_BLOCKED_APPS", "com.example.app1");
		await assert.rejects(() => call(executeReadText, { stateId, ref: "@e3" }), (error) => error.code === "app_blocked");
		assert.equal(fake.readTexts.length, 1 - 1);
	});
});

describe("read_text on stored output", () => {
	/** Overflow the model output envelope with an oversized error so the tail is stored as `@oN`. */
	const overflow = async (chars) => {
		const error = await call(executeObserve, { root: `@r${"9".repeat(chars)}` }).then(() => undefined, (caught) => caught);
		return error.message.match(/read_text\(\{ ref: "(@o\d+)", offset: (\d+) \}\)/);
	};

	test("pages through a stored output until the last page", async () => {
		const [, ref, offset] = await overflow(60_000);
		const page = await call(executeReadText, { ref, offset: Number(offset) });
		assert.equal(page.details.hasMore, true);
		assert.match(fake.text(page), new RegExp(`\\n\\ncontinue: read_text\\(\\{ ref: "${ref}", offset: ${page.details.offset + page.details.limit} \\}\\)$`));
		let last = page;
		while (last.details.hasMore) last = await call(executeReadText, { ref, offset: last.details.offset + last.details.limit });
		assert.equal(last.details.hasMore, false);
		assert.doesNotMatch(fake.text(last), /continue:/);
		const past = await call(executeReadText, { ref, offset: 10_000_000 });
		assert.equal(fake.text(past), "(empty output page)");
	});

	test("an output past the storage cap says the remainder was not kept", async () => {
		const [, ref] = await overflow(16 * 1024 * 1024 + 2_048);
		const tail = await call(executeReadText, { ref, offset: 16 * 1024 * 1024 - 100 });
		assert.equal(tail.details.hasMore, false);
		assert.match(fake.text(tail), /\n\ncontinuation storage limit reached; rerun a more focused query for the remainder$/);
	}, 60_000);

	test("an unknown or evicted output ref is refused", async () => {
		await assert.rejects(() => call(executeReadText, { ref: "@o9999" }), /Output ref '@o9999' is unavailable or was evicted\. Rerun the focused query\./);
	});
});

describe("browser pages", () => {
	/** Observe a browser page whose snapshot carries `text` and actionable backend node ids. */
	const page = async (children, text = "") => {
		const snapshot = await browserSnapshot("base", children);
		snapshot.text = text;
		snapshot.targets = snapshot.targets.map((target, index) => ({ ...target, ref: `@e${index + 2}`, backendNodeId: 100 + index }));
		listCdpPageContexts.mockResolvedValue([{ contextId: "browser:page1", targetId: "page1", title: "Page", url: "https://example.test/" }]);
		cdpSnapshotForContext.mockResolvedValue(snapshot);
		const found = await call(executeFind, { app: "Browser" });
		const root = found.details.windows.find((window) => window.kind === "browser_page").windowRef;
		const observed = await call(executeObserve, { root });
		return { stateId: observed.details.stateId, cdp: { cdpSnapshotForContext } };
	};

	test("read_text returns whole-page text for the root and labels for a subtree", async () => {
		const { stateId } = await page([wireNode("form", "AXGroup", "Form", { text: [{ string: "caption", confidence: 1, rect: { x: 0, y: 0, w: 1, h: 1 } }, { string: "OK", confidence: 1, rect: { x: 0, y: 0, w: 1, h: 1 } }], children: [wireButton("ok", "OK")] }), wireButton("solo", "Solo")], "page body");
		const whole = await call(executeReadText, { stateId, ref: "@e1" });
		assert.equal(fake.text(whole), "page body");
		assert.equal(whole.details.totalChars, 9);
		const subtree = await call(executeReadText, { stateId, ref: "@e2" });
		assert.equal(fake.text(subtree), "Form\ncaption\nOK", "labels, recognised text and descendants, deduplicated");
		const empty = await call(executeReadText, { stateId, ref: "@e1", offset: 500 });
		assert.equal(fake.text(empty), "(empty text slice)");
		assert.equal(empty.details.hasMore, false);
		await assert.rejects(() => call(executeReadText, { stateId }), /read_text requires an @e ref for browser contexts/);
		await assert.rejects(() => call(executeReadText, { stateId, ref: "@e99" }), /Browser text ref '@e99' is unavailable in this state\./);
	});

	test("read_text pages long page text by character", async () => {
		const { stateId } = await page([wireButton("ok", "OK")], "é".repeat(13_000));
		const first = await call(executeReadText, { stateId, ref: "@e1" });
		assert.deepEqual([first.details.offset, first.details.limit, first.details.totalChars, first.details.hasMore], [0, 12_288, 13_000, true]);
		const second = await call(executeReadText, { stateId, ref: "@e1", offset: 12_288 });
		assert.deepEqual([second.details.text.length, second.details.hasMore], [712, false]);
	});

	test("navigate_browser writes through the scheduler and returns a diff against the base", async () => {
		const { stateId, cdp } = await page([wireButton("ok", "OK")]);
		cdp.cdpSnapshotForContext.mockResolvedValue(await browserSnapshot("next", [wireButton("ok", "OK"), wireButton("more", "More")]));
		const result = await call(executeNavigateBrowser, { stateId, url: "https://example.test/next" });
		assert.deepEqual(cdpNavigateContext.mock.calls[0], ["browser:page1", "https://example.test/next"]);
		assert.deepEqual([result.details.view, result.details.stateId, result.details.baseStateId], ["diff", "next", "base"]);
		assert.match(fake.text(result), /^navigate_browser completed for @r\d+ "Page"\. State next\.\nChanges \(\d+, base → next\):/);
	});

	test("navigate_browser reports a page that vanished or became unobservable", async () => {
		const { stateId, cdp } = await page([wireButton("ok", "OK")]);
		cdpNavigateContext.mockResolvedValueOnce(false);
		await assert.rejects(() => call(executeNavigateBrowser, { stateId, url: "https://example.test/" }), /Browser context 'browser:page1' is no longer available\. Observe it again\./);
		const fresh = await page([wireButton("ok", "OK")]);
		cdp.cdpSnapshotForContext.mockResolvedValue(undefined);
		await assert.rejects(() => call(executeNavigateBrowser, { stateId: fresh.stateId, url: "https://example.test/" }), /Browser root 'browser:page1' is no longer available\. Call find_roots and observe_ui again\./);
	});

	test("navigate_browser refuses a desktop state", async () => {
		const stateId = await observe();
		await assert.rejects(() => call(executeNavigateBrowser, { stateId, url: "https://example.test/" }), /navigate_browser\.stateId must belong to a CDP browser-page observation\./);
	});

	test("act_ui forwards a ref-less browser keypress", async () => {
		const { stateId, cdp } = await page([wireButton("ok", "OK")]);
		cdp.cdpSnapshotForContext.mockResolvedValue(await browserSnapshot("after", [wireButton("ok", "OK")]));
		await call(executeAct, { stateId, actions: [{ action: "keypress", keys: ["Enter"] }] });
		assert.deepEqual(cdpKeypressForContext.mock.calls[0], ["browser:page1", ["Enter"]]);
	});

	test("act_ui clicks a browser ref owned by the state and refuses foreign or non-actionable refs", async () => {
		const { stateId, cdp } = await page([wireButton("ok", "OK")]);
		cdp.cdpSnapshotForContext.mockResolvedValue(await browserSnapshot("after", [wireButton("ok", "OK")]));
		const result = await call(executeAct, { stateId, actions: [{ action: "click", ref: "@e2" }] });
		assert.deepEqual(cdpClickForContext.mock.calls[0], ["browser:page1", 100]);
		assert.equal(result.details.stateId, "after");
		await assert.rejects(() => call(executeAct, { stateId, actions: [{ action: "press", ref: "@e99" }] }), /Browser press requires an actionable @e ref owned by/);
		await assert.rejects(() => call(executeAct, { stateId, actions: [{ action: "scroll", ref: "@e99", scrollY: 1 }] }), /Browser scroll ref must be owned by/);
	});
});
