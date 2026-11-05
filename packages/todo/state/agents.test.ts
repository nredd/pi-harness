import { describe, expect, it } from "vitest";
import {
	STATE_ENTRY_TYPE,
	SUBAGENT_COMPLETED_EVENT,
	SUBAGENT_FAILED_EVENT,
	SUBAGENT_STARTED_EVENT,
} from "../tool/types.ts";
import { agentStateForOwner, applyAgentEvent, isAbandoned, MAX_TRACKED_AGENTS, ownerLabel } from "./agents.ts";

describe("applyAgentEvent", () => {
	it("maps the lifecycle to running, done, failed and stopped", () => {
		applyAgentEvent(SUBAGENT_STARTED_EVENT, { id: "a1", handle: "explore" });
		expect(agentStateForOwner("explore")).toBe("running");
		applyAgentEvent(SUBAGENT_COMPLETED_EVENT, { id: "a1", status: "steered" });
		expect(agentStateForOwner("explore")).toBe("done");
		applyAgentEvent(SUBAGENT_FAILED_EVENT, { id: "a1", status: "stopped" });
		expect(agentStateForOwner("explore")).toBe("stopped");
		for (const status of ["error", "aborted", undefined]) {
			applyAgentEvent(SUBAGENT_FAILED_EVENT, { id: "a1", status });
			expect(agentStateForOwner("explore"), String(status)).toBe("failed");
		}
	});

	it("reports a change only when state or identity moved", () => {
		expect(applyAgentEvent(SUBAGENT_STARTED_EVENT, { id: "a1" })).toBe(true);
		expect(applyAgentEvent(SUBAGENT_STARTED_EVENT, { id: "a1" })).toBe(false);
		expect(applyAgentEvent(SUBAGENT_STARTED_EVENT, { id: "a1", name: "auth-audit" })).toBe(true);
		// A payload without the field keeps the earlier identity.
		expect(applyAgentEvent(SUBAGENT_STARTED_EVENT, { id: "a1" })).toBe(false);
		expect(agentStateForOwner("auth-audit")).toBe("running");
		expect(applyAgentEvent(SUBAGENT_COMPLETED_EVENT, { id: "a1" })).toBe(true);
	});

	it.each([
		["a non-object", "subagents:started", "nope"],
		["null", SUBAGENT_STARTED_EVENT, null],
		["a missing id", SUBAGENT_STARTED_EVENT, { handle: "x" }],
		["an empty id", SUBAGENT_STARTED_EVENT, { id: "" }],
		["an unrelated channel", STATE_ENTRY_TYPE, { id: "a1" }],
	])("ignores %s", (_label, channel, payload) => {
		expect(applyAgentEvent(channel, payload)).toBe(false);
		expect(agentStateForOwner("a1")).toBeUndefined();
	});

	it("drops the least recently updated agent past the cap", () => {
		for (let i = 0; i <= MAX_TRACKED_AGENTS; i++) applyAgentEvent(SUBAGENT_STARTED_EVENT, { id: `a${i}` });
		expect(agentStateForOwner("a0")).toBeUndefined();
		expect(agentStateForOwner("a1")).toBe("running");
		expect(agentStateForOwner(`a${MAX_TRACKED_AGENTS}`)).toBe("running");
	});
});

describe("agentStateForOwner", () => {
	it("matches id, handle or name, case-insensitive with an optional @", () => {
		applyAgentEvent(SUBAGENT_STARTED_EVENT, { id: "AbC123", handle: "explore-2", name: "auth-audit" });
		for (const owner of ["abc123", "@Explore-2", " @AUTH-AUDIT "])
			expect(agentStateForOwner(owner), owner).toBe("running");
	});

	it("returns nothing for free text, a blank owner or no owner", () => {
		applyAgentEvent(SUBAGENT_STARTED_EVENT, { id: "a1", handle: "explore" });
		for (const owner of ["Sergii", "", "  @ ", undefined]) expect(agentStateForOwner(owner)).toBeUndefined();
	});

	it("prefers the most recently updated of two agents sharing a name", () => {
		applyAgentEvent(SUBAGENT_STARTED_EVENT, { id: "old", name: "worker" });
		applyAgentEvent(SUBAGENT_STARTED_EVENT, { id: "new", name: "worker" });
		applyAgentEvent(SUBAGENT_FAILED_EVENT, { id: "new", status: "error" });
		expect(agentStateForOwner("worker")).toBe("failed");
		applyAgentEvent(SUBAGENT_COMPLETED_EVENT, { id: "old" });
		expect(agentStateForOwner("worker")).toBe("done");
	});
});

describe("ownerLabel and isAbandoned", () => {
	it("labels an owner with exactly one @ and strips terminal escapes", () => {
		expect(ownerLabel("auth-audit")).toBe("@auth-audit");
		expect(ownerLabel(" @auth-audit ")).toBe("@auth-audit");
		expect(ownerLabel("who\u009b31mami")).toBe("@whoami");
		expect(ownerLabel("@")).toBeUndefined();
		expect(ownerLabel(undefined)).toBeUndefined();
	});

	it("flags only in_progress todos whose agent failed or stopped", () => {
		expect(isAbandoned({ status: "in_progress" }, "failed")).toBe(true);
		expect(isAbandoned({ status: "in_progress" }, "stopped")).toBe(true);
		expect(isAbandoned({ status: "in_progress" }, "done")).toBe(false);
		expect(isAbandoned({ status: "in_progress" }, undefined)).toBe(false);
		expect(isAbandoned({ status: "pending" }, "failed")).toBe(false);
	});
});
