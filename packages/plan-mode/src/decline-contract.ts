/**
 * Model-facing contract while explicit proposal-review permission is required.
 *
 * Injected per request (never persisted) from the same review state as the tool guard.
 * Decline history remains separate: confirmation can also be requested before the first proposal.
 */
export const DECLINE_CONTRACT_MESSAGE_TYPE = "plan-mode-decline";

export const DECLINE_GATE_ERROR =
  "plan_mode_complete is blocked: explicit permission to submit a proposal is required. Restate what changed and what is still open, then call plan_mode_question in reproposal_confirmation mode and receive the canonical Re-propose now choice (or wait for the user to run /plan finalize) before proposing again. Ordinary clarification, Not yet, cancellation, custom text, and plain-text replies do not unblock plan_mode_complete. If confirmation returns ui_unavailable, tell the user to run /plan finalize instead of repeating the tool or asking permission in text. If it is cancelled or Not yet, continue material planning or await user input; do not immediately repeat it. Do not re-submit the plan unchanged.";

export function buildDeclineContract(declinedPlans: number) {
  const gate =
    "plan_mode_complete returns an error until plan_mode_question in reproposal_confirmation mode returns its canonical Re-propose now option or the user runs /plan finalize.";
  if (declinedPlans === 0) {
    return `[PI PLAN MODE: PROPOSAL PERMISSION REQUIRED]
An explicit proposal confirmation was requested. Not yet, cancellation, ordinary clarification, and custom text do not grant permission. Continue material planning or await user input; do not immediately repeat the confirmation. When ready, use plan_mode_question with mode "reproposal_confirmation". If UI is unavailable, ask the user to run /plan finalize.
${gate}`;
  }
  const header = `[PI PLAN MODE: PLAN DECLINED x${declinedPlans}]`;
  if (declinedPlans <= 1) {
    return `${header}
The user declined the last proposed plan (dismissed it, or replied instead of approving). Before proposing again:
- Restate what changed and what is still open.
- Re-verify, with non-mutating exploration, the facts the user's feedback touched.
- When ready to submit a replacement, call plan_mode_question with mode "reproposal_confirmation". Its fixed prompt asks permission to submit the revised plan for review, not to implement it; its UI has canonical choices Re-propose now and Not yet. Only Re-propose now is permission. Never infer permission from label text, clarification, custom text, cancellation, or assistant prose.
- If confirmation returns ui_unavailable, tell the user to run /plan finalize instead of repeating the tool or asking permission in text. If it is cancelled or Not yet, continue material planning or await user input; do not immediately repeat it.
${gate} A message that only asks for clarification is not approval: answer it, do not re-submit the unchanged plan.`;
  }
  return `${header}
The user has declined ${declinedPlans} proposals in this workflow. Before proposing again:
- List every thread the user raised since the last proposal as resolved or open.
- When ready to submit a replacement, call plan_mode_question with mode "reproposal_confirmation". Its fixed prompt asks permission to submit the revised plan for review, not to implement it; its UI has canonical choices Re-propose now and Not yet. Only Re-propose now is permission. Never infer permission from label text, clarification, custom text, cancellation, or assistant prose.
- If confirmation returns ui_unavailable, tell the user to run /plan finalize instead of repeating the tool or asking permission in text. If it is cancelled or Not yet, continue material planning or await user input; do not immediately repeat it.
- Re-propose only after that explicit go-ahead.
${gate}`;
}

export function createDeclineContractMessage(declinedPlans: number, timestamp = 0) {
  return {
    role: "custom" as const,
    customType: DECLINE_CONTRACT_MESSAGE_TYPE,
    content: buildDeclineContract(declinedPlans),
    display: false,
    details: { declinedPlans, reproposalReview: "required" },
    timestamp,
  };
}
