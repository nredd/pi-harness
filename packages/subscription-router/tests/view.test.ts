import { readFileSync } from "node:fs";
import { Check, type XSchema } from "typebox/schema";
import { expect, expectTypeOf, it } from "vitest";
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

it("can report a usage percentage independently of an inferred span", () => {
	type SpanSource = UsageReplyV2["snapshots"][number]["windows"][number]["spanSource"];
	expectTypeOf<"inferred">().toExtend<SpanSource>();
	const row = fixture.views.find(({ name }) => name === "inferred-span");
	expect(row?.usage.views[0]?.snapshot?.windows[0]).toMatchObject({
		spanSource: "inferred",
		basis: "reported",
	});
});

it("projects readonly arrays without sharing mutable input data", () => {
	const row = fixture.views.find(({ name }) => name === "metered");
	if (!row) throw new Error("Expected a metered fixture row");
	const { snapshots, blocks } = structuredClone(row.usage);
	const [snapshot] = snapshots;
	const pool = snapshot?.pools?.[0];
	if (!snapshot?.meters || !snapshot.pools || !pool) throw new Error("Expected meters and pools");
	Object.freeze(snapshots);
	Object.freeze(snapshot);
	Object.freeze(snapshot.windows);
	Object.freeze(snapshot.meters);
	Object.freeze(snapshot.pools);
	Object.freeze(blocks);
	const show = [{ name: "rpd" }];
	const display = { full: "Google", compact: "Goog", footer: { show } };
	const views = describe(["google"], snapshots, blocks, new Map([["google", display]]));
	const [view] = views;
	if (!view?.snapshot) throw new Error("Expected a projected snapshot");
	expectTypeOf(views).not.toExtend<unknown[]>();
	expectTypeOf(view.snapshot.windows).not.toExtend<unknown[]>();
	expectTypeOf(view.meters).not.toExtend<unknown[]>();
	expectTypeOf(view.pools).not.toExtend<unknown[]>();
	expectTypeOf(view.marks).not.toExtend<unknown[]>();
	type Selectors = NonNullable<NonNullable<typeof view.display.footer>["show"]>;
	expectTypeOf<Selectors>().not.toExtend<unknown[]>();
	expect(snapshots).toStrictEqual(row.usage.snapshots);
	expect(blocks).toStrictEqual(row.usage.blocks);
	expect(view.snapshot).not.toBe(snapshot);
	expect(view.meters).not.toBe(snapshot.meters);
	expect(view.pools).not.toBe(snapshot.pools);

	const expected = structuredClone(view);
	snapshot.meters[0]?.families?.push("other-model");
	pool.balance = 0;
	blocks[0]?.families?.push("other-model");
	show.push({ name: "other-window" });
	display.full = "Changed";
	expect(view).toStrictEqual(expected);
});

it("selects the latest snapshot per provider, keeping the first on ties", () => {
	const base = { provider: "faux", status: "available", retrievedAt: 1, expiresAt: 10, windows: [] } as const;
	const older = { ...base, windows: [] };
	const newest = { ...older, retrievedAt: 3, message: "first at 3" };
	const tied = { ...newest, message: "second at 3" };
	const other = { ...older, provider: "other", retrievedAt: 4 };
	const [view] = describe(["faux"], [older, newest, tied, other, older], []);
	expect(view?.snapshot).toStrictEqual(newest);
});

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
