/**
 * plan-mode-children.ts -- keeps a child started while the parent plans in Plan
 * mode (#437), as Claude Code keeps a subagent spawned in plan mode in plan mode.
 *
 * pi-plan-mode gates only its own session's tool calls, and a child is a separate
 * session on a separate event bus. So right before a child runs, the manager asks
 * the parent's pi-plan-mode, synchronously on the parent's `pi.events`, whether it
 * is planning; when it is, the answer carries the Plan tool policy, and this
 * module applies it to every call the child makes. No answer means pi-plan-mode is
 * not installed, and nothing changes.
 *
 * The contract mirrors `packages/plan-mode/src/child-policy.ts`, repeated rather
 * than imported because either package installs without the other.
 */
import type { ToolInfo } from "@earendil-works/pi-coding-agent";

export const PLAN_MODE_STATE_QUERY = "pi-plan-mode:state-query";
/** pi-plan-mode asks here whether a compatible gate is installed; answering is the handshake. */
export const PLAN_MODE_GATE_QUERY = "pi-plan-mode:gate-query";
const PLAN_MODE_STATE_VERSION = 1;

/** Buses on which pi-plan-mode has shown itself by asking {@link PLAN_MODE_GATE_QUERY}. */
const planModeSeen = new WeakSet<object>();

/**
 * Answer pi-plan-mode's gate query, so Plan admits `Agent` and friends, and remember that Plan
 * mode is installed on this bus: from then on a state query nobody answers fails closed.
 */
export function answerPlanGateQueries(events: { on(channel: string, handler: (data: unknown) => void): unknown }): void {
  events.on(PLAN_MODE_GATE_QUERY, (data) => {
    planModeSeen.add(events);
    const reply = (data as { reply?: unknown } | undefined)?.reply;
    if (typeof reply === "function") reply({ version: PLAN_MODE_STATE_VERSION, gate: "@nredd/pi-subagents" });
  });
}

/** Thrown when pi-plan-mode is installed but did not answer whether it is planning. */
export const PLAN_MODE_SILENT_ERROR =
  "Plan mode is installed but did not answer whether it is planning, so this subagent was not started. Reload Pi, or update @nredd/pi-plan-mode and @nredd/pi-subagents together.";

/** One tool call inside a child session. */
interface PlanModeChildToolCall {
  toolName: string;
  input: unknown;
  cwd: string;
  tool: ToolInfo | undefined;
}

/** Why Plan mode refuses a child's tool call, or `undefined` when it may run. */
export type PlanToolPolicy = (call: PlanModeChildToolCall) => string | undefined;

/**
 * The Plan restriction one child run is under. Mutable on purpose: it is decided
 * per run (a spawn, then each resume) while the hooks reading it are installed
 * once, on the child's session.
 */
export interface PlanGate {
  policy?: PlanToolPolicy;
}

/** Tools a child keeps without asking: safe built-ins only. */
const FAIL_CLOSED_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "find", "ls"]);

/**
 * For a planner that says it is active but sent no policy this host understands:
 * nothing beyond the safe built-ins, so a contract mismatch can never run a child
 * unrestricted.
 */
const failClosedPolicy: PlanToolPolicy = ({ toolName }) =>
  FAIL_CLOSED_TOOLS.has(toolName)
    ? undefined
    : `Plan mode is active and sent no tool policy this subagent understands, so '${toolName}' is blocked.`;

/**
 * Ask the parent's pi-plan-mode whether a child started now must plan. Returns
 * the policy to run it under, or `undefined` when nobody is planning. Several
 * answers (two Plan extensions) combine fail-closed: any active one restricts.
 * A malformed answer (not version 1 with a boolean `active`) restricts like an unusable one.
 * When Plan mode is installed but nothing answers, a new child is refused
 * (`silent: "refuse"`, which throws) and a resumed one runs fail-closed.
 */
export function queryPlanPolicy(
  events: { emit(channel: string, data: unknown): void } | undefined,
  silent: "refuse" | "restrict" = "refuse",
): PlanToolPolicy | undefined {
  // Hosts without an event bus (bare programmatic callers) cannot run pi-plan-mode either.
  if (!events) return undefined;
  const policies: PlanToolPolicy[] = [];
  let answered = false;
  events.emit(PLAN_MODE_STATE_QUERY, {
    version: PLAN_MODE_STATE_VERSION,
    reply: (state: unknown) => {
      const answer = state as { version?: unknown; active?: unknown; evaluate?: unknown } | undefined;
      // Only a well-formed answer says whether Plan is on; anything else restricts, never frees.
      if (answer?.version !== PLAN_MODE_STATE_VERSION || typeof answer.active !== "boolean") {
        policies.push(failClosedPolicy);
        return;
      }
      answered = true;
      if (!answer.active) return;
      policies.push(typeof answer.evaluate === "function" ? (answer.evaluate as PlanToolPolicy) : failClosedPolicy);
    },
  });
  if (!answered && policies.length === 0 && planModeSeen.has(events)) {
    if (silent === "refuse") throw new Error(PLAN_MODE_SILENT_ERROR);
    return failClosedPolicy;
  }
  if (policies.length === 0) return undefined;
  return (call) => {
    for (const policy of policies) {
      const reason = policy(call);
      if (reason !== undefined) return reason;
    }
    return undefined;
  };
}

/**
 * Whether a Plan policy is active on `events` now, failing closed: an installed Plan mode that
 * answers badly or not at all counts as planning. For work that would otherwise outlive Plan
 * unrestricted (a schedule, a quota-parked dispatch, steering an unrestricted child).
 */
export function planningNow(events: { emit(channel: string, data: unknown): void } | undefined): boolean {
  return queryPlanPolicy(events, "restrict") !== undefined;
}

/** Plan's model must not steer a child that runs without Plan's restrictions. */
export function planSteerRefusal(id: string): string {
  return (
    `Cannot steer agent "${id}" while Plan mode is active: it started before Plan and runs without Plan's restrictions, so a steer could make it edit. ` +
    "Wait for it to finish and steer it then (that resumes it read-only), stop it from /agents, or leave Plan mode (/plan exit) first."
  );
}

/** A scheduled agent fires as a fresh spawn, after Plan, with nothing restricting it. */
export const PLAN_SCHEDULE_REFUSAL =
  "Cannot schedule an agent while Plan mode is active: it would start later, after Plan, without Plan's restrictions. Start it now, or leave Plan mode first.";

/** A quota-parked dispatch is a scheduled job too. */
export const PLAN_PARK_REFUSAL =
  "The agent was not started or parked: Plan mode is active, and a parked agent would start after Plan without Plan's restrictions. Retry after the reset, or leave Plan mode first.";

/**
 * The refusal for one child tool call, or `undefined`. Tools this extension
 * injects (nested delegation, whose children inherit the gate; StructuredOutput;
 * the workflow refusal) are exempt: Plan's policy has no entry for them.
 */
export function planGateReason(
  gate: PlanGate | undefined,
  call: { toolName: string; input: unknown; cwd: string },
  tools: () => ToolInfo[],
  exempt: ReadonlySet<string>,
): string | undefined {
  const policy = gate?.policy;
  if (!policy || exempt.has(call.toolName)) return undefined;
  return policy({ ...call, tool: tools().find((tool) => tool.name === call.toolName) });
}

/** Told to a child started while planning, so a refused write is not a surprise. */
export const PLAN_MODE_CHILD_PROMPT = `<plan_mode>
Your parent is in Plan mode, so you are too: investigate and report, do not change anything.
edit and write are blocked, bash runs only reviewed read-only commands, and other tools run only when Plan mode admits them.
</plan_mode>`;
