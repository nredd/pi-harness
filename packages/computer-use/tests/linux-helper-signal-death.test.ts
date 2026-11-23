// `LinuxHelperClient` signal deaths and session resets (nredd/pi-harness#1262): a helper killed by a signal refuses
// physical input only when that helper itself received a physical write, and concurrent resets overlap their bounded
// exit waits instead of stacking them. Fake children only; no helper binary or X server runs.
import { afterEach, expect, test, vi } from "vitest";
import { effect, ok, silent } from "../test/support/fake-helper.mjs";
import { linuxHelperClient } from "./fixtures/linux-helper.mjs";

type Fixture = Awaited<ReturnType<typeof linuxHelperClient>>;
type FakeChild = Fixture["children"][number];

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.doUnmock("node:child_process");
	vi.resetModules();
});

/** A client whose every helper answers `listRoots` and `act`, and never answers `actBatch`; `received` logs commands. */
async function fixture(): Promise<Fixture & { received: string[] }> {
	const received: string[] = [];
	const log = (cmd: string, reply: ReturnType<typeof ok>) => effect(() => received.push(cmd), reply);
	const loaded = await linuxHelperClient(() => ({
		listRoots: log("listRoots", ok([])),
		act: log("act", ok({ outcome: "worked" })),
		actBatch: log("actBatch", silent()),
	}));
	return { ...loaded, received };
}

const refused = expect.objectContaining({
	code: "input_unsafe",
	message: expect.stringMatching(/killed after physical input; held keys\/buttons unknown/),
});

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
	const { client, children } = await fixture();
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
	const { client, children } = await fixture();
	// An observe-only helper first, so the refusal is pinned to the helper that took the write.
	expect(await client.command("listRoots")).toEqual([]);
	exitWithCode(children[0], 0);
	expect(await client.command("act", {})).toEqual({ outcome: "worked" });
	expect(await client.command("listRoots")).toEqual([]);
	killedBy(children[1], "SIGTERM");
	await expect(client.command("act", {})).rejects.toEqual(refused);
	// Observation respawns; a clean exit of that later helper does not lift the refusal.
	expect(await client.command("listRoots")).toEqual([]);
	exitWithCode(children[2], 0);
	await expect(client.command("focusWindow", {})).rejects.toEqual(refused);
	expect(children).toHaveLength(3);
});

test("a discarded helper that took physical input refuses when it dies by a signal after its successor started", async () => {
	const { client, children } = await fixture();
	expect(await client.command("act", {})).toEqual({ outcome: "worked" });
	// A failed stdin write discards the live helper, which is then killed and replaced on the next command.
	children[0].stdin.emit("error", new Error("EPIPE"));
	// The observe-only successor is the live helper when the discarded one dies: the death is judged on its own writes.
	expect(await client.command("listRoots")).toEqual([]);
	expect(children).toHaveLength(2);
	killedBy(children[0], "SIGKILL");
	await expect(client.command("act", {})).rejects.toThrow(/killed after physical input/);
});

test("concurrent resets overlap their bounded exit waits instead of stacking them", async () => {
	const { helper, children } = await fixture();
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

test("a physical batch still awaiting its reply when its helper dies by a signal refuses, and its reply is lost", async () => {
	const { client, children, received } = await fixture();
	const batch = client.command("actBatch", { actions: [{ policy: "ax_only" }, { kind: "click" }] });
	// The write is out and the helper never answers: delivery is unknown from the moment the write was attempted.
	await vi.waitFor(() => expect(received).toEqual(["actBatch"]));
	killedBy(children[0], "SIGKILL");
	await expect(client.command("act", {})).rejects.toEqual(refused);
	children[0].emit("close", null, "SIGKILL");
	await expect(batch).rejects.toMatchObject({ code: "reply_lost", message: "Linux helper exited on SIGKILL." });
	expect(children).toHaveLength(1);
});

test("a physical request that cannot be serialized is never written, so its helper's signal death leaves input allowed", async () => {
	const { client, children, received } = await fixture();
	expect(await client.command("listRoots")).toEqual([]);
	const circular: Record<string, unknown> = {};
	circular.self = circular;
	await expect(client.command("act", circular)).rejects.toThrow(TypeError);
	killedBy(children[0], "SIGKILL");
	expect(await client.command("act", {})).toEqual({ outcome: "worked" });
	expect(received).toEqual(["listRoots", "act"]);
	expect(children).toHaveLength(2);
});
