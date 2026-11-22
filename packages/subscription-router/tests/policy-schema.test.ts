/** Shipped JSON Schema and runtime parser share the same policy acceptance fixtures. */
import { readdirSync, readFileSync } from "node:fs";
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
const examples = new URL("../examples/", import.meta.url);
const exampleFiles = readdirSync(examples)
	.filter((name) => name.endsWith(".json"))
	.sort();

it.each(exampleFiles)("accepts shipped example %s in both validators", (name) => {
	const document = JSON.parse(readFileSync(new URL(name, examples), "utf8"));
	expect(Check(schema, document)).toBe(true);
	expect(() => parseConfigDocument(document)).not.toThrow();
});

it.each([
	["subscription-router.json", 2],
	["policies.json", 3],
	["providers.json", 0],
] as const)("keeps %s profile membership at %i", (name, count) => {
	const document = JSON.parse(readFileSync(new URL(name, examples), "utf8"));
	expect(parseConfig(document)).toHaveLength(count);
});

const rolling = { name: "roll", kind: "rolling", durationMinutes: 10, unit: "usd", scope: "provider" };
const resetRule = { at: "00:00", timeZone: "America/Los_Angeles", every: "day" };
const calendar = { name: "daily", kind: "calendar", resetRule, unit: "requests", scope: "model" };

it("accepts the section 7 Google subscription config and its worked collector declaration", () => {
	// The spec's literal JSON contains only labels; its surrounding worked example describes the windows.
	const document = JSON.parse(
		readFileSync(new URL("./fixtures/google-subscription-config.json", import.meta.url), "utf8"),
	);
	const providers = {
		"google-subscription": {
			...document.providers["google-subscription"],
			collector: { id: "google-subscription" },
			evidence: ["read", "failure"],
			windows: [
				{ name: "5h", kind: "rolling", durationMinutes: 300, unit: "requests", scope: "provider" },
				{ name: "7d", kind: "rolling", durationMinutes: 10080, unit: "requests", scope: "provider" },
				calendar,
			],
		},
	};
	const profiles = [
		{
			id: "deep",
			name: "Router deep",
			strategy: "balanced",
			chain: [
				{ provider: "anthropic", id: "claude-sonnet-5-5" },
				{ provider: "google-subscription", id: "gemini-4-neon" },
				{ provider: "google", id: "gemini-4-neon" },
			],
		},
	];
	for (const worked of [document, { ...document, providers }]) {
		expect(Check(schema, worked)).toBe(true);
		expect(parseConfigDocument(worked)).toEqual({ profiles, providers: worked.providers });
	}
});

it("accepts Unknown/Nowhere in the schema shape but rejects it in the loader via Intl", () => {
	const document = {
		profiles: {},
		providers: { p: { windows: [{ ...calendar, resetRule: { ...resetRule, timeZone: "Unknown/Nowhere" } }] } },
	};
	expect(Check(schema, document)).toBe(true);
	expect(() => parseConfigDocument(document)).toThrow(
		'providers.p.windows[0].resetRule.timeZone: unknown IANA time zone "Unknown/Nowhere"',
	);
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

it.each(["UTC", "GMT", "Etc/UTC", "US/Pacific"])("accepts Intl time zone %s in both validators", (timeZone) => {
	const providers = { p: { windows: [{ ...calendar, resetRule: { ...resetRule, timeZone } }] } };
	const document = { profiles: {}, providers };
	expect(Check(schema, document)).toBe(true);
	expect(parseConfigDocument(document)).toEqual({ profiles: [], providers });
});

it.each(["PST", "pst", "CET", "EST"])("rejects bare time zone abbreviation %s in both validators", (timeZone) => {
	const document = {
		profiles: {},
		providers: { p: { windows: [{ ...calendar, resetRule: { ...resetRule, timeZone } }] } },
	};
	expect(Check(schema, document)).toBe(false);
	expect(() => parseConfigDocument(document)).toThrow("providers.p.windows[0].resetRule.timeZone:");
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
		{ p: { windows: [{ ...calendar, resetRule: { ...resetRule, every: "week" } }] } },
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

it.each([
	"http://x",
	"https://x",
	"../x",
	"..\\x",
	"file:x",
	"a/b",
	"a\\b",
	".",
	"..",
	"",
	"Upper",
	"has space",
	"рrovider",
	"1reader",
	"a--b",
	"a-",
	"reader\n",
	"a".repeat(65),
	null,
])("rejects invalid collector ID %j in both validators", (id) => {
	const document = { profiles: {}, providers: { p: { collector: { id } } } };
	expect(Check(schema, document)).toBe(false);
	expect(() => parseConfigDocument(document)).toThrow("providers.p.collector.id:");
});

it("keeps Pi provider IDs independent of collector ID rules", () => {
	const providers = {
		"google-vertex": { collector: { id: "google-reader2" } },
		"openai-codex": {},
		anthropic: {},
		"Custom.Provider_1": { collector: { id: "a".repeat(64) } },
	};
	const document = { profiles: {}, providers };
	expect(Check(schema, document)).toBe(true);
	expect(parseConfigDocument(document)).toEqual({ profiles: [], providers });
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
