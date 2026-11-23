import assert from "node:assert/strict";
import { onTestFinished, test, vi } from "vitest";
import { macosBackend } from "../src/platform/macos/backend.ts";
import { macosHelper } from "../src/platform/macos/helper.ts";
import type { PlatformRoot } from "../src/platform/types.ts";
import { scoreWindow, shouldPreferForegroundModalWindow } from "../src/root-selection.ts";
import { installFakeDesktop } from "../test/support/fake-desktop.mjs";

const FLAGS = ["isFocused", "isMain", "isMinimized", "isOnscreen"] as const;
type Flag = (typeof FLAGS)[number];

/** A helper `listRoots` entry with every state flag read, then `fields` applied (`undefined` leaves a flag out). */
function helperRoot(fields: Record<string, unknown> = {}): Record<string, unknown> {
	const entry: Record<string, unknown> = {
		kind: "window",
		rootRef: "ax:w7",
		windowId: 700,
		pid: 7,
		appName: "App7",
		bundleId: "com.example.app7",
		title: "Main",
		framePoints: { x: 0, y: 0, w: 300, h: 200 },
		zOrder: 1,
		isModal: false,
		isFocused: true,
		isMain: true,
		isMinimized: false,
		isOnscreen: true,
		...fields,
	};
	for (const [key, value] of Object.entries(fields)) if (value === undefined) delete entry[key];
	return entry;
}

/** Parse `entries` through the production macOS `listRoots` with the helper reply mocked. */
async function parsedRoots(entries: Record<string, unknown>[]): Promise<PlatformRoot[]> {
	const command = vi.spyOn(macosHelper, "command").mockResolvedValue({ roots: entries, complete: true });
	onTestFinished(() => command.mockRestore());
	return await macosBackend.listRoots({});
}

/** A ranked root for the pure selection rules. */
function ranked(fields: Partial<PlatformRoot>): PlatformRoot {
	return {
		kind: "window",
		windowId: 1,
		windowRef: "w:1",
		title: "",
		zOrder: 1,
		framePoints: { x: 0, y: 0, w: 1, h: 1 },
		scaleFactor: 1,
		isModal: false,
		...fields,
	};
}

test.each(FLAGS)("macOS listRoots keeps an omitted or non-boolean %s unknown, never false", async (flag: Flag) => {
	const [omitted, stringy, numeric, nulled, read] = await parsedRoots([
		helperRoot({ [flag]: undefined }),
		helperRoot({ [flag]: "true" }),
		helperRoot({ [flag]: 1 }),
		helperRoot({ [flag]: null }),
		helperRoot({ [flag]: false }),
	]);
	for (const root of [omitted, stringy, numeric, nulled]) assert.equal(root?.[flag], undefined);
	assert.equal(read?.[flag], false, "an explicit false read stays false");
});

test("only an explicit isMinimized false earns the not-minimized bonus; unknown flags earn none", () => {
	const unknown = scoreWindow(ranked({}));
	assert.equal(scoreWindow(ranked({ isMinimized: false })) - unknown, 40);
	assert.equal(scoreWindow(ranked({ isMinimized: true })), unknown);
	assert.equal(scoreWindow(ranked({ isFocused: false, isMain: false, isOnscreen: false })), unknown);
	assert.equal(scoreWindow(ranked({ isFocused: true, isMain: true, isOnscreen: true })) - unknown, 200);
});

test("modal selection needs a read onscreen modal and treats unknown focus as no focus", () => {
	const current = ranked({ windowId: 1, windowRef: "w:1", zOrder: 2, isMinimized: false, isOnscreen: true });
	const modal = (fields: Partial<PlatformRoot>) =>
		ranked({ windowId: 2, windowRef: "w:2", isModal: true, zOrder: 1, isOnscreen: true, ...fields });
	assert.equal(shouldPreferForegroundModalWindow(current, modal({})), true, "read onscreen, minimized unknown");
	assert.equal(shouldPreferForegroundModalWindow(current, modal({ isOnscreen: undefined })), false);
	assert.equal(shouldPreferForegroundModalWindow(current, modal({ isOnscreen: false })), false);
	assert.equal(shouldPreferForegroundModalWindow(current, modal({ isMinimized: true })), false);
	// Behind the current root, only a read focus puts the modal in front.
	assert.equal(shouldPreferForegroundModalWindow(current, modal({ zOrder: 3 })), false);
	assert.equal(shouldPreferForegroundModalWindow(current, modal({ zOrder: 3, isFocused: true })), true);
});

test("an unknown isMinimized does not cost a foreground modal its takeover at the score boundary", () => {
	// A focused main window scores 252, as does a titled onscreen modal with a window ID once it is not minimized.
	const current = ranked({
		windowId: 1,
		windowRef: "w:1",
		title: "Main",
		zOrder: 2,
		isFocused: true,
		isMain: true,
		isMinimized: false,
		isOnscreen: true,
	});
	const dialog = (fields: Partial<PlatformRoot>) =>
		ranked({ windowId: 2, windowRef: "w:2", title: "Save", zOrder: 1, isOnscreen: true, isModal: true, ...fields });
	assert.equal(scoreWindow(current), scoreWindow(dialog({ isMinimized: false })));
	assert.equal(shouldPreferForegroundModalWindow(current, dialog({ isMinimized: false })), true);
	assert.equal(shouldPreferForegroundModalWindow(current, dialog({})), true, "unknown minimized keeps the takeover");
	assert.equal(
		shouldPreferForegroundModalWindow(current, dialog({ isMinimized: true })),
		false,
		"a read minimized vetoes",
	);
	// Ranking still gives the not-minimized bonus only to a read false.
	assert.equal(scoreWindow(dialog({ isMinimized: false })) - scoreWindow(dialog({})), 40);
});

test("find_roots details and restored ref records keep unknown macOS flags unknown", async () => {
	const fake = await installFakeDesktop(onTestFinished, { platform: "macos" });
	const unread = Object.fromEntries(FLAGS.map((flag) => [flag, undefined]));
	fake.roots = await parsedRoots([
		helperRoot({ ...unread, zOrder: 0 }),
		helperRoot({ rootRef: "ax:w8", windowId: 800, title: "Other", zOrder: 5 }),
	]);
	fake.frontmostPid = 7;
	const found = await fake.call(fake.bridge.executeFind, {});
	const [focused, unknown] = found.details.windows;
	assert.equal(focused.windowTitle, "Other", "a read focused root ranks before one whose focus is unknown");
	for (const flag of FLAGS) assert.equal(unknown[flag], undefined, `${flag} is not reported as read`);
	assert.equal(unknown.score, 10 + 2, "only windowId and title score");
	assert.deepEqual(
		FLAGS.map((flag) => focused[flag]),
		[true, true, false, true],
	);
	const stored = JSON.parse(JSON.stringify(found.details));
	for (const flag of FLAGS) assert.equal(flag in stored.windows[1], false, `${flag} is left out of the stored details`);
	stored.windows[0] = { ...stored.windows[0], isFocused: "true", isMain: 1, isMinimized: null };
	fake.bridge.reconstructStateFromBranch({
		...fake.ctx,
		sessionManager: {
			getBranch: () => [{ type: "message", message: { role: "toolResult", toolName: "find_roots", details: stored } }],
		},
	});
	const restoredUnknown = fake.bridge.testing.storedRootRef(unknown.windowRef);
	const restoredMixed = fake.bridge.testing.storedRootRef(focused.windowRef);
	assert.ok(restoredUnknown, "the all-unknown record is restored");
	assert.equal(restoredUnknown.ref, unknown.windowRef);
	for (const flag of FLAGS) assert.equal(restoredUnknown[flag], undefined, `restored ${flag} stays unknown`);
	assert.deepEqual(
		FLAGS.map((flag) => restoredMixed?.[flag]),
		[undefined, undefined, undefined, true],
		"a stored non-boolean restores unknown; a stored boolean restores as read",
	);
});
