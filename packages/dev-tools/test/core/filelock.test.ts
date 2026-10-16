import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	FileLockAbortedError,
	FileLockFailedError,
	FileLockTimeoutError,
	withFileLock,
} from "../../src/core/filelock.ts";

const CHILD = fileURLToPath(new URL("./filelock-child.ts", import.meta.url));
const roots: string[] = [];
const children: ChildProcess[] = [];

/** Every temp root is registered for teardown; `x.lock` lives inside it. */
const tmp = () => {
	const root = mkdtempSync(join(tmpdir(), "pi-dev-tools-fl-"));
	roots.push(root);
	return join(root, "x.lock");
};
const rootOf = (lock: string) => join(lock, "..");

afterEach(() => {
	for (const c of children.splice(0)) {
		const pid = c.pid;
		expect(
			pid !== undefined && c.exitCode === null && c.signalCode === null && pidAlive(pid),
			`leaked child ${pid}`,
		).toBe(false);
		c.kill("SIGKILL");
	}
	for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** A pid that is certainly dead: a child we spawned and waited for. */
async function deadPid(): Promise<number> {
	const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
	const pid = child.pid ?? 0;
	await new Promise((r) => child.once("close", r));
	return pid;
}

function plant(dir: string, owner: { pid: number; startedAt: number; token?: string }): void {
	mkdirSync(dir);
	writeFileSync(join(dir, "owner.json"), JSON.stringify({ token: "other", ...owner }));
}

/** Run the child to completion; resolves with its stdout. */
function child(mode: string, lock: string, startAt = 0, timeoutMs = 15_000): Promise<string> {
	return new Promise((resolve, reject) => {
		const p = spawn(process.execPath, [CHILD, mode, lock, rootOf(lock), String(startAt), String(timeoutMs)], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		children.push(p);
		let out = "";
		let err = "";
		p.stdout.on("data", (d) => {
			out += d;
		});
		p.stderr.on("data", (d) => {
			err += d;
		});
		p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`child exited ${code}: ${err || out}`))));
	});
}

describe("withFileLock", () => {
	it("holds an owner file while running and removes the lock after, even on throw", async () => {
		const dir = tmp();
		await withFileLock(dir, async () => {
			expect(JSON.parse(readFileSync(join(dir, "owner.json"), "utf8"))).toMatchObject({ pid: process.pid });
		});
		expect(existsSync(dir)).toBe(false);
		await expect(
			withFileLock(dir, async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect(existsSync(dir)).toBe(false);
	});

	it("reclaims a lock whose owner pid is dead", async () => {
		const dir = tmp();
		plant(dir, { pid: await deadPid(), startedAt: Date.now() });
		await expect(withFileLock(dir, async () => "ok", { timeoutMs: 1000 })).resolves.toBe("ok");
		expect(existsSync(dir)).toBe(false);
	});

	it("never reclaims a live pid, however old the lock", async () => {
		const dir = tmp();
		plant(dir, { pid: process.pid, startedAt: Date.now() - 24 * 3600_000 });
		const err = await withFileLock(dir, async () => "no", { timeoutMs: 200 }).catch((e) => e);
		expect(err).toBeInstanceOf(FileLockTimeoutError);
		expect(err.message).toContain(`pid ${process.pid}`);
		expect(existsSync(join(dir, "owner.json"))).toBe(true);
	});

	it("reclaims an ownerless lock directory only once it is old", async () => {
		const dir = tmp();
		mkdirSync(dir);
		await expect(withFileLock(dir, async () => "no", { timeoutMs: 150 })).rejects.toBeInstanceOf(FileLockTimeoutError);
		expect(existsSync(dir)).toBe(true);
		const old = new Date(Date.now() - 60_000);
		utimesSync(dir, old, old);
		await expect(withFileLock(dir, async () => "ok", { timeoutMs: 1000 })).resolves.toBe("ok");
	});

	it("times out with a live holder, names it, and leaves the holder's lock alone", async () => {
		const dir = tmp();
		plant(dir, { pid: process.pid, startedAt: Date.now() });
		let waits = 0;
		const err = await withFileLock(dir, async () => "no", { timeoutMs: 200, onWait: () => waits++ }).catch((e) => e);
		expect(err).toBeInstanceOf(FileLockTimeoutError);
		expect(err.message).toMatch(/^lock-timeout: .*held by pid \d+/);
		expect(waits).toBe(1);
		expect(existsSync(join(dir, "owner.json"))).toBe(true);
	});

	it("does not delete a lock that was reclaimed from it", async () => {
		const dir = tmp();
		await withFileLock(dir, async () => {
			writeFileSync(
				join(dir, "owner.json"),
				JSON.stringify({ pid: process.pid, startedAt: Date.now(), token: "thief" }),
			);
		});
		expect(existsSync(dir)).toBe(true);
	});

	it("rejects when aborted while waiting", async () => {
		const dir = tmp();
		plant(dir, { pid: process.pid, startedAt: Date.now() });
		const ac = new AbortController();
		setTimeout(() => ac.abort(), 100);
		await expect(withFileLock(dir, async () => "no", { signal: ac.signal, timeoutMs: 5000 })).rejects.toBeInstanceOf(
			FileLockAbortedError,
		);
	});

	it("never breaks an artificially old live reclaim guard and bounds waiting", async () => {
		const dir = tmp();
		plant(dir, { pid: await deadPid(), startedAt: Date.now() });
		mkdirSync(`${dir}.reclaim`);
		const owner = join(`${dir}.reclaim`, `${process.pid}.aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa`);
		writeFileSync(owner, "");
		const old = new Date(Date.now() - 60_000);
		utimesSync(`${dir}.reclaim`, old, old);
		const start = Date.now();
		await expect(withFileLock(dir, async () => "no", { timeoutMs: 200 })).rejects.toThrow("inspect");
		expect(Date.now() - start).toBeLessThan(1000);
		expect(existsSync(owner)).toBe(true);
		expect(existsSync(dir)).toBe(true);
	});

	it("retains unknown reclaim guards regardless of age", async () => {
		const dir = tmp();
		plant(dir, { pid: await deadPid(), startedAt: Date.now() });
		mkdirSync(`${dir}.reclaim`);
		await expect(withFileLock(dir, async () => "no", { timeoutMs: 200 })).rejects.toBeInstanceOf(FileLockTimeoutError);
		const old = new Date(Date.now() - 60_000);
		utimesSync(`${dir}.reclaim`, old, old);
		await expect(withFileLock(dir, async () => "no", { timeoutMs: 200 })).rejects.toBeInstanceOf(FileLockTimeoutError);
		expect(existsSync(`${dir}.reclaim`)).toBe(true);
	});

	it("reclaims a confirmed dead guard even when fresh", async () => {
		const dir = tmp();
		const dead = await deadPid();
		plant(dir, { pid: dead, startedAt: Date.now() });
		mkdirSync(`${dir}.reclaim`);
		writeFileSync(join(`${dir}.reclaim`, `${dead}.bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb`), "");
		await expect(withFileLock(dir, async () => "ok", { timeoutMs: 1000 })).resolves.toBe("ok");
		expect(existsSync(dir)).toBe(false);
		expect(existsSync(`${dir}.reclaim`)).toBe(false);
	});

	it("removes the directory and reports lock-failed when the owner write fails", async () => {
		const dir = tmp();
		let ran = false;
		const err = await withFileLock(
			dir,
			async () => {
				ran = true;
			},
			{
				writeOwner: () => {
					throw new Error("disk full");
				},
			},
		).catch((e) => e);
		expect(err).toBeInstanceOf(FileLockFailedError);
		expect(err.message).toMatch(/^lock-failed: .*disk full/);
		expect(ran).toBe(false);
		expect(existsSync(dir)).toBe(false);
	});

	it("serializes real processes reclaiming one dead lock: never two in the critical section", async () => {
		const dir = tmp();
		plant(dir, { pid: await deadPid(), startedAt: Date.now(), token: "dead" });
		const at = Date.now() + 1500;
		const outs = await Promise.all(Array.from({ length: 6 }, () => child("crit", dir, at)));
		expect(outs).toEqual(Array(6).fill("ok"));
		const root = rootOf(dir);
		expect(existsSync(join(root, "violations"))).toBe(false);
		expect(readFileSync(join(root, "entered"), "utf8").trim().split("\n")).toHaveLength(6);
		expect(existsSync(dir)).toBe(false);
		expect(existsSync(`${dir}.reclaim`)).toBe(false);
	}, 30_000);

	it("serializes real processes on a fresh lock", async () => {
		const dir = tmp();
		const at = Date.now() + 1000;
		const outs = await Promise.all(Array.from({ length: 6 }, () => child("crit", dir, at)));
		expect(outs).toEqual(Array(6).fill("ok"));
		expect(existsSync(join(rootOf(dir), "violations"))).toBe(false);
		expect(
			readFileSync(join(rootOf(dir), "entered"), "utf8")
				.trim()
				.split("\n"),
		).toHaveLength(6);
	}, 30_000);

	it("polls with unref'd timers: a waiting process exits promptly once nothing else holds it open", async () => {
		const dir = tmp();
		plant(dir, { pid: process.pid, startedAt: Date.now() });
		const t0 = Date.now();
		await child("wait", dir, 0, 60_000);
		expect(Date.now() - t0).toBeLessThan(5000);
	}, 30_000);
});
