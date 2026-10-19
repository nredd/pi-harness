import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type PidRecord, psInfo, sweepOrphans, writePidfile } from "../../src/monitor/pidfiles.ts";
import { alive, cleanupProcs, deadPid, spawnSleeper, tempDir, waitFor } from "./helpers.ts";

let tmp: ReturnType<typeof tempDir>;
beforeEach(() => {
	tmp = tempDir();
});
afterEach(() => {
	cleanupProcs();
	tmp.cleanup();
});

function record(over: Partial<PidRecord>): PidRecord {
	return { ownerPid: process.pid, childPid: 1, pgid: 1, startedAt: Date.now(), name: "n", command: "c", ...over };
}

describe("psInfo", () => {
	it("reports this process's group and start time, and nothing for a dead pid", async () => {
		const info = await psInfo(process.pid);
		expect(info?.pgid).toBeGreaterThan(0);
		expect(Math.abs((info?.startedAt ?? 0) - (Date.now() - process.uptime() * 1000))).toBeLessThan(10_000);
		expect(await psInfo(await deadPid())).toBeUndefined();
	});
});

describe("sweepOrphans", () => {
	it("kills the group of a dead owner's monitor and removes its file and directory", async () => {
		const child = await spawnSleeper();
		const owner = await deadPid();
		writePidfile(
			join(tmp.dir, "dead-session"),
			"m1",
			record({
				ownerPid: owner,
				childPid: child.pid,
				pgid: child.pid,
				startedAt: child.startedAt,
				command: (await psInfo(child.pid))?.command ?? "",
			}),
		);
		const res = await sweepOrphans(tmp.dir, "me");
		expect(res.killed).toHaveLength(1);
		await waitFor(() => !alive(child.pid));
		expect(existsSync(join(tmp.dir, "dead-session"))).toBe(false);
	});

	it("awaits escalation after the actual leader exits and retains recovery coverage", async () => {
		const file = join(tmp.dir, "grandchild");
		const child = spawn(
			"/bin/sh",
			["-c", `/bin/sh -c 'trap "" TERM; echo $$ > "${file}"; while :; do sleep 1; done' & wait`],
			{ detached: true, stdio: "ignore" },
		);
		const pid = child.pid as number;
		let grandchild = 0;
		try {
			await waitFor(() => existsSync(file));
			grandchild = Number((await import("node:fs")).readFileSync(file, "utf8"));
			const info = await psInfo(pid);
			writePidfile(
				join(tmp.dir, "orphan"),
				"m1",
				record({
					ownerPid: await deadPid(),
					childPid: pid,
					pgid: pid,
					startedAt: info?.startedAt,
					command: info?.command,
				}),
			);
			const sweep = sweepOrphans(tmp.dir, "me");
			await waitFor(() => !alive(pid));
			expect(existsSync(join(tmp.dir, "orphan", "m1.json"))).toBe(true);
			await sweep;
			await waitFor(() => !alive(grandchild));
			expect(existsSync(join(tmp.dir, "orphan", "m1.json"))).toBe(false);
		} finally {
			try {
				process.kill(-pid, "SIGKILL");
			} catch {
				/* gone */
			}
		}
	});

	it("recovers a resistant orphan whose leader exited before any sweep, even after an interrupted concurrent cleaner", async () => {
		const file = join(tmp.dir, "early-grandchild");
		const leader = spawn(
			"/bin/sh",
			["-c", `/bin/sh -c 'trap "" TERM; echo $$ > "${file}"; while :; do sleep 1; done' & sleep 0.2`],
			{ detached: true, stdio: "ignore" },
		);
		const pid = leader.pid as number;
		await new Promise((resolve) => leader.once("spawn", resolve));
		const startedAt = Date.now();
		let cleaner: ReturnType<typeof spawn> | undefined;
		try {
			await waitFor(() => existsSync(file));
			const grandchild = Number(readFileSync(file, "utf8"));
			await new Promise((resolve) => leader.once("close", resolve));
			const dir = join(tmp.dir, "early");
			const path = writePidfile(dir, "m1", record({ ownerPid: await deadPid(), childPid: pid, pgid: pid, startedAt }));
			const ready = join(tmp.dir, "cleaner-ready");
			cleaner = spawn(process.execPath, [join(import.meta.dirname, "sweep-child.ts"), tmp.dir, ready], {
				stdio: "ignore",
			});
			await waitFor(() => existsSync(ready));
			expect(JSON.parse(readFileSync(path, "utf8")).members.length).toBeGreaterThan(0);
			const second = await sweepOrphans(tmp.dir, "other");
			expect(second.failed).toContain(path);
			expect(existsSync(path)).toBe(true);
			expect(alive(grandchild)).toBe(true);
			cleaner.kill("SIGKILL");
			await new Promise((resolve) => cleaner?.once("close", resolve));
			const recovered = await sweepOrphans(tmp.dir, "third");
			expect(recovered.killed).toContain(path);
			await waitFor(() => !alive(grandchild));
			expect(existsSync(path)).toBe(false);
		} finally {
			cleaner?.kill("SIGKILL");
			try {
				process.kill(-pid, "SIGKILL");
			} catch {
				/* gone */
			}
		}
	}, 15_000);

	it("does not escalate into a reused group and retains uncertain recovery", async () => {
		const original = { pid: 123, pgid: 123, startedAt: Date.now(), command: "original" };
		writePidfile(
			join(tmp.dir, "reuse"),
			"m1",
			record({ ownerPid: 999, childPid: 123, pgid: 123, startedAt: original.startedAt, command: "original" }),
		);
		const signals: string[] = [];
		const res = await sweepOrphans(tmp.dir, "me", {
			isAlive: () => false,
			procInfo: async () =>
				signals.length ? { ...original, startedAt: original.startedAt + 1000, command: "unrelated" } : original,
			groupMembers: async () => (signals.length ? undefined : [original]),
			signal: (_pgid, signal) => {
				signals.push(signal);
			},
		});
		expect(signals).toEqual(["SIGTERM"]);
		expect(res.removed).toEqual([]);
		expect(existsSync(join(tmp.dir, "reuse", "m1.json"))).toBe(true);
	});

	it.each(["start", "command", "group"])("refuses a reused recovery member with changed %s", async (field) => {
		const original = { pid: 124, pgid: 123, startedAt: Date.now(), command: "original" };
		const reused = {
			...original,
			...(field === "start"
				? { startedAt: original.startedAt + 1000 }
				: field === "command"
					? { command: "unrelated" }
					: { pgid: 999 }),
		};
		writePidfile(
			join(tmp.dir, "reuse-member"),
			"m1",
			record({ ownerPid: 999, childPid: 123, pgid: 123, members: [original] }),
		);
		const signals: string[] = [];
		await sweepOrphans(tmp.dir, "me", {
			isAlive: () => false,
			procInfo: async (pid) => (pid === 124 ? reused : undefined),
			groupMembers: async () => [reused],
			signal: (_pgid, signal) => {
				signals.push(signal);
			},
		});
		expect(signals).toEqual([]);
	});

	it("recovers persisted survivors after a previous sweep lost its leader", async () => {
		const survivor = { pid: 124, pgid: 123, startedAt: Date.now(), command: "survivor" };
		writePidfile(
			join(tmp.dir, "recover"),
			"m1",
			record({ ownerPid: 999, childPid: 123, pgid: 123, members: [survivor] }),
		);
		const signals: string[] = [];
		const res = await sweepOrphans(tmp.dir, "me", {
			isAlive: () => false,
			procInfo: async (pid) => (pid === 124 && !signals.includes("SIGKILL") ? survivor : undefined),
			groupMembers: async () => (signals.includes("SIGKILL") ? [] : [survivor]),
			signal: (_pgid, signal) => {
				signals.push(signal);
			},
		});
		expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
		expect(res.removed).toHaveLength(1);
	});

	it.each(["later", "session", "unknown"])("retains unauthenticated leaderless groups: %s", async (kind) => {
		const startedAt = Date.now();
		const path = writePidfile(
			join(tmp.dir, "uncertain"),
			"m1",
			record({ ownerPid: 999, childPid: 123, pgid: 123, startedAt }),
		);
		const signals: string[] = [];
		const res = await sweepOrphans(tmp.dir, "me", {
			isAlive: () => false,
			procInfo: async () => undefined,
			groupMembers: async () =>
				kind === "unknown"
					? undefined
					: [
							{
								pid: 124,
								pgid: 123,
								startedAt: kind === "later" ? startedAt + 1000 : startedAt,
								sessionId: kind === "session" ? 999 : 123,
								command: "survivor",
							},
						],
			signal: (_pgid, signal) => {
				signals.push(signal);
			},
		});
		expect(res.failed).toContain(path);
		expect(existsSync(path)).toBe(true);
		expect(signals).toEqual([]);
	});

	it("reaps a leaderless group whose at-spawn member reads as the next whole second", async () => {
		// `ps lstart` is a whole-second floor, so a member started milliseconds after the recorded spawn
		// reads as the next second when its start crosses a second boundary.
		const startedAt = 1_792_383_691_950;
		const path = writePidfile(
			join(tmp.dir, "boundary"),
			"m1",
			record({ ownerPid: 999, childPid: 123, pgid: 123, startedAt }),
		);
		const killed: number[] = [];
		const res = await sweepOrphans(tmp.dir, "me", {
			isAlive: () => false,
			procInfo: async () => undefined,
			groupMembers: async () => [
				{ pid: 124, pgid: 123, startedAt: 1_792_383_692_000, sessionId: 123, command: "member" },
			],
			killGroup: async (dead) => {
				killed.push(dead.pgid);
				return true;
			},
		});
		expect(res.killed).toEqual([path]);
		expect(killed).toEqual([123]);
	});

	it("never touches a live owner's files or processes", async () => {
		const child = await spawnSleeper();
		const file = join(tmp.dir, "live-session");
		writePidfile(
			file,
			"m1",
			record({ ownerPid: process.pid, childPid: child.pid, pgid: child.pid, startedAt: child.startedAt }),
		);
		const res = await sweepOrphans(tmp.dir, "me");
		expect(res.skippedLive).toHaveLength(1);
		expect(res.killed).toEqual([]);
		expect(alive(child.pid)).toBe(true);
		expect(readdirSync(file)).toEqual(["m1.json"]);
	});

	it("reclaims a dead owner even when its session id is being resumed", async () => {
		const child = await spawnSleeper();
		const owner = await deadPid();
		writePidfile(
			join(tmp.dir, "me"),
			"m1",
			record({
				ownerPid: owner,
				childPid: child.pid,
				pgid: child.pid,
				startedAt: child.startedAt,
				command: (await psInfo(child.pid))?.command ?? "",
			}),
		);
		const res = await sweepOrphans(tmp.dir, "me");
		expect(res.killed).toHaveLength(1);
		await waitFor(() => !alive(child.pid));
		expect(existsSync(join(tmp.dir, "me", "m1.json"))).toBe(false);
	});

	it("guards against pid reuse: a live pid with the wrong start time is left alone, the record is retained", async () => {
		const child = await spawnSleeper();
		const owner = await deadPid();
		writePidfile(
			join(tmp.dir, "s"),
			"m1",
			record({ ownerPid: owner, childPid: child.pid, pgid: child.pid, startedAt: child.startedAt - 3_600_000 }),
		);
		const res = await sweepOrphans(tmp.dir, "me");
		expect(res.killed).toEqual([]);
		expect(res.removed).toHaveLength(0);
		expect(res.failed).toHaveLength(1);
		expect(alive(child.pid)).toBe(true);
	});

	it("refuses a record whose pgid is not its own pid", async () => {
		const child = await spawnSleeper();
		const owner = await deadPid();
		writePidfile(
			join(tmp.dir, "s"),
			"m1",
			record({ ownerPid: owner, childPid: child.pid, pgid: 1, startedAt: child.startedAt }),
		);
		expect((await sweepOrphans(tmp.dir, "me")).killed).toEqual([]);
		expect(alive(child.pid)).toBe(true);
	});

	it("handles a dead owner whose child is already gone", async () => {
		const owner = await deadPid();
		const gone = await deadPid();
		writePidfile(join(tmp.dir, "s"), "m1", record({ ownerPid: owner, childPid: gone, pgid: gone }));
		const res = await sweepOrphans(tmp.dir, "me");
		expect(res.killed).toEqual([]);
		expect(res.removed).toHaveLength(1);
	});

	it("leaves fresh malformed files and temp files alone, removes day-old malformed ones", async () => {
		const dir = join(tmp.dir, "s");
		mkdirSync(dir);
		writeFileSync(join(dir, "bad.json"), "{nope");
		writeFileSync(join(dir, "m2.json.123.tmp"), "{}");
		const res = await sweepOrphans(tmp.dir, "me");
		expect(res.removed).toEqual([]);
		expect(existsSync(join(dir, "bad.json"))).toBe(true);
		const old = (Date.now() - 2 * 86_400_000) / 1000;
		utimesSync(join(dir, "bad.json"), old, old);
		expect((await sweepOrphans(tmp.dir, "me")).removed).toHaveLength(1);
	});

	it("is a no-op when the root does not exist", async () => {
		expect(await sweepOrphans(join(tmp.dir, "nope"), "me")).toEqual({
			killed: [],
			removed: [],
			skippedLive: [],
			failed: [],
		});
	});
});
