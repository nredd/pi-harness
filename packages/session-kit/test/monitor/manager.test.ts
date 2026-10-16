import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MonitorError, MonitorManager } from "../../src/monitor/manager.ts";
import type { MonitorMessage } from "../../src/monitor/types.ts";
import { alive, tempDir, waitFor } from "./helpers.ts";

let tmp: ReturnType<typeof tempDir>;
let sent: MonitorMessage[];
let mgr: MonitorManager;

const node = (code: string) => ["node", "-e", code];
const STAY = "setInterval(() => {}, 1000);";

function make(coalesceMs = 80, killGraceMs = 300): MonitorManager {
	return new MonitorManager({
		sessionId: "sess-1",
		root: tmp.dir,
		coalesceMs,
		killGraceMs,
		send: (m) => sent.push(m),
	});
}

beforeEach(() => {
	tmp = tempDir();
	sent = [];
	mgr = make();
});
afterEach(async () => {
	await mgr.dispose();
	tmp.cleanup();
});

describe("MonitorManager", () => {
	it("coalesces output into one passive message and keeps it readable", async () => {
		const info = await mgr.start({ argv: node(`console.log("one");console.log("two");${STAY}`), name: "w" }, tmp.dir);
		await waitFor(() => sent.length === 1);
		expect(sent[0]).toMatchObject({ wake: false });
		expect(sent[0]?.text).toContain("1: one\n2: two");
		const read = mgr.read(info.id, 1);
		expect(read?.lines).toEqual([{ n: 2, text: "two" }]);
		expect(read?.lastLine).toBe(2);
		expect(mgr.read("w")?.info.id).toBe(info.id);
		expect(mgr.read("nope")).toBeUndefined();
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
		await waitFor(() => sent.length === 2, 4000);
		expect(sent.map((m) => m.wake)).toEqual([false, true]);
		expect(sent[1]?.details.matched).toEqual([2]);
	});

	it("keeps the event loop and shutdown responsive during pathological matching", async () => {
		const info = await mgr.start(
			{ argv: node(`setTimeout(() => console.log("a".repeat(26) + "!"), 100);${STAY}`), name: "bad", match: "^(a+)+$" },
			tmp.dir,
		);
		let maxDelay = 0;
		let last = Date.now();
		const heartbeat = setInterval(() => {
			const now = Date.now();
			maxDelay = Math.max(maxDelay, now - last);
			last = now;
		}, 10);
		try {
			await waitFor(() => sent.length > 0, 10_000);
			expect(maxDelay).toBeLessThan(300);
			expect(sent[0]?.wake).toBe(true);
			const start = Date.now();
			await mgr.dispose();
			expect(Date.now() - start).toBeLessThan(1000);
			expect(alive(info.pid)).toBe(false);
		} finally {
			clearInterval(heartbeat);
		}
	}, 15_000);

	it("disposes while a full-length pathological line is still being matched", async () => {
		const info = await mgr.start(
			{ argv: node(`console.log("a".repeat(4095) + "!");${STAY}`), name: "busy", match: "^(a+)+$" },
			tmp.dir,
		);
		await waitFor(() => (mgr.info(info.id)?.lines ?? 0) === 1);
		const start = Date.now();
		await mgr.dispose();
		expect(Date.now() - start).toBeLessThan(1000);
		expect(alive(info.pid)).toBe(false);
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
		expect(sent[0]?.text).toContain("1: bye");
		expect(sent[0]?.text).toContain("exited with code 3");
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
		expect(sent[0]?.text).toContain("1: fine\n2: ERROR bad");
	});

	it("reports a death by signal", async () => {
		const info = await mgr.start({ argv: node(`process.kill(process.pid,"SIGKILL")`), name: "w" }, tmp.dir);
		await waitFor(() => mgr.info(info.id)?.status === "exited");
		expect(sent[0]?.text).toContain("died from SIGKILL");
	});

	it("stop kills the whole process group quietly and removes the pidfile", async () => {
		const info = await mgr.start({ argv: ["sh", "-c", "sleep 300 & echo $!; wait"], name: "w" }, tmp.dir);
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
		const a = await mgr.start({ argv: ["sh", "-c", "sleep 300 & echo $!; wait"], name: "a" }, tmp.dir);
		const b = await mgr.start({ argv: node(STAY), name: "b" }, tmp.dir);
		await waitFor(() => (mgr.read(a.id)?.lines.length ?? 0) === 1);
		const grandchild = Number(mgr.read(a.id)?.lines[0]?.text);
		sent.length = 0;
		await mgr.dispose();
		expect(alive(a.pid) || alive(b.pid) || alive(grandchild)).toBe(false);
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
		const o = await other.start({ argv: node(STAY), name: "o" }, tmp.dir);
		await mgr.start({ argv: node(STAY), name: "w" }, tmp.dir);
		await mgr.dispose();
		expect(alive(o.pid)).toBe(true);
		expect(existsSync(join(tmp.dir, `sess-2.${process.pid}`, `${o.id}.json`))).toBe(true);
		await other.dispose();
	});
});
