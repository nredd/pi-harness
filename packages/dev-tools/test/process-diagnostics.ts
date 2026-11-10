/**
 * Failure diagnostics for the real-host `resource_snapshot` smoke. The published sampler swallows the errno behind each
 * lost process field and reports only a coverage reason code, so a bare "missing process metadata" cannot say which
 * host read failed. This names the code, prints the raw samples, and re-probes the same host reads so a fresh CI
 * failure (e.g. an ephemeral WSL runner) is self-explaining.
 */

import { opendir, readFile, readlink, stat } from "node:fs/promises";
import type { ResourceSnapshot } from "@nredd/pi-resource-sampler";

/** What each sampler coverage reason means in terms of the host read that produced it. */
export const REASON_MEANING: Readonly<Record<string, string>> = {
	"process-collection-unavailable":
		"the whole process listing failed (Linux /proc opendir/readdir iterator threw, e.g. a PID exiting mid-listing, or the Darwin ps read failed)",
	"process-unreadable-or-changed":
		"a per-PID read failed (/proc/<pid>/stat, statm or exe unreadable, or the PID exited)",
	deadline: "the scan budget elapsed before the listing finished",
	"byte-limit": "the scan byte budget was exhausted",
	"file-byte-limit": "a single /proc file or exe target exceeded its byte cap",
	"pid-limit": "more PIDs than the scan cap",
	"command-unavailable": "the ps helper could not be spawned",
	"command-failed": "the ps helper exited non-zero",
	"malformed-process-row": "a process row could not be parsed",
	"clock-ticks-unavailable": "the Linux clock tick rate could not be read",
	"unsupported-platform": "process metadata is unsupported on this platform",
};

/** Outcome of one independent host read: its path and either a value summary or the failing errno. */
export interface ProbeResult {
	readonly step: string;
	readonly ok: boolean;
	readonly detail: string;
}

/** Host reads, injectable so the diagnostic path is testable without a failing host. */
export interface HostProbes {
	readonly platform: NodeJS.Platform;
	readonly pid: number;
	/** Entry count via `opendir` iteration, the sampler's listing mechanism (its implicit lstat can reject mid-listing). */
	readonly countDir: (path: string) => Promise<number>;
	readonly readlink: (path: string) => Promise<string>;
	readonly stat: (path: string) => Promise<unknown>;
	readonly readFile: (path: string) => Promise<string>;
}

export const realProbes: HostProbes = {
	platform: process.platform,
	pid: process.pid,
	countDir: async (path) => {
		let count = 0;
		for await (const _entry of await opendir(path)) count++;
		return count;
	},
	readlink: (path) => readlink(path),
	stat: (path) => stat(path),
	readFile: (path) => readFile(path, "utf8"),
};

function errnoOf(error: unknown): string {
	if (error instanceof Error) {
		const code = (error as NodeJS.ErrnoException).code;
		const syscall = (error as NodeJS.ErrnoException).syscall;
		return [code, syscall, error.message].filter((part) => part !== undefined).join(" ");
	}
	return String(error);
}

async function probe(step: string, read: () => Promise<string>): Promise<ProbeResult> {
	try {
		return { step, ok: true, detail: await read() };
	} catch (error) {
		return { step, ok: false, detail: errnoOf(error) };
	}
}

/** Re-run the reads the Linux sampler depends on, against this process, keeping each errno. Empty off Linux. */
export async function probeHost(probes: HostProbes = realProbes): Promise<ProbeResult[]> {
	if (probes.platform !== "linux") return [];
	const self = `/proc/${probes.pid}`;
	return Promise.all([
		probe("opendir /proc", async () => `${await probes.countDir("/proc")} entries`),
		probe(`readlink ${self}/exe`, async () => `-> ${await probes.readlink(`${self}/exe`)}`),
		probe(`stat ${self}`, async () => {
			await probes.stat(self);
			return "ok";
		}),
		probe(`read ${self}/stat`, async () => `${(await probes.readFile(`${self}/stat`)).length} bytes`),
		probe(`read ${self}/statm`, async () => `${(await probes.readFile(`${self}/statm`)).length} bytes`),
		probe("read /proc/stat", async () => `${(await probes.readFile("/proc/stat")).length} bytes`),
	]);
}

/** Multi-line, human-readable account of why process metadata was missing, for a failing assertion message. */
export async function describeProcessLoss(
	field: string,
	unavailableReason: string,
	samples: readonly ResourceSnapshot[],
	probes: HostProbes = realProbes,
): Promise<string> {
	const lines = [`missing process metadata: field \`${field}\`: ${unavailableReason}`];
	samples.forEach((sample, index) => {
		const reasons = sample.coverage.reasons;
		lines.push(
			`scan ${index}: ${sample.processes.length} processes, coverage ${JSON.stringify(sample.coverage)}`,
			...reasons.map((reason) => `  reason \`${reason}\`: ${REASON_MEANING[reason] ?? "unknown to this harness"}`),
		);
	});
	if (samples.length === 0) lines.push("no sampler scan completed");
	const results = await probeHost(probes);
	if (results.length > 0) {
		lines.push("independent host probes (same reads the sampler makes, with errno kept):");
		for (const result of results) {
			lines.push(`  ${result.ok ? "ok  " : "FAIL"} ${result.step}: ${result.detail}`);
		}
	}
	lines.push(`raw samples: ${JSON.stringify(samples)}`);
	return lines.join("\n");
}

/** Name the first per-process field that violates the contract, or `undefined`. */
export function firstBadProcessField(
	entries: readonly { pid: number; executable: string; rssBytes: number; parentPid: number }[],
): { field: string; pid: number; value: unknown } | undefined {
	for (const entry of entries) {
		if (entry.executable.includes("/")) return { field: "executable", pid: entry.pid, value: entry.executable };
		if (!Number.isFinite(entry.rssBytes) || entry.rssBytes < 0) {
			return { field: "rssBytes", pid: entry.pid, value: entry.rssBytes };
		}
		if (!Number.isInteger(entry.parentPid) || entry.parentPid < 0) {
			return { field: "parentPid", pid: entry.pid, value: entry.parentPid };
		}
	}
	return undefined;
}
