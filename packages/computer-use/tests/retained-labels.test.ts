// Retained outline labels never outlive a node's readable classification (#1234): notes, grafts, searches, diffs.
import assert from "node:assert/strict";
import { describe, onTestFinished, test, vi } from "vitest";
import { noteForOutline, noteFromLook, renderNote, type WindowNote } from "../src/note.ts";
import {
	foldToBudget,
	graftScopedOutline,
	isProtectedNode,
	OUTLINE_FORMAT_VERSION,
	type ParseLookOptions,
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

/** Simulated seconds `act_ui` may take to settle before the test fails instead of spinning. */
const MAX_SETTLE_ADVANCES = 60;

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
	if (shape.platform === "windows" || shape.platform === "linux") {
		// Windows and Linux admit a root only by its executable identity.
		const root = desktopRoot({ appId: shape.platform === "windows" ? "notes.exe" : "notes" });
		fake.roots = [root];
		fake.apps = [{ appName: root.appName, appId: root.appId, pid: root.pid, isFrontmost: true }];
		fake.frontmost = { appName: root.appName, appId: root.appId, pid: root.pid, windowId: root.windowId };
	}
	const { executeExpandUi, executeInspectUi, executeSearchUi } = fake.bridge;
	/**
	 * Every read-only query surface for `ref`, checked against the secret. An OCR-escalated search adopts a fresh look,
	 * which revokes `stateId` when it holds a protected node (#1279), so later queries follow the returned state.
	 */
	const assertQueriesClean = async (initialStateId: string, ref: string) => {
		const expanded = await fake.call(executeExpandUi, { stateId: initialStateId, ref, depth: 3 });
		assertNoSecret(expanded, fake.text(expanded), "expand_ui");
		const inspected = await fake.call(executeInspectUi, { stateId: initialStateId, ref });
		assertNoSecret(inspected, fake.text(inspected), "inspect_ui");
		let stateId = initialStateId;
		for (const text of [SECRET, SECRET_VALUE, "private", "hunter2"]) {
			const found = await fake.call(executeSearchUi, { stateId, text });
			assertNoSecret(found, fake.text(found), `search_ui(${text})`);
			stateId = found.details.stateId;
		}
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
			for (let advances = 0; !settled && advances < MAX_SETTLE_ADVANCES; advances++)
				await vi.advanceTimersByTimeAsync(1_000);
			assert.ok(settled, `act_ui did not settle within ${MAX_SETTLE_ADVANCES} simulated seconds`);
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
		// The act's own look saw the protected node, so the earlier state no longer answers from its look (#1279).
		for (const [execute, params] of [
			[fake.bridge.executeInspectUi, { ref: "@e2" }],
			[fake.bridge.executeExpandUi, { ref: "@e2" }],
			[fake.bridge.executeSearchUi, { text: SECRET }],
		] as const)
			await assert.rejects(fake.call(execute, { stateId: first.stateId, ...params }), (error: Error) => {
				assert.match(error.message, new RegExp(`State '${first.stateId}' was revoked: a later look`));
				assert.ok(!error.message.includes(SECRET));
				return true;
			});
		await assertQueriesClean(second.stateId, "@e2");
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

// macOS and Windows redact a preserved, unconfirmed child; a Linux scoped reply is the whole live subtree, so the
// graft drops it instead (#1349).
for (const shape of ["windows missing role", "linux password"] as const)
	test(`a scoped look with a protected node redacts or drops preserved, unconfirmed children (${shape})`, async () => {
		const { fake, assertQueriesClean } = await desktop(PROTECTED_SHAPES[shape]);
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
		if (shape === "linux password") {
			assert.doesNotMatch(fake.text(expanded), /@e3/);
			await assert.rejects(fake.call(fake.bridge.executeInspectUi, { stateId, ref: "@e3" }), /not available/);
			await assertQueriesClean(stateId, "@e2");
		} else {
			assert.match(fake.text(expanded), /@e3 AXStaticText "\[redacted\]"/);
			await assertQueriesClean(stateId, "@e3");
		}
	});

test("a scoped look that leaves a child unread never brings its cached text or ref back (#1349)", async () => {
	const { fake, assertQueriesClean } = await desktop(PROTECTED_SHAPES["linux password"]);
	const kid = wireNode("kid", "AXStaticText", SECRET, { value: SECRET_VALUE });
	const group = (children: object[]) => wireNode("g", "AXGroup", "Group", { children, truncated: true });
	// The first look read the child; later looks refuse it, e.g. its live `Parent` edge is now unconfirmed.
	let children = [kid];
	fake.lookPayload = (request: { scopeRef?: string }) =>
		request.scopeRef === "g"
			? { ...lookPayload({ lookId: "scoped", image: false }), outline: group(children) }
			: lookPayload({ children: [group(children), wireButton("b", "Keep")] });
	const { stateId, text } = await fake.observe({ detail: "outline" });
	children = [];
	assert.match(text, new RegExp(SECRET), "precondition: the full look shows the child");
	assert.match(text, /@e4 AXStaticText/, "precondition: the child is @e4");
	const expanded = await fake.call(fake.bridge.executeExpandUi, { stateId, ref: "@e2" });
	assert.equal(fake.looks.at(-1).scopeRef, "g", "the truncated group took a scoped look");
	assertNoSecret(expanded, fake.text(expanded), "expand_ui");
	await assert.rejects(
		fake.call(fake.bridge.executeInspectUi, { stateId, ref: "@e4" }),
		/not available in the current outline/,
		"the refused child's cached ref is gone",
	);
	await assertQueriesClean(stateId, "@e2");
});

test("a complete Linux scoped look that omits a moved child drops its cached text and ref (#1349)", async () => {
	const { fake, assertQueriesClean } = await desktop(PROTECTED_SHAPES["linux password"]);
	const kid = wireNode("kid", "AXStaticText", SECRET, { value: SECRET_VALUE });
	// The child moves under a protected container outside the group: the helper never sees the old edge, so the
	// scoped reply is complete (nothing `truncated`) and simply omits it.
	let children = [kid];
	fake.lookPayload = (request: { scopeRef?: string }) =>
		request.scopeRef === "g"
			? { ...lookPayload({ lookId: "scoped", image: false }), outline: wireNode("g", "AXGroup", "Group") }
			: lookPayload({
					children: [wireNode("g", "AXGroup", "Group", { children, truncated: true }), wireButton("b", "Keep")],
				});
	const { stateId, text } = await fake.observe({ detail: "outline" });
	children = [];
	assert.match(text, new RegExp(SECRET), "precondition: the full look shows the child");
	assert.match(text, /@e4 AXStaticText/, "precondition: the child is @e4");
	const expanded = await fake.call(fake.bridge.executeExpandUi, { stateId, ref: "@e2" });
	assert.equal(fake.looks.at(-1).scopeRef, "g", "the truncated group took a scoped look");
	assertNoSecret(expanded, fake.text(expanded), "expand_ui");
	await assert.rejects(
		fake.call(fake.bridge.executeInspectUi, { stateId, ref: "@e4" }),
		/not available in the current outline/,
		"the moved child's cached ref is gone",
	);
	await assertQueriesClean(stateId, "@e2");
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

// macOS and Windows keep the old field redacted; Linux drops it (#1349). Its region is redacted either way.
for (const shape of ["windows missing role", "linux password"] as const)
	test(`a redacted top-level graft never echoes the old region label (${shape})`, async () => {
		const { fake, assertQueriesClean } = await desktop(PROTECTED_SHAPES[shape]);
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
		if (shape === "linux password") {
			await assert.rejects(fake.call(fake.bridge.executeInspectUi, { stateId, ref: "@e2" }), /not available/);
			await assertQueriesClean(stateId, "@e1");
		} else await assertQueriesClean(stateId, "@e2");
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

	test("a fresh scoped look re-confirms a node an earlier graft left unconfirmed", () => {
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

	test("an unconfirmed node is never keyed by an identifier it still carries", () => {
		const node = outlineNode("@e2", { role: "AXGroup", title: REDACTED_LABEL, identifier: SECRET });
		node.unconfirmed = true;
		const note = noteFromLook(undefined, look("a", [node]), window);
		assert.equal(note.regions[0].key, `AXGroup:${REDACTED_LABEL.toLowerCase()}`);
		assert.ok(!JSON.stringify(note).includes(SECRET), JSON.stringify(note));
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

describe("OCR text over a protected node (#1263)", () => {
	const field = { x: 100, y: 50, w: 80, h: 20 };
	const box = (string: string, rect?: object) => ({ string, confidence: 0.9, ...(rect ? { rect } : {}) });
	const secure = (extra = {}) => ({ ref: "s", role: "AXSecureTextField", rect: field, ...extra });
	const picture = (ref: string, title: string, rect: object) => ({
		ref,
		role: "AXImage",
		title,
		pictureOnly: true,
		rect,
	});
	const window = (children: object[], extra = {}, options: ParseLookOptions = {}) =>
		present(
			parseLookResponse(
				{
					lookId: "l",
					outline: { ref: "w", role: "AXWindow", rect: { x: 0, y: 0, w: 300, h: 200 }, children, ...extra },
				},
				options,
			).parsedOutline,
		);
	const byWire = (outline: ReturnType<typeof parsed>, wireRef: string) =>
		present(outline.nodes.find((node) => node.wireRef === wireRef));
	const texts = (outline: ReturnType<typeof parsed>, wireRef: string) =>
		byWire(outline, wireRef).text.map((item) => item.string);

	test("a box attributed to another node is dropped where it overlaps the field", () => {
		const outline = window([
			{
				ref: "g",
				role: "AXGroup",
				rect: { x: 90, y: 40, w: 200, h: 100 },
				text: [box(SECRET, { x: 95, y: 52, w: 30, h: 10 }), box("Shown", { x: 200, y: 100, w: 40, h: 10 })],
				children: [secure()],
			},
		]);
		assert.deepEqual(texts(outline, "g"), ["Shown"]);
		assert.equal(searchOutlineRanked(outline, SECRET).totalMatches, 0);
		assert.ok(!JSON.stringify(serializeOutline(outline)).includes(SECRET));
	});

	test("a picture-only title over the field reads as protected; one beside it stays", () => {
		const outline = window([
			secure(),
			picture("pic_1", SECRET, { x: 170, y: 55, w: 30, h: 10 }),
			picture("pic_2", "Beside", { x: 10, y: 150, w: 30, h: 10 }),
		]);
		const redacted = byWire(outline, "pic_1");
		assert.deepEqual(
			[redacted.title, redacted.pictureOnly, redacted.rect],
			[PROTECTED_LABEL, true, { x: 170, y: 55, w: 30, h: 10 }],
		);
		assert.equal(byWire(outline, "pic_2").title, "Beside");
		assert.ok(!foldToBudget(outline).text.includes(SECRET));
	});

	test("a picture-only node over a redacted one is redacted too, and restore agrees", () => {
		const outline = window([
			secure(),
			picture("pic_1", SECRET, { x: 170, y: 55, w: 30, h: 10 }),
			picture("pic_2", `${SECRET} tail`, { x: 195, y: 55, w: 30, h: 10 }),
			picture("pic_3", "Far", { x: 10, y: 150, w: 30, h: 10 }),
		]);
		assert.deepEqual(
			["pic_1", "pic_2", "pic_3"].map((ref) => byWire(outline, ref).title),
			[PROTECTED_LABEL, PROTECTED_LABEL, "Far"],
		);
		const restored = restoreOutline(serializeOutline(outline));
		assert.deepEqual(serializeOutline(restored), serializeOutline(outline), "a second pass changes nothing");
	});

	test("a protected node of unknown area drops every OCR box and picture-only title", () => {
		const outline = window(
			[
				secure({ rect: { x: 0, y: 0, w: 0, h: 0 } }),
				{
					ref: "t",
					role: "AXStaticText",
					title: "Kept",
					rect: { x: 10, y: 150, w: 30, h: 10 },
					text: [box(SECRET, { x: 10, y: 150, w: 30, h: 10 })],
				},
				picture("pic_1", SECRET, { x: 200, y: 150, w: 30, h: 10 }),
			],
			{ text: [box(SECRET, { x: 250, y: 180, w: 20, h: 10 })] },
		);
		assert.deepEqual([texts(outline, "w"), texts(outline, "t")], [[], []]);
		assert.equal(byWire(outline, "t").title, "Kept", "AX fields are not OCR and stay");
		assert.equal(byWire(outline, "pic_1").title, PROTECTED_LABEL);
	});

	test("a box without area is dropped once the outline holds a protected node", () => {
		const outline = window([
			secure(),
			{ ref: "g", role: "AXGroup", rect: { x: 10, y: 150, w: 30, h: 10 }, text: [box(SECRET)] },
		]);
		assert.deepEqual(texts(outline, "g"), []);
	});

	test("an outline without protected nodes keeps every box, placed or not", () => {
		const outline = window([
			{ ref: "g", role: "AXGroup", rect: field, text: [box("Placed", field), box("Unplaced")] },
			picture("pic_1", "Logo", field),
		]);
		assert.deepEqual(texts(outline, "g"), ["Placed", "Unplaced"]);
		assert.equal(byWire(outline, "pic_1").title, "Logo");
	});

	test("a Linux child's own-value text inside a protected ancestor stays; text spilling past it does not", () => {
		const child = { x: 20, y: 20, w: 50, h: 20 };
		const outline = window(
			[
				{
					ref: "u",
					role: "unknown",
					title: PROTECTED_LABEL,
					rect: { x: 10, y: 10, w: 200, h: 100 },
					children: [
						{ ref: "own", role: "text", value: "Readable", rect: child, text: [box("Readable", child)] },
						{ ref: "spill", role: "text", rect: child, text: [box(SECRET, { x: 20, y: 20, w: 120, h: 20 })] },
						picture("pic_1", SECRET, { x: 30, y: 60, w: 30, h: 10 }),
					],
				},
			],
			{},
			{ ownValueText: true },
		);
		assert.deepEqual([texts(outline, "own"), texts(outline, "spill")], [["Readable"], []]);
		assert.equal(byWire(outline, "pic_1").title, PROTECTED_LABEL, "a picture-only box is nobody's own pixels");
	});

	test("restoring an outline stored before the fix drops boxes over a protected node", () => {
		const restored = restoreOutline({
			lookId: "l",
			root: {
				...outlineNode("@e1", { role: "AXWindow", rect: { x: 0, y: 0, w: 300, h: 200 }, text: [box(SECRET, field)] }),
				children: [{ ...outlineNode("@e2", { role: "AXSecureTextField", rect: field }), children: [] }],
			},
		});
		assert.deepEqual(restored.root.text, []);
	});

	test("a graft that sees protection drops OCR boxes it can no longer place", () => {
		const outline = outlineOf(
			outlineNode("@e1", {
				role: "AXWindow",
				rect: { x: 0, y: 0, w: 300, h: 200 },
				children: [
					outlineNode("@e2", { wireRef: "g", rect: field, truncated: true }),
					outlineNode("@e3", {
						wireRef: "t",
						rect: { x: 10, y: 150, w: 30, h: 10 },
						text: [box(SECRET, { x: 10, y: 150, w: 30, h: 10 })],
					}),
					outlineNode("@e4", {
						wireRef: "pic",
						pictureOnly: true,
						role: "AXImage",
						title: SECRET,
						rect: { x: 200, y: 150, w: 30, h: 10 },
					}),
				],
			}),
		);
		graftScopedOutline(
			outline,
			"@e2",
			outlineOf(
				outlineNode("g", {
					wireRef: "g",
					children: [outlineNode("n", { wireRef: "n", role: "AXSecureTextField", rect: field })],
				}),
			),
		);
		assert.deepEqual(present(outline.nodes.find((node) => node.ref === "@e3")).text, []);
		assert.equal(present(outline.nodes.find((node) => node.ref === "@e4")).title, PROTECTED_LABEL);
		assert.ok(!JSON.stringify(serializeOutline(outline)).includes(SECRET));
	});

	/** A readable box well away from `field`, so only the unknown-geometry rule can drop it. */
	const far = { x: 10, y: 150, w: 30, h: 10 };
	const farText = (extra = {}) => ({ ref: "t", role: "AXStaticText", rect: far, text: [box(SECRET, far)], ...extra });
	/** A restored current-format outline: `children` under a readable window that holds a box at `far`. */
	const restored = (children: object[]) =>
		restoreOutline({
			lookId: "l",
			formatVersion: OUTLINE_FORMAT_VERSION,
			root: {
				...outlineNode("@e1", { role: "AXWindow", rect: { x: 0, y: 0, w: 300, h: 200 }, text: [box(SECRET, far)] }),
				children: children as never,
			},
		});
	const restoredNode = (ref: string, over: object, children: object[] = []) => ({
		...outlineNode(ref, over),
		children,
	});

	for (const [name, rect] of Object.entries({
		"protected rect missing its origin": { w: 80, h: 20 },
		"protected rect with a NaN origin": { x: Number.NaN, y: 50, w: 80, h: 20 },
		"protected rect with a string origin": { x: "100", y: 50, w: 80, h: 20 },
		"null protected rect": null,
	})) {
		test(`parse: a ${name} is unknown geometry and drops every OCR box`, () => {
			const outline = window([secure({ rect }), farText()], { text: [box(SECRET, far)] });
			assert.deepEqual([texts(outline, "w"), texts(outline, "t")], [[], []]);
			assert.equal(byWire(outline, "s").rect, undefined, "no origin is invented");
		});

		test(`restore: a legacy ${name} is unknown geometry and drops every OCR box`, () => {
			const outline = restored([
				restoredNode("@e2", { role: "AXSecureTextField", rect }),
				restoredNode("@e3", farText()),
			]);
			assert.deepEqual([outline.root.text, present(outline.nodes[2]).text], [[], []]);
			assert.equal(present(outline.nodes[1]).rect, undefined);
		});
	}

	for (const [name, rect] of Object.entries({
		"box rect missing its origin": { w: 30, h: 10 },
		"null box rect": null,
		"box rect with an infinite size": { x: 10, y: 150, w: Number.POSITIVE_INFINITY, h: 10 },
	})) {
		test(`parse and restore: a ${name} is unplaced and dropped beside a protected node`, () => {
			const outline = window([secure(), farText({ text: [box(SECRET, rect as object), box("Shown", far)] })]);
			assert.deepEqual(texts(outline, "t"), ["Shown"]);
			const legacy = restored([
				restoredNode("@e2", { role: "AXSecureTextField", rect: field }),
				restoredNode("@e3", farText({ text: [{ string: SECRET, confidence: 1, rect }, box("Shown", far)] })),
			]);
			assert.deepEqual(
				present(legacy.nodes[2]).text.map((item) => item.string),
				["Shown"],
			);
		});
	}

	test("restore keeps a well-formed rect and drops a malformed one on a readable node", () => {
		const outline = restored([
			restoredNode("@e2", { role: "AXButton", rect: { x: 1, y: 2, w: 3, h: 4 } }),
			restoredNode("@e3", { role: "AXButton", rect: { x: 1, w: 3, h: 4 } }),
		]);
		assert.deepEqual([outline.nodes[1].rect, outline.nodes[2].rect], [{ x: 1, y: 2, w: 3, h: 4 }, undefined]);
		assert.deepEqual(outline.root.text, [{ string: SECRET, confidence: 0.9, rect: far }]);
	});

	const underProtected = (child: object) => [
		{ ref: "u", role: "unknown", title: PROTECTED_LABEL, rect: { x: 10, y: 10, w: 200, h: 100 }, children: [child] },
	];
	const childRect = { x: 20, y: 20, w: 50, h: 20 };

	test("macOS OCR under a protected ancestor is dropped even inside a readable child", () => {
		const outline = window(
			underProtected({
				ref: "own",
				role: "AXStaticText",
				value: SECRET,
				rect: childRect,
				text: [box(SECRET, childRect)],
			}),
		);
		assert.deepEqual(texts(outline, "own"), []);
	});

	test("Linux own-value text equal to the node value stays; a box with another string is dropped", () => {
		const own = (value: string, string: string) =>
			window(
				underProtected({ ref: "own", role: "text", value, rect: childRect, text: [box(string, childRect)] }),
				{},
				{ ownValueText: true },
			);
		assert.deepEqual(texts(own("Readable", "Readable"), "own"), ["Readable"]);
		assert.deepEqual(texts(own("Readable", SECRET), "own"), []);
		assert.deepEqual(texts(own("", SECRET), "own"), [], "an empty value proves nothing");
		const besideProtected = window(
			[
				{ ref: "s", role: "password text", title: PROTECTED_LABEL, rect: childRect },
				{ ref: "own", role: "text", value: "Readable", rect: childRect, text: [box("Readable", childRect)] },
			],
			{},
			{ ownValueText: true },
		);
		assert.deepEqual(texts(besideProtected, "own"), [], "a protected sibling is not an ancestor");
	});

	test("restore: a legacy box without provenance is OCR; a saved own-value box round-trips", () => {
		const child = (text: object) =>
			restoredNode("@e3", { role: "text", value: "Readable", rect: childRect, text: [text] });
		const legacy = (text: object) =>
			restoreOutline({
				lookId: "l",
				formatVersion: OUTLINE_FORMAT_VERSION,
				root: restoredNode("@e1", { role: "AXWindow", rect: { x: 0, y: 0, w: 300, h: 200 } }, [
					restoredNode("@e2", { role: "unknown", rect: { x: 10, y: 10, w: 200, h: 100 } }, [child(text)]),
				]),
			});
		assert.deepEqual(legacy(box("Readable", childRect)).nodes[2].text, []);
		assert.deepEqual(legacy({ ...box("Readable", childRect), source: "ocr" }).nodes[2].text, []);
		const otherString = legacy({ ...box(SECRET, childRect), source: "value" });
		assert.deepEqual(otherString.nodes[2].text, [], "a tag never vouches for a string other than the value");
		const linux = window(
			underProtected({
				ref: "own",
				role: "text",
				value: "Readable",
				rect: childRect,
				text: [box("Readable", childRect)],
			}),
			{},
			{ ownValueText: true },
		);
		const again = restoreOutline(serializeOutline(linux));
		assert.deepEqual(serializeOutline(again), serializeOutline(linux));
		assert.deepEqual(texts(again as ReturnType<typeof parsed>, "own"), ["Readable"]);
	});

	test("the Linux backend marks its own-value text", async ({ onTestFinished }) => {
		const { linuxHelper } = await import("../src/platform/linux/helper.ts");
		const { linuxBackend } = await import("../src/platform/linux/backend.ts");
		const command = vi.spyOn(linuxHelper, "command").mockResolvedValue({
			lookId: "l1",
			outline: {
				ref: "w",
				role: "frame",
				truncated: false,
				rect: { x: 0, y: 0, w: 300, h: 200 },
				children: underProtected({
					ref: "own",
					role: "text",
					truncated: false,
					value: "Readable",
					rect: childRect,
					text: [box("Readable", childRect)],
				}).map((node) => ({ ...node, truncated: false })),
			},
		});
		onTestFinished(() => command.mockRestore());
		const look = await linuxBackend.observe({ target: { pid: 1 } });
		assert.deepEqual(present(look.parsedOutline).nodes[2].text, [
			{ string: "Readable", confidence: 0.9, rect: childRect, source: "value" },
		]);
	});

	test("visual OCR over an unread subtree is dropped; an unread node without a rect drops it all", () => {
		const unread = { ref: "u", role: "AXGroup", truncated: true, rect: { x: 90, y: 40, w: 100, h: 40 } };
		const outline = window([unread, farText(), picture("pic_1", SECRET, { x: 100, y: 50, w: 30, h: 10 })], {
			text: [box(SECRET, { x: 95, y: 45, w: 30, h: 10 }), box("Shown", { x: 250, y: 10, w: 30, h: 10 })],
		});
		assert.deepEqual([texts(outline, "w"), texts(outline, "t")], [["Shown"], [SECRET]]);
		assert.equal(byWire(outline, "pic_1").title, PROTECTED_LABEL);
		const rectless = window([{ ...unread, rect: { x: 0, y: 0, w: 0, h: 0 } }, farText()]);
		assert.deepEqual(texts(rectless, "t"), []);
	});

	test("an unconfirmed node alone filters OCR on restore and graft", () => {
		const outline = restored([
			restoredNode("@e2", { role: "AXGroup", wireRef: "old", unconfirmed: true, rect: { x: 0, y: 140, w: 60, h: 30 } }),
			restoredNode("@e3", { role: "AXGroup", wireRef: "g", rect: { x: 200, y: 10, w: 50, h: 50 } }),
			restoredNode("@e4", {
				role: "AXGroup",
				wireRef: "k",
				rect: { x: 250, y: 150, w: 30, h: 10 },
				text: [box("Kept", { x: 250, y: 150, w: 30, h: 10 })],
			}),
		]);
		assert.deepEqual(outline.root.text, [], "the box at `far` overlaps the unconfirmed node");
		assert.deepEqual(
			outline.nodes[3].text.map((item) => item.string),
			["Kept"],
		);
		outline.root.text = [box(SECRET, far) as never];
		graftScopedOutline(outline, "@e3", outlineOf(outlineNode("g", { wireRef: "g", role: "AXGroup" })));
		assert.ok(!outline.nodes.some(isProtectedNode), "no protected node anywhere");
		assert.deepEqual([outline.root.text, outline.nodes[3].text.map((item) => item.string)], [[], ["Kept"]]);
	});

	test("rectless protected graft root: the cached rect never stands in, so every OCR box goes", () => {
		const outline = outlineOf(
			outlineNode("@e1", {
				role: "AXWindow",
				rect: { x: 0, y: 0, w: 300, h: 200 },
				text: [box(SECRET, far)],
				children: [outlineNode("@e2", { wireRef: "f", role: "AXTextField", rect: field })],
			}),
		);
		const target = graftScopedOutline(
			outline,
			"@e2",
			outlineOf(outlineNode("f", { wireRef: "f", role: "AXSecureTextField" })),
		);
		assert.equal(target.rect, undefined, "a protected target is unplaced in full-look space");
		assert.deepEqual(outline.root.text, []);
		assert.deepEqual(restoreOutline(serializeOutline(outline)).root.text, [], "and stays so on restore");
	});

	test("a graft never mixes scoped box coordinates with a protected sibling outside it", () => {
		const outline = outlineOf(
			outlineNode("@e1", {
				role: "AXWindow",
				rect: { x: 0, y: 0, w: 300, h: 200 },
				children: [
					outlineNode("@e2", { wireRef: "s", role: "AXSecureTextField", rect: field }),
					outlineNode("@e3", { wireRef: "g", rect: { x: 200, y: 120, w: 90, h: 70 } }),
				],
			}),
		);
		// Scoped space: the box sits at the scoped root's origin, nowhere near the sibling's full-look rect.
		const scoped = outlineOf(
			outlineNode("g", {
				wireRef: "g",
				rect: { x: 0, y: 0, w: 90, h: 70 },
				text: [box(SECRET, { x: 0, y: 0, w: 30, h: 10 })],
			}),
		);
		const target = graftScopedOutline(outline, "@e3", scoped);
		assert.deepEqual(target.rect, { x: 200, y: 120, w: 90, h: 70 }, "a readable target keeps its action rect");
		assert.deepEqual(target.text, []);
	});

	/** A stored window holding a secure field at `fieldRect`, a box at x:110 and a picture-only title far away. */
	const stored = (fieldRect: object, formatVersion?: number) =>
		restoreOutline({
			lookId: "l",
			...(formatVersion === undefined ? {} : { formatVersion }),
			root: restoredNode("@e1", { role: "AXWindow", rect: { x: 0, y: 0, w: 300, h: 200 } }, [
				restoredNode("@e2", { role: "AXSecureTextField", rect: fieldRect }),
				restoredNode("@e3", {
					role: "AXGroup",
					rect: { x: 105, y: 45, w: 60, h: 30 },
					text: [box(SECRET, { x: 110, y: 52, w: 30, h: 10 })],
				}),
				restoredNode("@e4", { role: "AXImage", pictureOnly: true, title: SECRET, rect: far }),
			]),
		});

	test("legacy normalized origin: an unversioned outline with an unreadable node drops all its OCR", () => {
		// The old parser saved `{ y: 50, w: 80, h: 20 }` as `x: 0`, so the box at x:110 escaped its filter.
		const legacy = stored({ x: 0, y: 50, w: 80, h: 20 });
		assert.deepEqual([legacy.nodes[2].text, legacy.nodes[3].title], [[], PROTECTED_LABEL]);
		assert.ok(!JSON.stringify(serializeOutline(legacy)).includes(SECRET));
		const versioned = stored({ x: 0, y: 50, w: 80, h: 20 }, OUTLINE_FORMAT_VERSION);
		assert.deepEqual(
			[versioned.nodes[2].text.map((item) => item.string), versioned.nodes[3].title],
			[[SECRET], SECRET],
			"a versioned origin is genuine, so the per-rect rules apply",
		);
		const unknown = stored({ x: 0, y: 50, w: 80, h: 20 }, OUTLINE_FORMAT_VERSION + 1);
		assert.deepEqual(unknown.nodes[2].text, [], "an unrecognized version is legacy too");
		const readable = restoreOutline({
			lookId: "l",
			root: restoredNode("@e1", { role: "AXWindow", rect: { x: 0, y: 0, w: 300, h: 200 } }, [
				restoredNode("@e3", { role: "AXGroup", rect: far, text: [box("Kept", far)] }),
				restoredNode("@e4", { role: "AXImage", pictureOnly: true, title: "Logo", rect: field }),
			]),
		});
		assert.deepEqual(
			[readable.nodes[1].text.map((item) => item.string), readable.nodes[2].title],
			[["Kept"], "Logo"],
			"a legacy outline with no unreadable node restores unchanged",
		);
		assert.equal(serializeOutline(readable).formatVersion, OUTLINE_FORMAT_VERSION, "writers stamp the version");
	});

	test("truncated picture-only self overlap: an unread picture-only node never keeps its own OCR title", () => {
		const unread = { ...picture("pic_1", SECRET, far), truncated: true };
		const outline = window([unread, picture("pic_2", "Beside", { x: 200, y: 150, w: 30, h: 10 })]);
		assert.deepEqual([byWire(outline, "pic_1").title, byWire(outline, "pic_2").title], [PROTECTED_LABEL, "Beside"]);
		const restoredPicture = restoreOutline({
			lookId: "l",
			formatVersion: OUTLINE_FORMAT_VERSION,
			root: restoredNode("@e1", { role: "AXWindow", rect: { x: 0, y: 0, w: 300, h: 200 } }, [
				restoredNode("@e2", { role: "AXImage", pictureOnly: true, truncated: true, title: SECRET, rect: far }),
			]),
		});
		assert.equal(restoredPicture.nodes[1].title, PROTECTED_LABEL);
		assert.ok(!JSON.stringify(serializeOutline(restoredPicture)).includes(SECRET));
	});

	test("observe_ui and search_ui never echo OCR read over a secure field", async () => {
		const fake = await installFakeDesktop(onTestFinished, { platform: "macos" });
		fake.lookPayload = () =>
			lookPayload({
				children: [
					wireNode("g", "AXGroup", "Form", {
						rect: { x: 90, y: 40, w: 200, h: 100 },
						text: [box(SECRET, { x: 95, y: 52, w: 30, h: 10 })],
						children: [wireNode("s", "AXSecureTextField", "", { label: "", rect: field })],
					}),
					wireNode("pic_1", "AXImage", SECRET, {
						pictureOnly: true,
						label: SECRET,
						rect: { x: 170, y: 55, w: 30, h: 10 },
					}),
				],
			});
		const observed = await fake.observe({ detail: "outline" });
		assertNoSecret(observed.result, observed.text, "observe_ui");
		let stateId = observed.stateId;
		for (const query of [SECRET, "private"]) {
			const found = await fake.call(fake.bridge.executeSearchUi, { stateId, text: query });
			assertNoSecret(found, fake.text(found), `search_ui(${query})`);
			stateId = found.details.stateId;
		}
	});
});
