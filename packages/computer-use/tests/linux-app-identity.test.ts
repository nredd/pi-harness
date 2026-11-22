import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeTestTempDir } from "@nredd/pi-test-lib/temp-dir";
import { expect, test, vi } from "vitest";
import { executeFind, executeObserve } from "../src/bridge.ts";
import { currentPlatformBackend, platformBackendForRuntime } from "../src/platform/index.ts";
import { linuxBackend } from "../src/platform/linux/backend.ts";
import { linuxHelper } from "../src/platform/linux/helper.ts";

type Root = Record<string, unknown> & { pid: number; rootRef: string };

/** A Linux helper root: `appName` is the app-supplied AT-SPI name, `appId` the executable basename. */
function linuxRoot(pid: number, appName: string, appId?: string): Root {
	return {
		kind: "window",
		rootRef: `@w${pid}`,
		pid,
		title: `${appName} window`,
		appName,
		processName: appId ?? null,
		appId: appId ?? null,
		isFocused: pid === 101,
	};
}

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
	const state = { roots: initial };
	const command = vi.spyOn(linuxHelper, "command").mockImplementation(async (name, args) => {
		switch (name) {
			case "listRoots": {
				const pid = (args as { pid?: number } | undefined)?.pid;
				return { roots: pid ? state.roots.filter((root) => root.pid === pid) : state.roots };
			}
			case "look":
				return {
					lookId: `look-${String(args?.rootRef)}`,
					window: { rootRef: args?.rootRef, framePoints: { x: 0, y: 0, w: 100, h: 100 }, scaleFactor: 1 },
					outline: { ref: "native-window", role: "frame", title: "Window", truncated: false, children: [] },
					readText: { requested: false, executed: false },
				};
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
	const looks = () => command.mock.calls.filter(([name]) => name === "look").length;
	return { state, userFile, find, observe, looks };
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
		await expect(observe(refOf(pid))).rejects.toMatchObject({ code: "app_blocked", message: /is blocked/ });
	}
	await expect(observe(refOf(104))).rejects.toMatchObject({
		code: "app_blocked",
		message: /identity could not be determined/,
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
	const { state, find, observe, looks } = useLinuxRoots(onTestFinished, [linuxRoot(101, "Editor", "fixture-editor")]);
	const [{ windowRef }] = await find();
	await observe(windowRef);
	expect(looks()).toBe(1);

	// The same window, PID and title, but the helper can no longer attribute its executable.
	state.roots = [linuxRoot(101, "Editor")];
	await expect(observe(windowRef)).rejects.toMatchObject({
		code: "app_blocked",
		message: /identity could not be determined/,
	});
	// The live executable changed under the same PID (e.g. exec): the new identity is checked.
	state.roots = [linuxRoot(101, "Editor", "kitty")];
	await expect(observe(windowRef)).rejects.toMatchObject({ code: "app_blocked", message: /\(kitty\)/ });
	expect(looks()).toBe(1);
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
