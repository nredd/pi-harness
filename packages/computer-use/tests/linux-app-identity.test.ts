import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeTestTempDir } from "@nredd/pi-test-lib/temp-dir";
import { expect, test, vi } from "vitest";
import { executeFind, executeObserve, executeReadText, executeSearchUi } from "../src/bridge.ts";
import { currentPlatformBackend, platformBackendForRuntime } from "../src/platform/index.ts";
import { linuxBackend } from "../src/platform/linux/backend.ts";
import { linuxHelper } from "../src/platform/linux/helper.ts";

type Root = Record<string, unknown> & { pid: number; metadata: { busName: string; objectPath: string } };

/**
 * A Linux helper root: `appName` is the app-supplied AT-SPI name, `appId` the executable basename. Its AT-SPI
 * identity is `:1.<pid>` plus `/window`; `extra.metadata` entries merge over it.
 */
function linuxRoot(
	pid: number,
	appName: string,
	appId?: string,
	{ metadata, ...extra }: Record<string, unknown> & { metadata?: Record<string, unknown> } = {},
): Root {
	return {
		kind: "window",
		pid,
		title: `${appName} window`,
		appName,
		processName: appId ?? null,
		appId: appId ?? null,
		isFocused: pid === 101,
		...extra,
		metadata: { busName: `:1.${pid}`, objectPath: "/window", ...metadata },
	};
}

/** The AT-SPI identity the helper retains for a root: bus name and object path. */
const nativeIdentity = (root: Root) => `${root.metadata.busName}${root.metadata.objectPath}`;

/** Drive the bridge with the Linux backend over a scripted helper whose roots the test can change. */
function useLinuxRoots(onTestFinished: (fn: () => void) => void, initial: Root[]) {
	const original = { ...currentPlatformBackend };
	const cwd = makeTestTempDir("cu-linux-identity-", onTestFinished);
	onTestFinished(() => {
		Object.assign(currentPlatformBackend, original);
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});
	vi.stubEnv("PI_CODING_AGENT_DIR", cwd);
	vi.stubEnv("PI_COMPUTER_USE_BLOCKED_APPS", undefined);
	vi.stubEnv("PI_COMPUTER_USE_CDP_PORT", undefined);
	Object.assign(currentPlatformBackend, platformBackendForRuntime("linux"), {
		ensureReady: async (_ctx: unknown, state: unknown) => state,
	});
	const state: { roots: Root[]; lookRootError?: Error } = { roots: initial };
	// Like the helper, every listing replaces the handle table: a root it omits loses its `@w` handle, and a
	// later listing issues a new one (#1300).
	let handles = new Map<string, string>();
	let minted = 0;
	const lookRoots = new Map<string, string>();
	const command = vi.spyOn(linuxHelper, "command").mockImplementation(async (name, args) => {
		switch (name) {
			case "listRoots": {
				const pid = (args as { pid?: number } | undefined)?.pid;
				const listed = pid ? state.roots.filter((root) => root.pid === pid) : state.roots;
				const next = new Map<string, string>();
				const roots = listed.map((root) => {
					const rootRef = handles.get(nativeIdentity(root)) ?? `@w${++minted}`;
					next.set(nativeIdentity(root), rootRef);
					return { ...root, rootRef };
				});
				handles = next;
				return { roots };
			}
			case "atspiLookRoot": {
				if (state.lookRootError) throw state.lookRootError;
				const identity = lookRoots.get(String(args?.lookId));
				const root = state.roots.find((candidate) => nativeIdentity(candidate) === identity);
				return { root: root ? { ...root, rootRef: handles.get(identity!) ?? "" } : null };
			}
			case "look": {
				const identity = [...handles].find(([, handle]) => handle === args?.rootRef)?.[0];
				if (!identity) throw Object.assign(new Error("Root not found"), { code: "target_not_found" });
				const lookId = `look-${lookRoots.size + 1}`;
				lookRoots.set(lookId, identity);
				return {
					lookId,
					window: { rootRef: args?.rootRef, framePoints: { x: 0, y: 0, w: 100, h: 100 }, scaleFactor: 1 },
					outline: {
						ref: "native-window",
						role: "frame",
						title: "Window",
						truncated: false,
						children: [{ ref: "native-body", role: "text", title: "Body", truncated: false, children: [] }],
					},
					readText: { requested: false, executed: false },
				};
			}
			case "atspiReadText":
				return { text: "private body", offset: 0, limit: 4000, totalChars: 12, hasMore: false };
			default:
				throw new Error(`Unexpected helper command ${name}`);
		}
	});
	mkdirSync(path.join(cwd, "extensions"));
	const userFile = path.join(cwd, "extensions", "pi-computer-use.json");
	const ctx = { cwd, hasUI: false, ui: { notify() {} }, sessionManager: { getBranch: () => [] } } as Parameters<
		typeof executeFind
	>[4];
	const find = async () => (await executeFind("t", {}, undefined, undefined, ctx)).details.windows;
	const observe = async (root: string) =>
		await executeObserve("t", { root, mode: "semantic" }, undefined, undefined, ctx);
	const calls = (wanted: string) => command.mock.calls.filter(([name]) => name === wanted).length;
	const looks = () => calls("look");
	const search = async (stateId: string) =>
		(await executeSearchUi("t", { stateId, text: "Body" }, undefined, undefined, ctx)).details.matches![0].ref;
	const readText = async (stateId: string, ref: string) =>
		await executeReadText("t", { stateId, ref }, undefined, undefined, ctx);
	return { state, userFile, find, observe, looks, calls, search, readText };
}

test("Linux blocks roots by executable basename, never by the accessible app name", async ({ onTestFinished }) => {
	const { state, userFile, find, observe, looks } = useLinuxRoots(onTestFinished, [
		linuxRoot(101, "keepassxc", "fixture-editor"),
		linuxRoot(102, "Editor", "KeePassXC"),
		linuxRoot(103, "Prompt", "pinentry-gnome3"),
		linuxRoot(104, "Anonymous"),
	]);
	const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected CDP discovery"));
	const byPid = async () =>
		Object.fromEntries(
			(await find()).map((root) => [root.pid, { blocked: root.blocked, unresolved: root.identityUnresolved }]),
		);

	expect(await byPid()).toEqual({
		101: { blocked: false, unresolved: undefined },
		102: { blocked: true, unresolved: undefined },
		103: { blocked: true, unresolved: undefined },
		104: { blocked: true, unresolved: true },
	});
	const windows = await find();
	const refOf = (pid: number) => {
		const root = windows.find((candidate) => candidate.pid === pid);
		if (!root) throw new Error(`no root for pid ${pid}`);
		return root.windowRef;
	};
	for (const pid of [102, 103]) {
		await expect(observe(refOf(pid))).rejects.toMatchObject({
			code: "app_blocked",
			message: expect.stringMatching(/is blocked/),
		});
	}
	await expect(observe(refOf(104))).rejects.toMatchObject({
		code: "app_blocked",
		message: expect.stringMatching(/identity could not be determined/),
	});
	expect(looks()).toBe(0);
	await observe(refOf(101));
	expect(looks()).toBe(1);

	// Renaming the accessible name changes nothing; the executable alone decides.
	state.roots = [linuxRoot(101, "Editor", "fixture-editor"), linuxRoot(102, "fixture-editor", "KeePassXC")];
	expect(await byPid()).toMatchObject({ 101: { blocked: false }, 102: { blocked: true } });

	// User entries match case-insensitively; the always-blocked agents survive an empty list.
	writeFileSync(userFile, JSON.stringify({ blocked_apps: ["FIXTURE-EDITOR"] }));
	state.roots = [linuxRoot(101, "Editor", "fixture-editor"), linuxRoot(102, "Editor", "KeePassXC")];
	expect(await byPid()).toMatchObject({ 101: { blocked: true }, 102: { blocked: false } });
	writeFileSync(userFile, JSON.stringify({ blocked_apps: [] }));
	state.roots = [linuxRoot(102, "Editor", "KeePassXC"), linuxRoot(103, "Prompt", "PINENTRY")];
	expect(await byPid()).toMatchObject({ 102: { blocked: false }, 103: { blocked: true } });
	expect(fetch).not.toHaveBeenCalled();
});

test("A saved Linux identity never stands in for a live lookup that failed", async ({ onTestFinished }) => {
	const admitted = linuxRoot(101, "Editor", "fixture-editor");
	const { state, find, observe, looks } = useLinuxRoots(onTestFinished, [admitted]);
	const [{ windowRef }] = await find();
	for (const [roots, message] of [
		// The same window, PID and title, but the helper can no longer attribute its executable.
		[[linuxRoot(101, "Editor")], /identity could not be determined/],
		// A WM_CLASS that only the live lookup reports is checked.
		[
			[linuxRoot(101, "Editor", "fixture-editor", { metadata: { wmClass: { instance: "x", class: "kitty" } } })],
			/\(kitty\)/,
		],
		// The live executable changed under the same PID (e.g. exec): the new identity is checked.
		[[linuxRoot(101, "Editor", "kitty")], /\(kitty\)/],
	] as const) {
		// Rediscover and admit the root, then change only what the next live lookup reports.
		state.roots = [admitted];
		await find();
		await observe(windowRef);
		const admittedLooks = looks();
		state.roots = [...roots];
		await expect(observe(windowRef), String(message)).rejects.toMatchObject({
			code: "app_blocked",
			message: expect.stringMatching(message),
		});
		expect(looks()).toBe(admittedLooks);
	}
});

test("The Linux backend reads appId only from the helper's executable field", async ({ onTestFinished }) => {
	onTestFinished(() => vi.restoreAllMocks());
	vi.spyOn(linuxHelper, "command").mockResolvedValue({
		roots: [
			{ pid: 1, appName: "Editor", appId: "fixture-editor", processName: "fixture-editor" },
			// A protocol 5 helper copied the accessible name into `processName`.
			{ pid: 2, appName: "Editor", processName: "keepassxc" },
		],
	});
	const roots = await linuxBackend.listRoots({});
	expect(roots.map(({ appName, appId }) => ({ appName, appId }))).toEqual([
		{ appName: "Editor", appId: "fixture-editor" },
		{ appName: "Editor", appId: undefined },
	]);
});

test("Linux WM_CLASS and an ambiguous exe link name can only add a block", async ({ onTestFinished }) => {
	const wmClass = (instance: string | null, cls: string) => ({ metadata: { wmClass: { instance, class: cls } } });
	const { userFile, find, observe, looks } = useLinuxRoots(onTestFinished, [
		linuxRoot(201, "Editor", "fixture-editor", wmClass("KeePassXC", "KeePassXC")),
		linuxRoot(202, "Editor", "fixture-editor", wmClass("fixture", "KEEPASSXC")),
		// WM_CLASS never unblocks an executable the policy blocks.
		linuxRoot(203, "Editor", "kitty", wmClass("fixture", "Fixture")),
		linuxRoot(204, "Editor", "fixture-editor"),
		linuxRoot(205, "Editor", "editor", { blockAliases: ["editor (deleted)"] }),
		// An alias never identifies a root.
		linuxRoot(206, "Editor", undefined, wmClass("fixture", "Fixture")),
	]);
	const byPid = async () =>
		Object.fromEntries(
			(await find()).map((root) => [root.pid, { blocked: root.blocked, unresolved: root.identityUnresolved }]),
		);
	expect(await byPid()).toEqual({
		201: { blocked: true, unresolved: undefined },
		202: { blocked: true, unresolved: undefined },
		203: { blocked: true, unresolved: undefined },
		204: { blocked: false, unresolved: undefined },
		205: { blocked: false, unresolved: undefined },
		206: { blocked: true, unresolved: true },
	});
	const windows = await find();
	const refOf = (pid: number) => windows.find((root) => root.pid === pid)!.windowRef;
	await expect(observe(refOf(201))).rejects.toMatchObject({
		code: "app_blocked",
		message: expect.stringMatching(/\(KeePassXC\)/),
	});
	expect(looks()).toBe(0);

	// The literal ` (deleted)` link name blocks; so does the stripped identity.
	writeFileSync(userFile, JSON.stringify({ blocked_apps: ["EDITOR (DELETED)"] }));
	expect(await byPid()).toMatchObject({ 204: { blocked: false }, 205: { blocked: true } });
	writeFileSync(userFile, JSON.stringify({ blocked_apps: ["editor"] }));
	expect(await byPid()).toMatchObject({ 204: { blocked: false }, 205: { blocked: true } });
	// The user list replaced the defaults: a WM_CLASS alias then has nothing to match.
	expect(await byPid()).toMatchObject({ 201: { blocked: false }, 202: { blocked: false }, 203: { blocked: false } });
});

test("Linux read_text revalidates the exact root that owns the look before every live read", async ({
	onTestFinished,
}) => {
	const editor = linuxRoot(101, "Editor", "fixture-editor");
	const { state, find, observe, calls, search, readText } = useLinuxRoots(onTestFinished, [editor]);
	const [{ windowRef }] = await find();
	const { stateId } = (await observe(windowRef)).details.capture;
	const ref = await search(stateId);
	expect((await readText(stateId, ref)).details.text).toBe("private body");
	expect(calls("atspiReadText")).toBe(1);

	for (const [roots, refusal] of [
		// Non-dumpable or otherwise unattributable now, same AT-SPI connection.
		[
			[linuxRoot(101, "Editor")],
			{ code: "app_blocked", message: expect.stringMatching(/identity could not be determined/) },
		],
		[[linuxRoot(101, "Editor", "kitty")], { code: "app_blocked", message: expect.stringMatching(/\(kitty\)/) }],
		[
			[linuxRoot(101, "Editor", "other-editor")],
			{ code: "app_blocked", message: expect.stringMatching(/Linux root owner identity changed/) },
		],
		[
			[linuxRoot(101, "Editor", "fixture-editor", { metadata: { wmClass: { instance: "x", class: "keepassxc" } } })],
			{ code: "app_blocked", message: expect.stringMatching(/\(keepassxc\)/) },
		],
		// A replacement window of the same PID and title is never the look's root.
		[
			[linuxRoot(101, "Editor", "fixture-editor", { metadata: { objectPath: "/replacement" } })],
			{ code: "root_stale", message: expect.stringMatching(/Saved Linux root is no longer available/) },
		],
		// The same AT-SPI identity under another owner PID is not the look's root either.
		[[{ ...editor, pid: 102 }], { code: "root_stale" }],
		[[], { code: "root_stale" }],
	] as const) {
		state.roots = [...roots];
		await expect(readText(stateId, ref), JSON.stringify(roots)).rejects.toMatchObject(refusal);
	}
	expect(calls("atspiReadText")).toBe(1);

	state.roots = [editor];
	expect((await readText(stateId, ref)).details.text).toBe("private body");
	expect(calls("atspiReadText")).toBe(2);
});

test("Linux read_text of one root survives observing another (#1300)", async ({ onTestFinished }) => {
	const editor = linuxRoot(101, "Editor", "fixture-editor", { windowId: 71 });
	const notes = linuxRoot(102, "Notes", "fixture-notes");
	const { state, find, observe, calls, search, readText } = useLinuxRoots(onTestFinished, [editor, notes]);
	const windows = await find();
	const refOf = (pid: number) => windows.find((root) => root.pid === pid)!.windowRef;
	const { stateId } = (await observe(refOf(101))).details.capture;
	const ref = await search(stateId);
	// B's PID-scoped listing drops A's `@w` handle; a later listing of A would issue a new one.
	await observe(refOf(102));
	const listed = calls("listRoots");
	expect((await readText(stateId, ref)).details.text).toBe("private body");
	// Bounded: the read never re-lists an inventory.
	expect(calls("listRoots")).toBe(listed);
	expect(calls("atspiLookRoot")).toBe(1);

	// The X11 pairing is not AT-SPI text identity: a re-paired window does not refuse the read.
	state.roots = [{ ...editor, windowId: 72 }, notes];
	expect((await readText(stateId, ref)).details.text).toBe("private body");
	expect(calls("atspiReadText")).toBe(2);
});

test("Linux read_text never reads an unfinished root lookup as absence", async ({ onTestFinished }) => {
	const { state, find, observe, calls, search, readText } = useLinuxRoots(onTestFinished, [
		linuxRoot(101, "Editor", "fixture-editor"),
	]);
	const [{ windowRef }] = await find();
	const { stateId } = (await observe(windowRef)).details.capture;
	const ref = await search(stateId);
	state.lookRootError = Object.assign(new Error("AT-SPI2 GetChildren timed out"), { code: "timeout" });
	await expect(readText(stateId, ref)).rejects.toMatchObject({
		code: "inventory_incomplete",
		message: expect.stringMatching(/could not be verified: AT-SPI2 GetChildren timed out\. It may still be open/),
	});
	state.lookRootError = Object.assign(new Error("Owning look is no longer available"), { code: "stale_look" });
	await expect(readText(stateId, ref)).rejects.toMatchObject({ code: "stale_look" });
	expect(calls("atspiReadText")).toBe(0);
});

test("Linux read_text preflight refuses a root whose latest discovery lost its identity", async ({
	onTestFinished,
}) => {
	const { state, find, observe, calls, search, readText } = useLinuxRoots(onTestFinished, [
		linuxRoot(101, "Editor", "fixture-editor"),
	]);
	const [{ windowRef }] = await find();
	const { stateId } = (await observe(windowRef)).details.capture;
	const ref = await search(stateId);
	state.roots = [linuxRoot(101, "Editor")];
	await find();
	const listed = calls("listRoots");
	await expect(readText(stateId, ref)).rejects.toMatchObject({
		code: "app_blocked",
		message: expect.stringMatching(/identity could not be determined/),
	});
	// Refused before the live lookup or any helper read.
	expect(calls("listRoots")).toBe(listed);
	expect(calls("atspiLookRoot")).toBe(0);
	expect(calls("atspiReadText")).toBe(0);
});

test("The Linux backend proves a look root absent only from an explicit null", async ({ onTestFinished }) => {
	onTestFinished(() => vi.restoreAllMocks());
	const command = vi.spyOn(linuxHelper, "command");
	command.mockResolvedValueOnce({ root: null });
	expect(await linuxBackend.lookRoot!("look_1")).toBeUndefined();
	expect(command).toHaveBeenLastCalledWith("atspiLookRoot", { lookId: "look_1" }, undefined);
	for (const reply of [{}, { root: "@w1" }, undefined]) {
		command.mockResolvedValueOnce(reply);
		await expect(linuxBackend.lookRoot!("look_1"), JSON.stringify(reply)).rejects.toThrow(
			"Linux helper atspiLookRoot reply has no root.",
		);
	}
	command.mockResolvedValueOnce({
		root: { pid: 7, appId: "editor", metadata: { wmClass: { instance: "editor", class: "Editor" } } },
	});
	expect(await linuxBackend.lookRoot!("look_1")).toMatchObject({
		pid: 7,
		appId: "editor",
		blockAliases: ["editor", "Editor"],
	});
});

test("The Linux backend collects block-only aliases from the helper and X11 WM_CLASS", async ({ onTestFinished }) => {
	onTestFinished(() => vi.restoreAllMocks());
	vi.spyOn(linuxHelper, "command").mockResolvedValue({
		roots: [
			{
				pid: 1,
				appId: "editor",
				blockAliases: ["editor (deleted)", 7, ""],
				metadata: { wmClass: { instance: "editor", class: "Editor" } },
			},
			{ pid: 2, appId: "editor", blockAliases: "editor (deleted)", metadata: { wmClass: null } },
			{ pid: 3, appId: "editor", metadata: { wmClass: { instance: "", class: "Editor" } } },
		],
	});
	const roots = await linuxBackend.listRoots({});
	expect(roots.map((root) => root.blockAliases)).toEqual([
		["editor (deleted)", "editor", "Editor"],
		undefined,
		["Editor"],
	]);
	expect("blockAliases" in roots[1]).toBe(false);
});
