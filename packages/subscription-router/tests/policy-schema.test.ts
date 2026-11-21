/** Shipped JSON Schema and runtime parser share the same policy acceptance fixtures. */
import { readFileSync } from "node:fs";
import type { TSchema } from "typebox";
import { Check } from "typebox/value";
import { expect, it } from "vitest";
import { parseConfig, parseConfigDocument } from "../src/config.ts";
import { compilePolicy, evaluatePolicy } from "../src/policy.ts";
import { POLICY_CASES } from "./fixtures/policy-cases.ts";

const schema = JSON.parse(
	readFileSync(new URL("../schemas/subscription-router.schema.json", import.meta.url), "utf8"),
) as TSchema;
it.each(POLICY_CASES)("schema/runtime acceptance parity: $policy", ({ policy, valid }) => {
	const document = { profiles: { test: { policy, chain: [{ model: "p/a" }] } } };
	expect(Check(schema, document)).toBe(valid);
	if (valid) expect(() => parseConfig(document)).not.toThrow();
	else expect(() => parseConfig(document)).toThrow();
});
it("ships valid opt-in examples without migrating legacy profile membership", () => {
	for (const name of ["subscription-router", "policies"]) {
		const document = JSON.parse(readFileSync(new URL(`../examples/${name}.json`, import.meta.url), "utf8"));
		expect(Check(schema, document)).toBe(true);
		expect(parseConfig(document).length).toBeGreaterThan(0);
	}
});

const rolling = { name: "roll", kind: "rolling", durationMinutes: 10, unit: "usd", scope: "provider" };
const resetRule = { at: "00:00", timeZone: "America/Los_Angeles", every: "day" };
const calendar = { name: "daily", kind: "calendar", resetRule, unit: "requests", scope: "model" };

it("accepts the shipped provider declarations in the schema and parser", () => {
	const document = JSON.parse(readFileSync(new URL("../examples/providers.json", import.meta.url), "utf8"));
	expect(Check(schema, document)).toBe(true);
	expect(parseConfigDocument(document)).toEqual({ ...document, profiles: [] });
});

it.each([
	{},
	{ p: {} },
	{ p: { evidence: [], fallbackOnReadError: false, failure: {}, windows: [], collector: { options: {} } } },
	{
		p: { failure: { parser: "generic" }, windows: [rolling, { ...calendar, limits: {} }], collector: { id: "new-id" } },
	},
	{ p: { collector: { options: { custom: [{ nested: null }] } } } },
	{ p: { failure: { minHintSeconds: 0 } } },
	{ p: { failure: { minHintSeconds: 0.5 } } },
])("accepts optional provider data: %j", (providers) => {
	const document = { profiles: {}, providers, otherRootKey: true };
	expect(Check(schema, document)).toBe(true);
	expect(parseConfigDocument(document)).toEqual({ profiles: [], providers });
});

it.each([
	[null, "providers: expected an object"],
	[[], "providers: expected an object"],
	[{ "a/b": {} }, "providers: expected non-blank provider ids"],
	[{ p: "new" }, "providers.p: expected an object"],
	[{ p: { typo: true } }, "providers.p.typo: unknown key"],
	[{ p: { label: { compact: "New" } } }, "providers.p.label.full:"],
	[{ p: { label: { full: "New", compact: " " } } }, "providers.p.label.compact:"],
	[{ p: { label: { full: "New", compact: "N", typo: 0 } } }, "providers.p.label.typo: unknown key"],
	[{ p: { quotaGroup: " " } }, "providers.p.quotaGroup:"],
	[{ p: { evidence: "read" } }, "providers.p.evidence: expected an array"],
	[{ p: { evidence: ["other"] } }, "providers.p.evidence[0]: expected one of"],
	[{ p: { evidence: ["read", "read"] } }, "providers.p.evidence: duplicate source"],
	[{ p: { fallbackOnReadError: "yes" } }, "providers.p.fallbackOnReadError: expected a boolean"],
	[{ p: { failure: { parser: "other" } } }, "providers.p.failure.parser:"],
	[{ p: { failure: { typo: 1 } } }, "providers.p.failure.typo: unknown key"],
	[{ p: { failure: { minHintSeconds: -1 } } }, "providers.p.failure.minHintSeconds:"],
	[{ p: { failure: { minHintSeconds: "0" } } }, "providers.p.failure.minHintSeconds:"],
	[{ p: { failure: { minHintSeconds: Number.POSITIVE_INFINITY } } }, "providers.p.failure.minHintSeconds:"],
	[{ p: { failure: { maxBlockMinutes: 1441 } } }, "providers.p.failure.maxBlockMinutes: must not exceed 1440"],
	[
		{ p: { failure: { repeat: { count: 1.5, withinMinutes: 10 } } } },
		"providers.p.failure.repeat.count: expected a safe integer",
	],
	[{ p: { failure: { repeat: { count: 2 } } } }, "providers.p.failure.repeat.withinMinutes:"],
	[
		{ p: { failure: { repeat: { count: 2, withinMinutes: 10, typo: 0 } } } },
		"providers.p.failure.repeat.typo: unknown key",
	],
	[{ p: { collector: { id: "https://example.invalid" } } }, "providers.p.collector.id:"],
	[{ p: { collector: { options: [] } } }, "providers.p.collector.options: expected an object"],
	[{ p: { collector: { module: "example" } } }, "providers.p.collector.module: unknown key"],
	[{ p: { windows: {} } }, "providers.p.windows: expected an array"],
	[{ p: { windows: [{ ...rolling, kind: "annual" }] } }, "providers.p.windows[0].kind:"],
	[{ p: { windows: [{ ...rolling, name: "" }] } }, "providers.p.windows[0].name:"],
	[{ p: { windows: [{ ...rolling, unit: "money" }] } }, "providers.p.windows[0].unit:"],
	[{ p: { windows: [{ ...rolling, scope: "account" }] } }, "providers.p.windows[0].scope:"],
	[{ p: { windows: [{ ...rolling, resetRule }] } }, "providers.p.windows[0].resetRule: unknown key"],
	[{ p: { windows: [{ ...rolling, durationMinutes: -1 }] } }, "providers.p.windows[0].durationMinutes:"],
	[
		{ p: { windows: [{ ...rolling, limits: { model: 100 } }] } },
		"providers.p.windows[0].limits: expected a finite positive number",
	],
	[{ p: { windows: [{ ...calendar, durationMinutes: 10 }] } }, "providers.p.windows[0].durationMinutes: unknown key"],
	[{ p: { windows: [{ ...calendar, resetRule: null }] } }, "providers.p.windows[0].resetRule: expected an object"],
	[
		{ p: { windows: [{ ...calendar, resetRule: { ...resetRule, at: "24:00" } }] } },
		"providers.p.windows[0].resetRule.at:",
	],
	[
		{ p: { windows: [{ ...calendar, resetRule: { ...resetRule, timeZone: "+02:00" } }] } },
		"providers.p.windows[0].resetRule.timeZone:",
	],
	[
		{ p: { windows: [{ ...calendar, resetRule: { ...resetRule, every: "month" } }] } },
		"providers.p.windows[0].resetRule.every:",
	],
	[
		{ p: { windows: [{ ...calendar, resetRule: { ...resetRule, typo: 0 } }] } },
		"providers.p.windows[0].resetRule.typo: unknown key",
	],
	[{ p: { windows: [{ ...calendar, limits: 100 }] } }, "providers.p.windows[0].limits: expected an object"],
	[
		{ p: { windows: [{ ...calendar, limits: { " ": 100 } }] } },
		"providers.p.windows[0].limits: expected non-blank model-id keys",
	],
	[{ p: { windows: [{ ...calendar, limits: { model: 0 } }] } }, 'providers.p.windows[0].limits["model"]:'],
] as const)("rejects invalid provider data: %j", (providers, error) => {
	const document = { profiles: {}, providers };
	expect(() => parseConfig(document)).toThrow(error);
	expect(Check(schema, document)).toBe(false);
});

it("lets both providers compete in the shipped lexicographic example", () => {
	const document = JSON.parse(readFileSync(new URL("../examples/policies.json", import.meta.url), "utf8"));
	const profile = parseConfig(document).find((entry) => entry.id === "lexicographic-example");
	if (!profile) throw new Error("missing lexicographic example");
	const members = profile.chain.map((ref, index) => ({
		ref,
		index,
		filters: [],
		snapshot: {
			provider: ref.provider,
			status: "available" as const,
			retrievedAt: 0,
			expiresAt: 2,
			windows: [
				{
					name: index === 0 ? "seven_day_fable" : "7d",
					scope: "provider" as const,
					usedPercent: index === 0 ? 50 : 20,
				},
			],
		},
	}));
	const previous = "anthropic/claude-fable-5-1";
	expect(evaluatePolicy(compilePolicy(profile), members, 1, { reason: "user", previous }).chosen).toBe(
		"openai-codex/gpt-6-astra",
	);
});

it("describes legacy optional defaults and rejects outer mutual exclusion", () => {
	for (const extra of [{}, { strategy: "balanced" }, { policy: { version: 1, kind: "strict-priority" } }])
		expect(Check(schema, { profiles: { test: { ...extra, chain: [{ model: "p/a" }] } } })).toBe(true);
	for (const extra of [{ strategy: "ordered" }, { policyByCaller: {} }])
		expect(
			Check(schema, {
				profiles: { test: { ...extra, policy: { version: 1, kind: "strict-priority" }, chain: [{ model: "p/a" }] } },
			}),
		).toBe(false);
});
