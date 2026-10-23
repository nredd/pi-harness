/** Test-only mapping from an actual ResourceSnapshot-shaped fixture; never a production source. */
import type { MonSnapshot } from "../../src/mon/model.ts";
import { resourceFixture } from "./resource-fixture.ts";

export function snapshot(cpuPercent = 36.2, platform: "linux" | "darwin" = "linux"): MonSnapshot {
	const raw = resourceFixture(platform, cpuPercent);
	return {
		cpuPercent: raw.cpu.value,
		logicalCpus: raw.logicalCpus,
		memoryUsedBytes: raw.memory.totalBytes - raw.memory.freeBytes,
		memoryTotalBytes: raw.memory.totalBytes,
		load: raw.loadAverage,
		capturedAt: raw.wallTimeMs,
		sampledAtMs: raw.monotonicTimeMs,
		status: "live",
		cpuState: "available",
		processes: raw.processes.map((p) => ({
			identity: p.identity,
			pid: p.pid,
			name: p.name,
			rssBytes: p.rssBytes,
			cpuPercent: p.cpu.state === "available" ? p.cpu.value : null,
		})),
		...(platform === "darwin" ? { notice: "Process CPU unavailable: macOS identity precision" } : {}),
	};
}
