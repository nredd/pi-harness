/** Public lifecycle outcomes for the fleet widget, tool row and alert journal. */

import type { TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { AgentManager } from "../src/agent-manager.js";
import { modelFallbackNote } from "../src/model-resolver.js";
import type { AgentRecord, NotificationDetails } from "../src/types.js";
import { AgentCallView, AgentResultView, agentRowSummary, keepRowTicking } from "../src/ui/agent-row.js";
import { type AgentActivity, type AgentDetails, AgentWidget, describeActivity, type Theme, type UICtx } from "../src/ui/agent-widget.js";
import { FLEET_STATE_ENTRY, FleetJournal, type FleetJournalEntry, MAX_FLEET_ALERT_DETAILS } from "../src/ui/fleet-state.js";
import { renderNotification } from "../src/ui/notification-view.js";
import { formatCompactTokens } from "../src/ui/workflow-card.js";
import { handleWorkflowDialogKey, initialWorkflowDialogState, resolveWorkflowDialog, WorkflowDialog, type WorkflowDialogState } from "../src/ui/workflow-dialog.js";
import { FakeClock } from "./helpers/fake-clock.js";

const theme: Theme = { fg: (_color, text) => text, bold: text => text };

/** Capture only the public widget factory, not private render methods. */
function widgetFixture(records: AgentRecord[], activity = new Map<string, AgentActivity>()) {
  const clock = new FakeClock();
  let build: Exclude<Parameters<UICtx["setWidget"]>[1], undefined> | undefined;
  const ui: UICtx = { setStatus: vi.fn(), setWidget: vi.fn((_key, factory) => { build = factory; }) };
  const widget = new AgentWidget({ listAgents: () => records } as unknown as AgentManager, activity, () => "all", () => false, () => false, clock);
  widget.setUICtx(ui);
  widget.update();
  const create = () => {
    if (!build) throw new Error("widget factory was not registered");
    return build({ terminal: { columns: 240 }, requestRender: vi.fn() }, theme);
  };
  return { clock, widget, ui, create };
}

/** A settled record whose timestamps agree with the independent fake clock. */
function record(status: AgentRecord["status"], error?: string): AgentRecord {
  return { id: "run", type: "general-purpose", description: "observed", status, toolUses: 2, startedAt: Date.parse("2020-01-01T00:00:00Z"), completedAt: Date.parse("2020-01-01T00:00:02Z"), error } as AgentRecord;
}

const details: AgentDetails = { displayName: "Agent", description: "observed", subagentType: "general-purpose", toolUses: 0, tokens: "", durationMs: 2000, status: "running", agentId: "run" };

describe("static fleet display contracts", () => {
  it("keeps notification/dialog pixels stable on host invalidation and returns left from agent detail", () => {
    const details = { description: "finished", status: "completed", toolUses: 0, totalTokens: 0, durationMs: 0, turnCount: 0, resultPreview: "answer" } as NotificationDetails;
    const notice = renderNotification(details, true, theme, false);
    const before = notice.render(120);
    notice.invalidate();
    expect(notice.render(120)).toEqual(before);
    expect(before.join("\n")).toContain("answer");
    const source = { progress: [], task: { status: "completed" as const, startTime: 1000, endTime: 2000 } };
    const dialog = new WorkflowDialog({ requestRender: vi.fn() } as unknown as TUI, () => source, theme, vi.fn());
    try {
      const before = dialog.render(120);
      dialog.invalidate();
      expect(dialog.render(120)).toEqual(before);
      const state: WorkflowDialogState = { ...initialWorkflowDialogState(), level: "agent", promptExpanded: true };
      expect(handleWorkflowDialogKey("\x1b[D", state, resolveWorkflowDialog({ ...source, state }))).toEqual({ state: { ...state, level: "phases", promptExpanded: false } });
    } finally { dialog.dispose(); }
    expect(formatCompactTokens(99)).toBe("99");
    expect(modelFallbackNote({ input: "missing-a", also: ["missing-b"], used: "p/parent" })).toBe('Note: configured models "missing-a", "missing-b" did not resolve; running on parent model p/parent.');
  });
});

describe("widget lifecycle", () => {
  it.each([
    ["steered", undefined, "✓", "(turn limit)"],
    ["stopped", undefined, "■", "stopped"],
    ["error", "diagnostic", "✗", "error: diagnostic"],
    ["error", undefined, "✗", "error"],
    ["aborted", undefined, "✗", "aborted"],
  ] as const)("displays the terminal %s verdict independently of a running activity tracker", (status, error, icon, wording) => {
    const activity: AgentActivity = { activeTools: new Map(), toolUses: 3, responseText: "", turnCount: 4, maxTurns: 9 };
    const f = widgetFixture([record(status, error)], new Map([["run", activity]]));
    try {
      const text = f.create().render().join("\n");
      expect(text).toContain(icon);
      expect(text).toContain(wording);
      expect(text).toContain("↻4≤9");
      expect(text).toContain("2 tool uses");
      expect(text).toContain("2.0s");
    } finally { f.widget.dispose(); }
  });

  it("invalidates the themed factory without letting an old component dispose its replacement", () => {
    const f = widgetFixture([record("completed")]);
    try {
      const first = f.create();
      first.invalidate();
      f.widget.update();
      expect(f.ui.setWidget).toHaveBeenCalledTimes(2);
      const replacement = f.create();
      first.dispose?.();
      f.widget.update();
      expect(f.ui.setWidget).toHaveBeenCalledTimes(2);
      expect(replacement.render().join("\n")).toContain("2.0s");
    } finally { f.widget.dispose(); }
  });

  it("clears the active status when the final running agent disappears", () => {
    const records = [record("running")];
    const f = widgetFixture(records);
    try {
      expect(f.ui.setStatus).toHaveBeenLastCalledWith("subagents", "1 running agent");
      f.create();
      records.length = 0;
      f.widget.update();
      expect(f.ui.setStatus).toHaveBeenLastCalledWith("subagents", undefined);
      expect(f.ui.setWidget).toHaveBeenLastCalledWith("agents", undefined);
    } finally { f.widget.dispose(); }
  });

  it("groups simultaneous searches as patterns and other repeated tools as files", () => {
    expect(describeActivity(new Map([["a", "grep"], ["b", "grep"], ["c", "read"], ["d", "read"]]))).toBe("searching 2 patterns, reading 2 files…");
  });
});

describe("tool row lifecycle", () => {
  it("keeps queued wording and bounded expanded results across host invalidation", () => {
    const live = { getRecord: () => undefined, getActivity: () => undefined, showCost: () => false };
    expect(agentRowSummary({ ...details, status: "queued" }, live, theme)).toContain("queued");
    const output = Array.from({ length: 51 }, (_, i) => `result-${i}`).join("\n");
    const view = new AgentResultView({ ...details, status: "completed" }, output, true, live, theme);
    const before = view.render(240).join("\n");
    expect(before).toContain("result-49");
    expect(before).not.toContain("result-50");
    expect(before).toContain("use get_subagent_result with verbose for full output");
    const call = new AgentCallView("Agent observed", "prompt", theme);
    const rendered = call.render(240);
    call.invalidate();
    expect(call.render(240)).toEqual(rendered);
  });

  it("renders background fallback activity and repaints on a settled live record", () => {
    const clock = new FakeClock();
    let current = record("running");
    const live = { getRecord: () => current, getActivity: () => undefined, showCost: () => false };
    const background: AgentDetails = { ...details, status: "background" };
    expect(agentRowSummary(background, live, theme, clock.now())).toContain("running in background");
    const invalidate = vi.fn();
    keepRowTicking({ state: {}, invalidate }, background, live, clock);
    clock.advance(1000);
    expect(invalidate).toHaveBeenCalledTimes(1);
    current = record("completed");
    clock.advance(1000);
    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(clock.pending).toBe(0);
    const view = new AgentResultView(background, "output", false, live, theme, clock);
    expect(view.render(240).join("\n")).toContain("done");
    view.invalidate();
    expect(view.render(240).join("\n")).toContain("done");
  });
});

describe("fleet journal overflow attempt replacement", () => {
  it("moves the unread overflow count across failure kinds for a newer attempt with the same id", () => {
    const entries: FleetJournalEntry[] = [];
    const journal = new FleetJournal();
    journal.restore(() => entries, state => entries.push({ type: "custom", customType: FLEET_STATE_ENTRY, data: state }));
    for (let i = 0; i <= MAX_FLEET_ALERT_DETAILS; i++) journal.report({ id: `id-${i}`, type: "Agent", description: "failed", state: "error", timestamp: 1 });
    const id = `id-${MAX_FLEET_ALERT_DETAILS}`;
    journal.report({ id, type: "Agent", description: "stopped", state: "killed", timestamp: 2 });
    expect(journal.count).toBe(MAX_FLEET_ALERT_DETAILS + 1);
    expect(journal.overflowCount).toBe(1);
    expect(journal.alerts).toHaveLength(MAX_FLEET_ALERT_DETAILS);
    const restored = new FleetJournal();
    restored.restore(() => entries, state => entries.push({ type: "custom", customType: FLEET_STATE_ENTRY, data: state }));
    restored.acknowledge(id);
    expect(restored.count).toBe(MAX_FLEET_ALERT_DETAILS);
    expect(restored.overflowCount).toBe(0);
    const saved = entries.at(-1)?.data;
    expect(saved).toMatchObject({ overflow: { error: 0, aborted: 0, failed: 0, killed: 0 }, transition: { alert: { id, state: "killed", timestamp: 2 }, acknowledged: true } });
  });
});
