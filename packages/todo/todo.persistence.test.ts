import { createMockCtx, createMockPi } from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __resetState, registerTodoTool, type TaskDetails, TOOL_NAME } from "./.test-support/home-fixtures.ts";
import { applyPlanApproval } from "./state/plan.ts";
import { replayFromBranch } from "./state/replay.ts";
import { commitState, getState } from "./state/store.ts";
import { STATE_ENTRY_TYPE } from "./tool/types.ts";

beforeEach(__resetState);
afterEach(__resetState);

/** Capture the same custom snapshots the real host appends during execution. */
function setup() {
	const { pi, captured } = createMockPi();
	registerTodoTool(pi);
	const tool = captured.tools.get(TOOL_NAME)!;
	const ctx = createMockCtx();
	const sessionId = ctx.sessionManager.getSessionId();
	const call = async (params: Record<string, unknown>) => {
		const result = await tool.execute!("tc", params as never, undefined, undefined, ctx as never);
		return result.details as TaskDetails;
	};
	const replay = () =>
		replayFromBranch({
			sessionManager: { getBranch: () => captured.entries.map((entry) => ({ type: "custom", ...entry })) },
		});
	return { captured, sessionId, call, replay };
}

describe("atomic batch persistence", () => {
	it("writes one final snapshot, retains Plan metadata and evidence, and never changes historical results", async () => {
		const { captured, sessionId, call, replay } = setup();
		const approved = applyPlanApproval(getState(sessionId), "approved", "# Ship\n\n- Implement\n- Verify\n");
		commitState(sessionId, approved.state);
		const before = await call({ action: "list" });
		const final = await call({
			ops: [
				{ action: "update", id: 1, status: "completed", evidence: "unit suite passed" },
				{ action: "update", id: 2, status: "deferred", reason: "owner postponed verification" },
				{ action: "list" },
			],
		});
		expect(captured.entries).toHaveLength(1);
		expect(captured.entries[0]).toMatchObject({
			customType: STATE_ENTRY_TYPE,
			data: { persistenceVersion: 1, plan: approved.state.plan },
		});
		expect(replay()).toEqual({ tasks: final.tasks, nextId: final.nextId, plan: final.plan });
		expect(before.tasks.map((task) => task.status)).toEqual(["pending", "pending"]);
		await call({ action: "update", id: 2, reason: "new owner decision" });
		expect(final.tasks[1].reason).toBe("owner postponed verification");
		expect(final.tasks[0].evidence).toBe("unit suite passed");
	});

	it("writes nothing for rejected or no-op batches, even after a valid provisional mutation", async () => {
		const { captured, call, replay } = setup();
		await call({ action: "create", subject: "Original" });
		const stable = replay();
		const ignoredField = await call({
			ops: [
				{ action: "update", id: 1, status: "in_progress" },
				{ action: "create", subject: "Must not silently start pending", status: "in_progress" },
			],
		});
		expect(ignoredField.error).toContain("ops[1]: status is not supported for create");
		expect(ignoredField.tasks).toEqual(stable.tasks);
		expect(captured.entries).toHaveLength(1);
		expect(replay()).toEqual(stable);
		const failed = await call({
			ops: [
				{ action: "update", id: 1, subject: "Provisional" },
				{ action: "update", id: 1, status: "completed" },
			],
		});
		expect(failed.error).toContain("ops[1]: evidence required");
		await call({
			ops: [{ action: "update", id: 1, status: "pending" }, { action: "get", id: 1 }, { action: "list" }],
		});
		expect(captured.entries).toHaveLength(1);
		expect(replay()).toEqual(stable);
	});

	it("persists a batch clear followed by id reuse without resurrecting the old subject", async () => {
		const { captured, call, replay } = setup();
		const history = await call({ action: "create", subject: "Before clear" });
		await call({ ops: [{ action: "clear" }, { action: "create", subject: "After clear" }] });
		expect(captured.entries).toHaveLength(2);
		expect(replay().tasks).toEqual([{ id: 1, subject: "After clear", status: "pending" }]);
		expect(history.tasks[0].subject).toBe("Before clear");
	});
});
