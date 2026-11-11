/** Shipped JSON Schema and runtime parser share the same policy acceptance fixtures. */
import { readFileSync } from "node:fs";
import type { TSchema } from "typebox";
import { Check } from "typebox/value";
import { expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { compilePolicy, evaluatePolicy } from "../src/policy.js";
import { POLICY_CASES } from "./policy-cases.js";

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
