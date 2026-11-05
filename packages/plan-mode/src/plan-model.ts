import {
  type ImplementationModelOverride,
  MAX_PENDING_IMPLEMENTATION_MODEL_IDENTIFIER_LENGTH,
} from "./implementation-models.js";

/** Provider of the subscription router's `router/<tier>` virtual models. */
export const PLAN_MODEL_ROUTER_PROVIDER = "router";
/** Same key grammar as subscription-router profiles and pi-subagents tiers. */
const TIER_KEY = /^[a-z0-9][a-z0-9._-]*$/u;

/** A router tier reference such as `@deep`; never a concrete `provider/modelId`. */
export type PlanModelTier = `@${string}`;

export function normalizePlanModelTier(value: unknown): PlanModelTier | undefined {
  if (typeof value !== "string") return undefined;
  const tier = value.trim();
  return tier.length <= MAX_PENDING_IMPLEMENTATION_MODEL_IDENTIFIER_LENGTH &&
    tier.startsWith("@") &&
    TIER_KEY.test(tier.slice(1))
    ? (tier as PlanModelTier)
    : undefined;
}

/** The router virtual model a tier selects, e.g. `@deep` -> `router/deep`. */
export function planModelTarget(tier: PlanModelTier): ImplementationModelOverride {
  return { provider: PLAN_MODEL_ROUTER_PROVIDER, modelId: tier.slice(1) };
}

/** Tier keys offered by the router models in a catalogue snapshot, in catalogue order. */
export function availablePlanModelTiers(models: readonly { provider: string; id: string }[]): PlanModelTier[] {
  return models.flatMap((model) => {
    const tier = model.provider === PLAN_MODEL_ROUTER_PROVIDER ? normalizePlanModelTier(`@${model.id}`) : undefined;
    return tier ? [tier] : [];
  });
}
