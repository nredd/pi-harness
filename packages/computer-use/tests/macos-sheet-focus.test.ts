import assert from "node:assert/strict";
import { onTestFinished, test, vi } from "vitest";
import { macosBackend } from "../src/platform/macos/backend.ts";
import { macosHelper } from "../src/platform/macos/helper.ts";
import { shouldPreferForegroundModalWindow } from "../src/root-selection.ts";

/** A helper `listRoots` reply: an unpaired, on-screen, focused, not main window and its sheet at the same z-order. */
function sheetedReply(sheet: Record<string, unknown>): Record<string, unknown>[] {
	const frame = { x: 100, y: 100, w: 800, h: 600 };
	return [
		{
			kind: "window",
			rootRef: "w:1",
			pid: 42,
			title: "Doc",
			framePoints: frame,
			zOrder: 3,
			isFocused: true,
			isMain: false,
			isMinimized: false,
			isOnscreen: true,
		},
		{
			kind: "sheet",
			rootRef: "w:2",
			pid: 42,
			title: "Save",
			framePoints: frame,
			zOrder: 3,
			isModal: true,
			isMain: false,
			isMinimized: false,
			isOnscreen: true,
			...sheet,
		},
	];
}

async function parsed(sheetFields: Record<string, unknown>) {
	const command = vi.spyOn(macosHelper, "command").mockResolvedValue(sheetedReply(sheetFields));
	onTestFinished(() => command.mockRestore());
	const roots = await macosBackend.listRoots({ pid: 42 });
	const [window, sheet] = roots;
	assert.ok(roots.length === 2 && window && sheet);
	return { window, sheet };
}

// The helper gives a sheet whose own `AXFocused` was not read its window's focus, marked `focusInherited` (#1303).
test("macOS selection prefers a focused window's sheet whose own focus was not read", async () => {
	const { window, sheet } = await parsed({ isFocused: true, focusInherited: true });
	assert.equal(sheet.isFocused, true);
	assert.equal(shouldPreferForegroundModalWindow(window, sheet), true);
});

test("macOS selection keeps the window when its sheet reports no focus at its z-order", async () => {
	const { window, sheet } = await parsed({});
	assert.equal(shouldPreferForegroundModalWindow(window, sheet), false);
});
