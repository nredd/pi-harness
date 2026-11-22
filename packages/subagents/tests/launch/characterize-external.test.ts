import { beforeAll, expect, it } from "vitest";
import { flush } from "../fixtures/boot-extension.ts";
import { bootLaunchStack, expectHeld, heldTool, warmLaunchStack } from "../fixtures/launch-stack.ts";

beforeAll(() => warmLaunchStack());

it("char:3 tracks a launch from the RPC bus", async () => {
	const stack = await bootLaunchStack();
	const gate = stack.holdAt(heldTool);
	stack.bus.emit("subagents:rpc:spawn", {
		requestId: "characterize",
		type: "general-purpose",
		prompt: "rpc subject",
	});
	const id = await expectHeld(gate);
	await flush();
	expect(stack.emitted).toContainEqual({
		event: "subagents:rpc:spawn:reply:characterize",
		payload: expect.objectContaining({ success: true, data: expect.objectContaining({ id }) }),
	});
	stack.expectTracked(id, heldTool);
});

it("char:4 tracks a launch from the public manager registry", async () => {
	const stack = await bootLaunchStack();
	const gate = stack.holdAt(heldTool);
	const id = stack.registry.spawn(stack.pi, stack.context, "general-purpose", "registry subject", {
		description: "registry subject",
	});
	expect(await expectHeld(gate)).toBe(id);
	stack.expectTracked(id, heldTool);
});

it.each([
	[5, "direct"],
	[6, "model"],
] as const)("char:%i tracks a mention in %s mode", async (site, mode) => {
	const stack = await bootLaunchStack({ agentMentions: mode });
	const gate = stack.holdAt(heldTool);
	// No parent model: the real clone cannot take a model turn and must fall back.
	expect(await stack.mention("@explore mention subject")).toEqual({ action: "handled" });
	const id = await expectHeld(gate);
	stack.expectTracked(id, heldTool);
	if (site === 6) {
		await flush();
		expect(stack.context.ui.notify).toHaveBeenCalledWith(expect.stringContaining("directly"), "warning");
	}
});
