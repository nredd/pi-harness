import { beforeAll, expect, it } from "vitest";
import { bootLaunchStack, expectHeld, heldTool, warmLaunchStack } from "../fixtures/launch-stack.ts";

beforeAll(() => warmLaunchStack());

it.each([
	[1, true],
	[2, false],
] as const)("char:%i renders the Agent tool launch (background=%s)", async (_site, background) => {
	const stack = await bootLaunchStack();
	const gate = stack.holdAt(heldTool);
	const result = stack.agent({ run_in_background: background });
	const id = await expectHeld(gate);
	expect(stack.manager.getRecord(id)?.isBackground ?? false).toBe(background);
	stack.expectTracked(id, heldTool);
	expect(await stack.openViewer(id)).toContain(`▍ ${heldTool.tool}`);
	gate.release();
	expect((await result).isError).not.toBe(true);
});
