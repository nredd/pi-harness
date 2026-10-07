/**
 * Model-facing contract for a Plan workflow where the user declined a proposed plan.
 *
 * Injected per request (never persisted) while `declinedPlans > 0`, so the text always matches the
 * latest count and the stable Plan contract stays cache-friendly.
 */
export const DECLINE_CONTRACT_MESSAGE_TYPE = "plan-mode-decline";

export const DECLINE_GATE_ERROR =
  "plan_mode_complete is blocked: the user declined the last proposed plan. Restate what changed and what is still open, then call the plan_mode_question tool now with the next open question and get it answered (or wait for the user to run /plan finalize) before proposing again. Do not ask in assistant text: a plain-text question or reply does not unblock plan_mode_complete. Do not re-submit the plan unchanged.";

export function buildDeclineContract(declinedPlans: number, gated: boolean) {
  const gate = gated
    ? "plan_mode_complete returns an error until a plan_mode_question has been answered or the user runs /plan finalize."
    : "plan_mode_complete is available again.";
  const header = `[PI PLAN MODE: PLAN DECLINED x${declinedPlans}]`;
  if (declinedPlans <= 1) {
    return `${header}
The user declined the last proposed plan (dismissed it, or replied instead of approving). Before proposing again:
- Restate what changed and what is still open.
- Re-verify, with non-mutating exploration, the facts the user's feedback touched.
- Call the plan_mode_question tool at least once. Never ask in assistant text; plain-text questions do not count and do not lift the gate.
${gate} A message that only asks for clarification is not approval: answer it, do not re-submit the unchanged plan.`;
  }
  return `${header}
The user has declined ${declinedPlans} proposals in this workflow. Before proposing again:
- List every thread the user raised since the last proposal as resolved or open.
- Call the plan_mode_question tool to ask "anything else before I re-propose?" with options like "Re-propose now" / "Not yet". Never ask in assistant text; plain-text questions do not count and do not lift the gate.
- Re-propose only after an explicit go-ahead from the user.
${gate}`;
}

export function createDeclineContractMessage(declinedPlans: number, gated: boolean, timestamp = 0) {
  return {
    role: "custom" as const,
    customType: DECLINE_CONTRACT_MESSAGE_TYPE,
    content: buildDeclineContract(declinedPlans, gated),
    display: false,
    details: { declinedPlans, gated },
    timestamp,
  };
}
