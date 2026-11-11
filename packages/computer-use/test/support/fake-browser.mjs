// Scripted CDP browser pages for tools that observe or poll `browser:` contexts.
// The importing test file must `vi.mock("../src/cdp.ts", ...)` so `listCdpPageContexts` and
// `cdpSnapshotForContext` are `vi.fn()` mocks.
import { vi } from "vitest";
import { wireNode } from "./fake-desktop.mjs";

/**
 * Build a CDP page snapshot whose outline is a web area holding `children`.
 * @param {string} id Snapshot id.
 * @param {object[]} children Wire child nodes.
 * @param {object} [options] `contextId` and the web area `role` override.
 * @returns {Promise<object>} Snapshot as `cdpSnapshotForContext` returns it.
 * @throws {Error} When the outline module cannot be imported.
 */
export async function browserSnapshot(id, children, options = {}) {
	const { parseLookResponse, serializeOutline } = await import("../../src/outline.ts");
	const outline = parseLookResponse({
		lookId: id,
		capturedAt: 1,
		window: { windowId: 0, framePoints: { x: 0, y: 0, w: 1, h: 1 }, scaleFactor: 1, isModal: false, role: "document", subrole: "" },
		outline: wireNode("doc", options.role ?? "AXWebArea", "Page", { children }),
		timings: {},
	}).parsedOutline;
	return { contextId: options.contextId ?? "browser:page1", snapshotId: id, targetId: "page1", title: "Page", url: "https://example.test/", capturedAt: 1, text: "", targets: children.map((child) => ({ ref: child.ref, source: "browser_ax", role: child.role, name: child.title, actions: [] })), outline: serializeOutline(outline), diagnostics: { cdp: "connected", targetCount: children.length } };
}

/**
 * Expose one browser page through `find_roots` and observe it.
 * @param {object} fake Controls from `installFakeDesktop`.
 * @param {object[]} children Wire children of the page's base snapshot.
 * @returns {Promise<object>} `{ cdp, root, stateId, observed }` where `cdp` holds the mocks.
 * @throws {Error} When the page is not offered as a root.
 */
export async function observeBrowser(fake, children) {
	const cdp = await import("../../src/cdp.ts");
	if (!vi.isMockFunction(cdp.cdpSnapshotForContext) || !vi.isMockFunction(cdp.listCdpPageContexts)) throw new Error("observeBrowser needs the caller to vi.mock(\"../src/cdp.ts\") with vi.fn() page functions.");
	cdp.listCdpPageContexts.mockResolvedValue([{ contextId: "browser:page1", targetId: "page1", title: "Page", url: "https://example.test/" }]);
	cdp.cdpSnapshotForContext.mockResolvedValue(await browserSnapshot("base", children));
	const found = await fake.call(fake.bridge.executeFind, { app: "Browser" });
	const root = found.details.windows.find((window) => window.kind === "browser_page").windowRef;
	const observed = await fake.call(fake.bridge.executeObserve, { root });
	return { cdp, root, stateId: observed.details.stateId, observed };
}
