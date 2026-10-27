/**
 * fleet-list.ts — Claude Code-style "FleetView" list rendered below the editor.
 *
 * Starts as a one-line state/count summary; ctrl+shift+a toggles the full list.
 * Shows `main` + each running/queued subagent as a navigable list. Pressing ↓ (or
 * ←) at an empty prompt activates the list; ↑/↓ move the selection (filled ● marker),
 * Enter opens the selected agent's live conversation overlay, Esc returns to the prompt.
 * A viewer stays open when its agent finishes; finished agents linger briefly in the list.
 *
 * Mechanics (see plan): the list is a `belowEditor` widget (render-only), and ALL key
 * handling goes through `onTerminalInput` — which fires before the focused editor and
 * can `consume` keys — gated on `getEditorText() === ""` so normal typing is untouched.
 */

import { isKeyRelease, isKeyRepeat, Key, matchesKey, type ScrollViewScrollbar, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { hasAgentBadge, renderAgentName } from "../agent-color.js";
import { type AgentManager, isTopLevelAgent, markConsumed } from "../agent-manager.js";
import { type Clock, realClock, type TimerHandle } from "../clock.js";
import type { RunningDetached } from "../detached-results.js";
import { describeModelCall } from "../model-call.js";
import type { AgentRecord, ViewerMarkdownMode } from "../types.js";
import { getLifetimeCost, getLifetimeTotal } from "../usage.js";
import { type AgentActivity, buildInvocationTags, fgPreservingNestedStyles, formatCost, type Theme } from "./agent-widget.js";
import { ConversationViewer, getConversationOverlayOptions, type ViewerBackgroundAction } from "./conversation-viewer.js";
import { fallbackFlag, hasFallback, withLeadingFlag } from "./fallback-flag.js";
import { FleetJournal, type FleetJournalEntry, type FleetSnapshot, fleetAlert, MAX_COMPACT_ALERT_COUNT } from "./fleet-state.js";

export { FLEET_STATE_ENTRY } from "./fleet-state.js";

/** Matches the todo/monitor disclosure shortcut family; arrows keep their navigation roles. */
export const FLEET_COLLAPSE_KEY = "ctrl+shift+a";
/** Quiet-period debounce bounds journal writes per toggle burst; shutdown flushes immediately. */
export const FLEET_DISCLOSURE_SETTLE_MS = 300;

/** Existing result-consumption semantics also acknowledge a failed fleet row. */
function isOutstandingFailure(record: AgentRecord): boolean {
  return (record.status === "error" || record.status === "aborted") && !record.resultConsumed;
}

/** Widget key for the below-editor fleet list. */
const FLEET_KEY = "fleet";
/** Max fleet rows shown at once; extras collapse into indicator rows. */
const MAX_AGENT_ROWS = 5;
/** Agent rows left when overflow reserves the two indicator rows. */
const OVERFLOW_AGENT_ROWS = Math.max(1, MAX_AGENT_ROWS - 2);
/** Re-render cadence so elapsed/token stats tick while agents run. */
const TICK_MS = 200;
/** How long a finished agent lingers in the list before it drops out. */
const FINISHED_LINGER_MS = 4000;

/** Minimal UI surface the FleetView needs from `ctx.ui` (structural subset). */
export type FleetUICtx = {
  setWidget(
    key: string,
    content: undefined | ((tui: any, theme: Theme) => { render(width: number): string[]; invalidate(): void; dispose?(): void }),
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
  onTerminalInput(handler: (data: string) => { consume?: boolean; data?: string } | undefined): () => void;
  getEditorText(): string;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  custom<T>(
    factory: (tui: any, theme: Theme, keybindings: any, done: (result: T) => void) => { render(width: number): string[]; invalidate(): void; dispose?(): void },
    options?: { overlay?: boolean; overlayOptions?: unknown; onHandle?: (handle: unknown) => void },
  ): Promise<T>;
};

/**
 * A workflow run, as the fleet list needs to see it.
 *
 * Narrow on purpose: the list knows nothing about `WorkflowTask`, the runtime
 * or the dialog, so it stays as testable as it was when it only held agents.
 * The extension maps its tasks into this shape and injects an opener.
 */
export interface FleetWorkflow {
  id: string;
  /** The `meta.name` of the run, or its id when the script named nothing. */
  name: string;
  status: "running" | "completed" | "failed" | "killed" | "paused";
  doneCount: number;
  totalCount: number;
  startedAt: number;
  /** Set once the run settles, which is what freezes its clock. */
  completedAt?: number;
  tokens: number;
}

type MainEntry = { kind: "main" };
type AgentEntry = { kind: "agent"; record: AgentRecord };
type WorkflowEntry = { kind: "workflow"; workflow: FleetWorkflow };
type FleetEntry = MainEntry | WorkflowEntry | AgentEntry;

/** `11s` — integer seconds, no decimal/suffix (matches Claude Code, unlike formatMs). */
export function formatFleetElapsed(ms: number): string {
  return `${Math.max(0, Math.round(ms / 1000))}s`;
}

/** `↓ 13.1k tokens` — down-arrow prefix, compact magnitude, plural "tokens". */
export function formatFleetTokens(count: number): string {
  let compact: string;
  if (count >= 1_000_000) compact = `${(count / 1_000_000).toFixed(1)}M`;
  else if (count >= 1_000) compact = `${(count / 1_000).toFixed(1)}k`;
  else compact = `${count}`;
  return `↓ ${compact} tokens`;
}

/**
 * Place `right` flush to `width`, truncating `left` first so the stats survive.
 * The final clamp guarantees the line never exceeds `width` (which would wrap and
 * desync pi's line-diff → flicker) even on a terminal too narrow for the stats.
 */
function rightAlign(left: string, right: string, width: number): string {
  const rightW = visibleWidth(right);
  const maxLeft = Math.max(0, width - rightW - 1);
  const leftClamped = truncateToWidth(left, maxLeft);
  const gap = Math.max(leftClamped ? 1 : 0, width - visibleWidth(leftClamped) - rightW);
  return truncateToWidth(leftClamped + " ".repeat(gap) + right, width);
}

/**
 * Agent-row tail columns, left to right; text pads right, numbers pad left.
 * `drop` ranks how early a column goes on a narrow terminal (1 first); an
 * undefined rank is never dropped, so state, elapsed, tokens and cost survive
 * and the description is what truncates (#144).
 */
const TAIL_SLOTS = [
  { align: "end" }, // state: glyph + label
  { align: "end", drop: 3 }, // model
  { align: "end", drop: 2 }, // thinking level
  { align: "end", drop: 1 }, // live model-call activity
  { align: "start" }, // elapsed
  { align: "start" }, // tokens
  { align: "start" }, // cost
] as const;

/** Columns reserved for the bullet, name and the start of the description. */
const MIN_LEFT_WIDTH = 24;

/** Which bucket a state counts under in an overflow summary. */
type StateBucket = "running" | "queued" | "paused" | "done" | "stopped" | "failed";

/** How one agent or run state reads: a glyph AND a word, so colour is never the only cue. */
interface FleetState {
  glyph: string;
  label: string;
  color: string;
  bucket: StateBucket;
}

/** The state of an agent record. */
function agentState(status: AgentRecord["status"]): FleetState {
  switch (status) {
    case "queued": return { glyph: "◦", label: "queued", color: "muted", bucket: "queued" };
    case "running": return { glyph: "▶", label: "running", color: "accent", bucket: "running" };
    case "completed": return { glyph: "✓", label: "done", color: "success", bucket: "done" };
    case "steered": return { glyph: "✓", label: "limit", color: "warning", bucket: "done" };
    case "stopped": return { glyph: "■", label: "stopped", color: "dim", bucket: "stopped" };
    case "aborted": return { glyph: "✗", label: "aborted", color: "error", bucket: "failed" };
    case "error": return { glyph: "✗", label: "failed", color: "error", bucket: "failed" };
  }
}

/** The bucket a workflow run counts under in an overflow summary. */
function workflowBucket(status: FleetWorkflow["status"]): StateBucket {
  switch (status) {
    case "running": return "running";
    case "paused": return "paused";
    case "completed": return "done";
    case "failed":
    case "killed": return "failed";
  }
}

const BUCKET_ORDER: readonly StateBucket[] = ["running", "queued", "paused", "failed", "stopped", "done"];

/** `3 running, 1 failed` for the rows an indicator hides. */
function summarizeHidden(rows: readonly (WorkflowEntry | AgentEntry)[]): string {
  const counts = new Map<StateBucket, number>();
  for (const row of rows) {
    const bucket = row.kind === "workflow" ? workflowBucket(row.workflow.status) : agentState(row.record.status).bucket;
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }
  return BUCKET_ORDER.filter(b => counts.has(b)).map(b => `${counts.get(b)} ${b}`).join(", ");
}

/** One bounded line, including zero agents; the controller still hides an empty fleet. */
export function renderFleetSummary(
  agents: readonly AgentRecord[],
  workflows: readonly FleetWorkflow[],
  parked: number,
  showCost: boolean,
  width: number,
  theme: Theme,
  overflowFailures = 0,
): string {
  const rows: (AgentEntry | WorkflowEntry)[] = [
    ...agents.map(record => ({ kind: "agent" as const, record })),
    ...workflows.map(workflow => ({ kind: "workflow" as const, workflow })),
  ];
  const failed = rows.filter(row => row.kind === "agent"
    ? agentState(row.record.status).bucket === "failed"
    : workflowBucket(row.workflow.status) === "failed").length + overflowFailures;
  const paused = workflows.filter(run => run.status === "paused").length;
  const fallback = agents.filter(hasFallback).length;
  // Actionable counts lead. Cap ONLY compact counts, then remove spaces before
  // dropping any alert: all four fit at 20 columns even for arbitrarily large fleets.
  const alerts = [
    { count: failed, label: "failed", key: "E" },
    { count: parked, label: "parked", key: "P" },
    { count: paused, label: "paused", key: "B" },
    { count: fallback, label: "fallback", key: "F" },
  ].filter(alert => alert.count > 0);
  let flagText = alerts.length ? `[${alerts.map(a => `${a.count} ${a.label}`).join(", ")}]` : "";
  if (visibleWidth(flagText) > width) {
    const compact = alerts.map(a => `${a.key}${a.count > MAX_COMPACT_ALERT_COUNT ? `${MAX_COMPACT_ALERT_COUNT}+` : a.count}`);
    flagText = `[${compact.join(" ")}]`;
    if (visibleWidth(flagText) > width) flagText = `[${compact.join("")}]`;
    // Below the supported 20-column floor, shed lowest-priority alerts first.
    // Failure is first and never becomes the shared helper's misleading [fb].
    while (visibleWidth(flagText) > width && compact.length > 1) {
      compact.pop();
      flagText = `[${compact.join("")}]`;
    }
    if (visibleWidth(flagText) > width) flagText = width > 0 ? "!" : "";
  }
  const flag = theme.fg(failed ? "error" : "warning", flagText);
  const cost = showCost ? formatCost(agents.reduce((sum, agent) => sum + getLifetimeCost(agent.lifetimeUsage), 0)) : "";
  const summary = [summarizeHidden(rows), overflowFailures ? `${overflowFailures} more failed` : ""].filter(Boolean).join(", ") || "0 running";
  const text = `agents: ${summary}${parked ? `, ${parked} parked` : ""}${cost ? ` · ${cost}` : ""} · ${FLEET_COLLAPSE_KEY} to expand`;
  return withLeadingFlag("", alerts.length ? flag : "", theme.fg("dim", text), width);
}

export class FleetList {
  private ui: FleetUICtx | undefined;
  private tui: any | undefined;
  private inputUnsub: (() => void) | undefined;
  private widgetRegistered = false;
  /** The registered widget component, so a late `dispose()` of a replaced one is ignored. */
  private component: object | undefined;
  private timer: TimerHandle | undefined;

  private enabled = true;
  /** Explicit session choice. Navigation temporarily reveals rows without changing it. */
  private readonly journal = new FleetJournal();
  private disclosureTimer: TimerHandle | undefined;
  /** Weak observation prevents repeated journal lookups, without retaining manager records. */
  private readonly observed = new WeakMap<AgentRecord, boolean>();
  /** Quota parking has no AgentRecord; the scheduler supplies its enabled-job count. */
  private parkedSource: () => number = () => 0;
  /** Whether arrow keys currently navigate the list (vs. flow to the editor). */
  private active = false;
  /** 0 = `main`, 1..N = subagents. */
  private selectedIndex = 0;
  /** Set while a conversation overlay is open; calling it closes the overlay. */
  private viewerClose: (() => void) | undefined;
  private viewingAgentId: string | undefined;
  /** Injected by the extension; absent until workflows are wired (or at all). */
  private workflowSource: (() => readonly FleetWorkflow[]) | undefined;
  private openWorkflow: ((id: string) => Promise<void> | void) | undefined;
  /**
   * Set while the workflow inspector is up.
   *
   * It does the two jobs `viewerClose` does for an agent's overlay — keep the
   * list out of the dialog's keys, and remember which row to come back to —
   * minus the close handle, because that overlay belongs to the extension.
   */
  private viewingWorkflowId: string | undefined;

  constructor(
    private manager: AgentManager,
    private agentActivity: Map<string, AgentActivity>,
    /**
     * Read live at render time. Whether each row shows an estimated cost after
     * its token count. Defaults to off — the extension supplies the user's
     * `showCost` setting.
     */
    private showCost: () => boolean = () => false,
    /**
     * The user's `viewerMarkdown` setting, for a conversation overlay opened
     * from here. Read live rather than captured, because the viewer's `m` key
     * changes it while the overlay is up. Omitted → the viewer's own default.
     */
    private viewerMarkdown?: () => ViewerMarkdownMode,
    /**
     * Persist a mode chosen with `m` in that overlay, so the key means the same
     * thing here as it does from `/agents` — one setting, not one per entry
     * point. Omitted → `m` still cycles, viewer-locally.
     */
    private onViewerMarkdown?: (mode: ViewerMarkdownMode) => void,
    private scrollbarMode: () => ScrollViewScrollbar = () => "auto",
    /**
     * The viewer's `b` for this row's run, supplied by the extension: only it
     * knows which runs have a tool call waiting to be released, and it owns the
     * widget this list shares with. Omitted → no `b` affordance.
     */
    private backgroundAction?: (record: AgentRecord, notify: (message: string) => void) => ViewerBackgroundAction,
    /**
     * Read live at render time. Whether each row names the model and thinking
     * level it runs at. Defaults to off — the extension supplies the user's
     * `showModel` setting, which until now only the widget honoured.
     */
    private showModel: () => boolean = () => false,
    /**
     * Agents still running in an orphaned manager (the instance before a
     * `/reload`, `/new`, ...). Listed with this session's own and opened,
     * stopped and steered through the orphan's manager. Omitted -> none.
     */
    private detachedSource: () => readonly RunningDetached[] = () => [],
    private readonly clock: Clock = realClock,
  ) {}

  /** UI-only disclosure; never claims a dialog's key or touches running work. */
  toggleCollapse(): void {
    if (!this.enabled || !this.ui || this.viewerClose || this.viewingWorkflowId || !this.editorHasFocus()) return;
    this.journal.collapsed = this.active ? true : !this.journal.collapsed;
    this.disclosureTimer?.cancel();
    this.disclosureTimer = this.clock.setTimeout(() => this.flushState(), FLEET_DISCLOSURE_SETTLE_MS);
    this.active = false;
    this.selectedIndex = 0;
    this.update();
  }

  /** Restore the last valid active-branch disclosure entry without writing another entry. */
  restoreSession(
    entries: readonly FleetJournalEntry[] | (() => readonly FleetJournalEntry[]),
    persist: (state: FleetSnapshot) => void,
  ): void {
    this.disclosureTimer?.cancel();
    this.disclosureTimer = undefined;
    this.journal.restore(typeof entries === "function" ? entries : () => entries, persist);
    this.active = false;
    this.selectedIndex = 0;
  }

  /** Flush while the activation's appendEntry/context is still valid. */
  flushState(): void {
    this.disclosureTimer?.cancel();
    this.disclosureTimer = undefined;
    this.journal.flushDisclosure();
  }

  /** Terminal callback and detached-notice ingress, never dependent on a render tick. */
  ingestFailure(value: unknown): void {
    const alert = fleetAlert(value);
    if (alert) this.journal.report(alert);
  }

  /** Shared semantic edge for result consumption, RPC and successful human inspection. */
  acknowledgeFailure(id: string): void {
    this.journal.acknowledge(id);
  }

  /** Inject scheduler display data, without coupling the fleet to scheduling behavior. */
  setParkedSource(source: () => number): void {
    this.parkedSource = source;
  }

  // ---- Lifecycle ----

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (!enabled) this.active = false;
    this.update();
  }

  /** Capture the UI context and (re)register the global input handler. */
  setUICtx(ui: FleetUICtx): void {
    if (ui === this.ui) return;
    this.inputUnsub?.();
    this.ui = ui;
    this.widgetRegistered = false;
    this.component = undefined;
    this.tui = undefined;
    this.inputUnsub = ui.onTerminalInput(data => this.handleKey(data));
  }

  /** Ensure the re-render timer is running (called when an agent spawns). */
  ensureTimer(): void {
    if (!this.timer) this.timer = this.clock.setInterval(() => this.update(), TICK_MS);
  }

  /**
   * Called when an agent finishes. The viewer (if open on it) stays open so the
   * final output remains readable, and the row lingers in the list — just refresh.
   */
  onAgentFinished(_id: string): void {
    this.update();
  }

  dispose(): void {
    this.flushState();
    if (this.timer) { this.timer.cancel(); this.timer = undefined; }
    this.inputUnsub?.();
    this.inputUnsub = undefined;
    if (this.viewerClose) { this.viewerClose(); this.viewerClose = undefined; }
    this.viewingAgentId = undefined;
    // No handle to close the workflow inspector with, but the list is going
    // away — leaving the id set would keep it swallowing input forever.
    this.viewingWorkflowId = undefined;
    if (this.ui && this.widgetRegistered) this.ui.setWidget(FLEET_KEY, undefined);
    this.widgetRegistered = false;
    this.component = undefined;
    this.tui = undefined;
    this.active = false;
    // Null last so a `viewerClose()` microtask above can't re-register the widget.
    this.ui = undefined;
  }

  /** Re-register/refresh the below-editor widget; clears it when nothing remains. */
  update(): void {
    if (!this.ui) return;
    // Summary existence includes pending starts and quota parking: neither has
    // an openable row yet. Navigation still uses the openable roster only.
    const hasRows = this.enabled && (this.agentRecords(true).length > 0 || this.workflows().length > 0 || this.journal.count > 0 || this.parkedSource() > 0);

    if (!hasRows) {
      if (this.widgetRegistered) {
        this.ui.setWidget(FLEET_KEY, undefined);
        this.widgetRegistered = false;
        this.tui = undefined;
      }
      // A just-spawned agent has no session until its runner finishes binding
      // extensions, and nothing else calls update() until the child's first model
      // event, which a slow first response delays by minutes. Keep ticking while
      // one is starting so its row appears as soon as the session exists.
      if (this.enabled && this.hasStartingAgent()) this.ensureTimer();
      else if (this.timer) { this.timer.cancel(); this.timer = undefined; }
      this.active = false;
      this.selectedIndex = 0;
      return;
    }

    this.clampSelection();
    this.ensureTimer(); // keep stats ticking whenever the list is shown (e.g. after a re-enable)

    if (!this.widgetRegistered) {
      this.ui.setWidget(FLEET_KEY, (tui, theme) => {
        this.tui = tui;
        const component = {
          render: (w: number) => this.renderBar(w, theme),
          invalidate: () => { this.widgetRegistered = false; this.tui = undefined; },
          // Core disposes extension widgets on /reload and plan-mode enter/exit.
          // Reset the flag so the next update() registers a fresh one instead of
          // asking a dead component to re-render. Only the live component counts:
          // a replaced one is disposed after its successor registered.
          dispose: () => {
            if (this.component !== component) return;
            this.component = undefined;
            this.widgetRegistered = false;
            this.tui = undefined;
          },
        };
        this.component = component;
        return component;
      }, { placement: "belowEditor" });
      this.widgetRegistered = true;
    } else {
      this.tui?.requestRender();
    }
  }

  /** Whether a top-level agent is live but not yet listable (no session yet). */
  private hasStartingAgent(): boolean {
    return this.manager.listAgents().some(a =>
      isTopLevelAgent(a) && !a.session && (a.status === "running" || a.status === "queued"));
  }

  // ---- Roster ----

  /**
   * Agents shown in the list, ordered earliest-launched first so the ones you
   * started sooner sit at the top. Every row is openable (has a session), so Enter
   * never dead-ends. Included: running/queued, plus the agent currently being
   * viewed, plus recently-finished ones (they linger briefly before dropping out).
   * Pending agents have no openable row; includePending counts them in the summary.
   * (`listAgents()` is newest-first, so we re-sort.)
   */
  private agentRecords(includePending = false): AgentRecord[] {
    const now = this.clock.now();
    // Orphans are live objects, so a settled one is simply skipped; the
    // registry drops it itself. Own records win if an id appears in both.
    const own = this.manager.listAgents();
    const ownIds = new Set(own.map(a => a.id));
    const orphans = this.detachedSource().map(d => d.record).filter(r => !ownIds.has(r.id));
    const records = new Map([...own, ...orphans].map(a => [a.id, a]));
    for (const a of records.values()) {
      if (!isTopLevelAgent(a) || (a.status !== "error" && a.status !== "aborted")) continue;
      const consumed = !!a.resultConsumed;
      if (this.observed.get(a) === consumed) continue;
      this.observed.set(a, consumed);
      if (consumed) this.acknowledgeFailure(a.id);
      else this.ingestFailure(a);
    }
    for (const alert of this.journal.alerts) {
      if (alert.state !== "error" && alert.state !== "aborted") continue;
      const live = records.get(alert.id);
      if (!live || !isOutstandingFailure(live)) records.set(`fleet-alert:${alert.id}`, {
        id: alert.id, type: alert.type, description: alert.description, status: alert.state,
        startedAt: alert.timestamp, completedAt: alert.timestamp, toolUses: 0, compactionCount: 0,
        lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
      });
    }
    return [...records.values()]
      .filter(a => {
        if (!isTopLevelAgent(a)) return false;
        if (isOutstandingFailure(a)) return this.journal.alerts.some(alert => alert.id === a.id);
        // Consumed failures may linger as expanded history, never as outstanding alerts.
        if (includePending && (a.status === "error" || a.status === "aborted")) return false;
        return (includePending || a.session) && (
          a.status === "running" || a.status === "queued" || a.id === this.viewingAgentId
          || (a.completedAt != null && now - a.completedAt < FINISHED_LINGER_MS)
        );
      })
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  private detachedFor(id: string): RunningDetached | undefined {
    return this.detachedSource().find(d => d.record.id === id);
  }

  private activityFor(id: string): AgentActivity | undefined {
    return this.agentActivity.get(id) ?? this.detachedFor(id)?.activity;
  }

  /**
   * Wire workflow runs into the list.
   *
   * Injected rather than constructed here because the fleet list predates
   * workflows and must keep working without them — a session with the feature
   * switched off never calls this, and the roster is agents-only exactly as
   * before.
   */
  setWorkflowSource(
    source: () => readonly FleetWorkflow[],
    open: (id: string) => Promise<void> | void,
  ): void {
    this.workflowSource = source;
    this.openWorkflow = open;
  }

  /** Live runs, plus recently settled ones — the same linger the agents get. */
  private workflows(): FleetWorkflow[] {
    const now = this.clock.now();
    const runs = new Map((this.workflowSource?.() ?? []).map(run => [run.id, run]));
    for (const run of runs.values()) {
      if (run.status === "failed" || run.status === "killed") {
        this.ingestFailure({ id: run.id, type: "workflow", description: run.name, status: run.status, startedAt: run.startedAt, completedAt: run.completedAt });
      }
    }
    for (const alert of this.journal.alerts) {
      if (alert.state !== "failed" && alert.state !== "killed") continue;
      const live = runs.get(alert.id);
      if (!live || (live.status !== "failed" && live.status !== "killed")) runs.set(`fleet-alert:${alert.id}`, {
        id: alert.id, name: alert.description, status: alert.state, startedAt: alert.timestamp,
        completedAt: alert.timestamp, doneCount: 0, totalCount: 0, tokens: 0,
      });
    }
    return [...runs.values()]
      .filter(run => {
        if (run.status === "failed" || run.status === "killed") return this.journal.alerts.some(alert => alert.id === run.id);
        return run.status === "running" || run.status === "paused"
          || (run.completedAt != null && now - run.completedAt < FINISHED_LINGER_MS);
      })
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  /**
   * Runs sit above the agents rather than interleaved by start time: a run owns
   * most of the agents under it, so listing the container first is what makes
   * the list read as a hierarchy rather than a shuffle.
   */
  private roster(): FleetEntry[] {
    return [
      { kind: "main" },
      ...this.workflows().map(workflow => ({ kind: "workflow" as const, workflow })),
      ...this.agentRecords().map(record => ({ kind: "agent" as const, record })),
    ];
  }

  private clampSelection(): void {
    const max = this.roster().length - 1;
    if (this.selectedIndex > max) this.selectedIndex = Math.max(0, max);
    if (this.selectedIndex < 0) this.selectedIndex = 0;
  }

  // ---- Key handling ----

  /** Returns `{consume:true}` to swallow a key, or undefined to let it through. */
  handleKey(data: string): { consume?: boolean; data?: string } | undefined {
    if (!this.enabled || !this.ui) return undefined;
    // Input listeners receive BOTH key-press and key-release (the kitty protocol
    // emits both, and matchesKey matches either) — act on press only, or every
    // tap would move/fire twice. Repeats still pass through for held-key nav.
    if (isKeyRelease(data)) return undefined;
    // While an overlay is open, let it own all input. Checked before the focus
    // test below, which would otherwise read the dialog holding the keyboard as
    // "the user left the list" and reset the selection out from under it.
    if (this.viewerClose || this.viewingWorkflowId) return undefined;
    // Input listeners fire BEFORE the focused component, and dialogs
    // (ctx.ui.select/confirm/input, pi's own menus) swap the prompt editor out
    // while getEditorText() still reads the detached — empty — editor. So when
    // anything but the editor owns the keyboard, stay out of its keys (#123).
    if (!this.editorHasFocus()) {
      if (this.active) this.deactivate();
      return undefined;
    }

    if (matchesKey(data, FLEET_COLLAPSE_KEY)) {
      // Kitty event type 2 is auto-repeat; arrows deliberately still repeat.
      if (isKeyRepeat(data)) return { consume: true };
      this.toggleCollapse();
      return { consume: true };
    }

    if (!this.active) {
      // Activate: ↓ or ← at an empty prompt moves focus into the list.
      const isActivator = matchesKey(data, "down") || matchesKey(data, "left");
      // Gated on the roster, not the agents: a session whose only row is a
      // workflow run still has somewhere to go, and requiring an agent would
      // render the row but refuse to move into it.
      if (isActivator && this.roster().length > 1 && this.ui.getEditorText() === "") {
        this.active = true;
        this.selectedIndex = 0;
        this.update();
        return { consume: true };
      }
      return undefined;
    }

    // Active — arrows navigate, Enter opens, Esc / Up-past-top exits.
    if (matchesKey(data, "down")) {
      const max = this.roster().length - 1;
      this.selectedIndex = Math.min(max, this.selectedIndex + 1);
      this.update();
      return { consume: true };
    }
    if (matchesKey(data, "up")) {
      if (this.selectedIndex === 0) { this.deactivate(); return { consume: true }; }
      this.selectedIndex -= 1;
      this.update();
      return { consume: true };
    }
    if (matchesKey(data, "escape")) { this.deactivate(); return { consume: true }; }
    if (matchesKey(data, Key.enter)) { this.openSelected(); return { consume: true }; }

    // Any other key cancels navigation and flows to the editor.
    this.deactivate();
    return undefined;
  }

  /**
   * True when pi's prompt editor owns the keyboard. The editor is pluggable
   * (ui.setEditorComponent) and need not extend `Editor` (#374), so match pi-tui's
   * `EditorComponent` contract instead: `getText` + `setText`, which pi calls on
   * every editor and none of pi's dialogs, selectors or overlays implement.
   * `focusedComponent` is TUI-private (no public accessor), hence the best-effort
   * peek: unknowable focus (no tui seen yet, nothing focused) counts as the
   * editor so activation keeps working.
   */
  editorHasFocus(): boolean {
    const focused = (this.tui as { focusedComponent?: unknown } | undefined)?.focusedComponent;
    if (focused == null) return true;
    const c = focused as { getText?: unknown; setText?: unknown };
    return typeof c.getText === "function" && typeof c.setText === "function";
  }

  private deactivate(): void {
    this.active = false;
    this.selectedIndex = 0;
    this.update();
  }

  private openSelected(): void {
    const entry = this.roster()[this.selectedIndex];
    if (!entry || entry.kind === "main") {
      // `main` = return to the prompt; the native transcript is already shown.
      this.deactivate();
      return;
    }
    if (entry.kind === "workflow") {
      if (!this.workflowSource?.().some(run => run.id === entry.workflow.id) || !this.openWorkflow) {
        this.ui?.notify(`workflow: ${entry.workflow.name} (${entry.workflow.status}).`, "error");
        this.acknowledgeFailure(entry.workflow.id);
        this.update();
        return;
      }
      // The extension owns this overlay and closes it, so there is no
      // `viewerClose` to hold — but the list still has to know one is up, and
      // still has to put the cursor back on the run when it comes down.
      this.viewingWorkflowId = entry.workflow.id;
      void Promise.resolve(this.openWorkflow?.(entry.workflow.id)).then(
        () => this.clearViewer(true),
        () => this.clearViewer(),
      );
      return;
    }
    const record = entry.record;
    if (!this.ui) return;
    if (!record.session) {
      if (isOutstandingFailure(record)) {
        this.ui.notify(record.error ?? `${record.type}: ${record.description} (${record.status}).`, "error");
        markConsumed(record, this.clock.now());
        this.acknowledgeFailure(record.id);
        this.update();
        return;
      }
      this.ui.notify(`Agent is ${record.status} — no session available.`, "info");
      return;
    }
    const session = record.session;
    const activity = this.activityFor(record.id);
    const orphan = this.detachedFor(record.id);
    this.viewingAgentId = record.id;
    let overlayOptions = getConversationOverlayOptions({ mode: "regular" });

    void this.ui.custom<undefined>(
      (tui, theme, keybindings, done) => {
        overlayOptions = getConversationOverlayOptions(tui);
        this.viewerClose = () => done(undefined);
        return new ConversationViewer(
          tui,
          session,
          record,
          activity,
          theme,
          done,
          () => {
            if ((orphan ? orphan.abort() : this.manager.abort(record.id))) this.ui?.notify(`Stopped "${record.description}".`, "info");
          },
          keybindings,
          (message: string) => (orphan ? orphan.steer(message) : this.manager.steer(record.id, message)),
          this.showCost(),
          this.viewerMarkdown,
          this.onViewerMarkdown,
          this.scrollbarMode(),
          this.backgroundAction?.(record, message => this.ui?.notify(message, "info")),
          this.clock,
        );
      },
      {
        overlay: true,
        overlayOptions: () => overlayOptions,
      },
    ).then(() => this.clearViewer(true), () => this.clearViewer());
  }

  /** Reset overlay state and return to the list (on close, auto-close, or error). */
  private clearViewer(acknowledge = false): void {
    // Keep the cursor on the agent we were viewing — re-resolve by id so it
    // still feels natural if the list reordered (an earlier agent finished)
    // while the overlay was open. If that agent is gone, leave the index for
    // update()'s clamp to settle.
    const viewed = this.viewingAgentId ?? this.viewingWorkflowId;
    if (viewed !== undefined) {
      const idx = this.roster().findIndex(e =>
        e.kind === "agent" ? e.record.id === viewed
        : e.kind === "workflow" ? e.workflow.id === viewed
        : false,
      );
      if (idx >= 0) this.selectedIndex = idx;
    }
    if (acknowledge && this.viewingAgentId) {
      const record = this.agentRecords(true).find(a => a.id === this.viewingAgentId);
      if (record && isOutstandingFailure(record)) {
        markConsumed(record, this.clock.now());
        this.acknowledgeFailure(record.id);
      }
    }
    if (acknowledge && this.viewingWorkflowId) {
      const run = this.workflows().find(run => run.id === this.viewingWorkflowId);
      if (run?.status === "failed" || run?.status === "killed") this.acknowledgeFailure(run.id);
    }
    this.viewerClose = undefined;
    this.viewingAgentId = undefined;
    this.viewingWorkflowId = undefined;
    this.update();
  }

  // ---- Rendering ----

  private renderBar(width: number, theme: Theme): string[] {
    const rows = this.roster().slice(1) as (WorkflowEntry | AgentEntry)[];
    if ((this.journal.collapsed && !this.active) || rows.length === 0) {
      return [renderFleetSummary(this.agentRecords(true), this.workflows(), this.parkedSource(), this.showCost(), width, theme, this.journal.overflowCount)];
    }
    // Clamp locally so a render between a roster shrink and the next update()
    // (e.g. on terminal resize) never loses the selection marker.
    const sel = Math.min(this.selectedIndex, rows.length);

    const hint = this.active
      ? "↑↓ select · enter view · esc back"
      : `esc to interrupt · ← for agents · ↓ to manage · ${FLEET_COLLAPSE_KEY} to collapse`;
    const lines: string[] = [];
    // Overflow details are deliberately bounded, but their exact failure count stays visible.
    lines.push(this.journal.overflowCount
      ? renderFleetSummary(this.agentRecords(true), this.workflows(), this.parkedSource(), this.showCost(), width, theme, this.journal.overflowCount)
      : truncateToWidth("  " + theme.fg("dim", hint), width));
    lines.push("");
    lines.push(truncateToWidth(`  ${this.bullet(0, sel, theme)} main`, width));

    // At the cap, the row block holds rows alone. Once it overflows, reserve
    // two of those slots for indicators, keeping the block exactly cap lines
    // tall while the selected row stays in the agent window.
    const overflow = rows.length > MAX_AGENT_ROWS;
    const visible = Math.min(overflow ? OVERFLOW_AGENT_ROWS : MAX_AGENT_ROWS, rows.length);
    const selRow = Math.max(0, sel - 1);
    const start = selRow < visible ? 0 : selRow - visible + 1;
    const hiddenBelow = rows.length - (start + visible);

    // Both indicator slots remain in the row block, blank at an edge, so every
    // overflowing roster has the same height.
    // Column widths come from EVERY agent row, not the window, so scrolling
    // never shifts a column; a column too wide for the terminal is dropped
    // lowest-value first, never state, elapsed, tokens or cost.
    const cells = new Map<AgentRecord, string[]>();
    for (const r of rows) {
      if (r.kind === "agent") cells.set(r.record, this.tailCells(r.record, theme));
    }
    // Reserve the widest leading flag across ALL rows before fitting optional
    // columns, so a fallback cannot hide the alias or shift columns on scroll.
    const flagWidth = Math.max(0, ...[...cells.keys()].map(record => {
      const flag = fallbackFlag(theme, record);
      return flag ? visibleWidth(flag) + 1 : 0;
    }));
    const colWidths = this.fitColumns(
      TAIL_SLOTS.map((_, i) => Math.max(0, ...[...cells.values()].map(c => visibleWidth(c[i])))),
      width - flagWidth,
    );
    if (start > 0) {
      lines.push(rightAlign("", theme.fg("dim", `↑ ${start} more: ${summarizeHidden(rows.slice(0, start))}`), width));
    } else if (overflow) lines.push("");
    for (let a = start; a < start + visible; a++) {
      const row = rows[a];
      lines.push(
        row.kind === "workflow" ?
          this.renderWorkflowRow(a + 1, sel, row.workflow, width, theme)
        : this.renderAgentRow(a + 1, sel, row.record, width, theme, cells.get(row.record) ?? [], colWidths),
      );
    }
    if (hiddenBelow > 0) {
      lines.push(rightAlign("", theme.fg("dim", `↓ ${hiddenBelow} more: ${summarizeHidden(rows.slice(start + visible))}`), width));
    } else if (overflow) lines.push("");
    // pi stacks below-editor widgets directly on its footer with no spacer (#351).
    lines.push("");

    return lines;
  }

  private bullet(rosterIndex: number, sel: number, theme: Theme): string {
    return rosterIndex === sel ? theme.fg("accent", "●") : theme.fg("dim", "○");
  }

  /**
   * A run's row. Shaped like an agent's — bullet, kind, name, stats flush right
   * — so the two read as one list, with the agent count where an agent has its
   * description and the same elapsed/token tail.
   */
  private renderWorkflowRow(
    rosterIndex: number,
    sel: number,
    workflow: FleetWorkflow,
    width: number,
    theme: Theme,
  ): string {
    const selected = rosterIndex === sel;
    const kind = theme.fg(selected ? "text" : "muted", "workflow");
    const name = selected ? theme.fg("text", workflow.name) : workflow.name;
    const left = `  ${this.bullet(rosterIndex, sel, theme)} ${kind}  ${name}`;
    // Frozen once the run settles, exactly as an agent's clock is.
    const elapsed = (workflow.completedAt ?? this.clock.now()) - workflow.startedAt;
    const agents = `${workflow.doneCount}/${workflow.totalCount} agent${workflow.totalCount === 1 ? "" : "s"}`;
    const stats = `${agents} · ${formatFleetElapsed(elapsed)} · ${formatFleetTokens(workflow.tokens)}`;
    return rightAlign(left, selected ? theme.fg("text", stats) : theme.fg("dim", stats), width);
  }

  /** Zero the widths of droppable columns, lowest value first, until the tail leaves room for the description. */
  private fitColumns(widths: number[], width: number): number[] {
    const fitted = [...widths];
    const tail = () => {
      const used = fitted.filter(w => w > 0);
      return used.reduce((sum, w) => sum + w, 0) + 3 * Math.max(0, used.length - 1);
    };
    const droppable = TAIL_SLOTS
      .map((slot, i) => ({ i, rank: "drop" in slot ? slot.drop : 0 }))
      .filter(c => c.rank > 0)
      .sort((x, y) => x.rank - y.rank);
    for (const { i } of droppable) {
      if (width - tail() >= MIN_LEFT_WIDTH) break;
      fitted[i] = 0;
    }
    return fitted;
  }

  /** One agent's stats tail as {@link TAIL_SLOTS} cells; "" where a slot has no value. */
  private tailCells(record: AgentRecord, theme: Theme): string[] {
    // The record, not the activity tracker — see the note in AgentWidget's
    // running line: only the record carries a nested child's spend, and only it
    // outlives the agent.
    const tokens = getLifetimeTotal(record.lifetimeUsage);
    const elapsedMs = (record.completedAt ?? this.clock.now()) - record.startedAt; // freezes once finished
    let model = "";
    let thinking = "";
    if (this.showModel()) {
      // Leading, and paired: a thinking level means nothing without its model.
      const { modelName, tags } = buildInvocationTags(record.invocation);
      model = modelName ?? "";
      // `think:high` here, so the configured level cannot read as a duplicate
      // of the live `thinking · 4s` activity beside it.
      thinking = (tags.find(tag => tag.startsWith("thinking: ")) ?? "").replace(/^thinking: /, "think:");
    }
    const state = agentState(record.status);
    // What the in-flight model call is doing, only while the agent is running:
    // a finished row has no call to describe.
    const call = record.status === "running"
      ? describeModelCall(this.activityFor(record.id)?.modelCall, this.clock.now())
      : undefined;
    const cost = this.showCost() ? formatCost(getLifetimeCost(record.lifetimeUsage)) : "";
    return [theme.fg(state.color, `${state.glyph} ${state.label}`), model, thinking, call ?? "", formatFleetElapsed(elapsedMs), formatFleetTokens(tokens), cost];
  }

  private renderAgentRow(
    rosterIndex: number,
    sel: number,
    record: AgentRecord,
    width: number,
    theme: Theme,
    cells: string[],
    colWidths: number[],
  ): string {
    // The selected row renders in the theme's primary text color so it reads as
    // one selection (#230). A configured badge survives — Claude Code's FleetView
    // keeps the agent color on the selected row too and only bolds it — which also
    // keeps the row's width fixed as the selection moves.
    const selected = rosterIndex === sel;
    const name = renderAgentName(record.type, theme, selected
      ? { fallbackColor: "text", bold: hasAgentBadge(record.type) }
      : { fallbackColor: "muted" });
    // The spawner's `name` leads when there is one, so two agents of one type
    // with similar descriptions stay distinguishable after truncation.
    const label = record.alias ? `${record.alias}: ${record.description}` : record.description;
    const description = selected ? theme.fg("text", label) : label;
    let prefix = `  ${this.bullet(rosterIndex, sel, theme)} `;
    const left = `${name}  ${description}`;
    // Fixed-width slots (blank where a row has no value) keep each column at the
    // same cells on every row; an all-empty column is dropped.
    let stats = TAIL_SLOTS.map((slot, i) => {
      if (colWidths[i] === 0) return undefined;
      const pad = " ".repeat(colWidths[i] - visibleWidth(cells[i] ?? ""));
      return slot.align === "end" ? (cells[i] ?? "") + pad : pad + (cells[i] ?? "");
    }).filter((c): c is string => c !== undefined).join(" · ");
    let flag = fallbackFlag(theme, record);
    if (flag && visibleWidth(prefix + flag) + 1 + visibleWidth(stats) > width) {
      // Description space is exhausted and fitColumns already dropped activity,
      // thinking and model. Use the SHARED helper's compact marker, never slice
      // the flag, before sacrificing any spend cell. Rendering an empty body in
      // the flag budget selects [fb] or ! with the same policy as every renderer.
      const flagBudget = Math.max(1, width - visibleWidth(prefix) - visibleWidth(stats) - 1);
      flag = withLeadingFlag("", flag, "", flagBudget).trimEnd();
    }
    // Every row preserves spend, not just rows carrying a fallback marker.
    const markerWidth = flag ? visibleWidth(flag) + 1 : 0;
    if (visibleWidth(prefix) + markerWidth + visibleWidth(stats) > width) {
      // A state word and padded separators are not spend. Keep its glyph and
      // unpadded elapsed/tokens/cost, then remove navigation padding if needed.
      const spend = cells.slice(4).filter(Boolean);
      stats = [agentState(record.status).glyph, ...spend].join(" ");
      if (visibleWidth(prefix) + markerWidth + visibleWidth(stats) > width) prefix = "";
      const remaining = width - markerWidth;
      if (visibleWidth(stats) > remaining) stats = spend.join(" ");
      // Only when all three cannot physically fit may elapsed yield to spend.
      if (visibleWidth(stats) > remaining) stats = spend.slice(1).join(" ");
    }
    const right = fgPreservingNestedStyles(theme, selected ? "text" : "dim", stats);
    // The flag leads the row (even with `showModel` off: a substituted model is
    // not cosmetic) and the name/description/tail are laid out in what is left.
    return withLeadingFlag(prefix, flag, inner => rightAlign(left, right, inner), width);
  }
}
