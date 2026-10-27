import { spawn } from "node:child_process";
import { open, opendir, readlink } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import {
	darwinMemory,
	darwinProcess,
	darwinSwap,
	executableName,
	linuxRss,
	linuxStat,
	type ProcessCounter,
	psi,
} from "./counters.js";
import { darwinNativeProcesses } from "./darwin.js";
import type { ResourceSnapshot } from "./types.js";

/** Linux PATH_MAX: Node (libuv `pathconf`) and Bun (`PathBuffer`) readlink buffer size on Linux. */
const LINK_BUFFER_BYTES = 4096;

/** Per-scan mutable budget, never shared between sampler instances. */
export class Budget {
	bytesRead = 0;
	enumerated = 0;
	skipped = 0;
	readonly reasons = new Set<string>();
	/**
	 * Initialize one scan's limits.
	 * @param deadline Absolute monotonic deadline in milliseconds.
	 * @param maxBytes Maximum captured/charged bytes.
	 * @param maxPids Maximum enumerated PIDs.
	 * @param signal Caller-owned cancellation signal.
	 */
	constructor(
		readonly deadline: number,
		readonly maxBytes: number,
		readonly maxPids: number,
		readonly signal: AbortSignal,
	) {}
	/** @returns Remaining admission milliseconds; throws when cancelled. */
	remaining(): number {
		this.signal.throwIfAborted();
		return Math.max(0, this.deadline - performance.now());
	}
	/** @returns Whether time/bytes remain, recording exhausted limits; throws when cancelled. */
	ready(): boolean {
		if (this.remaining() <= 0) this.reasons.add("deadline");
		if (this.bytesRead >= this.maxBytes) this.reasons.add("byte-limit");
		return this.remaining() > 0 && this.bytesRead < this.maxBytes;
	}
	/**
	 * Read a fixed-size proc file and always await handle closure.
	 * @param path Fixed proc file path for an admitted PID or pressure source.
	 * @returns Complete UTF-8 contents; rejects on exhaustion/truncation/read failure/abort.
	 */
	async read(path: string): Promise<string> {
		if (!this.ready()) throw new Error("budget exhausted");
		const capacity = Math.min(8192, this.maxBytes - this.bytesRead);
		const file = await open(path, "r");
		try {
			if (!this.ready()) throw new Error("budget exhausted while opening proc file");
			const buffer = Buffer.alloc(capacity);
			const { bytesRead } = await file.read(buffer, 0, capacity, 0);
			this.bytesRead += bytesRead;
			this.signal.throwIfAborted();
			if (bytesRead === capacity) {
				this.reasons.add("file-byte-limit");
				throw new Error("proc file may be truncated");
			}
			return buffer.toString("utf8", 0, bytesRead);
		} finally {
			await file.close();
		}
	}
	/**
	 * Linux executable basename, or "" when the exe link is unreadable (other users' processes without
	 * ptrace read access, exited processes), over budget or possibly truncated. Errors carry no detail
	 * outward. Node and Bun cannot cap readlink below their fixed PATH_MAX buffer, so the length is only
	 * known after the syscall: a target beyond the remaining budget is charged the remainder and dropped,
	 * keeping `bytesRead <= maxBytes`. Node returns a full buffer silently truncated, so that is dropped too.
	 * @param path Admitted PID's /proc/PID/exe link path.
	 * @returns Safe basename, or empty string when unavailable; aborts propagate.
	 */
	async executable(path: string): Promise<string> {
		if (!this.ready()) return "";
		let target: Buffer;
		try {
			target = await readlink(path, { encoding: "buffer" });
		} catch {
			this.signal.throwIfAborted();
			return "";
		}
		this.signal.throwIfAborted();
		const remaining = this.maxBytes - this.bytesRead;
		if (target.length > remaining) {
			this.bytesRead = this.maxBytes;
			this.reasons.add("byte-limit");
			return "";
		}
		this.bytesRead += target.length;
		if (target.length >= LINK_BUFFER_BYTES) {
			this.reasons.add("file-byte-limit");
			return "";
		}
		return executableName(target.toString("utf8"));
	}
}

/**
 * Run a fixed helper with bounded capture, kill on cancellation/deadline and await close/reaping.
 * @param executable Fixed absolute OS helper path.
 * @param args Fixed helper arguments, never target process arguments.
 * @param budget Shared admission and capture accounting.
 * @param maxLines Maximum complete stdout rows to admit.
 * @returns Captured text and whether the command completed without truncation/failure.
 */
export async function command(
	executable: string,
	args: string[],
	budget: Budget,
	maxLines = Number.POSITIVE_INFINITY,
): Promise<{ text: string; complete: boolean }> {
	if (!budget.ready()) return { text: "", complete: false };
	return new Promise((resolve) => {
		const child = spawn(executable, args, {
			stdio: ["ignore", "pipe", "pipe"],
			env: { LC_ALL: "C", PATH: "/usr/bin:/bin" },
		});
		const buffers: Buffer[] = [];
		let complete = true;
		let lines = 0;
		/**
		 * Terminate the helper and mark capture incomplete.
		 * @param reason Coverage reason to record.
		 * @returns Nothing; completion still waits for close.
		 */
		const stop = (reason: string) => {
			complete = false;
			budget.reasons.add(reason);
			child.kill("SIGKILL");
		};
		/** @returns Nothing; terminate the helper after shared cancellation. */
		const abort = () => stop("cancelled");
		const timer = setTimeout(() => stop("deadline"), budget.remaining());
		budget.signal.addEventListener("abort", abort, { once: true });
		// Close the race between the ready check and listener registration.
		if (budget.signal.aborted) abort();
		child.stdout.on("data", (data: Buffer) => {
			if (!complete) return;
			const remaining = budget.maxBytes - budget.bytesRead;
			const kept = data.subarray(0, remaining);
			budget.bytesRead += kept.length;
			let end = kept.length;
			for (let i = 0; i < kept.length; i++) {
				if (kept[i] === 10 && ++lines > maxLines) {
					end = i + 1;
					stop("pid-limit");
					break;
				}
			}
			buffers.push(kept.subarray(0, end));
			if (data.length >= remaining) stop("byte-limit");
		});
		child.stderr.on("data", (data: Buffer) => {
			const remaining = budget.maxBytes - budget.bytesRead;
			budget.bytesRead += Math.min(remaining, data.length);
			if (data.length >= remaining) stop("byte-limit");
		});
		child.on("error", () => {
			complete = false;
			budget.reasons.add("command-unavailable");
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			budget.signal.removeEventListener("abort", abort);
			if (code !== 0 && complete) {
				complete = false;
				budget.reasons.add("command-failed");
			}
			let text = Buffer.concat(buffers).toString("utf8");
			if (!complete) text = text.slice(0, text.lastIndexOf("\n") + 1);
			resolve({ text, complete });
		});
	});
}

/**
 * Scan Linux sequentially and close the directory even on cancellation.
 * @param budget Shared scan limits and cancellation.
 * @param hz Host CLK_TCK rate in ticks per second.
 * @returns Validated identity-bracketed process counters; aborts propagate.
 */
export async function linuxProcesses(budget: Budget, hz: number): Promise<ProcessCounter[]> {
	const result: ProcessCounter[] = [];
	const directory = await opendir("/proc");
	for await (const entry of directory) {
		if (!/^\d+$/.test(entry.name)) continue;
		if (!budget.ready()) break;
		if (budget.enumerated >= budget.maxPids) {
			budget.reasons.add("pid-limit");
			break;
		}
		budget.enumerated++;
		try {
			const path = `/proc/${entry.name}`;
			const first = linuxStat(await budget.read(`${path}/stat`), hz, performance.now());
			if (!first) throw new Error("process incomplete");
			const name = await budget.executable(`${path}/exe`);
			const rssBytes = linuxRss(await budget.read(`${path}/status`));
			const last = linuxStat(await budget.read(`${path}/stat`), hz, performance.now());
			// The name and RSS reads sit between two stat reads, so PID reuse rejects both.
			if (!last || first.pid !== Number(entry.name) || first.identity !== last.identity || rssBytes === null)
				throw new Error("process changed or incomplete");
			result.push({ ...last, name, rssBytes });
		} catch {
			budget.signal.throwIfAborted();
			budget.skipped++;
			budget.reasons.add("process-unreadable-or-changed");
		}
	}
	return result;
}

/**
 * Fixed metadata-only ps format. `ucomm` prints kinfo `p_comm`, never `comm`: `ps -c -o comm` shows the
 * basename of argv[0], which any launcher picks and Node's `process.title` rewrites in place.
 * @param budget Shared helper/native scan limits and cancellation.
 * @returns Bounded fallback rows enriched with accessible native metrics; aborts propagate.
 */
export async function darwinProcesses(budget: Budget): Promise<ProcessCounter[]> {
	const { text } = await command(
		"/bin/ps",
		["-A", "-o", "pid=,ppid=,lstart=,time=,rss=,ucomm="],
		budget,
		budget.maxPids,
	);
	const result: ProcessCounter[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		if (budget.enumerated >= budget.maxPids) {
			budget.reasons.add("pid-limit");
			break;
		}
		budget.enumerated++;
		const parsed = darwinProcess(line, performance.now());
		if (parsed) result.push(parsed);
		else {
			budget.skipped++;
			budget.reasons.add("malformed-process-row");
		}
	}
	return darwinNativeProcesses(result, budget);
}

/**
 * Run fixed metadata-only helpers sharing the process deadline, cap and awaited reaping.
 * @param budget Shared helper capture budget and cancellation.
 * @param total Host physical RAM in bytes.
 * @returns Explicit available/unavailable host usage and swap metrics.
 */
export async function darwinHostMemory(
	budget: Budget,
	total: number,
): Promise<Pick<ResourceSnapshot["memory"], "usage" | "swap">> {
	const vm = await command("/usr/bin/vm_stat", [], budget);
	const usage = vm.complete ? darwinMemory(vm.text, total) : null;
	const swap = await command("/usr/sbin/sysctl", ["vm.swapusage"], budget);
	const parsedSwap = swap.complete ? darwinSwap(swap.text) : null;
	return {
		usage: usage
			? { state: "available", value: usage }
			: { state: "unavailable", reason: "vm_stat invalid, unavailable or over budget" },
		swap: parsedSwap
			? { state: "available", value: parsedSwap }
			: { state: "unavailable", reason: "swapusage invalid, unavailable or over budget" },
	};
}

/**
 * Collect optional platform-specific PSI; absence is not zero pressure.
 * @param budget Shared file-read budget and cancellation.
 * @param platform Host platform identifier.
 * @returns Linux PSI availability or explicit unsupported state; aborts propagate.
 */
export async function pressure(budget: Budget, platform: string): Promise<ResourceSnapshot["pressure"]> {
	if (platform !== "linux")
		return { source: "unsupported", reason: "no comparable native PSI metric on this platform" };
	try {
		const value = psi(await budget.read("/proc/pressure/memory"));
		if (value) return { source: "linux-psi", memory: { state: "available", value } };
	} catch {
		budget.signal.throwIfAborted();
	}
	return {
		source: "linux-psi",
		memory: { state: "unavailable", reason: "PSI absent, invalid or scan budget exhausted" },
	};
}
