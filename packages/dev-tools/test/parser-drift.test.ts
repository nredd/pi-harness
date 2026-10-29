import { expect, it } from "vitest";
import { benchEstimate } from "../src/cargo/parse.ts";
import { parseTyConcise } from "../src/py/parse.ts";

it("retains unrecognized ty output instead of discarding findings", () => {
	expect(parseTyConcise("future diagnostic format\n")).toMatchObject({
		diagnostics: [],
		unparsed: ["future diagnostic format"],
	});
});

it("keeps valid benchmark means when optional change JSON is malformed", () => {
	const estimate = JSON.stringify({
		mean: { point_estimate: 2, confidence_interval: { lower_bound: 1, upper_bound: 3 } },
	});
	expect(benchEstimate("fixture", estimate, "{broken")).toEqual({
		name: "fixture",
		meanNs: 2,
		lowerNs: 1,
		upperNs: 3,
		changePct: null,
	});
});
