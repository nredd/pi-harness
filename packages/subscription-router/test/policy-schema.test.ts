/** Shipped JSON Schema and runtime parser share the same policy acceptance fixtures. */
import { readFileSync } from "node:fs";
import type { TSchema } from "typebox";
import { Check } from "typebox/value";
import { expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
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
