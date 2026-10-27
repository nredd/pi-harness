/**
 * fallback-flag-renderers.test.ts -- ONE table walks EVERY renderer that shows
 * model info with a fallback record and pathological text, and asserts the
 * fallback flag is present (compact for a narrow fleet), comes BEFORE the unbounded text, and the line
 * fits the width. A renderer that bypasses `src/ui/fallback-flag.ts` and appends
 * its marker after the label/stats fails here at the narrow widths.
 */
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { AgentManager } from "../src/agent-manager.js";
import type { TierDisclosure } from "../src/model-tiers.js";
import type { AgentRecord, NotificationDetails } from "../src/types.js";
import { AgentResultView } from "../src/ui/agent-row.js";
import { type AgentActivity, AgentWidget } from "../src/ui/agent-widget.js";
import { ConversationViewer } from "../src/ui/conversation-viewer.js";
import { hasFallback } from "../src/ui/fallback-flag.js";
import { FleetList, type FleetUICtx } from "../src/ui/fleet-list.js";
import { groupSummary, renderNotification } from "../src/ui/notification-view.js";
import { layoutWorkflowCard, plainWorkflowCardLines, type WorkflowCardTask } from "../src/ui/workflow-card.js";
import {
  initialWorkflowDialogState,
  layoutWorkflowDialog,
  plainWorkflowDialogLines,
  type WorkflowDialogInput,
} from "../src/ui/workflow-dialog.js";
import type { WorkflowAgentEntry } from "../src/workflow/progress.js";

const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s } as any;
const coloredTheme = { fg: (color: string, text: string) => `${color}:${text}`, bold: (text: string) => text } as any;
const FALLBACK = { input: "ghost", used: "anthropic/x" };
const NOTE = 'Note: configured model "ghost" did not resolve; running on parent model anthropic/x.';
const NOW = 10_000_000;

/** Pathological text: its first visible char is the marker the flag must precede. */
const UGLY = {
  ascii: "Z".repeat(300),
  cjk: "銀".repeat(150),
  emoji: "🧠".repeat(100),
  ansi: `\u001b[31m${"Z".repeat(300)}\u001b[0m`,
};

const strip = (s: string) => stripTerminalSequences(s).replace(/<\/?[a-zA-Z]+>/g, "");

interface Case {
  name: string;
  /** The rendered line that carries the unbounded text. */
  render: (ugly: string, width: number) => string;
  /** Widths where this renderer shows a row at all (the agent-level dialog has no list pane when narrow). */
  widths?: number[];
  /** Fleet rows compact the shared flag before clipping spend at narrow widths. */
  compactFlagAt?: number;
}

const record = (over: Partial<AgentRecord> = {}): AgentRecord =>
  ({
    id: "a1", type: "general-purpose", description: "d", status: "running", toolUses: 0, startedAt: NOW - 12_000,
    lifetimeUsage: { input: 3_200, output: 0, cacheWrite: 0 }, compactionCount: 0, modelFallback: FALLBACK, session: { subscribe: () => () => {}, messages: [] } as any, ...over,
  }) as AgentRecord;

function widgetLine(rec: AgentRecord, width: number, renderTheme = theme): string {
  const widget = new AgentWidget(
    { listAgents: () => [rec] } as unknown as AgentManager,
    new Map<string, AgentActivity>([[rec.id, { activeTools: new Map(), toolUses: 0, responseText: "", turnCount: 1 }]]),
    undefined, () => false, () => true,
  );
  let factory: any;
  widget.setUICtx({ setStatus: () => {}, setWidget: (_k: string, c: unknown) => { factory = c; } } as any);
  widget.update();
  const lines: string[] = factory({ terminal: { columns: width }, requestRender: () => {} }, renderTheme).render();
  return lines.find(l => l.includes("[fallback")) ?? lines.join("\n");
}

function fleetLine(rec: AgentRecord, width: number, renderTheme = theme): string {
  const fleet = new FleetList({ listAgents: () => [rec], abort: () => true, steer: vi.fn(() => true) } as unknown as AgentManager,
    new Map(), undefined, undefined, undefined, undefined, undefined, () => true);
  let factory: any;
  fleet.setUICtx({
    setWidget: (_k: string, c: unknown) => { factory = c; }, onTerminalInput: () => () => {}, getEditorText: () => "",
    notify: () => {}, custom: (() => new Promise(() => {})) as FleetUICtx["custom"],
  } as FleetUICtx);
  fleet.update();
  const lines: string[] = factory({ requestRender: () => {}, terminal: { columns: width, rows: 40 } }, renderTheme).render(width);
  return lines.find(l => /\[fallback|\[fb\]|^\s*[●○]\s+!/.test(l)) ?? lines.join("\n");
}

const agentEntry = (over: Partial<WorkflowAgentEntry>): WorkflowAgentEntry =>
  ({ type: "workflow_agent", index: 0, label: "agent-0", phaseIndex: 0, state: "done", modelNote: NOTE, ...over }) as WorkflowAgentEntry;

const task: WorkflowCardTask = { status: "running", workflowName: "wf", startTime: NOW };

function dialogInput(width: number, progress: WorkflowAgentEntry[], level: "phases" | "agent" = "phases"): WorkflowDialogInput {
  return { width, now: NOW + 1000, task, progress, state: { ...initialWorkflowDialogState(), level } } as unknown as WorkflowDialogInput;
}

const notice = (over: Partial<NotificationDetails>): NotificationDetails => ({
  id: "a", description: "d", status: "completed", toolUses: 1, turnCount: 1, totalTokens: 1, durationMs: 1, resultPreview: "r", ...over,
});

const TIER_FLAGS: { modelTier: TierDisclosure; flag: string }[] = [
  { modelTier: { kind: "routed", tier: "cheap", profile: "router/cheap", model: { provider: "router", id: "cheap", name: "Cheap", api: "pi-virtual" } }, flag: "[@cheap]" },
  { modelTier: { kind: "static", tier: "cheap", member: "fixture/fast", model: { provider: "fixture", id: "fast", name: "Fast", api: "openai-completions" }, skipped: [], quotaSignal: true }, flag: "[@cheap]" },
  { modelTier: { kind: "unavailable", tier: "cheap", tried: ["router/cheap"] }, flag: "[@cheap unavailable]" },
];

it("workflow cards use the actual tier flag ahead of long labels, not a healthy fallback", () => {
  for (const { modelTier, flag } of TIER_FLAGS) {
    for (const width of [40, 80, 120]) {
      const lines = plainWorkflowCardLines(layoutWorkflowCard({ width, now: NOW, task,
        progress: [agentEntry({ label: UGLY.ascii, modelNote: undefined, modelTier })] }));
      const row = lines.find(line => line.includes(flag));
      expect(row, lines.join("\n")).toBeDefined();
      expect(row).not.toContain("[fallback]");
      if (!row) throw new Error("Missing tier card row");
      expect(row.indexOf(flag)).toBeLessThan(row.indexOf("Z"));
      expect(visibleWidth(row)).toBeLessThanOrEqual(width);
    }
  }
});

it("keeps a routed response without an admission label healthy across every renderer", () => {
  const routedWithoutAdmission: TierDisclosure = { ...TIER_FLAGS[0]!.modelTier, answered: "fixture/fast" };
  const switched: TierDisclosure = { ...routedWithoutAdmission, admitted: "fixture/fast", answered: "fixture/safer" };
  expect(hasFallback({ modelTier: routedWithoutAdmission })).toBe(false);
  expect(hasFallback({ modelTier: switched })).toBe(true);

  const neutralCard = layoutWorkflowCard({ width: 120, now: NOW, task, progress: [agentEntry({ modelTier: routedWithoutAdmission })] });
  const warningCard = layoutWorkflowCard({ width: 120, now: NOW, task, progress: [agentEntry({ modelTier: switched })] });
  expect(neutralCard.flat().find(segment => segment.text.includes("[@cheap]"))).toMatchObject({ color: "dim" });
  expect(warningCard.flat().find(segment => segment.text.includes("[@cheap]"))).toMatchObject({ color: "warning" });

  const neutralDialog = layoutWorkflowDialog(dialogInput(120, [agentEntry({ modelTier: routedWithoutAdmission })]));
  const warningDialog = layoutWorkflowDialog(dialogInput(120, [agentEntry({ modelTier: switched })]));
  expect(neutralDialog.flat().find(segment => segment.text.includes("[@cheap]"))).toMatchObject({ color: "dim" });
  expect(warningDialog.flat().find(segment => segment.text.includes("[@cheap]"))).toMatchObject({ color: "warning" });

  const neutralNotice = strip(renderNotification(notice({ modelTier: routedWithoutAdmission }), false, coloredTheme, false).render(120)[0]!);
  const warningNotice = strip(renderNotification(notice({ modelTier: switched }), false, coloredTheme, false).render(120)[0]!);
  expect(neutralNotice).toContain("dim:[@cheap]");
  expect(neutralNotice).not.toContain("warning:");
  expect(warningNotice).toContain("warning:[@cheap]");
  expect(groupSummary([notice({ modelTier: routedWithoutAdmission }), notice({ modelTier: switched })], coloredTheme)).toContain("warning:[@cheap]");

  const details = { displayName: "x", description: "d", subagentType: "x", toolUses: 0, tokens: "", durationMs: 0, status: "completed", agentId: "a1", modelTier: routedWithoutAdmission } as any;
  const row = new AgentResultView(details, "", false, { getRecord: () => undefined, getActivity: () => undefined, showCost: () => false }, coloredTheme).render(120).join("\n");
  expect(strip(row)).toContain("dim:[@cheap]");
  expect(strip(row)).not.toContain("warning:");

  const tierRecord = record({ modelFallback: undefined, modelTier: routedWithoutAdmission });
  expect(strip(widgetLine(tierRecord, 120, coloredTheme))).toContain("dim:[@cheap]");
  expect(strip(fleetLine(tierRecord, 120, coloredTheme))).toContain("dim:[@cheap]");
});

it("individual and grouped notices distinguish tiers, outcome and real fallback counts", () => {
  for (const { modelTier, flag } of TIER_FLAGS) {
    const member = notice({ description: UGLY.ascii, modelTier });
    const individual = strip(renderNotification(member, false, theme, false).render(120)[0]!);
    expect(individual).toContain(flag);
    expect(individual).not.toContain("[fallback]");
    const grouped = groupSummary([member, notice({ modelTier }), notice({ modelNote: NOTE })], theme);
    expect(grouped).toContain(flag.replace("]", " x2]"));
    expect(grouped).toContain("[fallback]");
    expect(grouped).not.toContain("[fallback x3]");
    expect(grouped.indexOf(flag.replace("]", " x2]"))).toBeLessThan(grouped.indexOf("Z"));
  }
  const mixed = groupSummary([notice({ modelTier: TIER_FLAGS[0]!.modelTier }), notice({ modelTier: { kind: "unmapped", tier: "deep" } })], theme);
  expect(mixed).toContain("[@cheap]");
  expect(mixed).toContain("[@deep unmapped]");
  expect(mixed).not.toContain("[fallback");
});

const CASES: Case[] = [
  { name: "notice (individual)", render: (u, w) => renderNotification(notice({ description: u, modelNote: NOTE }), false, theme, true).render(w)[0]! },
  {
    name: "notice (group, fallback member last)",
    render: (u, w) => {
      const members = [notice({ id: "a", description: u }), notice({ id: "b", description: u }), notice({ id: "c", description: "last", modelNote: NOTE })];
      return renderNotification({ ...members[0]!, others: members.slice(1) }, false, theme, true).render(w)[0]! + groupSummary.name.slice(0, 0);
    },
  },
  { name: "agent widget (running)", render: (u, w) => widgetLine(record({ description: u }), w) },
  { name: "agent widget (finished)", render: (u, w) => widgetLine(record({ description: u, status: "completed", completedAt: NOW }), w) },
  {
    name: "agent row summary (error)",
    render: (u, w) => {
      const rec = record({ status: "error", error: u });
      const details = { displayName: "x", description: "d", subagentType: "x", toolUses: 0, tokens: "", durationMs: 0, status: "error", agentId: "a1", error: u, modelFallback: FALLBACK } as any;
      return new AgentResultView(details, "", false, { getRecord: () => rec, getActivity: () => undefined, showCost: () => false }, theme).render(w)[0]!;
    },
  },
  {
    name: "agent row tags line (expanded, long model)",
    render: (u, w) => {
      const details = { displayName: "x", description: "d", subagentType: "x", toolUses: 0, tokens: "", durationMs: 0, status: "completed", agentId: "a1", modelName: u, modelFallback: FALLBACK } as any;
      const lines = new AgentResultView(details, "", true, { getRecord: () => undefined, getActivity: () => undefined, showCost: () => false }, theme).render(w);
      return lines.find(l => l.includes("↳")) ?? lines.join("\n");
    },
  },
  {
    name: "workflow card agent row",
    render: (u, w) => plainWorkflowCardLines(layoutWorkflowCard({ width: w, now: NOW + 1000, task, progress: [agentEntry({ label: u })] })).find(l => l.includes("[fallback")) ?? "",
  },
  {
    name: "workflow dialog agent list row",
    render: (u, w) => plainWorkflowDialogLines(layoutWorkflowDialog(dialogInput(w, [agentEntry({ label: u })]))).find(l => l.includes("[fallback")) ?? "",
  },
  {
    // At 40 columns the agent-level list pane is ~10 columns wide, so the flag is
    // clipped to a fragment there; that KNOWN LIMIT is asserted below (and in the
    // README), not in this matrix.
    name: "workflow dialog agent list row (agent level)",
    widths: [80, 120],
    render: (u, w) => plainWorkflowDialogLines(layoutWorkflowDialog(dialogInput(w, [agentEntry({ label: u })], "agent"))).find(l => l.includes("[fallback")) ?? "",
  },
  {
    name: "conversation viewer invocation row",
    render: (u, w) => {
      const viewer = new ConversationViewer(
        { terminal: { rows: 30, columns: w }, requestRender: vi.fn() } as any,
        { messages: [], subscribe: vi.fn(() => vi.fn()), dispose: vi.fn(), getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheWrite: 0 } }) } as any,
        record({ invocation: { modelId: u, modelName: "m" } }), undefined, theme, vi.fn(),
      );
      const lines = viewer.render(w);
      return lines.find(l => l.includes("↳")) ?? lines.join("\n");
    },
  },
  { name: "fleet list row", compactFlagAt: 40, render: (u, w) => fleetLine(record({ description: u, invocation: { modelName: u } }), w) },
];

describe("every renderer keeps a leading [fallback] flag that unbounded text cannot hide", () => {
  for (const c of CASES) {
    for (const [kind, ugly] of Object.entries(UGLY)) {
      for (const width of c.widths ?? [40, 80, 120]) {
        it(`${c.name} / ${kind} / ${width} cols`, () => {
          const line = c.render(ugly, width);
          const text = strip(line);
          const flagAt = c.compactFlagAt !== undefined && width <= c.compactFlagAt
            ? text.search(/\[fallback|\[fb\]|!/)
            : text.indexOf("[fallback");
          expect(flagAt, `flag missing in: ${JSON.stringify(text)}`).toBeGreaterThanOrEqual(0);
          const marker = strip(ugly)[0]!;
          const markerAt = text.indexOf(marker);
          if (markerAt >= 0) expect(flagAt, `flag after unbounded text: ${JSON.stringify(text)}`).toBeLessThan(markerAt);
          expect(visibleWidth(line), JSON.stringify(text)).toBeLessThanOrEqual(width);
        });
      }
    }
  }

  it("the workflow dialog detail pane WRAPS the note instead of clamping it", () => {
    const longNote = `Note: configured model "${"Q".repeat(120)}" did not resolve; running on parent model anthropic/x.`;
    const lines = plainWorkflowDialogLines(layoutWorkflowDialog(dialogInput(70, [agentEntry({ modelNote: longNote })], "agent")));
    const joined = lines.map(l => l.replace(/[^A-Za-z]/g, "")).join("");
    expect(joined).toContain("Q".repeat(120));
    for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(70);
  });

  describe("known limits: the workflow dialog at narrow widths (tracked in nredd/pi-harness issue, see README)", () => {
    it("at 40 columns the agent-level list pane is narrow and shows only a fragment of the flag", () => {
      const lines = plainWorkflowDialogLines(layoutWorkflowDialog(dialogInput(40, [agentEntry({ label: UGLY.ascii })], "agent")));
      const listRow = lines.find(l => l.includes("✔ [fal"));
      expect(listRow, lines.join("\n")).toBeDefined();
      expect(listRow).not.toContain("[fallback]");
      for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(40);
    });

    it("a very long note in the detail pane is clamped to the pane capacity, not shown in full", () => {
      const longNote = `Note: ${"Q".repeat(2000)}`;
      const lines = plainWorkflowDialogLines(layoutWorkflowDialog(dialogInput(40, [agentEntry({ modelNote: longNote })], "agent")));
      const shown = lines.join("").replace(/[^Q]/g, "").length;
      expect(shown).toBeGreaterThan(0);
      expect(shown).toBeLessThan(2000);
    });
  });
});
