/** Read-only, privacy-safe host resource observation for choosing test and build scope. */

import { readFile } from "node:fs/promises";
import { availableParallelism, freemem, loadavg, platform, totalmem } from "node:os";
import { basename } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type RunOptions, type RunResult, run, toolResult } from "../core/index.ts";

const DEFAULT_PROCESS_LIMIT = 12;
const MAX_PROCESS_LIMIT = 50;
const COMMAND_TIMEOUT_MS = 3_000;
const COMMAND_MAX_BYTES = 128 * 1024;

type ProcessRun = (options: RunOptions) => Promise<RunResult>;
type ReadText = (path: string) => Promise<string>;

/** Test seams for OS primitives. Omitted fields use the local host. */
export interface ResourceSnapshotOptions {
	platform?: () => NodeJS.Platform;
	availableParallelism?: () => number;
	loadavg?: () => number[];
	totalmem?: () => number;
	freemem?: () => number;
	readFile?: ReadText;
	run?: ProcessRun;
}

type Unavailable = { status: "unavailable"; reason: string };
type Available<T> = T & { status: "available" };

type ProcessEntry = { pid: number; cpuPercent: number; rssBytes: number; elapsed: string; executable: string };

type Snapshot = {
	platform: string;
	cpu: { logicalCpus: number; loadAverage: [number, number, number] | null };
	memory: Available<{
		totalBytes: number;
		freeBytes: number;
		availableBytes: number | null;
		pressure: { source: "memory_pressure" | "linux-psi"; value: number } | null;
	}>;
	processes: Available<{ limit: number; entries: ProcessEntry[] }> | Unavailable;
};

const defaultOptions = {
	platform,
	availableParallelism,
	loadavg,
	totalmem,
	freemem,
	readFile: (path: string) => readFile(path, "utf8"),
	run,
};

function parseLinuxAvailable(text: string): number | null {
	const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(text);
	return match?.[1] === undefined ? null : Number(match[1]) * 1024;
}

function parsePsiSomeAvg10(text: string): number | null {
	const match = /^some\s+avg10=(\d+(?:\.\d+)?)/m.exec(text);
	return match?.[1] === undefined ? null : Number(match[1]);
}

function parseMacFreePercent(text: string): number | null {
	const match = /^System-wide memory free percentage:\s+(\d+)%$/m.exec(text);
	return match?.[1] === undefined ? null : Number(match[1]);
}

function parseProcesses(text: string, limit: number): ProcessEntry[] {
	const entries: ProcessEntry[] = [];
	for (const line of text.split("\n")) {
		const match = /^\s*(\d+)\s+(\d+(?:\.\d+)?)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
		if (!match?.[1] || !match[2] || !match[3] || !match[4] || !match[5]) continue;
		const pid = Number(match[1]);
		const cpuPercent = Number(match[2]);
		const rssKiB = Number(match[3]);
		if (![pid, cpuPercent, rssKiB].every(Number.isFinite)) continue;
		entries.push({ pid, cpuPercent, rssBytes: rssKiB * 1024, elapsed: match[4], executable: basename(match[5]) });
	}
	return entries
		.sort((left, right) => right.cpuPercent - left.cpuPercent || right.rssBytes - left.rssBytes || left.pid - right.pid)
		.slice(0, limit);
}

async function collectMemory(
	options: Required<ResourceSnapshotOptions>,
	hostPlatform: NodeJS.Platform,
): Promise<Snapshot["memory"]> {
	const memory = {
		status: "available" as const,
		totalBytes: options.totalmem(),
		freeBytes: options.freemem(),
		availableBytes: null as number | null,
		pressure: null as { source: "memory_pressure" | "linux-psi"; value: number } | null,
	};
	try {
		if (hostPlatform === "linux") {
			memory.availableBytes = parseLinuxAvailable(await options.readFile("/proc/meminfo"));
			const pressure = parsePsiSomeAvg10(await options.readFile("/proc/pressure/memory"));
			if (pressure !== null) memory.pressure = { source: "linux-psi", value: pressure };
		} else if (hostPlatform === "darwin") {
			const result = await options.run({
				cmd: "memory_pressure",
				args: ["-Q"],
				timeoutMs: COMMAND_TIMEOUT_MS,
				maxBytes: COMMAND_MAX_BYTES,
			});
			const pressure = result.exitCode === 0 ? parseMacFreePercent(result.stdout) : null;
			if (pressure !== null) memory.pressure = { source: "memory_pressure", value: pressure };
		}
	} catch {
		// Base memory figures remain useful; optional pressure metrics are honestly absent.
	}
	return memory;
}

async function collectProcesses(
	options: Required<ResourceSnapshotOptions>,
	hostPlatform: NodeJS.Platform,
	limit: number,
): Promise<Snapshot["processes"]> {
	if (hostPlatform !== "darwin" && hostPlatform !== "linux") {
		return { status: "unavailable", reason: `bounded process metadata is unsupported on ${hostPlatform}` };
	}
	const args =
		hostPlatform === "darwin"
			? ["-A", "-r", "-o", "pid=,pcpu=,rss=,etime=,comm="]
			: ["-A", "--sort=-pcpu", "-o", "pid=,pcpu=,rss=,etime=,comm="];
	try {
		const result = await options.run({ cmd: "ps", args, timeoutMs: COMMAND_TIMEOUT_MS, maxBytes: COMMAND_MAX_BYTES });
		if (result.exitCode !== 0 || result.timedOut || result.aborted || result.spawnError) {
			return { status: "unavailable", reason: "process metadata command unavailable" };
		}
		return { status: "available", limit, entries: parseProcesses(result.stdout, limit) };
	} catch {
		return { status: "unavailable", reason: "process metadata command unavailable" };
	}
}

/** Collect a bounded snapshot without arguments, environments, or process-to-agent attribution. */
export async function resourceSnapshot(limit: number, overrides: ResourceSnapshotOptions = {}): Promise<Snapshot> {
	const options: Required<ResourceSnapshotOptions> = { ...defaultOptions, ...overrides };
	const hostPlatform = options.platform();
	const cpu = {
		logicalCpus: options.availableParallelism(),
		loadAverage: hostPlatform === "win32" ? null : (options.loadavg() as [number, number, number]),
	};
	return {
		platform: hostPlatform,
		cpu,
		memory: await collectMemory(options, hostPlatform),
		processes: await collectProcesses(options, hostPlatform, limit),
	};
}

function formatSnapshot(snapshot: Snapshot): string {
	const cpu = snapshot.cpu.loadAverage
		? `${snapshot.cpu.logicalCpus} logical CPUs, load ${snapshot.cpu.loadAverage.map((value) => value.toFixed(2)).join("/")}`
		: `${snapshot.cpu.logicalCpus} logical CPUs, load unavailable`;
	const memory = `${(snapshot.memory.freeBytes / 2 ** 30).toFixed(1)} GiB free of ${(snapshot.memory.totalBytes / 2 ** 30).toFixed(1)} GiB`;
	const pressure = snapshot.memory.pressure
		? `, ${snapshot.memory.pressure.source} ${snapshot.memory.pressure.value}${snapshot.memory.pressure.source === "memory_pressure" ? "% free" : "% avg10"}`
		: "";
	const processes =
		snapshot.processes.status === "available"
			? `${snapshot.processes.entries.length} bounded entries (pid cpu% RSS elapsed executable)${snapshot.processes.entries.length > 0 ? `\n${snapshot.processes.entries.map((entry) => `${entry.pid} ${entry.cpuPercent.toFixed(1)} ${entry.rssBytes} ${entry.elapsed} ${entry.executable}`).join("\n")}` : ""}`
			: `unavailable (${snapshot.processes.reason})`;
	return `host ${snapshot.platform}: CPU ${cpu}; memory ${memory}${pressure}; processes ${processes}. No arguments, environments, or process-to-agent attribution are collected.`;
}

/** Register the model-visible observer. */
export function registerResourceTools(pi: ExtensionAPI, options: ResourceSnapshotOptions = {}): void {
	pi.registerTool({
		name: "resource_snapshot",
		label: "resource snapshot",
		description:
			"Read-only bounded host snapshot for resource awareness before a known large test or compile. Reports CPU count/load, memory availability and available pressure metrics, plus up to 50 busiest process metadata entries (pid, CPU, RSS, elapsed, executable only). It never returns command arguments or environments and cannot attribute OS processes to agents. Use it to choose scope, workers or timing; it makes no scheduling, locking or concurrency change.",
		promptSnippet:
			"Inspect current host resources and bounded process metadata before a known large test or compile; use it for awareness only, not process-to-agent attribution",
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		parameters: Type.Object({
			process_limit: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: MAX_PROCESS_LIMIT,
					description: `Busiest process metadata entries to return. Default ${DEFAULT_PROCESS_LIMIT}.`,
				}),
			),
		}),
		outputSchema: Type.Object({
			platform: Type.String(),
			cpu: Type.Object({
				logicalCpus: Type.Number(),
				loadAverage: Type.Union([Type.Tuple([Type.Number(), Type.Number(), Type.Number()]), Type.Null()]),
			}),
			memory: Type.Object({
				status: Type.Literal("available"),
				totalBytes: Type.Number(),
				freeBytes: Type.Number(),
				availableBytes: Type.Union([Type.Number(), Type.Null()]),
				pressure: Type.Union([
					Type.Object({
						source: Type.Union([Type.Literal("memory_pressure"), Type.Literal("linux-psi")]),
						value: Type.Number(),
					}),
					Type.Null(),
				]),
			}),
			processes: Type.Union([
				Type.Object({
					limit: Type.Number(),
					status: Type.Literal("available"),
					entries: Type.Array(
						Type.Object({
							pid: Type.Number(),
							cpuPercent: Type.Number(),
							rssBytes: Type.Number(),
							elapsed: Type.String(),
							executable: Type.String(),
						}),
					),
				}),
				Type.Object({ status: Type.Literal("unavailable"), reason: Type.String() }),
			]),
		}),
		async execute(_id, params) {
			const snapshot = await resourceSnapshot(params.process_limit ?? DEFAULT_PROCESS_LIMIT, options);
			return toolResult({ text: formatSnapshot(snapshot), structured: snapshot });
		},
	});
}
