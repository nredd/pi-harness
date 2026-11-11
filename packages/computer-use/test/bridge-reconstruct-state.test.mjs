// `reconstructStateFromBranch`: which session entries restore roots and states, and which malformed ones are skipped (nredd/pi-harness#712, Refs #645).
import assert from "node:assert/strict";
import { test } from "vitest";
import { installFakeDesktop } from "./support/fake-desktop.mjs";

const message = (toolName, details, role = "toolResult") => ({ type: "message", message: { role, toolName, details } });
const clone = (value) => JSON.parse(JSON.stringify(value));

/**
 * Observe the default window so a reconstructable `observe_ui` result exists.
 * @param {(fn: () => void | Promise<void>) => void} onTestFinished Vitest cleanup registrar.
 * @returns {Promise<{ fake: object, details: object, stateId: string, restore: (...entries: object[]) => void }>} Fake controls and the cloned details.
 * @throws {Error} When the observation fails.
 */
async function sessionWith(onTestFinished) {
	const fake = await installFakeDesktop(onTestFinished);
	const observed = await fake.observe();
	return {
		fake,
		details: clone(observed.result.details),
		stateId: observed.stateId,
		restore: (...entries) => fake.bridge.reconstructStateFromBranch({ ...fake.ctx, sessionManager: { getBranch: () => entries } }),
	};
}

test("a desktop result restores its state, target, capture and look", async ({ onTestFinished }) => {
	const { fake, details, stateId, restore } = await sessionWith(onTestFinished);
	restore(message("observe_ui", details));
	const state = fake.bridge.testing.savedState(stateId);
	assert.equal(state.value.kind, "desktop");
	assert.equal(state.resourceKey, "desktop-pid:1");
	assert.equal(state.epoch, 0);
	assert.equal(state.value.target.appName, "App1");
	assert.equal(state.value.capture.stateId, stateId);
	assert.equal(state.value.look.lookId, details.lookId);
	assert.deepEqual(state.value.look.image, { jpegBase64: "", width: details.capture.width, height: details.capture.height });
});

test("entries that are not tool results of this extension are ignored", async ({ onTestFinished }) => {
	const { fake, details, stateId, restore } = await sessionWith(onTestFinished);
	restore(
		null,
		{ type: "custom", message: { role: "toolResult", toolName: "observe_ui", details } },
		{ type: "message" },
		message("observe_ui", details, "assistant"),
		message("bash", details),
		message("observe_ui", undefined),
	);
	assert.equal(fake.bridge.testing.savedState(stateId), undefined);
});

test("desktop results missing a usable target or capture are skipped", async ({ onTestFinished }) => {
	const { fake, details, stateId, restore } = await sessionWith(onTestFinished);
	const without = (mutate) => {
		const copy = clone(details);
		mutate(copy);
		return message("observe_ui", copy);
	};
	restore(
		without((d) => delete d.target),
		without((d) => delete d.capture),
		without((d) => (d.target.app = 5)),
		without((d) => delete d.target.app),
		without((d) => (d.target.pid = "1")),
		without((d) => (d.target.windowId = null)),
		without((d) => (d.capture.stateId = 7)),
	);
	assert.equal(fake.bridge.testing.savedState(stateId), undefined);
});

test("loosely typed target and capture fields fall back to safe defaults", async ({ onTestFinished }) => {
	const { fake, details, stateId, restore } = await sessionWith(onTestFinished);
	details.target.windowTitle = undefined;
	details.target.windowRef = 4;
	details.target.nativeWindowRef = 4;
	details.target.pid = 12.9;
	details.target.windowId = 100.9;
	details.capture.width = 0;
	details.capture.height = "tall";
	details.capture.scaleFactor = 0;
	details.capture.timestamp = "yesterday";
	const before = Date.now();
	restore(message("observe_ui", details));
	const state = fake.bridge.testing.savedState(stateId);
	assert.equal(state.value.target.windowTitle, "(untitled)");
	assert.equal(state.value.target.windowRef, undefined);
	assert.equal(state.value.target.nativeWindowRef, undefined);
	assert.equal(state.value.target.pid, 12);
	assert.equal(state.value.target.windowId, 100);
	assert.deepEqual([state.value.capture.width, state.value.capture.height, state.value.capture.scaleFactor], [1, 1, 1]);
	assert.ok(state.value.capture.timestamp >= before, "a non-numeric timestamp becomes now");
});

test("the newest result for a resource wins and older ones for it are not restored", async ({ onTestFinished }) => {
	const { fake, details, stateId, restore } = await sessionWith(onTestFinished);
	// Inline the outline so the older result would be restorable if the newest-wins rule did not skip it.
	const older = { ...clone(details), outline: clone(fake.bridge.testing.savedState(stateId).value.outline) };
	older.capture.stateId = "S-older";
	// The branch is replayed newest first, so the later entry is the one that wins.
	restore(message("observe_ui", older), message("observe_ui", details));
	assert.ok(fake.bridge.testing.savedState(stateId));
	assert.equal(fake.bridge.testing.savedState("S-older"), undefined);
});

test("a restored note survives and a re-restore clears what was there", async ({ onTestFinished }) => {
	const { fake, details, stateId, restore } = await sessionWith(onTestFinished);
	details.note = { text: "kept" };
	restore(message("observe_ui", details));
	assert.deepEqual(fake.bridge.testing.savedState(stateId).value.note, { text: "kept" });
	restore();
	assert.equal(fake.bridge.testing.savedState(stateId), undefined);
});

const findRoots = (windows) => message("find_roots", { tool: "find_roots", windows });
const root = (over = {}) => ({ windowRef: "@r4", pid: 7, app: "App", bundleId: "com.example.app", windowTitle: "Main", windowId: 11, nativeWindowRef: "ax:w11", ...over });

/**
 * Where the next issued root ref lands after restoring `entries`.
 * @param {object} fake Fake desktop controls.
 * @returns {Promise<string>} The `@rN` ref `find_roots` issues for a never-seen root.
 * @throws {Error} When `find_roots` fails.
 */
async function nextRootRef(fake) {
	const found = await fake.call(fake.bridge.executeFind, {});
	return found.details.windows[0].windowRef;
}

test("find_roots results restore refs and move the next root index past them", async ({ onTestFinished }) => {
	const { fake, restore } = await sessionWith(onTestFinished);
	restore(findRoots([root({ windowRef: "@r4", pid: 1, windowId: 100 }), root({ windowRef: "@r9", pid: 9 })]));
	assert.equal(await nextRootRef(fake), "@r4", "a live root restored by identity keeps its ref");
	const { stateId } = await fake.observe({ root: "@r9" }).catch(() => ({}));
	assert.equal(stateId, undefined, "@r9 names a root that is not live");
	fake.roots = [{ ...fake.roots[0], pid: 2, windowId: 200, appName: "Fresh", bundleId: "com.example.fresh" }];
	assert.equal(await nextRootRef(fake), "@r10", "the next fresh ref follows the highest restored one");
});

test("malformed root entries are skipped and non-@r refs do not move the index", async ({ onTestFinished }) => {
	const { fake, restore } = await sessionWith(onTestFinished);
	restore(
		findRoots([
			{ pid: 7 },
			{ windowRef: "@r3" },
			{ windowRef: "@r3", pid: "7" },
			null,
			root({ windowRef: "custom-ref", pid: 8 }),
			root({ windowRef: "@r2", pid: 9, app: 5, bundleId: 5, windowTitle: 5, windowId: "x", nativeWindowRef: 5, framePoints: { x: "a", w: 0, h: -3 }, scaleFactor: 0, isMinimized: "no" }),
		]),
		message("find_roots", { tool: "find_roots", windows: "none" }),
	);
	assert.equal(await nextRootRef(fake), "@r3", "only the numeric @r2 ref counted");
});
