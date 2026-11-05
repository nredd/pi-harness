import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ensureRoot,
	type PidRecord,
	psGroup,
	psInfo,
	rootDir,
	type SweepDeps,
	sessionDirName,
	sweepOrphans,
	writePidfile,
} from "../../src/monitor/pidfiles.ts";
import { tempDir } from "./helpers.ts";

const ps = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	const { promisify } = await import("node:util");
	return { ...actual, execFile: Object.assign(() => {}, { [promisify.custom]: ps }) };
});
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		chmodSync: vi.fn(actual.chmodSync),
		readFileSync: vi.fn(actual.readFileSync),
		readdirSync: vi.fn(actual.readdirSync),
		rmdirSync: vi.fn(actual.rmdirSync),
		statSync: vi.fn(actual.statSync),
		unlinkSync: vi.fn(actual.unlinkSync),
		writeFileSync: vi.fn(actual.writeFileSync),
	};
});

const NOW = 1_792_383_692_000;
/** Synthetic authenticated process identity, never passed to a real signal implementation. */
const MEMBER = { pid: 123, pgid: 123, startedAt: NOW, command: "test-monitor" };
/** All sweep process capabilities are synthetic; only recovery files use the real filesystem. */
function sweepDeps(overrides: Partial<SweepDeps> = {}): Partial<SweepDeps> {
	return {
		now: () => NOW,
		isAlive: () => false,
		procInfo: async () => MEMBER,
		groupMembers: async () => [MEMBER],
		signal: vi.fn(),
		killGroup: vi.fn(async () => true),
		...overrides,
	};
}

let tmp: ReturnType<typeof tempDir>;
let dir: string;
let path: string;
beforeEach(() => {
	tmp = tempDir();
	dir = join(tmp.dir, "session");
	const record: PidRecord = {
		ownerPid: 999,
		childPid: 123,
		pgid: 123,
		startedAt: NOW,
		command: MEMBER.command,
		name: "fixture",
	};
	path = writePidfile(dir, "m1", record);
	setFixtureAge(0);
});
afterEach(() => {
	vi.useRealTimers();
	vi.resetAllMocks();
	tmp.cleanup();
});

/** Assert uncertainty retains both the durable record and its contents, without signaling. */
function expectRetained(original: string, deps: Partial<SweepDeps>): void {
	expect(readFileSync(path, "utf8")).toBe(original);
	expect(deps.killGroup).not.toHaveBeenCalled();
	expect(deps.signal).not.toHaveBeenCalled();
}

describe("pidfile naming", () => {
	it("names an unusable session id generically", () => {
		expect(sessionDirName("", 42)).toBe("session.42");
		expect(sessionDirName("a/b", 42)).toBe("a_b.42");
	});

	it("uses uid 0 where the platform has no getuid", () => {
		const getuid = process.getuid;
		try {
			Object.defineProperty(process, "getuid", { value: undefined, configurable: true, writable: true });
			expect(rootDir(undefined, "/base")).toBe("/base/pi-monitors-0");
		} finally {
			Object.defineProperty(process, "getuid", { value: getuid, configurable: true, writable: true });
		}
		expect(rootDir(undefined, "/base")).toBe(`/base/pi-monitors-${process.getuid?.()}`);
	});
});

describe("ps output parsing", () => {
	it("treats unrecognised or undated ps output as no process", async () => {
		ps.mockResolvedValueOnce({ stdout: "" });
		expect(await psInfo(123)).toBeUndefined();
		ps.mockResolvedValueOnce({ stdout: "  123   123 Xxx Xxx 99 99:99:99 9999 test-monitor\n" });
		expect(await psInfo(123)).toBeUndefined();
	});

	it("reports session 0 as no session id", async () => {
		ps.mockResolvedValueOnce({ stdout: "  123     0 Thu Nov  5 07:00:00 2026 test-monitor\n" });
		expect(await psInfo(123)).toMatchObject({ pgid: 123, sessionId: undefined, command: "test-monitor" });
		ps.mockResolvedValueOnce({ stdout: "  123   123     0 Thu Nov  5 07:00:00 2026 test-monitor\n" });
		expect(await psGroup(123)).toEqual([expect.objectContaining({ pid: 123, pgid: 123, sessionId: undefined })]);
	});

	it("refuses a group snapshot with an undated member", async () => {
		ps.mockResolvedValueOnce({ stdout: "  123   123   123 Xxx Xxx 99 99:99:99 9999 test-monitor\n" });
		expect(await psGroup(123)).toBeUndefined();
	});
});

describe("pidfile recovery failure boundaries", () => {
	it.each([
		["a non-positive owner pid", { ownerPid: 0 }],
		["a non-string command", { command: 7 }],
	])("retains a fresh record with %s", async (_name, patch) => {
		const record = JSON.parse(readFileSync(path, "utf8"));
		writeFileSync(path, JSON.stringify({ ...record, ...patch }));
		setFixtureAge(0);
		const original = readFileSync(path, "utf8");
		const deps = sweepDeps();
		expect(await sweepOrphans(tmp.dir, "me", deps)).toEqual({ killed: [], removed: [], skippedLive: [], failed: [] });
		expectRetained(original, deps);
	});

	it("keeps a stale malformed record whose unlink is denied", async () => {
		malformedRecord(86_400_001);
		vi.mocked(unlinkSync).mockImplementationOnce(() => {
			throw new Error("record unlink denied");
		});
		expect((await sweepOrphans(tmp.dir, "me", sweepDeps())).removed).toEqual([]);
		expect(existsSync(path)).toBe(true);
	});

	it("does not report a vanished empty group's record as removed when unlink fails", async () => {
		vi.mocked(unlinkSync).mockImplementationOnce(() => {
			throw new Error("record unlink denied");
		});
		const deps = sweepDeps({ procInfo: async () => undefined, groupMembers: async () => [] });
		expect(await sweepOrphans(tmp.dir, "me", deps)).toEqual({ killed: [], removed: [], skippedLive: [], failed: [] });
		expect(existsSync(path)).toBe(true);
		expect(deps.killGroup).not.toHaveBeenCalled();
	});

	it("does not treat a leader in another login session as the recorded monitor", async () => {
		const original = readFileSync(path, "utf8");
		const deps = sweepDeps({ procInfo: async () => ({ ...MEMBER, sessionId: 456 }) });
		expect((await sweepOrphans(tmp.dir, "me", deps)).failed).toEqual([path]);
		expectRetained(original, deps);
	});

	it("does not signal when the persisted member changed before the default kill", async () => {
		let probes = 0;
		const deps = sweepDeps({ procInfo: async () => (++probes <= 2 ? MEMBER : { ...MEMBER, command: "reused" }) });
		delete deps.killGroup;
		const result = await sweepOrphans(tmp.dir, "me", deps);
		expect(result.failed).toEqual([path]);
		expect(deps.signal).not.toHaveBeenCalled();
		expect(JSON.parse(readFileSync(path, "utf8")).members).toEqual([MEMBER]);
	});

	it.each([
		["empty", []],
		["shared", ["1.abc", "2.def"]],
		["zero-pid", ["0.abc"]],
		["unrecognised", ["owner"]],
	])("refuses an %s guard it cannot attribute to one dead owner", async (_kind, owners) => {
		mkdirSync(`${path}.sweep`);
		for (const owner of owners) writeFileSync(join(`${path}.sweep`, owner), "");
		const original = readFileSync(path, "utf8");
		const deps = sweepDeps();
		expect((await sweepOrphans(tmp.dir, "me", deps)).failed).toEqual([path]);
		expectRetained(original, deps);
		expect(readdirSync(`${path}.sweep`).sort()).toEqual([...owners].sort());
	});

	it("retains recovery when process enumeration fails", async () => {
		ps.mockRejectedValueOnce(new Error("ps unavailable"));
		expect(await psGroup(123)).toBeUndefined();
	});

	it.each(["unknown group", "changed leader"])("does not signal after authentication changes: %s", async (kind) => {
		const original = readFileSync(path, "utf8");
		let probes = 0;
		const deps = sweepDeps({
			groupMembers: async () => (kind === "unknown group" ? undefined : [MEMBER]),
			procInfo: async () => (++probes === 1 ? MEMBER : { ...MEMBER, command: "reused" }),
		});
		const result = await sweepOrphans(tmp.dir, "me", deps);
		expect(result.failed).toEqual([path]);
		expectRetained(original, deps);
	});

	it("retains a valid file that becomes unreadable inside the guard", async () => {
		const original = readFileSync(path, "utf8");
		vi.mocked(readFileSync).mockImplementationOnce(() => {
			throw new Error("read failed");
		});
		const deps = sweepDeps();
		const result = await sweepOrphans(tmp.dir, "me", deps);
		expect(result).toEqual({ killed: [], removed: [], skippedLive: [], failed: [] });
		expectRetained(original, deps);
		expect(existsSync(`${path}.sweep`)).toBe(false);
	});

	it("retains malformed member identities while fresh", async () => {
		malformedRecord(0);
		const original = readFileSync(path, "utf8");
		const deps = sweepDeps();
		expect((await sweepOrphans(tmp.dir, "me", deps)).removed).toEqual([]);
		expectRetained(original, deps);
	});

	it.each([Date.UTC(1980, 0, 1), Date.UTC(2100, 0, 1)])(
		"uses fixture age, not wall clock %i, at the stale threshold",
		async (wallTime) => {
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(wallTime);
			const day = 86_400_000;
			malformedRecord(day);
			expect(Date.now()).toBe(wallTime);
			expect(statSync(path).mtimeMs).toBe(NOW - day);
			const deps = sweepDeps();
			const original = readFileSync(path, "utf8");
			expect((await sweepOrphans(tmp.dir, "me", deps)).removed).toEqual([]);
			expectRetained(original, deps);
			setFixtureAge(day + 1);
			expect((await sweepOrphans(tmp.dir, "me", deps)).removed).toEqual([path]);
			expect(existsSync(path)).toBe(false);
			expect(deps.killGroup).not.toHaveBeenCalled();
			expect(deps.signal).not.toHaveBeenCalled();
		},
	);

	it("refuses an unreadable guard rather than breaking another cleaner's lock", async () => {
		mkdirSync(`${path}.sweep`);
		const original = readFileSync(path, "utf8");
		const deps = sweepDeps();
		const read = vi.mocked(readdirSync).getMockImplementation();
		vi.mocked(readdirSync).mockImplementation((...args) => {
			if (args[0] === `${path}.sweep`) throw new Error("guard unreadable");
			return read?.(...args) as ReturnType<typeof readdirSync>;
		});
		expect((await sweepOrphans(tmp.dir, "me", deps)).failed).toEqual([path]);
		expectRetained(original, deps);
	});

	it("retains a dead cleaner's guard when unlink fails", async () => {
		mkdirSync(`${path}.sweep`);
		// This deliberately impossible PID is checked with kill(pid, 0), never signaled.
		const owner = join(`${path}.sweep`, "2147483647.abcdef");
		writeFileSync(owner, "");
		vi.mocked(unlinkSync).mockImplementationOnce(() => {
			throw new Error("unlink denied");
		});
		const deps = sweepDeps();
		expect((await sweepOrphans(tmp.dir, "me", deps)).failed).toEqual([path]);
		expect(existsSync(owner)).toBe(true);
		expect(deps.killGroup).not.toHaveBeenCalled();
	});

	it("does not claim a guard when its owner token cannot be written", async () => {
		const original = readFileSync(path, "utf8");
		vi.mocked(writeFileSync).mockImplementationOnce(() => {
			throw new Error("token write denied");
		});
		const deps = sweepDeps();
		expect((await sweepOrphans(tmp.dir, "me", deps)).failed).toEqual([path]);
		expectRetained(original, deps);
		expect(readdirSync(`${path}.sweep`)).toEqual([]);
	});

	it("reports a killed group but not a removed record when unlink fails", async () => {
		vi.mocked(unlinkSync).mockImplementationOnce(() => {
			throw new Error("record unlink denied");
		});
		const result = await sweepOrphans(tmp.dir, "me", sweepDeps());
		expect(result.killed).toEqual([path]);
		expect(result.removed).toEqual([]);
		expect(existsSync(path)).toBe(true);
		expect(JSON.parse(readFileSync(path, "utf8")).members).toEqual([MEMBER]);
	});

	it("does not remove an empty directory with an unknown age", async () => {
		rmRecord();
		vi.mocked(statSync).mockImplementationOnce(() => {
			throw new Error("stat denied");
		});
		expect((await sweepOrphans(tmp.dir, "me", sweepDeps())).removed).toEqual([]);
		expect(existsSync(dir)).toBe(true);
	});

	it("keeps an existing root usable when chmod is denied", () => {
		vi.mocked(chmodSync).mockImplementationOnce(() => {
			throw new Error("chmod denied");
		});
		expect(() => ensureRoot(tmp.dir)).not.toThrow();
		writeFileSync(join(tmp.dir, "usable"), "ok");
		expect(readFileSync(join(tmp.dir, "usable"), "utf8")).toBe("ok");
	});

	it("bounds post-KILL polling and retains authenticated recovery on reap timeout", async () => {
		vi.useFakeTimers();
		const signal = vi.fn();
		const groupMembers = vi.fn(async () => [MEMBER]);
		const deps = sweepDeps({ signal, groupMembers });
		delete deps.killGroup; // Exercise production escalation with fake time and synthetic process capabilities.
		const sweeping = sweepOrphans(tmp.dir, "me", deps);
		await vi.advanceTimersByTimeAsync(5_000);
		const result = await sweeping;
		expect(signal.mock.calls).toEqual([
			[123, "SIGTERM"],
			[123, "SIGKILL"],
		]);
		expect(groupMembers).toHaveBeenCalledTimes(21); // Initial authentication plus 20 bounded reap checks.
		expect(result.failed).toEqual([path]);
		expect(result.killed).toEqual([]);
		expect(result.removed).toEqual([]);
		expect(JSON.parse(readFileSync(path, "utf8")).members).toEqual([MEMBER]);
		expect(vi.getTimerCount()).toBe(0);
	});
});

/** Pin every age-bearing fixture to the injected sweep clock, never the host's filesystem clock. */
function setFixtureAge(ageMs: number): void {
	const instant = new Date(NOW - ageMs);
	utimesSync(path, instant, instant);
	utimesSync(dir, instant, instant);
}

/** Rewriting changes filesystem mtime, so restore deterministic age after each malformed write. */
function malformedRecord(ageMs: number): void {
	const record = JSON.parse(readFileSync(path, "utf8"));
	writeFileSync(path, JSON.stringify({ ...record, members: [{ ...MEMBER, pgid: 999 }] }));
	setFixtureAge(ageMs);
}

/** Leave a real empty directory for the age-check failure path. */
function rmRecord(): void {
	unlinkSync(path);
}
