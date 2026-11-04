/**
 * plan-mode-children.ts — keeps a child started while the parent plans in Plan
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
const PLAN_MODE_STATE_VERSION = 1;

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
 */
export function queryPlanPolicy(
  events: { emit(channel: string, data: unknown): void } | undefined,
): PlanToolPolicy | undefined {
  // Hosts without an event bus (bare programmatic callers) cannot run pi-plan-mode either.
  if (!events) return undefined;
  const policies: PlanToolPolicy[] = [];
  events.emit(PLAN_MODE_STATE_QUERY, {
    version: PLAN_MODE_STATE_VERSION,
    reply: (state: unknown) => {
      const answer = state as { version?: unknown; active?: unknown; evaluate?: unknown } | undefined;
      if (answer?.active !== true) return;
      policies.push(
        answer.version === PLAN_MODE_STATE_VERSION && typeof answer.evaluate === "function"
          ? (answer.evaluate as PlanToolPolicy)
          : failClosedPolicy,
      );
    },
  });
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
