/**
 * Writer-claim races and failures (#1247) pinned to one interleaving each:
 * another process acting between two filesystem calls, or a call failing
 * partway, injected at that call.
 */
import * as fs from "node:fs";
import { join } from "node:path";
import { makeTestTempDir } from "@nredd/pi-test-lib/temp-dir";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { claimTranscript, openClaimed, type TranscriptClaim, WRITER_CLAIM_SUFFIX } from "../src/transcript-claim.ts";
import { EXITED_PID, holderBody, stubExited, stubVerifiedDomain } from "./fixtures/writer-claim.ts";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const openSync = vi.fn(actual.openSync);
	const linkSync = vi.fn(actual.linkSync);
	const writeFileSync = vi.fn(actual.writeFileSync);
	const statSync = vi.fn(actual.statSync);
	const realpathSync = vi.fn(actual.realpathSync);
	const lstatSync = vi.fn(actual.lstatSync);
	// A copy a test can strip a flag from, as a platform without it would.
	const constants = { ...actual.constants };
	const spies = { openSync, linkSync, writeFileSync, statSync, realpathSync, lstatSync, constants };
	return { ...actual, default: { ...actual, ...spies }, ...spies };
});

/** Every spy, paired with the real implementation it restores to. */
function spies() {
	return [
		[vi.mocked(fs.openSync), actual.openSync],
		[vi.mocked(fs.linkSync), actual.linkSync],
		[vi.mocked(fs.writeFileSync), actual.writeFileSync],
		[vi.mocked(fs.statSync), actual.statSync],
		[vi.mocked(fs.realpathSync), actual.realpathSync],
		[vi.mocked(fs.lstatSync), actual.lstatSync],
	] as const;
}

afterEach(() => {
	for (const [spy] of spies()) spy.mockReset();
});

/** The real implementation, restored on the spy after a reset. */
const actual = await vi.importActual<typeof import("node:fs")>("node:fs");

function setup(stale: boolean): { dir: string; file: string; claimPath: string } {
	for (const [spy, real] of spies()) spy.mockImplementation(real as never);
	const dir = actual.realpathSync(makeTestTempDir("transcript-claim-race-", onTestFinished));
	const file = join(dir, "child.jsonl");
	actual.writeFileSync(file, "{}\n");
	const claimPath = `${file}${WRITER_CLAIM_SUFFIX}`;
	if (stale) {
		stubExited();
		stubVerifiedDomain();
		actual.writeFileSync(claimPath, holderBody(EXITED_PID));
	}
	return { dir, file, claimPath };
}

const failure = (code: string) => Object.assign(new Error(`${code}: injected`), { code });

/** Make exclusive publishes at `path` fail as if another process had just won them, `times` times. */
function losePublishes(path: string, times: number): void {
	let lost = 0;
	vi.mocked(fs.linkSync).mockImplementation((existing, target) => {
		if (target === path && lost < times) {
			lost++;
			throw failure("EEXIST");
		}
		return actual.linkSync(existing, target);
	});
}

it("refuses a takeover when the stale claim changes before it is replaced", () => {
	const { file, claimPath } = setup(true);
	// Another process replaces the claim just before the reread under the lock.
	let opens = 0;
	vi.mocked(fs.openSync).mockImplementation(((path: fs.PathLike, flags: fs.OpenMode) => {
		if (path === claimPath && ++opens === 2) actual.writeFileSync(claimPath, holderBody(process.ppid));
		return actual.openSync(path, flags);
	}) as never);
	expect(() => claimTranscript(file)).toThrow(
		`child session's writer claim changed while it was being taken over; retry: ${file}`,
	);
	// The claim it judged stale is left for whoever replaced it, and the lock is gone.
	expect(actual.readFileSync(claimPath, "utf8")).toContain(`"pid":${process.ppid}`);
	expect(actual.existsSync(`${claimPath}.takeover`)).toBe(false);
});

it("refuses a takeover another process wins between the unlink and the create", () => {
	const { file, claimPath } = setup(true);
	// The first publish meets the stale claim for real; the one after the unlink loses.
	let publishes = 0;
	vi.mocked(fs.linkSync).mockImplementation((existing, target) => {
		if (target === claimPath && ++publishes === 2) throw failure("EEXIST");
		return actual.linkSync(existing, target);
	});
	expect(() => claimTranscript(file)).toThrow(`child session was claimed by another process during takeover: ${file}`);
	expect(actual.existsSync(`${claimPath}.takeover`)).toBe(false);
});

it("refuses a takeover another process locks after the lock check", () => {
	const { file, claimPath } = setup(true);
	const lockPath = `${claimPath}.takeover`;
	losePublishes(lockPath, 1);
	expect(() => claimTranscript(file)).toThrow(
		`another process is taking over this child session's stale writer claim, or one crashed doing so; remove ${lockPath} if none is: ${file}`,
	);
	// The stale claim is the other taker's to replace.
	expect(JSON.parse(actual.readFileSync(claimPath, "utf8")).pid).toBe(EXITED_PID);
});

it("claims a transcript whose holder released it between the create and the read", () => {
	const { file, claimPath } = setup(false);
	losePublishes(claimPath, 1);
	const claim = claimTranscript(file);
	expect(JSON.parse(actual.readFileSync(claimPath, "utf8")).pid).toBe(process.pid);
	claim.release();
});

it("refuses when a third process claims it in that same gap", () => {
	const { file, claimPath } = setup(false);
	losePublishes(claimPath, 2);
	expect(() => claimTranscript(file)).toThrow(`child session was claimed by another process; retry: ${file}`);
});

it("leaves no partial claim or takeover lock when writing one fails", () => {
	const { dir, file, claimPath } = setup(false);
	// Out of space mid-write: the `nth` descriptor write of the next attempt fails.
	const failWrites = (nth = 1) => {
		let writes = 0;
		vi.mocked(fs.writeFileSync).mockImplementation((target, ...rest) => {
			if (typeof target === "number" && ++writes === nth) throw failure("ENOSPC");
			return actual.writeFileSync(target, ...rest);
		});
	};
	failWrites();
	expect(() => claimTranscript(file)).toThrow(expect.objectContaining({ code: "ENOSPC" }));
	expect(actual.readdirSync(dir)).toEqual(["child.jsonl"]);
	// The next attempt is not refused by anything the failed one left.
	vi.mocked(fs.writeFileSync).mockImplementation(actual.writeFileSync);
	claimTranscript(file).release();

	// The same during a takeover's lock: the stale claim stays, the next takeover proceeds.
	stubExited();
	stubVerifiedDomain();
	actual.writeFileSync(claimPath, holderBody(EXITED_PID));
	// The first write is the fresh publish that meets the stale claim; the second is the lock.
	failWrites(2);
	expect(() => claimTranscript(file)).toThrow(expect.objectContaining({ code: "ENOSPC" }));
	expect(actual.readdirSync(dir).sort()).toEqual(["child.jsonl", "child.jsonl.writer"]);
	vi.mocked(fs.writeFileSync).mockImplementation(actual.writeFileSync);
	const claim = claimTranscript(file);
	expect(JSON.parse(actual.readFileSync(claimPath, "utf8")).pid).toBe(process.pid);
	claim.release();
});

it("passes a transcript's resolution error other than not-yet-created through", () => {
	const { file } = setup(false);
	vi.mocked(fs.realpathSync).mockImplementation(((path: fs.PathLike) => {
		if (path === file) throw failure("EACCES");
		return actual.realpathSync(path);
	}) as never);
	expect(() => claimTranscript(file)).toThrow(expect.objectContaining({ code: "EACCES" }));
	expect(actual.existsSync(`${file}${WRITER_CLAIM_SUFFIX}`)).toBe(false);
});

it("passes a stat error other than a missing file through the claim and the reopen", () => {
	const { file } = setup(false);
	vi.mocked(fs.statSync).mockImplementation(() => {
		throw failure("EACCES");
	});
	expect(() => claimTranscript(file)).toThrow(expect.objectContaining({ code: "EACCES" }));
	let stats = 0;
	vi.mocked(fs.statSync).mockImplementation(((path: fs.PathLike, ...rest: never[]) => {
		if (++stats === 2) throw failure("EACCES");
		return actual.statSync(path, ...rest);
	}) as never);
	const claims: TranscriptClaim[] = [];
	expect(() => openClaimed(file, claims, () => "never")).toThrow(expect.objectContaining({ code: "EACCES" }));
	for (const claim of claims) claim.release();
});

it("passes a claim read error other than a missing file or a link through", () => {
	const { file, claimPath } = setup(true);
	vi.mocked(fs.openSync).mockImplementation(((path: fs.PathLike, flags: fs.OpenMode) => {
		if (path === claimPath) throw failure("EIO");
		return actual.openSync(path, flags);
	}) as never);
	expect(() => claimTranscript(file)).toThrow(expect.objectContaining({ code: "EIO" }));
});

it("passes a takeover lock probe error through", () => {
	const { file, claimPath } = setup(false);
	vi.mocked(fs.lstatSync).mockImplementation(((path: fs.PathLike) => {
		if (path === `${claimPath}.takeover`) throw failure("EACCES");
		return actual.lstatSync(path);
	}) as never);
	expect(() => claimTranscript(file)).toThrow(expect.objectContaining({ code: "EACCES" }));
});

it("refuses a fresh claim when a takeover lock appears just before it is published", () => {
	const { file, claimPath } = setup(false);
	const lockPath = `${claimPath}.takeover`;
	const refusal = `another process is taking over this child session's stale writer claim, or one crashed doing so; remove ${lockPath} if none is: ${file}`;
	// A taker locks and drops the stale claim after this process's lock probe, then crashes.
	const lockBefore = (nth: number) => {
		let publishes = 0;
		vi.mocked(fs.linkSync).mockImplementation((existing, target) => {
			if (target === claimPath && ++publishes === nth) actual.writeFileSync(lockPath, "{}");
			if (target === claimPath && publishes < nth) throw failure("EEXIST");
			return actual.linkSync(existing, target);
		});
	};
	lockBefore(1);
	expect(() => claimTranscript(file)).toThrow(refusal);
	// Only the claim this process just published is dropped; the lock stays for whoever owns it.
	expect(actual.existsSync(claimPath)).toBe(false);
	expect(actual.existsSync(lockPath)).toBe(true);
	// The same on the retry after a holder released between the create and the read.
	actual.unlinkSync(lockPath);
	lockBefore(2);
	expect(() => claimTranscript(file)).toThrow(refusal);
	expect(actual.existsSync(claimPath)).toBe(false);
});

it("publishes in place on a volume without hard links, never leaving a partial claim of its own", () => {
	const { dir, file, claimPath } = setup(false);
	const unreadable = `child session is in use (unreadable writer claim; remove ${claimPath}`;
	// exFAT and friends: an exclusive create works, a link does not.
	vi.mocked(fs.linkSync).mockImplementation(() => {
		throw failure("ENOTSUP");
	});
	const claim = claimTranscript(file);
	expect(JSON.parse(actual.readFileSync(claimPath, "utf8"))).toMatchObject({ pid: process.pid });
	expect(actual.readdirSync(dir).sort()).toEqual(["child.jsonl", "child.jsonl.writer"]);
	expect(() => claimTranscript(file)).toThrow(`writer claim held by pid ${process.pid} (this process)`);
	claim.release();
	expect(actual.readdirSync(dir)).toEqual(["child.jsonl"]);
	// A claim cut short (a writer that crashed mid-write) refuses: it cannot name its holder.
	actual.writeFileSync(claimPath, holderBody(EXITED_PID).slice(0, 12));
	expect(() => claimTranscript(file)).toThrow(unreadable);
	actual.unlinkSync(claimPath);

	// Out of space in place: the partial claim this call created is removed.
	const failInPlace = (then: () => void) => {
		vi.mocked(fs.writeFileSync).mockImplementation((target, ...rest) => {
			if (typeof target === "number" && actual.existsSync(claimPath)) {
				then();
				throw failure("ENOSPC");
			}
			return actual.writeFileSync(target, ...rest);
		});
	};
	failInPlace(() => {});
	expect(() => claimTranscript(file)).toThrow(expect.objectContaining({ code: "ENOSPC" }));
	expect(actual.readdirSync(dir)).toEqual(["child.jsonl"]);
	// Replaced meanwhile by another process's claim: that one is not this call's to remove.
	failInPlace(() => {
		actual.unlinkSync(claimPath);
		actual.writeFileSync(claimPath, holderBody(process.ppid));
	});
	expect(() => claimTranscript(file)).toThrow(expect.objectContaining({ code: "ENOSPC" }));
	expect(actual.readFileSync(claimPath, "utf8")).toBe(holderBody(process.ppid));
	actual.unlinkSync(claimPath);
	// Already gone: nothing to remove.
	failInPlace(() => actual.unlinkSync(claimPath));
	expect(() => claimTranscript(file)).toThrow(expect.objectContaining({ code: "ENOSPC" }));
	expect(actual.readdirSync(dir)).toEqual(["child.jsonl"]);

	// Any other error creating it passes through.
	vi.mocked(fs.writeFileSync).mockImplementation(actual.writeFileSync);
	vi.mocked(fs.openSync).mockImplementation(((path: fs.PathLike, flags: fs.OpenMode) => {
		if (path === claimPath && flags === "wx") throw failure("EACCES");
		return actual.openSync(path, flags);
	}) as never);
	expect(() => claimTranscript(file)).toThrow(expect.objectContaining({ code: "EACCES" }));
});

it("takes over a stale claim on a volume without hard links", () => {
	const { file, claimPath } = setup(true);
	vi.mocked(fs.linkSync).mockImplementation(() => {
		throw failure("EOPNOTSUPP");
	});
	const claim = claimTranscript(file);
	expect(JSON.parse(actual.readFileSync(claimPath, "utf8")).pid).toBe(process.pid);
	expect(actual.existsSync(`${claimPath}.takeover`)).toBe(false);
	claim.release();
});

it("reads a claim swapped for another file between its lstat and its open as unreadable", () => {
	const { dir, file, claimPath } = setup(true);
	// The claim it inspects names a live holder; the one swapped in, a gone one.
	actual.writeFileSync(claimPath, holderBody(process.ppid));
	const swapped = join(dir, "swapped");
	actual.writeFileSync(swapped, holderBody(EXITED_PID));
	vi.mocked(fs.openSync).mockImplementation(((path: fs.PathLike, flags: fs.OpenMode) => {
		if (path === claimPath && actual.existsSync(swapped)) actual.renameSync(swapped, claimPath);
		return actual.openSync(path, flags);
	}) as never);
	expect(() => claimTranscript(file)).toThrow(`child session is in use (unreadable writer claim; remove ${claimPath}`);
	expect(actual.readFileSync(claimPath, "utf8")).toBe(holderBody(EXITED_PID));

	// Swapped for a link instead: the no-follow open refuses it where the platform has one.
	actual.writeFileSync(claimPath, holderBody(process.ppid));
	const link = join(dir, "link");
	actual.symlinkSync(join(dir, "elsewhere"), link);
	let linked = false;
	vi.mocked(fs.openSync).mockImplementation(((path: fs.PathLike, flags: fs.OpenMode) => {
		if (path === claimPath && !linked) {
			linked = true;
			actual.renameSync(link, claimPath);
		}
		return actual.openSync(path, flags);
	}) as never);
	expect(() => claimTranscript(file)).toThrow(`child session is in use (unreadable writer claim; remove ${claimPath}`);
});

it("never opens a linked claim where the platform cannot open without following links", () => {
	const { dir, file, claimPath } = setup(true);
	// Windows: no `O_NOFOLLOW`, so an open would follow the link to a gone holder's claim.
	const real = join(dir, "real-claim");
	actual.renameSync(claimPath, real);
	actual.symlinkSync(real, claimPath);
	const noFollow = fs.constants.O_NOFOLLOW;
	Reflect.deleteProperty(fs.constants, "O_NOFOLLOW");
	onTestFinished(() => {
		Object.assign(fs.constants, { O_NOFOLLOW: noFollow });
	});
	expect(() => claimTranscript(file)).toThrow(`child session is in use (unreadable writer claim; remove ${claimPath}`);
	expect(vi.mocked(fs.openSync).mock.calls.filter(([path]) => path === claimPath)).toEqual([]);
	expect(actual.readlinkSync(claimPath)).toBe(real);
});
