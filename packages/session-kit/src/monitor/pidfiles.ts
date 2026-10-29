/**
 * Orphan safety. Each monitor writes `<root>/<sessionId>/<id>.json`; a clean exit removes it. When pi
 * is SIGKILLed the files stay behind, and the next session's sweep kills the recorded process group.
 *
 * Safety rules, in order of importance:
 * - never touch a file whose `ownerPid` is alive (`kill(pid, 0)` succeeds or fails with EPERM)
 * - authenticate the leader or a spawn-second group/session anchor before recording identities
 * - persist those identities before TERM; await cleanup before removing the recovery file
 * - escalation/recovery requires an exact surviving member identity, not a surviving leader
 *   (ps start times have one-second resolution; the check-to-signal race cannot be atomic)
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	chmodSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmdirSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { KILL_GRACE_MS, signalGroup } from "./process.ts";

const execFileAsync = promisify(execFile);

/** Allowed drift between the recorded spawn time and `ps -o lstart=` (1s resolution plus slack). */
export const START_TOLERANCE_MS = 5_000;
/**
 * `ps lstart` is a whole-second floor of a start time derived from an integer boot time, so a process
 * started milliseconds after `Date.now()` can read up to one second later, or nearly two earlier.
 */
const PS_START_RESOLUTION_MS = 1_000;
/** Malformed files and empty dirs older than this are cleaned up; younger ones may be mid-write. */
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export interface PidRecord {
	ownerPid: number;
	childPid: number;
	pgid: number;
	startedAt: number;
	name: string;
	command: string;
	/** Authenticated before TERM, retained for recovery if the leader exits first. */
	members?: GroupMember[];
}

export interface GroupMember extends ProcInfo {
	pid: number;
}

export interface ProcInfo {
	pgid: number;
	/** Linux session ID; macOS ps reports an unusable zero, so it is omitted there. */
	sessionId?: number;
	startedAt: number;
	command: string;
}

export interface SweepDeps {
	isAlive(pid: number): boolean;
	procInfo(pid: number): Promise<ProcInfo | undefined>;
	groupMembers(pgid: number): Promise<GroupMember[] | undefined>;
	killGroup(record: PidRecord, deps: SweepDeps): Promise<boolean>;
	signal(pgid: number, signal: NodeJS.Signals): void;
	now(): number;
}

export interface SweepResult {
	killed: string[];
	removed: string[];
	skippedLive: string[];
	/** Recovery could not be authenticated or a cleaner owns the record. Files are retained. */
	failed: string[];
}

export function rootDir(uid = process.getuid?.() ?? 0, base = tmpdir()): string {
	return join(base, `pi-monitors-${uid}`);
}

export function sessionDirName(sessionId: string, ownerPid = process.pid): string {
	return `${sessionId.replace(/[^A-Za-z0-9._-]/g, "_") || "session"}.${ownerPid}`;
}

/** Atomic write (temp + rename) so a sweeper never reads a half-written file. */
export function writePidfile(sessionDir: string, id: string, record: PidRecord): string {
	mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
	const path = join(sessionDir, `${id}.json`);
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
	renameSync(tmp, path);
	return path;
}

export function removePidfile(sessionDir: string, id: string): void {
	try {
		unlinkSync(join(sessionDir, `${id}.json`));
	} catch {
		// already gone
	}
}

/** Remove the session directory when nothing is left in it. */
export function removeSessionDirIfEmpty(sessionDir: string): void {
	try {
		rmdirSync(sessionDir);
	} catch {
		// not empty or already gone
	}
}

export function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

/** Process group and start time of `pid`, from `ps`. Undefined when the process does not exist. */
export async function psInfo(pid: number): Promise<ProcInfo | undefined> {
	try {
		const { stdout } = await execFileAsync("/bin/ps", ["-o", "pgid=,sess=,lstart=,command=", "-p", String(pid)], {
			env: { ...process.env, LC_ALL: "C" },
			timeout: 5_000,
		});
		const match = /^\s*(\d+)\s+(\d+)\s+(.{24})\s+(.+?)\s*$/.exec(stdout);
		if (!match) return undefined;
		const startedAt = Date.parse(match[3] as string);
		if (!Number.isFinite(startedAt)) return undefined;
		return { pgid: Number(match[1]), sessionId: Number(match[2]) || undefined, startedAt, command: match[4] as string };
	} catch {
		return undefined;
	}
}

/** Snapshot a group without relying on its leader still existing. Failure is not an empty group. */
export async function psGroup(pgid: number): Promise<GroupMember[] | undefined> {
	try {
		const { stdout } = await execFileAsync("/bin/ps", ["-axo", "pid=,pgid=,sess=,lstart=,command="], {
			env: { ...process.env, LC_ALL: "C" },
			timeout: 5_000,
			maxBuffer: 4 * 1024 * 1024,
		});
		const members: GroupMember[] = [];
		for (const line of stdout.split("\n")) {
			const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.{24})\s+(.+?)\s*$/.exec(line);
			if (!match || Number(match[2]) !== pgid) continue;
			const startedAt = Date.parse(match[4] as string);
			if (!Number.isFinite(startedAt)) return undefined;
			members.push({
				pid: Number(match[1]),
				pgid,
				sessionId: Number(match[3]) || undefined,
				startedAt,
				command: match[5] as string,
			});
		}
		return members;
	} catch {
		return undefined;
	}
}

async function sameMember(record: PidRecord, d: SweepDeps): Promise<boolean> {
	for (const member of record.members ?? []) {
		const current = await d.procInfo(member.pid);
		if (
			current?.pgid === record.pgid &&
			current.sessionId === member.sessionId &&
			current.startedAt === member.startedAt &&
			current.command === member.command
		)
			return true;
	}
	return false;
}

const defaultDeps: SweepDeps = {
	isAlive,
	procInfo: psInfo,
	groupMembers: psGroup,
	signal: signalGroup,
	async killGroup(record, d) {
		if (!(await sameMember(record, d))) return false;
		d.signal(record.pgid, "SIGTERM");
		await new Promise<void>((resolve) => setTimeout(resolve, KILL_GRACE_MS));
		if (await sameMember(record, d)) d.signal(record.pgid, "SIGKILL");
		// Give the OS a bounded interval to reap the killed members. Keep the file on uncertainty.
		for (let attempt = 0; attempt < 20; attempt++) {
			const remaining = await d.groupMembers(record.pgid);
			if (remaining?.length === 0) return true;
			if (!remaining) return false;
			await new Promise<void>((resolve) => setTimeout(resolve, 50));
		}
		return false;
	},
	now: Date.now,
};

function parseRecord(text: string): PidRecord | undefined {
	try {
		const r = JSON.parse(text) as Partial<PidRecord>;
		const ints = [r.ownerPid, r.childPid, r.pgid, r.startedAt];
		if (!ints.every((v) => typeof v === "number" && Number.isInteger(v) && v > 0)) return undefined;
		if (typeof r.command !== "string" || typeof r.name !== "string") return undefined;
		if (
			r.members !== undefined &&
			(!Array.isArray(r.members) ||
				!r.members.every(
					(m) =>
						Number.isInteger(m.pid) &&
						m.pid > 0 &&
						m.pgid === r.pgid &&
						Number.isFinite(m.startedAt) &&
						typeof m.command === "string",
				))
		)
			return undefined;
		return r as PidRecord;
	} catch {
		return undefined;
	}
}

/** Sweep every session directory under `root` whose recorded owner is dead. */
export async function sweepOrphans(
	root: string,
	_ownSession: string,
	deps: Partial<SweepDeps> = {},
): Promise<SweepResult> {
	const d: SweepDeps = { ...defaultDeps, ...deps };
	const result: SweepResult = { killed: [], removed: [], skippedLive: [], failed: [] };
	let sessions: string[];
	try {
		sessions = readdirSync(root);
	} catch {
		return result;
	}
	for (const session of sessions) {
		const dir = join(root, session);
		let files: string[];
		try {
			files = readdirSync(dir);
		} catch {
			continue;
		}
		let removedAny = false;
		for (const file of files) {
			if (!file.endsWith(".json")) continue;
			const path = join(dir, file);
			const release = acquireSweepGuard(path);
			if (!release) {
				result.failed.push(path);
				continue;
			}
			try {
				let text: string;
				try {
					text = readFileSync(path, "utf8");
				} catch {
					continue;
				}
				const record = parseRecord(text);
				if (!record) {
					if (isStale(path, d.now())) removedAny = unlinkQuiet(path, result) || removedAny;
					continue;
				}
				if (d.isAlive(record.ownerPid)) {
					result.skippedLive.push(path);
					continue;
				}
				if (await looksLikeSame(record, d)) {
					const members = await d.groupMembers(record.pgid);
					if (!members || !(await looksLikeSame(record, d))) {
						result.failed.push(path);
						continue;
					}
					record.members = members;
					// Atomic persistence MUST succeed before any signal; a killed sweeper can resume cleanup.
					writePidfile(dir, file.slice(0, -5), record);
				} else if (!(await sameMember(record, d))) {
					const members = await d.groupMembers(record.pgid);
					if (members?.length === 0) {
						removedAny = unlinkQuiet(path, result) || removedAny;
						continue;
					}
					// A member already present at spawn anchors this group to the recorded lifetime.
					// Later-born survivors alone cannot distinguish a reused, now leaderless group.
					const anchor = members?.find(
						(m) =>
							m.pgid === record.childPid &&
							(m.sessionId === undefined || m.sessionId === record.childPid) &&
							m.startedAt < record.startedAt + PS_START_RESOLUTION_MS &&
							record.startedAt - m.startedAt < 2 * PS_START_RESOLUTION_MS,
					);
					if (
						record.members?.length ||
						!anchor ||
						record.pgid !== record.childPid ||
						d.isAlive(record.childPid) ||
						members?.some((m) => m.pid === record.childPid) ||
						(await d.procInfo(record.childPid))
					) {
						result.failed.push(path);
						continue;
					}
					record.members = members;
					writePidfile(dir, file.slice(0, -5), record);
				}
				if (!(await d.killGroup(record, d))) {
					result.failed.push(path);
					continue;
				}
				result.killed.push(path);
				removedAny = unlinkQuiet(path, result) || removedAny;
			} finally {
				release();
			}
		}
		if (removedAny || isStale(dir, d.now())) removeSessionDirIfEmpty(dir);
	}
	return result;
}

/** A live or unknown guard is never broken, regardless of age. Reread records only inside it. */
function acquireSweepGuard(path: string): (() => void) | undefined {
	const guard = `${path}.sweep`;
	const token = randomUUID();
	const ownerPath = join(guard, `${process.pid}.${token}`);
	const read = (): { pid: number; token: string } | undefined => {
		try {
			const files = readdirSync(guard);
			if (files.length !== 1) return undefined;
			const match = /^(\d+)\.([a-f0-9-]+)$/.exec(files[0] ?? "");
			return match && Number(match[1]) > 0 ? { pid: Number(match[1]), token: match[2] as string } : undefined;
		} catch {
			return undefined;
		}
	};
	try {
		mkdirSync(guard, { mode: 0o700 });
	} catch {
		const owner = read();
		if (owner && !isAlive(owner.pid) && read()?.token === owner.token) {
			try {
				unlinkSync(join(guard, `${owner.pid}.${owner.token}`));
				rmdirSync(guard);
			} catch {
				return undefined;
			}
			return acquireSweepGuard(path);
		}
		return undefined;
	}
	try {
		writeFileSync(ownerPath, "", { mode: 0o600, flag: "wx" });
	} catch {
		return undefined;
	}
	return () => {
		try {
			unlinkSync(ownerPath);
			rmdirSync(guard);
		} catch {
			// Never recursively remove a replacement owner's guard.
		}
	};
}

async function looksLikeSame(record: PidRecord, d: SweepDeps): Promise<boolean> {
	if (record.pgid !== record.childPid) return false;
	const info = await d.procInfo(record.childPid);
	if (!info || info.pgid !== record.pgid || (info.sessionId !== undefined && info.sessionId !== record.childPid))
		return false;
	if (Math.abs(info.startedAt - record.startedAt) > START_TOLERANCE_MS) return false;
	return (
		info.command === record.command || info.command.endsWith(record.command) || record.command.endsWith(info.command)
	);
}

function unlinkQuiet(path: string, result: SweepResult): boolean {
	try {
		unlinkSync(path);
		result.removed.push(path);
		return true;
	} catch {
		return false;
	}
}

function isStale(path: string, now: number): boolean {
	try {
		return now - statSync(path).mtimeMs > STALE_AFTER_MS;
	} catch {
		return false;
	}
}

/** Create the root directory with owner-only permissions. */
export function ensureRoot(root: string): void {
	mkdirSync(root, { recursive: true, mode: 0o700 });
	try {
		chmodSync(root, 0o700);
	} catch {
		// not ours to chmod
	}
}
