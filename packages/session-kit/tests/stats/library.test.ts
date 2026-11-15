import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, expectTypeOf, it } from "vitest";
import * as aggregate from "../../src/stats/aggregate.ts";
import * as library from "../../src/stats/library.ts";
import * as load from "../../src/stats/load.ts";
import * as snapshot from "../../src/stats/snapshot.ts";

it("preserves every runtime binding from the original three export-star targets", () => {
	const original = { ...aggregate, ...load, ...snapshot };
	expect(Object.keys(library).sort()).toEqual(Object.keys(original).sort());
	for (const [name, binding] of Object.entries(original)) expect(Reflect.get(library, name)).toBe(binding);
});

it("preserves every type-only binding from the original export-star targets", () => {
	expectTypeOf<library.Range>().toEqualTypeOf<aggregate.Range>();
	expectTypeOf<library.Filter>().toEqualTypeOf<aggregate.Filter>();
	expectTypeOf<library.ModelTotals>().toEqualTypeOf<aggregate.ModelTotals>();
	expectTypeOf<library.DayPoint>().toEqualTypeOf<aggregate.DayPoint>();
	expectTypeOf<library.HourPoint>().toEqualTypeOf<aggregate.HourPoint>();
	expectTypeOf<library.Overview>().toEqualTypeOf<aggregate.Overview>();
	expectTypeOf<library.SeriesKey>().toEqualTypeOf<aggregate.SeriesKey>();
	expectTypeOf<library.CallTuple>().toEqualTypeOf<load.CallTuple>();
	expectTypeOf<library.FileStats>().toEqualTypeOf<load.FileStats>();
	expectTypeOf<library.Harness>().toEqualTypeOf<load.Harness>();
	expectTypeOf<library.Call>().toEqualTypeOf<load.Call>();
	expectTypeOf<library.Session>().toEqualTypeOf<load.Session>();
	expectTypeOf<library.Loaded>().toEqualTypeOf<load.Loaded>();
	expectTypeOf<library.LoadOptions>().toEqualTypeOf<load.LoadOptions>();
	expectTypeOf<library.Identity>().toEqualTypeOf<snapshot.Identity>();
	expectTypeOf<library.SnapshotEvent>().toEqualTypeOf<snapshot.SnapshotEvent>();
	expectTypeOf<library.SnapshotSession>().toEqualTypeOf<snapshot.SnapshotSession>();
	expectTypeOf<library.Shard>().toEqualTypeOf<snapshot.Shard>();
	expectTypeOf<library.Manifest>().toEqualTypeOf<snapshot.Manifest>();
	expectTypeOf<library.MachineSnapshot>().toEqualTypeOf<snapshot.MachineSnapshot>();
	expectTypeOf<library.GlobalCache>().toEqualTypeOf<snapshot.GlobalCache>();
	expectTypeOf<library.MachineCoverage>().toEqualTypeOf<snapshot.MachineCoverage>();
	expectTypeOf<library.Coverage>().toEqualTypeOf<snapshot.Coverage>();
	expectTypeOf<library.Combined>().toEqualTypeOf<snapshot.Combined>();
});

it("imports the same public namespace through real Node and Bun without Vitest transforms", () => {
	const dir = mkdtempSync(join(tmpdir(), "kit-library-import-"));
	const modules = ["library", "aggregate", "load", "snapshot"].map(
		(name) => new URL(`../../src/stats/${name}.ts`, import.meta.url).href,
	);
	const code = `import assert from 'node:assert/strict';
const [library, ...targets] = await Promise.all(${JSON.stringify(modules)}.map(path => import(path)));
const original = Object.assign({}, ...targets);
assert.deepEqual(Object.keys(library).sort(), Object.keys(original).sort());
for (const [name, binding] of Object.entries(original)) assert.equal(library[name], binding);
console.log(JSON.stringify(Object.keys(library).sort()));`;
	try {
		const results = ["node", "bun"].map((engine) => {
			const result = spawnSync(engine, ["--input-type=module", "-e", code], {
				encoding: "utf8",
				timeout: 5_000,
				env: {
					PATH: process.env.PATH,
					HOME: dir,
					USERPROFILE: dir,
					XDG_CONFIG_HOME: join(dir, ".config"),
					PI_CODING_AGENT_DIR: join(dir, ".pi", "agent"),
					PI_OFFLINE: "1",
				},
			});
			expect(result.status, `${engine}: ${result.stderr}`).toBe(0);
			return JSON.parse(result.stdout) as string[];
		});
		expect(results[0]).toEqual(Object.keys(library).sort());
		expect(results[1]).toEqual(results[0]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
