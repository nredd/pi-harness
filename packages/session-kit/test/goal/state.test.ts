import { describe, expect, it } from "vitest";
import {
	applyUpdate,
	budgetExhausted,
	chipText,
	DEFAULT_TURNS,
	decideNudge,
	describeGoal,
	GOAL_ENTRY,
	type Goal,
	kickoffPrompt,
	type NudgeInput,
	newGoal,
	nudgeText,
	parseCount,
	parseGoalArgs,
	pauseGoal,
	recordTurn,
	restoreGoal,
	resumeGoal,
} from "../../src/goal/state.ts";

describe("parseCount", () => {
	it.each([
		["30", 30],
		["200k", 200_000],
		["1.5k", undefined],
		["2M", 2_000_000],
		["0", undefined],
		["-1", undefined],
		["abc", undefined],
		["", undefined],
	])("%s -> %s", (raw, expected) => expect(parseCount(raw)).toBe(expected));
});

describe("parseGoalArgs", () => {
	it("treats nothing and `status` as status", () => {
		expect(parseGoalArgs("")).toEqual({ kind: "status" });
		expect(parseGoalArgs("  status ")).toEqual({ kind: "status" });
	});
	it.each(["pause", "resume", "clear"])("parses %s", (word) => expect(parseGoalArgs(word)).toEqual({ kind: word }));
	it("uses a subcommand word as an objective when more follows", () => {
		expect(parseGoalArgs("status page redesign")).toMatchObject({ kind: "set", objective: "status page redesign" });
	});
	it("defaults to 30 turns and no token cap", () => {
		expect(parseGoalArgs("fix the build")).toEqual({
			kind: "set",
			objective: "fix the build",
			maxTurns: DEFAULT_TURNS,
		});
	});
	it("reads flags anywhere, spaced or with =", () => {
		expect(parseGoalArgs("--turns 5 fix it --tokens=200k")).toEqual({
			kind: "set",
			objective: "fix it",
			maxTurns: 5,
			maxTokens: 200_000,
		});
	});
	it("rejects bad flag values and a missing objective", () => {
		expect(parseGoalArgs("x --turns zero")).toMatchObject({ kind: "error" });
		expect(parseGoalArgs("x --tokens")).toMatchObject({ kind: "error" });
		expect(parseGoalArgs("--turns 3")).toMatchObject({ kind: "error" });
	});
});

describe("state machine", () => {
	const goal = (patch: Partial<Goal> = {}): Goal => ({ ...newGoal("ship", 3, 1000), ...patch });

	it("charges turns and tokens while active", () => {
		const next = recordTurn(goal(), 250.9);
		expect(next).toMatchObject({ turns: 1, tokens: 250, status: "active" });
	});
	it("never charges a goal that is not active", () => {
		const paused = goal({ status: "paused" });
		expect(recordTurn(paused, 500)).toBe(paused);
	});
	it("ends on the turn budget at exactly maxTurns", () => {
		let g = goal();
		g = recordTurn(g, 1);
		g = recordTurn(g, 1);
		expect(g.status).toBe("active");
		g = recordTurn(g, 1);
		expect(g).toMatchObject({ status: "budget", turns: 3, reason: "turns budget exhausted" });
	});
	it("ends on the token budget", () => {
		expect(recordTurn(goal(), 1000)).toMatchObject({ status: "budget", reason: "tokens budget exhausted" });
		expect(budgetExhausted(goal({ tokens: 999 }))).toBeUndefined();
		expect(budgetExhausted(newGoal("x", 3))).toBeUndefined();
	});
	it("clamps negative usage", () => {
		expect(recordTurn(goal(), -50).tokens).toBe(0);
	});
	it("pauses only an active goal", () => {
		expect(pauseGoal(goal(), "why")).toMatchObject({ status: "paused", reason: "why" });
		const done = goal({ status: "complete" });
		expect(pauseGoal(done, "why")).toBe(done);
	});
	it("resumes paused and blocked goals, refuses the rest", () => {
		expect(resumeGoal(goal({ status: "paused", reason: "x" }))).toEqual({
			ok: true,
			goal: expect.objectContaining({ status: "active" }),
		});
		expect(resumeGoal(goal({ status: "blocked" }))).toMatchObject({ ok: true });
		expect(resumeGoal(goal({ status: "active" }))).toMatchObject({ ok: false });
		expect(resumeGoal(goal({ status: "complete" }))).toMatchObject({ ok: false });
		expect(resumeGoal(goal({ status: "budget", reason: "turns budget exhausted" }))).toMatchObject({ ok: false });
		expect(resumeGoal(goal({ status: "paused", turns: 3 }))).toMatchObject({ ok: false });
	});
	it("drops the pause reason on resume", () => {
		const result = resumeGoal(goal({ status: "paused", reason: "plan mode" }));
		expect(result.ok && result.goal.reason).toBeUndefined();
	});
});

describe("applyUpdate", () => {
	const active = newGoal("ship");
	it("refuses complete without evidence, empty or blank", () => {
		for (const evidence of [undefined, "", "   \n"]) {
			expect(applyUpdate(active, "complete", evidence)).toMatchObject({
				ok: false,
				error: expect.stringContaining("evidence required"),
			});
		}
	});
	it("completes with trimmed evidence", () => {
		expect(applyUpdate(active, "complete", "  make test: 12 passed ")).toMatchObject({
			ok: true,
			goal: { status: "complete", evidence: "make test: 12 passed" },
		});
	});
	it("blocks with or without a reason", () => {
		expect(applyUpdate(active, "blocked", "no creds")).toMatchObject({
			ok: true,
			goal: { status: "blocked", reason: "no creds" },
		});
		expect(applyUpdate(active, "blocked", "")).toMatchObject({ ok: true, goal: { reason: "no reason given" } });
	});
	it("refuses with no active goal or an unknown status", () => {
		expect(applyUpdate(undefined, "complete", "x")).toMatchObject({ ok: false });
		expect(applyUpdate({ ...active, status: "paused" }, "complete", "x")).toMatchObject({ ok: false });
		expect(applyUpdate(active, "done", "x")).toMatchObject({ ok: false });
	});
});

describe("restoreGoal", () => {
	const entry = (goal: unknown) => ({ type: "custom", customType: GOAL_ENTRY, data: { version: 1, goal } });
	it("returns the latest snapshot on the branch", () => {
		const entries = [
			entry({ ...newGoal("old"), status: "complete" }),
			{ type: "message" },
			entry({ ...newGoal("new"), turns: 4 }),
		];
		expect(restoreGoal(entries)).toMatchObject({ objective: "new", turns: 4 });
	});
	it("restores an active goal as paused", () => {
		expect(restoreGoal([entry(newGoal("x"))])).toMatchObject({ status: "paused", reason: "session restored" });
	});
	it("keeps finished goals as they were", () => {
		expect(restoreGoal([entry({ ...newGoal("x"), status: "blocked" })])).toMatchObject({ status: "blocked" });
	});
	it("honours a clear (null) and ignores malformed data", () => {
		expect(restoreGoal([entry(newGoal("x")), entry(null)])).toBeUndefined();
		expect(restoreGoal([entry({ objective: 3 })])).toBeUndefined();
		expect(restoreGoal([])).toBeUndefined();
	});
	it.each([
		{ ...newGoal("x"), status: "unknown" },
		{ ...newGoal("x"), turns: -1 },
		{ ...newGoal("x"), turns: Number.POSITIVE_INFINITY },
		{ ...newGoal("x"), maxTurns: 0 },
		{ ...newGoal("x"), maxTurns: Number.NaN },
		{ ...newGoal("x"), tokens: 1.5 },
		{ ...newGoal("x"), maxTokens: 0 },
		{ ...newGoal("x"), maxTokens: Number.POSITIVE_INFINITY },
		{ ...newGoal("x"), reason: 3 },
		{ ...newGoal("x"), evidence: false },
	])("rejects malformed persisted fields %#", (goal) => {
		expect(restoreGoal([entry(goal)])).toBeUndefined();
	});
	it("rejects an unknown snapshot version", () => {
		expect(
			restoreGoal([{ type: "custom", customType: GOAL_ENTRY, data: { version: 2, goal: newGoal("x") } }]),
		).toBeUndefined();
	});
	it("ignores other custom entries", () => {
		expect(restoreGoal([{ type: "custom", customType: "other", data: {} }])).toBeUndefined();
	});
});

describe("decideNudge matrix", () => {
	const base: NudgeInput = {
		goal: newGoal("ship"),
		isChild: false,
		planMode: false,
		continueAlready: false,
		canContinue: true,
		outcome: "completed",
		pendingMessages: 0,
		subagentsBusy: 0,
	};
	it("nudges when everything allows it", () => {
		expect(decideNudge(base)).toEqual({ nudge: true });
	});
	it.each<[string, Partial<NudgeInput>, string]>([
		["a child session", { isChild: true }, "child session"],
		["no goal", { goal: undefined }, "no active goal"],
		["a paused goal", { goal: { ...newGoal("x"), status: "paused" } }, "no active goal"],
		["a complete goal", { goal: { ...newGoal("x"), status: "complete" } }, "no active goal"],
		["plan mode", { planMode: true }, "plan mode"],
		["an aborted run", { outcome: "aborted" }, "run aborted"],
		["an errored run", { outcome: "error" }, "run error"],
		["another handler continuing", { continueAlready: true }, "already continued"],
		["canContinue false", { canContinue: false }, "cannot continue"],
		["queued messages", { pendingMessages: 1 }, "queued messages pending"],
		["busy subagents", { subagentsBusy: 2 }, "subagents busy"],
		["an exhausted budget", { goal: { ...newGoal("x", 1), turns: 1 } }, "budget exhausted"],
	])("skips for %s", (_name, patch, reason) => {
		expect(decideNudge({ ...base, ...patch })).toEqual({ nudge: false, reason });
	});
});

describe("text", () => {
	it("kickoff names the objective, budget and the tool", () => {
		const text = kickoffPrompt(newGoal("ship", 5, 2000), false);
		expect(text).toContain("Goal: ship");
		expect(text).toContain("5 turns, 2000 tokens");
		expect(text).toContain("goal_update");
		expect(kickoffPrompt(newGoal("ship"), true)).toContain("Resuming goal: ship");
	});
	it("nudge shows progress", () => {
		expect(nudgeText({ ...newGoal("ship", 10), turns: 3 })).toContain("[goal 3/10 turns]");
	});
	it("chip shows turns, tokens, state and waiting agents", () => {
		expect(chipText({ ...newGoal("x", 30), turns: 3 })).toBe("goal 3/30");
		expect(chipText({ ...newGoal("x", 30, 200_000), turns: 3, tokens: 12_500 })).toBe("goal 3/30 12.5k/200k tok");
		expect(chipText({ ...newGoal("x", 30), turns: 3, tokens: 12_400 })).toBe("goal 3/30 12.4k tok");
		expect(chipText({ ...newGoal("x"), status: "paused" })).toBe("goal 0/30 paused");
		expect(chipText(newGoal("x"), 2)).toBe("goal 0/30 (waiting on 2 agents)");
	});
	it("describes no goal and a finished one", () => {
		expect(describeGoal(undefined)).toContain("no goal");
		expect(describeGoal({ ...newGoal("x"), status: "complete", evidence: "proof" })).toContain("evidence: proof");
	});
});
