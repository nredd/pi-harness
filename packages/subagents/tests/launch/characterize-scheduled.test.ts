import { expect, it } from "vitest";
import { QUOTA_RESTART_GRACE_MS } from "../../src/quota-admission.ts";
import { flush } from "../fixtures/boot-extension.ts";
import { bootLaunchStack, expectHeld, heldTool } from "../fixtures/launch-stack.ts";

it.each([
	["cron", "* * * * * *"],
	["interval", "1s"],
	["one-shot", "once"],
] as const)("char:8 #1176: %s shows thinking without the live tool or turn", async (_kind, schedule) => {
	const stack = await bootLaunchStack();
	const gate = stack.holdAt(heldTool);
	const result = await stack.agent({
		schedule: schedule === "once" ? new Date(stack.clock.now() + 1000).toISOString() : schedule,
		run_in_background: true,
		description: "scheduled subject",
	});
	expect(result.content[0].text).toContain('Scheduled "scheduled subject"');
	expect(stack.manager.listAgents()).toEqual([]);
	stack.clock.advance(1000);
	const id = await expectHeld(gate);
	expect(stack.emitted).toContainEqual({
		event: "subagents:scheduled",
		payload: expect.objectContaining({ type: "fired", agentId: id }),
	});
	await expectUntrackedSchedule(stack, id);
});

it("char:8 #1176: a quota-parked fire shows thinking without the live tool or turn", async () => {
	const stack = await bootLaunchStack();
	stack.context.model = { provider: "fixture", id: "model", name: "Model" };
	const resetAt = stack.clock.now() + 1000;
	let requests = 0;
	const off = stack.bus.on("router:rpc:admit", (raw) => {
		const { requestId } = raw as { requestId: string };
		stack.bus.emit(`router:rpc:admit:reply:${requestId}`, {
			success: true,
			data: ++requests === 1 ? { ok: false, resetAt } : { ok: true },
		});
	});
	try {
		const gate = stack.holdAt(heldTool);
		const launch = stack.agent({ run_in_background: true, description: "quota subject" });
		await flush();
		expect(requests, "initial quota check").toBe(1);
		const result = await launch;
		expect(result.content[0].text).toContain("Queued");
		expect(stack.scheduler.list()).toEqual([expect.objectContaining({ quotaParked: true })]);
		expect(stack.manager.listAgents()).toEqual([]);
		stack.clock.advance(1000 + QUOTA_RESTART_GRACE_MS);
		await flush();
		expect(requests, "fire-time quota check").toBe(2);
		const id = await expectHeld(gate);
		await expectUntrackedSchedule(stack, id);
	} finally {
		off();
	}
});

async function expectUntrackedSchedule(stack: Awaited<ReturnType<typeof bootLaunchStack>>, id: string) {
	const row = stack.renderRow(id);
	expect(row.widget).toContain("thinking…");
	expect(row.widget).not.toContain(heldTool.tool);
	expect(row.widget).not.toContain("↻");
	expect(row.fleet).toMatch(/running/i);
	expect(await stack.openViewer(id)).toContain(`[Tool: ${heldTool.tool}]`);
	expect(stack.manager.getRecord(id)?.outputFile).toBeUndefined();
}
