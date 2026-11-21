import { expect, it } from "vitest";
import { bootLaunchStack, expectHeld, heldTool } from "../fixtures/launch-stack.ts";

it("char:11 #1176: generation uses general-purpose and shows thinking instead of the tool", async () => {
	const stack = await bootLaunchStack();
	stack.select
		.mockResolvedValueOnce("Create new agent")
		.mockResolvedValueOnce("Project")
		.mockResolvedValueOnce("Generate with Claude (recommended)");
	stack.input.mockResolvedValueOnce("draft a fixture agent").mockResolvedValueOnce("generated");
	const gate = stack.holdAt(heldTool);
	const command = stack.command();
	const id = await expectHeld(gate);
	expect(stack.manager.getRecord(id)?.type).toBe("general-purpose");
	const row = stack.renderRow(id);
	expect(row.widget).toContain("thinking…");
	expect(row.widget).not.toContain(heldTool.tool);
	expect(row.widget).not.toContain("↻");
	expect(row.fleet).toMatch(/running/i);
	expect(await stack.openViewer(id)).toContain(`[Tool: ${heldTool.tool}]`);
	gate.release();
	await command;
});
