import { randomUUID } from "node:crypto";
import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { collectorFor } from "./collectors.ts";
import type { ExhaustionTracker } from "./exhaustion.ts";
import type { UsageService } from "./usage.ts";
import { describe, type ProviderDisplay } from "./view.ts";

// Match the /stats reader's byte limit.
const MAX_VIEW_BYTES = 1024 * 1024;

async function ensureDirectory(path: string): Promise<void> {
	await mkdir(path, { recursive: true, mode: 0o700 });
	if (!(await lstat(path)).isDirectory()) throw new Error("Expected a router state directory");
}

/** Publish only a complete view. Never follow a symlink at the destination. */
async function writeView(agentDir: string, json: string): Promise<void> {
	if (Buffer.byteLength(json) > MAX_VIEW_BYTES) return;
	const root = join(agentDir, "router-state");
	const dir = join(root, "v1");
	await ensureDirectory(root);
	await ensureDirectory(dir);
	const temp = join(dir, `.view-${randomUUID()}.tmp`);
	try {
		await writeFile(temp, json, { mode: 0o600, flag: "wx" });
		await rename(temp, join(dir, "view.json"));
	} finally {
		await rm(temp, { force: true });
	}
}

export interface ViewStore {
	schedule(): Promise<void>;
	flush(): Promise<void> | undefined;
}

/** Coalesce updates from the process-wide router; disk failures must not affect routing. */
export function bindViewStore(agentDir: string, usage: UsageService, tracker: ExhaustionTracker): ViewStore {
	let dirty = false;
	let pending: Promise<void> | undefined;
	const drain = async (): Promise<void> => {
		while (dirty) {
			dirty = false;
			try {
				const snapshots = usage.cachedSnapshots();
				const marks = tracker.active();
				const providers = [...new Set([...snapshots, ...marks].map(({ provider }) => provider))];
				const displays = new Map<string, ProviderDisplay>();
				for (const provider of providers) {
					const display = collectorFor(provider)?.display;
					// Persist only the display fields used for labels, not the collector object.
					if (typeof display?.full === "string" && typeof display.compact === "string") {
						displays.set(provider, { full: display.full, compact: display.compact });
					}
				}
				await writeView(agentDir, JSON.stringify(describe(providers, snapshots, marks, displays)));
			} catch {
				// Optional projection. A later cache or mark change can retry.
			}
		}
		pending = undefined;
	};
	const schedule = (): Promise<void> => {
		dirty = true;
		pending ??= Promise.resolve().then(drain);
		return pending;
	};
	usage.subscribe(schedule);
	tracker.subscribe(schedule);
	return { schedule, flush: () => pending };
}
