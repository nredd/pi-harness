import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type FreshPlanModel,
  showPlanModeMenu as showPlanModeMenuWithModel,
  showReadyPlanMenu as showReadyPlanMenuWithModel,
} from "../src/plan-action-menus.js";
import { createPlanPi as createBasePlanPi } from "./harness/support.js";

export {
  builtinTool,
  createCustomSelectorHarness,
  createPlanContext,
  driveCustomSelector,
  extensionTool,
} from "./harness/support.js";

const PLAN_HELPERS = ["plan_mode_question", "plan_mode_complete"];

export function createPlanPi(options: Parameters<typeof createBasePlanPi>[0] = {}) {
  return createBasePlanPi({
    ...options,
    activeTools: [...new Set([...(options.activeTools ?? []), ...PLAN_HELPERS])],
  });
}

/** The controller's Start fresh model when no Plan model is applied: the session's current model. */
export function samePlanModel(ctx: ExtensionContext): FreshPlanModel {
  return {
    model: ctx.model ? { provider: ctx.model.provider, modelId: ctx.model.id } : undefined,
    label: "same as plan",
  };
}

type WithOptionalPlanModel<T> = Omit<T, "planModel"> & { planModel?: FreshPlanModel };

/** `showPlanModeMenu` with the controller's default fresh model unless the test supplies one. */
export function showPlanModeMenu(
  ctx: ExtensionContext,
  options: WithOptionalPlanModel<Parameters<typeof showPlanModeMenuWithModel>[1]>,
) {
  return showPlanModeMenuWithModel(ctx, { planModel: samePlanModel(ctx), ...options });
}

/** `showReadyPlanMenu` with the controller's default fresh model unless the test supplies one. */
export function showReadyPlanMenu(
  ctx: ExtensionContext,
  options: WithOptionalPlanModel<Parameters<typeof showReadyPlanMenuWithModel>[1]>,
) {
  return showReadyPlanMenuWithModel(ctx, { planModel: samePlanModel(ctx), ...options });
}
