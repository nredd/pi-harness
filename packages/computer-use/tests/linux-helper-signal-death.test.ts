// `LinuxHelperClient` signal deaths and session resets (nredd/pi-harness#1262): a helper killed by a signal refuses
// physical input only when that helper itself received a physical write, and concurrent resets overlap their bounded
// exit waits instead of stacking them. Fake children only; no helper binary or X server runs.
import { afterEach, expect, test, vi } from "vitest";
import { createFakeChild, createFakeSpawn, createHelperEngine, ok } from "../test/support/fake-helper.mjs";

type FakeChild = ReturnType<typeof createFakeChild> & { exitCode: number | null; signals: string[] };
type HelperModule = typeof import("../src/platform/linux/helper.ts");

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.doUnmock("node:child_process");
	vi.resetModules();
});

/** A fresh helper module whose every spawn yields a fake child answering `listRoots` and `act`. */
async function helperModule(): Promise<{ helper: HelperModule; children: FakeChild[] }> {
	const children: FakeChild[] = [];
	const engine = createHelperEngine({ profile: "envelope", protocolVersion: 5, platform: "Linux" });
	Object.assign(engine.handlers, { listRoots: ok([]), act: ok({ outcome: "worked" }) });
	const spawn = createFakeSpawn({
		"*": () => {
			const child = createFakeChild({ engine }) as FakeChild;
			children.push(child);
			return child;
		},
	});
	vi.resetModules();
	vi.doMock("node:child_process", async (original) => ({ ...(await original<object>()), spawn }));
	const helper = await import("../src/platform/linux/helper.ts");
	return { helper, children };
}

/** A client of `helper` whose install check always passes. */
function clientOf(helper: HelperModule): InstanceType<HelperModule["LinuxHelperClient"]> {
	const client = new helper.LinuxHelperClient({ helperPath: "/nonexistent/linux-bridge" });
	vi.spyOn(client, "ensureInstalled").mockResolvedValue(undefined);
	return client;
}

/** Emit `exit` the way Node reports a normal exit with `code`. */
function exitWithCode(child: FakeChild, code: number): void {
	child.exitCode = code;
	child.emit("exit", code, null);
}

/** Emit `exit` the way Node reports a death by `signal`. */
function killedBy(child: FakeChild, signal: string): void {
	child.emit("exit", null, signal);
}

test("an observe-only helper killed by a signal after an earlier helper took physical input leaves input allowed", async () => {
	const { helper, children } = await helperModule();
	const client = clientOf(helper);
	// Helper A takes physical input and exits through its own cleanup: its status is trusted.
	expect(await client.command("act", {})).toEqual({ outcome: "worked" });
	exitWithCode(children[0], 0);
	// Helper B only observes and then dies by a signal: it never posted input, so it cannot have left any held.
	expect(await client.command("listRoots")).toEqual([]);
	expect(children).toHaveLength(2);
	killedBy(children[1], "SIGKILL");
	expect(await client.command("act", {})).toEqual({ outcome: "worked" });
	expect(children).toHaveLength(3);
});

test("a helper killed by a signal after its own physical write stays refused, past later helpers", async () => {
	const { helper, children } = await helperModule();
	const client = clientOf(helper);
	// An observe-only helper first, so the refusal is pinned to the helper that took the write.
	expect(await client.command("listRoots")).toEqual([]);
	exitWithCode(children[0], 0);
	expect(await client.command("act", {})).toEqual({ outcome: "worked" });
	expect(await client.command("listRoots")).toEqual([]);
	killedBy(children[1], "SIGTERM");
	const refused = expect.objectContaining({
		code: "input_unsafe",
		message: expect.stringMatching(/killed after physical input; held keys\/buttons unknown/),
	});
	await expect(client.command("act", {})).rejects.toEqual(refused);
	// Observation respawns; a clean exit of that later helper does not lift the refusal.
	expect(await client.command("listRoots")).toEqual([]);
	exitWithCode(children[2], 0);
	await expect(client.command("focusWindow", {})).rejects.toEqual(refused);
	expect(children).toHaveLength(3);
});

test("a discarded helper that took physical input refuses when it dies by a signal after its successor started", async () => {
	const { helper, children } = await helperModule();
	const client = clientOf(helper);
	expect(await client.command("act", {})).toEqual({ outcome: "worked" });
	(client as unknown as { discardChild(error: Error): void }).discardChild(new Error("replaced"));
	// The observe-only successor is the live helper when the discarded one dies: the death is judged on its own writes.
	expect(await client.command("listRoots")).toEqual([]);
	expect(children).toHaveLength(2);
	killedBy(children[0], "SIGKILL");
	await expect(client.command("act", {})).rejects.toThrow(/killed after physical input/);
});

test("concurrent resets overlap their bounded exit waits instead of stacking them", async () => {
	const { helper, children } = await helperModule();
	vi.spyOn(helper.linuxHelper, "ensureInstalled").mockResolvedValue(undefined);
	await helper.linuxHelper.command("listRoots");
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	const first = helper.resetLinuxHelper();
	const fresh = helper.linuxHelper;
	vi.spyOn(fresh, "ensureInstalled").mockResolvedValue(undefined);
	await fresh.command("listRoots");
	const second = helper.resetLinuxHelper();
	expect(children).toHaveLength(2);
	expect(children.map((child) => child.signals[0])).toEqual(["SIGTERM", "SIGTERM"]);
	const settled: string[] = [];
	void first.then(() => settled.push("first"));
	void second.then(() => settled.push("second"));
	// Neither helper ever exits: both waits run out together, one `DISCARDED_EXIT_WAIT_MS` after the resets began.
	await vi.advanceTimersByTimeAsync(helper.DISCARDED_EXIT_WAIT_MS);
	expect(settled).toEqual(["first", "second"]);
	expect(await first).toMatch(/did not exit within/);
	expect(await second).toMatch(/did not exit within/);
	expect(children.map((child) => child.signals)).toEqual([
		["SIGTERM", "SIGKILL"],
		["SIGTERM", "SIGKILL"],
	]);
});
