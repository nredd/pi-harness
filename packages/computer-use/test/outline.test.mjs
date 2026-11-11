// Pure-module coverage for src/outline.ts: parse fallbacks, search, serialization and the scoped graft (#702).
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	controlLine,
	countOutlineNodes,
	foldToBudget,
	graftScopedOutline,
	isInteractiveControl,
	nodeByRef,
	outlineNodeLabel,
	outlineNodePath,
	parseLookResponse,
	rankedTextMatch,
	renderInteractiveControls,
	restoreOutline,
	searchOutline,
	searchOutlineRanked,
	serializeOutline,
	serializeOutlineNodeShallow,
	serializeOutlineSearchMatch,
} from "../src/outline.ts";

const look = (outline, extra = {}) => parseLookResponse({ lookId: "look", capturedAt: 5, window: {}, outline, ...extra });
const outlineOf = (outline) => look(outline).parsedOutline;
const refs = (outline) => outline.nodes.map((node) => node.ref);

describe("parseLookResponse fallbacks", () => {
	test("non-record input has no lookId and is rejected", () => {
		for (const raw of [undefined, null, 7, "x", {}, { lookId: 3 }]) {
			assert.throws(() => parseLookResponse(raw), /without lookId/);
		}
	});

	test("missing window, outline, image and readText default safely", () => {
		const parsed = parseLookResponse({ lookId: "l", capturedAt: "not a number", outline: 5 });
		assert.ok(Number.isFinite(parsed.capturedAt) && parsed.capturedAt > 1e9, "capturedAt falls back to now (seconds)");
		assert.deepEqual(parsed.window, { windowId: 0, rootRef: undefined, kind: undefined, framePoints: { x: 0, y: 0, w: 0, h: 0 }, scaleFactor: 1, isModal: false, metadata: undefined, role: "", subrole: "" });
		assert.equal(parsed.image, undefined);
		assert.equal(parsed.readText, undefined);
		assert.deepEqual(parsed.timings, {});
		assert.equal(parsed.outline.role, "");
		assert.deepEqual(parsed.outline.children, []);
		assert.equal(parsed.outline.wireRef, undefined);
		assert.equal(parsed.outline.ref, "@e1");
		assert.equal(parsed.parsedOutline.refToWireRef.size, 0);
	});

	test("window fields are coerced and clamped", () => {
		const parsed = look({}, { window: { windowId: "12.9", rootRef: "root", kind: "dialog", framePoints: { x: "3", y: "x", w: -4, h: 9 }, scaleFactor: 0.2, isModal: true, metadata: { a: 1 }, role: "AXWindow", subrole: "AXDialog" } });
		assert.deepEqual(parsed.window, { windowId: 12, rootRef: "root", kind: "dialog", framePoints: { x: 3, y: 0, w: 0, h: 9 }, scaleFactor: 1, isModal: true, metadata: { a: 1 }, role: "AXWindow", subrole: "AXDialog" });
		assert.equal(look({}, { window: { scaleFactor: 2.5, metadata: "nope" } }).window.scaleFactor, 2.5);
		assert.equal(look({}, { window: { metadata: "nope" } }).window.metadata, undefined);
	});

	test("image mime type, dimensions and base64 fall back", () => {
		const png = look({}, { image: { jpegBase64: "AAA", mimeType: "image/png", width: "640.7", height: 480 } }).image;
		assert.deepEqual(png, { jpegBase64: "AAA", mimeType: "image/png", width: 640, height: 480 });
		const odd = look({}, { image: { jpegBase64: 9, mimeType: "image/gif", width: 0 } }).image;
		assert.deepEqual(odd, { jpegBase64: "", mimeType: "image/jpeg", width: 1, height: 1 });
	});

	test("readText requested accepts only known modes", () => {
		for (const requested of ["auto", "always", "never"]) assert.deepEqual(look({}, { readText: { requested, executed: true } }).readText, { requested, executed: true });
		assert.deepEqual(look({}, { readText: { requested: "sometimes", executed: "yes" } }).readText, { requested: undefined, executed: false });
		assert.equal(look({}, { readText: "x" }).readText, undefined);
	});

	test("timings coerce numeric strings and zero the rest", () => {
		assert.deepEqual(look({}, { timings: { a: 1.5, b: "2", c: "zzz", d: null } }).timings, { a: 1.5, b: 2, c: 0, d: 0 });
		assert.deepEqual(look({}, { timings: [] }).timings, {});
	});

	test("node fields: rect, scrollExtent, text, actions and children are sanitized", () => {
		const root = look({
			ref: "r",
			role: "AXGroup",
			title: 4,
			rect: { x: "1", y: Number.NaN, w: -3, h: Infinity },
			scrollExtent: { seen: 3.9, total: -2 },
			actions: ["AXPress", 7, null, "AXShowMenu"],
			text: [null, "str", { string: "" }, { string: "hi", confidence: 9, rect: { x: 1, y: 2, w: 3, h: 4 } }, { string: "lo", confidence: -1 }],
			canPress: "true",
			focused: true,
			children: [null, 3, { ref: "c", role: "AXButton" }],
		}).outline;
		assert.equal(root.title, "", "non-string title becomes empty");
		assert.deepEqual(root.rect, { x: 1, y: 0, w: 0, h: 0 });
		assert.deepEqual(root.scrollExtent, { seen: 3, total: 0 });
		assert.deepEqual(root.actions, ["AXPress", "AXShowMenu"]);
		assert.equal(root.canPress, false, "only literal true is truthy");
		assert.equal(root.focused, true);
		assert.deepEqual(root.text, [
			{ string: "hi", confidence: 1, rect: { x: 1, y: 2, w: 3, h: 4 } },
			{ string: "lo", confidence: 0, rect: { x: 0, y: 0, w: 0, h: 0 } },
		]);
		assert.equal(root.children.length, 3, "malformed children still occupy a slot as empty nodes");
		assert.equal(root.children[2].wireRef, "c");
		assert.equal(root.children[0].parent, root);
		assert.equal(root.children[2].ref, "@e4");
		assert.equal(look({ children: "x", text: "x", actions: "x" }).outline.children.length, 0);
	});

	test("wire refs map both ways in breadth-first order", () => {
		const { parsedOutline } = look({ ref: "a", children: [{ ref: "b", children: [{ ref: "d" }] }, { ref: "c" }, {}] });
		assert.deepEqual(refs(parsedOutline), ["@e1", "@e2", "@e3", "@e4", "@e5"]);
		assert.deepEqual([...parsedOutline.refToWireRef], [["@e1", "a"], ["@e2", "b"], ["@e3", "c"], ["@e5", "d"]]);
		assert.equal(parsedOutline.wireRefToRef.get("d"), "@e5");
		assert.equal(nodeByRef(parsedOutline, "d")?.ref, "@e5", "lookup by wire ref");
		assert.equal(nodeByRef(parsedOutline, "@e3")?.wireRef, "c");
		assert.equal(nodeByRef(parsedOutline, "@e99"), undefined);
	});
});

const tree = () =>
	outlineOf({
		ref: "root",
		role: "AXWindow",
		title: "Main",
		children: [
			{ ref: "btn", role: "AXButton", title: "Save", description: "Writes the file", actions: ["AXPress"], canPress: true },
			{ ref: "fld", role: "AXTextField", subrole: "AXSearchField", value: "needle", identifier: "search-box" },
			{ ref: "grp", role: "AXGroup", children: [{ ref: "lbl", role: "AXStaticText", text: [{ string: "OCR words", confidence: 0.9 }] }] },
		],
	});

describe("searchOutline", () => {
	test("matches text across label, role, subrole, identifier, description, value and OCR", () => {
		const outline = tree();
		const hit = (text) => searchOutline(outline, text).map((match) => match.ref);
		assert.deepEqual(hit("save"), ["@e2"]);
		assert.deepEqual(hit("  WRITES "), ["@e2"], "trimmed and case-insensitive; description is searched even when title wins the label");
		assert.deepEqual(hit("needle"), ["@e3"]);
		assert.deepEqual(hit("searchfield"), ["@e3"], "subrole");
		assert.deepEqual(hit("search-box"), ["@e3"]);
		assert.deepEqual(hit("ocr words"), ["@e5"]);
		assert.deepEqual(hit("no such thing"), []);
	});

	test("role is an exact match and action uses the capability matcher", () => {
		const outline = tree();
		assert.deepEqual(searchOutline(outline, undefined, "AXButton").map((m) => m.ref), ["@e2"]);
		assert.deepEqual(searchOutline(outline, undefined, "Button"), [], "role must match exactly");
		assert.deepEqual(searchOutline(outline, undefined, undefined, "press").map((m) => m.ref), ["@e2"]);
		assert.deepEqual(searchOutline(outline, undefined, undefined, "nothing"), []);
		assert.deepEqual(searchOutline(outline, "save", "AXGroup"), []);
	});

	test("no filters returns everything, capped by limit; results carry label, path and actions", () => {
		const outline = tree();
		assert.equal(searchOutline(outline).length, 5);
		const limited = searchOutline(outline, undefined, undefined, undefined, 2);
		assert.deepEqual(limited.map((m) => m.ref), ["@e1", "@e2"]);
		const save = searchOutline(outline, "save")[0];
		assert.equal(save.label, "Save");
		assert.deepEqual(save.actions, ["AXPress"]);
		assert.equal(save.path, 'AXWindow "Main" ▸ AXButton "Save"');
		assert.equal(save.node, outline.nodes[1]);
	});

	test("serializeOutlineSearchMatch drops only the live node", () => {
		const [match] = searchOutline(tree(), "save");
		const serialized = serializeOutlineSearchMatch(match);
		assert.equal("node" in serialized, false);
		assert.deepEqual(serialized, { ref: "@e2", role: "AXButton", label: "Save", actions: ["AXPress"], path: match.path });
	});
});

describe("counting and serialization", () => {
	test("countOutlineNodes counts the whole subtree", () => {
		const outline = tree();
		assert.equal(countOutlineNodes(outline.root), 5);
		assert.equal(countOutlineNodes(outline.nodes[3]), 2);
		assert.equal(countOutlineNodes(outline.nodes[1]), 1);
	});

	test("serializeOutlineNodeShallow drops parent and children, copies the rest", () => {
		const outline = tree();
		const shallow = serializeOutlineNodeShallow(outline.nodes[3]);
		assert.equal("parent" in shallow, false);
		assert.deepEqual(shallow.children, []);
		assert.equal(shallow.ref, "@e4");
		assert.equal(shallow.wireRef, "grp");
		assert.equal(outline.nodes[3].children.length, 1, "source node is untouched");
	});

	test("restoreOutline skips nodes without a wire ref in the maps", () => {
		const restored = restoreOutline({ lookId: "l", root: serializeOutline(outlineOf({ children: [{ ref: "w" }, {}] })).root });
		assert.deepEqual([...restored.refToWireRef], [["@e2", "w"]]);
		assert.equal(restored.nodes.length, 3);
	});

	test("serialize then restore round-trips structure and indexes", () => {
		const outline = tree();
		const restored = restoreOutline(JSON.parse(JSON.stringify(serializeOutline(outline))));
		assert.deepEqual(refs(restored), refs(outline));
		assert.deepEqual([...restored.wireRefToRef], [...outline.wireRefToRef]);
		assert.equal(restored.nodes[4].parent, restored.nodes[3]);
	});
});

/** Tree for graft tests: window -> pane(@e2) -> [keep, gone, nested -> deep]. */
const graftBase = () =>
	outlineOf({
		ref: "win",
		role: "AXWindow",
		rect: { x: 0, y: 0, w: 800, h: 600 },
		children: [
			{
				ref: "pane",
				role: "AXScrollArea",
				title: "Old pane",
				truncated: true,
				rect: { x: 10, y: 20, w: 300, h: 400 },
				children: [
					{ ref: "keep", role: "AXButton", title: "Old keep", rect: { x: 11, y: 21, w: 5, h: 5 } },
					{ ref: "gone", role: "AXButton", title: "Stale child", rect: { x: 1, y: 1, w: 1, h: 1 }, children: [{ ref: "gone-kid", role: "AXImage" }] },
					{ ref: "nested", role: "AXGroup", children: [{ ref: "deep", role: "AXStaticText", title: "Deep" }] },
				],
			},
			{ ref: "sibling", role: "AXButton", title: "Sibling" },
		],
	});

const scopedLook = () =>
	outlineOf({
		ref: "pane",
		role: "AXList",
		subrole: "AXContentList",
		identifier: "list-id",
		title: "New pane",
		description: "d",
		value: "v",
		actions: ["AXScrollToVisible"],
		canPress: true,
		canFocus: true,
		canSetValue: true,
		canScroll: true,
		canIncrement: true,
		canDecrement: true,
		isTextInput: true,
		focused: true,
		offscreen: true,
		pictureOnly: true,
		truncated: true,
		rect: { x: 0, y: 0, w: 50, h: 50 },
		scrollExtent: { seen: 2, total: 9 },
		text: [{ string: "scoped text", confidence: 0.5, rect: { x: 1, y: 1, w: 2, h: 2 } }],
		children: [
			{ ref: "keep", role: "AXButton", title: "New keep", rect: { x: 2, y: 2, w: 2, h: 2 }, children: [{ ref: "fresh-kid", role: "AXImage", rect: { x: 3, y: 3, w: 1, h: 1 } }] },
			{ ref: "fresh", role: "AXCell", title: "Fresh", text: [{ string: "cell ocr", confidence: 1, rect: { x: 4, y: 4, w: 1, h: 1 } }], scrollExtent: { seen: 1, total: 1 } },
			{ role: "AXRow", title: "No wire ref" },
		],
	});

describe("graftScopedOutline", () => {
	test("unknown target throws and leaves the outline alone", () => {
		const outline = graftBase();
		const before = refs(outline);
		assert.throws(() => graftScopedOutline(outline, "@e99", scopedLook()), /target @e99 is not in the current outline/);
		assert.deepEqual(refs(outline), before);
	});

	test("target adopts scoped fields but keeps ref, wire ref and its own rect", () => {
		const outline = graftBase();
		const target = outline.nodes[1];
		const originalRect = { ...target.rect };
		const scoped = scopedLook();
		scoped.root.wireRef = "pane-scoped";
		const returned = graftScopedOutline(outline, "@e2", scoped);
		assert.equal(returned, target);
		assert.equal(target.ref, "@e2");
		assert.equal(target.wireRef, "pane", "the live wire ref survives a scoped root that carries a different one");
		assert.equal(outline.wireRefToRef.get("pane"), "@e2");
		assert.equal(outline.wireRefToRef.has("pane-scoped"), false);
		assert.deepEqual(target.rect, originalRect);
		assert.deepEqual(
			{ role: target.role, subrole: target.subrole, identifier: target.identifier, title: target.title, description: target.description, value: target.value, actions: target.actions },
			{ role: "AXList", subrole: "AXContentList", identifier: "list-id", title: "New pane", description: "d", value: "v", actions: ["AXScrollToVisible"] },
		);
		for (const flag of ["canPress", "canFocus", "canSetValue", "canScroll", "canIncrement", "canDecrement", "isTextInput", "focused", "offscreen", "pictureOnly"]) assert.equal(target[flag], true, flag);
		assert.equal(target.truncated, false, "a regrafted node is no longer truncated");
		assert.deepEqual(target.scrollExtent, { seen: 2, total: 9 });
		assert.deepEqual(target.text, [{ string: "scoped text", confidence: 0.5, rect: { x: 1, y: 1, w: 2, h: 2 } }]);
	});

	test("target without a rect stays rectless; scoped text without rect stays rectless", () => {
		const outline = outlineOf({ ref: "win", children: [{ ref: "t", role: "AXGroup" }] });
		outline.nodes[1].rect = undefined;
		const scoped = outlineOf({ ref: "t", role: "AXGroup", children: [] });
		scoped.root.rect = { x: 9, y: 9, w: 9, h: 9 };
		scoped.root.text = [{ string: "x", confidence: 1 }];
		graftScopedOutline(outline, "@e2", scoped);
		assert.equal(outline.nodes[1].rect, undefined);
		assert.deepEqual(outline.nodes[1].text, [{ string: "x", confidence: 1, rect: undefined }]);
		assert.equal(outline.nodes[1].scrollExtent, undefined);
	});

	test("reuses matching wire refs, numbers new nodes after the max ref, preserves unreused", () => {
		const outline = graftBase();
		const before = Object.fromEntries(outline.nodes.map((node) => [node.wireRef, node]));
		graftScopedOutline(outline, "@e2", scopedLook());
		const pane = outline.nodes[1];
		const byWire = (wire) => outline.nodes.find((node) => node.wireRef === wire);

		// Reused: same object, same ref, new fields, grafted under pane.
		const keep = byWire("keep");
		assert.equal(keep, before.keep);
		assert.equal(keep.ref, "@e4");
		assert.equal(keep.title, "New keep");
		assert.equal(keep.parent, pane);
		// New nodes continue numbering after the old max (@e8), depth-first in graft order.
		const fresh = byWire("fresh");
		assert.notEqual(fresh, before.fresh);
		assert.equal(byWire("fresh-kid").ref, "@e9");
		assert.equal(fresh.ref, "@e10");
		const unwired = pane.children.find((node) => node.title === "No wire ref");
		assert.equal(unwired.ref, "@e11");
		assert.equal(unwired.wireRef, undefined);
		assert.equal(fresh.parent, pane);
		assert.equal(byWire("fresh-kid").parent, keep);
		// Grafted children come first, in scoped order; unreused old children follow, subtrees intact.
		assert.deepEqual(pane.children.map((node) => node.title || node.role), ["New keep", "Fresh", "No wire ref", "Stale child", "AXGroup"]);
		assert.equal(byWire("gone"), before.gone);
		assert.equal(byWire("gone").parent, pane);
		assert.equal(byWire("gone-kid").parent, byWire("gone"));
		assert.equal(byWire("deep").parent, byWire("nested"));
		// The unrelated sibling is untouched.
		assert.equal(byWire("sibling"), before.sibling);
		assert.equal(byWire("sibling").parent, outline.root);
	});

	test("preserved subtrees drop descendants that were reused elsewhere", () => {
		const outline = graftBase();
		// Scoped look pulls "deep" out of its old parent "nested" and places it directly under the target.
		const scoped = outlineOf({ ref: "pane", role: "AXList", children: [{ ref: "deep", role: "AXStaticText", title: "Moved deep" }] });
		graftScopedOutline(outline, "@e2", scoped);
		const pane = outline.nodes[1];
		const nested = outline.nodes.find((node) => node.wireRef === "nested");
		assert.deepEqual(pane.children.map((node) => node.wireRef), ["deep", "keep", "gone", "nested"]);
		assert.deepEqual(nested.children, [], "deep is no longer duplicated under its old parent");
		assert.equal(outline.nodes.filter((node) => node.wireRef === "deep").length, 1);
	});

	test("a reused node keeps its old children when the scoped copy has none", () => {
		const outline = graftBase();
		const scoped = outlineOf({ ref: "pane", role: "AXList", children: [{ ref: "nested", role: "AXGroup", title: "Nested again" }] });
		graftScopedOutline(outline, "@e2", scoped);
		const nested = outline.nodes.find((node) => node.wireRef === "nested");
		assert.equal(nested.title, "Nested again");
		assert.deepEqual(nested.children.map((node) => node.wireRef), ["deep"]);
		assert.equal(nested.children[0].parent, nested);
	});

	test("grafted descendants lose their rects; reused node rects are cleared too; text rects too", () => {
		const outline = graftBase();
		graftScopedOutline(outline, "@e2", scopedLook());
		const byWire = (wire) => outline.nodes.find((node) => node.wireRef === wire);
		for (const wire of ["keep", "fresh", "fresh-kid", "gone"]) assert.equal(byWire(wire).rect, undefined, `${wire} rect`);
		assert.equal(byWire("fresh").text[0].rect, undefined);
		assert.equal(outline.nodes[1].rect.w, 300, "the target keeps real geometry");
		assert.equal(outline.root.rect.w, 800);
	});

	test("indexes are rebuilt breadth-first with consistent wire maps", () => {
		const outline = graftBase();
		graftScopedOutline(outline, "@e2", scopedLook());
		assert.deepEqual(outline.nodes.map((node) => node.wireRef ?? node.title), ["win", "pane", "sibling", "keep", "fresh", "No wire ref", "gone", "nested", "fresh-kid", "gone-kid", "deep"]);
		assert.equal(new Set(refs(outline)).size, outline.nodes.length, "refs are unique");
		for (const [ref, wire] of outline.refToWireRef) {
			assert.equal(outline.wireRefToRef.get(wire), ref);
			assert.equal(outline.nodes.find((node) => node.ref === ref).wireRef, wire);
		}
		assert.equal(outline.refToWireRef.size, outline.nodes.filter((node) => node.wireRef).length);
	});

	test("numbering ignores malformed refs and starts at 1 for an empty ref set", () => {
		const outline = outlineOf({ ref: "win", children: [{ ref: "t" }] });
		outline.nodes[0].ref = "weird";
		outline.nodes[1].ref = "@e07x";
		const scoped = outlineOf({ ref: "t", children: [{ ref: "n1" }, { ref: "n2" }] });
		graftScopedOutline(outline, "@e07x", scoped);
		assert.deepEqual(outline.nodes.slice(2).map((node) => node.ref), ["@e1", "@e2"], "refs that are not @e<digits> count as 0");
		assert.equal(outline.nodes[1].ref, "@e07x");
	});

	test("target found by wire ref keeps the ref it was addressed by", () => {
		const outline = graftBase();
		graftScopedOutline(outline, "pane", scopedLook());
		assert.equal(outline.nodes[1].ref, "pane", "targetRef is written back verbatim");
	});
});

describe("foldToBudget", () => {
	const folded = () =>
		outlineOf({
			ref: "w",
			role: "AXWindow",
			children: [
				{
					ref: "g",
					role: "AXGroup",
					scrollExtent: { seen: 1, total: 4 },
					children: [
						{ role: "AXButton" }, { role: "AXButton" }, { role: "AXButton" },
						{ role: "AXStaticText" }, { role: "AXStaticText" },
						{ role: "AXImage", pictureOnly: true }, { role: "AXImage", pictureOnly: true },
						{ role: "AXLink" }, { role: "AXCell" }, { role: "AX" },
					],
				},
				{ ref: "single", role: "AXGroup", children: [{ role: "AXRow", pictureOnly: true }] },
				{ ref: "leaf", role: "AXButton", title: "Leaf", actions: ["AXPress", "AXShowMenu"], offscreen: true, pictureOnly: true, truncated: false },
			],
		});

	test("folds deep groups into role-count summaries, ranked by count then name, top four only", () => {
		const result = foldToBudget(folded(), { maxDepth: 1 });
		const lines = result.text.split("\n");
		assert.equal(lines[0], "@e1 AXWindow");
		assert.match(lines[1], /^ {2}@e2 AXGroup \[scrollable 1\/4\] ▸ \(10: 3 buttons, 2 picture-only, 2 statictexts, 1 cell\) \[scrollable 1\/4\]$/);
		assert.equal(lines[2], "  @e3 AXGroup ▸ (1: 1 picture-only)");
		assert.equal(lines[3], "  @e4 AXButton \"Leaf\" {AXPress,AXShowMenu} [offscreen, pictureOnly]");
		assert.deepEqual(result.renderedRefs, ["@e1", "@e2", "@e3", "@e4"]);
		assert.equal(result.truncated, false);
		assert.equal(result.nodeCount, 15);
		assert.equal(result.fullUnfoldLineCount, 15);
	});

	test("unnamed roles fall back to 'node' and singulars are not pluralised", () => {
		const outline = outlineOf({ role: "AXWindow", children: [{ role: "AXGroup", children: [{ role: "AX" }, { role: "" }] }] });
		assert.match(foldToBudget(outline, { maxDepth: 1 }).text, /\(2: 2 nodes\)$/);
		const lone = outlineOf({ role: "AXWindow", children: [{ role: "AXGroup", children: [{ role: "AX" }] }] });
		assert.match(foldToBudget(lone, { maxDepth: 1 }).text, /\(1: 1 node\)$/);
		const one = outlineOf({ role: "AXWindow", children: [{ role: "AXGroup", children: [{ role: "AXButton" }] }] });
		assert.match(foldToBudget(one, { maxDepth: 1 }).text, /\(1: 1 button\)$/);
	});

	test("explicit unfold expands the path and the children of the ref, ignoring unknown refs", () => {
		const outline = folded();
		const result = foldToBudget(outline, { maxDepth: 1 }, ["@e2", "nope"]);
		assert.equal(result.renderedRefs.length, 14, "group children are now rendered; nothing else changes");
		assert.ok(result.text.includes("@e5 AXButton"));
		const byWire = foldToBudget(outline, { maxDepth: 1 }, ["g"]);
		assert.equal(byWire.text, result.text, "wire refs resolve too");
	});

	test("default anchors unfold: truncated, focused (and its children), sheets and dialogs", () => {
		const outline = outlineOf({
			role: "AXWindow",
			children: [
				{ role: "AXGroup", title: "plain", children: [{ role: "AXButton", title: "hidden" }] },
				{ role: "AXGroup", title: "trunc", truncated: true, children: [{ role: "AXButton", title: "t-kid" }] },
				{ role: "AXGroup", title: "foc", focused: true, children: [{ role: "AXGroup", title: "f-kid", children: [{ role: "AXButton", title: "f-grandkid" }] }] },
				{ role: "AXSheet", title: "sheet", children: [{ role: "AXButton", title: "s-kid" }] },
				{ role: "AXDialog", title: "dlg", children: [{ role: "AXButton", title: "d-kid" }] },
			],
		});
		const text = foldToBudget(outline, { maxDepth: 1 }).text;
		assert.ok(!text.includes("hidden"));
		for (const shown of ["t-kid", "f-kid", "s-kid", "d-kid"]) assert.ok(text.includes(shown), shown);
		assert.ok(text.includes("f-grandkid"), "children of a focused node are unfolded, so their own children render");
		assert.match(text, /AXGroup "plain" ▸ \(1: 1 button\)/);
	});

	test("render budget truncates with a pointer to search_ui and expand_ui", () => {
		const outline = outlineOf({ role: "AXWindow", children: [{ role: "AXButton" }, { role: "AXButton" }, { role: "AXButton" }] });
		const result = foldToBudget(outline, { maxDepth: 5, maxNodes: 2 });
		assert.equal(result.truncated, true);
		assert.deepEqual(result.renderedRefs, ["@e1", "@e2"]);
		assert.match(result.text.split("\n").at(-1), /render budget reached: 2 more nodes not shown; use search_ui or expand_ui\(@eN\)/);
		assert.equal(foldToBudget(outline, { maxDepth: -3, maxNodes: 0 }).renderedRefs.length, 1, "budgets clamp to at least one node");
	});
});

describe("interactive controls", () => {
	const out = () =>
		outlineOf({
			role: "AXWindow",
			children: [
				{ role: "AXButton", title: "Save", canPress: true },
				{ role: "AXButton", canPress: true },
				{ role: "AXTextField", isTextInput: true, canSetValue: true, value: "x".repeat(60) },
				{ role: "AXGroup", title: "Panel", canPress: true, children: [{ role: "AXButton", title: "Panel", canPress: true }, { role: "AXButton", title: "Inner", actions: ["AXPress"], offscreen: true }] },
				{ role: "AXStaticText", title: "Not a control", actions: ["AXShowMenu"] },
				{ role: "AXSlider", title: "Vol", value: "Vol", canIncrement: true, canDecrement: true, focused: true },
				{ role: "AXImage", title: "Icon", pictureOnly: true, canPress: true },
				{ role: "AXDialog", title: "Confirm", children: [{ role: "AXButton", title: "OK", canPress: true }] },
			],
		});

	test("lists controls with focus first, de-duplicates same-label children, counts unlabeled", () => {
		const result = renderInteractiveControls(out());
		assert.deepEqual(result.text.split("\n"), [
			'@e7 slider "Vol" [focused]',
			'@e12 button "OK"',
			'@e2 button "Save"',
			`@e4 textfield "${"x".repeat(60)}"`, // value is the label, so it is not repeated
			'@e5 group "Panel"',
			'@e11 button "Inner" [offscreen]',
		]);
		assert.equal(result.omittedUnlabeled, 1);
		assert.equal(result.controlCount, 6);
		assert.equal(result.nodeCount, 12);
		assert.equal(result.truncated, false);
		assert.equal(result.renderedRefs.includes("@e8"), false, "a child with the same label as its listed parent is skipped");
	});

	test("maxControls truncates and reports the remainder", () => {
		const result = renderInteractiveControls(out(), 2);
		assert.equal(result.renderedRefs.length, 2);
		assert.equal(result.truncated, true);
		assert.match(result.text.split("\n").at(-1), /render budget reached: 4 more controls not shown/);
	});

	test("controlLine truncates long values, omits values equal to the label, lists both states", () => {
		const [node] = outlineOf({ role: "AXTextField", title: "Name", value: "y".repeat(41), focused: true, offscreen: true }).nodes;
		assert.equal(controlLine(node), `@e1 textfield "Name" = "${"y".repeat(40)}…" [focused, offscreen]`);
		node.value = "Name";
		assert.equal(controlLine(node), '@e1 textfield "Name" [focused, offscreen]');
		node.value = "short";
		node.focused = node.offscreen = false;
		assert.equal(controlLine(node), '@e1 textfield "Name" = "short"');
	});

	test("isInteractiveControl: picture-only never, incidental actions alone never", () => {
		const n = (fields) => outlineOf({ role: "AXGroup", ...fields }).root;
		assert.equal(isInteractiveControl(n({ canPress: true, pictureOnly: true })), false);
		assert.equal(isInteractiveControl(n({ actions: ["AXShowMenu", "AXScrollToVisible"] })), false);
		assert.equal(isInteractiveControl(n({ actions: ["AXShowMenu", "AXOpen"] })), true);
		for (const flag of ["canPress", "canSetValue", "isTextInput", "canIncrement", "canDecrement"]) assert.equal(isInteractiveControl(n({ [flag]: true })), true, flag);
		assert.equal(isInteractiveControl(n({})), false);
	});

	test("labels fall back through title, description, value, identifier and OCR text", () => {
		const label = (fields) => outlineNodeLabel(outlineOf({ role: "AXGroup", ...fields }).root);
		assert.equal(label({ title: "t", description: "d" }), "t");
		assert.equal(label({ description: "d", value: "v" }), "d");
		assert.equal(label({ value: "v", identifier: "i" }), "v");
		assert.equal(label({ identifier: "i" }), "i");
		assert.equal(label({ text: [{ string: "a", confidence: 1 }, { string: "b", confidence: 1 }] }), "a b");
		assert.equal(label({}), "");
		assert.equal(outlineNodePath(outlineOf({ children: [{ role: "AXButton", subrole: "AXClose" }] }).nodes[1]), 'AXUnknown ▸ AXButton/AXClose');
	});
});

describe("ranked search", () => {
	test("rankedTextMatch ladders exact > prefix > substring > fuzzy and ignores empty queries", () => {
		assert.equal(rankedTextMatch(["Save"], "   "), undefined);
		assert.deepEqual(rankedTextMatch(["", "Save  File"], "save file"), { reason: "exact", score: 1 });
		assert.deepEqual(rankedTextMatch(["Save file"], "sav"), { reason: "prefix", score: 0.95 });
		assert.deepEqual(rankedTextMatch(["Quick save"], "sav"), { reason: "prefix", score: 0.95 }, "token prefix counts");
		assert.deepEqual(rankedTextMatch(["unsaved"], "save"), { reason: "substring", score: 0.9 });
		assert.equal(rankedTextMatch(["Save"], "savr")?.reason, "fuzzy");
		assert.equal(rankedTextMatch(["Save"], "svae")?.reason, "fuzzy", "transposition is one edit");
		assert.equal(rankedTextMatch(["Save"], "zzzz"), undefined);
		assert.equal(rankedTextMatch([], "x"), undefined);
		assert.equal(rankedTextMatch(["-abcde"], "abcdf")?.reason, "fuzzy", "a leading separator yields an empty token that is skipped");
		assert.equal(rankedTextMatch(["w".repeat(300)], "zzzz"), undefined, "over-long candidates are not fuzzed");
	});

	const ranked = () =>
		outlineOf({
			role: "AXWindow",
			children: [
				{ role: "AXButton", title: "Savr one", actions: ["AXPress"], canPress: true },
				{ role: "AXButton", title: "Save" },
				{ role: "AXTextField", title: "Savd two" },
				{ role: "AXButton", title: "Saved" },
				{ role: "AXButton", title: "Save" },
				{ role: "AXButton", title: "Unsaved" },
			],
		});

	test("orders exact, prefix, substring, then fuzzy; ties keep document order", () => {
		const { matches, totalMatches } = searchOutlineRanked(ranked(), "save");
		assert.deepEqual(matches.map((m) => [m.ref, m.matchReason]), [["@e3", "exact"], ["@e6", "exact"], ["@e5", "prefix"], ["@e7", "substring"], ["@e2", "fuzzy"], ["@e4", "fuzzy"]]);
		assert.equal(totalMatches, 6);
		assert.ok(matches.every((m) => !("order" in m) && m.node));
	});

	test("fuzzy results are dropped once strong matches fill the limit", () => {
		const { matches, totalMatches } = searchOutlineRanked(ranked(), "save", undefined, undefined, 2);
		assert.deepEqual(matches.map((m) => m.ref), ["@e3", "@e6"]);
		assert.equal(totalMatches, 4, "total counts strong matches only");
	});

	test("OCR text is searched", () => {
		const outline = outlineOf({ role: "AXWindow", children: [{ role: "AXImage", text: [{ string: "Invoice total", confidence: 1 }] }] });
		assert.deepEqual(searchOutlineRanked(outline, "invoice").matches.map((m) => [m.ref, m.matchReason]), [["@e2", "prefix"]]);
	});

	test("role and capability filters work without text and rank as 'filter'", () => {
		const outline = ranked();
		const buttons = searchOutlineRanked(outline, undefined, "ax button");
		assert.equal(buttons.matches.length, 5);
		assert.ok(buttons.matches.every((m) => m.matchReason === "filter" && m.score === 1));
		assert.deepEqual(searchOutlineRanked(outline, undefined, "textfield").matches.map((m) => m.ref), ["@e4"]);
		assert.deepEqual(searchOutlineRanked(outline, undefined, undefined, " press ").matches.map((m) => m.ref), ["@e2"]);
		assert.deepEqual(searchOutlineRanked(outline, "save", "textfield").matches.map((m) => m.ref), ["@e4"], "fuzzy text plus role");
		assert.deepEqual(searchOutlineRanked(outline, "save", undefined, "scroll").matches, []);
	});
});

describe("action matching via searchOutline", () => {
	const caps = outlineOf({
		role: "AXWindow",
		children: [
			{ role: "A", canFocus: true },
			{ role: "B", canSetValue: true },
			{ role: "C", canScroll: true },
			{ role: "D", canIncrement: true },
			{ role: "E", canDecrement: true },
			{ role: "F", actions: ["AXCancel"] },
			{ role: "G" },
		],
	});
	const roles = (action) => searchOutline(caps, undefined, undefined, action).map((m) => m.role).join("");
	test("capability keywords map to flags, anything else is a case-insensitive action substring", () => {
		assert.equal(roles("focus"), "A");
		for (const alias of ["setvalue", "SET_TEXT", "settext"]) assert.equal(roles(alias), "B", alias);
		assert.equal(roles("scroll"), "C");
		assert.equal(roles("increment"), "D");
		assert.equal(roles("decrement"), "E");
		assert.equal(roles("cancel"), "F");
		assert.equal(roles("press"), "");
	});
});

describe("graft without a wire-ref target", () => {
	test("a target without a wire ref still grafts and reuses matching children", () => {
		const outline = outlineOf({ role: "AXWindow", children: [{ role: "AXGroup", children: [{ ref: "kid", role: "AXButton", title: "old" }] }] });
		const scoped = outlineOf({ role: "AXGroup", children: [{ ref: "kid", role: "AXButton", title: "new" }] });
		graftScopedOutline(outline, "@e2", scoped);
		assert.equal(outline.nodes[1].children[0].title, "new");
		assert.equal(outline.nodes[1].children[0].ref, "@e3", "the old child object was reused");
	});
});
