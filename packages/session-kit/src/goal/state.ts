/**
 * Pure `/goal` logic: command parsing, the goal state machine, budgets and the nudge decision.
 * No pi imports, so everything here is unit-testable without a runtime.
 */

export const GOAL_ENTRY = "session-kit:goal";
export const GOAL_NUDGE_TYPE = "session-kit:goal-nudge";
export const GOAL_TOOL = "goal_update";
export const DEFAULT_TURNS = 30;

export type GoalStatus = "active" | "paused" | "complete" | "blocked" | "budget";

export interface Goal {
	objective: string;
	status: GoalStatus;
	/** Parent turns consumed while the goal was active. */
	turns: number;
	maxTurns: number;
	/** New tokens (input + output + cache writes) consumed while active. */
	tokens: number;
	maxTokens?: number;
	/** Why the goal is not active: pause cause, blocker, or budget. */
	reason?: string;
	/** The proof given on completion. */
	evidence?: string;
}

/** Persisted snapshot; the last one on a branch wins. `null` means cleared. */
export interface GoalSnapshot {
	version: 1;
	goal: Goal | null;
}

export type GoalCommand =
	| { kind: "set"; objective: string; maxTurns: number; maxTokens?: number }
	| { kind: "status" | "pause" | "resume" | "clear" }
	| { kind: "error"; message: string };

const SUBCOMMANDS = new Set(["status", "pause", "resume", "clear"]);
const COUNT = /^(\d+)([km])?$/i;

/** `30`, `200k`, `1m` -> a positive integer. */
export function parseCount(raw: string): number | undefined {
	const match = COUNT.exec(raw.trim());
	if (!match) return undefined;
	const unit = match[2]?.toLowerCase();
	const value = Number(match[1]) * (unit === "k" ? 1_000 : unit === "m" ? 1_000_000 : 1);
	return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** Parse `/goal` arguments. A subcommand word only counts when it is the whole argument. */
export function parseGoalArgs(raw: string): GoalCommand {
	const text = raw.trim();
	if (text === "") return { kind: "status" };
	if (SUBCOMMANDS.has(text)) return { kind: text as "status" | "pause" | "resume" | "clear" };
	const words: string[] = [];
	let maxTurns = DEFAULT_TURNS;
	let maxTokens: number | undefined;
	const tokens = text.split(/\s+/);
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i] as string;
		const flag = /^--(turns|tokens)(?:=(.*))?$/.exec(token);
		if (!flag) {
			words.push(token);
			continue;
		}
		const name = flag[1] as "turns" | "tokens";
		const value = flag[2] ?? tokens[++i] ?? "";
		const count = parseCount(value);
		if (count === undefined) return { kind: "error", message: `--${name} needs a positive integer (got "${value}")` };
		if (name === "turns") maxTurns = count;
		else maxTokens = count;
	}
	const objective = words.join(" ");
	if (objective === "") return { kind: "error", message: "usage: /goal <objective> [--turns N] [--tokens N]" };
	return { kind: "set", objective, maxTurns, ...(maxTokens === undefined ? {} : { maxTokens }) };
}

export function newGoal(objective: string, maxTurns = DEFAULT_TURNS, maxTokens?: number): Goal {
	return {
		objective,
		status: "active",
		turns: 0,
		maxTurns,
		tokens: 0,
		...(maxTokens === undefined ? {} : { maxTokens }),
	};
}

interface EntryLike {
	type?: string;
	customType?: string;
	data?: unknown;
}

const STATUSES: readonly string[] = ["active", "paused", "complete", "blocked", "budget"];

const isCount = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isCap = (value: unknown): value is number => isCount(value) && value > 0;

/**
 * Validate a persisted goal field by field; anything malformed yields `undefined` so a damaged
 * entry can never restore a goal with a disabled budget.
 */
function parseGoal(value: unknown): Goal | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const g = value as Record<string, unknown>;
	if (typeof g.objective !== "string" || typeof g.status !== "string" || !STATUSES.includes(g.status)) return undefined;
	if (!isCount(g.turns) || !isCap(g.maxTurns) || !isCount(g.tokens)) return undefined;
	if (g.maxTokens !== undefined && !isCap(g.maxTokens)) return undefined;
	if (g.reason !== undefined && typeof g.reason !== "string") return undefined;
	if (g.evidence !== undefined && typeof g.evidence !== "string") return undefined;
	return {
		objective: g.objective,
		status: g.status as GoalStatus,
		turns: g.turns,
		maxTurns: g.maxTurns,
		tokens: g.tokens,
		...(g.maxTokens === undefined ? {} : { maxTokens: g.maxTokens }),
		...(g.reason === undefined ? {} : { reason: g.reason }),
		...(g.evidence === undefined ? {} : { evidence: g.evidence }),
	};
}

/**
 * Rebuild the goal from a session branch. A goal that was active when the session was written
 * comes back PAUSED: nothing is running after a restart, and resuming is an explicit act.
 */
export function restoreGoal(entries: readonly EntryLike[]): Goal | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry?.type !== "custom" || entry.customType !== GOAL_ENTRY) continue;
		const snapshot = entry.data as Partial<GoalSnapshot> | undefined;
		if (snapshot?.version !== 1 || snapshot.goal === null) return undefined;
		const goal = parseGoal(snapshot.goal);
		if (!goal) return undefined;
		return goal.status === "active" ? { ...goal, status: "paused", reason: "session restored" } : goal;
	}
	return undefined;
}

export function budgetExhausted(goal: Goal): "turns" | "tokens" | undefined {
	if (goal.turns >= goal.maxTurns) return "turns";
	if (goal.maxTokens !== undefined && goal.tokens >= goal.maxTokens) return "tokens";
	return undefined;
}

/** Charge one finished parent turn; ends the goal when a budget runs out. No-op unless active. */
export function recordTurn(goal: Goal, tokens: number): Goal {
	if (goal.status !== "active") return goal;
	const next: Goal = { ...goal, turns: goal.turns + 1, tokens: goal.tokens + Math.max(0, Math.trunc(tokens)) };
	const spent = budgetExhausted(next);
	return spent ? { ...next, status: "budget", reason: `${spent} budget exhausted` } : next;
}

export function pauseGoal(goal: Goal, reason: string): Goal {
	return goal.status === "active" ? { ...goal, status: "paused", reason } : goal;
}

export type ResumeResult = { ok: true; goal: Goal } | { ok: false; error: string };

/** `paused` and `blocked` goals resume; finished and budget-exhausted ones need a new `/goal`. */
export function resumeGoal(goal: Goal): ResumeResult {
	if (goal.status === "active") return { ok: false, error: "goal is already active" };
	if (goal.status === "complete")
		return { ok: false, error: "goal is complete; start a new one with /goal <objective>" };
	if (goal.status === "budget") {
		return {
			ok: false,
			error: `${goal.reason ?? "budget exhausted"}; start a new one with /goal <objective> --turns N`,
		};
	}
	const { reason: _reason, ...rest } = goal;
	return budgetExhausted(rest)
		? { ok: false, error: "budget exhausted; start a new one with /goal <objective> --turns N" }
		: { ok: true, goal: { ...rest, status: "active" } };
}

export type UpdateResult = { ok: true; goal: Goal } | { ok: false; error: string };

/** The `goal_update` tool: `complete` needs non-empty evidence, same rule as rpiv-todo. */
export function applyUpdate(goal: Goal | undefined, status: string, evidence: string | undefined): UpdateResult {
	if (goal?.status !== "active") return { ok: false, error: "no active goal" };
	const proof = (evidence ?? "").trim();
	if (status === "complete") {
		if (proof === "") {
			return {
				ok: false,
				error: "evidence required to mark the goal complete: the check that proves it (command + result)",
			};
		}
		return { ok: true, goal: { ...goal, status: "complete", evidence: proof, reason: undefined } };
	}
	if (status === "blocked") {
		return { ok: true, goal: { ...goal, status: "blocked", reason: proof || "no reason given" } };
	}
	return { ok: false, error: `status must be "complete" or "blocked" (got "${status}")` };
}

export interface NudgeInput {
	goal: Goal | undefined;
	isChild: boolean;
	planMode: boolean;
	/** `event.continue`: another handler already continued this settle. */
	continueAlready: boolean;
	canContinue: boolean;
	outcome: "completed" | "aborted" | "error";
	/** Queued messages (e.g. a subagent notice follow-up) pi will run anyway. */
	pendingMessages: number;
	/** Background subagents running, or finished with their notice still unannounced. */
	subagentsBusy: number;
}

export type NudgeDecision = { nudge: true } | { nudge: false; reason: string };

/** Whether a settle should be turned into one more goal turn, and if not, why. */
export function decideNudge(input: NudgeInput): NudgeDecision {
	const skip = (reason: string): NudgeDecision => ({ nudge: false, reason });
	if (input.isChild) return skip("child session");
	if (input.goal?.status !== "active") return skip("no active goal");
	if (input.planMode) return skip("plan mode");
	if (input.outcome !== "completed") return skip(`run ${input.outcome}`);
	if (input.continueAlready) return skip("already continued");
	if (!input.canContinue) return skip("cannot continue");
	if (input.pendingMessages > 0) return skip("queued messages pending");
	if (input.subagentsBusy > 0) return skip("subagents busy");
	if (budgetExhausted(input.goal)) return skip("budget exhausted");
	return { nudge: true };
}

/** The first message of a goal, and of a resume. */
export function kickoffPrompt(goal: Goal, resumed: boolean): string {
	const budget = `${goal.maxTurns} turns${goal.maxTokens === undefined ? "" : `, ${goal.maxTokens} tokens`}`;
	return [
		`${resumed ? "Resuming goal" : "Goal"}: ${goal.objective}`,
		`Work on it until it is done (budget: ${budget}). When finished, call goal_update with status "complete" and evidence (the check that proves it). If you cannot proceed, call goal_update with status "blocked" and the reason.`,
	].join("\n");
}

/** The hidden settle nudge. */
export function nudgeText(goal: Goal): string {
	return `[goal ${goal.turns}/${goal.maxTurns} turns] Not complete yet: ${goal.objective}\nKeep working. When done call goal_update status "complete" with evidence; if stuck, status "blocked" with the reason.`;
}

/** Footer chip text. */
export function chipText(goal: Goal, waitingOnAgents = 0): string {
	const used = compact(goal.tokens);
	const tokens =
		goal.maxTokens !== undefined ? ` ${used}/${compact(goal.maxTokens)} tok` : goal.tokens > 0 ? ` ${used} tok` : "";
	const state = goal.status === "active" ? "" : ` ${goal.status}`;
	const wait =
		waitingOnAgents > 0 && goal.status === "active"
			? ` (waiting on ${waitingOnAgents} agent${waitingOnAgents === 1 ? "" : "s"})`
			: "";
	return `goal ${goal.turns}/${goal.maxTurns}${tokens}${state}${wait}`;
}

function compact(n: number): string {
	return n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}m` : n >= 1_000 ? `${+(n / 1_000).toFixed(1)}k` : String(n);
}

/** `/goal status` body. */
export function describeGoal(goal: Goal | undefined): string {
	if (!goal) return "no goal. /goal <objective> [--turns N] [--tokens N]";
	const lines = [`goal (${goal.status}): ${goal.objective}`, chipText(goal)];
	if (goal.reason) lines.push(`reason: ${goal.reason}`);
	if (goal.evidence) lines.push(`evidence: ${goal.evidence}`);
	return lines.join("\n");
}
