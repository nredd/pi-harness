// `src/note.ts` region notes and `src/view.ts` ref stabilisation, diffing and rendering (nredd/pi-harness#703, Refs #645).
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { noteAfterAct, noteFromLook, noteRegionKeyForRef, renderNote } from "../src/note.ts";
import { changesBetween, renderChanges, stabilizeRefs } from "../src/view.ts";
import { outlineNode as n, outlineOf } from "./support/outline-nodes.mjs";

const win = { windowRef: "@r1", title: "Doc", pairing: "exact" };
const regionsOf = (note) => note.regions.map(({ key, label, status, detail }) => [key, label, status, detail]);

describe("noteFromLook", () => {
	test("each top-level node is a seen region keyed by role and identifier or label", () => {
		const root = n("@e0", { children: [n("@e1", { role: "AXToolbar", identifier: "tb" }), n("@e2", { role: "", title: "  Side  Bar " }), n("@e3", { role: "AXList" })] });
		const note = noteFromLook(undefined, outlineOf(root), win);
		assert.deepEqual(regionsOf(note), [
			["AXToolbar:tb", "tb", "seen", undefined],
			["AXUnknown:side bar", "side bar", "seen", undefined],
			["AXList:axlist", "axlist", "seen", undefined],
		]);
		assert.deepEqual({ ...note, regions: undefined }, { windowRef: "@r1", title: "Doc", pairing: "exact", lastLookId: "look1", regions: undefined });
	});

	test("a childless root is its own region; blank labels fall back to the role, then the ref", () => {
		const blankRole = noteFromLook(undefined, outlineOf(n("@e9", { title: " " })), win);
		assert.deepEqual(regionsOf(blankRole), [["AXGroup:@e9", "axgroup", "seen", undefined]]);
		const blankBoth = noteFromLook(undefined, outlineOf(n("@e8", { role: "", title: " " })), win);
		assert.deepEqual(regionsOf(blankBoth), [["AXUnknown:@e8", "@e8", "seen", undefined]]);
		const bare = noteFromLook(undefined, outlineOf(n("@e7", { role: "" })), win);
		assert.deepEqual(regionsOf(bare), [["AXUnknown:@e7", "@e7", "seen", undefined]]);
	});

	test("regions that vanished since the previous look are changed, never-looked ones are dropped", () => {
		const prev = {
			windowRef: "@r1",
			title: "Doc",
			pairing: "exact",
			regions: [
				{ key: "AXList:axlist", label: "axlist", status: "seen" },
				{ key: "AXGone:x", label: "gone", status: "seen" },
				{ key: "AXLazy:y", label: "lazy", status: "never-looked" },
			],
		};
		const note = noteFromLook(prev, outlineOf(n("@e0", { children: [n("@e3", { role: "AXList" })] })), win);
		assert.deepEqual(regionsOf(note), [
			["AXList:axlist", "axlist", "seen", undefined],
			["AXGone:x", "gone", "changed", "not matched in latest look"],
		]);
	});

	test("an unpaired window adds a capture region, by missing ref or by -Infinity score", () => {
		const root = n("@e0", { children: [n("@e1")] });
		const missing = noteFromLook(undefined, outlineOf(root), { title: "T" });
		assert.deepEqual({ windowRef: missing.windowRef, pairing: missing.pairing }, { windowRef: "(unpaired)", pairing: "low" });
		assert.deepEqual(regionsOf(missing).at(-1), ["window:unpaired", "window capture", "never-looked", "AX window without capture pairing"]);
		const scored = noteFromLook(undefined, outlineOf(root), { windowRef: "@r2", title: "T", pairingScore: Number.NEGATIVE_INFINITY });
		assert.equal(scored.windowRef, "@r2");
		assert.equal(regionsOf(scored).at(-1)[0], "window:unpaired");
		const paired = noteFromLook(undefined, outlineOf(root), { windowRef: "@r2", title: "T", pairingScore: 3 });
		assert.equal(paired.regions.some((r) => r.key === "window:unpaired"), false);
	});

	test("partially scrolled and truncated subtrees are never-looked frontiers under their top-level region", () => {
		const list = n("@e2", { role: "AXList", scrollExtent: { seen: 10, total: 50 }, children: [n("@e3", { truncated: true, scrollExtent: { seen: 5, total: 5 } })] });
		const full = n("@e4", { role: "AXTable", scrollExtent: { seen: 4, total: 4 } });
		const root = n("@e0", { children: [list, full] });
		const note = noteFromLook(undefined, outlineOf(root), win);
		assert.deepEqual(regionsOf(note).slice(2), [
			["AXList:axlist:scroll:@e2", "axlist", "never-looked", "50 rows, 10 seen"],
			["AXList:axlist:truncated:@e3", "axlist", "never-looked", "subtree not walked"],
		]);
	});

	test("a frontier node outside every top-level region is keyed by its own ancestor", () => {
		const stray = n("@e5", { role: "AXSheet", scrollExtent: { seen: 1, total: 2 } });
		const strayTruncated = n("@e6", { role: "AXPopover", truncated: true });
		const outline = outlineOf(n("@e0", { children: [n("@e1")] }), { extra: [stray, strayTruncated] });
		assert.deepEqual(regionsOf(noteFromLook(undefined, outline, win)).slice(1), [
			["AXSheet:axsheet:scroll:@e5", "axsheet", "never-looked", "2 rows, 1 seen"],
			["AXPopover:axpopover:truncated:@e6", "axpopover", "never-looked", "subtree not walked"],
		]);
	});

	test("identical regions are de-duplicated", () => {
		const root = n("@e0", { children: [n("@e1", { role: "AXList" }), n("@e2", { role: "AXList" })] });
		assert.equal(noteFromLook(undefined, outlineOf(root), win).regions.length, 1);
	});
});

describe("noteAfterAct", () => {
	const outline = () => outlineOf(n("@e0", { children: [n("@e1", { role: "AXList", children: [n("@e2")] }), n("@e3", { role: "AXToolbar" })] }));

	test("no target leaves the note as a plain look", () => {
		const note = noteAfterAct(undefined, undefined, outline(), { window: win });
		assert.deepEqual(note.regions.map((r) => r.status), ["seen", "seen"]);
	});

	test("the acted-on top-level region is changed, an unknown ref is ignored", () => {
		const note = noteAfterAct(undefined, "@e2", outline(), { window: win });
		assert.deepEqual(regionsOf(note), [["AXList:axlist", "axlist", "changed", "acted here"], ["AXToolbar:axtoolbar", "axtoolbar", "seen", undefined]]);
		const none = noteAfterAct(undefined, "@e99", outline(), { window: win });
		assert.deepEqual(none.regions.map((r) => r.status), ["seen", "seen"]);
	});

	test("a target outside the known regions is prepended as a changed region", () => {
		const stray = n("@e5", { role: "AXSheet" });
		const note = noteAfterAct(undefined, "@e5", outlineOf(n("@e0", { children: [n("@e1")] }), { extra: [stray] }), { window: win });
		assert.deepEqual(regionsOf(note)[0], ["AXSheet:axsheet", "axsheet", "changed", "acted here"]);
	});

	test("root deltas are prepended, closed ones as changed", () => {
		const note = noteAfterAct(undefined, undefined, outline(), {
			window: win,
			rootDelta: [
				{ change: "closed", kind: "dialog", ref: "@r5", title: "Save" },
				{ change: "appeared", kind: "menu" },
			],
		});
		assert.deepEqual(regionsOf(note).slice(0, 2), [
			["root:appeared:menu:", "menu", "never-looked", "root appeared"],
			["root:closed:@r5:Save", "dialog Save", "changed", "root closed"],
		]);
	});

	test("a window change marks seen regions changed and appends the new window", () => {
		const note = noteAfterAct(undefined, undefined, outline(), { window: win, windowChanged: true, newWindowLabel: "Sheet" });
		assert.deepEqual(note.regions.map((r) => r.status), ["changed", "changed", "never-looked"]);
		assert.deepEqual(regionsOf(note).at(-1), ["window:changed:look1", "Sheet", "never-looked", "appeared after act"]);
		const unpaired = noteAfterAct(undefined, undefined, outline(), { window: { title: "T" }, windowChanged: true });
		assert.deepEqual(unpaired.regions.map((r) => r.status), ["changed", "changed", "never-looked", "never-looked"], "regions that were never looked at keep their status");
		const unlabeled = noteAfterAct(undefined, undefined, outlineOf(n("@e0", { children: [n("@e1")] }), { lookId: null }), { window: win, windowChanged: true });
		assert.deepEqual(regionsOf(unlabeled).at(-1), ["window:changed:unknown", "new sheet/window", "never-looked", "appeared after act"]);
	});
});

describe("noteRegionKeyForRef", () => {
	test("resolves a nested ref to its top-level region key", () => {
		const outline = outlineOf(n("@e0", { children: [n("@e1", { role: "AXList", children: [n("@e2")] })] }));
		assert.equal(noteRegionKeyForRef(outline, "@e2"), "AXList:axlist");
		assert.equal(noteRegionKeyForRef(outline, "@e404"), undefined);
	});
});

describe("renderNote", () => {
	const regionsNote = (count) => ({ windowRef: "@r1", title: "Doc", pairing: "high", regions: Array.from({ length: count }, (_, i) => ({ key: `k${i}`, label: `region ${i}`, status: "seen" })) });

	test("nothing renders as empty", () => assert.equal(renderNote(undefined), ""));

	test("header reports pairing and whether the window was looked at", () => {
		assert.equal(renderNote({ windowRef: "@r1", title: "Doc", pairing: "low", regions: [] }), 'note @r1 "Doc" (pairing low, not looked)');
		const looked = renderNote({ windowRef: "@r1", title: "x".repeat(600), pairing: "exact", lastLookId: "l", regions: [{ key: "k", label: "list", status: "changed", detail: "d".repeat(300) }] });
		const [head, line] = looked.split("\n");
		assert.equal(head, `note @r1 "${"x".repeat(512)}" (pairing exact, looked just now)`);
		assert.equal(line, `  list           changed   (${"d".repeat(256)})`);
	});

	test("more than 64 regions are summarised", () => {
		const lines = renderNote(regionsNote(70)).split("\n");
		assert.equal(lines.length, 1 + 64 + 1);
		assert.equal(lines.at(-1), "  … 6 more note regions; use search_ui or expand_ui");
	});

	test.each([0, 1, 2, 3])("the 8 KiB budget cuts on a UTF-8 boundary (pad %i)", (pad) => {
		const note = { windowRef: "@r1", title: "t".repeat(pad), pairing: "high", regions: Array.from({ length: 64 }, (_, i) => ({ key: `k${i}`, label: "é".repeat(256), status: "seen" })) };
		const text = renderNote(note);
		assert.ok(text.endsWith("\n… note byte budget reached"));
		assert.equal(text.includes("\uFFFD"), false, "no split character");
		assert.ok(new TextEncoder().encode(text).byteLength <= 8 * 1024 + 30);
	});
});

describe("stabilizeRefs", () => {
	const tree = (children) => outlineOf(n("@e0", { wireRef: "w0", title: "root", children }));

	test("no base keeps the next outline as is", () => {
		const next = tree([]);
		assert.equal(stabilizeRefs(undefined, next), next);
	});

	test("wire refs and unique structure keep public refs; unmatched nodes get fresh ones", () => {
		const base = tree([n("@e1", { wireRef: "wa", title: "A" }), n("@e2", { title: "twin" }), n("@e3", { title: "twin" }), n("@r7", { title: "odd" })]);
		const next = tree([n("@e9", { wireRef: "wa", title: "renamed" }), n("@e8", { title: "twin" }), n("@e7", { title: "twin" }), n("@e6", { title: "odd" }), n("@e5", { title: "new" })]);
		stabilizeRefs(base, next);
		assert.deepEqual(next.nodes.map((node) => node.ref), ["@e0", "@e1", "@e2", "@e3", "@r7", "@e4"]);
		assert.equal(next.refToWireRef.get("@e1"), "wa");
		assert.equal(next.wireRefToRef.get("wa"), "@e1");
		assert.equal(next.refToWireRef.has("@e4"), false, "nodes without a wire ref are not indexed");
	});
});

describe("changesBetween and renderChanges", () => {
	const mk = (children, over = {}) => outlineOf(n("@e0", { title: "root", ...over, children }));

	test("a different root role or subrole replaces the whole view", () => {
		const base = mk([n("@e1")]);
		const diff = changesBetween(base, mk([n("@e1"), n("@e2")], { role: "AXSheet" }));
		assert.deepEqual(diff, { changes: [], changedNodeCount: 3, fullNodeCount: 3, useFullView: true, reason: "root_replaced" });
		assert.equal(changesBetween(base, mk([n("@e1")], { subrole: "AXDialog" })).reason, "root_replaced");
	});

	test("added, updated and removed nodes are listed and rendered", () => {
		const base = mk([n("@e1", { title: "Save", value: "a" }), n("@e2", { title: "Gone" }), n("@e3", { title: "Keep", text: [{ string: "t", confidence: 0.5, rect: { x: 0, y: 0, w: 1, h: 1 } }], rect: { x: 1.2, y: 2, w: 3, h: 4 }, actions: ["AXPress"] })]);
		const next = mk([n("@e1", { title: "Save", value: "b" }), n("@e3", { title: "Keep", text: [{ string: "t2", confidence: 0.5 }], rect: { x: 1.4, y: 2, w: 3, h: 4 }, actions: ["AXShowMenu"] }), n("@e4", { description: "New one" })]);
		const diff = changesBetween(base, next);
		assert.deepEqual(diff.changes.map((c) => [c.type, c.ref]), [["updated", "@e1"], ["updated", "@e3"], ["added", "@e4"], ["removed", "@e2"]]);
		assert.equal(diff.useFullView, false);
		assert.equal(diff.reason, undefined);
		assert.equal(diff.changedNodeCount, 4);
		assert.equal(renderChanges(diff.changes), [
			'~ @e1 (@e0 > @e1) value="b"',
			'~ @e3 (@e0 > @e3) text=["t2"], actions=["AXShowMenu"]',
			'+ @e4 under @e0 "New one"',
			"- @e2 from @e0",
		].join("\n"));
	});

	test("rect jitter below a point is not a change", () => {
		const a = mk([n("@e1", { rect: { x: 1.1, y: 2.2, w: 3.3, h: 4.4 } })]);
		const b = mk([n("@e1", { rect: { x: 1.2, y: 2.3, w: 3.2, h: 4.3 } })]);
		assert.deepEqual(changesBetween(a, b).changes, []);
		assert.deepEqual(changesBetween(mk([n("@e1")]), mk([n("@e1", { rect: { x: 0, y: 0, w: 1, h: 1 } })])).changes.map((c) => c.type), ["updated"]);
	});

	test("many low-identity nodes fall back to the full view", () => {
		const base = mk(Array.from({ length: 10 }, (_, i) => n(`@e${i + 1}`, { title: `old${i}` })));
		const next = mk(Array.from({ length: 10 }, (_, i) => n(`@e${i + 20}`, { title: `new${i}` })));
		const diff = changesBetween(base, next);
		assert.equal(diff.useFullView, true);
		assert.equal(diff.reason, "identity_confidence_low");
	});

	test("more than 100 changes, or a majority of more than 20, exceed the change budget", () => {
		const big = (prefix, count, over) => mk(Array.from({ length: count }, (_, i) => n(`@e${i + 1}`, { title: `${prefix}${i}`, ...over })));
		const hundred = changesBetween(big("a", 120, {}), big("b", 120, {}));
		assert.equal(hundred.reason, "change_budget_exceeded");
		const ratio = changesBetween(big("a", 30, {}), big("b", 30, {}));
		assert.equal(ratio.reason, "change_budget_exceeded");
		const calm = changesBetween(big("a", 30, {}), mk([...big("a", 30, {}).root.children.slice(0, 29).map((c) => n(c.ref, { title: c.title })), n("@e30", { title: "changed" })]));
		assert.equal(calm.useFullView, false);
		const empty = changesBetween(mk([n("@e1")]), { ...mk([]), nodes: [] });
		assert.equal(empty.useFullView, false, "no next nodes means full identity confidence");
		assert.equal(empty.fullNodeCount, 0);
	});

	test("labels fall back through title, description, value, identifier, text and role", () => {
		const added = (over) => renderChanges(changesBetween(mk([]), mk([n("@e1", { role: "", ...over })])).changes);
		assert.equal(added({ title: "T" }), '+ @e1 under @e0 "T"');
		assert.equal(added({ description: "D" }), '+ @e1 under @e0 "D"');
		assert.equal(added({ value: "V" }), '+ @e1 under @e0 "V"');
		assert.equal(added({ identifier: "I" }), '+ @e1 under @e0 "I"');
		assert.equal(added({ text: [{ string: "a", confidence: 1 }, { string: "b", confidence: 1 }] }), '+ @e1 under @e0 "a b"');
		assert.equal(added({ role: "AXButton" }).replace("AXButton", "R"), '+ @e1 under @e0 "R"');
		assert.equal(added({}), '+ @e1 under @e0 "node"');
	});

	test("unparented added nodes and unlabelled updates render without a location", () => {
		assert.equal(renderChanges([{ type: "added", ref: "@e1", node: { title: "x", description: "", value: "", identifier: "", text: [], role: "r", children: [] } }]), '+ @e1 "x"');
		assert.equal(renderChanges([{ type: "removed", ref: "@e1" }]), "- @e1");
		assert.equal(renderChanges([{ type: "updated", ref: "@e1", path: ["@e0", "@e1"], fields: { rect: { x: 1, y: 1, w: 1, h: 1 } } }]), "~ @e1 (@e0 > @e1) changed");
	});
});
