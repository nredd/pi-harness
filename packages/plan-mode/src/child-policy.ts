import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { PlanModeSettings } from "./settings.js";
import {
  classifyPlanModeTool,
  explainBlockedCommand,
  findBlockedPowerShellCommandSegment,
  findBlockedSshExecCall,
  readCommand,
  type ShellPolicyOptions,
  SSH_EXEC_TOOL_NAME,
} from "./tool-policy.js";

/**
 * Channel a subagent host asks on, right before it runs a child, whether that child must plan too.
 * The host emits a {@link PlanModeStateQuery}; Plan mode answers synchronously through `reply`
 * with its live state. Nothing answering means Plan mode is not installed. The payload is a
 * versioned contract so the host never imports this package.
 */
export const PLAN_MODE_STATE_QUERY = "pi-plan-mode:state-query";
export const PLAN_MODE_STATE_VERSION = 1;

/**
 * Channel Plan mode asks on, at session start and before each subagent tool call, whether a
 * compatible subagent gate is installed. A gate answers `reply({ version: 1, gate })` and in doing
 * so learns that Plan mode is present, so it can refuse a child when a later state query goes
 * unanswered. Without an answer, Plan refuses {@link SUBAGENT_SPAWN_TOOLS}.
 */
export const PLAN_MODE_GATE_QUERY = "pi-plan-mode:gate-query";

/** `@nredd/pi-subagents` tools that start or resume a child; refused in Plan without a gate. */
export const SUBAGENT_SPAWN_TOOLS: ReadonlySet<string> = new Set(["Agent", "SubagentWorkflow", "steer_subagent"]);

/** Built-in tools Plan mode never runs, in the planner or in a child it started. */
export const BLOCKED_MUTATING_TOOLS: ReadonlySet<string> = new Set(["edit", "write", "update_plan"]);

/** One tool call inside a child session, with the child's own metadata for the tool. */
export interface PlanModeChildToolCall {
  toolName: string;
  input: unknown;
  /** The child's working directory, for relative `cd`/`git -C` targets. */
  cwd: string;
  /** The child's registry entry; absent fails closed. */
  tool: ToolInfo | undefined;
}

/** Returns why Plan mode refuses a child's tool call, or `undefined` when it may run. */
export type PlanModeChildToolPolicy = (call: PlanModeChildToolCall) => string | undefined;

export interface PlanModeStateSnapshot {
  version: typeof PLAN_MODE_STATE_VERSION;
  active: boolean;
  sessionId: string | undefined;
  /** Set iff `active`. Frozen at the answer, so a child keeps it after the planner leaves Plan. */
  evaluate?: PlanModeChildToolPolicy;
}

export interface PlanModeStateQuery {
  version: typeof PLAN_MODE_STATE_VERSION;
  reply: (state: PlanModeStateSnapshot) => void;
}

type ShellSettings = Pick<PlanModeSettings, "safeSubcommands" | "trustedDirectories">;

/**
 * The reviewed shell checks shared by the planner's gate and its children: limited `bash`,
 * limited `powershell` and `ssh_exec`, matched by name so an extension override stays limited.
 */
export function blockedShellCallReason(
  toolName: string,
  input: unknown,
  settings: ShellSettings,
  options: ShellPolicyOptions,
): string | undefined {
  const shellOptions = { ...options, trustedDirectories: settings.trustedDirectories };
  if (toolName === "bash") {
    const blocked = explainBlockedCommand(readCommand(input), settings.safeSubcommands, shellOptions);
    if (blocked !== undefined) {
      return `Plan mode blocks bash commands outside its reviewed inspection policy or containing explicitly unsafe arguments.\nBlocked command: ${blocked.segment}\nOffending token: ${blocked.token} (${blocked.reason})`;
    }
  }
  if (toolName === SSH_EXEC_TOOL_NAME) {
    const blocked = findBlockedSshExecCall(input, settings.safeSubcommands);
    if (blocked !== undefined) {
      return `Plan mode blocks ssh_exec calls outside its reviewed remote inspection policy.\nBlocked: ${blocked}`;
    }
  }
  if (toolName === "powershell") {
    const blocked = findBlockedPowerShellCommandSegment(readCommand(input), settings.safeSubcommands, shellOptions);
    if (blocked !== undefined) {
      return `Plan mode blocks PowerShell commands outside its reviewed inspection policy or containing explicitly unsafe syntax.\nBlocked command: ${blocked}`;
    }
  }
  return undefined;
}

/**
 * The Plan policy for a child started while planning. A child has its own registry, so the
 * planner's frozen selection cannot be its allowlist: safe built-ins and trusted read-only
 * extension tools run as Plan classifies the child's own tool, any other tool only when the
 * planner's policy selected a tool of that name loaded from the same file, and every shell call
 * goes through the same reviewed checks. Matching the file keeps a same-named tool from another
 * source (say, a project-scope copy) out.
 */
export function createChildToolPolicy(options: {
  /** Selected tool name -> the planner's source path for it. */
  selected: ReadonlyMap<string, string | undefined>;
  settings: ShellSettings;
  homeDir: string | undefined;
}): PlanModeChildToolPolicy {
  const { selected, settings, homeDir } = options;
  return ({ toolName, input, cwd, tool }) => {
    if (BLOCKED_MUTATING_TOOLS.has(toolName)) {
      return `Plan mode blocks mutating tool '${toolName}' in a subagent started while planning.`;
    }
    if (!tool?.sourceInfo?.source) {
      return `Plan mode blocks tool '${toolName}' in a subagent started while planning because its safe policy metadata is unavailable.`;
    }
    const policy = classifyPlanModeTool(tool);
    const selectedPath = selected.get(toolName);
    const selectedHere = selectedPath !== undefined && selectedPath === tool.sourceInfo.path;
    if (policy === "blocked" || (policy === "user-opt-in" && !selectedHere)) {
      return `Plan mode blocks tool '${toolName}' in a subagent started while planning because the Plan policy does not admit it.`;
    }
    return blockedShellCallReason(toolName, input, settings, { workingDirectory: cwd, homeDir });
  };
}

/** What a child gets when Plan mode cannot build its real answer: no tool at all. */
const refuseEverything: PlanModeChildToolPolicy = ({ toolName }) =>
  `Plan mode blocks tool '${toolName}' in a subagent started while planning because it could not build the child policy.`;

/**
 * Answers {@link PLAN_MODE_STATE_QUERY} with whatever `snapshot` reports at that moment. A
 * snapshot that throws answers active with a policy that refuses every tool: this is a security
 * gate, and an error must never read as "not planning".
 */
export function answerPlanModeStateQueries(
  pi: Pick<ExtensionAPI, "events">,
  snapshot: () => PlanModeStateSnapshot,
): void {
  pi.events.on(PLAN_MODE_STATE_QUERY, (data) => {
    const query = data as Partial<PlanModeStateQuery> | undefined;
    if (query?.version !== PLAN_MODE_STATE_VERSION || typeof query.reply !== "function") return;
    let state: PlanModeStateSnapshot;
    try {
      state = snapshot();
    } catch {
      state = { version: PLAN_MODE_STATE_VERSION, active: true, sessionId: undefined, evaluate: refuseEverything };
    }
    query.reply(state);
  });
}

/** True when a compatible subagent gate answers {@link PLAN_MODE_GATE_QUERY} right now. */
export function subagentGateInstalled(pi: Pick<ExtensionAPI, "events">): boolean {
  let installed = false;
  pi.events.emit(PLAN_MODE_GATE_QUERY, {
    version: PLAN_MODE_STATE_VERSION,
    reply: (answer: unknown) => {
      if ((answer as { version?: unknown } | undefined)?.version === PLAN_MODE_STATE_VERSION) installed = true;
    },
  });
  return installed;
}
