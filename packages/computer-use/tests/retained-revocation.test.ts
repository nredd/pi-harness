// A live look that sees a protected element revokes older retained states of its root and their `@o` pages (#1279).
import assert from "node:assert/strict";
import { describe, onTestFinished, test, vi } from "vitest";
import { applyOutputEnvelope, clearStoredOutputs, readStoredOutput } from "../src/output.ts";
import { mayShareRoot, type OperationState, SavedStates, type StateProvenance } from "../src/state.ts";
import { desktopRoot, installFakeDesktop, lookPayload, wireButton, wireNode } from "../test/support/fake-desktop.mjs";

vi.mock("../src/cdp.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/cdp.ts")>()),
	cdpTabForWindow: vi.fn(async () => undefined),
	listCdpPageContexts: vi.fn(async () => []),
}));

const SECRET = "private fixture label";
const REVOKED = /State '[^']+' was revoked: a later look of the same root saw a protected node/;

// biome-ignore lint/suspicious/noExplicitAny: tool results are untyped JS objects in these fixtures.
type Result = any;

const secureField = (ref = "s") => wireNode(ref, "AXSecureTextField", "", { label: "" });

/** A target of `pid` with an optional window id and native ref. */
const target = (pid: number, windowId = 0, nativeWindowRef?: string): StateProvenance["target"] => ({
	pid,
	windowId,
	nativeWindowRef,
});

/** Provenance of a state of `on`, looked at `lookSeq`. */
const from = (stateId: string, on: StateProvenance["target"], lookSeq: number, protectionRevision = 0) => ({
	stateId,
	target: on,
	lookSeq,
	protectionRevision,
});

describe("mayShareRoot", () => {
	test.each([
		["another pid", target(1, 10), target(2, 10), false, false],
		["the same window id", target(1, 10, "a"), target(1, 10, "b"), false, true],
		["another window id", target(1, 10, "a"), target(1, 11, "a"), false, false],
		["no window id, the same native ref", target(1, 0, "a"), target(1, 11, "a"), false, true],
		["no window id, another native ref", target(1, 0, "a"), target(1, 11, "b"), false, false],
		["nothing comparable: fails closed", target(1, 10), target(1, 0, "a"), false, true],
		["Windows: the native ref alone decides", target(1, 10, "a"), target(1, 11, "a"), true, true],
		["Windows: another native ref", target(1, 10, "a"), target(1, 10, "b"), true, false],
		["Windows: no native ref fails closed", target(1, 10), target(1, 11, "b"), true, true],
	])("%s", (_name, a, b, nativeRefOnly, expected) => {
		assert.equal(mayShareRoot(a, b, nativeRefOnly), expected);
		assert.equal(mayShareRoot(b, a, nativeRefOnly), expected);
	});
});

describe("SavedStates revocation", () => {
	test("revokes older states of the root, never the kept state, newer looks or other roots", () => {
		const states = new SavedStates();
		const window = target(1, 10);
		states.revokeOlder(window, 5, "kept");
		assert.ok(states.isRevoked(from("older", window, 4)));
		assert.ok(states.isRevoked(from("restored", target(1, 0), 0)), "a restored state has no look order");
		assert.ok(!states.isRevoked(from("kept", window, 2)));
		assert.ok(!states.isRevoked(from("same look", window, 5)));
		assert.ok(!states.isRevoked(from("newer", window, 6)));
		assert.ok(!states.isRevoked(from("other window", target(1, 11), 1)));
		assert.ok(!states.isRevoked(from("other pid", target(2, 10), 1)));
	});

	test("a later revocation of the same root replaces the earlier one and revokes what it kept", () => {
		const states = new SavedStates();
		states.revokeOlder(target(1, 10), 3, "first");
		states.revokeOlder(target(1, 10), 7, "second");
		assert.ok(states.isRevoked(from("first", target(1, 10), 3)));
		assert.ok(!states.isRevoked(from("second", target(1, 10), 7)));
	});

	test("a protection bump revokes provenance read at an earlier revision", () => {
		const states = new SavedStates();
		assert.equal(states.protectionRevision("S"), 0);
		assert.equal(states.bumpProtection("S"), 1);
		assert.ok(states.isRevoked(from("S", target(1), 9, 0)));
		assert.ok(!states.isRevoked(from("S", target(1), 9, 1)));
		states.clear();
		assert.equal(states.protectionRevision("S"), 0);
	});

	test("clear drops every revocation", () => {
		const states = new SavedStates();
		states.revokeOlder(target(1, 10), 5, "kept");
		states.clear();
		assert.ok(!states.isRevoked(from("older", target(1, 10), 1)));
	});

	test("the injected platform policy decides root identity", () => {
		const states = new SavedStates(() => true);
		states.revokeOlder(target(1, 10, "hwnd"), 5, "kept");
		assert.ok(states.isRevoked(from("moved", target(1, 11, "hwnd"), 1)), "Windows ignores the window id");
	});

	test("provenance defaults a missing look order and revision; target-less states have none", () => {
		const states = new SavedStates();
		assert.equal(states.provenance({}), undefined);
		const state: OperationState = {
			currentTarget: { appName: "A", pid: 3, windowTitle: "W", windowId: 30, nativeWindowRef: "n" },
			currentCapture: { stateId: "S", width: 1, height: 1, scaleFactor: 1, timestamp: 0 },
		};
		assert.deepEqual(states.provenance(state), from("S", target(3, 30, "n"), 0, 0));
		assert.deepEqual(
			states.provenance({ ...state, lookSeq: 4, protectionRevision: 2 }),
			from("S", target(3, 30, "n"), 4, 2),
		);
	});

	test("nextLook orders looks", () => {
		const states = new SavedStates();
		const first = states.nextLook();
		assert.ok(first < states.nextLook());
	});

	test("a root with no window identity revokes every window of its pid", () => {
		const states = new SavedStates();
		states.revokeOlder(target(1, -1), 5, "kept");
		assert.ok(states.isRevoked(from("window", target(1, 10, "a"), 1)));
		assert.ok(!states.isRevoked(from("other pid", target(2, 10), 1)));
	});
});

describe("revoked output pages", () => {
	test("a page whose guard holds is deleted and reads as unavailable", () => {
		onTestFinished(clearStoredOutputs);
		let revoked = false;
		const big = "x".repeat(60 * 1024);
		const result = applyOutputEnvelope(
			"observe_ui",
			{ content: [{ type: "text", text: big }], details: {} },
			() => revoked,
		);
		const ref = /read_text\(\{ ref: "(@o\d+)"/.exec((result.content[0] as { text: string }).text)?.[1];
		assert.ok(ref, "the oversized result was stored");
		assert.equal(readStoredOutput(ref, 0)?.offset, 0);
		revoked = true;
		assert.equal(readStoredOutput(ref, 0), undefined);
		revoked = false;
		assert.equal(readStoredOutput(ref, 0), undefined, "a revoked page is gone, not hidden");
	});
});

/** A fake desktop with `tree` as the frontmost window's children. */
async function desktop(tree: object[]) {
	const fake = await installFakeDesktop(onTestFinished, { platform: "macos" });
	fake.tree = tree;
	return fake;
}

/** Rejects with the revocation error, which names no retained text. */
async function assertRevoked(promise: Promise<unknown>): Promise<void> {
	await assert.rejects(promise, (error: Error) => {
		assert.match(error.message, REVOKED);
		assert.ok(!error.message.includes(SECRET), "the error echoes retained text");
		return true;
	});
}

/** Enough long labels that `expand_ui` of the window overflows into an `@o` page. */
const manyLabels = (prefix: string) =>
	Array.from({ length: 140 }, (_, index) => wireButton(`n${index}`, `${prefix} ${index} ${"y".repeat(400)}`));

/** The `@o` ref an oversized result names. */
function outputRef(fake: Result, result: Result): string {
	const ref = /read_text\(\{ ref: "(@o\d+)"/.exec(fake.text(result))?.[1];
	assert.ok(ref, "expected an oversized result");
	return ref;
}

describe("a later live look of the same root", () => {
	test("that sees a protected element revokes the older state and its output pages", async () => {
		const fake = await desktop([wireNode("c", "AXStaticText", SECRET), ...manyLabels(SECRET)]);
		const first = await fake.observe();
		const page = outputRef(fake, await fake.call(fake.bridge.executeExpandUi, { stateId: first.stateId, ref: "@e1" }));
		const read = await fake.call(fake.bridge.executeReadText, { ref: page });
		assert.match(fake.text(read), new RegExp(SECRET));

		fake.tree = [secureField(), wireButton("b", "Keep")];
		const second = await fake.observe();
		for (const [execute, params] of [
			[fake.bridge.executeInspectUi, { ref: "@e2" }],
			[fake.bridge.executeExpandUi, { ref: "@e1" }],
			[fake.bridge.executeSearchUi, { text: SECRET }],
			[fake.bridge.executeAct, { actions: [{ action: "press", ref: "@e3" }] }],
		] as const)
			await assertRevoked(fake.call(execute, { stateId: first.stateId, ...params }));
		await assert.rejects(
			fake.call(fake.bridge.executeReadText, { ref: page }),
			/Output ref '@o\d+' is unavailable, was evicted, or was revoked by a later protected look/,
		);
		const current = await fake.call(fake.bridge.executeInspectUi, { stateId: second.stateId, ref: "@e2" });
		assert.match(fake.text(current), /AXSecureTextField/);
	});

	test("with no protected element keeps the older state readable", async () => {
		const fake = await desktop([wireNode("c", "AXStaticText", SECRET)]);
		const first = await fake.observe();
		// A picture-only node's `[protected]` OCR title is not a protected element.
		fake.lookPayload = () =>
			lookPayload({
				children: [
					wireNode("c", "AXStaticText", "other", { truncated: true }),
					wireNode("pic_1", "AXImage", "ocr", { pictureOnly: true, label: "ocr" }),
				],
			});
		await fake.observe();
		const inspected = await fake.call(fake.bridge.executeInspectUi, { stateId: first.stateId, ref: "@e2" });
		assert.match(fake.text(inspected), new RegExp(SECRET));
	});

	test("of another app leaves its states alone", async () => {
		const fake = await desktop([wireNode("c", "AXStaticText", SECRET)]);
		fake.roots = [desktopRoot({ pid: 1 }), desktopRoot({ pid: 2 })];
		const first = await fake.observe();
		fake.frontmostPid = 2;
		fake.tree = [secureField()];
		await fake.observe();
		const inspected = await fake.call(fake.bridge.executeInspectUi, { stateId: first.stateId, ref: "@e2" });
		assert.match(fake.text(inspected), new RegExp(SECRET));
	});
});

describe("a scoped look that sees a protected element", () => {
	/** Window children: a truncated group `g` holding `kid`, then enough labels to overflow. */
	const grouped = (kid: object, truncated: boolean) => [
		wireNode("g", "AXGroup", "Group", { truncated, children: [kid] }),
		...manyLabels("filler"),
	];

	test("revokes the state's earlier pages and older states, and keeps the grafted state", async () => {
		const fake = await desktop([wireNode("c", "AXStaticText", SECRET)]);
		const older = await fake.observe();
		let kid = wireNode("kid", "AXStaticText", SECRET);
		fake.lookPayload = (request: { scopeRef?: string }) =>
			request.scopeRef === "g"
				? {
						...lookPayload({ lookId: "scoped", image: false }),
						outline: wireNode("g", "AXGroup", "Group", { children: [kid] }),
					}
				: lookPayload({ children: grouped(kid, true) });
		const grafted = await fake.observe();
		const page = outputRef(
			fake,
			await fake.call(fake.bridge.executeExpandUi, { stateId: grafted.stateId, ref: "@e1", depth: 3 }),
		);
		kid = secureField("kid");
		const expanded = await fake.call(fake.bridge.executeExpandUi, { stateId: grafted.stateId, ref: "@e2" });
		assert.equal(fake.looks.at(-1).scopeRef, "g", "the truncated group took a scoped look");
		assert.ok(!fake.text(expanded).includes(SECRET));
		await assert.rejects(fake.call(fake.bridge.executeReadText, { ref: page }), /revoked by a later protected look/);
		await assertRevoked(fake.call(fake.bridge.executeInspectUi, { stateId: older.stateId, ref: "@e2" }));
		const after = await fake.call(fake.bridge.executeInspectUi, { stateId: grafted.stateId, ref: "@e2" });
		assert.match(fake.text(after), /AXGroup/);
	});

	/** Gate the next root listing, so a protected observe can run while `expand_ui` resolves its root. */
	async function racedExpand(scopedKid: () => object) {
		const fake = await desktop([]);
		let protectedTree = false;
		fake.lookPayload = (request: { scopeRef?: string }) =>
			request.scopeRef === "g"
				? {
						...lookPayload({ lookId: "scoped", image: false }),
						outline: wireNode("g", "AXGroup", "Group", { children: [scopedKid()] }),
					}
				: lookPayload({
						children: protectedTree
							? [secureField()]
							: [wireNode("g", "AXGroup", SECRET, { truncated: true, children: [] })],
					});
		const { stateId } = await fake.observe();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let gated = false;
		const listRoots = fake.listRootsHook;
		fake.listRootsHook = (query: unknown) => {
			if (gated) return listRoots?.(query);
			gated = true;
			return gate.then(() => fake.roots);
		};
		const expanding = fake.call(fake.bridge.executeExpandUi, { stateId, ref: "@e2" });
		await vi.waitFor(() => assert.ok(gated, "expand_ui is resolving its root"));
		protectedTree = true;
		await fake.observe();
		release();
		return expanding;
	}

	test("refuses to keep a state a concurrent look revoked", async () => {
		await assertRevoked(racedExpand(() => secureField("kid")));
	});

	test("without protection still withholds a result whose state was revoked meanwhile", async () => {
		await assert.rejects(
			racedExpand(() => wireNode("kid", "AXStaticText", "plain")),
			/was revoked: .* This call's result was withheld; any actions it ran may have taken effect\./,
		);
	});
});
