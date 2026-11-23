import assert from "node:assert/strict";
import { onTestFinished, test, vi } from "vitest";
import { macosBackend } from "../src/platform/macos/backend.ts";
import { macosHelper } from "../src/platform/macos/helper.ts";
import { shouldPreferForegroundModalWindow } from "../src/root-selection.ts";

/**
 * A helper `listRoots` reply as `rootEntries` emits it: a focused main window, modal because it has a sheet
 * (`classifyModal`), and that sheet at the same z-order, showing its window's focus.
 */
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
			isModal: true,
			isFocused: true,
			isMain: true,
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
			isFocused: true,
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

// Unchanged by #1303: a sheet shows its window's focus, so the main window outscores it and stays selected. The
// sheet's own `AXFocused` read (`ownFocus`) is delta evidence only and never reaches the parsed root.
test("macOS selection keeps a focused main window over its sheet, whatever the sheet's own focus read", async () => {
	for (const ownFocus of [undefined, false, true]) {
		const { window, sheet } = await parsed(ownFocus === undefined ? {} : { ownFocus });
		assert.equal(sheet.isFocused, true);
		assert.equal("ownFocus" in sheet, false);
		assert.equal(shouldPreferForegroundModalWindow(window, sheet), false);
	}
});
