/** Exclusive writer claims on child transcripts (#1247), in-process and across real processes. */
import { type ChildProcessWithoutNullStreams, execFileSync, spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	linkSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	renameSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { makeTestTempDir } from "@nredd/pi-test-lib/temp-dir";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
	claimHost,
	claimTranscript,
	heldClaimRefusal,
	openClaimed,
	pidDomainOf,
	TAKEOVER_SUFFIX,
	type TranscriptClaim,
	WRITER_CLAIM_SUFFIX,
	writerClaimHolder,
} from "../src/transcript-claim.ts";
import { EXITED_PID, holderBody, stubExited, writeHolder } from "./fixtures/writer-claim.ts";

const CHILD = new URL("./fixtures/transcript-claim-child.ts", import.meta.url).pathname;
/** A pid `stubExited` answers `EPERM` for: alive, not ours to signal. */
const FOREIGN_PID = EXITED_PID + 1;

/** A pid this host just saw exit. Only the real two-process tests use one; the rest stub `kill`. */
function exitedPid(): number {
	const pid = spawnSync(process.execPath, ["-e", ""]).pid;
	if (pid === undefined) throw new Error("no pid");
	return pid;
}

function transcript(): { dir: string; file: string; claimPath: string } {
	// Canonical, as claims are: a temp root behind a symlink (macOS `/var`) would not compare equal.
	const dir = realpathSync(makeTestTempDir("transcript-claim-", onTestFinished));
	const file = join(dir, "child.jsonl");
	writeFileSync(file, '{"type":"session"}\n');
	return { dir, file, claimPath: `${file}${WRITER_CLAIM_SUFFIX}` };
}

describe("pidDomainOf", () => {
	it("names the PID namespace and boot on Linux and the platform elsewhere", () => {
		const fail = () => {
			throw new Error("not read");
		};
		expect(pidDomainOf("darwin", fail, fail)).toBe("darwin");
		expect(pidDomainOf("win32", fail, fail)).toBe("win32");
		expect(
			pidDomainOf(
				"linux",
				(path) => `${path === "/proc/self/ns/pid" ? "pid:[4026531836]" : "?"}`,
				(path) => Buffer.from(path === "/proc/sys/kernel/random/boot_id" ? "b00t\n" : "?"),
			),
		).toBe("pid:[4026531836] boot b00t");
		// Unreadable (a locked-down /proc): unknown, so never taken over automatically.
		expect(pidDomainOf("linux", fail, () => "b00t")).toBeUndefined();
		expect(claimHost.pidDomain()).toBe(pidDomainOf(process.platform, readlinkSync, readFileSync));
	});
});

describe("claimTranscript", () => {
	it("holds the transcript for one writer at a time, in this process too", () => {
		const { file, claimPath } = transcript();
		const claim = claimTranscript(file);
		expect(claim.file).toBe(file);
		expect(JSON.parse(readFileSync(claimPath, "utf8"))).toMatchObject({
			pid: process.pid,
			host: hostname(),
			domain: claimHost.pidDomain(),
		});
		expect(() => claimTranscript(file)).toThrow(
			`child session is in use (writer claim held by pid ${process.pid} (this process)): ${file}`,
		);
		claim.release();
		expect(existsSync(claimPath)).toBe(false);
		claimTranscript(file).release();
	});

	it("covers every spelling of one transcript with one claim", () => {
		const { dir, file } = transcript();
		const alias = join(dir, "alias");
		symlinkSync(dir, alias, "dir");
		const claim = claimTranscript(join(alias, "child.jsonl"));
		expect(claim.file).toBe(file);
		expect(() => claimTranscript(file)).toThrow("child session is in use");
		claim.release();
	});

	it("refuses a transcript with a second hard link, which would get a claim of its own", () => {
		const { dir, file, claimPath } = transcript();
		const other = join(dir, "other.jsonl");
		linkSync(file, other);
		for (const name of [file, other]) {
			expect(() => claimTranscript(name)).toThrow(
				`cannot establish writer ownership of child session with 2 hard links: ${name}`,
			);
		}
		expect(existsSync(claimPath)).toBe(false);
	});

	it("claims a transcript that is not on disk yet, never one a dangling link names", () => {
		const { dir } = transcript();
		const fresh = join(dir, "fresh.jsonl");
		const claim = claimTranscript(fresh);
		expect(claim.file).toBe(fresh);
		expect(existsSync(`${fresh}${WRITER_CLAIM_SUFFIX}`)).toBe(true);
		claim.release();
		// Publishing leaves nothing but the transcript behind: no staging file.
		expect(readdirSync(dir)).toEqual(["child.jsonl"]);
		const dangling = join(dir, "dangling.jsonl");
		symlinkSync(join(dir, "nowhere.jsonl"), dangling);
		expect(() => claimTranscript(dangling)).toThrow(`cannot establish writer ownership of child session: ${dangling}`);
	});

	it("never releases a claim it no longer holds", () => {
		const { file, claimPath } = transcript();
		const claim = claimTranscript(file);
		writeHolder(claimPath, process.ppid);
		claim.release();
		expect(existsSync(claimPath)).toBe(true);
	});

	it("refuses a live holder, another host and an unreadable claim", () => {
		stubExited(FOREIGN_PID);
		const { file, claimPath } = transcript();
		writeHolder(claimPath, process.ppid);
		expect(() => claimTranscript(file)).toThrow(
			`child session is in use (writer claim held by pid ${process.ppid}): ${file}`,
		);
		// Not ours to signal (EPERM): alive.
		writeHolder(claimPath, FOREIGN_PID);
		expect(() => claimTranscript(file)).toThrow(
			`child session is in use (writer claim held by pid ${FOREIGN_PID}): ${file}`,
		);
		writeHolder(claimPath, EXITED_PID, { host: `not-${hostname()}` });
		expect(() => claimTranscript(file)).toThrow(/on host not-.*; remove .*child\.jsonl\.writer once it has exited/);
		for (const raw of ["", "{", "null", '{"pid":0,"host":"h"}', '{"pid":1.5,"host":"h"}', '{"pid":7}']) {
			writeFileSync(claimPath, raw);
			expect(() => claimTranscript(file)).toThrow(
				`child session is in use (unreadable writer claim; remove ${claimPath}`,
			);
		}
		expect(readFileSync(claimPath, "utf8")).toBe('{"pid":7}');
	});

	it("never takes over a gone pid from another or an unknown PID namespace", () => {
		stubExited();
		const { file, claimPath } = transcript();
		const refusal = `child session is in use (writer claim held by pid ${EXITED_PID} in another or unknown PID namespace; remove ${claimPath} once it has exited): ${file}`;
		// Another container sharing this host name and session directory: its pid is invisible here.
		writeHolder(claimPath, EXITED_PID, { domain: "pid:[4026532999] boot other" });
		expect(() => claimTranscript(file)).toThrow(refusal);
		// A claim that names no domain, or a process that cannot read its own.
		writeHolder(claimPath, EXITED_PID, { domain: undefined });
		expect(() => claimTranscript(file)).toThrow(refusal);
		writeHolder(claimPath, EXITED_PID);
		const domain = vi.spyOn(claimHost, "pidDomain").mockReturnValue(undefined);
		onTestFinished(() => domain.mockRestore());
		expect(() => claimTranscript(file)).toThrow(refusal);
		expect(writerClaimHolder(file)).toContain("in another or unknown PID namespace");
		domain.mockRestore();
		claimTranscript(file).release();
	});

	it("reads a link, a FIFO, a directory or an oversized file as an unreadable claim", () => {
		const { dir, file, claimPath } = transcript();
		const unreadable = `child session is in use (unreadable writer claim; remove ${claimPath}`;
		const real = join(dir, "real-claim");
		writeFileSync(real, holderBody(EXITED_PID));
		symlinkSync(real, claimPath);
		expect(() => claimTranscript(file)).toThrow(unreadable);
		renameSync(claimPath, join(dir, "moved-link"));
		writeFileSync(claimPath, `${holderBody(process.ppid)}${" ".repeat(4096)}`);
		expect(() => claimTranscript(file)).toThrow(unreadable);
		renameSync(claimPath, join(dir, "big"));
		mkdirSync(claimPath);
		expect(() => claimTranscript(file)).toThrow(unreadable);
	});

	// No mkfifo on Windows.
	it.skipIf(process.platform === "win32")("never blocks on a FIFO planted as the claim", () => {
		const { file, claimPath } = transcript();
		execFileSync("mkfifo", [claimPath]);
		expect(() => claimTranscript(file)).toThrow(
			`child session is in use (unreadable writer claim; remove ${claimPath}`,
		);
		expect(writerClaimHolder(file)).toContain("unreadable writer claim");
	});

	it("takes over a claim whose holder on this host and PID namespace has exited", () => {
		stubExited();
		const { file, claimPath } = transcript();
		writeHolder(claimPath, EXITED_PID);
		expect(writerClaimHolder(file)).toBeUndefined();
		const claim = claimTranscript(file);
		expect(JSON.parse(readFileSync(claimPath, "utf8")).pid).toBe(process.pid);
		expect(existsSync(`${claimPath}${TAKEOVER_SUFFIX}`)).toBe(false);
		claim.release();
	});

	it("refuses while a takeover lock exists, in progress or left by a crash", () => {
		stubExited();
		const { file, claimPath } = transcript();
		const lockPath = `${claimPath}${TAKEOVER_SUFFIX}`;
		const refusal = `another process is taking over this child session's stale writer claim, or one crashed doing so; remove ${lockPath} if none is: ${file}`;
		writeHolder(claimPath, EXITED_PID);
		writeFileSync(lockPath, "{}");
		expect(() => claimTranscript(file)).toThrow(refusal);
		expect(existsSync(claimPath)).toBe(true);
		// A crash between dropping the stale claim and publishing its own: only the lock is left.
		renameSync(claimPath, join(file, "..", "kept"));
		expect(() => claimTranscript(file)).toThrow(refusal);
		expect(existsSync(claimPath)).toBe(false);
		expect(existsSync(lockPath)).toBe(true);
	});

	it("refuses a path it cannot resolve and passes other I/O errors through", () => {
		expect(() => claimTranscript("relative.jsonl")).toThrow(
			"cannot establish writer ownership of child session: relative.jsonl",
		);
		expect(heldClaimRefusal("relative.jsonl")).toBe(
			"child session is in use (cannot establish writer ownership): relative.jsonl",
		);
		const { dir, file } = transcript();
		// The parent "directory" is a regular file: ENOTDIR, not a refusal.
		expect(() => claimTranscript(join(file, "child.jsonl"))).toThrow(expect.objectContaining({ code: "ENOTDIR" }));
		expect(() => heldClaimRefusal(join(file, "child.jsonl"))).toThrow(expect.objectContaining({ code: "ENOTDIR" }));
		// A link loop is not a transcript that does not exist yet.
		const loop = join(dir, "loop.jsonl");
		symlinkSync(loop, loop);
		expect(() => claimTranscript(loop)).toThrow(expect.objectContaining({ code: "ELOOP" }));
		// Nor is a missing directory: its error, not a guess at a path.
		expect(() => claimTranscript(join(dir, "missing", "child.jsonl"))).toThrow(
			expect.objectContaining({ code: "ENOENT" }),
		);
	});

	it("reports a held claim without taking it", () => {
		const { file, claimPath } = transcript();
		expect(heldClaimRefusal(file)).toBeUndefined();
		writeHolder(claimPath, process.ppid);
		expect(heldClaimRefusal(file)).toBe(`child session is in use (writer claim held by pid ${process.ppid}): ${file}`);
		expect(readFileSync(claimPath, "utf8")).toContain(`"pid":${process.ppid}`);
	});
});

describe("openClaimed", () => {
	it("checks and opens under the claim and leaves it to the caller", () => {
		const { file, claimPath } = transcript();
		const claims: TranscriptClaim[] = [];
		const order: string[] = [];
		const opened = openClaimed(
			file,
			claims,
			() => {
				order.push(`open ${existsSync(claimPath)}`);
				return "session";
			},
			() => {
				order.push(`verify ${existsSync(claimPath)}`);
				return undefined;
			},
		);
		expect(opened).toBe("session");
		expect(order).toEqual(["verify true", "open true"]);
		expect(claims.map((claim) => claim.file)).toEqual([file]);
		claims[0]?.release();
	});

	it("refuses before opening when the recheck refuses, still handing back the claim", () => {
		const { file } = transcript();
		const claims: TranscriptClaim[] = [];
		let opened = false;
		expect(() =>
			openClaimed(
				file,
				claims,
				() => {
					opened = true;
				},
				() => "may still be running",
			),
		).toThrow("may still be running");
		expect(opened).toBe(false);
		expect(claims).toHaveLength(1);
		claims[0]?.release();
	});

	it("refuses a transcript replaced or redirected while it was opened", () => {
		const { dir, file } = transcript();
		const replacement = join(dir, "replacement.jsonl");
		writeFileSync(replacement, '{"type":"session"}\n');
		const claims: TranscriptClaim[] = [];
		expect(() => openClaimed(file, claims, () => renameSync(replacement, file))).toThrow(
			`child session changed while it was being reopened: ${file}`,
		);
		for (const claim of claims.splice(0)) claim.release();

		const real = join(dir, "real");
		const other = join(dir, "other");
		mkdirSync(real);
		mkdirSync(other);
		writeFileSync(join(real, "child.jsonl"), "{}\n");
		writeFileSync(join(other, "child.jsonl"), "{}\n");
		const link = join(dir, "link");
		symlinkSync(real, link, "dir");
		const linked = join(link, "child.jsonl");
		expect(() =>
			openClaimed(linked, claims, () => {
				renameSync(link, join(dir, "old-link"));
				symlinkSync(other, link, "dir");
			}),
		).toThrow(`child session changed while it was being reopened: ${linked}`);
		for (const claim of claims.splice(0)) claim.release();
	});

	it("opens the canonical path the claim covers, whatever spelling it was given", () => {
		const { dir, file } = transcript();
		const alias = join(dir, "alias");
		symlinkSync(dir, alias, "dir");
		const claims: TranscriptClaim[] = [];
		expect(openClaimed(join(alias, "child.jsonl"), claims, (canonical) => canonical)).toBe(file);
		for (const claim of claims) claim.release();
	});

	it("passes a missing transcript through to the open", () => {
		const { dir } = transcript();
		const claims: TranscriptClaim[] = [];
		expect(openClaimed(join(dir, "gone.jsonl"), claims, () => "fresh")).toBe("fresh");
		for (const claim of claims) claim.release();
	});
});

/** A real process running the dispatch check, then (on `go`) the claim; see the fixture. */
class Recoverer {
	readonly child: ChildProcessWithoutNullStreams;
	private readonly lines: string[] = [];
	private waiting: (() => void) | undefined;

	constructor(file: string) {
		this.child = spawn(process.execPath, [CHILD, file]);
		createInterface({ input: this.child.stdout }).on("line", (line) => {
			this.lines.push(line);
			this.waiting?.();
		});
		onTestFinished(() => {
			this.child.kill("SIGKILL");
		});
	}

	/** The next line the child writes. */
	async next(): Promise<string> {
		while (this.lines.length === 0) {
			await new Promise<void>((resolve) => {
				this.waiting = resolve;
			});
		}
		return this.lines.shift() as string;
	}

	go(): void {
		this.child.stdin.write("go\n");
	}

	async exit(): Promise<void> {
		if (this.child.exitCode !== null || this.child.signalCode !== null) return;
		await new Promise((resolve) => this.child.once("exit", resolve));
	}
}

describe("two recovering processes", { timeout: 30_000 }, () => {
	/** Both pass the dispatch check first, then both claim; exactly one may write. */
	async function race(file: string): Promise<{ winner: Recoverer; refusals: string[] }> {
		const recoverers = [new Recoverer(file), new Recoverer(file)];
		for (const recoverer of recoverers) expect(await recoverer.next()).toBe("ready free");
		for (const recoverer of recoverers) recoverer.go();
		const outcomes = await Promise.all(recoverers.map((recoverer) => recoverer.next()));
		const winners = recoverers.filter((_, i) => outcomes[i] === "claimed");
		expect(winners, outcomes.join("\n")).toHaveLength(1);
		const refusals = outcomes.filter((outcome) => outcome !== "claimed");
		for (const refusal of refusals) expect(refusal).toMatch(/^refused (child session|another process)/);
		return { winner: winners[0] as Recoverer, refusals };
	}

	it("lets one of two processes write a transcript both judged free", async () => {
		const { file, claimPath } = transcript();
		const { winner, refusals } = await race(file);
		expect(refusals[0]).toMatch(/^refused child session is in use \(/);
		expect(heldClaimRefusal(file)).toBe(
			`child session is in use (writer claim held by pid ${winner.child.pid}): ${file}`,
		);
		winner.child.stdin.end();
		expect(await winner.next()).toBe("released");
		await winner.exit();
		expect(existsSync(claimPath)).toBe(false);
	});

	it("lets one of two processes take over a crashed writer's claim", async () => {
		const { file, claimPath } = transcript();
		writeFileSync(claimPath, holderBody(exitedPid()));
		const { winner } = await race(file);
		expect(JSON.parse(readFileSync(claimPath, "utf8")).pid).toBe(winner.child.pid);
		// The winner crashes too: the claim it leaves is taken over once it is gone.
		winner.child.kill("SIGKILL");
		await winner.exit();
		const claim = claimTranscript(file);
		expect(JSON.parse(readFileSync(claimPath, "utf8")).pid).toBe(process.pid);
		claim.release();
	});
});
