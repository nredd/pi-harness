import { beforeAll, expect, it } from "vitest";
import { bootLaunchStack, expectHeld, heldTool, warmLaunchStack } from "../fixtures/launch-stack.ts";

beforeAll(() => warmLaunchStack());

it.each([
	[7, "evicted"],
	[12, "foreground"],
	[13, "background"],
] as const)("char:%i tracks the new attempt (%s)", async (site, mode) => {
	const stack = await bootLaunchStack();
	const first = stack.holdAt({ turn: 1, tool: "prior_tool" });
	const started = stack.agent({ run_in_background: true });
	const original = await expectHeld(first);
	await started;
	const record = stack.manager.getRecord(original)!;
	const priorRun = record.runId;
	const originalFile = record.sessionFile;
	first.release();
	await record.promise;
	if (mode === "evicted") {
		stack.clock.advance(61 * 60_000);
		expect(stack.manager.getRecord(original)).toBeUndefined();
		expect(stack.manager.tombstoneById(original)).toBeDefined();
	}
	const gate = stack.holdAt(heldTool);
	const resumed = stack.agent({
		resume: original,
		run_in_background: mode !== "foreground",
		prompt: "continue launch subject",
	});
	const id = await expectHeld(gate);
	if (site === 7) {
		expect(id).not.toBe(original);
		expect(stack.manager.getRecord(id)?.sessionFile).toBe(originalFile);
	} else {
		expect(id).toBe(original);
		expect(record.runId).not.toBe(priorRun);
	}
	stack.expectTracked(id, heldTool);
	expect(stack.renderRow(id).widget).not.toContain("prior_tool");
	gate.release();
	expect((await resumed).isError).not.toBe(true);
});
