import { readFileSync } from "node:fs";
import { Check, type XSchema } from "typebox/schema";
import { expect, it } from "vitest";
import { formatQuotaRow, parseUsageReply } from "../../preset/src/footer-quota.ts";
import { describe, type UsageReplyV2 } from "../src/view.ts";

type Fixture = {
	name: string;
	now: number;
	timeZone: string;
	usage: UsageReplyV2;
	legacyRows?: { full: string; compact: string };
};
// Bump the fixture schema only for breaking format changes, independently of usage.version.
const fixtureSchema = JSON.parse(
	readFileSync(new URL("./fixtures/views.schema.json", import.meta.url), "utf8"),
) as XSchema;
const fixture = JSON.parse(readFileSync(new URL("./fixtures/views.json", import.meta.url), "utf8")) as {
	schema: number;
	views: Fixture[];
};

it("validates the shared fixture against the on-disk JSON Schema", () => {
	expect(Check(fixtureSchema, fixture)).toBe(true);
	expect(Check(fixtureSchema, fixture.views)).toBe(false);
	expect(Check(fixtureSchema, { ...fixture, schema: 2 })).toBe(false);
});

it.each([
	{ name: "rpd", scope: "model", quantity: { unit: "requests", used: 37 }, usedPercent: 15 },
	{ name: "rpd", scope: "model" },
])("rejects invalid meter %j through the shared JSON Schema", (meter) => {
	const row = fixture.views.find(({ name }) => name === "metered");
	if (!row) throw new Error("Expected a metered fixture row");
	const views = row.usage.views.map((view) => ({ ...view, meters: [meter] }));
	expect(Check(fixtureSchema, { ...fixture, views: [{ ...row, usage: { ...row.usage, views } }] })).toBe(false);
});

it.each(fixture.views)(
	"builds $name without altering readings or mixing marks",
	({ usage, now, timeZone, legacyRows }) => {
		const providers = usage.views.map(({ provider }) => provider);
		const displays = new Map([["google", { full: "Google", compact: "Goog" }]]);
		// Snapshot collection order need not match the requested view order.
		const views = describe(
			providers,
			[...usage.snapshots].reverse(),
			[...usage.blocks].reverse(),
			legacyRows ? undefined : displays,
		);
		expect(views).toStrictEqual(usage.views);

		// Legacy byte baseline: the footer slice must reuse these golden rows against the v2 renderer.
		if (legacyRows) {
			const snapshots = views.flatMap((view) => (view.snapshot ? [view.snapshot] : []));
			const state = parseUsageReply({ success: true, data: { snapshots } }, now);
			if (!state) throw new Error("Expected a valid legacy footer reply");
			for (const tier of ["full", "compact"] as const) {
				expect(formatQuotaRow(state, tier, (_color, value) => value, { now, timeZone })).toBe(legacyRows[tier]);
			}
		}
	},
);

it("prefers a supplied display and preserves explicit subscription access", () => {
	const reading = {
		provider: "anthropic",
		access: "subscription",
		status: "available",
		retrievedAt: 0,
		expiresAt: 1,
		windows: [],
	} as const satisfies Omit<UsageReplyV2["snapshots"][number], "windows"> & { windows: [] };
	const override = { full: "Custom label", compact: "Custom" };
	expect(describe(["anthropic"], [reading], [], new Map([["anthropic", override]]))).toStrictEqual([
		{
			provider: "anthropic",
			display: override,
			access: "subscription",
			snapshot: reading,
			meters: [],
			pools: [],
			marks: [],
		},
	]);
});
