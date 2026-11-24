import { randomUUID } from "node:crypto";
import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExhaustionMark, ExhaustionTracker } from "./exhaustion.ts";
import type { UsageMeter, UsageService, UsageSnapshot, UsageSpanSource, UsageWindow } from "./usage.ts";

// The boundary test exercises this limit against the real /stats reader.
export const MAX_VIEW_BYTES = 1024 * 1024;
const MAX_PROVIDER_BYTES = MAX_VIEW_BYTES / 4;

async function ensureDirectory(path: string): Promise<void> {
	await mkdir(path, { recursive: true, mode: 0o700 });
	if (!(await lstat(path)).isDirectory()) throw new Error("Expected a router state directory");
}

/** Publish only a complete view. Never follow a symlink at the destination. */
async function writeView(dir: string, json: string): Promise<void> {
	const temp = join(dir, `.view-${randomUUID()}.tmp`);
	try {
		await writeFile(temp, json, { mode: 0o600, flag: "wx" });
		await rename(temp, join(dir, "view.json"));
	} finally {
		await rm(temp, { force: true });
	}
}

function bucketFields({
	name,
	families,
	basis,
	spanSource,
	resetAt,
	resetRule,
}: UsageWindow<UsageSpanSource> | UsageMeter) {
	return { name, families, basis, spanSource, resetAt, resetRule: resetRule && { timeZone: resetRule.timeZone } };
}

/** Only fields consumed by /stats go on disk. The v1 RPC still uses the original snapshots. */
function snapshotFields(snapshot: UsageSnapshot) {
	const { status, retrievedAt, expiresAt, windows, meters, pools } = snapshot;
	return {
		snapshot: {
			status,
			retrievedAt,
			expiresAt,
			windows: windows.map((window) => ({ ...bucketFields(window), usedPercent: window.usedPercent })),
		},
		meters: meters?.map((meter) => ({
			...bucketFields(meter),
			quantity: {
				unit: meter.quantity.unit,
				used: meter.quantity.used,
				limit: meter.quantity.limit,
				remaining: meter.quantity.remaining,
			},
		})),
		pools: pools?.map(({ name, unit, balance, unlimited }) => ({ name, unit, balance, unlimited })),
	};
}

function displayName(usage: UsageService, snapshot: UsageSnapshot): string {
	try {
		const full = usage.displayForSnapshot(snapshot)?.full;
		if (typeof full === "string" && full.trim()) return full.slice(0, 256);
	} catch {
		// A broken display accessor should not suppress quota data.
	}
	return snapshot.provider;
}

/** Give each provider a separate budget; overflow in readings must not suppress current marks. */
function encodeView(usage: UsageService, snapshots: UsageSnapshot[], marks: ExhaustionMark[]): string {
	const readings = new Map(snapshots.map((snapshot) => [snapshot.provider, snapshot]));
	const providers = new Set([...readings.keys(), ...marks.map(({ provider }) => provider)]);
	const rows: string[] = [];
	let bytes = 2; // Array delimiters.
	for (const provider of providers) {
		const reading = readings.get(provider);
		const base = {
			provider,
			display: { full: reading ? displayName(usage, reading) : provider },
			marks: marks
				.filter((mark) => mark.provider === provider)
				.map(({ window, families, until, evidence }) => ({ window, families, until, evidence })),
		};
		let row = JSON.stringify(reading ? { ...base, ...snapshotFields(reading) } : base);
		if (Buffer.byteLength(row) > MAX_PROVIDER_BYTES) {
			if (base.marks.length === 0) continue;
			row = JSON.stringify(base);
		}
		const size = Buffer.byteLength(row);
		const cost = size + Number(rows.length > 0);
		if (size > MAX_PROVIDER_BYTES || bytes + cost > MAX_VIEW_BYTES) continue;
		rows.push(row);
		bytes += cost;
	}
	return `[${rows.join(",")}]`;
}

/** Process-local publication queue for one agent directory. */
export interface ViewStore {
	/** Queue a best-effort write of the current cache and marks, coalescing concurrent updates. */
	schedule(): Promise<void>;
	/** Wait for queued work, without scheduling another write. */
	flush(): Promise<void>;
}

/** Coalesce updates from the process-wide router; disk failures must not affect routing. */
export function bindViewStore(agentDir: string, usage: UsageService, tracker: ExhaustionTracker): ViewStore {
	const root = join(agentDir, "router-state");
	const dir = join(root, "v1");
	let published = false;
	let dirty = false;
	let pending: Promise<void> | undefined;
	const drain = async (): Promise<void> => {
		while (dirty) {
			dirty = false;
			try {
				await ensureDirectory(root);
				await ensureDirectory(dir);
				const json = encodeView(usage, usage.cachedSnapshots(), tracker.active());
				// A cold process must not erase another process's view. After writing real
				// data, this process can clear its last row (e.g. after /router reset).
				if (json === "[]" && !published) continue;
				await writeView(dir, json);
				published = true;
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
	return { schedule, flush: () => pending ?? Promise.resolve() };
}
