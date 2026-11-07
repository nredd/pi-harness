import { describe, expect, it } from "vitest";
import * as aggregate from "../../src/stats/aggregate.ts";
import * as library from "../../src/stats/library.ts";
import * as load from "../../src/stats/load.ts";
import * as snapshot from "../../src/stats/snapshot.ts";

describe("stats library barrel", () => {
	it("re-exports every runtime export of the aggregate, load and snapshot modules, same bindings", () => {
		// The barrel is a named-export facade, so the coverage gate cannot notice a binding that drifts from its sources.
		const sources: Record<string, unknown> = { ...aggregate, ...load, ...snapshot };
		const exported: Record<string, unknown> = { ...library };
		expect(Object.keys(exported).sort()).toEqual(Object.keys(sources).sort());
		for (const [name, value] of Object.entries(sources)) expect(exported[name], name).toBe(value);
	});
});
