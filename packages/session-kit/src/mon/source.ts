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

function finite(value: number): number | null {
	return Number.isFinite(value) ? value : null;
}

/** Every observed process lacks interval CPU by platform design, not because it is warming. */
function processCpuUnavailable(snapshot: ResourceSnapshot): boolean {
	return snapshot.processes.length > 0 && snapshot.processes.every((p) => p.cpu.state === "unavailable");
}

/** Explain coverage and unavailable metrics in one bounded line; reasons are sampler-owned constants. */
function notice(snapshot: ResourceSnapshot, baseline: boolean): string | undefined {
	const parts: string[] = [];
	const { coverage } = snapshot;
	if (!coverage.complete) {
		const reasons = coverage.reasons.slice(0, MAX_REASONS).join(", ") || "unknown";
		parts.push(`Partial: ${coverage.sampled} of ${coverage.enumerated} seen processes (${reasons})`);
	}
	if (snapshot.cpu.state === "unavailable") parts.push("Host CPU unavailable");
	// The first observation is always a baseline; persistent warming (e.g. frozen counters) is explained.
	else if (snapshot.cpu.state === "warming" && !baseline) parts.push(`Host CPU warming: ${snapshot.cpu.reason}`);
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
	return {
		cpuPercent: snapshot.cpu.state === "available" ? finite(snapshot.cpu.value) : null,
		logicalCpus: snapshot.logicalCpus,
		memoryUsedBytes: total !== null && total > 0 && free !== null ? Math.max(0, total - free) : null,
		memoryTotalBytes: total !== null && total > 0 ? total : null,
		load: snapshot.loadAverage,
		processes: snapshot.processes.map((p) => ({
			identity: p.identity,
			pid: p.pid,
			name: p.name,
			cpuPercent: p.cpu.state === "available" ? finite(p.cpu.value) : null,
			rssBytes: finite(p.rssBytes),
		})),
		capturedAt: snapshot.wallTimeMs,
		scanMs: finite(snapshot.durationMs),
		status: snapshot.cpu.state === "warming" ? "warming" : "live",
		...(processCpuUnavailable(snapshot) ? { processCpu: "unavailable" as const } : {}),
		...(text ? { notice: text } : {}),
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
