import { Type } from "typebox";
import { Check } from "typebox/value";
import type { CollectorReading } from "./collectors.ts";

const label = Type.String({ minLength: 1, maxLength: 256 });
const labels = Type.Array(label, { maxItems: 128 });
const amount = Type.Number({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const quantity = Type.Object({
	unit: Type.Union([Type.Literal("requests"), Type.Literal("tokens"), Type.Literal("usd"), Type.Literal("credits")]),
	used: Type.Optional(amount),
	limit: Type.Optional(amount),
	remaining: Type.Optional(amount),
});
const bucket = {
	name: label,
	resetAt: Type.Optional(Type.Number()),
	durationMs: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
	spanSource: Type.Optional(Type.Union([Type.Literal("reported"), Type.Literal("assumed")])),
	scope: Type.Union([Type.Literal("provider"), Type.Literal("model")]),
	families: Type.Optional(labels),
	kind: Type.Optional(Type.Union([Type.Literal("rolling"), Type.Literal("calendar")])),
	resetRule: Type.Optional(
		Type.Object({
			at: Type.String({ pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$" }),
			timeZone: label,
			every: Type.Union([Type.Literal("day"), Type.Literal("week")]),
		}),
	),
};
const schema = Type.Object({
	windows: Type.Array(
		Type.Object({
			...bucket,
			usedPercent: Type.Number({ minimum: 0, maximum: 100 }),
			quantity: Type.Optional(quantity),
		}),
		{ maxItems: 128 },
	),
	meters: Type.Optional(Type.Array(Type.Object({ ...bucket, quantity }), { maxItems: 128 })),
	pools: Type.Optional(
		Type.Array(
			Type.Object({
				name: label,
				unit: Type.Union([Type.Literal("usd"), Type.Literal("credits")]),
				role: Type.Union([Type.Literal("overage"), Type.Literal("prepaid")]),
				balance: Type.Optional(amount),
				unlimited: Type.Optional(Type.Boolean()),
				appliesAfter: Type.Optional(labels),
			}),
			{ maxItems: 128 },
		),
	),
	credits: Type.Optional(
		Type.Object({
			available: Type.Boolean(),
			unlimited: Type.Boolean(),
			balance: Type.Optional(Type.String({ maxLength: 256 })),
		}),
	),
});

function copyBucket({
	name,
	resetAt,
	durationMs,
	spanSource,
	scope,
	families,
	kind,
	resetRule,
}: CollectorReading["windows"][number] | NonNullable<CollectorReading["meters"]>[number]) {
	return {
		name,
		resetAt: Math.abs(resetAt ?? Infinity) <= 8.64e15 ? resetAt : undefined,
		durationMs,
		spanSource: spanSource as "reported" | "assumed" | undefined,
		scope,
		families: families?.slice(),
		kind,
		resetRule: resetRule && { at: resetRule.at, timeZone: resetRule.timeZone, every: resetRule.every },
	};
}

/** Copy only declared fields. A successful collector read has reported basis (the wire default). */
export function normalizeReading(reading: unknown): CollectorReading | undefined {
	if (!Check(schema, reading)) return undefined;
	const { windows, meters, pools, credits } = reading;
	return {
		windows: windows.map((window) => {
			const { usedPercent, quantity } = window;
			return {
				...copyBucket(window),
				usedPercent,
				quantity: quantity && {
					unit: quantity.unit,
					used: quantity.used,
					limit: quantity.limit,
					remaining: quantity.remaining,
				},
			};
		}),
		meters: meters?.map((meter) => {
			const { unit, used, limit, remaining } = meter.quantity;
			return { ...copyBucket(meter), quantity: { unit, used, limit, remaining } };
		}),
		pools: pools?.map(({ name, unit, role, balance, unlimited, appliesAfter }) => ({
			name,
			unit,
			role,
			balance,
			unlimited,
			appliesAfter: appliesAfter?.slice(),
		})),
		credits: credits && { available: credits.available, unlimited: credits.unlimited, balance: credits.balance },
	};
}
