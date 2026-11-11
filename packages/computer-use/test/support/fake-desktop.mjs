// Fake desktop backend for driving the public observe/query tools without a native helper.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Build one wire outline node.
 * @param {string} ref Wire ref.
 * @param {string} role Accessibility role.
 * @param {string} title Node title.
 * @param {object} [extra] Wire field overrides, including `children`.
 * @returns {object} Wire node.
 * @throws {never} Fixed construction cannot fail.
 */
export const wireNode = (ref, role, title, extra = {}) => ({
	ref,
	wireRef: ref,
	role,
	subrole: "",
	title,
	label: title,
	value: "",
	actions: [],
	rect: { x: 10, y: 10, w: 50, h: 20 },
	children: [],
	...extra,
});

/**
 * Build a pressable wire button.
 * @param {string} ref Wire ref.
 * @param {string} title Button title.
 * @param {object} [extra] Wire field overrides.
 * @returns {object} Wire node.
 * @throws {never} Fixed construction cannot fail.
 */
export const wireButton = (ref, title, extra = {}) => wireNode(ref, "AXButton", title, { actions: ["AXPress"], ...extra });

/**
 * Build a desktop root listing entry.
 * @param {object} [fields] Overrides; `pid` defaults to 1.
 * @returns {object} Platform root.
 * @throws {never} Fixed construction cannot fail.
 */
export const desktopRoot = (fields = {}) => {
	const pid = fields.pid ?? 1;
	return {
		kind: "window",
		rootRef: `ax:w${pid}`,
		windowRef: `ax:w${pid}`,
		windowId: pid * 100,
		pid,
		appName: `App${pid}`,
		bundleId: `com.example.app${pid}`,
		title: "Main",
		zOrder: pid,
		framePoints: { x: 0, y: 0, w: 300, h: 200 },
		scaleFactor: 1,
		isOnscreen: true,
		isFocused: pid === 1,
		isMinimized: false,
		isMain: true,
		isModal: false,
		...fields,
	};
};

/**
 * Install a scripted platform backend and return its controls.
 * `roots` is the live root listing, `tree` the children of the next look's window node, `frontmostPid`
 * picks the frontmost root, and `listRootsHook`, `lookPayload` and `waitFor` may be replaced to script
 * the backend. Every look and wait request is recorded.
 * @param {(fn: () => void | Promise<void>) => void} onTestFinished Vitest cleanup registrar.
 * @param {object} [options] `roots` seeds the listing (the first root's pid is not auto-selected; set `frontmostPid`).
 * @returns {Promise<object>} Fake controls: `roots`, `tree`, `looks`, `waits`, `call`, `text`, `observe`, `bridge` and the hooks above.
 * @throws {Error} When the backend module cannot be imported.
 */
export async function installFakeDesktop(onTestFinished, options = {}) {
	const { currentPlatformBackend } = await import("../../src/platform/index.ts");
	const bridge = await import("../../src/bridge.ts");
	const { parseLookResponse } = await import("../../src/outline.ts");
	const original = { ...currentPlatformBackend };
	onTestFinished(async () => {
		await bridge.shutdownComputerUseSession();
		Object.assign(currentPlatformBackend, original);
		rmSync(cwd, { recursive: true, force: true });
	});

	const cwd = mkdtempSync(path.join(os.tmpdir(), "cu-fake-"));
	const fake = {
		roots: options.roots ?? [desktopRoot()],
		frontmostPid: 1,
		tree: [wireButton("b1", "Go")],
		windowTitle: "Main",
		readText: undefined,
		image: undefined,
		looks: [],
		waits: [],
		lookSeq: 0,
		/** Replaceable listing: receives the query, returns roots, or undefined for the default. */
		listRootsHook: undefined,
		/** Replaceable look builder: receives the request, returns a wire look. */
		lookPayload: undefined,
		/** Replaceable `waitFor` backend result: receives the request. */
		waitFor: async () => ({ found: true, nodeCount: 2 }),
	};
	const findWire = (nodes, ref) => {
		for (const node of nodes) {
			const hit = node.wireRef === ref ? node : findWire(node.children, ref);
			if (hit) return hit;
		}
		return undefined;
	};
	const defaultLook = (request) => {
		const root = fake.roots.find((candidate) => candidate.pid === fake.frontmostPid) ?? fake.roots[0];
		return {
			lookId: `look${++fake.lookSeq}`,
			capturedAt: 1,
			window: { windowId: root.windowId ?? 0, rootRef: root.rootRef, kind: "window", framePoints: root.framePoints, scaleFactor: 1, isModal: false, role: "AXWindow", subrole: "AXStandardWindow", metadata: {} },
			// A scoped look returns the requested subtree as its root, like the native helper.
			outline: (request?.scopeRef && findWire(fake.tree, request.scopeRef)) || wireNode("w", "AXWindow", fake.windowTitle, { subrole: "AXStandardWindow", rect: { x: 0, y: 0, w: 300, h: 200 }, children: fake.tree }),
			readText: fake.readText,
			image: fake.image,
			timings: { captureMs: 0, describeMs: 0, readTextMs: 0 },
		};
	};
	Object.assign(currentPlatformBackend, {
		ensureReady: async () => ({ permissionStatus: { accessibility: true, screenRecording: true }, lastPermissionCheckAt: Date.now() }),
		listApps: async () => fake.roots.map((r) => ({ appName: r.appName, bundleId: r.bundleId, pid: r.pid, isFrontmost: r.pid === fake.frontmostPid })),
		listRoots: async (query) => fake.listRootsHook?.(query) ?? (query?.pid ? fake.roots.filter((r) => r.pid === query.pid) : fake.roots),
		getFrontmost: async () => {
			const root = fake.roots.find((candidate) => candidate.pid === fake.frontmostPid) ?? fake.roots[0];
			return { appName: root.appName, bundleId: root.bundleId, pid: root.pid, windowId: root.windowId };
		},
		observe: async (request) => {
			fake.looks.push(request);
			return parseLookResponse((fake.lookPayload ?? defaultLook)(request));
		},
		waitFor: async (request, options) => {
			fake.waits.push({ request, options });
			return await fake.waitFor(request, options);
		},
	});

	const ctx = { cwd, hasUI: false, ui: { notify() {} }, sessionManager: { getBranch: () => [] } };
	fake.call = (executor, params, signal) => executor("t", params, signal, undefined, ctx);
	fake.text = (result) => result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
	/** Observe the frontmost root and return `{ result, stateId, text }`. */
	fake.observe = async (params = {}) => {
		const result = await fake.call(bridge.executeObserve, { mode: "semantic", ...params });
		return { result, stateId: result.details.capture?.stateId ?? result.details.stateId, text: fake.text(result) };
	};
	fake.bridge = bridge;
	return fake;
}
