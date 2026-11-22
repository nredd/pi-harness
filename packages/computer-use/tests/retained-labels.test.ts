// Retained outline labels never outlive a node's readable classification (#1234): notes, grafts, searches, diffs.
import assert from "node:assert/strict";
import { describe, onTestFinished, test, vi } from "vitest";
import { noteForOutline, noteFromLook, renderNote, type WindowNote } from "../src/note.ts";
import {
	foldToBudget,
	graftScopedOutline,
	isProtectedNode,
	PROTECTED_LABEL,
	parseLookResponse,
	REDACTED_LABEL,
	restoreOutline,
	searchOutlineRanked,
	serializeOutline,
} from "../src/outline.ts";
import { loadStoredOutline, saveStoredOutline } from "../src/outline-store.ts";
import { changesBetween, renderChanges, stabilizeRefs } from "../src/view.ts";
import { desktopRoot, installFakeDesktop, lookPayload, wireButton, wireNode } from "../test/support/fake-desktop.mjs";
import { outlineNode, outlineOf } from "../test/support/outline-nodes.mjs";

vi.mock("../src/cdp.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/cdp.ts")>()),
	cdpTabForWindow: vi.fn(async () => undefined),
	listCdpPageContexts: vi.fn(async () => []),
}));

const SECRET = "private fixture label";
const SECRET_VALUE = "hunter2 fixture value";

/** How each host reports a node that is no longer readable; macOS-only helpers still sent a value. */
const PROTECTED_SHAPES = {
	"linux password": { platform: "linux", fields: { role: "password text", title: PROTECTED_LABEL, label: "" } },
	"linux unclassified": { platform: "linux", fields: { role: "unknown", title: PROTECTED_LABEL, label: "" } },
	"macos secure field": {
		platform: "macos",
		fields: { role: "AXSecureTextField", title: "", label: "", value: SECRET_VALUE },
	},
	"macos secure subrole": {
		platform: "macos",
		fields: { role: "AXTextField", subrole: "AXSecureTextField", title: "", label: "", value: SECRET_VALUE },
	},
	"windows missing role": { platform: "windows", fields: { role: "unknown", title: "", label: "" } },
} as const;

type Shape = (typeof PROTECTED_SHAPES)[keyof typeof PROTECTED_SHAPES];

/** `value`, failing the test when it is missing. */
function present<T>(value: T | undefined): T {
	assert.ok(value !== undefined, "expected a value");
	return value;
}

/** Parse a wire look and return its outline. */
const parsed = (raw: object) => present(parseLookResponse(raw).parsedOutline);

// biome-ignore lint/suspicious/noExplicitAny: tool results are untyped JS objects in these fixtures.
type Result = any;

/** Fail unless neither the model text nor the structured details mention the secret label or value. */
function assertNoSecret(result: Result, text: string, what: string): void {
	for (const secret of [SECRET, SECRET_VALUE]) {
		assert.ok(!text.toLowerCase().includes(secret), `${what} text echoes ${secret}:\n${text}`);
		assert.ok(!JSON.stringify(result.details).toLowerCase().includes(secret), `${what} details echo ${secret}`);
	}
}

async function desktop(shape: Shape) {
	const fake = await installFakeDesktop(onTestFinished, { platform: shape.platform });
	if (shape.platform === "windows") {
		// Windows admits a root only by its executable identity.
		const root = desktopRoot({ appId: "notes.exe" });
		fake.roots = [root];
		fake.apps = [{ appName: root.appName, appId: root.appId, pid: root.pid, isFrontmost: true }];
		fake.frontmost = { appName: root.appName, appId: root.appId, pid: root.pid, windowId: root.windowId };
	}
	const { executeExpandUi, executeInspectUi, executeSearchUi } = fake.bridge;
	/** Every read-only query surface for `ref`, checked against the secret. */
	const assertQueriesClean = async (stateId: string, ref: string) => {
		for (const text of [SECRET, SECRET_VALUE, "private", "hunter2"]) {
			const found = await fake.call(executeSearchUi, { stateId, text });
			assertNoSecret(found, fake.text(found), `search_ui(${text})`);
		}
		const expanded = await fake.call(executeExpandUi, { stateId, ref, depth: 3 });
		assertNoSecret(expanded, fake.text(expanded), "expand_ui");
		const inspected = await fake.call(executeInspectUi, { stateId, ref });
		assertNoSecret(inspected, fake.text(inspected), "inspect_ui");
	};
	/** Press `Keep` (`@e3`) while the live tree turns into `next`; act_ui chains the note from `stateId`. */
	const actWhile = async (stateId: string, next: object[]) => {
		fake.actHook = () => {
			fake.tree = next;
			return undefined;
		};
		// The post-act settle sleep runs on fake timers: no wall-clock wait.
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			let settled = false;
			const acting = fake
				.call(fake.bridge.executeAct, { stateId, actions: [{ action: "press", ref: "@e3" }] })
				.finally(() => {
					settled = true;
				});
			while (!settled) await vi.advanceTimersByTimeAsync(1_000);
			const acted = await acting;
			return { acted, text: fake.text(acted), stateId: acted.details.capture.stateId as string };
		} finally {
			vi.useRealTimers();
		}
	};
	/** Restart the session from `results` (oldest first), as Pi does when it reloads a branch. */
	const restart = async (results: Array<{ toolName: string; details: unknown }>) => {
		await fake.bridge.shutdownComputerUseSession();
		fake.bridge.reconstructStateFromBranch({
			...fake.ctx,
			sessionManager: {
				getBranch: () =>
					results.map(({ toolName, details }) => ({
						type: "message",
						message: { role: "toolResult", toolName, details: JSON.parse(JSON.stringify(details)) },
					})),
			},
		});
	};
	return { fake, assertQueriesClean, actWhile, restart };
}

describe.each(Object.entries(PROTECTED_SHAPES))("a readable node that turns %s", (_name, shape) => {
	test("expand_ui grafts the protection into the note, search, expand and inspect", async () => {
		const { fake, assertQueriesClean } = await desktop(shape);
		const readable = { title: SECRET, label: SECRET, value: SECRET_VALUE, truncated: true, children: [] };
		let live: object = readable;
		fake.lookPayload = (request: { scopeRef?: string }) =>
			request.scopeRef === "c"
				? { ...lookPayload({ lookId: "scoped", image: false }), outline: wireNode("c", "AXGroup", "", live) }
				: lookPayload({ children: [wireNode("c", "AXGroup", "", live), wireButton("b", "Keep")] });
		const { stateId, text } = await fake.observe();
		assert.match(text, new RegExp(SECRET), "precondition: the readable look shows the label");
		live = { ...shape.fields, truncated: false, children: [] };
		const expanded = await fake.call(fake.bridge.executeExpandUi, { stateId, ref: "@e2" });
		assert.equal(fake.looks.at(-1).scopeRef, "c", "the truncated node took a scoped look");
		assertNoSecret(expanded, fake.text(expanded), "expand_ui");
		assert.match(renderNote(expanded.details.note), /keep +seen/, "readable regions keep their labels");
		await assertQueriesClean(stateId, "@e2");
	});

	test("act_ui drops the earlier label from retained note regions and diffs", async () => {
		const { fake, assertQueriesClean, actWhile } = await desktop(shape);
		fake.tree = [wireNode("c", "AXGroup", SECRET, { value: SECRET_VALUE }), wireButton("b", "Keep")];
		const first = await fake.observe();
		assert.match(first.text, new RegExp(SECRET));
		const second = await actWhile(first.stateId, [
			wireNode("c", "AXGroup", "", { ...shape.fields }),
			wireButton("b", "Keep"),
		]);
		assert.equal(second.acted.details.view, "diff");
		assertNoSecret(second.acted, second.text, "act_ui");
		assert.match(second.text, /\[redacted\] +changed +\(not matched in latest look\)/);
		await assertQueriesClean(second.stateId, "@e2");
		// The later look revoked the node in the earlier state too (#1263): no replay, and no search oracle.
		const earlier = await fake.call(fake.bridge.executeInspectUi, { stateId: first.stateId, ref: "@e2" });
		assertNoSecret(earlier, fake.text(earlier), "inspect_ui on the earlier state");
		const kept = await fake.call(fake.bridge.executeInspectUi, { stateId: first.stateId, ref: "@e3" });
		assert.match(fake.text(kept), /AXButton "Keep"/, "a node the later look confirmed keeps its text");
		const expanded = await fake.call(fake.bridge.executeExpandUi, { stateId: first.stateId, ref: "@e2" });
		assertNoSecret(expanded, fake.text(expanded), "expand_ui on the earlier state");
		// No cached hit confirms the old text; with no cached match, the live OCR retry refuses the stale state.
		for (const text of [SECRET, "private", "hunter2"])
			await assert.rejects(
				fake.call(fake.bridge.executeSearchUi, { stateId: first.stateId, text }),
				(error: Error) => /stale/i.test(error.message) && !error.message.includes(SECRET),
			);
	});
});

test("a removed node's retained region is redacted: its classification is unknown", async () => {
	const { fake, assertQueriesClean, actWhile } = await desktop(PROTECTED_SHAPES["linux password"]);
	fake.tree = [wireNode("c", "AXGroup", SECRET), wireButton("b", "Keep")];
	const first = await fake.observe();
	const second = await actWhile(first.stateId, [wireButton("b", "Keep")]);
	assertNoSecret(second.acted, second.text, "act_ui");
	assert.match(second.text, /\[redacted\] +changed/);
	await assertQueriesClean(second.stateId, "@e3");
});

test("a scoped look with a protected node redacts preserved, unconfirmed children", async () => {
	const { fake, assertQueriesClean } = await desktop(PROTECTED_SHAPES["linux password"]);
	const group = (children: object[], extra = {}) => wireNode("g", "AXGroup", "Group", { children, ...extra });
	let kid = wireNode("kid", "AXStaticText", SECRET);
	fake.lookPayload = (request: { scopeRef?: string }) =>
		request.scopeRef === "g"
			? { ...lookPayload({ lookId: "scoped", image: false }), outline: group([kid]) }
			: lookPayload({ children: [group([kid], { truncated: request.scopeRef === undefined })] });
	const { stateId, text } = await fake.observe({ detail: "outline" });
	assert.match(text, new RegExp(SECRET));
	// The old child reappears under a new wire ref once protected, so the graft cannot reuse it.
	kid = wireNode("kid2", "password text", PROTECTED_LABEL, { label: "" });
	const expanded = await fake.call(fake.bridge.executeExpandUi, { stateId, ref: "@e2" });
	assertNoSecret(expanded, fake.text(expanded), "expand_ui");
	assert.match(fake.text(expanded), /@e3 AXStaticText "\[redacted\]"/);
	await assertQueriesClean(stateId, "@e3");
});

test("a restored session note from before the fix is redacted by every cached query", async () => {
	const { fake, assertQueriesClean } = await desktop(PROTECTED_SHAPES["linux password"]);
	fake.tree = [wireButton("b", "Keep")];
	const observed = await fake.observe();
	const details = JSON.parse(JSON.stringify(observed.result.details));
	// Older notes carried no node ref, so nothing can confirm the label's node is still readable.
	details.note.regions = [{ key: `AXGroup:${SECRET}`, label: SECRET, status: "seen" }];
	const restore = async () => {
		await fake.bridge.shutdownComputerUseSession();
		fake.bridge.reconstructStateFromBranch({
			...fake.ctx,
			sessionManager: {
				getBranch: () => [{ type: "message", message: { role: "toolResult", toolName: "observe_ui", details } }],
			},
		});
	};
	// Each query is first on a freshly restored state, so none relies on another's reconciliation.
	for (const [tool, params] of [
		[fake.bridge.executeSearchUi, { text: "Keep" }],
		[fake.bridge.executeInspectUi, { ref: "@e2" }],
		[fake.bridge.executeExpandUi, { ref: "@e2" }],
	] as const) {
		await restore();
		const result = await fake.call(tool, { stateId: observed.stateId, ...params });
		assertNoSecret(result, fake.text(result), tool.name);
		assert.deepEqual(result.details.note.regions[0], {
			key: "redacted",
			label: REDACTED_LABEL,
			status: "seen",
			source: "redacted",
		});
	}
	await assertQueriesClean(observed.stateId, "@e2");
});

test("a redacted top-level graft never echoes the old region label", async () => {
	const { fake, assertQueriesClean } = await desktop(PROTECTED_SHAPES["linux password"]);
	const keep = wireButton("b", "Keep");
	// The field turns protected and comes back under a new wire ref, so the graft keeps the old one unconfirmed.
	const protectedField = wireNode("a2", "password text", PROTECTED_LABEL, { label: "" });
	let turned = false;
	fake.lookPayload = (request: { scopeRef?: string }) => {
		if (turned) return lookPayload({ lookId: `turned-${request.scopeRef}`, children: [protectedField, keep] });
		const full = lookPayload({ children: [wireNode("a", "AXTextField", SECRET, { value: SECRET_VALUE }), keep] });
		return { ...full, outline: { ...full.outline, truncated: true } };
	};
	const { stateId, result } = await fake.observe();
	assert.ok(
		result.details.note.regions.some(
			(region: { ref?: string; label: string }) => region.ref === "@e2" && region.label === SECRET,
		),
		"precondition: the top-level field has its own note region",
	);
	turned = true;
	const expanded = await fake.call(fake.bridge.executeExpandUi, { stateId, ref: "@e1" });
	assert.equal(fake.looks.at(-1).scopeRef, "w", "the truncated root took a scoped look");
	assertNoSecret(expanded, fake.text(expanded), "expand_ui");
	const found = await fake.call(fake.bridge.executeSearchUi, { stateId, text: "Keep" });
	assertNoSecret(found, fake.text(found), "search_ui");
	assert.ok(
		found.details.note.regions.some((region: { label: string }) => region.label === REDACTED_LABEL),
		"the preserved field's region is redacted",
	);
	await assertQueriesClean(stateId, "@e2");
});

test("restart after scoped protection restores the graft, and fails closed when it was not persisted", async () => {
	const { fake, assertQueriesClean, restart } = await desktop(PROTECTED_SHAPES["linux password"]);
	const group = (children: object[], extra = {}) => wireNode("g", "AXGroup", "Group", { children, ...extra });
	let kid = wireNode("kid", "AXStaticText", SECRET);
	fake.lookPayload = (request: { scopeRef?: string }) =>
		request.scopeRef === "g"
			? { ...lookPayload({ lookId: "scoped", image: false }), outline: group([kid]) }
			: lookPayload({ children: [group([kid], { truncated: request.scopeRef === undefined })] });
	const observed = await fake.observe({ detail: "outline" });
	const original = present(loadStoredOutline(observed.stateId));
	kid = wireNode("kid2", "password text", PROTECTED_LABEL, { label: "" });
	const expanded = await fake.call(fake.bridge.executeExpandUi, { stateId: observed.stateId, ref: "@e2" });
	const session = [
		{ toolName: "observe_ui", details: observed.result.details },
		{ toolName: "expand_ui", details: expanded.details },
	];
	/** The restored state is the graft itself, not a blanket redaction: the confirmed group keeps its label. */
	const assertGraftRestored = async () => {
		const group = await fake.call(fake.bridge.executeInspectUi, { stateId: observed.stateId, ref: "@e2" });
		assert.match(fake.text(group), /AXGroup "Group"/);
		await assertQueriesClean(observed.stateId, "@e3");
	};
	await restart(session);
	await assertGraftRestored();
	// A legacy session carries the pre-graft outline inline; the store, rewritten by the graft, still wins.
	await restart([{ toolName: "observe_ui", details: { ...observed.result.details, outline: original } }, session[1]]);
	await assertGraftRestored();
	// The graft's write was lost: the store holds the pre-graft outline the session's expansion does not match.
	saveStoredOutline(observed.stateId, original);
	await restart(session);
	const inspected = await fake.call(fake.bridge.executeInspectUi, { stateId: observed.stateId, ref: "@e3" });
	assert.match(fake.text(inspected), /\[redacted\]/);
	await assertQueriesClean(observed.stateId, "@e3");
});

test("a scoped expansion on an older state revokes the newer state, on disk too", async () => {
	const { fake, assertQueriesClean, restart } = await desktop(PROTECTED_SHAPES["linux password"]);
	const group = (children: object[], extra = {}) => wireNode("g", "AXGroup", "Group", { children, ...extra });
	let kid = wireNode("kid", "AXStaticText", SECRET);
	fake.lookPayload = (request: { scopeRef?: string }) =>
		request.scopeRef === "g"
			? { ...lookPayload({ lookId: "scoped", image: false }), outline: group([kid]) }
			: lookPayload({
					lookId: `full-${fake.looks.length}`,
					children: [group([kid], { truncated: request.scopeRef === undefined })],
				});
	const older = await fake.observe({ detail: "outline" });
	const newer = await fake.observe({ detail: "outline" });
	kid = wireNode("kid2", "password text", PROTECTED_LABEL, { label: "" });
	const expanded = await fake.call(fake.bridge.executeExpandUi, { stateId: older.stateId, ref: "@e2" });
	await assertQueriesClean(newer.stateId, "@e3");
	// Restart restores the newest observation, which the expansion revoked after it was first written.
	await restart([
		{ toolName: "observe_ui", details: older.result.details },
		{ toolName: "observe_ui", details: newer.result.details },
		{ toolName: "expand_ui", details: expanded.details },
	]);
	const inspected = await fake.call(fake.bridge.executeInspectUi, { stateId: newer.stateId, ref: "@e3" });
	assertNoSecret(inspected, fake.text(inspected), "inspect_ui after restart");
	assert.match(fake.text(inspected), /\[redacted\]/);
});

test("a scoped graft that redacts drops the same state's earlier output pages", async () => {
	const { fake } = await desktop(PROTECTED_SHAPES["linux password"]);
	const long = `${SECRET} ${"x".repeat(60_000)}`;
	const group = (children: object[], extra = {}) => wireNode("g", "AXGroup", "Group", { children, ...extra });
	let kid = wireNode("kid", "AXStaticText", long);
	fake.lookPayload = (request: { scopeRef?: string }) =>
		request.scopeRef === "g"
			? { ...lookPayload({ lookId: "scoped", image: false }), outline: group([kid]) }
			: lookPayload({ children: [group([kid], { truncated: request.scopeRef === undefined })] });
	const { stateId } = await fake.observe({ detail: "outline" });
	const inspected = await fake.call(fake.bridge.executeInspectUi, { stateId, ref: "@e3" });
	const outputRef = present(/read_text\(\{ ref: "(@o\d+)"/.exec(fake.text(inspected)))[1];
	kid = wireNode("kid2", "password text", PROTECTED_LABEL, { label: "" });
	await fake.call(fake.bridge.executeExpandUi, { stateId, ref: "@e2" });
	await assert.rejects(fake.call(fake.bridge.executeReadText, { ref: outputRef }), /unavailable or was evicted/);
});

test("a protection revocation drops the earlier state's output pages", async () => {
	const { fake, actWhile } = await desktop(PROTECTED_SHAPES["linux password"]);
	const long = `${SECRET} ${"x".repeat(60_000)}`;
	fake.tree = [wireNode("c", "AXGroup", long), wireButton("b", "Keep")];
	const first = await fake.observe();
	const inspected = await fake.call(fake.bridge.executeInspectUi, { stateId: first.stateId, ref: "@e2" });
	const outputRef = present(/read_text\(\{ ref: "(@o\d+)"/.exec(fake.text(inspected)))[1];
	const page = await fake.call(fake.bridge.executeReadText, { ref: outputRef });
	assert.match(fake.text(page), new RegExp(SECRET), "precondition: the page holds the readable label");
	await actWhile(first.stateId, [
		wireNode("c", "password text", PROTECTED_LABEL, { label: "" }),
		wireButton("b", "Keep"),
	]);
	await assert.rejects(fake.call(fake.bridge.executeReadText, { ref: outputRef }), /unavailable or was evicted/);
});

test("a restored node without a role expands as protected, not as a crash", async () => {
	const { fake, restart } = await desktop(PROTECTED_SHAPES["linux password"]);
	fake.tree = [wireNode("c", "AXGroup", "Group", { children: [wireNode("k", "AXStaticText", SECRET)] })];
	const observed = await fake.observe();
	// An older writer or a damaged file: untyped JSON whose node omits `role` and `subrole`.
	const stored = JSON.parse(JSON.stringify(present(loadStoredOutline(observed.stateId))));
	const kid = stored.root.children[0].children[0];
	delete kid.role;
	delete kid.subrole;
	kid.value = SECRET_VALUE;
	saveStoredOutline(observed.stateId, stored);
	await restart([{ toolName: "observe_ui", details: observed.result.details }]);
	const expanded = await fake.call(fake.bridge.executeExpandUi, { stateId: observed.stateId, ref: "@e2", depth: 3 });
	assertNoSecret(expanded, fake.text(expanded), "expand_ui");
	assert.match(fake.text(expanded), /\[protected\]/);
});

describe("isProtectedNode", () => {
	test.each([
		["macOS secure role", { role: "AXSecureTextField" }],
		["macOS secure subrole", { role: "AXTextField", subrole: "AXSecureTextField" }],
		["Linux password", { role: "password text" }],
		["Linux unclassified", { role: "unknown" }],
		["Windows missing role", { role: " Unknown " }],
		["no role at all", { role: "" }],
		["the helper's title marker", { role: "AXGroup", title: PROTECTED_LABEL }],
		["the helper's description marker", { role: "AXGroup", description: PROTECTED_LABEL }],
	])("%s is protected", (_name, over) => {
		assert.equal(isProtectedNode(outlineNode("x", over)), true);
	});

	test.each([
		["AXButton", { role: "AXButton" }],
		["macOS web AXUnknown", { role: "AXUnknown" }],
		["Linux text", { role: "text", title: "protected" }],
	])("%s is readable", (_name, over) => {
		assert.equal(isProtectedNode(outlineNode("x", over)), false);
	});
});

describe("outline sanitizing", () => {
	// An AX title, description or identifier can still hold the old text, so none of them is trusted.
	const protectedWire = {
		ref: "s",
		role: "AXSecureTextField",
		title: SECRET,
		description: SECRET,
		identifier: SECRET,
		value: SECRET_VALUE,
		text: [{ string: SECRET_VALUE, confidence: 1 }],
		rect: { x: 1, y: 2, w: 3, h: 4 },
	};
	const textFields = (node: {
		title: string;
		description: string;
		identifier: string;
		value: string;
		text: unknown;
	}) => [node.title, node.description, node.identifier, node.value, node.text];

	test("a parsed protected node keeps only its role, ref, geometry and marker", () => {
		const outline = parsed({
			lookId: "l",
			outline: {
				ref: "w",
				role: "AXWindow",
				children: [protectedWire, { ref: "r", role: "AXTextField", title: "Name", value: "ok" }],
			},
		});
		const [, secure, readable] = outline.nodes;
		assert.deepEqual(textFields(secure), [PROTECTED_LABEL, "", "", "", []]);
		assert.deepEqual([secure.role, secure.wireRef, secure.rect], ["AXSecureTextField", "s", protectedWire.rect]);
		assert.deepEqual([readable.title, readable.value], ["Name", "ok"], "readable fields survive");
		for (const query of [SECRET, SECRET_VALUE, "private"])
			assert.equal(searchOutlineRanked(outline, query).totalMatches, 0, query);
		assert.ok(!JSON.stringify(serializeOutline(outline)).includes(SECRET));
		assert.ok(!foldToBudget(outline).text.includes(SECRET));
	});

	test("restoring a stored outline sanitizes protected nodes written before the fix", () => {
		const restored = restoreOutline({
			lookId: "l",
			root: {
				...outlineNode("@e1", { role: "AXWindow" }),
				children: [{ ...outlineNode("@e2", { ...protectedWire, ref: "@e2" }), children: [] }],
			},
		});
		assert.deepEqual(textFields(restored.nodes[1]), [PROTECTED_LABEL, "", "", "", []]);
	});

	test("a restored node missing its role or subrole is unclassified, not a crash", () => {
		// Untyped JSON, as read from disk: no cast hides the missing fields.
		const restored = restoreOutline(
			JSON.parse(
				JSON.stringify({
					lookId: "l",
					root: {
						ref: "@e1",
						role: "AXWindow",
						children: [
							{ ref: "@e2", title: "Bare", value: SECRET_VALUE, children: [] },
							{ ref: "@e3", role: "AXTextField", title: "Bare", value: "kept", children: [] },
							{ ref: "@e4", role: "AXStaticText", title: SECRET, unconfirmed: true, children: [] },
						],
					},
				}),
			),
		);
		assert.deepEqual(
			restored.nodes.slice(1).map((node) => [node.role, node.subrole, node.title, node.value, node.unconfirmed]),
			[
				["", "", PROTECTED_LABEL, "", undefined],
				["AXTextField", "", "Bare", "kept", undefined],
				["AXStaticText", "", REDACTED_LABEL, "", true],
			],
		);
		assert.ok(!foldToBudget(restored).text.includes(SECRET));
		assert.equal(searchOutlineRanked(restored, "private").totalMatches, 0);
	});

	test("diffs between a readable and a protected look name only the new fields", () => {
		const parse = (lookId: string, child: object) =>
			parsed({ lookId, outline: { ref: "w", role: "AXWindow", children: [child] } });
		const base = parse("a", { ref: "c", role: "AXTextField", title: SECRET, value: SECRET_VALUE });
		for (const child of [
			{ ref: "c", ...protectedWire },
			{ ref: "c2", role: "password text", title: PROTECTED_LABEL, value: SECRET_VALUE },
		]) {
			const next = stabilizeRefs(base, parse("b", child));
			const rendered = renderChanges(changesBetween(base, next).changes);
			assert.ok(rendered.length > 0);
			assert.ok(!rendered.includes(SECRET) && !rendered.includes(SECRET_VALUE), rendered);
			assert.ok(!JSON.stringify(changesBetween(base, next)).includes(SECRET_VALUE));
		}
	});
});

describe("graftScopedOutline", () => {
	const base = () =>
		outlineOf(
			outlineNode("@e1", {
				role: "AXWindow",
				children: [
					outlineNode("@e2", {
						wireRef: "g",
						truncated: true,
						children: [
							outlineNode("@e3", {
								wireRef: "old",
								role: "AXStaticText",
								title: SECRET,
								description: SECRET,
								// An identifier can itself be the old displayed label.
								identifier: SECRET,
								value: SECRET_VALUE,
								text: [{ string: SECRET, confidence: 1 }],
								children: [outlineNode("@e4", { wireRef: "deep", title: SECRET })],
							}),
						],
					}),
				],
			}),
		);
	const scoped = (child: object) => outlineOf(outlineNode("g", { wireRef: "g", children: [outlineNode("n", child)] }));

	test("a fresh scoped look re-confirms a node an earlier revocation left unconfirmed", () => {
		const outline = base();
		graftScopedOutline(outline, "@e2", scoped({ wireRef: "new", role: "password text", title: PROTECTED_LABEL }));
		graftScopedOutline(outline, "@e2", scoped({ wireRef: "old", role: "AXStaticText", title: "Fresh" }));
		const node = present(outline.nodes.find((candidate) => candidate.ref === "@e3"));
		assert.deepEqual([node.title, node.unconfirmed], ["Fresh", undefined]);
	});

	test("preserved children stay readable when the scoped look has no protected node", () => {
		const outline = base();
		graftScopedOutline(outline, "@e2", scoped({ wireRef: "new", role: "AXButton", title: "New" }));
		assert.equal(present(outline.nodes.find((node) => node.ref === "@e3")).title, SECRET);
	});

	test("preserved children and their subtrees are redacted when the scoped look has a protected node", () => {
		const outline = base();
		graftScopedOutline(outline, "@e2", scoped({ wireRef: "new", role: "password text", title: PROTECTED_LABEL }));
		const preserved = present(outline.nodes.find((node) => node.ref === "@e3"));
		assert.deepEqual(
			[preserved.title, preserved.description, preserved.identifier, preserved.value, preserved.text],
			[REDACTED_LABEL, "", "", "", []],
		);
		assert.deepEqual([preserved.wireRef, preserved.unconfirmed], ["old", true], "the ref stays addressable");
		for (const query of [SECRET, "private"]) assert.equal(searchOutlineRanked(outline, query).totalMatches, 0, query);
		assert.equal(present(outline.nodes.find((node) => node.ref === "@e4")).title, REDACTED_LABEL);
		assert.equal(
			present(outline.nodes.find((node) => node.wireRef === "new")).title,
			PROTECTED_LABEL,
			"grafted nodes keep fields",
		);
		assert.ok(!JSON.stringify(serializeOutline(outline)).includes(SECRET));
	});
});

describe("note retention", () => {
	const look = (lookId: string, children: ReturnType<typeof outlineNode>[]) =>
		outlineOf(outlineNode("@e1", { role: "AXWindow", children }), { lookId });
	const window = { windowRef: "w", title: "Main", pairing: "exact" as const };

	test("current regions record their node; retained unmatched regions lose their label and ref", () => {
		const first = noteFromLook(undefined, look("a", [outlineNode("@e2", { title: SECRET })]), window);
		assert.deepEqual(
			first.regions.map((region) => [region.source, region.ref, region.label]),
			[["node", "@e2", SECRET]],
		);
		const second = noteFromLook(first, look("b", [outlineNode("@e3", { role: "AXButton", title: "Go" })]), window);
		assert.deepEqual(second.regions, [
			{ key: "AXButton:go", label: "go", status: "seen", source: "node", ref: "@e3" },
			{
				key: "redacted",
				label: REDACTED_LABEL,
				status: "changed",
				source: "redacted",
				detail: "not matched in latest look",
			},
		]);
		assert.ok(!JSON.stringify(second).includes(SECRET.toLowerCase()));
	});

	test("protected top-level nodes are noted by their marker, never their title or identifier", () => {
		const note = noteFromLook(
			undefined,
			look("a", [outlineNode("@e2", { role: "AXSecureTextField", title: SECRET, identifier: SECRET })]),
			window,
		);
		assert.deepEqual(note.regions[0], {
			key: `AXSecureTextField:${PROTECTED_LABEL}`,
			label: PROTECTED_LABEL,
			status: "seen",
			source: "node",
			ref: "@e2",
		});
	});

	test("a real region of role window is reclassified by provenance, not exempted by its key", () => {
		const readable = look("a", [outlineNode("@e2", { role: "window", title: SECRET })]);
		const note = noteFromLook(undefined, readable, window);
		assert.equal(note.regions[0].key, `window:${SECRET}`, "the Windows helper's real role shares the prefix");
		const protectedNow = look("b", [outlineNode("@e2", { role: "password text", title: PROTECTED_LABEL })]);
		const reconciled = present(noteForOutline(note, protectedNow));
		assert.ok(!JSON.stringify(reconciled).includes(SECRET), JSON.stringify(reconciled));
		assert.equal(reconciled.regions[0].label, PROTECTED_LABEL);
	});

	test("noteForOutline rebuilds labels from confirmed current nodes only", () => {
		const note: WindowNote = {
			windowRef: "w",
			title: "Main",
			pairing: "exact",
			regions: [
				{ key: "AXGroup:stale", label: "stale", status: "seen", source: "node", ref: "@e2" },
				{
					key: `AXGroup:${SECRET}`,
					label: SECRET,
					status: "changed",
					detail: "acted here",
					source: "node",
					ref: "@e3",
				},
				{ key: `AXGroup:${SECRET} gone`, label: `${SECRET} gone`, status: "seen", source: "node", ref: "@e9" },
				{ key: `AXGroup:${SECRET} graft`, label: `${SECRET} graft`, status: "seen", source: "node", ref: "@e4" },
				{
					key: `AXGroup:stale:scroll:@e5`,
					label: "stale",
					status: "never-looked",
					source: "node",
					ref: "@e2",
					facet: "scroll:@e5",
				},
				{ key: "root:opened:r:Sheet", label: "sheet Sheet", status: "never-looked", source: "root" },
				{ key: "window:unpaired", label: "window capture", status: "never-looked", source: "window" },
				{ key: "redacted", label: REDACTED_LABEL, status: "changed", source: "redacted", ref: "@e2" },
				// Legacy regions predate provenance: a ref is reclassified, anything else fails closed.
				{ key: `window:${SECRET} legacy`, label: `${SECRET} legacy`, status: "changed", ref: "@e3" },
				{ key: `window:${SECRET} no ref`, label: `${SECRET} no ref`, status: "never-looked" },
			],
		};
		const outline = look("a", [
			outlineNode("@e2", { title: "Readable", identifier: "rid" }),
			outlineNode("@e3", { role: "password text", title: PROTECTED_LABEL, identifier: SECRET }),
			outlineNode("@e4", { role: "AXGroup", title: REDACTED_LABEL, unconfirmed: true }),
		]);
		const reconciled = present(noteForOutline(note, outline));
		assert.deepEqual(reconciled.regions, [
			{ key: "AXGroup:rid", label: "readable", status: "seen", source: "node", ref: "@e2" },
			{
				key: `password text:${PROTECTED_LABEL}`,
				label: PROTECTED_LABEL,
				status: "changed",
				detail: "acted here",
				source: "node",
				ref: "@e3",
			},
			{ key: "redacted", label: REDACTED_LABEL, status: "seen", source: "redacted" },
			{ key: `AXGroup:${REDACTED_LABEL}`, label: REDACTED_LABEL, status: "seen", source: "node", ref: "@e4" },
			{
				key: "AXGroup:rid:scroll:@e5",
				label: "readable",
				status: "never-looked",
				facet: "scroll:@e5",
				source: "node",
				ref: "@e2",
			},
			{ key: "root:opened:r:Sheet", label: "sheet Sheet", status: "never-looked", source: "root" },
			{ key: "window:unpaired", label: "window capture", status: "never-looked", source: "window" },
			{ key: "redacted", label: REDACTED_LABEL, status: "changed", source: "redacted" },
			{
				key: `password text:${PROTECTED_LABEL}`,
				label: PROTECTED_LABEL,
				status: "changed",
				source: "node",
				ref: "@e3",
			},
			{ key: "redacted", label: REDACTED_LABEL, status: "never-looked", source: "redacted" },
		]);
		assert.ok(!JSON.stringify(reconciled).includes(SECRET));
		assert.equal(note.regions[1].label, SECRET, "the input note is not mutated");
		assert.equal(noteForOutline(undefined, outline), undefined);
	});
});
