/** Production /mon source: a thin mapping over the published shared sampler. No collector lives here. */
import {
	createResourceSampler,
	type ResourceSampler,
	type ResourceSnapshot,
	type SamplerOptions,
} from "@nredd/pi-resource-sampler";
import type { MonSnapshot } from "./model.ts";
import type { MonSource } from "./poll.ts";

/** Bounded so a notice line stays readable even with many coverage reasons. */
const MAX_REASONS = 3;
/** macOS keeps at most this many bytes of the executable name (`p_comm`). */
const DARWIN_NAME_BYTES = 16;
/** Skips every Linux scan expects: kernel threads have no RSS, and processes exit mid-scan. */
const ROUTINE_SKIP = "process-unreadable-or-changed";
const REASONS: Readonly<Record<string, string>> = {
	deadline: "time budget",
	"pid-limit": "process cap",
	"byte-limit": "read budget",
	"file-byte-limit": "read budget",
	[ROUTINE_SKIP]: "unreadable or exited",
	"command-unavailable": "ps unavailable",
	"command-failed": "ps failed",
	"malformed-process-row": "unparsed rows",
	"process-collection-unavailable": "process list unavailable",
};
const utf8 = new TextEncoder();

function finite(value: number): number | null {
	return Number.isFinite(value) ? value : null;
}

/** Every observed process lacks interval CPU by platform design, not because it is warming. */
function processCpuUnavailable(snapshot: ResourceSnapshot): boolean {
	return snapshot.processes.length > 0 && snapshot.processes.every((p) => p.cpu.state === "unavailable");
}

function nameState(snapshot: ResourceSnapshot, name: string): "unknown" | "truncated" | undefined {
	if (name === "") return "unknown";
	return snapshot.platform === "darwin" && utf8.encode(name).length >= DARWIN_NAME_BYTES ? "truncated" : undefined;
}

/** Limits that hide data the user would expect: budget caps, collector failures, unavailable host CPU. */
function notice(snapshot: ResourceSnapshot, baseline: boolean): string | undefined {
	const parts: string[] = [];
	const { coverage } = snapshot;
	const limits = coverage.reasons.filter((reason) => reason !== ROUTINE_SKIP);
	if (!coverage.complete && (limits.length || !coverage.reasons.length)) {
		const reasons = [...new Set(coverage.reasons.map((reason) => REASONS[reason] ?? reason))];
		const text = reasons.slice(0, MAX_REASONS).join(", ") || "unknown";
		parts.push(`Partial list: ${coverage.sampled} of ${coverage.enumerated} seen (${text})`);
	}
	if (snapshot.cpu.state === "unavailable") parts.push("Host CPU unavailable");
	// The first observation is always a baseline; persistent warming (e.g. frozen counters) is explained.
	else if (snapshot.cpu.state === "warming" && !baseline) parts.push(`Host CPU warming: ${snapshot.cpu.reason}`);
	return parts.length ? parts.join(" · ") : undefined;
}

/** Expected platform limits, stated once so `--` and `(unknown)` are never mistaken for zero or a bug. */
function hint(snapshot: ResourceSnapshot): string | undefined {
	const parts: string[] = [];
	const { coverage } = snapshot;
	if (!coverage.complete && coverage.reasons.length && coverage.reasons.every((reason) => reason === ROUTINE_SKIP))
		parts.push(`${coverage.enumerated - coverage.sampled} skipped: kernel threads, exited or unreadable`);
	const unknown = snapshot.processes.filter((p) => p.name === "").length;
	if (unknown) parts.push(`${unknown} ${unknown === 1 ? "name" : "names"} unknown (no access, e.g. other users)`);
	if (processCpuUnavailable(snapshot))
		parts.push(snapshot.platform === "darwin" ? "macOS: process CPU unavailable (see ?)" : "Process CPU unavailable");
	return parts.length ? parts.join(" · ") : undefined;
}

/**
 * Map one typed sampler snapshot without inventing zeros for warming/unavailable values.
 * `baseline` marks a source's first observation, whose warming CPU needs no explanation.
 */
export function toMonSnapshot(snapshot: ResourceSnapshot, baseline = true): MonSnapshot {
	const total = finite(snapshot.memory.totalBytes);
	const free = finite(snapshot.memory.freeBytes);
	const text = notice(snapshot, baseline);
	const note = hint(snapshot);
	return {
		cpuPercent: snapshot.cpu.state === "available" ? finite(snapshot.cpu.value) : null,
		logicalCpus: snapshot.logicalCpus,
		memoryUsedBytes: total !== null && total > 0 && free !== null ? Math.max(0, total - free) : null,
		memoryTotalBytes: total !== null && total > 0 ? total : null,
		load: snapshot.loadAverage,
		processes: snapshot.processes.map((p) => {
			const state = nameState(snapshot, p.name);
			return {
				identity: p.identity,
				pid: p.pid,
				name: p.name,
				...(state ? { nameState: state } : {}),
				cpuPercent: p.cpu.state === "available" ? finite(p.cpu.value) : null,
				rssBytes: finite(p.rssBytes),
			};
		}),
		capturedAt: snapshot.wallTimeMs,
		sampledAtMs: snapshot.monotonicTimeMs,
		scanMs: finite(snapshot.durationMs),
		// A resolved sample is a successful collection, whatever its CPU state.
		status: "live",
		cpuState: snapshot.cpu.state,
		...(processCpuUnavailable(snapshot) ? { processCpu: "unavailable" as const } : {}),
		...(text ? { notice: text } : {}),
		...(note ? { hint: note } : {}),
	};
}

/** One sampler per open interaction; its baseline and child cleanup end with the view. */
export function createSamplerSource(
	create: (options?: SamplerOptions) => ResourceSampler = createResourceSampler,
): MonSource {
	const sampler = create();
	let observed = 0;
	return {
		sample: async (signal) => toMonSnapshot(await sampler.sample(signal), observed++ === 0),
		dispose: () => sampler.dispose(),
	};
}
