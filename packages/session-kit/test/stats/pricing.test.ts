import { parseColor, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { StatsView, summary } from "../../src/stats/component.ts";
import { dedupCalls, flatten, parseSession } from "../../src/stats/load.ts";
import { createValuer, type Estimate, type PricingModel, valuation, valuationLines } from "../../src/stats/pricing.ts";
import { call } from "./fixtures.ts";

const date = "2026-11-12";
const model: PricingModel = {
	provider: "example-provider",
	id: "physical",
	cost: {
		assessment: {
			source: "https://example.test/pricing",
			checkedAt: date,
			unit: "usd-per-million-tokens",
			conditions: "Synthetic Standard baseline",
		},
	},
};
const priced = call(date, model.provider, model.id, 100, 10, { cost: 99 });

// nredd/pi-harness#799: delegate arithmetic to core, price physical events before aggregating, preserve recorded data.
describe("offline current-rate valuation", () => {
	it("uses the requested native runtime", () => {
		if (process.env.PRICING_TEST_RUNTIME)
			expect(process.versions.bun ? "bun" : "node").toBe(process.env.PRICING_TEST_RUNTIME);
	});
	it("uses only exact loaded identities and the shared estimator, never a refresh or auth method", () => {
		const estimate = vi.fn<Estimate>((resolved, tokens) => {
			expect(tokens).toBe(priced);
			expect(resolved).toBe(model);
			return { cost: { total: 1.5 } };
		});
		const before = structuredClone(priced);
		const result = createValuer([model], estimate)(priced);
		expect(result).toEqual({
			cost: 1.5,
			basis: `https://example.test/pricing; ${date}; usd-per-million-tokens; Synthetic Standard baseline`,
		});
		expect(priced).toEqual(before);
		const missing = vi.fn<Estimate>((resolved) => {
			expect(resolved).toBeUndefined();
			return { cost: null, reason: "Unmapped alias" };
		});
		expect(createValuer([model], missing)({ ...priced, model: "alias" })).toEqual({
			cost: null,
			reason: "Unmapped alias",
		});
		const slash: PricingModel = { ...model, provider: "example/provider", id: "physical" };
		expect(
			createValuer([slash], (resolved) => ({ cost: resolved ? { total: 1 } : null }))({
				...priced,
				provider: "example",
				model: "provider/physical",
			}).cost,
		).toBeNull();
	});
	it("fails closed on old hosts, unpriced responses and invalid totals", () => {
		expect(createValuer([])(priced).cost).toBeNull();
		expect(createValuer([], null)(priced).reason).toContain("Host");
		expect(createValuer([], () => ({ cost: { total: 0 } }))(priced).cost).toBe(0);
		expect(createValuer([], () => ({ cost: null }))(priced)).toEqual({ cost: null, reason: "Price unavailable." });
		for (const total of [-1, Infinity, NaN])
			expect(createValuer([model], () => ({ cost: { total } }))(priced)).toEqual({
				cost: null,
				reason: "Invalid estimate.",
			});
		for (const cost of [null, 0, {}, { assessment: null }, { assessment: { source: 9, checkedAt: date } }]) {
			const result = createValuer([{ ...model, cost }], () => ({ cost: { total: 0 } }))(priced);
			expect(result.cost).toBe(0);
		}
	});
	it("counts priced/free/unknown coverage without treating partial sums as full value", () => {
		const calls = [
			priced,
			{ ...priced, model: "free", input: 20 },
			{ ...priced, model: "unknown", input: 30 },
			{ ...priced, model: "unknown", input: 40 },
		];
		const before = structuredClone(calls);
		const value = (c: typeof priced) => ({
			cost: c.model === "unknown" ? null : c.model === "free" ? 0 : 2,
			reason: c.model === "unknown" ? "Missing TTL" : undefined,
			basis: c.model === "physical" ? "Published baseline" : undefined,
		});
		const totals = valuation(calls, value);
		expect(totals).toMatchObject({
			cost: 2,
			pricedEvents: 2,
			unpricedEvents: 2,
			pricedTokens: 140,
			unpricedTokens: 90,
		});
		expect(totals.reasons.get("Missing TTL")).toBe(2);
		expect(valuationLines(calls, value).join("\n")).toContain("$2.00 (priced subset only)");
		expect(valuationLines(calls, value)).toContain("Price basis: Published baseline");
		expect(valuationLines([priced], () => ({ cost: null })).join("\n")).toContain("unknown");
		expect(valuationLines([priced], () => ({ cost: 0 }))[0]).toBe("Current-rate API-equivalent estimate: $0.00");
		expect(valuation([], value).cost).toBeNull();
		expect(calls).toEqual(before);
		const text = summary(calls, value);
		expect(text).toContain("recorded cost");
		expect(text).toContain("current estimate");
		expect(text).toContain("unknown");
		expect(text).toContain("$99.00");
		expect(
			summary([priced, { ...priced, input: 1 }], () => ({ cost: null, reason: "\u001b[31munsafe" })),
		).not.toContain("\u001b");
		const partial = summary([priced, { ...priced, input: 1 }], (c) => ({ cost: c.input === 1 ? null : 2 }));
		expect(partial).toContain("$2.00 subset");
	});
	it("renders scoped current value and coverage on both tabs, with basis on Machines", () => {
		const valueCall = (c: typeof priced) => ({
			cost: c.model === "unmapped" ? null : 2,
			reason: "Unmapped",
			basis: "AWS Standard/global published baseline; synthetic test",
		});
		const calls = [priced, { ...priced, model: "unmapped", input: 1 }];
		const theme = {
			fg: (_c: unknown, s: string) => s,
			bg: (_c: unknown, s: string) => s,
			bold: (s: string) => s,
			style: (s: string) => s,
			colors: { accent: parseColor("#426a79") },
		};
		const view = new StatsView({
			calls,
			sessions: [],
			valueCall,
			theme: theme as never,
			rows: () => 100,
			now: priced.ms + 1,
			requestRender() {},
			onClose() {},
		});
		for (const tab of ["Overview", "Models"]) {
			expect(view.state.tab).toBe(tab);
			for (const width of [1, 40, 60, 120, 320]) {
				const lines = view.render(width);
				expect(lines).toHaveLength(100);
				expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
				if (width === 320) expect(lines.join("\n")).toContain("$2.00 (priced subset only)");
			}
			view.handleInput("\t");
		}
		expect(view.state.tab).toBe("Machines");
		expect(view.render(320).join("\n")).toContain("AWS Standard/global published baseline");
		expect(view.render(320).join("\n")).toContain("request-date billing");
	});
	it("keeps copied/forked physical event IDs and transcript bytes unchanged", () => {
		const entry = {
			type: "message",
			id: "event-one",
			timestamp: `${date}T12:00:00Z`,
			message: {
				role: "assistant",
				provider: model.provider,
				model: model.id,
				usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
			},
		};
		const text = [
			{ type: "session", id: "session-one", timestamp: `${date}T11:00:00Z` },
			entry,
			{ ...entry, id: "virtual", message: { ...entry.message, provider: "router" } },
			{ type: "message", message: { role: "toolResult", usage: { input: 99999 } } },
		]
			.map((value) => JSON.stringify(value))
			.join("\n");
		const original = text;
		const loaded = flatten({ "/synthetic/one": parseSession(text), "/synthetic/fork": parseSession(text) });
		expect(loaded.calls).toHaveLength(1);
		const before = structuredClone(loaded.calls);
		expect(valuation(dedupCalls(loaded.calls), () => ({ cost: 123 })).cost).toBe(123);
		expect(loaded.calls).toEqual(before);
		expect(text).toBe(original);
		expect(loaded.calls[0]?.cost).toBe(0);
	});
});
