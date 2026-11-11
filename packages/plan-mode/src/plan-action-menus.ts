import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defineMenu, runMenu, sanitizeTerminalText } from "@narumitw/pi-tui-kit";
import {
  type AvailableImplementationModel,
  findAvailableImplementationModel,
  type ImplementationModelOverride,
  snapshotAvailableImplementationModels,
} from "./implementation-models.js";
import { deferPlanEdit, editPlanThenReopen, type PlanEditOption } from "./plan-edit.js";
import { type PlanExportDestinationProvider, planExportInputScreen } from "./plan-export-screen.js";
import { chooseReadyPlanAction } from "./ready-plan-chooser.js";
import { IMPLEMENTATION_THINKING_LEVELS, type PlanModeFixedThinkingLevel } from "./settings.js";
import type { ImplementationRuntimeSelection } from "./state.js";

const THINKING_LEVEL_DESCRIPTIONS: Record<PlanModeFixedThinkingLevel, string> = {
  off: "No reasoning",
  minimal: "Very brief reasoning (~1k tokens)",
  low: "Light reasoning (~2k tokens)",
  medium: "Moderate reasoning (~8k tokens)",
  high: "Deep reasoning (~16k tokens)",
  xhigh: "Extra-high reasoning (~32k tokens)",
  max: "Maximum reasoning",
};

interface PlanMenuOptions extends PlanEditOption {
  statusText: string;
  planThinkingLevel: PlanModeFixedThinkingLevel | undefined;
  /** The model Start fresh treats as the plan's, with the label the menu shows for it. */
  planModel: FreshPlanModel;
  implementationDefaults?: ImplementationRuntimeSelection;
  hasReadyPlan: boolean;
  implementationOutcome(): string;
  getExportDestination: PlanExportDestinationProvider;
  show(): void;
  finalize(): void;
  implementHere(): void | Promise<void>;
  implementFresh(runtime: ImplementationRuntimeSelection, signal: AbortSignal): void | Promise<void>;
  exportPlan(path: string, signal: AbortSignal): Promise<boolean>;
  save(): void;
  stay(): void;
  exit(): void;
}

export async function showPlanModeMenu(ctx: ExtensionContext, options: PlanMenuOptions): Promise<void> {
  type Screen = "main" | "fresh" | "models" | "thinking" | "export";
  type Action =
    | "show"
    | "edit"
    | "finalize"
    | "implement-here"
    | "select-model"
    | "select-thinking"
    | "start-fresh"
    | "export"
    | "save"
    | "stay"
    | "exit";
  const freshFlow = createFreshImplementationFlow(
    ctx,
    options.planModel,
    options.planThinkingLevel,
    options.implementationDefaults,
    options.implementFresh,
  );
  const deferredEdit = deferPlanEdit(options);
  const menu = defineMenu<undefined, Screen, Action, ExtensionContext>({
    start: "main",
    screens: {
      main: () => ({
        kind: "actions",
        title: "Plan mode",
        lines: [options.statusText],
        items: options.hasReadyPlan
          ? [
              { id: "show", label: "Show latest proposed plan", action: "show" },
              { id: "implement-here", label: "Implement here", action: "implement-here" },
              { id: "implement-fresh", label: "Start fresh and implement", to: "fresh" },
              { id: "export", label: "Export plan…", to: "export" },
              { id: "edit", label: "Edit plan…", action: "edit" },
              { id: "save", label: "Save for later", action: "save" },
              { id: "stay", label: "Stay in Plan mode", action: "stay" },
              { id: "exit", label: "Discard plan and exit", action: "exit" },
            ]
          : [
              { id: "finalize", label: "Request final plan", action: "finalize" },
              { id: "stay", label: "Stay in Plan mode", action: "stay" },
              { id: "exit", label: "Exit Plan mode", action: "exit" },
            ],
        hint: "close",
      }),
      fresh: freshFlow.settingsScreen,
      models: freshFlow.modelScreen,
      thinking: freshFlow.thinkingScreen,
      export: () => planExportInputScreen(options.getExportDestination),
    },
    actions: {
      show: async () => {
        options.show();
        return { kind: "close" };
      },
      edit: deferredEdit.action,
      finalize: async () => {
        options.finalize();
        return { kind: "close" };
      },
      "implement-here": async () => {
        await options.implementHere();
        return { kind: "close" };
      },
      "select-model": async ({ itemId }) => {
        freshFlow.selectModel(itemId);
        return { kind: "back" };
      },
      "select-thinking": async ({ itemId }) => {
        freshFlow.selectThinking(itemId);
        return { kind: "back" };
      },
      "start-fresh": async ({ signal }) => {
        await freshFlow.start(signal);
        return { kind: "close" };
      },
      export: async ({ value, signal }) =>
        (await options.exportPlan(value ?? "", signal)) ? { kind: "close" } : { kind: "rejected" },
      save: async () => {
        options.save();
        return { kind: "close" };
      },
      stay: async () => {
        options.stay();
        return { kind: "close" };
      },
      exit: async () => {
        options.exit();
        return { kind: "close" };
      },
    },
  });
  await runMenu(ctx, menu, {
    getState: () => undefined,
    signal: options.signal,
    isCurrent: options.isCurrent,
  });
  await deferredEdit.reopenAfter(() => showPlanModeMenu(ctx, options));
}

interface ReadyPlanMenuOptions extends PlanEditOption {
  planThinkingLevel: PlanModeFixedThinkingLevel | undefined;
  /** The model Start fresh treats as the plan's, with the label the menu shows for it. */
  planModel: FreshPlanModel;
  implementationDefaults?: ImplementationRuntimeSelection;
  implementationOutcome(): string;
  getExportDestination: PlanExportDestinationProvider;
  show(): void;
  implementHere(): void | Promise<void>;
  implementFresh(runtime: ImplementationRuntimeSelection, signal: AbortSignal): void | Promise<void>;
  exportPlan(path: string, signal: AbortSignal): Promise<boolean>;
  save(): void;
  stay(): void;
  exit(): void;
}

export async function showReadyPlanMenu(ctx: ExtensionContext, options: ReadyPlanMenuOptions): Promise<void> {
  let start: "ready" | "fresh" | "export" = "ready";
  if (ctx.mode === "tui" && ctx.hasUI) {
    const action = await chooseReadyPlanAction(ctx);
    if (!action || options.signal.aborted || !options.isCurrent()) return;
    if (action === "edit") {
      if (await editPlanThenReopen(options)) await showReadyPlanMenu(ctx, options);
      return;
    }
    if (action === "show") {
      options.show();
      return;
    }
    if (action === "implement-here") {
      await options.implementHere();
      return;
    }
    if (action === "save") {
      options.save();
      return;
    }
    if (action === "stay") {
      options.stay();
      return;
    }
    if (action === "exit") {
      options.exit();
      return;
    }
    start = action === "implement-fresh" ? "fresh" : "export";
  }
  await runReadyPlanMenu(ctx, options, start);
}

async function runReadyPlanMenu(
  ctx: ExtensionContext,
  options: ReadyPlanMenuOptions,
  start: "ready" | "fresh" | "export",
): Promise<void> {
  type Screen = "ready" | "fresh" | "models" | "thinking" | "export";
  type Action =
    | "show"
    | "edit"
    | "implement-here"
    | "select-model"
    | "select-thinking"
    | "start-fresh"
    | "export"
    | "save"
    | "stay"
    | "exit";
  const freshFlow = createFreshImplementationFlow(
    ctx,
    options.planModel,
    options.planThinkingLevel,
    options.implementationDefaults,
    options.implementFresh,
  );
  const deferredEdit = deferPlanEdit(options);
  const menu = defineMenu<undefined, Screen, Action, ExtensionContext>({
    start,
    screens: {
      ready: () => ({
        kind: "actions",
        title: "Proposed plan ready",
        items: [
          { id: "show", label: "Show latest proposed plan", action: "show" },
          { id: "implement-here", label: "Implement here", action: "implement-here" },
          { id: "implement-fresh", label: "Start fresh and implement", to: "fresh" },
          { id: "export", label: "Export plan…", to: "export" },
          { id: "edit", label: "Edit plan…", action: "edit" },
          { id: "save", label: "Save for later", action: "save" },
          { id: "stay", label: "Stay in Plan mode", action: "stay" },
          { id: "exit", label: "Discard plan and exit", action: "exit" },
        ],
        hint: "close",
      }),
      fresh: freshFlow.settingsScreen,
      models: freshFlow.modelScreen,
      thinking: freshFlow.thinkingScreen,
      export: () => planExportInputScreen(options.getExportDestination),
    },
    actions: {
      show: async () => {
        options.show();
        return { kind: "close" };
      },
      edit: deferredEdit.action,
      "implement-here": async () => {
        await options.implementHere();
        return { kind: "close" };
      },
      "select-model": async ({ itemId }) => {
        freshFlow.selectModel(itemId);
        return { kind: "back" };
      },
      "select-thinking": async ({ itemId }) => {
        freshFlow.selectThinking(itemId);
        return { kind: "back" };
      },
      "start-fresh": async ({ signal }) => {
        await freshFlow.start(signal);
        return { kind: "close" };
      },
      export: async ({ value, signal }) =>
        (await options.exportPlan(value ?? "", signal)) ? { kind: "close" } : { kind: "rejected" },
      save: async () => {
        options.save();
        return { kind: "close" };
      },
      stay: async () => {
        options.stay();
        return { kind: "close" };
      },
      exit: async () => {
        options.exit();
        return { kind: "close" };
      },
    },
  });
  await runMenu(ctx, menu, {
    getState: () => undefined,
    signal: options.signal,
    isCurrent: options.isCurrent,
  });
  await deferredEdit.reopenAfter(() => showReadyPlanMenu(ctx, options));
}

/** What Start fresh's "same as plan" runs on, and what the menu calls it. */
export interface FreshPlanModel {
  model: ImplementationModelOverride | undefined;
  label: "same as plan" | "previous model";
}

const FRESH_PLAN_MODEL_CHOICES: Record<FreshPlanModel["label"], string> = {
  "same as plan": "Same as plan",
  "previous model": "Previous model",
};

interface ModelChoice {
  itemId: string;
  model: ImplementationModelOverride;
  modelInfo: AvailableImplementationModel;
  label: string;
  summary: string;
  details?: readonly string[];
  searchText: string;
  isPlanModel: boolean;
}

function createFreshImplementationFlow(
  ctx: ExtensionContext,
  freshPlanModel: FreshPlanModel,
  planThinkingLevel: PlanModeFixedThinkingLevel | undefined,
  implementationDefaults: ImplementationRuntimeSelection | undefined,
  implementFresh: (runtime: ImplementationRuntimeSelection, signal: AbortSignal) => void | Promise<void>,
) {
  const { model: planModel, label: planModelLabel } = freshPlanModel;
  const models = snapshotAvailableModels(ctx, planModel);
  const planModelSummary = planModel
    ? `${safeModelMetadata(planModel.modelId, "unknown model")} [${safeModelMetadata(planModel.provider, "unknown provider")}]`
    : undefined;
  const planModelChoice = FRESH_PLAN_MODEL_CHOICES[planModelLabel];
  const configuredModel = implementationDefaults?.model;
  const configuredAvailableModel = findAvailableImplementationModel(
    models.map((choice) => choice.modelInfo),
    configuredModel,
  );
  let unavailableDefaultActive = configuredModel !== undefined && !configuredAvailableModel;
  let selectedModel = configuredAvailableModel
    ? models.find((choice) => choice.modelInfo === configuredAvailableModel)
    : undefined;
  let selectedModelUsesDefault = selectedModel !== undefined;
  let selectedThinkingLevel = implementationDefaults?.thinkingLevel;
  return {
    settingsScreen: () => ({
      kind: "actions" as const,
      title: "Fresh implementation settings",
      lines: [
        "These choices apply once to the new implementation session.",
        ...(unavailableDefaultActive && configuredModel
          ? [`Configured default ${safeModelReference(configuredModel)} is unavailable; using ${planModelLabel}.`]
          : []),
      ],
      items: [
        {
          id: "start-fresh",
          label: "Start fresh implementation",
          description: "Create the linked session and begin implementation.",
          action: "start-fresh" as const,
          busyLabel: "Starting fresh implementation session…",
        },
        {
          id: "implementation-model",
          label: "Model",
          description:
            selectedModel?.summary ?? (planModelSummary ? `${planModelSummary} · ${planModelLabel}` : planModelChoice),
          to: "models" as const,
        },
        {
          id: "implementation-thinking",
          label: "Thinking level",
          description:
            selectedThinkingLevel ?? (planThinkingLevel ? `${planThinkingLevel} · same as plan` : "Same as plan"),
          to: "thinking" as const,
        },
      ],
    }),
    modelScreen: () => ({
      kind: "choice" as const,
      title: "Implementation model",
      items: [
        {
          id: "same-as-plan",
          label: planModelChoice,
          ...(planModelSummary ? { description: planModelSummary } : {}),
        },
        ...models.map((choice) => ({
          id: choice.itemId,
          label: choice.label,
          details: choice.details,
          searchText: choice.searchText,
        })),
      ],
      action: "select-model" as const,
      initialItemId: selectedModel?.itemId ?? "same-as-plan",
      enableSearch: true,
      viewportSize: 10,
    }),
    thinkingScreen: () => ({
      kind: "choice" as const,
      title: "Implementation thinking level",
      items: [
        {
          id: "same-as-plan",
          label: "Same as plan",
        },
        ...IMPLEMENTATION_THINKING_LEVELS.map((level) => ({
          id: level,
          label: `${level === planThinkingLevel ? "✓ " : ""}${level}`,
          description: THINKING_LEVEL_DESCRIPTIONS[level],
        })),
      ],
      action: "select-thinking" as const,
      initialItemId: selectedThinkingLevel ?? "same-as-plan",
      viewportSize: IMPLEMENTATION_THINKING_LEVELS.length + 1,
    }),
    selectModel(itemId: string) {
      const choice = models.find((candidate) => candidate.itemId === itemId);
      selectedModel = itemId === "same-as-plan" || choice?.isPlanModel ? undefined : choice;
      selectedModelUsesDefault = false;
      unavailableDefaultActive = false;
    },
    selectThinking(itemId: string) {
      selectedThinkingLevel = IMPLEMENTATION_THINKING_LEVELS.find((level) => level === itemId);
    },
    start(signal: AbortSignal) {
      if (
        selectedModelUsesDefault &&
        selectedModel &&
        !findAvailableImplementationModel(snapshotAvailableImplementationModels(ctx), selectedModel.model)
      ) {
        const unavailableModel = selectedModel.model;
        selectedModel = undefined;
        selectedModelUsesDefault = false;
        unavailableDefaultActive = true;
        ctx.ui.notify(
          `Configured default ${safeModelReference(unavailableModel)} is unavailable; using ${planModelLabel}.`,
          "warning",
        );
      }
      const model = selectedModel?.model ?? planModel;
      const thinkingLevel = selectedThinkingLevel ?? planThinkingLevel;
      return implementFresh(
        {
          ...(model ? { model: { ...model } } : {}),
          ...(thinkingLevel ? { thinkingLevel } : {}),
        },
        signal,
      );
    },
  };
}

function snapshotAvailableModels(
  ctx: ExtensionContext,
  planModel: ImplementationModelOverride | undefined,
): ModelChoice[] {
  return snapshotAvailableImplementationModels(ctx)
    .map((model, index) => {
      const provider = safeModelMetadata(model.provider, "unknown provider");
      const modelId = safeModelMetadata(model.id, "unknown model");
      const name = safeModelMetadata(model.name, "");
      const isPlanModel = planModel?.provider === model.provider && planModel.modelId === model.id;
      const summary = `${modelId} [${provider}]`;
      return {
        itemId: `model-${index}`,
        model: { provider: model.provider, modelId: model.id },
        modelInfo: model,
        label: `${isPlanModel ? "✓ " : ""}${summary}${isPlanModel ? " · default" : ""}`,
        summary,
        ...(name ? { details: [`Model Name: ${name}`] } : {}),
        searchText: [provider, modelId, name].filter(Boolean).join(" "),
        isPlanModel,
      };
    })
    .sort((left, right) => Number(right.isPlanModel) - Number(left.isPlanModel));
}

function safeModelReference(model: ImplementationModelOverride) {
  return `${safeModelMetadata(model.modelId, "unknown model")} [${safeModelMetadata(model.provider, "unknown provider")}]`;
}

function safeModelMetadata(value: unknown, fallback: string) {
  if (typeof value !== "string") return fallback;
  const safe = sanitizeTerminalText(value).trim() || fallback;
  return [...safe].slice(0, 512).join("");
}
