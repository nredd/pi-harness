import { makeTestTempDir } from "@nredd/pi-test-lib/temp-dir";
import { expect, test, vi } from "vitest";
import {
	executeAct,
	executeFind,
	executeObserve,
	executeReadText,
	executeSearchUi,
	executeWaitFor,
} from "../src/bridge.ts";
import { currentPlatformBackend, platformBackendForRuntime } from "../src/platform/index.ts";
import { windowsHelper } from "../src/platform/windows/helper.ts";

const root = {
	kind: "window",
	rootRef: "native-notes",
	windowId: 232,
	pid: 101,
	title: "Notes",
	appName: "Notes",
	processName: "notes.exe",
	isFocused: true,
};
const stale = Object.assign(new Error("Wait target no longer belongs to its admitted PID"), { code: "root_stale" });

test("Windows live observation commands carry the admitted PID and HWND", async ({ onTestFinished }) => {
	const original = { ...currentPlatformBackend };
	const cwd = makeTestTempDir("cu-observation-owner-", onTestFinished);
	onTestFinished(() => {
		Object.assign(currentPlatformBackend, original);
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});
	vi.stubEnv("PI_CODING_AGENT_DIR", cwd);
	vi.stubEnv("PI_COMPUTER_USE_BLOCKED_APPS", undefined);
	vi.stubEnv("PI_COMPUTER_USE_CDP_PORT", undefined);
	Object.assign(currentPlatformBackend, platformBackendForRuntime("win32"), {
		ensureReady: async (_ctx: unknown, state: unknown) => state,
	});
	let ownerPresent = true;
	const command = vi.spyOn(windowsHelper, "command").mockImplementation(async (name, args) => {
		switch (name) {
			case "listRoots":
				return { roots: ownerPresent ? [root] : [] };
			case "look":
				return {
					lookId: "notes-look",
					window: { rootRef: root.rootRef, framePoints: { x: 0, y: 0, w: 100, h: 100 }, scaleFactor: 1 },
					outline: {
						ref: "native-window",
						role: "window",
						title: "Notes",
						children: [{ ref: "native-save", role: "button", title: "Save", actions: ["press"] }],
					},
					readText: { requested: false, executed: false },
				};
			case "uiaReadText":
				return { text: "Save", offset: 0, limit: 4, totalChars: 4, hasMore: false };
			case "act":
				return { outcome: "worked", method: "uia" };
			case "uiaWaitFor":
				if (args?.gone) ownerPresent = false;
				throw stale;
			default:
				throw new Error(`Unexpected helper command ${name}`);
		}
	});
	const ctx = { cwd, hasUI: false, ui: { notify() {} }, sessionManager: { getBranch: () => [] } } as Parameters<
		typeof executeFind
	>[4];
	const found = await executeFind("t", {}, undefined, undefined, ctx);
	const observed = await executeObserve(
		"t",
		{ root: found.details.windows[0].windowRef, mode: "semantic" },
		undefined,
		undefined,
		ctx,
	);
	const stateId = observed.details.capture.stateId;
	const search = await executeSearchUi("t", { stateId, text: "Save" }, undefined, undefined, ctx);
	const ref = search.details.matches[0].ref;
	await executeReadText("t", { stateId, ref }, undefined, undefined, ctx);
	const bound = { lookId: "notes-look", pid: root.pid, windowId: root.windowId };
	expect(command.mock.calls.find(([name]) => name === "uiaReadText")?.[1]).toMatchObject({
		...bound,
		elementRef: "native-save",
	});
	await expect(executeWaitFor("t", { stateId, text: "Save" }, undefined, undefined, ctx)).rejects.toMatchObject({
		code: "root_stale",
	});
	expect(command.mock.calls.find(([name]) => name === "uiaWaitFor")?.[1]).toMatchObject(bound);

	vi.useFakeTimers();
	onTestFinished(() => vi.useRealTimers());
	const acting = executeAct(
		"t",
		{ stateId, actions: [{ action: "press", ref }], expect: { text: "Save", until: "absent" } },
		undefined,
		undefined,
		ctx,
	);
	const [result] = await Promise.all([acting, vi.runAllTimersAsync()]);
	expect(result.details).toMatchObject({ status: "target_closed", error: { code: "root_stale" } });
	const waits = command.mock.calls.filter(([name]) => name === "uiaWaitFor");
	expect(waits).toHaveLength(2);
	expect(waits[1][1]).toMatchObject({ ...bound, gone: true });
	expect(result.details).toHaveProperty("execution");
	expect(result.details).not.toHaveProperty("execution.verification");
});

test("A Windows root ref denotes one window instance, never a same-HWND replacement", async ({ onTestFinished }) => {
	const original = { ...currentPlatformBackend };
	const cwd = makeTestTempDir("cu-observation-instance-", onTestFinished);
	onTestFinished(() => {
		Object.assign(currentPlatformBackend, original);
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});
	vi.stubEnv("PI_CODING_AGENT_DIR", cwd);
	vi.stubEnv("PI_COMPUTER_USE_BLOCKED_APPS", undefined);
	vi.stubEnv("PI_COMPUTER_USE_CDP_PORT", undefined);
	Object.assign(currentPlatformBackend, platformBackendForRuntime("win32"), {
		ensureReady: async (_ctx: unknown, state: unknown) => state,
	});
	// The helper issues a new native ref when a window reusing the HWND and PID replaces the original.
	let listed: Record<string, unknown> = { ...root, rootRef: "@w1" };
	const command = vi.spyOn(windowsHelper, "command").mockImplementation(async (name, args) => {
		switch (name) {
			case "listRoots":
				return { roots: [listed] };
			case "look":
				return {
					lookId: `look-${String(args?.rootRef)}`,
					window: { rootRef: args?.rootRef, framePoints: { x: 0, y: 0, w: 100, h: 100 }, scaleFactor: 1 },
					outline: { ref: "native-window", role: "window", title: "Notes", children: [] },
					readText: { requested: false, executed: false },
				};
			default:
				throw new Error(`Unexpected helper command ${name}`);
		}
	});
	const ctx = { cwd, hasUI: false, ui: { notify() {} }, sessionManager: { getBranch: () => [] } } as Parameters<
		typeof executeFind
	>[4];
	const observe = async (rootRef: string) =>
		await executeObserve("t", { root: rootRef, mode: "semantic" }, undefined, undefined, ctx);
	const originalRef = (await executeFind("t", {}, undefined, undefined, ctx)).details.windows[0].windowRef;
	await observe(originalRef);

	listed = { ...root, rootRef: "@w2" };
	await expect(observe(originalRef)).rejects.toMatchObject({
		code: "root_stale",
		message: expect.stringContaining("original owner and window instance"),
	});
	const looks = () => command.mock.calls.filter(([name]) => name === "look").map(([, args]) => args?.rootRef);
	expect(looks()).toEqual(["@w1"]);

	const replacement = (await executeFind("t", {}, undefined, undefined, ctx)).details.windows[0];
	expect(replacement.windowRef).not.toBe(originalRef);
	expect(replacement.nativeWindowRef).toBe("@w2");
	await observe(replacement.windowRef);
	expect(looks()).toEqual(["@w1", "@w2"]);
	// Rediscovery never revives the old ref onto the replacement.
	await expect(observe(originalRef)).rejects.toMatchObject({ code: "root_stale" });

	// A root the helper could not bind is listed as unbound and refused, distinctly from a stale one.
	listed = { ...root, rootRef: "@w3", instanceUnavailable: true };
	const unbound = await executeFind("t", {}, undefined, undefined, ctx);
	expect(unbound.details.windows[0]).toMatchObject({ nativeWindowRef: "@w3", instanceUnavailable: true });
	expect(JSON.stringify(unbound.content)).toContain("unbound");
	await expect(observe(unbound.details.windows[0].windowRef)).rejects.toMatchObject({
		code: "root_stale",
		message: expect.stringContaining("could not be admitted"),
	});
	expect(looks()).toEqual(["@w1", "@w2"]);
});
