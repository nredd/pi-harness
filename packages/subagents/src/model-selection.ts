/** One selection policy for every dispatch, independent of its transport. */
import type { Api, Model } from "@earendil-works/pi-ai";
import { getAgentModels, type ModelFallback, type ModelRegistry, modelFallbackTo, resolveModel } from "./model-resolver.js";
import { checkModelScope } from "./model-scope.js";

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
 * Preserve current matching and fallback rules. Explicit failures are errors;
 * unavailable config inherits the parent with PR0's durable disclosure. The
 * shared spawn path stores this outcome, not a second reconstruction of it.
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
    const resolved = request.paramModel != null && typeof request.paramModel === "object"
      ? request.paramModel : resolveModel(input.requested, request.registry);
    if (typeof resolved !== "string") selection = { ...input, model: resolved, outcome: "resolved" };
    else {
      if (input.source === "param") return resolved;
      selection = { ...selection, outcome: "fallback", fallback: modelFallbackTo(input.requested, request.parentModel) };
    }
  }
  const scope = checkModelScope({
    model: selection.model, cwd: request.cwd, modelRegistry: request.registry,
    callerSupplied: input.source === "param", agentLabel: request.agentLabel ?? request.agentType,
    modelInput: input.requested, homeDir: request.homeDir,
  });
  if (scope.kind === "error") return scope.message;
  if (scope.kind === "warn") selection.scopeWarning = scope.message;
  return selection;
}
