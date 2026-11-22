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

const MAX_ITEMS = 128;
const { apply, getOwnPropertyDescriptor } = Reflect;
const { hasOwn } = Object;
const { isArray } = Array;

type Copier = (value: unknown) => unknown;

/** Read one own property exactly once, invoking an own getter at most once. Throws propagate. */
function own(source: object, key: string): unknown {
	const descriptor = getOwnPropertyDescriptor(source, key);
	if (!descriptor) return undefined;
	return hasOwn(descriptor, "value") ? descriptor.value : descriptor.get && apply(descriptor.get, source, []);
}

/** A plain record of the named own fields, or `null` so validation rejects a non-record. */
function record(source: unknown, keys: readonly string[], nested: Readonly<Record<string, Copier>> = {}): unknown {
	if (typeof source !== "object" || source === null || isArray(source)) return null;
	const copy: Record<string, unknown> = {};
	for (const key of keys) {
		const value = own(source, key);
		const copier = nested[key];
		if (value !== undefined) copy[key] = copier ? copier(value) : value;
	}
	return copy;
}

/** A dense router-owned array read by index, never through the adapter's methods, or `null`. */
function list(source: unknown, item: Copier = (value) => value): unknown[] | null {
	if (!isArray(source)) return null;
	const length = own(source, "length");
	if (typeof length !== "number" || length > MAX_ITEMS) return null;
	const copy: unknown[] = [];
	for (let index = 0; index < length; index += 1) copy.push(item(own(source, String(index))));
	return copy;
}

const BUCKET_KEYS = [
	"name",
	"resetAt",
	"durationMs",
	"spanSource",
	"scope",
	"families",
	"kind",
	"resetRule",
	"quantity",
];
const BUCKET_FIELDS: Readonly<Record<string, Copier>> = {
	families: (value) => list(value),
	resetRule: (value) => record(value, ["at", "timeZone", "every"]),
	quantity: (value) => record(value, ["unit", "used", "limit", "remaining"]),
};
const READING_FIELDS: Readonly<Record<string, Copier>> = {
	windows: (value) => list(value, (window) => record(window, [...BUCKET_KEYS, "usedPercent"], BUCKET_FIELDS)),
	meters: (value) => list(value, (meter) => record(meter, BUCKET_KEYS, BUCKET_FIELDS)),
	pools: (value) =>
		list(value, (pool) =>
			record(pool, ["name", "unit", "role", "balance", "unlimited", "appliesAfter"], {
				appliesAfter: (names) => list(names),
			}),
		),
	credits: (value) => record(value, ["available", "unlimited", "balance"]),
};

function copyBucket({
	resetAt,
	durationMs,
	spanSource,
	scope,
	families,
	kind,
	resetRule,
}: CollectorReading["windows"][number] | NonNullable<CollectorReading["meters"]>[number]) {
	return {
		resetAt: Math.abs(resetAt ?? Infinity) <= 8.64e15 ? resetAt : undefined,
		durationMs,
		spanSource: spanSource as "reported" | "assumed" | undefined,
		scope,
		families: families?.slice(),
		kind,
		resetRule: resetRule && { at: resetRule.at, timeZone: resetRule.timeZone, every: resetRule.every },
	};
}

/**
 * Copy only declared fields. A successful collector read has reported basis (the wire default).
 * Validation and every later step see one router-owned copy, so adapter getters and array
 * methods cannot change a value after it was checked. A throwing getter throws.
 */
export function normalizeReading(reading: unknown): CollectorReading | undefined {
	const copy = record(reading, Object.keys(READING_FIELDS), READING_FIELDS);
	if (!Check(schema, copy)) return undefined;
	const { windows, meters, pools, credits } = copy;
	return {
		windows: windows.map((window) => {
			const { usedPercent, quantity } = window;
			return {
				name: window.name,
				usedPercent,
				...copyBucket(window),
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
			return { name: meter.name, ...copyBucket(meter), quantity: { unit, used, limit, remaining } };
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
