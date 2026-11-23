/** Exclusive writer claims on child transcripts (#1247), in-process and across real processes. */
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { makeTestTempDir } from "@nredd/pi-test-lib/temp-dir";
import { describe, expect, it, onTestFinished } from "vitest";
import {
	claimTranscript,
	heldClaimRefusal,
	openClaimed,
	TAKEOVER_SUFFIX,
	type TranscriptClaim,
	WRITER_CLAIM_SUFFIX,
	writerClaimHolder,
} from "../src/transcript-claim.ts";

const CHILD = new URL("./fixtures/transcript-claim-child.ts", import.meta.url).pathname;

/** A pid this host just saw exit, so `kill(pid, 0)` reports ESRCH. */
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

function writeHolder(claimPath: string, holder: unknown): void {
	writeFileSync(claimPath, typeof holder === "string" ? holder : JSON.stringify(holder));
}

describe("claimTranscript", () => {
	it("holds the transcript for one writer at a time, in this process too", () => {
		const { file, claimPath } = transcript();
		const claim = claimTranscript(file);
		expect(claim.file).toBe(file);
		expect(JSON.parse(readFileSync(claimPath, "utf8"))).toMatchObject({ pid: process.pid, host: hostname() });
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

	it("claims a transcript that is not on disk yet", () => {
		const { dir } = transcript();
		const fresh = join(dir, "fresh.jsonl");
		const claim = claimTranscript(fresh);
		expect(existsSync(`${fresh}${WRITER_CLAIM_SUFFIX}`)).toBe(true);
		claim.release();
	});

	it("never releases a claim it no longer holds", () => {
		const { file, claimPath } = transcript();
		const claim = claimTranscript(file);
		writeHolder(claimPath, { pid: process.ppid, host: hostname() });
		claim.release();
		expect(existsSync(claimPath)).toBe(true);
	});

	it("refuses a live holder, another host and an unreadable claim", () => {
		const { file, claimPath } = transcript();
		writeHolder(claimPath, { pid: process.ppid, host: hostname() });
		expect(() => claimTranscript(file)).toThrow(
			`child session is in use (writer claim held by pid ${process.ppid}): ${file}`,
		);
		// Not ours to signal (EPERM) unless run as root, when it is plainly alive: held either way.
		writeHolder(claimPath, { pid: 1, host: hostname() });
		expect(() => claimTranscript(file)).toThrow(`child session is in use (writer claim held by pid 1): ${file}`);
		writeHolder(claimPath, { pid: exitedPid(), host: `not-${hostname()}` });
		expect(() => claimTranscript(file)).toThrow(/on host not-.*; remove .*child\.jsonl\.writer once it has exited/);
		for (const raw of ["", "{", "null", '{"pid":0,"host":"h"}', '{"pid":1.5,"host":"h"}', '{"pid":7}']) {
			writeHolder(claimPath, raw);
			expect(() => claimTranscript(file)).toThrow(
				`child session is in use (unreadable writer claim; remove ${claimPath}`,
			);
		}
		expect(readFileSync(claimPath, "utf8")).toBe('{"pid":7}');
	});

	it("takes over a claim whose holder on this host has exited", () => {
		const { file, claimPath } = transcript();
		writeHolder(claimPath, { pid: exitedPid(), host: hostname() });
		expect(writerClaimHolder(file)).toBeUndefined();
		const claim = claimTranscript(file);
		expect(JSON.parse(readFileSync(claimPath, "utf8")).pid).toBe(process.pid);
		expect(existsSync(`${claimPath}${TAKEOVER_SUFFIX}`)).toBe(false);
		claim.release();
	});

	it("refuses a takeover while another is in progress, and leaves both files", () => {
		const { file, claimPath } = transcript();
		writeHolder(claimPath, { pid: exitedPid(), host: hostname() });
		writeFileSync(`${claimPath}${TAKEOVER_SUFFIX}`, "{}");
		expect(() => claimTranscript(file)).toThrow(
			`another process is taking over this child session's stale writer claim; remove ${claimPath}${TAKEOVER_SUFFIX} if none is: ${file}`,
		);
		expect(existsSync(claimPath)).toBe(true);
	});

	it("refuses a path it cannot resolve and passes other I/O errors through", () => {
		expect(() => claimTranscript("relative.jsonl")).toThrow(
			"cannot establish writer ownership of child session: relative.jsonl",
		);
		expect(heldClaimRefusal("relative.jsonl")).toBe(
			"child session is in use (cannot establish writer ownership): relative.jsonl",
		);
		const { file } = transcript();
		// The parent "directory" is a regular file: ENOTDIR, not a refusal.
		expect(() => claimTranscript(join(file, "child.jsonl"))).toThrow(expect.objectContaining({ code: "ENOTDIR" }));
		expect(() => heldClaimRefusal(join(file, "child.jsonl"))).toThrow(expect.objectContaining({ code: "ENOTDIR" }));
	});

	it("reports a held claim without taking it", () => {
		const { file, claimPath } = transcript();
		expect(heldClaimRefusal(file)).toBeUndefined();
		writeHolder(claimPath, { pid: process.ppid, host: hostname() });
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
		writeHolder(claimPath, { pid: exitedPid(), host: hostname() });
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
