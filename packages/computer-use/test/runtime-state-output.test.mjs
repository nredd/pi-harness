// `src/runtime.ts` scheduler and store, `src/state.ts` hydration, `src/output.ts` bounded output store and `platform/architecture.ts` (nredd/pi-harness#703, Refs #645).
import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import { serializeOutline } from "../src/outline.ts";
import { REQUIRED_PLATFORM_INVARIANTS, assertPlatformArchitecture } from "../src/platform/architecture.ts";
import { ResourceScheduler, StaleResourceStateError, StateStore } from "../src/runtime.ts";
import { SavedStates } from "../src/state.ts";
import { MODEL_TEXT_MAX_BYTES, applyOutputEnvelope, boundToolError, clearStoredOutputs, readStoredOutput } from "../src/output.ts";
import { outlineNode as n, outlineOf } from "./support/outline-nodes.mjs";

describe("StateStore", () => {
	test("keeps the newest records up to the limit and refreshes re-set ones", () => {
		const store = new StateStore(2);
		const a = store.create("r", 0, "a");
		const b = store.create("r", 0, "b");
		store.set(a);
		const c = store.create("r", 1, "c");
		assert.equal(store.size, 2);
		assert.equal(store.get(b.stateId), undefined, "the least recently set record is evicted");
		assert.deepEqual([store.get(a.stateId)?.value, store.get(c.stateId)?.value], ["a", "c"]);
		assert.match(a.stateId, /^[0-9a-f-]{36}$/);
		store.clear();
		assert.equal(store.size, 0);
	});

	test("the default limit is 128", () => {
		const store = new StateStore();
		const first = store.create("r", 0, 0);
		for (let i = 1; i <= 128; i++) store.create("r", 0, i);
		assert.equal(store.size, 128);
		assert.equal(store.get(first.stateId), undefined);
	});
});

describe("ResourceScheduler", () => {
	test("epochs start at zero and restoring only moves them forward by whole numbers", () => {
		const scheduler = new ResourceScheduler();
		assert.equal(scheduler.epoch("w1"), 0);
		scheduler.restoreEpoch("w1", 4.9);
		assert.equal(scheduler.epoch("w1"), 4);
		scheduler.restoreEpoch("w1", 2);
		scheduler.restoreEpoch("w1", -7);
		assert.equal(scheduler.epoch("w1"), 4);
		assert.equal(scheduler.epoch("w2"), 0, "resources are independent");
	});

	test("reads see the current epoch and readAt refuses a stale one", async () => {
		const scheduler = new ResourceScheduler();
		scheduler.restoreEpoch("w", 3);
		assert.deepEqual(await scheduler.read("w", async (epoch) => `v${epoch}`), { value: "v3", epoch: 3 });
		assert.deepEqual(await scheduler.readAt("w", 3, async (epoch) => epoch), { value: 3, epoch: 3 });
		const stale = await scheduler.readAt("w", 2, async () => "never").catch((error) => error);
		assert.ok(stale instanceof StaleResourceStateError);
		assert.deepEqual([stale.name, stale.resourceKey, stale.expectedEpoch, stale.actualEpoch], ["StaleResourceStateError", "w", 2, 3]);
		assert.equal(stale.message, "State is stale for w: expected epoch 2, current epoch 3.");
	});

	test("a write bumps the epoch before it runs, even when it fails, and invalidates its base", async () => {
		const scheduler = new ResourceScheduler();
		const seen = [];
		await assert.rejects(scheduler.write("w", 0, async (next) => { seen.push([next, scheduler.epoch("w")]); throw new Error("partial effect"); }), /partial effect/);
		assert.deepEqual(seen, [[1, 1]]);
		await assert.rejects(scheduler.write("w", 0, async () => "again"), StaleResourceStateError);
		assert.deepEqual(await scheduler.write("w", 1, async (next) => next), { value: 2, epoch: 2 });
	});

	test("work on one resource is serial and in arrival order, other resources overlap", async () => {
		const scheduler = new ResourceScheduler();
		const log = [];
		let openGate;
		const gate = new Promise((resolve) => { openGate = resolve; });
		const first = scheduler.read("w", async () => { log.push("first:start"); await gate; log.push("first:end"); });
		const second = scheduler.read("w", async () => { log.push("second"); });
		await scheduler.read("other", async () => { log.push("other"); });
		assert.deepEqual(log, ["first:start", "other"]);
		openGate();
		await Promise.all([first, second]);
		assert.deepEqual(log, ["first:start", "other", "first:end", "second"]);
	});

	test("a failed operation does not block its successors; drain waits for the tail", async () => {
		const scheduler = new ResourceScheduler();
		const failed = scheduler.read("w", async () => { throw new Error("boom"); });
		const after = scheduler.read("w", async () => "ok");
		await assert.rejects(failed, /boom/);
		assert.equal((await after).value, "ok");
		await scheduler.drain();
	});

	test("after close new work is refused", async () => {
		const scheduler = new ResourceScheduler();
		await scheduler.read("w", async () => undefined);
		await scheduler.close();
		for (const call of [() => scheduler.read("w", async () => 1), () => scheduler.readAt("w", 0, async () => 1), () => scheduler.write("w", 0, async () => 1)]) {
			await assert.rejects(call(), /Computer-use session is shutting down\./);
		}
	});
});

describe("SavedStates", () => {
	const record = (value, over = {}) => ({ stateId: "s1", resourceKey: "pid:7", epoch: 2, value, ...over });
	const outline = () => serializeOutline(outlineOf(n("@e0", { wireRef: "w0", role: "AXWindow", children: [n("@e1", { wireRef: "w1" })] })));
	const desktopState = (over = {}) => ({
		currentTarget: { appName: "App", pid: 7, windowTitle: "Main", windowId: 3, windowRef: "@r1" },
		currentCapture: { stateId: "s1", width: 10, height: 20, scaleFactor: 2, timestamp: 5 },
		currentLook: { lookId: "look9", capturedAt: 1, window: { windowId: 3, framePoints: { x: 0, y: 0, w: 1, h: 1 }, scaleFactor: 2, isModal: false, role: "AXWindow", subrole: "" }, outline: undefined, timings: { look: 4 } },
		currentOutline: outlineOf(n("@e0", { wireRef: "w0", role: "AXWindow", children: [n("@e1", { wireRef: "w1" })] })),
		currentImageMode: "fused",
		...over,
	});

	test("current() needs an operation scope", () => {
		const states = new SavedStates();
		assert.throws(() => states.current(), /Computer-use operation state is unavailable\./);
		const scope = { currentFocus: true };
		assert.equal(states.operations.run(scope, () => states.current()), scope);
	});

	test("an unknown state hydrates to nothing", () => assert.deepEqual(new SavedStates().hydrate(undefined), {}));

	test("a desktop state round-trips through the store, including optional note, image and read text", () => {
		const states = new SavedStates();
		const look = { image: { jpegBase64: "x", width: 1, height: 2 }, readText: { text: "t" } };
		const original = desktopState({ currentLook: { ...desktopState().currentLook, ...look }, currentNote: { windowRef: "@r1", title: "Main", pairing: "exact", regions: [] } });
		states.saveDesktop(original, "pid:7", 2);
		const hydrated = states.hydrate(states.get("s1"));
		assert.equal(states.store.size, 1);
		assert.deepEqual(hydrated.currentTarget, original.currentTarget);
		assert.deepEqual(hydrated.currentStateTarget, { pid: 7, windowId: 3, windowRef: "@r1" });
		assert.equal(hydrated.currentImageMode, "fused");
		assert.equal(hydrated.currentLook.lookId, "look9");
		assert.deepEqual(hydrated.currentLook.image, look.image);
		assert.deepEqual(hydrated.currentLook.readText, look.readText);
		assert.deepEqual(hydrated.currentNote, original.currentNote);
		assert.notEqual(hydrated.currentNote, original.currentNote, "the note is cloned");
		assert.deepEqual([hydrated.resourceKey, hydrated.epoch], ["pid:7", 2]);
		assert.deepEqual(hydrated.currentOutline.nodes.map((node) => node.ref), ["@e0", "@e1"]);
		assert.equal(hydrated.currentLook.parsedOutline, hydrated.currentOutline);
	});

	test("without note, image or read text those stay absent", () => {
		const states = new SavedStates();
		states.saveDesktop(desktopState(), "pid:7", 2);
		const stored = states.get("s1");
		assert.deepEqual([stored.value.note, stored.value.look.image, stored.value.look.readText], [undefined, undefined, undefined]);
		assert.equal(states.hydrate(stored).currentNote, undefined);
		states.clear();
		assert.equal(states.get("s1"), undefined);
	});

	test.each(["currentTarget", "currentCapture", "currentLook", "currentOutline"])("saveDesktop skips a state missing %s", (missing) => {
		const states = new SavedStates();
		states.saveDesktop(desktopState({ [missing]: undefined }), "pid:7", 2);
		assert.equal(states.store.size, 0);
	});

	test("a browser state hydrates a synthetic look and its snapshot identity", () => {
		const states = new SavedStates();
		const snapshot = { snapshotId: "snap1", capturedAt: 5000, contextId: "ctx1" };
		const stored = record({ kind: "browser", snapshot, outline: outline() });
		states.set(stored);
		const hydrated = states.hydrate(states.get("s1"));
		assert.deepEqual(hydrated.currentCapture, { stateId: "s1", width: 0, height: 0, scaleFactor: 1, timestamp: 5000 });
		assert.deepEqual([hydrated.currentLook.lookId, hydrated.currentLook.capturedAt, hydrated.currentLook.window.role], ["snap1", 5, "document"]);
		assert.deepEqual([hydrated.browserSnapshot, hydrated.contextId, hydrated.resourceKey, hydrated.epoch], [snapshot, "ctx1", "pid:7", 2]);
		assert.equal(hydrated.currentOutline.root.ref, "@e0");
	});
});

describe("assertPlatformArchitecture", () => {
	test("accepts a helper reporting the version and every invariant", () => {
		assert.doesNotThrow(() => assertPlatformArchitecture("Linux", { architectureVersion: 1, invariants: [...REQUIRED_PLATFORM_INVARIANTS, "extra"] }));
	});

	test("rejects a different or missing version", () => {
		assert.throws(() => assertPlatformArchitecture("Linux", { architectureVersion: 2, invariants: [] }), /Linux helper architecture mismatch: expected 1, got 2\. Rebuild and restart the helper\./);
		assert.throws(() => assertPlatformArchitecture("macOS", {}), /macOS helper architecture mismatch: expected 1, got unknown\./);
	});

	test("lists missing invariants, or all of them when none are reported", () => {
		assert.throws(
			() => assertPlatformArchitecture("Windows", { architectureVersion: 1, invariants: REQUIRED_PLATFORM_INVARIANTS.filter((name) => name !== "multi-root-forest" && name !== "concurrent-requests") }),
			/Windows helper does not satisfy the shared computer-use contract: multi-root-forest, concurrent-requests\.$/,
		);
		assert.throws(() => assertPlatformArchitecture("Windows", { architectureVersion: 1 }), new RegExp(`contract: ${REQUIRED_PLATFORM_INVARIANTS.join(", ")}\\.$`));
	});
});

describe("bounded output store", () => {
	afterEach(() => clearStoredOutputs());
	const result = (text) => ({ content: [{ type: "text", text }], details: {} });
	const textOf = (value) => value.content[0].text;

	test("small results pass through untouched, including image-only ones", () => {
		const small = result("hello");
		assert.equal(applyOutputEnvelope("observe_ui", small), small);
		const image = { content: [{ type: "image", data: "x", mimeType: "image/png" }], details: {} };
		assert.equal(applyOutputEnvelope("observe_ui", image), image);
	});

	test.each([
		["search_ui", "use a more selective text, role, or capability predicate"],
		["find_roots", "use a more selective text, app, bundleId, pid, or kind filter"],
		["evaluate_browser", "return selected fields, an aggregate, or a smaller slice"],
		["observe_ui", "use search_ui or expand a more specific ref"],
		["expand_ui", "use search_ui or expand a more specific ref"],
		["act_ui", "request a smaller or more focused result"],
	])("%s truncation names its refinement", (tool, refinement) => {
		const image = { type: "image", data: "i", mimeType: "image/png" };
		const out = applyOutputEnvelope(tool, { content: [{ type: "text", text: "x".repeat(MODEL_TEXT_MAX_BYTES + 1) }, image], details: { keep: 1 } });
		assert.match(textOf(out), new RegExp(`\\nrefine: ${refinement}\\n`));
		assert.deepEqual(out.content[1], image, "images survive");
		assert.deepEqual(out.details, { keep: 1 });
		assert.match(textOf(out), /output truncated: returned 16384 of 49153 utf-8 bytes/);
		assert.match(textOf(out), /continue: read_text\(\{ ref: "@o1", offset: 16384 \}\)$/);
	});

	test("too many lines truncate even when the bytes fit", () => {
		const out = applyOutputEnvelope("observe_ui", result("x\n".repeat(2500)));
		assert.match(textOf(out), /output truncated: returned 3991 of 5000 utf-8 bytes/);
		assert.equal(textOf(out).split("\n\n")[0].split("\n").length, 1996);
	});

	test("stored output pages back out, resuming on character boundaries", () => {
		const text = "é".repeat(30_000);
		const out = applyOutputEnvelope("observe_ui", result(text));
		const ref = "@o1";
		assert.match(textOf(out), /output truncated: returned 16384 of 60000 utf-8 bytes/);
		const page = readStoredOutput(ref, 16_384);
		assert.deepEqual([page.offset, page.limit, page.totalBytes, page.hasMore, page.complete], [16_384, 16_384, 60_000, true, true]);
		assert.equal(page.text, "é".repeat(8192));
		const mid = readStoredOutput(ref, 16_385);
		assert.equal(mid.offset, 16_386, "a mid-character offset skips to the next character");
		assert.equal(mid.text.includes("\uFFFD"), false);
		const tail = readStoredOutput(ref, 50_000);
		assert.deepEqual([tail.hasMore, tail.text.length], [false, 5000]);
		const past = readStoredOutput(ref, 1e9);
		assert.deepEqual([past.text, past.offset, past.limit, past.hasMore], ["", 60_000, 0, false]);
		for (const odd of [undefined, Number.NaN, "7", -5]) assert.equal(readStoredOutput(ref, odd).offset, 0, String(odd));
		assert.equal(readStoredOutput("@o404", 0), undefined);
	});

	test("the preview never ends inside a multi-byte character", () => {
		const out = applyOutputEnvelope("observe_ui", result(`a${"é".repeat(30_000)}`));
		assert.match(textOf(out), /output truncated: returned 16383 of 60001 utf-8 bytes/);
		assert.equal(textOf(out).includes("\uFFFD"), false);
		assert.match(textOf(out), /continue: read_text\(\{ ref: "@o1", offset: 16383 \}\)$/);
	});

	test("clearing forgets stored output and restarts numbering", () => {
		applyOutputEnvelope("observe_ui", result("x".repeat(MODEL_TEXT_MAX_BYTES + 1)));
		clearStoredOutputs();
		assert.equal(readStoredOutput("@o1", 0), undefined);
		assert.match(textOf(applyOutputEnvelope("observe_ui", result("x".repeat(MODEL_TEXT_MAX_BYTES + 1)))), /ref: "@o1"/);
		clearStoredOutputs();
		clearStoredOutputs();
	});

	test("an entry over 16 MiB keeps only its prefix and says so; the store evicts oldest past 64 MiB", () => {
		const huge = "y".repeat(16 * 1024 * 1024 + 10);
		const outs = Array.from({ length: 5 }, () => applyOutputEnvelope("evaluate_browser", result(huge)));
		const last = textOf(outs[0]);
		assert.match(last, /only the first 16777216 bytes were stored, so refine for the remainder/);
		assert.match(last, /returned 16384 of 16777226 utf-8 bytes/);
		assert.equal(readStoredOutput("@o1", 0), undefined, "the oldest entry was evicted");
		for (const ref of ["@o2", "@o3", "@o4", "@o5"]) assert.equal(readStoredOutput(ref, 0).complete, false, ref);
		assert.equal(readStoredOutput("@o5", 0).totalBytes, 16_777_226);
	});
});

describe("boundToolError", () => {
	afterEach(() => clearStoredOutputs());

	test("small errors keep their identity, strings are wrapped", () => {
		const error = new Error("nope");
		assert.equal(boundToolError("act_ui", error), error);
		const wrapped = boundToolError("act_ui", "plain");
		assert.ok(wrapped instanceof Error);
		assert.equal(wrapped.message, "plain");
		assert.equal(boundToolError("act_ui", 42).message, "42");
	});

	test("large errors are previewed and stored for read_text", () => {
		const bounded = boundToolError("search_ui", new Error("z".repeat(MODEL_TEXT_MAX_BYTES + 1)));
		assert.match(bounded.message, /\n\nerror truncated: returned 16384 of 49153 utf-8 bytes\nrefine: use a more selective text, role, or capability predicate\ncontinue: read_text\(\{ ref: "@o1", offset: 16384 \}\)$/);
		assert.equal(readStoredOutput("@o1", 0).complete, true);
		const lines = boundToolError("act_ui", "l\n".repeat(2500));
		assert.match(lines.message, /error truncated: returned 3991 of 5000/);
	});

	test("an error over 16 MiB notes the partial store", () => {
		const bounded = boundToolError("act_ui", "q".repeat(16 * 1024 * 1024 + 1));
		assert.match(bounded.message, /offset: 16384 \}\); only the first 16777216 bytes were stored$/);
	});
});
