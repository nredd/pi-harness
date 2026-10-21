import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Event emitted on `pi.events` when the user approves a plan and implementation starts, in
 * the same session or a fresh one. Other extensions (rpiv-todo seeds its todos from it) listen
 * without importing this package, so the payload is a versioned contract:
 * `{ version: 1, planId, plan, sessionId }`. Nothing listening is fine.
 */
export const PLAN_APPROVED_EVENT = "pi-plan-mode:plan-approved";
export const PLAN_APPROVED_VERSION = 1;

/** Session entry recording an approval, so a fresh session (or a resume) can announce it. */
export const PLAN_APPROVAL_ENTRY_TYPE = "plan-mode-approved-plan";

export interface PlanApproval {
  version: typeof PLAN_APPROVED_VERSION;
  /** Unique per approval; listeners treat a repeated id as already handled. */
  planId: string;
  /** The approved plan Markdown, verbatim. */
  plan: string;
}

export interface PlanApprovedPayload extends PlanApproval {
  sessionId: string;
}

export function createPlanApproval(plan: string): PlanApproval {
  return { version: PLAN_APPROVED_VERSION, planId: randomUUID(), plan };
}

function isPlanApproval(value: unknown): value is PlanApproval {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v.version === PLAN_APPROVED_VERSION && typeof v.planId === "string" && typeof v.plan === "string";
}

/** The newest approval entry on the branch, if any. */
export function latestPlanApproval(branch: readonly unknown[]): PlanApproval | undefined {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index] as { type?: string; customType?: string; data?: unknown };
    if (entry?.type === "custom" && entry.customType === PLAN_APPROVAL_ENTRY_TYPE && isPlanApproval(entry.data)) {
      return entry.data;
    }
  }
  return undefined;
}

/**
 * Records approvals and announces each one once per session and extension instance.
 *
 * Same-session implementation calls `record`. A fresh session gets the entry from its setup,
 * which lands after `session_start`, so `announceLatest` runs again before the first prompt.
 * Announcing again after a resume is harmless: the `planId` is unchanged.
 */
export function createPlanApprovals(pi: Pick<ExtensionAPI, "appendEntry" | "events">) {
  const announced = new Set<string>();

  const announce = (ctx: Pick<ExtensionContext, "sessionManager">, approval: PlanApproval) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const key = `${sessionId}\u0000${approval.planId}`;
    if (announced.has(key)) return;
    announced.add(key);
    const payload: PlanApprovedPayload = { ...approval, sessionId };
    pi.events.emit(PLAN_APPROVED_EVENT, payload);
  };

  return {
    record(ctx: Pick<ExtensionContext, "sessionManager">, plan: string) {
      const approval = createPlanApproval(plan);
      pi.appendEntry<PlanApproval>(PLAN_APPROVAL_ENTRY_TYPE, approval);
      announce(ctx, approval);
    },
    announceLatest(ctx: Pick<ExtensionContext, "sessionManager">) {
      const approval = latestPlanApproval(ctx.sessionManager.getBranch());
      if (approval) announce(ctx, approval);
    },
  };
}
