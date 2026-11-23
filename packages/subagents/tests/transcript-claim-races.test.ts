/**
 * Writer-claim races (#1247) pinned to one interleaving each: another process
 * acting between two filesystem calls, injected at that call.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { makeTestTempDir } from "@nredd/pi-test-lib/temp-dir";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { claimTranscript, openClaimed, type TranscriptClaim, WRITER_CLAIM_SUFFIX } from "../src/transcript-claim.ts";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const readFileSync = vi.fn(actual.readFileSync);
	const writeFileSync = vi.fn(actual.writeFileSync);
	const statSync = vi.fn(actual.statSync);
	const spies = { readFileSync, writeFileSync, statSync };
	return { ...actual, default: { ...actual, ...spies }, ...spies };
});

afterEach(() => {
	vi.mocked(fs.readFileSync).mockReset();
	vi.mocked(fs.writeFileSync).mockReset();
	vi.mocked(fs.statSync).mockReset();
});

/** The real implementation, restored on the spy after a reset. */
const actual = await vi.importActual<typeof import("node:fs")>("node:fs");

function setup(stale: boolean): { file: string; claimPath: string } {
	vi.mocked(fs.readFileSync).mockImplementation(actual.readFileSync as never);
	vi.mocked(fs.writeFileSync).mockImplementation(actual.writeFileSync);
	vi.mocked(fs.statSync).mockImplementation(actual.statSync as never);
	const dir = actual.realpathSync(makeTestTempDir("transcript-claim-race-", onTestFinished));
	const file = join(dir, "child.jsonl");
	actual.writeFileSync(file, "{}\n");
	const claimPath = `${file}${WRITER_CLAIM_SUFFIX}`;
	// A pid this host just saw exit, so `kill(pid, 0)` reports ESRCH.
	if (stale)
		actual.writeFileSync(
			claimPath,
			JSON.stringify({ pid: spawnSync(process.execPath, ["-e", ""]).pid, host: hostname() }),
		);
	return { file, claimPath };
}

const exists = () => Object.assign(new Error("EEXIST: file already exists"), { code: "EEXIST" });

/** Make exclusive creates of `path` fail as if another process had just won them, `times` times. */
function loseCreates(path: string, times: number): void {
	let lost = 0;
	vi.mocked(fs.writeFileSync).mockImplementation((target, ...rest) => {
		if (target === path && lost < times) {
			lost++;
			throw exists();
		}
		return actual.writeFileSync(target, ...rest);
	});
}

it("refuses a takeover when the stale claim changes before it is replaced", () => {
	const { file, claimPath } = setup(true);
	let reads = 0;
	vi.mocked(fs.readFileSync).mockImplementation(((path: fs.PathOrFileDescriptor, options?: never) => {
		if (path === claimPath && ++reads === 2) return JSON.stringify({ pid: process.ppid, host: hostname() });
		return actual.readFileSync(path, options);
	}) as never);
	expect(() => claimTranscript(file)).toThrow(
		`child session's writer claim changed while it was being taken over; retry: ${file}`,
	);
	// The claim it judged stale is left for whoever replaced it, and the lock is gone.
	expect(actual.existsSync(claimPath)).toBe(true);
	expect(actual.existsSync(`${claimPath}.takeover`)).toBe(false);
});

it("refuses a takeover another process wins between the unlink and the create", () => {
	const { file, claimPath } = setup(true);
	// The first create meets the stale claim for real; the one after the unlink loses.
	let creates = 0;
	vi.mocked(fs.writeFileSync).mockImplementation((target, ...rest) => {
		if (target === claimPath && ++creates === 2) throw exists();
		return actual.writeFileSync(target, ...rest);
	});
	expect(() => claimTranscript(file)).toThrow(`child session was claimed by another process during takeover: ${file}`);
	expect(actual.existsSync(`${claimPath}.takeover`)).toBe(false);
});

it("claims a transcript whose holder released it between the create and the read", () => {
	const { file, claimPath } = setup(false);
	loseCreates(claimPath, 1);
	const claim = claimTranscript(file);
	expect(JSON.parse(actual.readFileSync(claimPath, "utf8")).pid).toBe(process.pid);
	claim.release();
});

it("refuses when a third process claims it in that same gap", () => {
	const { file, claimPath } = setup(false);
	loseCreates(claimPath, 2);
	expect(() => claimTranscript(file)).toThrow(`child session was claimed by another process; retry: ${file}`);
});

it("passes a stat error other than a missing file through the reopen", () => {
	const { file } = setup(false);
	vi.mocked(fs.statSync).mockImplementation(() => {
		throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
	});
	const claims: TranscriptClaim[] = [];
	expect(() => openClaimed(file, claims, () => "never")).toThrow(expect.objectContaining({ code: "EACCES" }));
	for (const claim of claims) claim.release();
});
