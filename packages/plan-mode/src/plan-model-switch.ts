import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ImplementationModelOverride } from "./implementation-models.js";
import type { FreshPlanModel } from "./plan-action-menus.js";
import { type PlanModelTier, planModelTarget } from "./plan-model.js";
import type { PlanModeFixedThinkingLevel, PlanModeSettings } from "./settings.js";
import type { PlanModelSwitch, PlanModeState } from "./state.js";

type PiModel = Parameters<ExtensionAPI["setModel"]>[0];

/** The Plan workflow state and Pi surface the model switch reads and writes. */
export interface PlanModelSwitchDependencies {
  pi: Pick<ExtensionAPI, "getThinkingLevel" | "setThinkingLevel" | "setModel">;
  getState(): PlanModeState;
  setState(state: PlanModeState): void;
  getSettings(): PlanModeSettings;
  persistState(): void;
  applyPlanThinkingLevel(): void;
  captureManualThinkingLevel(): void;
  restoreThinkingLevel(): void;
  errorText(error: unknown): string;
  safeTerminalText(value: string): string;
  terminalModelReference(model: ImplementationModelOverride): string;
}

export interface PlanModelSwitchController {
  /**
   * Queue the configured Plan model switch; Plan still starts on the current model if it fails.
   * `reapplyThinking` re-applies Plan thinking first, after a queued restore reset it.
   */
  start(ctx: ExtensionContext, reapplyThinking?: boolean): void;
  /** Restore thinking and, unless `/model` replaced it during Plan, the model a Plan start switched from. */
  restore(ctx: ExtensionContext): void;
  /** Like opusplan, Start fresh's "same as plan" implements on the model Plan started from, not on the tier. */
  freshModel(ctx: ExtensionContext): FreshPlanModel;
  /** Make every queued or in-flight switch stale; a Plan start, exit or session change calls this. */
  invalidate(): void;
  /** Resolves once every queued switch has run, so a run never starts mid-switch. */
  settled(): Promise<void>;
  /** Pi re-selects thinking inside `setModel`; those events are not manual changes. */
  isSwitching(): boolean;
  /**
   * Find and authenticate `reference` for the Plan and implementation model switches.
   * A failure reads after the model's name, e.g. "is no longer available".
   */
  resolveAuthenticatedModel(
    ctx: ExtensionContext,
    reference: ImplementationModelOverride,
  ): Promise<{ model: PiModel } | { failure: string }>;
}

export function sameModel(model: { provider: string; id: string } | undefined, reference: ImplementationModelOverride) {
  return model?.provider === reference.provider && model.id === reference.modelId;
}

export function createPlanModelSwitch(deps: PlanModelSwitchDependencies): PlanModelSwitchController {
  const { pi, errorText, safeTerminalText, terminalModelReference } = deps;
  /** Bumped by every Plan start, exit and session change so a queued model switch can tell it is stale. */
  let epoch = 0;
  /** Plan model switches run in order; `settled` exposes the tail. */
  let transition: Promise<void> = Promise.resolve();
  let switching = false;

  function enqueue(next: () => Promise<void>) {
    transition = transition.then(next);
  }

  function start(ctx: ExtensionContext, reapplyThinking = false) {
    const startEpoch = ++epoch;
    if (reapplyThinking) {
      enqueue(async () => {
        if (startEpoch !== epoch || !deps.getState().enabled) return;
        deps.applyPlanThinkingLevel();
        deps.persistState();
      });
    }
    const tier = deps.getSettings().planModel;
    if (tier) enqueue(() => applyPlanModel(ctx, tier, startEpoch));
  }

  async function applyPlanModel(ctx: ExtensionContext, tier: PlanModelTier, applyEpoch: number) {
    const target = planModelTarget(tier);
    const previous = ctx.model;
    const isCurrent = () => applyEpoch === epoch && deps.getState().enabled;
    if (!isCurrent() || !previous || sameModel(previous, target)) return;
    // Mirrors the fresh implementation row's "...; using the planning model."; here the tier is the planning model.
    const fallback = (failure: string) =>
      ctx.ui.notify(
        `Plan model ${tier} (${terminalModelReference(target)}) ${failure}; using the current model.`,
        "warning",
      );
    const resolved = await resolveAuthenticatedModel(ctx, target);
    if (!isCurrent()) return;
    if ("failure" in resolved) {
      fallback(resolved.failure);
      return;
    }
    const thinkingBefore = pi.getThinkingLevel();
    try {
      if (!(await switchModel(resolved.model, thinkingBefore))) {
        fallback("could not be applied");
        return;
      }
    } catch (error: unknown) {
      fallback(`could not be applied: ${errorText(error)}`);
      return;
    }
    const modelSwitch: PlanModelSwitch = {
      applied: target,
      previous: { provider: previous.provider, modelId: previous.id },
      thinkingBefore,
      thinkingAfter: pi.getThinkingLevel(),
    };
    if (!isCurrent()) {
      // Plan ended while the switch was in flight: put the previous model back.
      await restorePlanModel(ctx, modelSwitch, thinkingBefore);
      return;
    }
    const state = deps.getState();
    deps.setState({
      ...state,
      ...(state.appliedThinkingLevel ? { appliedThinkingLevel: modelSwitch.thinkingAfter } : {}),
      planModelSwitch: modelSwitch,
    });
    deps.persistState();
  }

  function restore(ctx: ExtensionContext) {
    epoch += 1;
    const modelSwitch = deps.getState().planModelSwitch;
    deps.setState({ ...deps.getState(), planModelSwitch: undefined });
    if (!modelSwitch || !sameModel(ctx.model, modelSwitch.applied)) {
      deps.restoreThinkingLevel();
      return;
    }
    deps.captureManualThinkingLevel();
    const current = pi.getThinkingLevel();
    // Pi re-selects a per-model thinking default on switch; pin the level Plan would restore without one.
    const thinking =
      deps.getState().previousThinkingLevel ??
      (current === modelSwitch.thinkingAfter ? modelSwitch.thinkingBefore : current);
    deps.setState({ ...deps.getState(), appliedThinkingLevel: undefined, previousThinkingLevel: undefined });
    enqueue(() => restorePlanModel(ctx, modelSwitch, thinking));
  }

  async function restorePlanModel(
    ctx: ExtensionContext,
    modelSwitch: PlanModelSwitch,
    thinking: PlanModeFixedThinkingLevel,
  ) {
    const resolved = await resolveAuthenticatedModel(ctx, modelSwitch.previous);
    let failure = "could not be applied";
    if ("failure" in resolved) failure = resolved.failure;
    else {
      try {
        if (await switchModel(resolved.model, thinking)) return;
      } catch (error: unknown) {
        failure = `could not be applied: ${errorText(error)}`;
      }
    }
    if (pi.getThinkingLevel() !== thinking) pi.setThinkingLevel(thinking);
    ctx.ui.notify(
      `Previous model ${terminalModelReference(modelSwitch.previous)} ${failure}; Pi stays on ${terminalModelReference(modelSwitch.applied)}.`,
      "warning",
    );
  }

  /** Switch models without letting Pi's per-model thinking default replace `thinking`. */
  async function switchModel(model: PiModel, thinking: PlanModeFixedThinkingLevel) {
    switching = true;
    try {
      if (!(await pi.setModel(model))) return false;
      if (pi.getThinkingLevel() !== thinking) pi.setThinkingLevel(thinking);
      return true;
    } finally {
      switching = false;
    }
  }

  async function resolveAuthenticatedModel(
    ctx: ExtensionContext,
    reference: ImplementationModelOverride,
  ): Promise<{ model: PiModel } | { failure: string }> {
    let model: ReturnType<ExtensionContext["modelRegistry"]["find"]>;
    try {
      model = ctx.modelRegistry.find(reference.provider, reference.modelId);
    } catch (error: unknown) {
      return { failure: `could not be resolved: ${errorText(error)}` };
    }
    if (!model) return { failure: "is no longer available" };
    try {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      return auth.ok ? { model } : { failure: `could not be authenticated: ${safeTerminalText(auth.error)}` };
    } catch (error: unknown) {
      return { failure: `could not be authenticated: ${errorText(error)}` };
    }
  }

  function freshModel(ctx: ExtensionContext): FreshPlanModel {
    const state = deps.getState();
    const modelSwitch = state.enabled ? state.planModelSwitch : undefined;
    if (modelSwitch && sameModel(ctx.model, modelSwitch.applied)) {
      return { model: { ...modelSwitch.previous }, label: "previous model" };
    }
    return {
      model: ctx.model ? { provider: ctx.model.provider, modelId: ctx.model.id } : undefined,
      label: "same as plan",
    };
  }

  return {
    start,
    restore,
    freshModel,
    invalidate: () => {
      epoch += 1;
    },
    settled: () => transition,
    isSwitching: () => switching,
    resolveAuthenticatedModel,
  };
}
