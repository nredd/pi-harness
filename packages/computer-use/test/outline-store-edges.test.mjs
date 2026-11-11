// Edge cases for the agent-cache outline store: stray files, bad shapes, failed writes (#702).
import assert from "node:assert/strict";
import fs from "node:fs";
import { beforeEach, test } from "vitest";

const outlineOf = () => {
	const node = { ref: "@e1", wireRef: "w1", role: "AXGroup", subrole: "", identifier: "", title: "t", description: "", value: "", actions: [], canPress: false, canFocus: false, canSetValue: false, canScroll: false, canIncrement: false, canDecrement: false, isTextInput: false, focused: false, offscreen: false, pictureOnly: false, truncated: false, text: [], children: [] };
	return { lookId: "look", root: node, nodes: [node], refToWireRef: new Map(), wireRefToRef: new Map() };
};

async function modules() {
	const store = await import("../src/outline-store.ts");
	const { serializeOutline } = await import("../src/outline.ts");
	return { ...store, serializeOutline };
}

beforeEach(async () => {
	const { outlineStoreDir } = await import("../src/outline-store.ts");
	fs.rmSync(outlineStoreDir(), { recursive: true, force: true });
});

test("a missing store directory, stray files and unreadable states are all tolerated", async () => {
	const { saveStoredOutline, loadStoredOutline, outlineStoreDir, serializeOutline } = await modules();
	assert.equal(loadStoredOutline("anything"), undefined, "no directory yet");
	const outline = serializeOutline(outlineOf());
	saveStoredOutline("real", outline);
	const dir = outlineStoreDir();
	const [entry] = fs.readdirSync(dir);
	const strays = ["README", "0-1-abc.json", `.tmp-${"0".repeat(32)}.json`, `.${entry}.tmp`];
	for (const stray of strays) fs.writeFileSync(`${dir}/${stray}`, "x");
	saveStoredOutline("other", outline, 1);
	assert.equal(fs.readdirSync(dir).filter((name) => /^\d{16}-/.test(name)).length, 1, "only well-formed entries are counted and evicted");
	for (const stray of strays) assert.ok(fs.existsSync(`${dir}/${stray}`), `${stray} is never deleted`);
	assert.ok(loadStoredOutline("other"));
	assert.equal(loadStoredOutline("real"), undefined);
});

test("shape-invalid entries load as missing", async () => {
	const { saveStoredOutline, loadStoredOutline, outlineStoreDir, serializeOutline } = await modules();
	const outline = serializeOutline(outlineOf());
	saveStoredOutline("x", outline);
	const dir = outlineStoreDir();
	const [file] = fs.readdirSync(dir);
	for (const body of [{ stateId: "x" }, { stateId: "x", outline: { lookId: "l" } }, { stateId: "x", outline: { root: outline.root, lookId: 4 } }]) {
		fs.writeFileSync(`${dir}/${file}`, JSON.stringify(body));
		assert.equal(loadStoredOutline("x"), undefined, JSON.stringify(Object.keys(body)));
	}
});

test("a save that cannot serialize is swallowed and leaves nothing loadable", async () => {
	const { saveStoredOutline, loadStoredOutline } = await modules();
	const circular = {};
	circular.self = circular;
	assert.doesNotThrow(() => saveStoredOutline("bad", { lookId: "l", root: circular }));
	assert.equal(loadStoredOutline("bad"), undefined);
});

test("load returns the newest entry when two copies of a state exist", async () => {
	const { loadStoredOutline, outlineStoreDir, serializeOutline } = await modules();
	const dir = outlineStoreDir();
	fs.mkdirSync(dir, { recursive: true });
	const { createHash } = await import("node:crypto");
	const key = createHash("sha256").update("dup").digest("hex").slice(0, 32);
	const outline = serializeOutline(outlineOf());
	for (const [stamp, lookId] of [["0000000000000001", "older"], ["0000000000000002", "newer"]]) {
		fs.writeFileSync(`${dir}/${stamp}-000000-${key}.json`, JSON.stringify({ stateId: "dup", outline: { ...outline, lookId } }));
	}
	assert.equal(loadStoredOutline("dup")?.lookId, "newer");
});

test("eviction drops the oldest states and keeps the newest", async () => {
	const { saveStoredOutline, loadStoredOutline, serializeOutline } = await modules();
	const outline = serializeOutline(outlineOf());
	for (const id of ["a", "b", "c"]) saveStoredOutline(id, outline, 2);
	assert.equal(loadStoredOutline("a"), undefined);
	assert.ok(loadStoredOutline("b"));
	assert.ok(loadStoredOutline("c"));
});
