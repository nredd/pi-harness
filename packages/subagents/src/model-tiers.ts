/** Exact, provider-neutral model tiers. Router profiles retain ownership of failover. */
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "./model-resolver.js";
import type { QuotaBlock } from "./quota-admission.js";

/** One registered router profile OR an ordered exact physical chain, never both. */
export type TierBinding =
  | { kind: "routed"; tier: string; profile: string }
  | { kind: "static"; tier: string; members: string[] };

/** Why an earlier static member could not be selected. */
export interface TierSkip {
  ref: string;
  why: "no-credentials" | "quota";
}

/** Resolution is explicit even when no model can run; callers never guess a neighbouring tier. */
export type TierOutcome =
  | { kind: "routed"; tier: string; model: Model<Api>; profile: string; admitted?: string; answered?: string }
  | { kind: "static"; tier: string; model: Model<Api>; member: string; skipped: TierSkip[]; quotaSignal: boolean; answered?: string }
  | { kind: "unmapped"; tier: string }
  | { kind: "unavailable"; tier: string; tried: string[] }
  | { kind: "exhausted"; tier: string; block: QuotaBlock; skipped: TierSkip[] };

/** Persist identity and decisions, never provider URLs, headers or credential-bearing model overlays. */
export type TierDisclosure = TierOutcome extends infer Outcome
  ? Outcome extends { model: Model<Api> } ? Omit<Outcome, "model"> & { model: Pick<Model<Api>, "provider" | "id" | "name" | "api"> } : Outcome
  : never;

/** Project a runtime outcome onto its credential-free persisted shape. */
export function tierDisclosure(outcome: TierDisclosure): TierDisclosure {
  if (outcome.kind !== "routed" && outcome.kind !== "static") return outcome;
  const { provider, id, name, api } = outcome.model;
  return { ...outcome, model: { provider, id, name, api } };
}

/** Trusted policy for configuration failures; quota exhaustion is handled separately. */
export interface ModelResolution {
  onUnmapped?: "error" | "inherit";
  onUnavailable?: "error" | "inherit";
}

/** Admission metadata includes the physical label and distinguishes fail-open from measured admission. */
export interface TierAdmission {
  block?: QuotaBlock;
  resolvedModel?: string;
  quotaSignal: boolean;
}

const TIER_NAME = /^[a-z0-9][a-z0-9._-]*$/;
const MODEL_REF = /^[^\s/]+\/\S+$/;
let bindings: Record<string, string[]> = {};
let policy: ModelResolution = {};

/** Reject the entire binding, never silently shorten a malformed chain. */
export function parseTierBinding(tier: string, members: unknown): TierBinding | undefined {
  if (tier.trim() !== tier || !TIER_NAME.test(tier) || !Array.isArray(members) || members.length === 0
    || members.some(ref => typeof ref !== "string" || ref.trim() !== ref || !MODEL_REF.test(ref))) return undefined;
  const refs = members as string[];
  if (refs.some(ref => ref.startsWith("router/"))) {
    return refs.length === 1 ? { kind: "routed", tier, profile: refs[0]! } : undefined;
  }
  return { kind: "static", tier, members: [...refs] };
}

/** Settings have already been validated at the trusted global boundary. */
export function setModelTiers(tiers: Record<string, string[]> | undefined, resolution: ModelResolution | undefined): void {
  bindings = Object.fromEntries(Object.entries(tiers ?? {}).map(([key, refs]) => [key, [...refs]]));
  policy = { ...resolution };
}

/** Return a snapshot; missing policies mean inherit with disclosure. */
export function getModelResolution(): ModelResolution {
  return { ...policy };
}

/** A missing or malformed name is unmapped, including bare @ and mixed case. */
export function tierBinding(tier: string): TierBinding | undefined {
  return parseTierBinding(tier, bindings[tier]);
}

/** Exact lookup independent of enabledModels, version ranking and provider retry. */
export function exactTierModel(ref: string, registry: ModelRegistry): Model<Api> | undefined {
  if (ref.trim() !== ref || !MODEL_REF.test(ref)) return undefined;
  const slash = ref.indexOf("/");
  const found = registry.find(ref.slice(0, slash), ref.slice(slash + 1)) as Model<Api> | undefined;
  if (!found) return undefined;
  if (ref.startsWith("router/")) return found.api === "pi-virtual" ? found : undefined;
  const available = registry.getAvailable?.() ?? registry.getAll();
  return available.some(model => model.provider === found.provider && model.id === found.id) ? found : undefined;
}

/** Resolve once per dispatch; a refused routed tier never tries another profile. */
export async function resolveTier(tier: string, deps: {
  registry: ModelRegistry;
  admit: (ref: string) => Promise<TierAdmission>;
  binding?: TierBinding;
}): Promise<TierOutcome> {
  const binding = deps.binding ?? tierBinding(tier);
  if (!binding) return { kind: "unmapped", tier };
  if (binding.kind === "routed") {
    const model = exactTierModel(binding.profile, deps.registry);
    if (!model) return { kind: "unavailable", tier, tried: [binding.profile] };
    const admission = await deps.admit(binding.profile);
    if (admission.block) return { kind: "exhausted", tier, block: admission.block, skipped: [] };
    return { kind: "routed", tier, model, profile: binding.profile, admitted: admission.resolvedModel };
  }
  const skipped: TierSkip[] = [];
  const blocks: QuotaBlock[] = [];
  for (const member of binding.members) {
    const model = exactTierModel(member, deps.registry);
    if (!model) {
      skipped.push({ ref: member, why: "no-credentials" });
      continue;
    }
    const admission = await deps.admit(member);
    if (admission.block) {
      skipped.push({ ref: member, why: "quota" });
      blocks.push(admission.block);
      continue;
    }
    return { kind: "static", tier, model, member, skipped, quotaSignal: admission.quotaSignal };
  }
  if (blocks.length) {
    // Wait only if every refusal permits it. Unknown resets must not invent a wake time.
    const resets = blocks.flatMap(block => block.resetAt === undefined ? [] : [block.resetAt]);
    return { kind: "exhausted", tier, skipped, block: {
      model: `@${tier}`, wait: blocks.every(block => block.wait !== false),
      resetAt: resets.length ? Math.min(...resets) : undefined,
    } };
  }
  return { kind: "unavailable", tier, tried: [...binding.members] };
}

/** Validate stored provenance without re-resolving a historical request against today's registry. */
export function isTierDisclosure(raw: unknown): raw is TierDisclosure {
  if (!raw || typeof raw !== "object") return false;
  const value = raw as Record<string, unknown>;
  if (typeof value.tier !== "string") return false;
  if (value.kind === "unmapped") return true;
  if (value.kind === "unavailable") return Array.isArray(value.tried) && value.tried.every(ref => typeof ref === "string");
  const skipsValid = Array.isArray(value.skipped) && value.skipped.every(skip => skip && typeof skip === "object"
    && typeof skip.ref === "string" && (skip.why === "quota" || skip.why === "no-credentials"));
  if (value.kind === "exhausted") {
    const block = value.block as QuotaBlock | undefined;
    return skipsValid && !!block && typeof block.model === "string"
      && (block.wait === undefined || typeof block.wait === "boolean")
      && (block.resetAt === undefined || (typeof block.resetAt === "number" && Number.isFinite(block.resetAt)));
  }
  const model = value.model as Partial<Model<Api>> | undefined;
  if (!model || typeof model.provider !== "string" || typeof model.id !== "string"
    || typeof model.name !== "string" || typeof model.api !== "string") return false;
  if (value.answered !== undefined && typeof value.answered !== "string") return false;
  if (value.kind === "routed") return typeof value.profile === "string" && value.profile.startsWith("router/")
    && (value.admitted === undefined || typeof value.admitted === "string");
  return value.kind === "static" && typeof value.member === "string" && skipsValid && typeof value.quotaSignal === "boolean";
}

/** Durable one-line disclosure, also useful before the first assistant response. */
export function tierNote(outcome: TierDisclosure | undefined, answering?: string): string {
  if (!outcome) return "";
  const tier = `@${outcome.tier}`;
  const answered = answering ?? ((outcome.kind === "routed" || outcome.kind === "static") ? outcome.answered : undefined);
  switch (outcome.kind) {
    case "routed": return `Model: ${tier} -> ${answered ?? outcome.admitted ?? outcome.profile} via ${outcome.profile}${answered && outcome.admitted && answered !== outcome.admitted ? ` (switched from ${outcome.admitted} within tier)` : ""}`;
    case "static": return `Model: ${tier} -> ${answered ?? outcome.member} (static${outcome.quotaSignal ? "" : "; no quota signal"})${outcome.skipped.length ? `; skipped ${outcome.skipped.map(skip => `${skip.ref}: ${skip.why}`).join(", ")}` : ""}`;
    case "unmapped": return `Note: model tier ${tier} is unmapped; inheriting the parent model.`;
    case "unavailable": return `Note: model tier ${tier} is unavailable; inheriting the parent model.`;
    case "exhausted": return `Model: ${tier} is exhausted.`;
  }
}
