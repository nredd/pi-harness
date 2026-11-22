import { expect, it, vi } from "vitest";
import { bootLaunchStack, expectHeld, heldTool } from "../fixtures/launch-stack.ts";

it.each([
	[10, false],
	[15, true],
] as const)("char:%i #1176: workflow viewer omits live activity (resume=%s)", async (_site, resume) => {
	const stack = await bootLaunchStack();
	const prior = { turn: 1, tool: "prior_workflow_tool" };
	const first = stack.holdAt(resume ? prior : heldTool);
	const result = await stack.execute("SubagentWorkflow", {
		script:
			'export const meta = { name: "workflow subject", description: "characterization" };\n' +
			'await agent("workflow child", { label: "child" });\n' +
			(resume ? 'return await agent("continue workflow child", { resume: "child" });' : ""),
	});
	expect(result.isError).not.toBe(true);
	const id = await expectHeld(first);
	const record = stack.manager.getRecord(id)!;
	const firstRun = record.runId;
	if (resume) {
		// Arm the resume before settling the first attempt; its worker can continue immediately.
		const second = stack.holdAt(heldTool);
		first.release();
		expect(await expectHeld(second)).toBe(id);
		expect(record.runId).not.toBe(firstRun);
	}
	expect(record.workflowId).toBeDefined();
	stack.expectOwnerScoped(id);
	expect(stack.fleet().join("\n")).toContain("workflow subject");
	vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
	try {
		const viewer = await stack.openViewer(id, (lines) => {
			expect(vi.getTimerCount(), "workflow inspector spinner must be armed").toBeGreaterThan(0);
			const inspector = lines.join("\n");
			expect(inspector).toContain(resume ? "1/2 agents" : "0/1 agent");
			expect(inspector).not.toContain(heldTool.tool);
			// The default selection stays on the completed invocation while its resume runs.
			if (resume) expect(inspector).toContain("❯ ✔ child");
		});
		expect(viewer).toContain(`[Tool: ${heldTool.tool}]`);
		// Unlike the top-level widget fallback, the workflow viewer omits the footer entirely.
		expect(viewer).not.toContain("▍");
		if (resume) expect(viewer).toContain(`[Tool: ${prior.tool}]`);
	} finally {
		try {
			stack.closeOverlays();
			expect(vi.getTimerCount(), "workflow overlays must clear their native intervals").toBe(0);
		} finally {
			vi.useRealTimers();
		}
	}
});
