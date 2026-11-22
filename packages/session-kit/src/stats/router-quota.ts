import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { duration } from "./format.ts";
import { asRecordOf } from "./harness/common.ts";
import { QUOTA_DIM_AFTER_MS, type QuotaRow } from "./quota.ts";

type Fields = Record<string, unknown>;
const MAX_VIEW_BYTES = 1024 * 1024;
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown): value is string => typeof value === "string";
const number = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const timestamp = (value: unknown): value is number => number(value) && Math.abs(value) <= 8.64e15;
function basis(value: unknown, reported: "reported" | "read" = "reported"): QuotaRow["basis"] {
	if (value === "observed" || value === "inferred") return value;
	return value === undefined || value === reported ? "reported" : undefined;
}

function label(provider: string, families: unknown, window: string): string {
	const models = list(families).filter(text).join(", ");
	return `${provider}${models ? `/${models}` : ""} ${window}`;
}

/** Stale rows say so in their label, so dimming is never the only signal and print output carries it too. */
const staleName = (name: string, old: boolean): string => (old ? `${name} (stale)` : name);

function resetDetail(window: Fields, now: number): string | undefined {
	if (!timestamp(window.resetAt)) return undefined;
	if (window.resetAt <= now) return `reset ${duration(now - window.resetAt)} ago, no newer reading`;
	const zone = asRecordOf(window.resetRule).timeZone;
	if (text(zone)) {
		try {
			const time = new Intl.DateTimeFormat("en-US", {
				timeZone: zone,
				hour: "2-digit",
				minute: "2-digit",
				hourCycle: "h23",
				timeZoneName: "shortGeneric",
			}).format(window.resetAt);
			return `resets ${time}`;
		} catch {
			// An invalid time zone does not invalidate the absolute reset timestamp.
		}
	}
	return `resets in ${duration(window.resetAt - now)}`;
}

function meterText(value: unknown): string | undefined {
	const { unit, used, limit, remaining } = asRecordOf(value);
	const quantity = (n: number): string => (unit === "usd" ? `$${n.toFixed(2)}` : String(n));
	if (unit !== "requests" && unit !== "tokens" && unit !== "usd" && unit !== "credits") return undefined;
	const suffix = unit === "usd" ? "" : ` ${unit}`;
	if (number(used)) return `${quantity(used)}${number(limit) ? `/${quantity(limit)}` : ""}${suffix}`;
	return number(remaining) ? `${quantity(remaining)}${suffix} left` : undefined;
}

/** Project the ProviderView wire data, without requiring the router package or persisting its rows. */
function projectViews(value: unknown, now: number): QuotaRow[] {
	const rows: QuotaRow[] = [];
	for (const view of list(value).map(asRecordOf)) {
		if (!text(view.provider)) continue;
		const display = asRecordOf(view.display).full;
		const provider = text(display) ? display : view.provider;
		const snapshot = asRecordOf(view.snapshot);
		const old =
			snapshot.status === "stale" ||
			(timestamp(snapshot.expiresAt) && snapshot.expiresAt <= now) ||
			(timestamp(snapshot.retrievedAt) && now - snapshot.retrievedAt > QUOTA_DIM_AFTER_MS);
		const start = rows.length;
		const read = snapshot.status === "available" || snapshot.status === "stale";
		if (read) {
			for (const window of list(snapshot.windows).map(asRecordOf)) {
				const utilization = basis(window.basis);
				if (!text(window.name) || !number(window.usedPercent) || utilization === undefined) continue;
				const expired = timestamp(window.resetAt) && window.resetAt <= now;
				const source = window.spanSource;
				const name = source === "assumed" || source === "inferred" ? `${window.name} (${source} span)` : window.name;
				rows.push({
					label: label(provider, window.families, staleName(name, old)),
					head: expired ? { kind: "text", text: "" } : { kind: "gauge", percent: window.usedPercent },
					basis: utilization,
					reset: resetDetail(window, now),
					expired,
					old,
				});
			}
		}
		// One staleness predicate for every row kind: an aged snapshot without windows still says so.
		if (snapshot.status === "error" || (read && old && rows.length === start)) {
			rows.push({
				label: provider,
				head: { kind: "text", text: `quota read ${snapshot.status === "error" ? "error" : "stale"}` },
				expired: false,
				old: true,
			});
		}
		for (const meter of list(view.meters).map(asRecordOf)) {
			if (!text(meter.name) || (timestamp(meter.resetAt) && meter.resetAt <= now)) continue;
			const count = meterText(meter.quantity);
			const utilization = basis(meter.basis);
			if (count === undefined || utilization === undefined) continue;
			rows.push({
				label: label(provider, meter.families, staleName(meter.name, old)),
				head: { kind: "text", text: count },
				basis: utilization,
				reset: resetDetail(meter, now),
				expired: false,
				old,
			});
		}
		for (const pool of list(view.pools).map(asRecordOf)) {
			if (!text(pool.name) || (pool.unit !== "credits" && pool.unit !== "usd")) continue;
			const balance = meterText({ unit: pool.unit, used: pool.balance });
			if (pool.unlimited !== true && balance === undefined) continue;
			rows.push({
				label: `${provider} ${staleName(pool.name, old)}`,
				head: { kind: "text", text: pool.unlimited === true ? "unlimited balance" : `${balance} balance` },
				expired: false,
				old,
			});
		}
		for (const mark of list(view.marks).map(asRecordOf)) {
			if (!text(mark.window) || !timestamp(mark.until) || mark.until <= now) continue;
			const evidence = basis(mark.evidence, "read");
			if (evidence === undefined) continue;
			const until = new Date(mark.until)
				.toISOString()
				.replace("T", " ")
				.replace(/:\d\d\.\d{3}Z$/, " UTC");
			rows.push({
				label: label(provider, mark.families, mark.window),
				head: { kind: "text", text: `blocked until ${until}` },
				basis: evidence,
				expired: false,
				old: false,
			});
		}
	}
	return rows;
}

/** Optional local view. Missing, oversized, unreadable and malformed files contribute no rows. */
export async function readRouterQuota(agentDir: string, now: number): Promise<QuotaRow[]> {
	try {
		const file = await open(
			join(agentDir, "router-state", "v1", "view.json"),
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
		try {
			const info = await file.stat();
			if (!info.isFile() || info.size > MAX_VIEW_BYTES) return [];
			const buffer = Buffer.alloc(MAX_VIEW_BYTES + 1);
			let offset = 0;
			// Short reads do not establish EOF, and the file can grow after stat.
			while (offset < buffer.length) {
				const { bytesRead } = await file.read({ buffer, offset, length: buffer.length - offset, position: offset });
				if (bytesRead === 0) return projectViews(JSON.parse(buffer.toString("utf8", 0, offset)), now);
				offset += bytesRead;
			}
			return [];
		} finally {
			await file.close();
		}
	} catch {
		return [];
	}
}
