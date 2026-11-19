import type { ChildProcess } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { FakeClock } from "@nredd/pi-test-lib/clock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MonitorError, MonitorManager } from "../../src/monitor/manager.ts";
import { MATCH_TIMEOUT_MS } from "../../src/monitor/matcher.ts";
import { type SpawnOptions, spawnMonitor } from "../../src/monitor/process.ts";
import type { MonitorMessage } from "../../src/monitor/types.ts";
import { alive, tempDir, waitFor } from "../fixtures/monitor/helpers.ts";
import { STAY, STAY_SH } from "../fixtures/monitor/stay.ts";

let tmp: ReturnType<typeof tempDir>;
let sent: MonitorMessage[];
let mgr: MonitorManager;

const node = (code: string) => ["node", "-e", code];
/** A group leader with an in-group descendant (its pid is the first output line) that outlives only while this worker does. */
const WITH_DESCENDANT = ["sh", "-c", `(${STAY_SH}) & echo $!; wait`];

function make(): MonitorManager {
	return new MonitorManager({
		sessionId: "sess-1",
		root: tmp.dir,
		coalesceMs: 80,
		killGraceMs: 300,
		send: (m) => sent.push(m),
	});
}

const matchReplies = vi.hoisted(() => ({
	suppress: false,
	onSuppressed: undefined as ((child: ChildProcess) => void) | undefined,
}));
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		spawn: (...args: Parameters<typeof actual.spawn>) => {
			const child = actual.spawn(...args);
			if (Array.isArray(args[2]?.stdio) && args[2].stdio.includes("ipc")) {
				const emit = child.emit.bind(child);
				child.emit = (event: string | symbol, ...values: unknown[]) => {
					// Suppress only match replies, not the readiness handshake or exit/close events.
					if (matchReplies.suppress && event === "message" && typeof values[0] === "boolean") {
						matchReplies.onSuppressed?.(child);
						return true;
					}
					return emit(event, ...values);
				};
			}
			return child;
		},
	};
});

it("lets the parent advance two turns while a pathological match is pending", async () => {
	const turnTmp = tempDir();
	const turnMessages: MonitorMessage[] = [];
	const clock = new FakeClock();
	const coalesceMs = 80;
	let onStdout: SpawnOptions["onStdout"] | undefined;
	const mgr = new MonitorManager({
		sessionId: "sess-1",
		root: turnTmp.dir,
		coalesceMs,
		killGraceMs: 300,
		clock,
		send: (m) => turnMessages.push(m),
		spawnMonitor: (argv, options) => {
			onStdout = options.onStdout;
			return spawnMonitor(argv, options);
		},
	});
	try {
		const info = await mgr.start({ argv: node(STAY), name: "bad", match: "^(a+)+$|^a+!$" }, turnTmp.dir);
		if (!onStdout) throw new Error("Monitor did not register a stdout handler");
		// Warm up the matcher so the pathological line is dispatched, not waiting for worker startup.
		await onStdout(Buffer.from("ready\n"));
		clock.advance(coalesceMs);
		// Hold replies and deadlines so host scheduling cannot shorten the observation window.
		matchReplies.suppress = true;
		const ingested = onStdout(Buffer.from(`${"a".repeat(26)}!\n`));
		let pendingTurns = 0;
		for (let turn = 0; turn < 2; turn++) {
			await setImmediate();
			// The second regex alternative makes an inline or deferred parent-side match count immediately.
			const state = mgr.info(info.id);
			if (state?.lines === 2 && state.matches === 0) pendingTurns++;
		}
		// This checks turn ordering, not turn duration: a synchronous delay without a match update can pass.
		expect(pendingTurns).toBe(2);
		// Expire the withheld reply and deliver the conservative wake using the virtual clock.
		clock.advance(MATCH_TIMEOUT_MS + coalesceMs);
		await ingested;
		expect(turnMessages[0]).toMatchObject({ wake: true, details: { matched: [2] } });
		await mgr.dispose();
		expect(alive(info.pid)).toBe(false);
	} finally {
		matchReplies.suppress = false;
		await mgr.dispose();
		turnTmp.cleanup();
	}
}, 15_000);

it("disposes with a match reply still withheld and reaps both children", async ({ onTestFinished }) => {
	const disposeTmp = tempDir();
	const clock = new FakeClock();
	const manager = new MonitorManager({ sessionId: "sess-1", root: disposeTmp.dir, clock, send: () => {} });
	let disposal: Promise<void> | undefined;
	onTestFinished(async () => {
		matchReplies.suppress = false;
		matchReplies.onSuppressed = undefined;
		// Let the match deadline unblock cleanup if the test timed out waiting for disposal.
		clock.advance(MATCH_TIMEOUT_MS);
		try {
			await (disposal ?? manager.dispose());
		} finally {
			disposeTmp.cleanup();
		}
	});

	matchReplies.suppress = true;
	const withheld = new Promise<ChildProcess>((resolve) => {
		matchReplies.onSuppressed = resolve;
	});
	const info = await manager.start(
		{ argv: node(`console.log("a".repeat(4095) + "!");${STAY}`), name: "busy", match: "^a+!$" },
		disposeTmp.dir,
	);
	const matcher = await withheld;
	if (!matcher.pid) throw new Error("Expected a real matcher child");
	expect(alive(matcher.pid)).toBe(true);
	expect(manager.info(info.id)).toMatchObject({ lines: 1, matches: 0 });
	// Neither reply delivery nor virtual deadlines can finish the pending match for dispose.
	disposal = manager.dispose();
	await disposal;
	expect(alive(info.pid)).toBe(false);
	expect(alive(matcher.pid)).toBe(false);
}, 15_000);

describe("MonitorManager", () => {
	beforeEach(() => {
		tmp = tempDir();
		sent = [];
		mgr = make();
	});
	afterEach(async () => {
		await mgr.dispose();
		tmp.cleanup();
	});
	it("keeps passive output only in the readable ring buffer", async () => {
		const info = await mgr.start({ argv: node(`console.log("one");console.log("two");${STAY}`), name: "w" }, tmp.dir);
		await waitFor(() => (mgr.read(info.id)?.lines.length ?? 0) === 2);
		expect(sent).toEqual([]);
		const read = mgr.read(info.id, 1);
		expect(read?.lines).toEqual([{ n: 2, text: "two" }]);
		expect(read?.lastLine).toBe(2);
		expect(mgr.read("w")?.info.id).toBe(info.id);
		expect(mgr.read("nope")).toBeUndefined();
	});

	it("counts matched lines for the widget without emitting anything for passive ones", async () => {
		const info = await mgr.start(
			{
				argv: node(`console.log("ok");console.log("ERROR x");console.log("ERROR y");${STAY}`),
				name: "m",
				match: "^ERROR",
			},
			tmp.dir,
		);
		await waitFor(() => (mgr.info(info.id)?.matches ?? 0) === 2);
		expect(mgr.info(info.id)?.lines).toBe(3);
		const quiet = await mgr.start({ argv: node(`console.log("a");${STAY}`), name: "q" }, tmp.dir);
		await waitFor(() => (mgr.info(quiet.id)?.lines ?? 0) === 1);
		expect(mgr.info(quiet.id)?.matches).toBe(0);
	});

	it("merges stdout and stderr", async () => {
		const info = await mgr.start({ argv: node(`console.error("e");console.log("o");${STAY}`), name: "w" }, tmp.dir);
		await waitFor(() => (mgr.read(info.id)?.lines.length ?? 0) === 2);
		expect(
			mgr
				.read(info.id)
				?.lines.map((l) => l.text)
				.sort(),
		).toEqual(["e", "o"]);
	});

	it("wakes on a match, only for the batch that contains it", async () => {
		await mgr.start(
			{
				argv: node(`console.log("fine");setTimeout(()=>console.log("ERROR bad"),400);${STAY}`),
				name: "w",
				match: "^ERROR",
			},
			tmp.dir,
		);
		await waitFor(() => sent.length === 1, 4000);
		expect(sent[0]?.wake).toBe(true);
		expect(sent[0]?.details.matched).toEqual([2]);
	});

	it("wakes on every batch with wake: true", async () => {
		await mgr.start({ argv: node(`console.log("x");${STAY}`), name: "w", wake: true }, tmp.dir);
		await waitFor(() => sent.length === 1);
		expect(sent[0]?.wake).toBe(true);
	});

	it("wakes on exit with the exit code, in one message with the last output", async () => {
		const info = await mgr.start({ argv: node(`console.log("bye");process.exit(3)`), name: "w" }, tmp.dir);
		await waitFor(() => mgr.info(info.id)?.status === "exited");
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({ wake: true });
		expect(sent[0]?.text).not.toContain("1: bye");
		expect(sent[0]?.text).toContain("exited with code 3");
		expect(sent[0]?.text).toContain('monitor_read {"id":"m1","since":0}');
		expect(mgr.info(info.id)).toMatchObject({ exitCode: 3 });
		expect(mgr.running()).toHaveLength(0);
	});

	it("drains matches in order before delivering final unterminated output", async () => {
		const info = await mgr.start(
			{ argv: node('process.stdout.write("fine\\nERROR bad")'), name: "final", match: "^ERROR" },
			tmp.dir,
		);
		await waitFor(() => mgr.info(info.id)?.status === "exited");
		expect(sent).toHaveLength(1);
		expect(sent[0]?.details.matched).toEqual([2]);
		expect(sent[0]?.text).toContain("2: ERROR bad");
		expect(sent[0]?.text).not.toContain("1: fine");
	});

	it("reports a death by signal", async () => {
		const info = await mgr.start({ argv: node(`process.kill(process.pid,"SIGKILL")`), name: "w" }, tmp.dir);
		await waitFor(() => mgr.info(info.id)?.status === "exited");
		expect(sent[0]?.text).toContain("died from SIGKILL");
	});

	it("stop kills the whole process group quietly and removes the pidfile", async () => {
		const info = await mgr.start({ argv: WITH_DESCENDANT, name: "w" }, tmp.dir);
		await waitFor(() => (mgr.read(info.id)?.lines.length ?? 0) === 1);
		const grandchild = Number(mgr.read(info.id)?.lines[0]?.text);
		expect(alive(grandchild)).toBe(true);
		sent.length = 0;
		const stopped = await mgr.stop(info.id);
		expect(stopped?.status).toBe("stopped");
		await waitFor(() => !alive(grandchild));
		expect(alive(info.pid)).toBe(false);
		expect(sent.filter((m) => m.wake)).toEqual([]);
		expect(existsSync(join(tmp.dir, "sess-1", `${info.id}.json`))).toBe(false);
		expect(await mgr.stop("ghost")).toBeUndefined();
	});

	it("escalates to SIGKILL when SIGTERM is ignored", async () => {
		const info = await mgr.start(
			{ argv: node(`process.on("SIGTERM",()=>{});console.log("up");${STAY}`), name: "w" },
			tmp.dir,
		);
		await waitFor(() => (mgr.read(info.id)?.lines.length ?? 0) === 1);
		const started = Date.now();
		await mgr.stop(info.id);
		expect(Date.now() - started).toBeGreaterThanOrEqual(250);
		expect(alive(info.pid)).toBe(false);
	});

	it("kills on timeout and wakes", async () => {
		const info = await mgr.start({ argv: node(STAY), name: "w", timeout_s: 1 }, tmp.dir);
		await waitFor(() => mgr.info(info.id)?.status === "timeout", 5000);
		expect(sent.at(-1)).toMatchObject({ wake: true });
		expect(sent.at(-1)?.text).toContain("timed out");
		expect(alive(info.pid)).toBe(false);
	});

	it("enforces unique live names, the cap, and parallel starts", async () => {
		const results = await Promise.allSettled(
			Array.from({ length: 7 }, (_, i) => mgr.start({ argv: node(STAY), name: `m-${i}` }, tmp.dir)),
		);
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
		await expect(mgr.start({ argv: node(STAY), name: "m-99" }, tmp.dir)).rejects.toThrow(/at most 5/);
		await mgr.stopAll();
		const [a, b] = await Promise.allSettled([
			mgr.start({ argv: node(STAY), name: "same" }, tmp.dir),
			mgr.start({ argv: node(STAY), name: "same" }, tmp.dir),
		]);
		expect([a.status, b.status].sort()).toEqual(["fulfilled", "rejected"]);
	});

	it("rejects an unstartable command without registering anything", async () => {
		await expect(mgr.start({ argv: ["/definitely/not/a/binary"], name: "w" }, tmp.dir)).rejects.toBeInstanceOf(
			MonitorError,
		);
		await expect(mgr.start({ argv: [""], name: "w" }, tmp.dir)).rejects.toThrow(/argv\[0\]/);
		expect(mgr.list()).toEqual([]);
		expect(existsSync(join(tmp.dir, `sess-1.${process.pid}`))).toBe(false);
	});

	it("writes a pidfile per monitor with the recorded shape", async () => {
		const info = await mgr.start({ argv: node(STAY), name: "w" }, tmp.dir);
		const file = join(tmp.dir, `sess-1.${process.pid}`, `${info.id}.json`);
		const rec = JSON.parse((await import("node:fs")).readFileSync(file, "utf8"));
		expect(rec).toMatchObject({ ownerPid: process.pid, childPid: info.pid, pgid: info.pid, name: "w" });
		expect(typeof rec.startedAt).toBe("number");
	});

	it("dispose kills every child and group silently and cleans the session dir", async () => {
		const a = await mgr.start({ argv: WITH_DESCENDANT, name: "a" }, tmp.dir);
		const b = await mgr.start({ argv: node(STAY), name: "b" }, tmp.dir);
		await waitFor(() => (mgr.read(a.id)?.lines.length ?? 0) === 1);
		const grandchild = Number(mgr.read(a.id)?.lines[0]?.text);
		sent.length = 0;
		await mgr.dispose();
		expect(alive(a.pid)).toBe(false);
		expect(alive(b.pid)).toBe(false);
		// `dispose` awaits the leaders, not PID 1 reaping their orphaned descendants.
		// Like `stop` above, observe group cleanup rather than assuming signal delivery is synchronous.
		await waitFor(() => !alive(grandchild));
		expect(sent).toEqual([]);
		expect(existsSync(join(tmp.dir, `sess-1.${process.pid}`))).toBe(false);
		await expect(mgr.start({ argv: node(STAY), name: "c" }, tmp.dir)).rejects.toThrow(/shutting down/);
		await mgr.dispose();
	});

	it("keeps the last 2000 lines with monotonic numbers", async () => {
		const info = await mgr.start({ argv: node(`for(let i=1;i<=2500;i++)console.log(i);${STAY}`), name: "w" }, tmp.dir);
		await waitFor(() => (mgr.info(info.id)?.lines ?? 0) === 2500);
		const all = mgr.read(info.id);
		expect(all?.lines).toHaveLength(2000);
		expect(all?.lines[0]).toEqual({ n: 501, text: "501" });
		expect(all?.missed).toBe(500);
		expect(readdirSync(join(tmp.dir, `sess-1.${process.pid}`))).toEqual([`${info.id}.json`]);
	});

	it("keeps another session's directory untouched", async () => {
		const other = new MonitorManager({ sessionId: "sess-2", root: tmp.dir, send: () => {} });
		try {
			const o = await other.start({ argv: node(STAY), name: "o" }, tmp.dir);
			await mgr.start({ argv: node(STAY), name: "w" }, tmp.dir);
			await mgr.dispose();
			expect(alive(o.pid)).toBe(true);
			expect(existsSync(join(tmp.dir, `sess-2.${process.pid}`, `${o.id}.json`))).toBe(true);
		} finally {
			await other.dispose();
		}
	});

	it("forgets the oldest finished monitors beyond the retained ten", async () => {
		const ids: string[] = [];
		for (let i = 0; i < 11; i++) {
			const info = await mgr.start({ argv: node(`console.log("done ${i}")`), name: `f${i}` }, tmp.dir);
			ids.push(info.id);
			await waitFor(() => mgr.info(info.id)?.status !== "running");
		}
		expect(mgr.info(ids[0] as string)).toBeDefined();
		// pruning runs on the next start
		const live = await mgr.start({ argv: node(STAY), name: "live" }, tmp.dir);
		expect(mgr.info(ids[0] as string)).toBeUndefined();
		expect(mgr.list().map((m) => m.id)).toEqual([...ids.slice(1), live.id]);
	});
});
