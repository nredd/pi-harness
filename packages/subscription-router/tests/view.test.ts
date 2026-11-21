import { readFileSync } from "node:fs";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { expect, it } from "vitest";
import { formatQuotaRow, parseUsageReply } from "../../preset/src/footer-quota.ts";
import { describe, type UsageReplyV2 } from "../src/view.ts";

const closed = { additionalProperties: false };
const string = Type.String();
const number = Type.Number();
const optionalNumber = Type.Optional(number);
const strings = Type.Array(string);
const access = Type.Union([Type.Literal("subscription"), Type.Literal("metered")]);
const creditUnit = Type.Union([Type.Literal("usd"), Type.Literal("credits")]);
const quantity = Type.Object(
	{
		unit: Type.Union([Type.Literal("requests"), Type.Literal("tokens"), creditUnit]),
		used: optionalNumber,
		limit: optionalNumber,
		remaining: optionalNumber,
	},
	closed,
);
const bucket = {
	name: string,
	resetAt: optionalNumber,
	durationMs: optionalNumber,
	spanSource: Type.Optional(Type.Union([Type.Literal("reported"), Type.Literal("assumed")])),
	scope: Type.Union([Type.Literal("provider"), Type.Literal("model")]),
	families: Type.Optional(strings),
	kind: Type.Optional(Type.Union([Type.Literal("rolling"), Type.Literal("calendar")])),
	resetRule: Type.Optional(
		Type.Object(
			{ at: string, timeZone: string, every: Type.Union([Type.Literal("day"), Type.Literal("week")]) },
			closed,
		),
	),
	basis: Type.Optional(Type.Union([Type.Literal("reported"), Type.Literal("observed"), Type.Literal("inferred")])),
};
const meters = Type.Array(Type.Object({ ...bucket, quantity }, closed));
const pools = Type.Array(
	Type.Object(
		{
			name: string,
			unit: creditUnit,
			role: Type.Union([Type.Literal("overage"), Type.Literal("prepaid")]),
			balance: optionalNumber,
			unlimited: Type.Optional(Type.Boolean()),
			appliesAfter: Type.Optional(strings),
		},
		closed,
	),
);
const snapshot = Type.Object(
	{
		provider: string,
		status: Type.Union([
			Type.Literal("available"),
			Type.Literal("stale"),
			Type.Literal("unavailable"),
			Type.Literal("error"),
		]),
		windows: Type.Array(Type.Object({ ...bucket, usedPercent: number, quantity: Type.Optional(quantity) }, closed)),
		meters: Type.Optional(meters),
		pools: Type.Optional(pools),
		access: Type.Optional(access),
		credits: Type.Optional(
			Type.Object({ available: Type.Boolean(), unlimited: Type.Boolean(), balance: Type.Optional(string) }, closed),
		),
		retrievedAt: number,
		expiresAt: number,
		message: Type.Optional(string),
	},
	closed,
);
const marks = Type.Array(
	Type.Object(
		{
			provider: string,
			families: Type.Optional(strings),
			window: string,
			until: number,
			resetKnown: Type.Boolean(),
			confirmations: number,
			// The shared fixture also previews the mark fields from slice 5.
			evidence: Type.Optional(Type.Union([Type.Literal("inferred"), Type.Literal("observed")])),
			expiry: Type.Optional(
				Type.Union([Type.Literal("hinted"), Type.Literal("window-reset"), Type.Literal("backoff")]),
			),
			cause: Type.Optional(Type.Union([Type.Literal("quota"), Type.Literal("billing")])),
			access: Type.Optional(access),
			markedAt: optionalNumber,
		},
		closed,
	),
);
const display = Type.Object(
	{
		full: string,
		compact: string,
		footer: Type.Optional(
			Type.Object(
				{
					show: Type.Optional(
						Type.Array(
							Type.Union([Type.Object({ name: string }, closed), Type.Object({ durationMs: number }, closed)]),
						),
					),
					placeholder: Type.Optional(Type.Boolean()),
				},
				closed,
			),
		),
	},
	closed,
);
const usage = Type.Object(
	{
		version: Type.Literal(2),
		snapshots: Type.Array(snapshot),
		blocks: marks,
		views: Type.Array(
			Type.Object(
				{
					provider: string,
					display,
					access: Type.Union([access, Type.Literal("unknown")]),
					snapshot: Type.Optional(snapshot),
					meters,
					pools,
					marks,
				},
				closed,
			),
		),
	},
	closed,
);
const fixtureSchema = Type.Array(
	Type.Object(
		{
			name: string,
			now: number,
			timeZone: string,
			usage,
			legacyRows: Type.Optional(Type.Object({ full: string, compact: string }, closed)),
		},
		closed,
	),
	{ minItems: 1 },
);

type Fixture = {
	name: string;
	now: number;
	timeZone: string;
	usage: UsageReplyV2;
	legacyRows?: { full: string; compact: string };
};
const fixtures = JSON.parse(readFileSync(new URL("./fixtures/views.json", import.meta.url), "utf8")) as Fixture[];

it("validates the shared RPC v2 fixture schema", () => {
	expect(Check(fixtureSchema, fixtures)).toBe(true);
});

it("rejects a meter masquerading as a percentage window", () => {
	expect(
		Check(meters, [{ name: "rpd", scope: "model", quantity: { unit: "requests", used: 37 }, usedPercent: 15 }]),
	).toBe(false);
	expect(Check(meters, [{ name: "rpd", scope: "model" }])).toBe(false);
});

it.each(fixtures)("builds $name without altering readings or mixing marks", ({ usage, now, timeZone, legacyRows }) => {
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

	if (legacyRows) {
		const snapshots = views.flatMap((view) => (view.snapshot ? [view.snapshot] : []));
		const state = parseUsageReply({ success: true, data: { snapshots } }, now);
		if (!state) throw new Error("Expected a valid legacy footer reply");
		for (const tier of ["full", "compact"] as const) {
			expect(formatQuotaRow(state, tier, (_color, value) => value, { now, timeZone })).toBe(legacyRows[tier]);
		}
	}
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
