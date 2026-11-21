import { expect, it } from "vitest";
import { createNestedSubagentTools } from "../../src/nested-tools.ts";
import { bootLaunchStack, expectHeld, heldTool } from "../fixtures/launch-stack.ts";

it.each([
	[9, false],
	[14, true],
] as const)("char:%i keeps the nested attempt off top-level surfaces (resume=%s)", async (_site, resume) => {
	const stack = await bootLaunchStack();
	const parent = stack.holdAt({ turn: 1, tool: "delegate_fixture" });
	const launched = stack.agent({ description: "nested parent", run_in_background: true });
	const parentId = await expectHeld(parent);
	await launched;
	const tools = createNestedSubagentTools({
		manager: stack.manager,
		pi: stack.pi,
		parentAgentId: parentId,
		depth: 1,
		maxSubagentDepth: 2,
		allowedSubagents: "all",
		configCwd: stack.context.cwd,
		projectTrusted: true,
	});
	const agent = tools.find((tool) => tool.name === "Agent")!;
	const start = (id?: string) =>
		agent.execute(
			"nested-case",
			{
				subagent_type: "general-purpose",
				description: "nested child",
				prompt: "child work",
				...(id ? { resume: id } : {}),
			},
			undefined,
			undefined,
			stack.context,
		);
	let priorId: string | undefined;
	if (resume) {
		const first = stack.holdAt({ turn: 1, tool: "prior_child_tool" });
		const result = start();
		priorId = await expectHeld(first);
		first.release();
		expect((await result).isError).not.toBe(true);
	}
	const child = stack.holdAt(heldTool);
	const result = start(priorId);
	const childId = await expectHeld(child);
	if (resume) expect(childId).toBe(priorId);
	expect(stack.manager.getRecord(childId)?.parentAgentId).toBe(parentId);
	stack.expectOwnerScoped(childId);
	stack.expectTracked(parentId, parent);
	child.release();
	expect((await result).isError).not.toBe(true);
});
