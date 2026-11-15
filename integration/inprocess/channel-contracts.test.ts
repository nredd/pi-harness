/**
 * Cross-package parity pins. The packages install standalone and redeclare these literals, so the one
 * place that sees both sides asserts they agree (nredd/pi-harness#867).
 */
import { describe, expect, it } from "vitest";
import { PLAN_APPROVED_EVENT as PLAN_MODE_APPROVED_EVENT } from "../../packages/plan-mode/src/plan-approval.ts";
import { MONITOR_STARTED_EVENT, MONITOR_STOPPED_EVENT } from "../../packages/session-kit/src/monitor/index.ts";
import * as subagentEvents from "../../packages/subagents/src/events.ts";
import { handleBase } from "../../packages/subagents/src/mention.ts";
import { ownerKey } from "../../packages/todo/state/agents.ts";
import * as todo from "../../packages/todo/tool/types.ts";

describe("todo's redeclared channel names", () => {
	it("match plan-mode's approval channel", () => {
		expect(todo.PLAN_APPROVED_EVENT).toBe(PLAN_MODE_APPROVED_EVENT);
	});

	it("match session-kit's monitor lifecycle channels", () => {
		expect(todo.MONITOR_STARTED_EVENT).toBe(MONITOR_STARTED_EVENT);
		expect(todo.MONITOR_STOPPED_EVENT).toBe(MONITOR_STOPPED_EVENT);
		expect(todo.MONITOR_LIFECYCLE_EVENTS).toEqual([MONITOR_STARTED_EVENT, MONITOR_STOPPED_EVENT]);
	});

	it.each([
		["created", todo.SUBAGENT_CREATED_EVENT, subagentEvents.SUBAGENT_CREATED_EVENT],
		["started", todo.SUBAGENT_STARTED_EVENT, subagentEvents.SUBAGENT_STARTED_EVENT],
		["completed", todo.SUBAGENT_COMPLETED_EVENT, subagentEvents.SUBAGENT_COMPLETED_EVENT],
		["failed", todo.SUBAGENT_FAILED_EVENT, subagentEvents.SUBAGENT_FAILED_EVENT],
		["announce_survivors", todo.SUBAGENT_ANNOUNCE_SURVIVORS_EVENT, subagentEvents.SUBAGENT_ANNOUNCE_SURVIVORS_EVENT],
		[
			"other_session_survivor",
			todo.SUBAGENT_OTHER_SESSION_SURVIVOR_EVENT,
			subagentEvents.SUBAGENT_OTHER_SESSION_SURVIVOR_EVENT,
		],
	])("match subagents' %s channel", (_name, theirs, ours) => {
		expect(theirs).toBe(ours);
	});

	it("keep the full lifecycle list", () => {
		expect(todo.SUBAGENT_LIFECYCLE_EVENTS).toEqual([
			subagentEvents.SUBAGENT_CREATED_EVENT,
			subagentEvents.SUBAGENT_STARTED_EVENT,
			subagentEvents.SUBAGENT_COMPLETED_EVENT,
			subagentEvents.SUBAGENT_FAILED_EVENT,
		]);
	});
});

describe("ownerKey parity with subagents' handleBase", () => {
	it.each([
		"auth-audit",
		"Auth Audit",
		"@auth-audit",
		"  Auth  Audit!  ",
		"--Auth.Audit--",
		"snake_case_name",
		"Ünïcödé Nämé",
		"a/b\\c:d",
		"x".repeat(70),
		`${"a".repeat(63)}-b`,
		`${"a".repeat(63)}!!!b`,
		"MiXeD-123_ok",
	])("slugs %j the same way", (name) => {
		expect(ownerKey(name)).toBe(handleBase(name));
	});

	it("diverges only where handleBase falls back to `agent`", () => {
		for (const name of ["", "!!!", " @ "]) {
			expect(handleBase(name)).toBe("agent");
			expect(ownerKey(name)).toBeUndefined();
		}
	});
});
