import { describe, expect, it } from "vitest";
// pi-subagents' own slugger, imported from source so the two cannot drift unnoticed.
import { handleBase } from "../../subagents/src/mention.ts";
import {
	STATE_ENTRY_TYPE,
	SUBAGENT_COMPLETED_EVENT,
	SUBAGENT_CREATED_EVENT,
	SUBAGENT_FAILED_EVENT,
	SUBAGENT_STARTED_EVENT,
} from "../tool/types.ts";
import {
	agentLookup,
	agentStateFor,
	applyAgentEvent,
	forgetAgents,
	isAbandoned,
	MAX_TRACKED_AGENTS,
	ownerKey,
	ownerLabel,
} from "./agents.ts";

const S = "s1";
const apply = (channel: string, payload: unknown) => applyAgentEvent(S, channel, payload);
const stateOf = (owner: string | undefined) => agentStateFor(S, owner);

describe("applyAgentEvent", () => {
	it("maps the lifecycle to running, done, failed and stopped", () => {
		apply(SUBAGENT_STARTED_EVENT, { id: "a1", handle: "explore" });
		expect(stateOf("explore")).toBe("running");
		apply(SUBAGENT_COMPLETED_EVENT, { id: "a1", status: "steered" });
		expect(stateOf("explore")).toBe("done");
		apply(SUBAGENT_FAILED_EVENT, { id: "a1", status: "stopped" });
		expect(stateOf("explore")).toBe("stopped");
		for (const status of ["error", "aborted", undefined]) {
			apply(SUBAGENT_FAILED_EVENT, { id: "a1", status });
			expect(stateOf("explore"), String(status)).toBe("failed");
		}
	});

	it("reads a first-heard created as queued until it starts", () => {
		expect(apply(SUBAGENT_CREATED_EVENT, { id: "a1", handle: "explore" })).toBe(true);
		expect(stateOf("explore")).toBe("queued");
		expect(apply(SUBAGENT_STARTED_EVENT, { id: "a1" })).toBe(true);
		expect(stateOf("explore")).toBe("running");
	});

	it("never lets a re-announcing created override a started or settled agent", () => {
		apply(SUBAGENT_STARTED_EVENT, { id: "a1", handle: "explore" });
		expect(apply(SUBAGENT_CREATED_EVENT, { id: "a1", handle: "explore" })).toBe(false);
		expect(stateOf("explore")).toBe("running");
		apply(SUBAGENT_COMPLETED_EVENT, { id: "a1" });
		expect(apply(SUBAGENT_CREATED_EVENT, { id: "a1" })).toBe(false);
		expect(stateOf("explore")).toBe("done");
		// A reopened agent's predecessor is known too, so its created is no new queue entry.
		expect(apply(SUBAGENT_CREATED_EVENT, { id: "a2", previousId: "a1" })).toBe(false);
		expect(stateOf("explore")).toBe("done");
	});

	it("accepts only a queued resume bound to the most recent settle", () => {
		apply(SUBAGENT_STARTED_EVENT, { id: "resume", handle: "resume" });
		apply(SUBAGENT_FAILED_EVENT, { id: "resume", status: "error", settleSeq: 10 });
		const queued = { id: "resume", queuedAfterSettleSeq: 10, queuedResumeSeq: 11 };
		expect(apply(SUBAGENT_CREATED_EVENT, queued)).toBe(true);
		expect(stateOf("resume")).toBe("queued");
		expect(apply(SUBAGENT_CREATED_EVENT, queued)).toBe(false);
		apply(SUBAGENT_STARTED_EVENT, { id: "resume" });
		expect(apply(SUBAGENT_CREATED_EVENT, queued)).toBe(false);
		apply(SUBAGENT_COMPLETED_EVENT, { id: "resume", settleSeq: 20 });
		expect(apply(SUBAGENT_CREATED_EVENT, queued)).toBe(false);
		expect(stateOf("resume")).toBe("done");
		expect(apply(SUBAGENT_CREATED_EVENT, { id: "resume", queuedAfterSettleSeq: 20, queuedResumeSeq: 21 })).toBe(true);
		expect(stateOf("resume")).toBe("queued");
	});

	it("does not let an older settled retry mask a newly queued resume", () => {
		apply(SUBAGENT_STARTED_EVENT, { id: "a1", name: "auth-audit", nameBase: "auth-audit", spawnSeq: 1 });
		apply(SUBAGENT_FAILED_EVENT, { id: "a1", status: "error", settleSeq: 2 });
		apply(SUBAGENT_STARTED_EVENT, { id: "a2", name: "auth-audit-2", nameBase: "auth-audit", spawnSeq: 3 });
		apply(SUBAGENT_COMPLETED_EVENT, { id: "a2", settleSeq: 4 });
		apply(SUBAGENT_CREATED_EVENT, { id: "a1", queuedAfterSettleSeq: 2, queuedResumeSeq: 5 });
		expect(stateOf("auth-audit")).toBe("queued");
		apply(SUBAGENT_STARTED_EVENT, { id: "a3", name: "auth-audit-3", nameBase: "auth-audit", spawnSeq: 6 });
		apply(SUBAGENT_FAILED_EVENT, { id: "a3", status: "error", settleSeq: 7 });
		expect(stateOf("auth-audit")).toBe("failed");
	});

	it("lets a settled nameBase retry outrank an owner still queued", () => {
		apply(SUBAGENT_CREATED_EVENT, { id: "a1", name: "auth-audit", nameBase: "auth-audit" });
		apply(SUBAGENT_STARTED_EVENT, { id: "a2", name: "auth-audit-2", nameBase: "auth-audit" });
		// A running sibling does not outrank the queued owner; a settled one does.
		expect(stateOf("auth-audit")).toBe("queued");
		apply(SUBAGENT_FAILED_EVENT, { id: "a2", status: "error" });
		expect(stateOf("auth-audit")).toBe("failed");
		apply(SUBAGENT_STARTED_EVENT, { id: "a3", name: "auth-audit-3", nameBase: "auth-audit" });
		apply(SUBAGENT_COMPLETED_EVENT, { id: "a3" });
		expect(stateOf("auth-audit")).toBe("done");
	});

	it("keeps a fresh queued owner over an older settled nameBase sibling", () => {
		const fields = (id: string, name: string, spawnSeq: number) => ({ id, name, nameBase: "auth-audit", spawnSeq });
		apply(SUBAGENT_CREATED_EVENT, fields("a1", "auth-audit", 1));
		apply(SUBAGENT_STARTED_EVENT, fields("a1", "auth-audit", 1));
		apply(SUBAGENT_CREATED_EVENT, fields("a2", "auth-audit-2", 2));
		apply(SUBAGENT_STARTED_EVENT, fields("a2", "auth-audit-2", 2));
		apply(SUBAGENT_COMPLETED_EVENT, { ...fields("a1", "auth-audit", 1), settleSeq: 3 });
		apply(SUBAGENT_COMPLETED_EVENT, { ...fields("a2", "auth-audit-2", 2), settleSeq: 4 });
		// The bare name is free again and a fresh owner queues: the old sibling says nothing about it.
		apply(SUBAGENT_CREATED_EVENT, fields("a9", "auth-audit", 50));
		expect(stateOf("auth-audit")).toBe("queued");
		// A retry spawned after it still outranks it once settled.
		apply(SUBAGENT_STARTED_EVENT, fields("a10", "auth-audit-2", 51));
		apply(SUBAGENT_FAILED_EVENT, { ...fields("a10", "auth-audit-2", 51), status: "error", settleSeq: 52 });
		expect(stateOf("auth-audit")).toBe("failed");
	});

	it("reports a change only when state or identity moved", () => {
		expect(apply(SUBAGENT_STARTED_EVENT, { id: "a1" })).toBe(true);
		expect(apply(SUBAGENT_STARTED_EVENT, { id: "a1" })).toBe(false);
		expect(apply(SUBAGENT_STARTED_EVENT, { id: "a1", name: "auth-audit" })).toBe(true);
		// A payload without the field keeps the earlier identity.
		expect(apply(SUBAGENT_STARTED_EVENT, { id: "a1" })).toBe(false);
		expect(stateOf("auth-audit")).toBe("running");
		expect(apply(SUBAGENT_COMPLETED_EVENT, { id: "a1" })).toBe(true);
	});

	it.each([
		["a non-object", "subagents:started", "nope"],
		["null", SUBAGENT_STARTED_EVENT, null],
		["a missing id", SUBAGENT_STARTED_EVENT, { handle: "x" }],
		["an empty id", SUBAGENT_STARTED_EVENT, { id: "" }],
		["an unrelated channel", STATE_ENTRY_TYPE, { id: "a1" }],
	])("ignores %s", (_label, channel, payload) => {
		expect(apply(channel, payload)).toBe(false);
		expect(stateOf("a1")).toBeUndefined();
	});

	it("drops the least recently updated agent past the cap", () => {
		for (let i = 0; i <= MAX_TRACKED_AGENTS; i++) apply(SUBAGENT_STARTED_EVENT, { id: `a${i}` });
		expect(stateOf("a0")).toBeUndefined();
		expect(stateOf("a1")).toBe("running");
		expect(stateOf(`a${MAX_TRACKED_AGENTS}`)).toBe("running");
	});

	it("keys a previous id this session never tracked", () => {
		apply(SUBAGENT_STARTED_EVENT, { id: "new", previousId: "evicted-before-tracking" });
		expect(stateOf("evicted-before-tracking")).toBe("running");
	});

	it("follows a reopened agent from its previous id", () => {
		apply(SUBAGENT_STARTED_EVENT, { id: "old", handle: "explore" });
		apply(SUBAGENT_FAILED_EVENT, { id: "old", status: "error" });
		expect(apply(SUBAGENT_STARTED_EVENT, { id: "new", handle: "explore", previousId: "old" })).toBe(true);
		expect(stateOf("old")).toBe("running");
		apply(SUBAGENT_COMPLETED_EVENT, { id: "new" });
		expect(stateOf("old")).toBe("done");
		// Chained reopens keep every earlier id.
		apply(SUBAGENT_STARTED_EVENT, { id: "newer", previousId: "new" });
		expect(stateOf("old")).toBe("running");
		expect(stateOf("new")).toBe("running");
	});
});

describe("agentStateFor", () => {
	it("matches id, handle or name, case-insensitive with an optional @", () => {
		apply(SUBAGENT_STARTED_EVENT, { id: "AbC123", handle: "explore-2", name: "auth-audit" });
		for (const owner of ["abc123", "@Explore-2", " @AUTH-AUDIT "]) expect(stateOf(owner), owner).toBe("running");
	});

	it("slugs the owner like a handle, so a spawner name matches its handle", () => {
		apply(SUBAGENT_STARTED_EVENT, { id: "a1", name: "auth-audit" });
		for (const owner of ["Auth Audit", "auth  audit!", "--Auth.Audit--"])
			expect(stateOf(owner), owner).toBe("running");
		expect(stateOf("authaudit")).toBeUndefined();
	});

	it("prefers a retry spawned under the same name over the failed first try", () => {
		apply(SUBAGENT_STARTED_EVENT, { id: "a1", name: "auth-audit", nameBase: "auth-audit" });
		apply(SUBAGENT_FAILED_EVENT, { id: "a1", status: "error" });
		// The first try still holds `auth-audit`, so the retry is numbered.
		apply(SUBAGENT_STARTED_EVENT, { id: "a2", name: "auth-audit-2", nameBase: "auth-audit" });
		expect(stateOf("Auth Audit")).toBe("running");
		expect(stateOf("a1")).toBe("failed");
	});

	it("keeps a running owner when a parallel same-name spawn fails", () => {
		apply(SUBAGENT_STARTED_EVENT, { id: "a1", name: "auth-audit", nameBase: "auth-audit" });
		apply(SUBAGENT_STARTED_EVENT, { id: "a2", name: "auth-audit-2", nameBase: "auth-audit" });
		apply(SUBAGENT_FAILED_EVENT, { id: "a2", status: "error" });
		expect(stateOf("@auth-audit")).toBe("running");
		expect(isAbandoned({ status: "in_progress" }, stateOf("@auth-audit"))).toBe(false);
		expect(stateOf("auth-audit-2")).toBe("failed");
	});

	it("keeps a running unnamed agent when a sibling named after its handle fails", () => {
		apply(SUBAGENT_STARTED_EVENT, { id: "e1", handle: "explore" });
		apply(SUBAGENT_STARTED_EVENT, { id: "s1", handle: "scout", name: "explore-2", nameBase: "explore" });
		apply(SUBAGENT_FAILED_EVENT, { id: "s1", status: "error" });
		expect(stateOf("@explore")).toBe("running");
		// Once nothing matching runs, the most recently updated settles it.
		apply(SUBAGENT_COMPLETED_EVENT, { id: "e1" });
		expect(stateOf("@explore")).toBe("done");
	});

	it("returns nothing for free text, a blank owner or no owner", () => {
		apply(SUBAGENT_STARTED_EVENT, { id: "a1", handle: "explore" });
		for (const owner of ["Sergii", "", "  @ ", undefined]) expect(stateOf(owner)).toBeUndefined();
	});

	it("takes the most recently updated of two exact matches", () => {
		apply(SUBAGENT_STARTED_EVENT, { id: "old", name: "worker" });
		apply(SUBAGENT_STARTED_EVENT, { id: "new", name: "worker" });
		apply(SUBAGENT_FAILED_EVENT, { id: "new", status: "error" });
		expect(stateOf("worker")).toBe("failed");
		apply(SUBAGENT_COMPLETED_EVENT, { id: "old" });
		expect(stateOf("worker")).toBe("done");
	});

	it("reports the owner's own failure while a same-name sibling still runs", () => {
		apply(SUBAGENT_STARTED_EVENT, { id: "a1", name: "auth-audit", nameBase: "auth-audit" });
		apply(SUBAGENT_STARTED_EVENT, { id: "a2", name: "auth-audit-2", nameBase: "auth-audit" });
		apply(SUBAGENT_FAILED_EVENT, { id: "a1", status: "error" });
		expect(stateOf("@auth-audit")).toBe("failed");
		expect(isAbandoned({ status: "in_progress" }, stateOf("@auth-audit"))).toBe(true);
		expect(stateOf("auth-audit-2")).toBe("running");
	});

	it("flips the owner to done while a same-name sibling still runs", () => {
		apply(SUBAGENT_STARTED_EVENT, { id: "a1", name: "auth-audit", nameBase: "auth-audit" });
		apply(SUBAGENT_STARTED_EVENT, { id: "a2", name: "auth-audit-2", nameBase: "auth-audit" });
		apply(SUBAGENT_COMPLETED_EVENT, { id: "a1" });
		expect(stateOf("@auth-audit")).toBe("done");
	});

	it("reports an unnamed agent's failure while a sibling named after its handle runs", () => {
		apply(SUBAGENT_STARTED_EVENT, { id: "e1", handle: "explore" });
		apply(SUBAGENT_STARTED_EVENT, { id: "s1", handle: "scout", name: "explore-2", nameBase: "explore" });
		apply(SUBAGENT_FAILED_EVENT, { id: "e1", status: "error" });
		expect(stateOf("@explore")).toBe("failed");
	});

	it("follows the latest of several retries started after the owner settled", () => {
		apply(SUBAGENT_STARTED_EVENT, { id: "a1", name: "auth-audit", nameBase: "auth-audit" });
		apply(SUBAGENT_FAILED_EVENT, { id: "a1", status: "error" });
		apply(SUBAGENT_STARTED_EVENT, { id: "a2", name: "auth-audit-2", nameBase: "auth-audit" });
		apply(SUBAGENT_FAILED_EVENT, { id: "a2", status: "error" });
		apply(SUBAGENT_STARTED_EVENT, { id: "a3", name: "auth-audit-3", nameBase: "auth-audit" });
		expect(stateOf("Auth Audit")).toBe("running");
		apply(SUBAGENT_COMPLETED_EVENT, { id: "a3" });
		// a2 updated last but started before a3: the latest-started retry decides.
		apply(SUBAGENT_FAILED_EVENT, { id: "a2", status: "error" });
		expect(stateOf("Auth Audit")).toBe("done");
	});

	it("keeps the owner's failure when a concurrent sibling is later resumed", () => {
		apply(SUBAGENT_STARTED_EVENT, { id: "a1", name: "auth-audit", nameBase: "auth-audit" });
		apply(SUBAGENT_STARTED_EVENT, { id: "a2", name: "auth-audit-2", nameBase: "auth-audit" });
		apply(SUBAGENT_FAILED_EVENT, { id: "a1", status: "error" });
		apply(SUBAGENT_COMPLETED_EVENT, { id: "a2" });
		expect(stateOf("@auth-audit")).toBe("failed");
		apply(SUBAGENT_STARTED_EVENT, { id: "a2", name: "auth-audit-2", nameBase: "auth-audit" });
		expect(stateOf("@auth-audit")).toBe("failed");
		expect(stateOf("auth-audit-2")).toBe("running");
	});

	it("keeps the owner's failure when a concurrent sibling is later reopened under a new id", () => {
		apply(SUBAGENT_STARTED_EVENT, { id: "a1", name: "auth-audit", nameBase: "auth-audit" });
		apply(SUBAGENT_STARTED_EVENT, { id: "a2", name: "auth-audit-2", nameBase: "auth-audit" });
		apply(SUBAGENT_FAILED_EVENT, { id: "a1", status: "error" });
		apply(SUBAGENT_COMPLETED_EVENT, { id: "a2" });
		apply(SUBAGENT_STARTED_EVENT, { id: "a3", previousId: "a2", name: "auth-audit-2", nameBase: "auth-audit" });
		expect(stateOf("@auth-audit")).toBe("failed");
		expect(stateOf("a2")).toBe("running");
	});

	it("still follows a real retry once it is resumed", () => {
		apply(SUBAGENT_STARTED_EVENT, { id: "a1", name: "auth-audit", nameBase: "auth-audit" });
		apply(SUBAGENT_FAILED_EVENT, { id: "a1", status: "error" });
		apply(SUBAGENT_STARTED_EVENT, { id: "a2", name: "auth-audit-2", nameBase: "auth-audit" });
		apply(SUBAGENT_COMPLETED_EVENT, { id: "a2" });
		apply(SUBAGENT_STARTED_EVENT, { id: "a2" });
		expect(stateOf("Auth Audit")).toBe("running");
	});

	it("orders retries by their latest start, so a resumed earlier retry wins", () => {
		apply(SUBAGENT_STARTED_EVENT, { id: "a1", name: "auth-audit", nameBase: "auth-audit" });
		apply(SUBAGENT_FAILED_EVENT, { id: "a1", status: "error" });
		apply(SUBAGENT_STARTED_EVENT, { id: "a2", name: "auth-audit-2", nameBase: "auth-audit" });
		apply(SUBAGENT_COMPLETED_EVENT, { id: "a2" });
		apply(SUBAGENT_STARTED_EVENT, { id: "a3", name: "auth-audit-3", nameBase: "auth-audit" });
		apply(SUBAGENT_FAILED_EVENT, { id: "a3", status: "error" });
		apply(SUBAGENT_STARTED_EVENT, { id: "a2" });
		expect(stateOf("Auth Audit")).toBe("running");
	});

	it("does not take a queued same-name sibling, dequeued by the owner's settle, for a retry", () => {
		const a = { name: "auth-audit", nameBase: "auth-audit" };
		const b = { name: "auth-audit-2", nameBase: "auth-audit" };
		apply(SUBAGENT_STARTED_EVENT, { id: "a1", ...a, spawnSeq: 1 });
		// a2 spawned at 2 but queued, so todo hears nothing until a1's settle frees its slot.
		apply(SUBAGENT_FAILED_EVENT, { id: "a1", ...a, spawnSeq: 1, settleSeq: 3, status: "error" });
		apply(SUBAGENT_STARTED_EVENT, { id: "a2", ...b, spawnSeq: 2 });
		expect(stateOf("@auth-audit")).toBe("failed");
		apply(SUBAGENT_COMPLETED_EVENT, { id: "a2", ...b, spawnSeq: 2, settleSeq: 4 });
		expect(stateOf("@auth-audit")).toBe("failed");
	});

	it("takes a sibling spawned after the owner's settle for a retry by spawnSeq", () => {
		apply(SUBAGENT_STARTED_EVENT, { id: "a1", name: "auth-audit", nameBase: "auth-audit", spawnSeq: 1 });
		apply(SUBAGENT_FAILED_EVENT, { id: "a1", settleSeq: 2, status: "error" });
		apply(SUBAGENT_STARTED_EVENT, { id: "a2", name: "auth-audit-2", nameBase: "auth-audit", spawnSeq: 3 });
		expect(stateOf("Auth Audit")).toBe("running");
	});

	it("carries the first spawnSeq over a reopen, so a reopened concurrent sibling stays no retry", () => {
		apply(SUBAGENT_STARTED_EVENT, { id: "a1", name: "auth-audit", nameBase: "auth-audit", spawnSeq: 1 });
		apply(SUBAGENT_STARTED_EVENT, { id: "a2", name: "auth-audit-2", nameBase: "auth-audit", spawnSeq: 2 });
		apply(SUBAGENT_FAILED_EVENT, { id: "a1", settleSeq: 3, status: "error" });
		apply(SUBAGENT_COMPLETED_EVENT, { id: "a2", settleSeq: 4 });
		// The reopened run is a new record, so its own spawnSeq comes after a1 settled.
		apply(SUBAGENT_STARTED_EVENT, {
			id: "a3",
			previousId: "a2",
			name: "auth-audit-2",
			nameBase: "auth-audit",
			spawnSeq: 9,
		});
		expect(stateOf("@auth-audit")).toBe("failed");
	});

	it("falls back to the latest nameBase match when nothing matches exactly", () => {
		apply(SUBAGENT_STARTED_EVENT, { id: "b1", name: "deploy-2", nameBase: "deploy" });
		expect(stateOf("deploy")).toBe("running");
		apply(SUBAGENT_FAILED_EVENT, { id: "b1", status: "stopped" });
		expect(stateOf("deploy")).toBe("stopped");
	});

	it("restarts an owner resumed after settling, ignoring an earlier retry", () => {
		apply(SUBAGENT_STARTED_EVENT, { id: "a1", name: "auth-audit", nameBase: "auth-audit" });
		apply(SUBAGENT_FAILED_EVENT, { id: "a1", status: "error" });
		apply(SUBAGENT_STARTED_EVENT, { id: "a2", name: "auth-audit-2", nameBase: "auth-audit" });
		apply(SUBAGENT_FAILED_EVENT, { id: "a2", status: "error" });
		apply(SUBAGENT_STARTED_EVENT, { id: "a1" });
		expect(stateOf("auth-audit")).toBe("running");
		apply(SUBAGENT_COMPLETED_EVENT, { id: "a1" });
		expect(stateOf("auth-audit")).toBe("done");
	});

	it("reports a nameBase change as a change", () => {
		apply(SUBAGENT_STARTED_EVENT, { id: "a1" });
		expect(apply(SUBAGENT_STARTED_EVENT, { id: "a1", nameBase: "auth-audit" })).toBe(true);
		expect(apply(SUBAGENT_STARTED_EVENT, { id: "a1" })).toBe(false);
	});

	it("never answers from another session, and forgets a session on demand", () => {
		applyAgentEvent("s1", SUBAGENT_STARTED_EVENT, { id: "a1", handle: "scout" });
		applyAgentEvent("s2", SUBAGENT_FAILED_EVENT, { id: "b1", handle: "scout", status: "error" });
		expect(agentLookup("s1")("scout")).toBe("running");
		expect(agentLookup("s2")("scout")).toBe("failed");
		expect(agentLookup("s3")("scout")).toBeUndefined();
		forgetAgents("s2");
		expect(agentLookup("s2")("scout")).toBeUndefined();
		expect(agentLookup("s1")("scout")).toBe("running");
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

describe("ownerKey parity with pi-subagents handleBase", () => {
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
