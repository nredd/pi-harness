// Outlines live in the agent-cache store, not the session file (#648).
import assert from "node:assert/strict";
import fs from "node:fs";
import { beforeEach, test, vi } from "vitest";

const uiNode = (ref, title, fields = {}) => ({ ref, wireRef: `w${ref}`, role: "AXGroup", subrole: "", identifier: `id-${ref}`, title, description: "An element description", value: "", actions: ["AXPress"], canPress: true, canFocus: false, canSetValue: false, canScroll: false, canIncrement: false, canDecrement: false, isTextInput: false, rect: { x: 1, y: 2, w: 30, h: 40 }, focused: false, offscreen: false, pictureOnly: false, truncated: false, text: [], children: [], ...fields });

/** Deep synthetic tree: `fan ** depth` leaves, like a browser or IDE window. */
function outlineOf(depth, fan, lookId = "look") {
	let count = 0;
	const build = (level) => {
		const node = uiNode(`@e${++count}`, `Node ${count} title text`);
		if (level) node.children = Array.from({ length: fan }, () => build(level - 1));
		return node;
	};
	const root = build(depth);
	const nodes = [];
	const visit = (node, parent) => {
		node.parent = parent;
		nodes.push(node);
		for (const child of node.children) visit(child, node);
	};
	visit(root, undefined);
	return { lookId, root, nodes, refToWireRef: new Map(), wireRefToRef: new Map() };
}

const capture = (outline, stateId) => ({ target: { appName: "App", pid: 7, windowTitle: "Doc", windowId: 5 }, capture: { stateId, width: 800, height: 600, scaleFactor: 2, timestamp: 1000 }, look: { lookId: outline.lookId }, outline, activation: {} });
const branchOf = (...details) => ({ sessionManager: { getBranch: () => details.map((d) => ({ type: "message", message: { role: "toolResult", toolName: "observe_ui", details: d } })) } });

async function modules() {
	const store = await import("../src/outline-store.ts");
	const bridge = await import("../src/bridge.ts");
	const { serializeOutline } = await import("../src/outline.ts");
	return { ...store, ...bridge, serializeOutline };
}

beforeEach(async () => {
	const { outlineStoreDir } = await import("../src/outline-store.ts");
	fs.rmSync(outlineStoreDir(), { recursive: true, force: true });
});

test("store round-trips, replaces a state, and evicts past the newest limit", async () => {
	const { saveStoredOutline, loadStoredOutline, outlineStoreDir, serializeOutline } = await modules();
	const outline = serializeOutline(outlineOf(1, 2));
	for (const id of ["a", "b", "c", "d"]) saveStoredOutline(id, outline, 3);
	assert.equal(loadStoredOutline("a"), undefined, "oldest entry is evicted past the limit");
	for (const id of ["b", "c", "d"]) assert.deepEqual(loadStoredOutline(id), outline);
	saveStoredOutline("b", { ...outline, lookId: "newer" }, 3);
	assert.equal(loadStoredOutline("b")?.lookId, "newer", "re-saving a state replaces it");
	assert.equal(loadStoredOutline("c")?.lookId, "look", "a replacement does not evict a live entry");
	assert.equal(fs.readdirSync(outlineStoreDir()).length, 3, "one file per state, capped");
	assert.equal(loadStoredOutline("never-saved"), undefined);
});

test("default cap keeps the newest 64 states", async () => {
	const { saveStoredOutline, loadStoredOutline, OUTLINE_STORE_LIMIT, serializeOutline } = await modules();
	assert.equal(OUTLINE_STORE_LIMIT, 64);
	const outline = serializeOutline(outlineOf(0, 0));
	for (let i = 0; i < 70; i++) saveStoredOutline(`s${i}`, outline);
	assert.equal(loadStoredOutline("s5"), undefined);
	assert.ok(loadStoredOutline("s6"));
	assert.ok(loadStoredOutline("s69"));
});

test("unreadable or mismatched entries load as missing", async () => {
	const { saveStoredOutline, loadStoredOutline, outlineStoreDir, serializeOutline } = await modules();
	saveStoredOutline("x", serializeOutline(outlineOf(0, 0)));
	const dir = outlineStoreDir();
	const [file] = fs.readdirSync(dir);
	fs.writeFileSync(`${dir}/${file}`, "{not json");
	assert.equal(loadStoredOutline("x"), undefined);
	fs.writeFileSync(`${dir}/${file}`, JSON.stringify({ stateId: "other", outline: serializeOutline(outlineOf(0, 0)) }));
	assert.equal(loadStoredOutline("x"), undefined);
});

test("tool results keep only stateId and lookId; the outline goes to the store", async () => {
	const { testing, loadStoredOutline } = await modules();
	const outline = outlineOf(4, 7);
	const result = await testing.runInOperation(() => testing.buildToolResult("observe_ui", "Observed.", capture(outline, "S-big"), {}, undefined, "never"));
	const bytes = JSON.stringify(result.details).length;
	assert.equal(result.details.outline, undefined);
	assert.equal(result.details.capture.stateId, "S-big");
	assert.equal(result.details.lookId, "look");
	assert.ok(outline.nodes.length > 2000);
	assert.ok(bytes < 20_000, `details stay bounded: ${bytes} bytes for ${outline.nodes.length} nodes`);
	assert.equal(loadStoredOutline("S-big")?.root.children.length, 7);
});

test("restore reads a new-format session from the store", async () => {
	const { testing, reconstructStateFromBranch } = await modules();
	const outline = outlineOf(2, 3, "look-new");
	const result = await testing.runInOperation(() => testing.buildToolResult("observe_ui", "Observed.", capture(outline, "S-new"), {}, undefined, "never"));
	reconstructStateFromBranch(branchOf(JSON.parse(JSON.stringify(result.details))));
	const restored = testing.savedState("S-new");
	assert.equal(restored?.value.kind, "desktop");
	assert.equal(restored?.value.outline.lookId, "look-new");
	assert.equal(restored?.value.outline.root.children.length, 3);
	assert.equal(restored?.value.look.lookId, "look-new");
});

test("restore still reads sessions that embed the full outline", async () => {
	const { testing, reconstructStateFromBranch, outlineStoreDir, serializeOutline } = await modules();
	const outline = outlineOf(2, 3, "look-old");
	const result = await testing.runInOperation(() => testing.buildToolResult("observe_ui", "Observed.", capture(outline, "S-old"), {}, undefined, "never"));
	fs.rmSync(outlineStoreDir(), { recursive: true, force: true });
	const legacy = { ...JSON.parse(JSON.stringify(result.details)), outline: JSON.parse(JSON.stringify(serializeOutline(outline))) };
	reconstructStateFromBranch(branchOf(legacy));
	assert.equal(testing.savedState("S-old")?.value.outline.lookId, "look-old");
});

test("restore with an evicted store entry skips the state instead of throwing", async () => {
	const { testing, reconstructStateFromBranch, outlineStoreDir } = await modules();
	const result = await testing.runInOperation(() => testing.buildToolResult("observe_ui", "Observed.", capture(outlineOf(1, 2), "S-gone"), {}, undefined, "never"));
	fs.rmSync(outlineStoreDir(), { recursive: true, force: true });
	assert.doesNotThrow(() => reconstructStateFromBranch(branchOf(JSON.parse(JSON.stringify(result.details)))));
	assert.equal(testing.savedState("S-gone"), undefined, "the state is unavailable, so tools report the stale-state error");
	const { executeSearchUi } = await import("../src/bridge.ts");
	await assert.rejects(() => executeSearchUi("call", { stateId: "S-gone", text: "x" }, undefined, undefined, {}), /State 'S-gone' is unavailable or was evicted/);
});

test("a failed write removes its temporary file", async () => {
	const { saveStoredOutline, loadStoredOutline, outlineStoreDir, serializeOutline } = await modules();
	const outline = serializeOutline(outlineOf(0, 0));
	const now = vi.spyOn(Date, "now").mockReturnValue(1);
	try {
		saveStoredOutline("w", outline);
		const dir = outlineStoreDir();
		const [first] = fs.readdirSync(dir);
		// The next save reuses the timestamp with the next sequence number; block its final name with a non-empty directory so the rename fails.
		const blocked = first.replace(/-(\d{6})-/, (_, seq) => `-${String(Number(seq) + 1).padStart(6, "0")}-`);
		fs.mkdirSync(`${dir}/${blocked}`);
		fs.writeFileSync(`${dir}/${blocked}/keep`, "x");
		assert.doesNotThrow(() => saveStoredOutline("w", outline));
		assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp")), []);
		fs.rmSync(`${dir}/${blocked}`, { recursive: true });
		assert.ok(loadStoredOutline("w"), "the earlier entry survives the failed write");
	} finally {
		now.mockRestore();
	}
});
