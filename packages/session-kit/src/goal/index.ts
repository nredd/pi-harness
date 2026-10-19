/**
 * `/goal`: keep a session working on an objective until the model proves it is done.
 *
 * While a goal is active, `agent_before_settle` turns a settle into one more turn (a hidden nudge
 * message), unless something else already continues the run or the goal must yield (Plan mode,
 * background subagents, queued messages, budget). The model ends the goal with `goal_update`.
 * State lives only in `session-kit:goal` session entries, rebuilt from the branch at
 * `session_start`, so two sessions never share anything.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isChildSession, registerChildIdentity, registerParentTool } from "../child.ts";
import { type Clock, realClock, type TimerHandle } from "../clock.ts";
import type { KitConfig } from "../config.ts";
import { coordination, planModeActive, planModeEnteredSince, watchQuota, watchStops } from "../shared.ts";
import {
	applyUpdate,
	chipText,
	decideNudge,
	describeGoal,
	GOAL_ENTRY,
	GOAL_NUDGE_TYPE,
	GOAL_TOOL,
	type Goal,
	type GoalSnapshot,
	kickoffPrompt,
	newGoal,
	nudgeText,
	parseGoalArgs,
	pauseGoal,
	recordTurn,
	restoreGoal,
	resumeGoal,
} from "./state.ts";
import { SubagentTracker } from "./subagents.ts";

const STATUS_KEY = "session-kit-goal";
/** How long a goal that skipped its nudge for subagents waits for their notice before waking itself. */
export const WAKE_MS = 4_000;
const SUBCOMMANDS = ["status", "pause", "resume", "clear"];

interface UsageLike {
	input?: number;
	output?: number;
	cacheWrite?: number;
}

/** New tokens a finished assistant message consumed: input + output + cache writes (not cache reads). */
export function turnTokens(message: unknown): number {
	const m = message as { role?: string; usage?: UsageLike } | undefined;
	if (m?.role !== "assistant" || !m.usage) return 0;
	return (m.usage.input ?? 0) + (m.usage.output ?? 0) + (m.usage.cacheWrite ?? 0);
}

export function register(pi: ExtensionAPI, _config: KitConfig, clock: Clock = realClock): void {
	registerChildIdentity(pi);
	const shared = coordination(pi);
	let goal: Goal | undefined;
	let lastCtx: ExtensionContext | undefined;
	let wakeTimer: TimerHandle | undefined;
	let skippedForAgents = false;

	const clearWake = (): void => {
		wakeTimer?.cancel();
		wakeTimer = undefined;
	};

	const armWake = (): void => {
		if (wakeTimer !== undefined || goal?.status !== "active" || shared.quotaParked.size > 0) return;
		wakeTimer = clock.setTimeout(() => {
			wakeTimer = undefined;
			const ctx = lastCtx;
			if (!ctx || !goal || goal.status !== "active" || isChildSession(pi) || shared.quotaParked.size > 0) return;
			try {
				// Only RUNNING agents hold the wake: a notice not delivered by now is not coming.
				if (!ctx.isIdle() || tracker.runningCount() > 0 || planModeActive(ctx)) return;
				skippedForAgents = false;
				pi.sendUserMessage(nudgeText(goal));
			} catch {
				// Stale context: the session is gone.
			}
		}, WAKE_MS);
	};

	const tracker = new SubagentTracker(() => {
		if (skippedForAgents) armWake();
	});

	const ensureTool = (ctx: ExtensionContext): void => {
		const want = goal?.status === "active" && !isChildSession(pi) && !planModeActive(ctx);
		const active = pi.getActiveTools();
		const has = active.includes(GOAL_TOOL);
		if (want && !has) pi.setActiveTools([...active, GOAL_TOOL]);
		else if (!want && has) pi.setActiveTools(active.filter((name) => name !== GOAL_TOOL));
	};

	const syncUi = (ctx: ExtensionContext): void => {
		shared.goalActive = goal?.status === "active";
		ctx.ui.setStatus(STATUS_KEY, goal ? chipText(goal, tracker.runningCount()) : undefined);
		ensureTool(ctx);
	};

	const commit = (ctx: ExtensionContext, next: Goal | undefined): void => {
		goal = next;
		pi.appendEntry<GoalSnapshot>(GOAL_ENTRY, { version: 1, goal: next ?? null });
		syncUi(ctx);
	};

	/**
	 * Entering Plan mode pauses an active goal, even when Plan mode was entered AND left while the
	 * goal sat idle (no event fires then, so the branch's `plan-mode-state` entries are replayed
	 * back to the goal's last state entry). Returns whether Plan mode is on right now.
	 */
	const guardPlanMode = (ctx: ExtensionContext): boolean => {
		const on = planModeActive(ctx);
		const excursion =
			!on && goal?.status === "active" && planModeEnteredSince(ctx.sessionManager.getBranch(), GOAL_ENTRY);
		if (!on && !excursion) return false;
		if (goal?.status === "active") {
			commit(ctx, pauseGoal(goal, "plan mode"));
			ctx.ui.notify("goal paused: Plan mode was entered. /goal resume after leaving it", "info");
		}
		return on;
	};

	shared.reconcilePlanMode = guardPlanMode;

	const rebuild = (ctx: ExtensionContext): void => {
		lastCtx = ctx;
		clearWake();
		skippedForAgents = false;
		tracker.dispose();
		goal = undefined;
		shared.goalActive = false;
		if (isChildSession(pi)) return;
		tracker.attach(pi.events);
		goal = restoreGoal(ctx.sessionManager.getBranch());
		syncUi(ctx);
		if (goal?.reason === "session restored") {
			ctx.ui.notify(`goal restored paused: ${goal.objective}. /goal resume to continue`, "info");
		}
	};

	/**
	 * Start work right away when the session can take it. Print/JSON mode dispose the session as
	 * soon as the command returns, killing an un-awaited run, so there the next prompt starts the goal.
	 */
	const kickoff = (ctx: ExtensionContext, text: string): void => {
		if ((ctx.mode === "tui" || ctx.mode === "rpc") && ctx.isIdle()) pi.sendUserMessage(text);
	};

	pi.on("session_start", (_event, ctx) => rebuild(ctx));
	pi.on("session_tree", (_event, ctx) => rebuild(ctx));
	pi.on("session_shutdown", () => {
		clearWake();
		tracker.dispose();
		shared.goalActive = false;
		shared.reconcilePlanMode = undefined;
		goal = undefined;
	});

	pi.on("before_agent_start", (_event, ctx) => {
		if (isChildSession(pi)) return;
		lastCtx = ctx;
		guardPlanMode(ctx);
		syncUi(ctx);
	});

	pi.on("agent_start", () => clearWake());
	pi.on("input", (_event, ctx) => {
		if (isChildSession(pi)) return undefined;
		lastCtx = ctx;
		guardPlanMode(ctx);
		return undefined;
	});
	pi.on("turn_start", (_event, ctx) => {
		if (isChildSession(pi)) return;
		lastCtx = ctx;
		guardPlanMode(ctx);
	});

	pi.on("turn_end", (event, ctx) => {
		if (isChildSession(pi)) return;
		lastCtx = ctx;
		guardPlanMode(ctx);
		if (goal?.status !== "active") return;
		const next = recordTurn(goal, turnTokens(event.message));
		commit(ctx, next);
		if (next.status === "budget")
			ctx.ui.notify(`goal stopped: ${next.reason}. /goal ${next.objective} --turns N to go on`, "warning");
	});

	pi.on("agent_before_settle", (event, ctx) => {
		if (isChildSession(pi)) return undefined;
		lastCtx = ctx;
		const planMode = guardPlanMode(ctx);
		const decision = decideNudge({
			goal,
			isChild: false,
			planMode,
			continueAlready: event.continue,
			// A settle after an assistant message reports canContinue=false until a draft ends the
			// context with a user-role message; our nudge is that draft. Only an empty context cannot continue.
			canContinue: event.context.canContinue || event.context.llmMessages.some((m) => m.role !== "system"),
			outcome: event.outcome,
			pendingMessages: Math.max(event.context.pendingMessages.length, ctx.hasPendingMessages() ? 1 : 0),
			subagentsBusy: tracker.busy(),
		});
		skippedForAgents = !decision.nudge && decision.reason === "subagents busy";
		if (!decision.nudge || !goal) return undefined;
		return {
			entries: [
				...event.entries,
				{ type: "custom_message", customType: GOAL_NUDGE_TYPE, content: nudgeText(goal), display: false },
			],
			continue: true,
		};
	});

	// A parked/refused dispatch is not a failed provider request. Pause at its
	// admission event, before settle can nudge and before a stale wake can fire.
	watchQuota(pi, (reason, ctx) => {
		clearWake();
		skippedForAgents = false;
		if (isChildSession(pi) || goal?.status !== "active") return;
		commit(ctx, pauseGoal(goal, reason));
		ctx.ui.notify(`goal paused: ${reason}. /goal resume after resolving quota`, "warning");
	});

	watchStops(pi, (outcome, ctx) => {
		if (isChildSession(pi) || goal?.status !== "active") return;
		const reason = outcome === "aborted" ? "run aborted" : "provider error";
		commit(ctx, pauseGoal(goal, reason));
		ctx.ui.notify(`goal paused: ${reason}. /goal resume to continue`, "warning");
	});

	pi.on("agent_settled", () => {
		if (skippedForAgents) armWake();
	});

	pi.on("message_end", (event) => {
		if ((event.message as { customType?: string }).customType === "subagent-notification") tracker.announced();
	});
	pi.on("tool_execution_end", (event) => {
		if (event.toolName === "get_subagent_result") tracker.announced();
	});

	registerParentTool(pi, {
		name: GOAL_TOOL,
		label: "Goal Update",
		description:
			'End the active /goal. status "complete" needs evidence: the check that proves the objective is met (command + result). status "blocked" needs the reason you cannot proceed.',
		promptSnippet: "Finish or block the active /goal (complete needs evidence)",
		parameters: Type.Object({
			status: Type.Union([Type.Literal("complete"), Type.Literal("blocked")], {
				description: "complete: objective met. blocked: cannot proceed.",
			}),
			evidence: Type.String({ description: "complete: what proves it. blocked: why you are stuck." }),
		}),
		defaultActive: false,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const result = applyUpdate(goal, params.status, params.evidence);
			if (!result.ok) throw new Error(result.error);
			commit(ctx, result.goal);
			ctx.ui.notify(
				`goal ${result.goal.status}: ${result.goal.objective}`,
				result.goal.status === "complete" ? "info" : "warning",
			);
			return {
				content: [{ type: "text", text: `Goal marked ${result.goal.status}.` }],
				details: { status: result.goal.status },
			};
		},
	});

	/**
	 * Registered from `session_start`, not at load: a child (subagent) session is only recognisable
	 * by its name, which does not exist at factory time. pi resolves extension commands lazily, so a
	 * late registration is executable; children never register it.
	 */
	const registerGoalCommand = (): void => {
		pi.registerCommand("goal", {
			description:
				"Work on an objective until done: /goal <objective> [--turns N] [--tokens N] | status | pause | resume | clear",
			getArgumentCompletions: (prefix) => {
				const items = SUBCOMMANDS.filter((name) => name.startsWith(prefix)).map((name) => ({
					value: name,
					label: name,
				}));
				return items.length > 0 ? items : null;
			},
			handler: async (args, ctx) => {
				if (isChildSession(pi)) return;
				lastCtx = ctx;
				guardPlanMode(ctx);
				const command = parseGoalArgs(args);
				if (command.kind === "error") return ctx.ui.notify(command.message, "error");
				if (command.kind === "status") {
					const waiting = tracker.busy() > 0 ? `\nwaiting on ${tracker.busy()} subagent(s)` : "";
					return ctx.ui.notify(describeGoal(goal) + waiting, "info");
				}
				if (command.kind === "clear") {
					if (goal) commit(ctx, undefined);
					return ctx.ui.notify("goal cleared", "info");
				}
				if (command.kind === "pause") {
					if (goal?.status !== "active") return ctx.ui.notify("no active goal to pause", "error");
					commit(ctx, pauseGoal(goal, "paused by user"));
					return ctx.ui.notify("goal paused. /goal resume to continue", "info");
				}
				if (planModeActive(ctx)) {
					return ctx.ui.notify(
						"refused: Plan mode is active. Leave it (/plan) before starting or resuming a goal",
						"error",
					);
				}
				if (shared.quotaParked.size > 0) {
					return ctx.ui.notify(
						"refused: quota dispatch is still parked. Resolve it before starting or resuming a goal",
						"error",
					);
				}
				if (command.kind === "resume") {
					if (!goal) return ctx.ui.notify("no goal to resume", "error");
					const result = resumeGoal(goal);
					if (!result.ok) return ctx.ui.notify(result.error, "error");
					commit(ctx, result.goal);
					kickoff(ctx, kickoffPrompt(result.goal, true));
					return;
				}
				if (command.kind !== "set") return;
				const started = newGoal(command.objective, command.maxTurns, command.maxTokens);
				commit(ctx, started);
				kickoff(ctx, kickoffPrompt(started, false));
			},
		});
	};

	pi.on("session_start", () => {
		if (!isChildSession(pi)) registerGoalCommand();
	});
}
