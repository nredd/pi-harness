/** One selection policy for every dispatch, independent of its transport. */
import type { Api, Model } from "@earendil-works/pi-ai";
import { describeModel, describeVirtualModel, getAgentModels, getModelAliases, isVirtualModel, type ModelFallback, type ModelRegistry, modelFallbackNote, modelFallbackTo, resolveModel } from "./model-resolver.js";
import { checkModelScope } from "./model-scope.js";
import { exactTierModel, getModelResolution, parseTierBinding, resolveTier, type TierBinding, type TierDisclosure, type TierOutcome, tierBinding, tierNote } from "./model-tiers.js";
import { type AdmissionEvents, admissionOutcome, type QuotaBlock } from "./quota-admission.js";

/** Exact compatibility pins until built-in definitions migrate to tiers. User aliases win. */
const LEGACY_MODEL_PINS = new Map([
  ["claude-haiku-4-5", "anthropic/claude-haiku-4-5"],
]);

/** The winning precedence level, before resolution or fallback. */
export type ModelSource = "param" | "agentModels:type" | "agentModels:*" | "definition" | "parent";

/** Keep the original request even when it could not be resolved. */
export interface ModelSelection {
  requested?: string;
  source: ModelSource;
  model: Model<Api> | undefined;
  outcome: "resolved" | "inherited" | "fallback";
  fallback?: ModelFallback;
  scopeWarning?: string;
  /** Serializable tier provenance, retained when the answering model changes. */
  tier?: TierOutcome;
  /** A prepared binding is resolved with admission before starting the child. */
  tierBinding?: TierBinding;
  tierAdmitted?: boolean;
  /** Startup-only parent floor if credentials/profile disappear between preflight and admission. */
  tierParent?: Model<Api>;
}

/** Choose the input once: explicit parameter > type > wildcard > definition; blank strings are unset. */
export function modelRequest(type: string, definitionModel?: string, paramModel?: string | Model<Api> | null): {
  requested?: string;
  source: ModelSource;
} {
  if (paramModel != null && (typeof paramModel !== "string" || paramModel.trim() !== "")) {
    return { requested: typeof paramModel === "string" ? paramModel : `${paramModel.provider}/${paramModel.id}`, source: "param" };
  }
  const overrides = getAgentModels();
  const typed = overrides.get(type.toLowerCase());
  if (typed?.trim()) return { requested: typed, source: "agentModels:type" };
  const wildcard = overrides.get("*");
  if (wildcard?.trim()) return { requested: wildcard, source: "agentModels:*" };
  if (definitionModel?.trim()) return { requested: definitionModel, source: "definition" };
  return { source: "parent" };
}

/**
 * Choose an exact configured input or tier binding before record creation.
 * Only explicit non-tier tool inputs retain fuzzy matching. Tier admission is
 * asynchronous and completes through admitModelSelection before startup; this
 * synchronous preflight preserves spawn's immediate-id and validation contract.
 * An already-open resume keeps the record and does not select again.
 */
export function selectModel(request: {
  homeDir?: string;
  agentType: string;
  definitionModel?: string;
  paramModel?: string | Model<Api> | null;
  parentModel: Model<Api> | undefined;
  registry: ModelRegistry;
  cwd: string;
  agentLabel?: string;
}): ModelSelection | string {
  const input = modelRequest(request.agentType, request.definitionModel, request.paramModel);
  let selection: ModelSelection = { ...input, model: request.parentModel, outcome: "inherited" };
  if (input.requested) {
    const requested = input.requested.trim();
    const legacy = getModelAliases().get(requested.toLowerCase());
    const legacyBinding = legacy ? parseTierBinding("legacy", legacy) : undefined;
    const binding = requested.startsWith("@") ? tierBinding(requested.slice(1))
      : legacyBinding ? { ...legacyBinding, tier: requested } : undefined;
    if (requested.startsWith("@") || legacy) {
      const tier = requested.startsWith("@") ? requested.slice(1) : requested;
      const refs = binding?.kind === "routed" ? [binding.profile] : binding?.members ?? [];
      const model = refs.map(ref => exactTierModel(ref, request.registry)).find(Boolean);
      if (!binding || !model) {
        const outcome: TierOutcome = binding ? { kind: "unavailable", tier, tried: refs } : { kind: "unmapped", tier };
        const mode = outcome.kind === "unmapped" ? getModelResolution().onUnmapped : getModelResolution().onUnavailable;
        if (mode === "error") return `Model tier @${tier} is ${outcome.kind}.`;
        selection = { ...selection, tier: outcome, outcome: "fallback", fallback: modelFallbackTo(input.requested, request.parentModel) };
      } else {
        selection = { ...input, model, outcome: "resolved", tierBinding: binding, tierParent: request.parentModel };
      }
    } else {
      const compatibilityPin = input.source === "definition" && request.agentType === "Explore"
        ? LEGACY_MODEL_PINS.get(requested) : undefined;
      const resolved = request.paramModel != null && typeof request.paramModel === "object"
        ? request.paramModel : input.source === "param" ? resolveModel(requested, request.registry)
        : exactTierModel(compatibilityPin ?? requested, request.registry) ?? `Model not found: "${requested}".`;
      if (typeof resolved !== "string") selection = { ...input, model: resolved, outcome: "resolved" };
      else if (compatibilityPin) {
        const tier: TierOutcome = { kind: "unavailable", tier: requested, tried: [compatibilityPin] };
        if (getModelResolution().onUnavailable === "error") return `Model tier @${requested} is unavailable.`;
        selection = { ...selection, tier, outcome: "fallback", fallback: modelFallbackTo(input.requested, request.parentModel) };
      } else {
        if (input.source === "param" || getModelResolution().onUnavailable === "error") return resolved;
        selection = { ...selection, outcome: "fallback", fallback: modelFallbackTo(input.requested, request.parentModel) };
      }
    }
  }
  const scope = checkModelScope({
    model: selection.model, cwd: request.cwd, modelRegistry: request.registry,
    callerSupplied: input.source === "param" && !selection.tierBinding && !selection.tier, agentLabel: request.agentLabel ?? request.agentType,
    modelInput: input.requested, homeDir: request.homeDir,
  });
  if (scope.kind === "error") return scope.message;
  if (scope.kind === "warn") selection.scopeWarning = scope.message;
  return selection;
}

/** Label an admitted physical model before any response, without replacing the virtual selection. */
export function describeSelection(selection: ModelSelection | undefined, registry: ModelRegistry): { modelName?: string; modelId?: string } {
  const admitted = selection?.tier?.kind === "routed" ? selection.tier.admitted : undefined;
  if (admitted) {
    const slash = admitted.indexOf("/");
    const provider = admitted.slice(0, slash);
    const id = admitted.slice(slash + 1);
    return describeModel(registry.find(provider, id) ?? { provider, id });
  }
  const model = selection?.model;
  return model ? isVirtualModel(model) ? describeVirtualModel(model) : describeModel(model) : {};
}

/** One disclosure for records, persisted details, workflows and notices. */
export function modelSelectionNote(carrier: { modelTier?: TierDisclosure; modelFallback?: ModelFallback; invocation?: { modelId?: string } } | undefined): string {
  const tier = carrier?.modelTier;
  const fallback = carrier?.modelFallback;
  const sameRequest = tier && (fallback?.input === tier.tier || fallback?.input === `@${tier.tier}`);
  return [tierNote(tier, carrier?.invocation?.modelId), sameRequest ? "" : modelFallbackNote(fallback)].filter(Boolean).join("\n");
}

/** Admission for tiers is made once and is shared by every transport. */
export async function admitModelSelection(selection: ModelSelection, registry: ModelRegistry, events: AdmissionEvents): Promise<QuotaBlock | undefined> {
  if (!selection.tierBinding || selection.tierAdmitted) return selection.tier?.kind === "exhausted" ? selection.tier.block : undefined;
  selection.tier = await resolveTier(selection.tierBinding.tier, {
    registry, binding: selection.tierBinding, admit: ref => admissionOutcome(events, ref),
  });
  selection.tierAdmitted = true;
  if (selection.tier.kind === "routed" || selection.tier.kind === "static") selection.model = selection.tier.model;
  if (selection.tier.kind === "exhausted") return selection.tier.block;
  if (selection.tier.kind === "unavailable" || selection.tier.kind === "unmapped") {
    const mode = selection.tier.kind === "unmapped" ? getModelResolution().onUnmapped : getModelResolution().onUnavailable;
    if (mode === "error") throw new Error(`Model tier @${selection.tier.tier} is ${selection.tier.kind}.`);
    selection.model = selection.tierParent;
    selection.outcome = "fallback";
    selection.fallback = modelFallbackTo(selection.requested ?? `@${selection.tier.tier}`, selection.tierParent);
    delete selection.tierBinding;
  }
  delete selection.tierParent;
  return undefined;
}
