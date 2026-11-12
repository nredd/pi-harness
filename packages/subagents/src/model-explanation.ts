/** Read-only, allowlisted projections of the real dispatch selector. Never admit or route. */
import { isVirtualModel } from "./model-resolver.js";
import { hasModelConfigurationError, modelInputBinding, modelInputs, selectModel } from "./model-selection.js";
import { getModelResolution } from "./model-tiers.js";

/** Only model references, not commands, endpoints, diagnostics or model overlays, reach the UI. */
function safeRef(value: string | undefined): string {
  return value && /^@?[a-zA-Z0-9][a-zA-Z0-9._/@-]*$/.test(value) && !value.includes("//")
    ? value : value === undefined ? "session default" : "[redacted]";
}

/** A configuration preview is neither quota admission nor evidence that a model answered. */
export interface ModelExplanation {
  source: string;
  outcome: "resolved" | "inherited" | "fallback" | "error";
  selected?: string;
  virtual: boolean;
  summary: string;
  text: string;
}

/** Same synchronous selection as dispatch; raw error strings can contain registry inventories and are never echoed. */
export function explainModel(request: Parameters<typeof selectModel>[0]): ModelExplanation {
  const inputs = modelInputs(request.agentType, request.definitionModel, request.paramModel);
  const winner = inputs[0]!;
  const selection = selectModel(request);
  const outcome = typeof selection === "string" ? "error" : selection.outcome;
  const model = typeof selection === "string" ? undefined : selection.model;
  const selected = model ? safeRef(`${model.provider}/${model.id}`) : undefined;
  const virtual = isVirtualModel(model);
  const binding = modelInputBinding(winner, request.agentType);
  const policy = getModelResolution();
  const requested = safeRef(winner.requested);
  const summary = `${winner.source}: ${requested}${selected && selected !== requested ? ` -> ${selected}` : ""} (${outcome === "error" ? "error; no dispatch" : outcome === "fallback" ? "unavailable, fallback: inherit" : outcome})`;
  const lines = [
    summary,
    "Precedence: explicit dispatch > agentModels[type] > agentModels[*] > definition > parent.",
    ...inputs.slice(1).map(input => `Shadowed ${input.source}: ${safeRef(input.source === "parent" && request.parentModel ? `${request.parentModel.provider}/${request.parentModel.id}` : input.requested)}`),
    `Failure policy: unmapped=${policy.onUnmapped ?? "inherit"}; unavailable=${policy.onUnavailable ?? "inherit"}; unresolved explicit literal=error.`,
  ];
  if (binding) lines.push(binding.kind === "routed"
    ? `Exact binding: routed ${safeRef(binding.profile)}`
    : `Exact binding: static ${binding.members.map(safeRef).join(" -> ")}`);
  else if (winner.requested?.trim().startsWith("@")) lines.push("Exact binding: unmapped.");
  lines.push(
    `Selected: ${selected ?? "unknown"}${virtual ? " (virtual)" : ""}.`,
    "Admitted physical model: unknown (no admission requested).",
    "Answering model: unknown (only an assistant response establishes this).",
    "Configuration preview only, not a reservation. No quota forecast or provider request is made; dispatch reselects and admits at start.",
  );
  if (typeof selection !== "string" && selection.scopeWarning) lines.push("Scope warning: selected model is outside enabled scope; trusted configuration remains authoritative.");
  return { source: winner.source, outcome, selected, virtual, summary, text: lines.join("\n") };
}

/** Registration-only validation after trusted discovery. No live credential or quota availability checks. */
export function modelConfigurationWarnings(requests: Parameters<typeof selectModel>[0][]): string[] {
  return requests.flatMap(request => {
    const winner = modelInputs(request.agentType, request.definitionModel)[0]!;
    return hasModelConfigurationError(request)
      ? [`Model configuration for ${safeRef(request.agentType)}: ${winner.source}: ${safeRef(winner.requested)} (error; no dispatch). Registration-only check; credentials and quota were not checked.`] : [];
  });
}
