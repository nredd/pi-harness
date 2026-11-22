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
const basis = (value: unknown): QuotaRow["basis"] =>
	value === "observed" || value === "inferred" ? value : "reported";

function label(provider: string, families: unknown, window: string): string {
	const models = list(families).filter(text).join(", ");
	return `${provider}${models ? `/${models}` : ""} ${window}`;
}

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
		if (snapshot.status === "available" || snapshot.status === "stale") {
			for (const window of list(snapshot.windows).map(asRecordOf)) {
				if (!text(window.name) || !number(window.usedPercent)) continue;
				const expired = timestamp(window.resetAt) && window.resetAt <= now;
				const source = window.spanSource;
				const name = source === "assumed" || source === "inferred" ? `${window.name} (${source} span)` : window.name;
				rows.push({
					label: label(provider, window.families, old ? `${name} (stale)` : name),
					head: expired ? { kind: "text", text: "" } : { kind: "gauge", percent: window.usedPercent },
					basis: basis(window.basis),
					reset: resetDetail(window, now),
					expired,
					old,
				});
			}
		}
		if (snapshot.status === "error" || (snapshot.status === "stale" && rows.length === start)) {
			rows.push({
				label: provider,
				head: { kind: "text", text: `quota read ${snapshot.status}` },
				expired: false,
				old: true,
			});
		}
		for (const meter of list(view.meters).map(asRecordOf)) {
			if (!text(meter.name) || (timestamp(meter.resetAt) && meter.resetAt <= now)) continue;
			const count = meterText(meter.quantity);
			if (count === undefined) continue;
			rows.push({
				label: label(provider, meter.families, meter.name),
				head: { kind: "text", text: count },
				basis: basis(meter.basis),
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
				label: `${provider} ${pool.name}`,
				head: { kind: "text", text: pool.unlimited === true ? "unlimited balance" : `${balance} balance` },
				expired: false,
				old,
			});
		}
		for (const mark of list(view.marks).map(asRecordOf)) {
			if (!text(mark.window) || !timestamp(mark.until) || mark.until <= now) continue;
			const until = new Date(mark.until)
				.toISOString()
				.replace("T", " ")
				.replace(/:\d\d\.\d{3}Z$/, " UTC");
			rows.push({
				label: label(provider, mark.families, mark.window),
				head: { kind: "text", text: `blocked until ${until}` },
				basis: basis(mark.evidence),
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
			if (!info.isFile()) return [];
			const buffer = Buffer.alloc(MAX_VIEW_BYTES + 1);
			const { bytesRead } = await file.read(buffer);
			if (bytesRead > MAX_VIEW_BYTES) return [];
			return projectViews(JSON.parse(buffer.toString("utf8", 0, bytesRead)), now);
		} finally {
			await file.close();
		}
	} catch {
		return [];
	}
}
