// `src/actions.ts` parameter normalisation and target selection as tables of valid and invalid input (nredd/pi-harness#703, Refs #645).
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { outcomeAfterObservedValues, prepareAction } from "../src/actions.ts";
import { outlineNode } from "./support/outline-nodes.mjs";

const node = outlineNode;

const NODES = new Map(
	[
		node("@e1", { wireRef: "w1", canPress: true }),
		node("@e2", { wireRef: "w2", isTextInput: true, role: "AXTextField" }),
		node("@e3", { wireRef: "w3", pictureOnly: true }),
		node("@e4", { wireRef: "w4", actions: ["AXShowMenu", "AXScrollToVisible"] }),
		node("@e5", { wireRef: "w5", actions: ["AXShowMenu", "AXPick"] }),
		node("@e6"),
		node("@e7", { wireRef: "w7", canSetValue: true, actions: ["AXShowMenu", "AXPress"] }),
		node("@e8", { wireRef: "w8", children: [node("@e9", { role: "AXImage" })], canPress: true }),
		node("@e10", { wireRef: "w10", children: [node("@e11", { canSetValue: true })], canPress: true }),
		node("@e12", { wireRef: "w12", canPress: true, children: [node("@e13", { children: [node("@e14")] })] }),
	].map((n) => [n.ref, n]),
);

const makeEnv = (over = {}) => {
	const validated = [];
	return {
		headless: false,
		image: { width: 801, height: 600 },
		node: (ref) => {
			const found = NODES.get(ref);
			if (!found) throw new Error(`Unknown ref ${ref}`);
			return found;
		},
		center: (n) => ({ x: n.ref.length * 10, y: 5 }),
		validatePoint: (x, y, label) => {
			if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`${label ?? "Point"} is not finite`);
			validated.push([x, y, label]);
		},
		validated,
		...over,
	};
};
const state = (currentFocus = false) => ({ currentFocus });
const prepare = (action, { focus = false, ...envOver } = {}) => prepareAction(action, state(focus), makeEnv(envOver));

describe("click and press", () => {
	test("button and clickCount are normalised", () => {
		const cases = [
			[{ action: "click", ref: "@e1", button: "right", clickCount: 2 }, "right", 2],
			[{ action: "click", ref: "@e1", button: "middle", clickCount: 3.4 }, "middle", 3],
			[{ action: "press", ref: "@e1", button: "bogus", clickCount: 99 }, "left", 3],
			[{ action: "click", ref: "@e1", clickCount: 0 }, "left", 1],
			[{ action: "click", ref: "@e1", clickCount: "2" }, "left", 2],
			[{ action: "click", ref: "@e1", clickCount: "many" }, "left", 1],
		];
		for (const [action, button, count] of cases) {
			const prepared = prepare(action);
			assert.deepEqual(prepared.params, { button, clickCount: count }, JSON.stringify(action));
			assert.deepEqual(prepared.target, { ref: "w1" });
			assert.equal(prepared.needsForeground, false);
		}
	});

	test("target selection by node capability", () => {
		// Semantic ref when the node can be pressed, or advertises a real action.
		assert.deepEqual(prepare({ action: "click", ref: "@e1" }).target, { ref: "w1" });
		assert.deepEqual(prepare({ action: "click", ref: "@e5" }).target, { ref: "w5" }, "a non-incidental action keeps the wire ref");
		assert.deepEqual(prepare({ action: "press", ref: "@e7" }).target, { ref: "w7" });
		// Text inputs, picture-only nodes and nodes without a wire ref are clicked by coordinates, in the foreground.
		for (const ref of ["@e2", "@e3", "@e4", "@e6"]) {
			const prepared = prepare({ action: "click", ref });
			assert.deepEqual(prepared.target, { x: ref.length * 10, y: 5 }, ref);
			assert.equal(prepared.needsForeground, true, ref);
		}
		// Not a click: the wire ref wins even for an inert node, a missing one falls back to coordinates.
		assert.deepEqual(prepare({ action: "scroll", ref: "@e4" }).target, { ref: "w4" });
		assert.deepEqual(prepare({ action: "scroll", ref: "@e6" }).target, { x: 30, y: 5 });
		assert.deepEqual(prepare({ action: "scroll", ref: "@e3" }).target, { x: 30, y: 5 });
		assert.deepEqual(prepare({ action: "scroll", ref: " @e1 " }).target, { ref: "w1" }, "refs are trimmed");
	});

	test("headless never needs the foreground or establishes focus", () => {
		const prepared = prepare({ action: "click", x: 3, y: 4 }, { headless: true });
		assert.equal(prepared.needsForeground, false);
		assert.equal(prepare({ action: "click", ref: "@e10" }, { headless: true }).establishesFocus, false);
	});

	test("a click on or above an editable node establishes focus", () => {
		assert.equal(prepare({ action: "click", ref: "@e10" }).establishesFocus, true, "descendant canSetValue");
		assert.equal(prepare({ action: "click", ref: "@e7" }).establishesFocus, true, "canSetValue itself");
		assert.equal(prepare({ action: "click", ref: "@e2" }).establishesFocus, true, "text role");
		assert.equal(prepare({ action: "click", ref: "@e8" }).establishesFocus, false, "non-editable child");
		assert.equal(prepare({ action: "click", ref: "@e12" }).establishesFocus, false, "deep non-editable subtree");
		assert.equal(prepare({ action: "click", x: 1, y: 2 }).establishesFocus, false, "coordinate click has no ref");
		assert.equal(prepare({ action: "scroll", ref: "@e10" }).establishesFocus, false);
	});

	test("coordinates are validated and need finite numbers", () => {
		const env = makeEnv();
		const prepared = prepareAction({ action: "click", x: "7", y: 8 }, state(), env);
		assert.deepEqual(prepared.target, { x: 7, y: 8 });
		assert.deepEqual(env.validated, [[7, 8, undefined]]);
		assert.throws(() => prepare({ action: "click", x: 1 }), /click requires either ref or both x and y\./);
		assert.throws(() => prepare({ action: "moveMouse", x: "left", y: 1 }), /moveMouse requires either ref or both x and y\./);
		assert.throws(() => prepare({ action: "click", ref: "  " }), /click requires either ref or both x and y\./);
	});
});

describe("text and keyboard input", () => {
	test("setText and typeText default to empty text", () => {
		assert.deepEqual(prepare({ action: "setText", ref: "@e2" }).params, { text: "" });
		assert.deepEqual(prepare({ action: "setText", ref: "@e2", text: "hi" }).params, { text: "hi" });
		assert.deepEqual(prepare({ action: "typeText", ref: "@e2" }).params, { text: "" });
		assert.deepEqual(prepare({ action: "typeText", ref: "@e2", text: "yo" }).params, { text: "yo" });
	});

	test("paste text must be a non-empty string", () => {
		assert.deepEqual(prepare({ action: "paste", ref: "@e2", text: "clip" }).params, { text: "clip" });
		for (const text of [undefined, "", 5]) assert.throws(() => prepare({ action: "paste", ref: "@e2", text }), /paste\.text must be a non-empty string\./);
	});

	test("keypress keys are stringified and must be a non-empty array", () => {
		assert.deepEqual(prepare({ action: "keypress", ref: "@e2", keys: ["cmd+a", 1] }).params, { keys: ["cmd+a", "1"] });
		for (const keys of [undefined, [], "cmd+a"]) assert.throws(() => prepare({ action: "keypress", ref: "@e2", keys }), /keypress\.keys must contain at least one key\./);
	});

	test("a ref-less typeText follows the established focus only when not headless", () => {
		const followed = prepare({ action: "typeText", text: "x" }, { focus: true });
		assert.deepEqual(followed.target, { focus: { x: 400, y: 300 } });
		assert.equal(followed.usesCurrentFocus, true);
		for (const action of ["paste", "keypress"]) {
			const prepared = prepare({ action, text: "x", keys: ["a"] }, { focus: true });
			assert.equal(prepared.usesCurrentFocus, true, action);
			assert.deepEqual(prepared.target, { focus: { x: 400, y: 300 } }, action);
		}
		assert.throws(() => prepare({ action: "typeText", text: "x" }, { focus: true, image: undefined }), /Focused keyboard input requires an image-bearing state\./);
		assert.throws(() => prepare({ action: "typeText", text: "x" }, { focus: true, headless: true }), /requires either ref or both x and y\./, "headless ignores established focus");
		assert.throws(() => prepare({ action: "typeText", text: "x" }), /requires either ref or both x and y\./, "no focus established");
		assert.equal(prepare({ action: "typeText", ref: "@e2", text: "x" }, { focus: true }).usesCurrentFocus, false, "an explicit ref wins");
	});
});

describe("scroll, drag and moveMouse", () => {
	test("scroll deltas are rounded, clamped and default to zero", () => {
		const cases = [
			[{ scrollX: 3.6, scrollY: -2.2 }, { scrollX: 4, scrollY: -2 }],
			[{ scrollX: 1e9, scrollY: -1e9 }, { scrollX: 10_000, scrollY: -10_000 }],
			[{}, { scrollX: 0, scrollY: 0 }],
			[{ scrollX: "12", scrollY: "n/a" }, { scrollX: 12, scrollY: 0 }],
		];
		for (const [extra, params] of cases) assert.deepEqual(prepare({ action: "scroll", x: 1, y: 2, ...extra }).params, params, JSON.stringify(extra));
	});

	test("drag paths accept objects and tuples, each point validated", () => {
		const env = makeEnv();
		const prepared = prepareAction({ action: "drag", path: [{ x: 1, y: 2 }, [3, 4], { x: "5", y: "6" }] }, state(), env);
		assert.deepEqual(prepared.params.path, [{ x: 1, y: 2 }, { x: 3, y: 4 }, { x: 5, y: 6 }]);
		assert.deepEqual(prepared.target, { x: 1, y: 2 }, "a drag without x/y starts at its first point");
		const labels = ["Drag point 1", "Drag point 2", "Drag point 3"];
		assert.deepEqual(env.validated.map(([, , label]) => label), [...labels, ...labels], "validated while picking the start and again for the params");
		assert.equal(prepared.needsForeground, false);
	});

	test("invalid drag paths are refused", () => {
		for (const path of [undefined, [], [{ x: 1, y: 1 }], "ab"]) assert.throws(() => prepare({ action: "drag", path }), /drag\.path must contain at least two points\.|drag requires either ref or both x and y\./, JSON.stringify(path));
		assert.throws(() => prepare({ action: "drag", path: [{ x: 1, y: 1 }, null] }), /Drag point 2 is not finite/);
		assert.throws(() => prepare({ action: "drag", path: [[1], [2, 3]] }), /Drag point 1 is not finite/);
		assert.throws(() => prepare({ action: "drag", path: [{ x: 1, y: 1 }, { x: "x", y: 1 }] }), /Drag point 2 is not finite/);
	});

	test("an explicit drag start wins over the path", () => {
		const prepared = prepare({ action: "drag", x: 9, y: 9, path: [{ x: 1, y: 1 }, { x: 2, y: 2 }] });
		assert.deepEqual(prepared.target, { x: 9, y: 9 });
	});

	test("moveMouse carries no params", () => {
		const prepared = prepare({ action: "moveMouse", x: 5, y: 6 });
		assert.deepEqual(prepared, { action: "moveMouse", target: { x: 5, y: 6 }, params: {}, establishesFocus: false, usesCurrentFocus: false, needsForeground: false });
	});
});

describe("secondaryAction and selectText", () => {
	test("secondaryAction normalises the AX prefix and checks the advertised actions", () => {
		assert.deepEqual(prepare({ action: "secondaryAction", ref: "@e4", name: "ShowMenu" }).params, { name: "AXShowMenu" });
		assert.deepEqual(prepare({ action: "secondaryAction", ref: "@e4", name: " AXScrollToVisible " }).params, { name: "AXScrollToVisible" });
		assert.throws(() => prepare({ action: "secondaryAction", ref: "@e4", name: "Raise" }), /@e4 does not advertise AXRaise\. Advertised actions: AXShowMenu, AXScrollToVisible\./);
		assert.throws(() => prepare({ action: "secondaryAction", ref: "@e1", name: "Raise" }), /Advertised actions: none\./);
		assert.throws(() => prepare({ action: "secondaryAction", ref: "@e4", name: "  " }), /secondaryAction requires name/);
		assert.throws(() => prepare({ action: "secondaryAction", ref: "@e4" }), /secondaryAction requires name/);
	});

	test("semantic actions need a live, non-picture ref", () => {
		assert.throws(() => prepare({ action: "secondaryAction", name: "ShowMenu" }), /secondaryAction requires a ref\./);
		assert.throws(() => prepare({ action: "selectText", ref: "  " }), /selectText requires a ref\./);
		assert.throws(() => prepare({ action: "selectText", ref: "@e3", start: 0 }), /pictureOnly and has no semantic element, so selectText is unavailable\./);
		assert.throws(() => prepare({ action: "selectText", ref: "@e6", start: 0 }), /Outline ref '@e6' is pictureOnly/);
	});

	test("selectText validates the range on a text node", () => {
		assert.deepEqual(prepare({ action: "selectText", ref: "@e2", start: 3 }), { action: "selectText", target: { ref: "w2" }, params: { start: 3, length: 0 }, establishesFocus: false, usesCurrentFocus: false, needsForeground: false });
		assert.deepEqual(prepare({ action: "selectText", ref: "@e7", start: 1, length: 4 }).params, { start: 1, length: 4 }, "canSetValue counts as text");
		assert.throws(() => prepare({ action: "selectText", ref: "@e1", start: 0 }), /@e1 is not a text element, so selectText is unavailable\./);
		for (const start of [undefined, -1, 1.5]) assert.throws(() => prepare({ action: "selectText", ref: "@e2", start }), /selectText\.start must be a non-negative integer\./);
		for (const length of [-1, 0.5]) assert.throws(() => prepare({ action: "selectText", ref: "@e2", start: 0, length }), /selectText\.length must be a non-negative integer\./);
	});
});

describe("outcomeAfterObservedValues", () => {
	const set = (ref, text) => ({ action: "setText", ref, text });
	test("only a fully matching setText batch promotes the outcome", () => {
		const values = { "@e1": "a", "@e2": "" };
		const lookup = (ref) => values[ref];
		assert.equal(outcomeAfterObservedValues("unknown", [set("@e1", "a"), set("@e2")], lookup), "worked");
		assert.equal(outcomeAfterObservedValues("didnt", [set("@e1", "b")], lookup), "didnt");
		assert.equal(outcomeAfterObservedValues("unknown", [], lookup), "unknown");
		assert.equal(outcomeAfterObservedValues("unknown", [{ action: "typeText", ref: "@e1", text: "a" }], lookup), "unknown");
		assert.equal(outcomeAfterObservedValues("unknown", [{ action: "setText", text: "a" }], lookup), "unknown");
	});
});
