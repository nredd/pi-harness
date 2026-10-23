/** Deterministic ResourceSnapshot v1 fixture, type-checked against the published package's export. */
import type { ResourceSnapshot } from "@nredd/pi-resource-sampler";

export function resourceFixture(platform: "linux" | "darwin" = "linux", cpuPercent = 36.2) {
	return {
		version: 1 as const,
		platform,
		wallTimeMs: 1_000,
		monotonicTimeMs: 10_000,
		durationMs: 12,
		cpu: { state: "available" as const, value: cpuPercent },
		logicalCpus: 12,
		loadAverage: [3.21, 2.43, 1.98],
		memory: { totalBytes: 24 * 1024 ** 3, freeBytes: 13.6 * 1024 ** 3 },
		processes: Array.from({ length: 40 }, (_, i) => ({
			pid: 1000 + i,
			parentPid: 1,
			identity: `${1000 + i}:start-1`,
			// Deliberately unlike any real executable, so fixture renders cannot pass for host data.
			name: `fixture-${["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"][i % 8]}`,
			cpu:
				platform === "darwin"
					? { state: "unavailable" as const, reason: "Darwin process start identity has only second precision" }
					: i === 39
						? { state: "warming" as const, reason: "No previous process counter" }
						: { state: "available" as const, value: 148.3 / (i + 1) },
			rssBytes: (640 / (i + 1)) * 1024 ** 2,
		})),
		coverage: { complete: true, enumerated: 40, sampled: 40, skipped: 0, bytesRead: 2000, reasons: [] as string[] },
		pressure: { source: "unsupported" as const, reason: "Not part of this display fixture" },
	} satisfies ResourceSnapshot;
}
