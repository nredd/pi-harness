/** Release gate against the host's real shared estimator, never an injected pricing stub. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as modelApi from "@earendil-works/pi-ai/models";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createValuer, type PricingModel, valuation } from "../../src/stats/pricing.ts";
import { exportStats, importStats, loadCombined, makeSnapshot } from "../../src/stats/snapshot.ts";
import { call } from "./fixtures.ts";

const available = typeof Reflect.get(modelApi, "estimateTokenCost") === "function";
const date = "2026-11-12";
const assessment = {
	status: "verified",
	source: "https://example.test/pricing",
	checkedAt: date,
	unit: "usd-per-million-tokens",
	conditions: "Synthetic Standard token baseline",
};
const rates = { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, cacheWrite1h: 4, cacheWrite12h: 5 };
const model: PricingModel = {
	provider: "example-provider",
	id: "physical",
	cost: {
		...rates,
		assessment,
		tiers: [
			{
				inputTokensAbove: 100,
				input: 4,
				output: 15,
				cacheRead: 0.2,
				cacheWrite: 5,
				cacheWrite1h: 8,
				cacheWrite12h: 10,
			},
		],
	},
};
const event = call(date, model.provider, model.id, 0, 0, { cost: 99 });
const roots: string[] = [];
beforeEach(() => {
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden in offline pricing gate"));
});
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// nredd/pi-harness#799: legacy hosts intentionally show unknown; a coherent release MUST supply core46.
it("requires the matching shared estimator when release admission is requested", () => {
	if (process.env.PI_PRICING_CORE_REQUIRED === "1")
		expect(available, "Matching core estimator is required before releasing current-rate pricing").toBe(true);
	if (process.env.PI_EXPECT_BUN_RUNTIME === "1") expect(process.versions.bun).toBeDefined();
	if (!available) expect(createValuer([model])(event).cost).toBeNull();
});

// Old-host compatibility is not release evidence. `make check-stats-pricing` fails if these cannot execute.
describe.skipIf(!available)("matching-core pricing contract", () => {
	it("converts per-million rates while preserving recorded zero/stale observations", () => {
		const value = createValuer([model]);
		const zero = { ...event, input: 1000000, output: 1000000, cacheRead: 1000000, cost: 0 };
		const stale = { ...zero, cost: 123 };
		const before = structuredClone([zero, stale]);
		expect(value(zero).cost).toBeCloseTo(19.2);
		expect(valuation([zero, stale], value).cost).toBeCloseTo(38.4);
		expect([zero, stale]).toEqual(before);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});
	it.each([0, 1])("selects request-wide context tier at cached boundary +%i", (extra) => {
		const value = createValuer([model]);
		const counters = { ...event, input: 1, output: 1, cacheRead: 99 + extra };
		expect(value(counters).cost).toBeCloseTo(extra ? 0.000039 : 0.0000219, 12);
	});
	it("keeps cached input separate from uncached input and never subtracts it twice", () => {
		const value = createValuer([model]);
		expect(value({ ...event, input: 1, cacheRead: 99 }).cost).toBeCloseTo((2 + 9.9) / 1000000, 12);
	});
	it("prices explicit cache lifetimes and refuses missing historical TTL", () => {
		const value = createValuer([model]);
		const oneHour = { ...event, cacheWrite: 1000000, cacheWrite1h: 1000000 };
		const twelveHour = { ...event, cacheWrite: 1000000, cacheWrite12h: 1000000 };
		const mixed = { ...event, cacheWrite: 1000000, cacheWrite1h: 400000, shortCacheWrites: true };
		expect(value(oneHour).cost).toBe(8);
		expect(value(twelveHour).cost).toBe(10);
		expect(value(mixed).cost).toBeCloseTo(6.2);
		expect(value({ ...event, cacheWrite: 1 }).cost).toBeNull();
	});
	it("distinguishes verified free, unknown and unmapped aliases", () => {
		const free = {
			...model,
			id: "free",
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, assessment: { ...assessment, status: "free" } },
		};
		const unknown = {
			...model,
			id: "unknown",
			cost: { ...rates, assessment: { status: "unknown", reason: "Unverified source" } },
		};
		const value = createValuer([model, free, unknown]);
		expect(value({ ...event, model: "free", input: 1000000 }).cost).toBe(0);
		expect(value({ ...event, model: "unknown", input: 1000000 }).cost).toBeNull();
		expect(value({ ...event, model: "unmapped-alias", input: 1000000 }).cost).toBeNull();
	});
	it("values local/imported/deleted cached events without changing transcripts, snapshot bytes or IDs", async () => {
		const root = await mkdtemp(join(tmpdir(), "pricing-core-contract-"));
		roots.push(root);
		const agent = join(root, "agent"),
			sessions = join(agent, "sessions"),
			repo = join(root, "repo");
		await mkdir(sessions, { recursive: true });
		const stamp = `${date}T12:00:00Z`;
		const message = (id: string, input: number, cacheWrite: number, cost: number) => ({
			type: "message",
			id,
			timestamp: stamp,
			message: {
				role: "assistant",
				provider: model.provider,
				model: model.id,
				usage: { input, output: 1000000, cacheRead: 0, cacheWrite, cost: { total: cost } },
			},
		});
		const entries = [
			{ type: "session", id: "synthetic-original", timestamp: stamp },
			message("zero-recorded", 1000000, 0, 0),
			message("unknown-ttl", 1, 10, 3),
		];
		const original = `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
		const file = join(sessions, "original.jsonl");
		await writeFile(file, original);
		const published = await exportStats(agent, repo, sessions);
		await importStats(agent, repo);
		const loaded = await loadCombined(agent);
		expect(loaded.calls).toHaveLength(2);
		const before = structuredClone(loaded.calls);
		const identity = { machineId: published.machineId, label: "Synthetic machine" };
		const manifestFile = join(published.snapshotDir, "manifest.json");
		const manifestBytes = await readFile(manifestFile);
		const snapshot = makeSnapshot(loaded, identity, Date.parse(stamp));
		const value = createValuer([model]);
		expect(valuation(loaded.calls, value)).toMatchObject({ cost: 19, pricedEvents: 1, unpricedEvents: 1 });
		expect(loaded.calls.reduce((sum, c) => sum + c.cost, 0)).toBe(3);
		expect(loaded.calls).toEqual(before);
		expect(makeSnapshot(loaded, identity, Date.parse(stamp))).toEqual(snapshot);
		expect(await readFile(file, "utf8")).toBe(original);
		expect(await readFile(manifestFile)).toEqual(manifestBytes);
		await rm(file);
		const deleted = await loadCombined(agent);
		expect(deleted.calls).toEqual(loaded.calls);
		expect(valuation(deleted.calls, value).cost).toBe(19);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});
});
