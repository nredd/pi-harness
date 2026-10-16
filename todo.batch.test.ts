import { createMockCtx, createMockPi } from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyPlanApproval } from "./state/plan.js";
import { commitState, getState } from "./state/store.js";
import { __resetState, registerTodoTool, setActiveRenderSession, type TaskDetails, TOOL_NAME } from "./todo.js";

type Params = Record<string, unknown>;

function setup() {
	__resetState();
	setActiveRenderSession("test-session");
	const { pi, captured } = createMockPi();
	registerTodoTool(pi);
	const tool = captured.tools.get(TOOL_NAME)!;
	const ctx = createMockCtx();
	const call = async (params: Params) => {
		const result = await tool.execute?.("tc", params as never, undefined as never, undefined as never, ctx as never);
		return { text: (result!.content[0] as { text: string }).text, details: result!.details as TaskDetails };
	};
	return { call, ctx };
}

beforeEach(() => __resetState());
afterEach(() => __resetState());

describe("todo ops batch", () => {
	it("creates many todos in one call and reports each op", async () => {
		const { call } = setup();
		const { text, details } = await call({
			ops: [
				{ action: "create", subject: "a" },
				{ action: "create", subject: "b" },
				{ action: "create", subject: "c" },
			],
		});
		expect(details.action).toBe("batch");
		expect(details.tasks.map((t) => t.subject)).toEqual(["a", "b", "c"]);
		expect(text).toContain("Applied 3 ops");
		expect(text).toContain("[0] Created #1: a (pending)");
		expect(text).toContain("[2] Created #3: c (pending)");
	});

	it("closes many todos at once, each with its own evidence", async () => {
		const { call } = setup();
		const n = 24;
		await call({ ops: Array.from({ length: n }, (_, i) => ({ action: "create", subject: `t${i + 1}` })) });
		const { details } = await call({
			ops: Array.from({ length: n }, (_, i) => ({
				action: "update",
				id: i + 1,
				status: "completed",
				evidence: `proof ${i + 1}`,
			})),
		});
		expect(details.tasks).toHaveLength(n);
		expect(details.tasks.every((t) => t.status === "completed")).toBe(true);
		expect(details.tasks[4].evidence).toBe("proof 5");
	});

	it("is atomic: one invalid op rolls everything back and names its index", async () => {
		const { call } = setup();
		await call({
			ops: [
				{ action: "create", subject: "a" },
				{ action: "create", subject: "b" },
			],
		});
		const { text, details } = await call({
			ops: [
				{ action: "update", id: 1, status: "completed", evidence: "ok" },
				{ action: "create", subject: "c" },
				{ action: "update", id: 2, status: "completed" },
			],
		});
		expect(text).toContain("Error: ops[2]: evidence required");
		expect(details.error).toContain("ops[2]");
		expect(details.tasks.map((t) => t.status)).toEqual(["pending", "pending"]);
		expect(details.nextId).toBe(3);
	});

	it("applies mutations in order, so a later op sees an earlier one", async () => {
		const { call } = setup();
		const { details } = await call({
			ops: [
				{ action: "create", subject: "a" },
				{ action: "update", id: 1, status: "in_progress" },
				{ action: "update", id: 1, status: "completed", evidence: "ok" },
			],
		});
		expect(details.tasks[0].status).toBe("completed");
	});

	it("answers list/get from the final state", async () => {
		const { call } = setup();
		const { text } = await call({
			ops: [{ action: "list" }, { action: "create", subject: "fresh" }, { action: "get", id: 1 }],
		});
		expect(text).toContain("[0] [pending] #1 fresh");
		expect(text).toContain("[1] Created #1: fresh");
		expect(text).toContain("[2] #1 [pending] fresh");
	});

	it("reports mutation outcomes from the operation that produced them", async () => {
		const { call } = setup();
		const { text } = await call({
			ops: [{ action: "create", subject: "first" }, { action: "clear" }, { action: "create", subject: "second" }],
		});
		expect(text).toContain("[0] Created #1: first (pending)");
		expect(text).toContain("[2] Created #1: second (pending)");
	});

	it("renders repeated plan deferral reasons locally and notifies the final reason once", async () => {
		const { call, ctx } = setup();
		(ctx as { hasUI: boolean }).hasUI = true;
		const sid = (ctx as { sessionManager: { getSessionId(): string } }).sessionManager.getSessionId();
		const plan = applyPlanApproval(getState(sid), "p1", "# T\n\n- one\n");
		commitState(sid, plan.state);

		const { text } = await call({
			ops: [
				{ action: "update", id: 1, status: "deferred", reason: "needs design" },
				{ action: "update", id: 1, status: "deferred", reason: "needs approval" },
			],
		});
		expect(text).toContain(
			"[0] Updated #1 (pending → deferred). Tell the user this plan item is descoped and why: needs design",
		);
		expect(text).toContain("[1] Updated #1. Tell the user this plan item is descoped and why: needs approval");
		expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
		expect(ctx.ui.notify).toHaveBeenCalledWith("Plan item deferred: #1 one -- needs approval", "warning");
	});

	it("reports and notifies a normal single plan deferral", async () => {
		const { call, ctx } = setup();
		(ctx as { hasUI: boolean }).hasUI = true;
		const sid = (ctx as { sessionManager: { getSessionId(): string } }).sessionManager.getSessionId();
		const plan = applyPlanApproval(getState(sid), "p1", "# T\n\n- one\n");
		commitState(sid, plan.state);

		const { text } = await call({ action: "update", id: 1, status: "deferred", reason: "needs design" });
		expect(text).toContain("Tell the user this plan item is descoped and why: needs design");
		expect(ctx.ui.notify).toHaveBeenCalledWith("Plan item deferred: #1 one -- needs design", "warning");
	});

	it("does not notify for a transient batch deferral that is reopened", async () => {
		const { call, ctx } = setup();
		(ctx as { hasUI: boolean }).hasUI = true;
		const sid = (ctx as { sessionManager: { getSessionId(): string } }).sessionManager.getSessionId();
		const plan = applyPlanApproval(getState(sid), "p1", "# T\n\n- one\n");
		commitState(sid, plan.state);

		const { text } = await call({
			ops: [
				{ action: "update", id: 1, status: "deferred", reason: "needs design" },
				{ action: "update", id: 1, status: "pending" },
			],
		});
		expect(text).toContain("Tell the user this plan item is descoped and why: needs design");
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});

	it("shows the source of carried plan evidence in list and get results", async () => {
		const { call, ctx } = setup();
		const sid = (ctx as { sessionManager: { getSessionId(): string } }).sessionManager.getSessionId();
		commitState(sid, {
			tasks: [
				{
					id: 2,
					subject: "Ship it",
					status: "completed",
					source: "plan",
					evidence: "npm test",
					planProvenance: { planId: "p1", taskId: 7 },
				},
			],
			nextId: 3,
			plan: { id: "p2", title: "Revised plan" },
		});

		expect((await call({ action: "list" })).text).toContain("    carried from plan p1 task #7");
		expect((await call({ action: "get", id: 2 })).text).toContain("  carried from plan p1 task #7");
	});

	it("supports delete and clear inside a batch", async () => {
		const { call } = setup();
		await call({
			ops: [
				{ action: "create", subject: "a" },
				{ action: "create", subject: "b" },
			],
		});
		const { details } = await call({ ops: [{ action: "delete", id: 1 }, { action: "clear" }] });
		expect(details.tasks).toEqual([]);
	});

	it.each([
		[{ ops: [] }, "ops must not be empty"],
		[{ action: "list", ops: [{ action: "list" }] }, "ops can't be combined"],
		[{ subject: "x", ops: [{ action: "list" }] }, "ops can't be combined"],
		[{ ops: [{ subject: "x" }] }, "ops[0]: action required"],
		[{ ops: [{ action: "list", ops: [] }] }, "ops[0]: ops can't be nested"],
		[{}, "action required (or pass ops)"],
	])("rejects malformed call %j", async (params, message) => {
		const { call } = setup();
		const { text, details } = await call(params as Params);
		expect(text).toContain(message);
		expect(details.error).toContain(message);
	});

	it("keeps the flat single-op form working", async () => {
		const { call } = setup();
		const { details } = await call({ action: "create", subject: "solo" });
		expect(details.action).toBe("create");
	});

	it("enforces plan-item rules inside a batch and closes plan items in one call", async () => {
		const { call, ctx } = setup();
		const sid = (ctx as { sessionManager: { getSessionId(): string } }).sessionManager.getSessionId();
		const plan = applyPlanApproval(getState(sid), "p1", "# T\n\n## Work\n- one\n- two\n- three\n");
		commitState(sid, plan.state);

		const dup = await call({ ops: [{ action: "create", subject: "ONE" }] });
		expect(dup.text).toContain("ops[0]: #1 is already a plan item; update it");

		const del = await call({ ops: [{ action: "update", id: 1, status: "deleted" }] });
		expect(del.text).toContain("ops[0]:");
		expect(del.text).toContain("can't be deleted");

		const done = await call({
			ops: [
				{ action: "update", id: 1, status: "completed", evidence: "a" },
				{ action: "update", id: 2, status: "completed", evidence: "b" },
				{ action: "update", id: 3, status: "deferred", reason: "later" },
			],
		});
		expect(done.details.tasks.map((t) => t.status)).toEqual(["completed", "completed", "deferred"]);
		expect(done.text).toContain("Plan: T -- 0/3 plan items open");
		expect(done.details.plan).toEqual({ id: "p1", title: "T" });
	});
});
