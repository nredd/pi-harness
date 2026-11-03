import assert from "node:assert/strict";
import { test } from "node:test";
import { collector } from "./render.ts";

test("a Node `--expose-gc` hook is used as is, and Bun is not consulted", () => {
	const calls: string[] = [];
	const collect = collector({
		gc: () => calls.push("node"),
		Bun: { gc: () => calls.push("bun") },
	});
	assert.ok(collect);
	collect();
	assert.deepEqual(calls, ["node"]);
});

test("Bun, which has no `--expose-gc`, collects synchronously through `Bun.gc(true)`", () => {
	const args: boolean[] = [];
	const collect = collector({ Bun: { gc: (sync: boolean) => args.push(sync) } });
	assert.ok(collect);
	collect();
	assert.deepEqual(args, [true]);
});

test("a runtime with neither hook has no collector, so the reading is flagged `gc: false`", () => {
	assert.equal(collector({}), undefined);
});
