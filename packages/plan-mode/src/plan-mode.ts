import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
import { basename, dirname } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  InputEvent,
  InputSource,
} from "@earendil-works/pi-coding-agent";
import {
  answerPlanModeStateQueries,
  BLOCKED_MUTATING_TOOLS,
  blockedShellCallReason,
  createChildToolPolicy,
  PLAN_MODE_STATE_VERSION,
  SUBAGENT_SPAWN_TOOLS,
  subagentGateInstalled,
} from "./child-policy.js";
import { completePlanArguments } from "./command.js";
import {
  normalizePlanModeCompletion,
  PLAN_MODE_COMPLETE_PARAMS,
  PLAN_MODE_COMPLETE_TOOL_NAME,
  planModeCompleted,
  renderPlanModeCompletion,
  renderPlanModeCompletionCall,
} from "./completion-tool.js";
import { createDeclineContractMessage, DECLINE_GATE_ERROR } from "./decline-contract.js";
import { isStaleExtensionContextError } from "./extension-runtime.js";
import {
  createFinalizationRequestCoordinator,
  FINALIZE_PLAN_PROMPT,
  type FinalizationRunOutcome,
  RETRY_FINALIZE_PLAN_PROMPT,
} from "./finalization-request.js";
import {
  formatHistoryImplementationPrompt,
  formatImplementationHandoff,
  formatTransferredPlanPrompt,
  startFreshImplementationFromState,
} from "./fresh-implementation.js";
import { createHeadlessTurns } from "./headless-turn.js";
import {
  createImplementationRetentionCoordinator,
  implementationRetentionPreview,
} from "./implementation-retention.js";
import {
  invalidPlanMessage,
  latestAssistantStopReason,
  latestAssistantText,
  messageTextContent,
  parseProposedPlan,
} from "./message-transform.js";
import {
  createModeContractMessage,
  hasModeContractArtifact,
  latestModeContract,
  MODE_CONTRACT_MESSAGE_TYPE,
  type PlanModeContract,
  reconcileModeContract,
} from "./mode-contract.js";
import { createPlanActionController } from "./plan-action-controller.js";
import type { FreshPlanModel } from "./plan-action-menus.js";
import { createPlanApprovals } from "./plan-approval.js";
import { createPlanEditMessage, PLAN_EDIT_SOURCE, reviewEditedPlan } from "./plan-edit.js";
import { createPlanExportController } from "./plan-export-controller.js";
import { type PlanModelTier, planModelTarget } from "./plan-model.js";
import {
  clearPlanModeUi,
  planModeStatusText as formatPlanModeStatusText,
  PLAN_MESSAGE_TYPE,
  renderPlanMessage,
  showStoredPlan,
  updatePlanModeUi,
} from "./presentation.js";
import {
  answerPlanModeQuestions,
  isReproposalConfirmed,
  normalizePlanModeQuestionParams,
  PLAN_MODE_QUESTION_PARAMS,
  PLAN_MODE_QUESTION_TOOL_NAME,
  planModeQuestionCancelled,
  renderPlanModeQuestion,
  renderPlanModeQuestionCall,
} from "./question-tool.js";
import { assertPlanModeHelperToolsAvailable, planModeHelperToolsAvailable } from "./required-tools.js";
import { preflightSavedPlanImplementation, savedPlanBlocksNewWorkflow } from "./saved-plan-preflight.js";
import {
  awaitPlanModeSettingsWrites,
  configuredImplementationPlanRetention,
  configuredPlanModeToggleShortcut,
  configuredThinkingLevel,
  type PlanModeFixedThinkingLevel,
  type PlanModeSettings,
  type PlanModeSettingsPatch,
  planModeSettingsPath,
  readPlanModeSettings,
  type UpdatePlanModeSettingsOptions,
  updatePlanModeSettings,
} from "./settings.js";
import {
  type ImplementationModelOverride,
  type ImplementationRuntimeSelection,
  type PlanCompletionSource,
  type PlanModelSwitch,
  type PlanModeState,
  type PlanModeWorkflowToolPolicy,
  restorePlanModeState,
} from "./state.js";
import { planModeToolAvailability } from "./tool-availability.js";
import { canSelectToolInPlanMode, classifyPlanModeTool } from "./tool-policy.js";
import {
  compareTools,
  filterAvailableSelectedToolNames,
  planModeToolSelection,
  snapshotPlanModeSelectedNames,
} from "./tool-selection.js";
import { WorkflowMutex, type WorkflowMutexOwner } from "./workflow-mutex.js";

const STATE_ENTRY_TYPE = "plan-mode-state";
const RECOVERED_RUNTIME_ADMISSION_INPUT_MESSAGE_TYPE = "plan-mode-recovered-input";
const DEFAULT_TOOLS = ["read", "bash", "edit", "write"];
/** Decline-gate fields cleared whenever a planning workflow starts or ends. */
const DECLINE_RESET = { declinedPlans: 0, reproposalReview: undefined, planDeclined: false } as const;
interface ReadyPresentationIntent {
  nonce: number;
  plan: string;
  source: PlanCompletionSource;
}
interface UnappliedPlanEdit {
  /** The plan the text was edited from; a different current plan drops the text. */
  before: string;
  enabled: boolean;
  sessionGeneration: number;
  text: string;
}
interface PendingWorkflowToolPolicy {
  generation: number;
  mode: "resolve" | "revalidate";
}
type ImplementationRuntimeApplicationResult = "ready" | "blocked" | "stale";
interface ActiveImplementationRuntimeApplication {
  sessionManager: ExtensionContext["sessionManager"];
  completion: Promise<ImplementationRuntimeApplicationResult>;
  drainOnShutdown: boolean;
  holdForAdmission: boolean;
}
interface QueuedRuntimeAdmissionInput {
  sessionManager: ExtensionContext["sessionManager"];
  text: string;
  images?: NonNullable<InputEvent["images"]>;
  source: InputSource;
}
type InteractiveUi = typeof import("./interactive-ui.js");

interface PlanModeDependencies {
  readSettings?(): ReturnType<typeof readPlanModeSettings>;
  updateSettings?(
    patch: PlanModeSettingsPatch,
    options?: UpdatePlanModeSettingsOptions,
  ): ReturnType<typeof updatePlanModeSettings>;
  settingsPath?: string;
  /** Home for policy-only tilde expansion in SDK hosts. */
  homeDir?: string;
  loadInteractiveUi?(): Promise<InteractiveUi>;
  /** Test seam for `createHeadlessTurns`. */
  headlessTurnStartTimeoutMs?: number;
}

// Keep session state, persistence, tool, thinking, and mutex commits in this one closure so an
// activation path cannot bypass the same atomic transition by crossing module-owned state.
export default function planMode(pi: ExtensionAPI, dependencies: PlanModeDependencies = {}) {
  const workflowMutex = new WorkflowMutex(pi);
  let workflowOwner: WorkflowMutexOwner | undefined;
  let currentSession: object | undefined;
  let currentSessionContext: ExtensionContext | undefined;
  let interactiveUiPromise: Promise<InteractiveUi> | undefined;
  const loadInteractiveUi = () => {
    if (dependencies.loadInteractiveUi) return dependencies.loadInteractiveUi();
    if (!interactiveUiPromise) {
      interactiveUiPromise = import("./interactive-ui.js").catch((error) => {
        interactiveUiPromise = undefined;
        throw error;
      });
    }
    return interactiveUiPromise;
  };
  const explicitPlanModeSettingsPath = dependencies.settingsPath;
  let state: PlanModeState = { enabled: false, awaitingAction: false, declinedPlans: 0 };
  let settings: PlanModeSettings = { thinkingLevel: "inherit" };
  let startupToggleShortcut: ReturnType<typeof configuredPlanModeToggleShortcut>;
  let shortcutInitialized = false;
  let workflowAllowedToolNames: string[] | undefined;
  let pendingWorkflowToolPolicy: PendingWorkflowToolPolicy | undefined;
  let publishedContractMode: PlanModeContract | undefined;
  let modeContractsRelevant = false;
  let readyPresentationIntent: ReadyPresentationIntent | undefined;
  /** Editor text that was not applied, restored when the same plan is edited again. */
  let unappliedPlanEdit: UnappliedPlanEdit | undefined;
  let readyPresentationInFlightNonce: number | undefined;
  let nextReadyPresentationNonce = 0;
  let menuGeneration = 0;
  let workflowGeneration = 0;
  let refreshStateBeforeFirstAgentStart = false;
  let activeImplementationRuntimeApplication: ActiveImplementationRuntimeApplication | undefined;
  let pendingRuntimeAdmissionSession: object | undefined;
  let queuedRuntimeAdmissionInputs: QueuedRuntimeAdmissionInput[] = [];
  let shuttingDownSession: object | undefined;
  let menuController = new AbortController();
  let settingsWatch: ReturnType<typeof watch> | undefined;
  let settingsReloadTimer: ReturnType<typeof setTimeout> | undefined;
  /** Bumped by every Plan start, exit and session change so a queued model switch can tell it is stale. */
  let planModelEpoch = 0;
  /** Plan model switches run in order; `before_agent_start` awaits the tail so a run never starts mid-switch. */
  let planModelTransition: Promise<void> = Promise.resolve();
  /** Pi re-selects thinking inside `setModel`; those events are not manual changes. */
  let switchingPlanModel = false;
  /** Source session of an in-flight Start fresh; its shutdown restores the pre-Plan runtime. */
  let freshSourceSession: ExtensionContext["sessionManager"] | undefined;
  const implementationRetention = createImplementationRetentionCoordinator();
  const finalizationRequest = createFinalizationRequestCoordinator();
  const headlessTurns = createHeadlessTurns(dependencies.headlessTurnStartTimeoutMs);
  const planApprovals = createPlanApprovals(pi);
  const persistState = () => pi.appendEntry<PlanModeState>(STATE_ENTRY_TYPE, state);
  const planExports = createPlanExportController({
    getState: () => state,
    getSettings: () => settings,
    finishReady: (ctx) => {
      exitPlanMode(ctx);
    },
  });
  const planActions = createPlanActionController({
    loadInteractiveUi,
    getState: () => state,
    captureLifecycle: captureMenuLifecycle,
    statusText: planStatusText,
    // ExtensionContext.thinkingLevel was added after the supported Pi 0.80.6 floor.
    // ExtensionAPI has exposed the same runtime value throughout that compatibility range.
    getThinkingLevel: () => pi.getThinkingLevel(),
    getFreshPlanModel,
    getSettings: () => settings,
    implementationOutcome,
    getExportDestination: (ctx) => planExports.getDestination(ctx),
    show: (ctx) => showStoredPlan(pi, ctx, state),
    edit: editPlan,
    finalize: requestFinalPlan,
    implementHere: startImplementation,
    implementFresh: startFreshImplementation,
    exportPlan: exportPlan,
    settings: showSettings,
    save: savePlanForLater,
    stay: (ctx) => {
      recordPlanDecline();
      updateUi(ctx);
    },
    exitReady: (ctx) => {
      if (exitPlanMode(ctx)) {
        ctx.ui.notify("Plan mode disabled. Proposed plan discarded.", "info");
      }
    },
    clearSaved: (ctx) => {
      if (exitPlanMode(ctx)) ctx.ui.notify("Saved plan cleared.", "info");
    },
  });

  // Subagent hosts ask before each child run; the live answer covers /reload, /resume and tree moves.
  answerPlanModeStateQueries(pi, () => {
    const sessionId = (currentSession as ExtensionContext["sessionManager"] | undefined)?.getSessionId();
    if (!state.enabled) return { version: PLAN_MODE_STATE_VERSION, active: false, sessionId };
    return {
      version: PLAN_MODE_STATE_VERSION,
      active: true,
      sessionId,
      evaluate: createChildToolPolicy({
        selected: new Map(planModePolicyToolNames().map((name) => [name, toolByName(name)?.sourceInfo?.path])),
        settings,
        homeDir: dependencies.homeDir,
      }),
    };
  });

  pi.registerMessageRenderer(PLAN_MESSAGE_TYPE, renderPlanMessage);

  pi.registerTool({
    name: PLAN_MODE_QUESTION_TOOL_NAME,
    label: "Plan question",
    description:
      "Ask one to three structured questions only when the latest effective Plan contract explicitly says /plan mode is active. Tool visibility alone does not activate Plan mode. Never call for ordinary planning requests, the writing-plans skill, roadmaps, checklists, or plan-file work.",
    parameters: PLAN_MODE_QUESTION_PARAMS,
    renderCall: renderPlanModeQuestionCall,
    renderResult: renderPlanModeQuestion,
    async execute(_toolCallId, params: unknown, _signal, _onUpdate, ctx) {
      if (!state.enabled || !workflowMutex.isOwner(workflowOwner)) {
        return planModeQuestionCancelled(
          [],
          "plan_mode_inactive",
          "Error: plan_mode_question is only available while Plan mode is active.",
        );
      }

      const parsed = normalizePlanModeQuestionParams(params);
      if (!parsed.ok) {
        return planModeQuestionCancelled([], "invalid_input", `Error: ${parsed.error}`);
      }
      finalizationRequest.satisfy();
      // A new confirmation supersedes any earlier permission. While it is
      // pending, cancelled, or answered Not yet, completion must stay blocked.
      if (parsed.mode) {
        state = { ...state, reproposalReview: "required" };
        persistState();
      }

      if (!ctx.hasUI) {
        return planModeQuestionCancelled(
          parsed.questions,
          "ui_unavailable",
          "Unable to ask Plan-mode questions because interactive UI is not available.",
          parsed.mode,
        );
      }

      const sessionGeneration = menuGeneration;
      const questionWorkflowGeneration = workflowGeneration;
      const questionOwner = workflowOwner;
      const result = await answerPlanModeQuestions(
        parsed.questions,
        ctx,
        {
          isCurrent: () =>
            sessionGeneration === menuGeneration &&
            questionWorkflowGeneration === workflowGeneration &&
            workflowMutex.isOwner(questionOwner),
          isEnabled: () => state.enabled,
        },
        parsed.mode,
      );
      if (isReproposalConfirmed(result)) confirmReproposal();
      return result;
    },
  });

  pi.registerTool({
    name: PLAN_MODE_COMPLETE_TOOL_NAME,
    label: "Complete plan",
    description:
      "Submit a decision-ready plan only when the latest effective Plan contract explicitly says /plan mode is active, and call it alone as the final action. Tool visibility alone does not activate Plan mode. Never call for ordinary planning requests, the writing-plans skill, roadmaps, checklists, or plan-file work.",
    parameters: PLAN_MODE_COMPLETE_PARAMS,
    renderCall: renderPlanModeCompletionCall,
    renderResult: renderPlanModeCompletion,
    async execute(_toolCallId, params: unknown, _signal, _onUpdate, ctx) {
      if (!state.enabled || !workflowMutex.isOwner(workflowOwner)) {
        throw new Error("plan_mode_complete is only available while Plan mode is active");
      }
      if (state.reproposalReview === "required") throw new Error(DECLINE_GATE_ERROR);
      const parsed = normalizePlanModeCompletion(params);
      if (!parsed.ok) throw new Error(parsed.error);

      acceptCompletedPlan(parsed.plan, PLAN_MODE_COMPLETE_TOOL_NAME, ctx);
      return planModeCompleted(parsed.plan);
    },
  });

  pi.registerCommand("plan", {
    description: "Enter or manage Codex-like Plan mode",
    getArgumentCompletions: completePlanArguments,
    handler: async (args, ctx) => {
      const turn = headlessTurns.arm(ctx);
      try {
        await runPlanCommand(args, ctx);
      } finally {
        await turn?.settle();
      }
    },
  });

  async function runPlanCommand(args: string, ctx: ExtensionCommandContext) {
    const prompt = args.trim();
    const command = prompt.toLowerCase();
    if (command === "start") {
      if (savedPlanBlocksNewWorkflow(ctx, state.savedPlan !== undefined && !state.enabled)) return;
      if (state.enabled) {
        ctx.ui.notify("Plan mode is already active.", "info");
        return;
      }
      if (enterPlanMode(ctx)) {
        ctx.ui.notify("Plan mode enabled. I will explore and plan, but not modify files.", "info");
      }
      return;
    }
    if (command === "show") {
      showStoredPlan(pi, ctx, state);
      return;
    }
    if (command === "finalize") {
      requestFinalPlan(ctx);
      return;
    }
    if (command === "implement") {
      if (!(state.enabled && state.latestPlan?.trim()) && !state.savedPlan?.plan.trim()) {
        ctx.ui.notify("No completed plan is available to implement.", "warning");
        return;
      }
      await startImplementation(ctx);
      return;
    }
    if (command === "save") {
      savePlanForLater(ctx);
      return;
    }
    if (command === "settings") {
      if (!ctx.hasUI) {
        throw new Error("/plan settings requires TUI or RPC mode and is unavailable here.");
      }
      const lifecycle = captureMenuLifecycle();
      await showSettings(ctx, lifecycle.signal, lifecycle.isCurrent);
      return;
    }
    const exportMatch = /^export(?:\s+([\s\S]+))?$/iu.exec(prompt);
    if (exportMatch) {
      const lifecycle = captureMenuLifecycle();
      await exportPlan(ctx, exportMatch[1], lifecycle.signal, lifecycle.isCurrent);
      return;
    }
    if (command === "exit" || command === "off") {
      const notification = planModeDisableNotification();
      if (exitPlanMode(ctx)) ctx.ui.notify(notification, "info");
      return;
    }
    if (command === "tools") {
      if (savedPlanBlocksNewWorkflow(ctx, state.savedPlan !== undefined && !state.enabled)) return;
      if (state.enabled) {
        const message =
          "Plan-mode tools are locked while Planning is active. Exit Plan mode and choose tools before starting again.";
        if (!ctx.hasUI) throw new Error(message);
        ctx.ui.notify(message, "warning");
        return;
      }
      if (!ctx.hasUI) {
        throw new Error("/plan tools requires TUI or RPC mode and is unavailable here.");
      }
      await showLaunchMenu(ctx, "tools");
      return;
    }
    if (prompt) {
      if (savedPlanBlocksNewWorkflow(ctx, state.savedPlan !== undefined && !state.enabled)) return;
      enterPlanModeWithPrompt(prompt, ctx);
      return;
    }
    if (!ctx.hasUI) {
      throw new Error(
        "The interactive /plan menu is unavailable in print and JSON modes. Use /plan start or /plan <prompt>.",
      );
    }
    if (!state.enabled) {
      if (state.activeImplementation && ctx.hasUI) {
        await showActivePlanMenu(ctx);
        return;
      }
      if (state.savedPlan) {
        await planActions.showSaved(ctx);
        return;
      }
      await showLaunchMenu(ctx);
      return;
    }
    await planActions.showCurrent(ctx);
  }

  const initializePlanModeShortcut = () => {
    if (shortcutInitialized) return;
    // Pi snapshots registrations when binding the editor. Keep even an unset shortcut stable
    // for this runtime; settings saves and file watches take effect after /reload or restart.
    const shortcut = configuredPlanModeToggleShortcut(settings);
    if (shortcut) {
      pi.registerShortcut(shortcut, {
        description: "Toggle Plan mode",
        handler: (ctx) => togglePlanMode(ctx),
      });
    }
    startupToggleShortcut = shortcut;
    shortcutInitialized = true;
  };

  const readPlanModeRuntimeSettings = async () => {
    return dependencies.readSettings?.() ?? readPlanModeSettings(explicitPlanModeSettingsPath);
  };

  const applyPlanModeSettings = async (
    generation: number,
    ctx: ExtensionContext | undefined,
    showWarnings: boolean,
  ) => {
    const loadedSettings = await readPlanModeRuntimeSettings();
    if (generation !== menuGeneration || menuController.signal.aborted) {
      return undefined;
    }
    settings =
      loadedSettings.kind === "loaded"
        ? loadedSettings.settings
        : ({ thinkingLevel: "inherit" } satisfies PlanModeSettings);
    if (!ctx || !showWarnings) return loadedSettings;
    if (loadedSettings.kind === "invalid") {
      ctx.ui.notify(`pi-plan-mode settings ignored: ${loadedSettings.reason}`, "warning");
    }
    if (loadedSettings.notice) {
      ctx.ui.notify(loadedSettings.notice, "warning");
    }
    return loadedSettings;
  };

  const stopPlanModeSettingsWatch = () => {
    if (settingsReloadTimer) {
      clearTimeout(settingsReloadTimer);
      settingsReloadTimer = undefined;
    }
    settingsWatch?.close();
    settingsWatch = undefined;
  };

  const schedulePlanModeSettingsReload = (generation: number) => {
    if (settingsReloadTimer) {
      clearTimeout(settingsReloadTimer);
      settingsReloadTimer = undefined;
    }
    settingsReloadTimer = setTimeout(() => {
      settingsReloadTimer = undefined;
      void applyPlanModeSettings(generation, currentSessionContext, false);
    }, 75);
  };

  const startPlanModeSettingsWatch = (generation: number) => {
    stopPlanModeSettingsWatch();
    if (dependencies.readSettings) return;
    const pathToWatch = explicitPlanModeSettingsPath ?? planModeSettingsPath();
    try {
      const directory = dirname(pathToWatch);
      const fileName = basename(pathToWatch);
      // Node and Bun report only "rename" and "change", and either can mean the file changed.
      const watcher = watch(directory, { persistent: false }, (_event, changedFile) => {
        if (!changedFile || changedFile.toString() !== fileName) return;
        schedulePlanModeSettingsReload(generation);
      });
      watcher.on("error", () => {
        stopPlanModeSettingsWatch();
      });
      settingsWatch = watcher;
    } catch {
      stopPlanModeSettingsWatch();
    }
  };

  pi.on("session_start", async (event, ctx) => {
    const generation = ++menuGeneration;
    finalizationRequest.reset();
    currentSession = ctx.sessionManager;
    currentSessionContext = ctx;
    shuttingDownSession = undefined;
    workflowOwner = undefined;
    workflowMutex.bindSession(ctx.sessionManager);
    // Every extension is loaded by now: the ask tells a subagent gate that Plan mode is present.
    subagentGateInstalled(pi);
    refreshStateBeforeFirstAgentStart = event.reason === "new";
    pendingRuntimeAdmissionSession = undefined;
    queuedRuntimeAdmissionInputs = [];
    menuController.abort(new DOMException("Plan-mode session replaced", "AbortError"));
    menuController = new AbortController();
    readyPresentationIntent = undefined;
    workflowAllowedToolNames = undefined;
    pendingWorkflowToolPolicy = undefined;
    implementationRetention.reset();
    planModelEpoch += 1;
    settings = { thinkingLevel: "inherit" };
    const branch = ctx.sessionManager.getBranch();
    const restoredState = restorePlanModeState(branch, STATE_ENTRY_TYPE);
    restoreModeContractTracking(branch, restoredState);
    state = { enabled: false, awaitingAction: false, declinedPlans: 0 };
    await applyPlanModeSettings(generation, ctx, true);
    if (generation !== menuGeneration || menuController.signal.aborted) return;
    initializePlanModeShortcut();
    startPlanModeSettingsWatch(generation);
    if (!installRestoredState(restoredState, ctx)) return;
    implementationRetention.restore(state.activeImplementation);
    updateUi(ctx);
    planApprovals.announceLatest(ctx);
    // A new session receives its setup entries after session_start, so its input gate refreshes
    // them. Resumed and forked sessions already have the intent and must apply it here because
    // extension-triggered custom-message turns bypass the user-input gates.
    if (event.reason !== "new") await applyPendingImplementationRuntime(ctx);
  });

  pi.on("session_before_tree", (event, ctx) => {
    if (runtimeAdmissionIsPending(ctx.sessionManager)) {
      if (ctx.hasUI) {
        ctx.ui.notify(
          "Wait for fresh implementation startup to admit the pending prompts before changing branches.",
          "warning",
        );
      }
      return { cancel: true };
    }
    const target = ctx.sessionManager.getEntry(event.preparation.targetId);
    if (target?.type !== "custom_message" || target.customType !== MODE_CONTRACT_MESSAGE_TYPE) {
      return;
    }
    if (ctx.hasUI) {
      ctx.ui.notify(
        "Plan mode transition markers are internal. Select the adjacent conversation entry instead.",
        "warning",
      );
    }
    return { cancel: true };
  });

  pi.on("session_tree", async (_event, ctx) => {
    advanceWorkflowGeneration();
    menuGeneration += 1;
    menuController.abort(new DOMException("Plan-mode tree branch changed", "AbortError"));
    menuController = new AbortController();
    readyPresentationIntent = undefined;
    pendingRuntimeAdmissionSession = undefined;
    queuedRuntimeAdmissionInputs = [];
    implementationRetention.reset();
    const branch = ctx.sessionManager.getBranch();
    const restoredState = restorePlanModeState(branch, STATE_ENTRY_TYPE);
    restoreModeContractTracking(branch, restoredState);
    if (!installRestoredState(restoredState, ctx)) return;
    implementationRetention.restore(state.activeImplementation);
    startPlanModeSettingsWatch(menuGeneration);
    updateUi(ctx);
    await applyPendingImplementationRuntime(ctx);
  });

  pi.on("model_select", (event) => {
    const modelSwitch = state.planModelSwitch;
    if (switchingPlanModel || !modelSwitch || sameModel(event.model, modelSwitch.applied)) return;
    // A manual `/model` during Plan wins: exit leaves it in place.
    state = { ...state, planModelSwitch: undefined };
    persistState();
  });

  pi.on("thinking_level_select", (event) => {
    if (switchingPlanModel || !state.enabled || !state.appliedThinkingLevel) return;
    if (event.level !== state.appliedThinkingLevel) {
      state = {
        ...state,
        manualThinkingLevel: event.level,
        previousThinkingLevel: undefined,
        appliedThinkingLevel: undefined,
      };
      persistState();
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const shutdownSession = ctx.sessionManager;
    const runtimeApplication =
      activeImplementationRuntimeApplication?.sessionManager === shutdownSession &&
      activeImplementationRuntimeApplication.drainOnShutdown
        ? activeImplementationRuntimeApplication
        : undefined;
    const queuedInputs = takeQueuedRuntimeAdmissionInputs(shutdownSession);
    for (const queued of queuedInputs) recoverRuntimeAdmissionInput(queued);
    if (currentSession !== undefined && currentSession !== shutdownSession) {
      workflowMutex.unbindSession(shutdownSession);
      return;
    }
    shuttingDownSession = shutdownSession;
    finalizationRequest.reset();
    menuGeneration += 1;
    menuController.abort(new DOMException("Plan-mode session shut down", "AbortError"));
    readyPresentationIntent = undefined;
    refreshStateBeforeFirstAgentStart = false;
    pendingRuntimeAdmissionSession = undefined;
    workflowAllowedToolNames = undefined;
    pendingWorkflowToolPolicy = undefined;
    implementationRetention.reset();
    if (runtimeApplication) await runtimeApplication.completion;
    if (currentSession !== undefined && currentSession !== shutdownSession) {
      workflowMutex.unbindSession(shutdownSession);
      return;
    }
    await awaitPlanModeSettingsWrites(dependencies.settingsPath);
    if (currentSession !== undefined && currentSession !== shutdownSession) {
      workflowMutex.unbindSession(shutdownSession);
      return;
    }
    captureManualThinkingLevel();
    if (freshSourceSession === shutdownSession && state.enabled && state.planModelSwitch) {
      // Start fresh hands the plan off: the source goes back to the model and thinking Plan started from.
      restorePlanRuntime(ctx);
      state = { ...state, resumePlanModel: true };
      persistState();
      await planModelTransition;
    } else {
      persistState();
      if (state.enabled) restoreThinkingLevel();
    }
    stopPlanModeSettingsWatch();
    clearUi(ctx);
    releaseWorkflowOwner();
    workflowMutex.unbindSession(ctx.sessionManager);
    if (currentSession === ctx.sessionManager) {
      currentSession = undefined;
      currentSessionContext = undefined;
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    const requiredHelper =
      event.toolName === PLAN_MODE_QUESTION_TOOL_NAME || event.toolName === PLAN_MODE_COMPLETE_TOOL_NAME;
    if (!state.enabled) {
      if (!requiredHelper) return;
      return {
        block: true,
        reason: `${event.toolName} is only available while Plan mode is active.`,
      };
    }
    if (!workflowMutex.isOwner(workflowOwner)) {
      return {
        block: true,
        reason: `Plan mode blocks tool '${event.toolName}' because workflow ownership is unavailable.`,
      };
    }
    if (BLOCKED_MUTATING_TOOLS.has(event.toolName)) {
      return {
        block: true,
        reason:
          event.toolName === "update_plan"
            ? "Plan mode blocks update_plan because it tracks execution progress rather than conversational planning."
            : `Plan mode blocks mutating tool '${event.toolName}'.`,
      };
    }
    if (requiredHelper) return;

    const calledTool = toolByName(event.toolName);
    const activeToolNames = new Set(safeGetActiveTools());
    if (!calledTool) {
      return {
        block: true,
        reason: activeToolNames.has(event.toolName)
          ? `Plan mode blocks tool '${event.toolName}' because its safe policy metadata is unavailable.`
          : `Plan mode blocks tool '${event.toolName}' because it is not registered or active. Register and activate it before starting the next Plan workflow.`,
      };
    }
    if (!calledTool.sourceInfo?.source) {
      return {
        block: true,
        reason: `Plan mode blocks tool '${event.toolName}' because its safe policy metadata is unavailable.`,
      };
    }
    if (classifyPlanModeTool(calledTool) === "blocked") {
      return {
        block: true,
        reason: `Plan mode blocks tool '${event.toolName}' because its built-in policy is blocked and settings cannot enable it.`,
      };
    }
    const allowedToolNames = new Set(planModePolicyToolNames());
    const availability = planModeToolAvailability(
      calledTool,
      activeToolNames,
      event.parentToolCallId ? "nested" : "model",
    );
    if (availability !== "available") {
      const reason =
        availability === "inactive"
          ? allowedToolNames.has(event.toolName)
            ? "it was admitted to the active Plan workflow but is currently inactive. Reactivate it to continue without restarting."
            : "it is registered but inactive. Activate it before starting the next Plan workflow."
          : availability === "hidden"
            ? "it is hidden in Pi. Stored selection cannot enable hidden tools."
            : availability === "model-only"
              ? "it is model-only and cannot be called by another tool."
              : "its tool exposure is unsupported.";
      return { block: true, reason: `Plan mode blocks tool '${event.toolName}' because ${reason}` };
    }
    if (!allowedToolNames.has(event.toolName)) {
      return {
        block: true,
        // Entering Plan and restoring an enabled state both set the policy before any tool call.
        reason: workflowDesiredToolNames(state.workflowToolPolicy!).has(event.toolName)
          ? `Plan mode blocks tool '${event.toolName}' because it was not available when the active Plan workflow froze its tool policy. Exit Plan mode, then start again after the tool is available.`
          : `Plan mode blocks tool '${event.toolName}' because it is not selected by the Plan policy. Exit Plan mode, then enable it with /plan tools or defaultPlanTools before starting again.`,
      };
    }
    if (SUBAGENT_SPAWN_TOOLS.has(event.toolName) && !subagentGateInstalled(pi)) {
      return {
        block: true,
        reason: `Plan mode blocks '${event.toolName}' because no compatible subagent gate answered, so a child it starts would not plan. Install @nredd/pi-subagents with Plan support (see the pi-plan-mode README).`,
      };
    }
    const blockedShell = blockedShellCallReason(event.toolName, event.input, settings, {
      workingDirectory: ctx.cwd,
      homeDir: dependencies.homeDir,
    });
    if (blockedShell !== undefined) return { block: true, reason: blockedShell };
  });

  pi.on("message_start", (event) => {
    if (
      state.enabled &&
      event.message.role === "user" &&
      messageTextContent(event.message).trim() === FINALIZE_PLAN_PROMPT
    ) {
      finalizationRequest.request(workflowGeneration);
    }
  });

  pi.on("context", async (event, ctx) => {
    resolvePendingWorkflowToolPolicy(ctx);
    const result = implementationRetention.transformContext(event.messages, state);
    if (result.clearActiveImplementationId) clearActiveImplementation(ctx);
    const messages =
      state.enabled || modeContractsRelevant
        ? reconcileModeContract(result.messages, state.enabled ? "plan" : "normal")
        : result.messages;
    const withDecline =
      state.enabled && state.reproposalReview === "required"
        ? [...messages, createDeclineContractMessage(state.declinedPlans, Date.now())]
        : messages;
    return { messages: withDecline as typeof event.messages };
  });

  pi.on("input", async (event, ctx) => {
    // A host may dispatch old-session input after replacement or while shutdown awaits writes.
    if (shuttingDownSession === ctx.sessionManager || (currentSession && currentSession !== ctx.sessionManager)) {
      recoverRuntimeAdmissionInput({ ...event, sessionManager: ctx.sessionManager });
      return { action: "handled" };
    }
    refreshStateForFirstPrompt(ctx);
    // A reply typed while a plan awaits action declines it; the extension's own prompts do not.
    if (event.source !== "extension") recordPlanDecline();
    const waitsForRuntimeAdmission =
      activeImplementationRuntimeApplication?.sessionManager === ctx.sessionManager ||
      pendingRuntimeAdmissionSession === ctx.sessionManager;
    const queuedInput = waitsForRuntimeAdmission
      ? {
          sessionManager: ctx.sessionManager,
          text: event.text,
          ...(event.images ? { images: [...event.images] } : {}),
          source: event.source,
        }
      : undefined;
    if (queuedInput) queuedRuntimeAdmissionInputs.push(queuedInput);
    const result = await applyPendingImplementationRuntime(ctx, true);
    if (result !== "ready") {
      if (result === "stale" && queuedInput) removeQueuedRuntimeAdmissionInput(queuedInput);
      return { action: "handled" };
    }
    if (queuedInput) return { action: "handled" };
  });

  pi.on("agent_start", (_event, ctx) => {
    headlessTurns.runStarted();
    if (currentSession !== ctx.sessionManager) return;
    if (pendingRuntimeAdmissionSession === ctx.sessionManager) {
      pendingRuntimeAdmissionSession = undefined;
    }
    const queuedInputs = takeQueuedRuntimeAdmissionInputs(ctx.sessionManager);
    for (const queued of queuedInputs) {
      pi.sendUserMessage(runtimeAdmissionInputContent(queued), {
        deliverAs: "followUp",
        expandPromptTemplates: queued.source !== "extension",
      });
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    await planModelTransition;
    refreshStateForFirstPrompt(ctx);
    // New-session setup arrives after session_start. Restore and announce its approval
    // even when an extension starts the first run, without treating that run as user input.
    planApprovals.announceLatest(ctx);
    if (event.messageType === "custom") return;
    if (!state.enabled || !workflowMutex.isOwner(workflowOwner)) return;
    if (state.latestPlan || state.awaitingAction) {
      readyPresentationIntent = undefined;
      state = {
        ...state,
        latestPlan: undefined,
        latestPlanSource: undefined,
        awaitingAction: false,
        planDeclined: false,
      };
      persistState();
      updateUi(ctx);
    }
  });

  pi.on("agent_end", async (event, ctx) => {
    if (!state.enabled || !workflowMutex.isOwner(workflowOwner)) return;

    const text = latestAssistantText(event.messages);
    if (finalizationRunOutcome(event.messages) === "cancelled") {
      finalizationRequest.observeRunEnd(workflowGeneration, "cancelled");
      return;
    }
    const parsedPlan = parseProposedPlan(text);
    if (parsedPlan.kind !== "valid") {
      finalizationRequest.observeRunEnd(workflowGeneration, finalizationRunOutcome(event.messages));
      if (parsedPlan.kind !== "absent") {
        ctx.ui.notify(invalidPlanMessage(parsedPlan.kind), "warning");
      }
      persistState();
      updateUi(ctx);
      return;
    }
    if (state.reproposalReview === "required") {
      ctx.ui.notify(`Proposed plan ignored. ${DECLINE_GATE_ERROR}`, "warning");
      persistState();
      updateUi(ctx);
      return;
    }
    acceptCompletedPlan(parsedPlan.plan, "legacy_proposed_plan", ctx);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const settledImplementationId = implementationRetention.implementationSettled(state.activeImplementation);
    if (settledImplementationId) clearActiveImplementation(ctx);

    if (finalizationRequest.hasPendingRequest() && state.enabled && workflowMutex.isOwner(workflowOwner)) {
      if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
      const action = finalizationRequest.settle(workflowGeneration);
      if (action === "retry") {
        if (sendPlanModeUserMessage(RETRY_FINALIZE_PLAN_PROMPT, ctx)) return;
        finalizationRequest.reset();
      }
      if (action === "failed") {
        ctx.ui.notify(
          "Plan finalization ended twice without a structured question or completed plan. Plan mode remains active; revise the plan or run /plan finalize again.",
          "warning",
        );
      }
    }

    const intent = readyPresentationIntent;
    if (!intent || !readyPresentationIsCurrent(intent)) return;
    if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
    if (readyPresentationInFlightNonce === intent.nonce) return;

    readyPresentationInFlightNonce = intent.nonce;
    try {
      await planActions.showReady(ctx, () => readyPresentationIsCurrent(intent));
    } catch (error: unknown) {
      if (!isStaleExtensionContextError(error)) throw error;
    } finally {
      if (readyPresentationIntent?.nonce === intent.nonce) readyPresentationIntent = undefined;
      if (readyPresentationInFlightNonce === intent.nonce) readyPresentationInFlightNonce = undefined;
    }
  });

  function enterPlanMode(
    ctx: ExtensionContext,
    candidate: Pick<PlanModeState, "selectedToolNames" | "selectedToolKeys"> = state,
  ) {
    if (!state.enabled && !allowModeTransition(ctx, "start Plan mode")) return false;
    bindWorkflowSessionIfNeeded(ctx);
    if (state.enabled) return workflowMutex.isOwner(workflowOwner);
    const owner = workflowMutex.acquire();
    if (!owner) return reportWorkflowBusy(ctx);
    workflowOwner = owner;

    const previousState = state;
    try {
      assertPlanModeHelperToolsAvailable(safeGetActiveTools());
      if (!publishModeContract("plan", ctx)) {
        releaseWorkflowOwner();
        return false;
      }
    } catch (error: unknown) {
      releaseWorkflowOwner();
      return reportHelperActivationFailure(ctx, error);
    }
    advanceWorkflowGeneration();
    try {
      modeContractsRelevant = true;
      state = {
        ...state,
        enabled: true,
        awaitingAction: false,
        ...DECLINE_RESET,
        savedPlan: undefined,
        activeImplementation: undefined,
        pendingImplementationRuntime: undefined,
        selectedToolNames: candidate.selectedToolNames,
        selectedToolKeys: candidate.selectedToolKeys,
      };
      beginWorkflowToolPolicy();
      applyPlanThinkingLevel();
      persistState();
      startPlanModel(ctx);
      updateUi(ctx);
      return true;
    } catch (error: unknown) {
      rollbackNewActivation(previousState, ctx);
      throw error;
    }
  }

  function enterPlanModeWithPrompt(prompt: string, ctx: ExtensionContext) {
    const previousState = state;
    const previousOwner = workflowOwner;
    const wasEnabled = state.enabled;
    if (!enterPlanMode(ctx)) return;
    if (!wasEnabled) {
      ctx.ui.notify("Plan mode enabled. I will explore and plan, but not modify files.", "info");
    } else {
      recordPlanDecline();
    }
    if (sendPlanModeUserMessage(prompt, ctx)) return;
    if (wasEnabled) return;
    rollbackNewActivation(previousState, ctx, previousOwner);
  }

  function exitPlanMode(ctx: ExtensionContext) {
    if (!allowModeTransition(ctx, "leave or clear Plan mode")) return false;
    const wasEnabled = state.enabled;
    if ((wasEnabled || modeContractsRelevant) && !publishModeContract("normal", ctx)) {
      return false;
    }
    advanceWorkflowGeneration();
    readyPresentationIntent = undefined;
    workflowAllowedToolNames = undefined;
    state = {
      ...state,
      enabled: false,
      latestPlan: undefined,
      latestPlanSource: undefined,
      awaitingAction: false,
      ...DECLINE_RESET,
      savedPlan: undefined,
      activeImplementation: undefined,
      pendingImplementationRuntime: undefined,
      workflowToolPolicy: undefined,
      manualThinkingLevel: undefined,
    };
    if (wasEnabled) {
      restorePlanRuntime(ctx);
      state = { ...state, manualThinkingLevel: undefined };
    }
    persistState();
    updateUi(ctx);
    if (wasEnabled) releaseWorkflowOwner();
    return true;
  }

  function restoreModeContractTracking(branch: unknown[], restoredState: PlanModeState) {
    publishedContractMode = latestModeContract(branch)?.mode;
    modeContractsRelevant =
      hasModeContractArtifact(branch) ||
      restoredState.enabled ||
      restoredState.savedPlan !== undefined ||
      restoredState.activeImplementation !== undefined ||
      restoredState.pendingImplementationRuntime !== undefined;
  }

  function publishModeContract(mode: PlanModeContract, ctx: ExtensionContext) {
    if (publishedContractMode === mode) return true;
    const { role: _role, timestamp: _timestamp, ...message } = createModeContractMessage(mode);
    try {
      pi.sendMessage(message, { triggerTurn: false });
      publishedContractMode = mode;
      modeContractsRelevant = true;
      return true;
    } catch (error: unknown) {
      const detail = errorText(error);
      const notification = `Unable to publish the ${mode === "plan" ? "Plan" : "Normal"} mode contract: ${detail}`;
      if (!ctx.hasUI) throw new Error(notification, { cause: error });
      ctx.ui.notify(notification, "error");
      return false;
    }
  }

  function sendPlanModeUserMessage(message: string, ctx: ExtensionContext) {
    try {
      if (ctx.isIdle()) pi.sendUserMessage(message);
      else pi.sendUserMessage(message, { deliverAs: "followUp" });
      headlessTurns.messageSent();
      return true;
    } catch (error: unknown) {
      const detail = errorText(error);
      ctx.ui.notify(`Unable to send Plan-mode message: ${detail}`, "error");
      return false;
    }
  }

  function acceptCompletedPlan(plan: string, source: PlanCompletionSource, ctx: ExtensionContext) {
    const normalized = normalizePlanModeCompletion({ plan });
    if (!normalized.ok) {
      ctx.ui.notify(`Proposed plan is not ready: ${normalized.error}.`, "warning");
      persistState();
      updateUi(ctx);
      return;
    }
    finalizationRequest.satisfy();
    if (
      state.enabled &&
      state.awaitingAction &&
      state.latestPlan === normalized.plan &&
      state.latestPlanSource === source
    ) {
      return;
    }
    state = {
      ...state,
      latestPlan: normalized.plan,
      latestPlanSource: source,
      awaitingAction: true,
      reproposalReview: undefined,
      planDeclined: false,
    };
    readyPresentationIntent = {
      nonce: ++nextReadyPresentationNonce,
      plan: normalized.plan,
      source,
    };
    persistState();
    updateUi(ctx);
  }

  function completedPlanIsCurrent(intent: ReadyPresentationIntent) {
    return (
      state.enabled &&
      workflowMutex.isOwner(workflowOwner) &&
      state.awaitingAction &&
      state.latestPlan === intent.plan &&
      state.latestPlanSource === intent.source
    );
  }

  /** Keyed by nonce: an edit replaces the presented plan without retiring its presentation. */
  function readyPresentationIsCurrent(intent: ReadyPresentationIntent) {
    const current = readyPresentationIntent;
    return current?.nonce === intent.nonce && completedPlanIsCurrent(current);
  }

  /**
   * Core defers `sendMessage` during a run while `persistState` writes at once, so the edit
   * message could land after a newer plan the run proposes. Edits apply only when idle.
   */
  function planEditBlockedByRun(ctx: ExtensionContext) {
    if (ctx.isIdle() && !ctx.hasPendingMessages()) return false;
    ctx.ui.notify(
      "Cannot edit the plan while an agent run is active. Wait for the run to settle, then retry.",
      "warning",
    );
    return true;
  }

  /**
   * Replaces the ready or saved plan with the user's editor text. Editing is not a decline:
   * the decline counters and re-proposal gate stay as they were.
   */
  async function editPlan(ctx: ExtensionContext, isCurrent: () => boolean) {
    const enabled = state.enabled;
    const savedPlan = enabled ? undefined : state.savedPlan;
    const before = enabled ? state.latestPlan : savedPlan?.plan;
    if (!before || planEditBlockedByRun(ctx)) return;
    // A tree move or session switch while the editor is open must not carry the draft across.
    const generation = menuGeneration;
    const kept = unappliedPlanEdit;
    const restored =
      kept?.before === before && kept.enabled === enabled && kept.sessionGeneration === generation
        ? kept.text
        : undefined;
    unappliedPlanEdit = undefined;
    const edited = await ctx.ui.editor(enabled ? "Edit proposed plan" : "Edit saved plan", restored ?? before);
    const review = reviewEditedPlan(before, edited);
    if (review.kind === "unchanged") return;
    if (review.kind === "cancelled") {
      // Closing the editor keeps a restored draft for the next edit of the same plan.
      if (restored !== undefined) unappliedPlanEdit = kept;
      return;
    }
    const keepEdit = (reason: string, level: "warning" | "error" = "warning") => {
      if (generation !== menuGeneration) {
        ctx.ui.notify(`${reason} The edit was not applied.`, level);
        return;
      }
      unappliedPlanEdit = { before, enabled, sessionGeneration: generation, text: edited as string };
      ctx.ui.notify(`${reason} The edit was not applied; Edit plan… reopens it while this plan is current.`, level);
    };
    // A run that started while the editor was open would defer the edit message past newer output.
    if (!ctx.isIdle() || ctx.hasPendingMessages()) {
      keepEdit("An agent run started while the editor was open.");
      return;
    }
    const unchangedWhileEditing =
      isCurrent() &&
      state.enabled === enabled &&
      (enabled ? state.latestPlan === before : state.savedPlan === savedPlan);
    if (!unchangedWhileEditing) {
      keepEdit("The plan changed while the editor was open.");
      return;
    }
    if (review.kind === "rejected") {
      keepEdit(`Edited plan rejected: ${review.error}.`);
      return;
    }
    try {
      // Before the state entry, so a tree move to this point still restores the earlier plan.
      pi.sendMessage(createPlanEditMessage(before, review.plan), { triggerTurn: false });
    } catch (error: unknown) {
      const detail = errorText(error);
      keepEdit(`Unable to record the plan edit: ${detail}.`, "error");
      return;
    }
    if (enabled) {
      const presentation =
        readyPresentationIntent && completedPlanIsCurrent(readyPresentationIntent)
          ? readyPresentationIntent
          : undefined;
      state = { ...state, latestPlan: review.plan, latestPlanSource: PLAN_EDIT_SOURCE };
      if (presentation) readyPresentationIntent = { ...presentation, plan: review.plan, source: PLAN_EDIT_SOURCE };
    } else {
      state = { ...state, savedPlan: { plan: review.plan, source: PLAN_EDIT_SOURCE } };
    }
    persistState();
    updateUi(ctx);
    ctx.ui.notify("Plan updated.", "info");
  }

  function togglePlanMode(ctx: ExtensionContext) {
    if (state.enabled) {
      const notification = planModeDisableNotification();
      if (exitPlanMode(ctx)) ctx.ui.notify(notification, "info");
      return;
    }
    if (savedPlanBlocksNewWorkflow(ctx, state.savedPlan !== undefined)) return;
    if (enterPlanMode(ctx)) {
      ctx.ui.notify("Plan mode enabled. I will explore and plan, but not modify files.", "info");
    }
  }

  function planModeDisableNotification() {
    return state.activeImplementation
      ? "Active implementation plan cleared."
      : state.savedPlan
        ? "Saved plan cleared."
        : state.latestPlan
          ? "Plan mode disabled. Proposed plan discarded."
          : "Plan mode disabled.";
  }

  function requestFinalPlan(ctx: ExtensionContext) {
    if (!state.enabled) {
      ctx.ui.notify("Plan mode is not active. Use /plan first.", "warning");
      return;
    }
    finalizationRequest.request(workflowGeneration);
    confirmReproposal();
    if (!sendPlanModeUserMessage(FINALIZE_PLAN_PROMPT, ctx)) finalizationRequest.reset();
  }

  /** Counts the ready plan as declined (once per proposal) and closes the completion gate. */
  function recordPlanDecline() {
    if (!state.enabled || !state.awaitingAction || !state.latestPlan) return;
    if (state.planDeclined) {
      if (state.reproposalReview === "required") return;
      state = { ...state, reproposalReview: "required" };
    } else {
      state = {
        ...state,
        declinedPlans: state.declinedPlans + 1,
        reproposalReview: "required",
        planDeclined: true,
      };
    }
    persistState();
  }

  /** Records explicit user permission from confirmation mode or `/plan finalize`. */
  function confirmReproposal() {
    if (!state.enabled || state.reproposalReview !== "required") return;
    state = { ...state, reproposalReview: "confirmed" };
    persistState();
  }

  function savePlanForLater(ctx: ExtensionContext) {
    const plan = state.enabled ? state.latestPlan?.trim() : undefined;
    if (!plan) {
      const message = "No completed plan is available to save.";
      if (!ctx.hasUI) throw new Error(message);
      ctx.ui.notify(message, "warning");
      return;
    }
    const source = state.latestPlanSource ?? "legacy_proposed_plan";
    if (!allowModeTransition(ctx, "save the plan and leave Plan mode")) return;

    if (!publishModeContract("normal", ctx)) return;
    advanceWorkflowGeneration();
    readyPresentationIntent = undefined;
    workflowAllowedToolNames = undefined;
    state = {
      ...state,
      enabled: false,
      latestPlan: undefined,
      latestPlanSource: undefined,
      awaitingAction: false,
      ...DECLINE_RESET,
      savedPlan: { plan, source },
      activeImplementation: undefined,
      pendingImplementationRuntime: undefined,
      workflowToolPolicy: undefined,
      manualThinkingLevel: undefined,
    };
    restorePlanRuntime(ctx);
    state = { ...state, manualThinkingLevel: undefined };
    persistState();
    updateUi(ctx);
    releaseWorkflowOwner();
    ctx.ui.notify("Plan saved for later. Plan mode disabled.", "info");
  }

  async function startFreshImplementation(
    ctx: ExtensionContext,
    menuIsCurrent: () => boolean,
    runtime: ImplementationRuntimeSelection | undefined,
  ) {
    freshSourceSession = ctx.sessionManager;
    try {
      await startFreshImplementationFromState(ctx, {
        getState: () => state,
        menuIsCurrent,
        retention: configuredImplementationPlanRetention(settings),
        stateEntryType: STATE_ENTRY_TYPE,
        runtime,
      });
    } finally {
      freshSourceSession = undefined;
    }
  }

  async function startImplementation(ctx: ExtensionContext) {
    const savedPlan = state.enabled ? undefined : state.savedPlan;
    const plan = (state.enabled ? state.latestPlan : savedPlan?.plan)?.trim();
    if (!plan) {
      ctx.ui.notify("Plan mode disabled. No proposed plan is available to implement.", "warning");
      return;
    }
    if (!allowModeTransition(ctx, "start plan implementation")) return;
    if (savedPlan) {
      const sessionGeneration = menuGeneration;
      const planWorkflowGeneration = workflowGeneration;
      const isCurrent = () =>
        sessionGeneration === menuGeneration &&
        planWorkflowGeneration === workflowGeneration &&
        !menuController.signal.aborted &&
        !state.enabled &&
        state.savedPlan === savedPlan;
      // Re-check after the await: the saved plan, and so `plan`, must still be the one shown.
      if (!(await preflightSavedPlanImplementation(ctx, isCurrent)) || !isCurrent()) return;
      if (!allowModeTransition(ctx, "start plan implementation")) return;
    }
    const source = (state.enabled ? state.latestPlanSource : savedPlan?.source) ?? "legacy_proposed_plan";

    const previousState = state;
    const previousIntent = readyPresentationIntent;
    const wasEnabled = state.enabled;
    if (!publishModeContract("normal", ctx)) return;
    advanceWorkflowGeneration();
    const retention = configuredImplementationPlanRetention(settings);
    const usesConversationHistory = retention === "clear-on-start";
    readyPresentationIntent = undefined;
    workflowAllowedToolNames = undefined;
    state = {
      ...state,
      enabled: false,
      latestPlan: undefined,
      latestPlanSource: undefined,
      awaitingAction: false,
      ...DECLINE_RESET,
      savedPlan: undefined,
      pendingImplementationRuntime: undefined,
      activeImplementation: usesConversationHistory
        ? undefined
        : {
            id: randomUUID(),
            plan,
            source,
            startedAt: Date.now(),
            retention,
          },
      workflowToolPolicy: undefined,
      manualThinkingLevel: undefined,
    };
    if (wasEnabled) {
      restorePlanRuntime(ctx);
      state = { ...state, manualThinkingLevel: undefined };
    }
    // Before the state entry: callers and resume read the newest entry as Plan state.
    planApprovals.record(ctx, plan);
    persistState();
    updateUi(ctx);

    // The generic history kickoff points at the proposal in history, so an edited plan,
    // like a saved one, carries its own text.
    const handoff = usesConversationHistory
      ? wasEnabled && source !== PLAN_EDIT_SOURCE
        ? formatHistoryImplementationPrompt()
        : formatTransferredPlanPrompt(plan, false)
      : formatImplementationHandoff(plan);
    const sent = sendPlanModeUserMessage(handoff, ctx);
    if (!sent) {
      // The queued model restore may already have run, so re-apply the Plan model afresh.
      state = { ...previousState, planModelSwitch: undefined };
      readyPresentationIntent = previousIntent;
      if (wasEnabled) {
        restoreWorkflowToolPolicy(state.workflowToolPolicy);
        publishModeContract("plan", ctx);
        applyPlanThinkingLevel();
        // The queued restore resets thinking after this, so the switch re-applies Plan thinking first.
        startPlanModel(ctx, true);
      }
      persistState();
      updateUi(ctx);
      return;
    }
    if (wasEnabled) releaseWorkflowOwner();
  }

  /** Callers derive the id from `state.activeImplementation` synchronously, so it is still current. */
  function clearActiveImplementation(ctx: ExtensionContext) {
    advanceWorkflowGeneration();
    state = { ...state, activeImplementation: undefined };
    persistState();
    updateUi(ctx);
  }

  async function exportPlan(
    ctx: ExtensionContext,
    path: string | undefined,
    signal: AbortSignal,
    isCurrent: () => boolean,
  ) {
    const exitsReadyPlan = state.enabled && Boolean(state.latestPlan?.trim());
    if (exitsReadyPlan && !allowModeTransition(ctx, "export the ready plan and leave Plan mode")) {
      return false;
    }
    return planExports.export(path, ctx, signal, () => {
      return isCurrent() && (!exitsReadyPlan || ctx.isIdle());
    });
  }

  async function showLaunchMenu(ctx: ExtensionContext, initialScreen: "main" | "tools" = "main") {
    const lifecycle = captureMenuLifecycle();
    if (!lifecycle.isCurrent() || lifecycle.signal.aborted) return;
    const ui = await loadInteractiveUi();
    if (!lifecycle.isCurrent() || lifecycle.signal.aborted) return;
    const tools = selectableTools();
    const activeToolNames = new Set(safeGetActiveTools());
    const initialSelectedNames = snapshotPlanModeSelectedNames(tools, toolSelectionSnapshot());
    const retainsInactiveSelection =
      state.selectedToolNames !== undefined ||
      state.selectedToolKeys !== undefined ||
      settings.defaultPlanTools !== undefined;
    const retainedInactiveNames = retainsInactiveSelection ? initialSelectedNames : new Set<string>();
    const registeredNames = new Set(tools.map((tool) => tool.name));
    const pendingNames = Array.from(retainedInactiveNames).filter((name) => !registeredNames.has(name));
    await ui.showPlanLaunchMenu(ctx, {
      statusText: planModeHelperToolsAvailable(safeGetActiveTools())
        ? "Status: Off — visible Plan helpers stay inactive until /plan starts."
        : "Status: Off — required Plan helpers are unavailable under the active tool policy.",
      initialScreen,
      getSelectedNames: () => snapshotPlanModeSelectedNames(tools, toolSelectionSnapshot()),
      toolSummary: (selectedNames) => {
        const allowed = tools
          .filter(
            (tool) =>
              planModeToolAvailability(tool, activeToolNames) === "available" &&
              selectedNames.has(tool.name) &&
              canSelectToolInPlanMode(tool),
          )
          .map((tool) => tool.name);
        const pending = pendingNames.filter((name) => selectedNames.has(name)).map(terminalToolName);
        const visiblePending = pending.slice(0, 3);
        const pendingSuffix =
          pending.length > visiblePending.length ? `, +${pending.length - visiblePending.length} more` : "";
        return [
          `Plan policy will allow: ${allowed.length > 0 ? allowed.join(", ") : "none"}.`,
          ...(pending.length > 0 ? [`Pending registration: ${visiblePending.join(", ")}${pendingSuffix}.`] : []),
        ].join(" ");
      },
      tools: [
        ...tools.map((tool) => {
          return {
            name: tool.name,
            ...planModeToolSelection(tool, activeToolNames, retainedInactiveNames.has(tool.name)),
          };
        }),
        ...pendingNames.map((name) => {
          const label = terminalToolName(name);
          return {
            name,
            label,
            description: "pending registration · Retained and resolved before the first Plan request",
            searchText: `${label} pending registration retained first Plan request`,
            disabled: true,
            disabledReason:
              "Not registered yet; Plan mode will not activate it and will resolve it before the first request",
          };
        }),
      ],
      ...lifecycle,
      start: (signal) => {
        if (signal.aborted || !lifecycle.isCurrent()) return;
        if (enterPlanMode(ctx)) {
          ctx.ui.notify("Plan mode enabled. I will explore and plan, but not modify files.", "info");
        }
      },
      startWithTools: (names, signal) => {
        if (signal.aborted || !lifecycle.isCurrent()) return;
        const availableNames = new Set(filterAvailableSelectedToolNames(names, tools, activeToolNames));
        const selectedToolNames = Array.from(
          new Set(names.filter((name) => availableNames.has(name) || retainedInactiveNames.has(name))),
        );
        if (enterPlanMode(ctx, { selectedToolNames, selectedToolKeys: undefined })) {
          ctx.ui.notify("Plan mode enabled with the selected tools.", "info");
        }
      },
      settings: (signal) => showSettings(ctx, signal, lifecycle.isCurrent),
    });
  }

  async function showActivePlanMenu(ctx: ExtensionContext) {
    const lifecycle = captureMenuLifecycle();
    if (!lifecycle.isCurrent() || lifecycle.signal.aborted) return;
    const ui = await loadInteractiveUi();
    if (!lifecycle.isCurrent() || lifecycle.signal.aborted) return;
    await ui.showActiveImplementationMenu(ctx, {
      statusText: planStatusText(),
      getExportDestination: () => planExports.getDestination(ctx),
      signal: lifecycle.signal,
      isCurrent: lifecycle.isCurrent,
      show: () => showStoredPlan(pi, ctx, state),
      exportPlan: (path, signal) => planExports.export(path, ctx, signal, lifecycle.isCurrent),
      settings: (signal) => showSettings(ctx, signal, lifecycle.isCurrent),
      startNew: () => {
        if (enterPlanMode(ctx)) {
          ctx.ui.notify("Plan mode enabled. I will explore and plan, but not modify files.", "info");
        }
      },
      clear: () => {
        if (exitPlanMode(ctx)) ctx.ui.notify("Active implementation plan cleared.", "info");
      },
    });
  }

  async function showSettings(ctx: ExtensionContext, signal: AbortSignal, isCurrent: () => boolean) {
    if (!isCurrent() || signal.aborted) return false;
    const ui = await loadInteractiveUi();
    if (!isCurrent() || signal.aborted) return false;
    const result = await ui.showPlanModeSettings(ctx, {
      tools: selectableTools(),
      activeToolNames: safeGetActiveTools(),
      signal,
      isCurrent,
      settingsPath: dependencies.settingsPath,
      updateSettings: dependencies.updateSettings ?? updatePlanModeSettings,
      startupToggleShortcut,
      onSaved: (saved) => {
        if (!isCurrent()) return;
        settings = saved;
      },
      ...(dependencies.readSettings ? { readSettings: readPlanModeRuntimeSettings } : {}),
    });
    return result.kind === "closed" && "reason" in result && result.reason === "close";
  }

  function allowModeTransition(ctx: ExtensionContext, action: string) {
    if (ctx.isIdle()) return true;
    const message = `Cannot ${action} while an agent run is active. Wait for the run to settle, then retry.`;
    if (!ctx.hasUI) throw new Error(message);
    ctx.ui.notify(message, "warning");
    return false;
  }

  function advanceWorkflowGeneration() {
    workflowGeneration += 1;
    pendingWorkflowToolPolicy = undefined;
    finalizationRequest.reset();
  }

  function finalizationRunOutcome(messages: unknown): FinalizationRunOutcome {
    const stopReason = latestAssistantStopReason(messages);
    if (stopReason === undefined || stopReason === "stop") return "normal";
    if (stopReason === "aborted") return "cancelled";
    return "error";
  }

  function captureMenuLifecycle() {
    const sessionGeneration = menuGeneration;
    const planWorkflowGeneration = workflowGeneration;
    const owner = workflowOwner;
    const controller = menuController;
    return {
      signal: controller.signal,
      isCurrent: () =>
        sessionGeneration === menuGeneration &&
        planWorkflowGeneration === workflowGeneration &&
        !controller.signal.aborted &&
        (!state.enabled || workflowMutex.isOwner(owner)),
    };
  }

  function planModePolicyToolNames() {
    // Only enabled tool admission and status branches call this, synchronously.
    return workflowAllowedToolNames ?? [];
  }

  function workflowDesiredToolNames(policy: PlanModeWorkflowToolPolicy) {
    return new Set(policy.kind === "automatic" ? automaticPlanModeToolNames() : policy.desiredNames);
  }

  /** A policy from the current selection; explicit when the user or settings chose the tools. */
  function selectedWorkflowToolPolicy(resolved: boolean): PlanModeWorkflowToolPolicy {
    const desiredNames = desiredPlanModeToolNames();
    const allowedNames = resolvePlanModePolicyToolNames(desiredNames);
    return toolPolicySelectionIsExplicit()
      ? { kind: "explicit", desiredNames, allowedNames, resolved }
      : { kind: "automatic", allowedNames, resolved };
  }

  function beginWorkflowToolPolicy() {
    const policy = selectedWorkflowToolPolicy(false);
    state = { ...state, workflowToolPolicy: policy };
    pendingWorkflowToolPolicy = { generation: workflowGeneration, mode: "resolve" };
    workflowAllowedToolNames = policy.allowedNames;
  }

  function resolvePendingWorkflowToolPolicy(ctx: ExtensionContext) {
    const pending = pendingWorkflowToolPolicy;
    if (!pending) return;
    if (pending.generation !== workflowGeneration || !state.enabled || !workflowMutex.isOwner(workflowOwner)) {
      pendingWorkflowToolPolicy = undefined;
      return;
    }
    const policy = state.workflowToolPolicy;
    const expectedResolved = pending.mode === "revalidate";
    if (!policy || policy.resolved !== expectedResolved) {
      pendingWorkflowToolPolicy = undefined;
      return;
    }
    const allowedNames =
      pending.mode === "resolve" ? resolveWorkflowToolPolicy(policy) : revalidateFrozenWorkflowToolPolicy(policy);
    const policyChanged = !policy.resolved || !arrayEquals(policy.allowedNames, allowedNames);
    workflowAllowedToolNames = allowedNames;
    state = {
      ...state,
      workflowToolPolicy: { ...policy, allowedNames, resolved: true },
    };
    pendingWorkflowToolPolicy = undefined;
    if (policyChanged) persistState();
    updateUi(ctx);
  }

  function toolPolicySelectionIsExplicit() {
    return (
      state.selectedToolNames !== undefined ||
      state.selectedToolKeys !== undefined ||
      settings.defaultPlanTools !== undefined
    );
  }

  function desiredPlanModeToolNames() {
    const tools = availablePlanPolicyTools();
    return Array.from(snapshotPlanModeSelectedNames(tools, toolSelectionSnapshot()));
  }

  function automaticPlanModeToolNames() {
    return Array.from(snapshotPlanModeSelectedNames(availablePlanPolicyTools(), {}));
  }

  function resolveWorkflowToolPolicy(policy: PlanModeWorkflowToolPolicy) {
    return resolvePlanModePolicyToolNames(
      policy.kind === "automatic" ? automaticPlanModeToolNames() : policy.desiredNames,
    );
  }

  function revalidateFrozenWorkflowToolPolicy(policy: PlanModeWorkflowToolPolicy) {
    const currentlyAllowed = new Set(
      policy.kind === "automatic"
        ? resolvePlanModePolicyToolNames(automaticPlanModeToolNames())
        : resolvePlanModePolicyToolNames(policy.allowedNames),
    );
    return policy.allowedNames.filter((name) => currentlyAllowed.has(name));
  }

  function restoreWorkflowToolPolicy(policy: PlanModeWorkflowToolPolicy | undefined) {
    let nextPolicy: PlanModeWorkflowToolPolicy;
    if (!policy) {
      nextPolicy = selectedWorkflowToolPolicy(true);
    } else if (policy.resolved) {
      nextPolicy = policy;
    } else {
      nextPolicy = {
        ...policy,
        allowedNames: resolveWorkflowToolPolicy(policy),
      };
    }
    state = { ...state, workflowToolPolicy: nextPolicy };
    workflowAllowedToolNames = nextPolicy.resolved
      ? revalidateFrozenWorkflowToolPolicy(nextPolicy)
      : nextPolicy.allowedNames;
    pendingWorkflowToolPolicy = {
      generation: workflowGeneration,
      mode: nextPolicy.resolved ? "revalidate" : "resolve",
    };
    return !workflowToolPoliciesEqual(policy, nextPolicy);
  }

  function workflowToolPoliciesEqual(left: PlanModeWorkflowToolPolicy | undefined, right: PlanModeWorkflowToolPolicy) {
    return (
      left?.kind === right.kind &&
      left.resolved === right.resolved &&
      arrayEquals(left.allowedNames, right.allowedNames) &&
      arrayEquals(left.desiredNames ?? [], right.desiredNames ?? [])
    );
  }

  function arrayEquals(left: readonly string[], right: readonly string[]) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
  }

  function resolvePlanModePolicyToolNames(desiredNames: readonly string[]) {
    const selectedNames = new Set(desiredNames);
    return availablePlanPolicyTools()
      .filter((tool) => selectedNames.has(tool.name) && canSelectToolInPlanMode(tool))
      .map((tool) => tool.name);
  }

  function toolSelectionSnapshot() {
    return {
      selectedToolNames: state.selectedToolNames,
      selectedToolKeys: state.selectedToolKeys,
      defaultPlanTools: settings.defaultPlanTools,
    };
  }

  function selectableTools() {
    return safeGetAllTools()
      .filter((tool) => tool.name !== PLAN_MODE_QUESTION_TOOL_NAME && tool.name !== PLAN_MODE_COMPLETE_TOOL_NAME)
      .sort(compareTools);
  }

  function availablePlanPolicyTools() {
    const activeNames = new Set(safeGetActiveTools());
    return selectableTools().filter((tool) => planModeToolAvailability(tool, activeNames) === "available");
  }

  function safeGetAllTools() {
    try {
      return pi.getAllTools();
    } catch {
      return [];
    }
  }

  function runtimeAdmissionIsPending(sessionManager: ExtensionContext["sessionManager"]) {
    return (
      activeImplementationRuntimeApplication?.sessionManager === sessionManager ||
      pendingRuntimeAdmissionSession === sessionManager ||
      queuedRuntimeAdmissionInputs.some((queued) => queued.sessionManager === sessionManager)
    );
  }

  function takeQueuedRuntimeAdmissionInputs(sessionManager: ExtensionContext["sessionManager"]) {
    const matching: QueuedRuntimeAdmissionInput[] = [];
    const remaining: QueuedRuntimeAdmissionInput[] = [];
    for (const queued of queuedRuntimeAdmissionInputs) {
      if (queued.sessionManager === sessionManager) matching.push(queued);
      else remaining.push(queued);
    }
    queuedRuntimeAdmissionInputs = remaining;
    return matching;
  }

  function recoverRuntimeAdmissionInput(queued: QueuedRuntimeAdmissionInput) {
    pi.sendMessage(
      {
        customType: RECOVERED_RUNTIME_ADMISSION_INPUT_MESSAGE_TYPE,
        content: runtimeAdmissionInputContent(queued),
        display: true,
        details: { source: queued.source },
      },
      { triggerTurn: false },
    );
  }

  function removeQueuedRuntimeAdmissionInput(queuedInput: QueuedRuntimeAdmissionInput) {
    const index = queuedRuntimeAdmissionInputs.indexOf(queuedInput);
    if (index >= 0) queuedRuntimeAdmissionInputs.splice(index, 1);
  }

  function runtimeAdmissionInputContent(queued: QueuedRuntimeAdmissionInput) {
    return queued.images?.length ? [{ type: "text" as const, text: queued.text }, ...queued.images] : queued.text;
  }

  function refreshStateForFirstPrompt(ctx: ExtensionContext) {
    if (!refreshStateBeforeFirstAgentStart) return;
    refreshStateBeforeFirstAgentStart = false;
    implementationRetention.reset();
    const branch = ctx.sessionManager.getBranch();
    const restoredState = restorePlanModeState(branch, STATE_ENTRY_TYPE);
    restoreModeContractTracking(branch, restoredState);
    if (!installRestoredState(restoredState, ctx)) return;
    implementationRetention.restore(state.activeImplementation);
    updateUi(ctx);
  }

  async function applyPendingImplementationRuntime(
    ctx: ExtensionContext,
    holdForAdmission = false,
  ): Promise<ImplementationRuntimeApplicationResult> {
    const session = ctx.sessionManager;
    const activeApplication = activeImplementationRuntimeApplication;
    if (activeApplication?.sessionManager === session) {
      if (holdForAdmission) activeApplication.holdForAdmission = true;
      return activeApplication.completion;
    }

    const intent = state.enabled ? undefined : state.pendingImplementationRuntime;
    if (!intent) return "ready";
    const generation = menuGeneration;
    const isCurrent = () =>
      currentSession === session && generation === menuGeneration && !menuController.signal.aborted;
    const notifyCurrent = (message: string) => {
      if (!isCurrent()) return;
      try {
        ctx.ui.notify(message, "warning");
      } catch {
        // The session can become stale while an asynchronous runtime application settles.
      }
    };
    let application!: ActiveImplementationRuntimeApplication;
    const completion = Promise.resolve()
      .then(async (): Promise<ImplementationRuntimeApplicationResult> => {
        if (!isCurrent()) return "stale";
        const pendingState = state;
        const previousThinkingLevel = pi.getThinkingLevel();

        const applyThinking = () => {
          if (!intent.thinkingLevel) return;
          try {
            pi.setThinkingLevel(intent.thinkingLevel);
            const effectiveLevel = pi.getThinkingLevel();
            if (effectiveLevel !== intent.thinkingLevel) {
              notifyCurrent(
                `Implementation thinking ${intent.thinkingLevel} is unsupported by the destination model; Pi is using ${effectiveLevel}.`,
              );
            }
          } catch (error: unknown) {
            notifyCurrent(
              `Implementation thinking ${intent.thinkingLevel} could not be applied: ${errorText(error)}. The destination default will continue.`,
            );
          }
        };

        if (intent.model) {
          const resolved = await resolveAuthenticatedModel(ctx, intent.model);
          if (!isCurrent()) return "stale";
          if ("failure" in resolved) {
            notifyCurrent(
              `Implementation model ${terminalModelReference(intent.model)} ${resolved.failure}. The destination default model will continue.`,
            );
          } else {
            const model = resolved.model;
            let applied = false;
            let applicationFailed = false;
            application.drainOnShutdown = true;
            try {
              try {
                applied = await pi.setModel(model);
              } catch (error: unknown) {
                applicationFailed = true;
                notifyCurrent(
                  `Implementation model ${terminalModelReference(intent.model)} could not be applied: ${errorText(error)}. The destination default model will continue.`,
                );
              }
            } finally {
              application.drainOnShutdown = false;
            }
            if (!isCurrent()) return "stale";
            if (!applied && !applicationFailed) {
              notifyCurrent(
                `Implementation model ${terminalModelReference(intent.model)} could not be applied after authentication changed. The destination default model will continue.`,
              );
            }
          }
        }
        // Every path to here checked `isCurrent()` with no await since.
        applyThinking();
        if (!isCurrent()) return "stale";

        state = { ...state, pendingImplementationRuntime: undefined };
        try {
          persistState();
        } catch (error: unknown) {
          state = pendingState;
          try {
            if (pi.getThinkingLevel() !== previousThinkingLevel) {
              pi.setThinkingLevel(previousThinkingLevel);
            }
          } catch {
            // Keep the durable intent pending even if a runtime rollback is unavailable.
          }
          try {
            persistState();
          } catch {
            // SessionManager mutates its in-memory branch before a disk append can fail.
            // A best-effort rollback entry keeps that branch aligned with durable pending state.
          }
          notifyCurrent(
            `Unable to apply fresh implementation settings because their one-shot state could not be consumed: ${errorText(error)}. The implementation request was not sent; retry after session persistence is available.`,
          );
          return "blocked";
        }
        if (application.holdForAdmission) pendingRuntimeAdmissionSession = session;
        return "ready";
      })
      .finally(() => {
        if (activeImplementationRuntimeApplication === application) {
          activeImplementationRuntimeApplication = undefined;
        }
      });
    application = {
      sessionManager: session,
      completion,
      drainOnShutdown: false,
      holdForAdmission,
    };
    activeImplementationRuntimeApplication = application;
    return completion;
  }

  function applyPlanThinkingLevel() {
    if (state.manualThinkingLevel) {
      if (pi.getThinkingLevel() !== state.manualThinkingLevel) {
        pi.setThinkingLevel(state.manualThinkingLevel);
      }
      return;
    }
    const configured = configuredThinkingLevel(settings);
    if (!configured) {
      state = {
        ...state,
        previousThinkingLevel: undefined,
        appliedThinkingLevel: undefined,
      };
      return;
    }
    const current = pi.getThinkingLevel();
    if (!state.appliedThinkingLevel) state.previousThinkingLevel = current;
    if (current !== configured) pi.setThinkingLevel(configured);
    state.appliedThinkingLevel = pi.getThinkingLevel();
  }

  function captureManualThinkingLevel() {
    if (!state.appliedThinkingLevel) return;
    const current = pi.getThinkingLevel();
    if (current === state.appliedThinkingLevel) return;
    state = {
      ...state,
      manualThinkingLevel: current,
      previousThinkingLevel: undefined,
      appliedThinkingLevel: undefined,
    };
  }

  function restoreThinkingLevel() {
    captureManualThinkingLevel();
    const { appliedThinkingLevel, previousThinkingLevel } = state;
    if (appliedThinkingLevel && previousThinkingLevel && pi.getThinkingLevel() === appliedThinkingLevel) {
      pi.setThinkingLevel(previousThinkingLevel);
    }
    state = { ...state, appliedThinkingLevel: undefined, previousThinkingLevel: undefined };
  }

  function queuePlanModelTransition(transition: () => Promise<void>) {
    planModelTransition = planModelTransition.then(transition);
  }

  /**
   * Queue the configured Plan model switch; Plan still starts on the current model if it fails.
   * `reapplyThinking` re-applies Plan thinking first, after a queued restore reset it.
   */
  function startPlanModel(ctx: ExtensionContext, reapplyThinking = false) {
    const epoch = ++planModelEpoch;
    if (reapplyThinking) {
      queuePlanModelTransition(async () => {
        if (epoch !== planModelEpoch || !state.enabled) return;
        applyPlanThinkingLevel();
        persistState();
      });
    }
    const tier = settings.planModel;
    if (tier) queuePlanModelTransition(() => applyPlanModel(ctx, tier, epoch));
  }

  /**
   * A source resumed after Start fresh plans on the Plan model again. Only that hand-off sets the
   * marker, so `/reload` with a persisted switch and a manual `/model` during Plan are left alone.
   */
  function resumePlanModel(ctx: ExtensionContext) {
    if (!state.resumePlanModel) return;
    state = { ...state, resumePlanModel: undefined };
    persistState();
    startPlanModel(ctx);
  }

  async function applyPlanModel(ctx: ExtensionContext, tier: PlanModelTier, epoch: number) {
    const target = planModelTarget(tier);
    const previous = ctx.model;
    const isCurrent = () => epoch === planModelEpoch && state.enabled;
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
    state = {
      ...state,
      ...(state.appliedThinkingLevel ? { appliedThinkingLevel: modelSwitch.thinkingAfter } : {}),
      planModelSwitch: modelSwitch,
    };
    persistState();
  }

  /** Restore thinking and, unless `/model` replaced it during Plan, the model a Plan start switched from. */
  function restorePlanRuntime(ctx: ExtensionContext) {
    planModelEpoch += 1;
    const modelSwitch = state.planModelSwitch;
    state = { ...state, planModelSwitch: undefined };
    if (!modelSwitch || !sameModel(ctx.model, modelSwitch.applied)) {
      restoreThinkingLevel();
      return;
    }
    captureManualThinkingLevel();
    const current = pi.getThinkingLevel();
    // Pi re-selects a per-model thinking default on switch; pin the level Plan would restore without one.
    const thinking =
      state.previousThinkingLevel ?? (current === modelSwitch.thinkingAfter ? modelSwitch.thinkingBefore : current);
    state = { ...state, appliedThinkingLevel: undefined, previousThinkingLevel: undefined };
    queuePlanModelTransition(() => restorePlanModel(ctx, modelSwitch, thinking));
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
  async function switchModel(model: Parameters<ExtensionAPI["setModel"]>[0], thinking: PlanModeFixedThinkingLevel) {
    switchingPlanModel = true;
    try {
      if (!(await pi.setModel(model))) return false;
      if (pi.getThinkingLevel() !== thinking) pi.setThinkingLevel(thinking);
      return true;
    } finally {
      switchingPlanModel = false;
    }
  }

  /**
   * Find and authenticate `reference` for the Plan and implementation model switches.
   * A failure reads after the model's name, e.g. "is no longer available".
   */
  async function resolveAuthenticatedModel(
    ctx: ExtensionContext,
    reference: ImplementationModelOverride,
  ): Promise<{ model: Parameters<ExtensionAPI["setModel"]>[0] } | { failure: string }> {
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

  function errorText(error: unknown) {
    return safeTerminalText(error instanceof Error ? error.message : String(error));
  }

  function sameModel(model: { provider: string; id: string } | undefined, reference: ImplementationModelOverride) {
    return model?.provider === reference.provider && model.id === reference.modelId;
  }

  /** Like opusplan, Start fresh's "same as plan" implements on the model Plan started from, not on the tier. */
  function getFreshPlanModel(ctx: ExtensionContext): FreshPlanModel {
    const modelSwitch = state.enabled ? state.planModelSwitch : undefined;
    if (modelSwitch && sameModel(ctx.model, modelSwitch.applied)) {
      return { model: { ...modelSwitch.previous }, label: "previous model" };
    }
    return {
      model: ctx.model ? { provider: ctx.model.provider, modelId: ctx.model.id } : undefined,
      label: "same as plan",
    };
  }

  function safeGetActiveTools() {
    try {
      return pi.getActiveTools();
    } catch {
      return DEFAULT_TOOLS;
    }
  }

  function installRestoredState(candidate: PlanModeState, ctx: ExtensionContext) {
    const previousState = state;
    const previousWorkflowAllowedToolNames = workflowAllowedToolNames;
    const previousPendingWorkflowToolPolicy = pendingWorkflowToolPolicy;
    const previousOwner = workflowOwner;
    const wasEnabled = state.enabled;
    if (candidate.enabled && !workflowMutex.isOwner(workflowOwner)) {
      const owner = workflowMutex.acquire();
      if (!owner) {
        state = { enabled: false, awaitingAction: false, declinedPlans: 0 };
        workflowAllowedToolNames = undefined;
        pendingWorkflowToolPolicy = undefined;
        reportRestoredWorkflowBusy(ctx);
        return false;
      }
      workflowOwner = owner;
    }

    try {
      if (candidate.enabled) {
        try {
          assertPlanModeHelperToolsAvailable(safeGetActiveTools());
        } catch {
          if (wasEnabled) restorePlanRuntime(ctx);
          state = { enabled: false, awaitingAction: false, declinedPlans: 0 };
          workflowAllowedToolNames = undefined;
          pendingWorkflowToolPolicy = undefined;
          releaseWorkflowOwner();
          updateUi(ctx);
          reportRestoredHelpersUnavailable(ctx);
          return false;
        }
      }
      if (wasEnabled && !candidate.enabled) {
        readyPresentationIntent = undefined;
        restorePlanRuntime(ctx);
      }
      state = candidate;
      const policyChanged = state.enabled ? restoreWorkflowToolPolicy(state.workflowToolPolicy) : false;
      if (!state.enabled) {
        workflowAllowedToolNames = undefined;
        pendingWorkflowToolPolicy = undefined;
      }
      if (policyChanged) persistState();
      if (state.enabled) {
        applyPlanThinkingLevel();
        resumePlanModel(ctx);
      } else if (wasEnabled) releaseWorkflowOwner();
      return true;
    } catch (error: unknown) {
      try {
        if (!wasEnabled && state.enabled) restoreThinkingLevel();
      } finally {
        state = previousState;
        workflowAllowedToolNames = previousWorkflowAllowedToolNames;
        pendingWorkflowToolPolicy = previousPendingWorkflowToolPolicy;
        if (workflowOwner !== previousOwner) {
          workflowMutex.release(workflowOwner);
          workflowOwner = previousOwner;
        }
      }
      throw error;
    }
  }

  /**
   * Undo an activation that has already enabled Plan and acquired a fresh owner; both callers
   * only reach this after `enterPlanMode` set `state.enabled`, and a fresh owner never equals a
   * previously captured one.
   */
  function rollbackNewActivation(
    previousState: PlanModeState,
    ctx: ExtensionContext,
    previousOwner?: WorkflowMutexOwner,
  ) {
    const activatedOwner = workflowOwner;
    readyPresentationIntent = undefined;
    try {
      publishModeContract("normal", ctx);
      restorePlanRuntime(ctx);
    } finally {
      state = previousState;
      workflowAllowedToolNames = undefined;
      pendingWorkflowToolPolicy = undefined;
      try {
        persistState();
        updateUi(ctx);
      } finally {
        workflowMutex.release(activatedOwner);
        workflowOwner = previousOwner;
      }
    }
  }

  function bindWorkflowSessionIfNeeded(ctx: ExtensionContext) {
    if (currentSession === ctx.sessionManager) return;
    currentSession = ctx.sessionManager;
    workflowOwner = undefined;
    workflowMutex.bindSession(ctx.sessionManager);
  }

  function releaseWorkflowOwner() {
    // A no-op release means another binding already dropped this owner; either way it is gone.
    workflowMutex.release(workflowOwner);
    workflowOwner = undefined;
  }

  function reportWorkflowBusy(ctx: ExtensionContext) {
    const message = "Another workflow is active in this session. End it before starting Plan mode.";
    if (!ctx.hasUI) throw new Error(message);
    ctx.ui.notify(message, "warning");
    return false;
  }

  function reportRestoredWorkflowBusy(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    ctx.ui.notify(
      "Plan mode was not restored because another workflow is active in this session. Reload or start Plan mode after it ends.",
      "warning",
    );
  }

  function reportRestoredHelpersUnavailable(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    ctx.ui.notify(
      "Plan mode was not restored because its helper tools are unavailable under the active tool policy.",
      "warning",
    );
  }

  function reportHelperActivationFailure(ctx: ExtensionContext, error: unknown) {
    const detail = errorText(error);
    const message = `Cannot start Plan mode: ${detail}.`;
    if (!ctx.hasUI) throw new Error(message, { cause: error });
    ctx.ui.notify(message, "error");
    return false;
  }

  function updateUi(ctx: ExtensionContext) {
    updatePlanModeUi(ctx, state, formatToolSummary);
  }

  function clearUi(ctx: ExtensionContext) {
    clearPlanModeUi(ctx);
  }

  function planStatusText() {
    return formatPlanModeStatusText(state, formatToolSummary);
  }

  function implementationOutcome() {
    return implementationRetentionPreview(configuredImplementationPlanRetention(settings));
  }

  function formatToolSummary() {
    const names = planModePolicyToolNames();
    return `Plan policy allows: ${names.length > 0 ? names.join(", ") : "none"}. Model-visible tools stay unchanged.`;
  }

  function toolByName(toolName: string) {
    return safeGetAllTools().find((candidate) => candidate.name === toolName);
  }

  function terminalToolName(value: string) {
    const safe = safeTerminalText(value) || "(unnamed tool)";
    return safe.length > 120 ? `${safe.slice(0, 119)}…` : safe;
  }

  function terminalModelReference(model: { provider: string; modelId: string }) {
    // The separator keeps this non-empty even when both identifiers sanitize away.
    const safe = safeTerminalText(`${model.provider}/${model.modelId}`);
    return safe.length > 160 ? `${safe.slice(0, 159)}…` : safe;
  }

  function safeTerminalText(value: string) {
    return [...stripVTControlCharacters(value)]
      .map((character) => {
        // Every range below is in the BMP, so the first UTF-16 unit decides.
        const codePoint = character.charCodeAt(0);
        return codePoint <= 0x1f ||
          (codePoint >= 0x7f && codePoint <= 0x9f) ||
          (codePoint >= 0x202a && codePoint <= 0x202e) ||
          (codePoint >= 0x2066 && codePoint <= 0x2069)
          ? " "
          : character;
      })
      .join("")
      .trim();
  }
}

export { completePlanArguments } from "./command.js";
export {
  extractProposedPlan,
  latestAssistantText,
  parseProposedPlan,
  stripProposedPlanBlocks,
  stripProposedPlanBlocksFromMessage,
} from "./message-transform.js";
export {
  createModeContractMessage,
  modeContractContent,
  reconcileModeContract,
} from "./mode-contract.js";
export { buildPlanModePrompt } from "./prompt.js";
export { normalizePlanModeQuestionParams } from "./question-tool.js";
export { withRequiredPlanModeTools } from "./required-tools.js";
export { normalizePlanModeSettings, readPlanModeSettings } from "./settings.js";
export {
  canSelectToolInPlanMode,
  classifyPlanModeTool,
  findBlockedSshExecCall,
  isAnnotatedReadOnlyTool,
  isSafeCommand,
} from "./tool-policy.js";
