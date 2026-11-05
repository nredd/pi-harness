/**
 * branch-coverage-workflow-views.test.ts — the run record, its progress model
 * and the views that draw it, on the paths the suite-wide tests never take.
 *
 * Each case pins one outcome a reader or the model would see: a resume message
 * that names the runs it could have meant, a notification that still reads
 * when the run carries no name or error, a dialog that stops repainting once
 * it is cancelled. They are grouped by module, not by scenario.
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TierDisclosure } from "../src/model-tiers.js";
import type { Theme } from "../src/ui/agent-widget.js";
import { renderWorkflowEntryCard, type WorkflowCardTask } from "../src/ui/workflow-card.js";
import {
  initialWorkflowDialogState,
  layoutWorkflowDialog,
  plainWorkflowDialogLines,
  WORKFLOW_DIALOG_SPINNER_MS,
  WorkflowDialog,
  type WorkflowDialogInput,
  type WorkflowDialogSource,
  type WorkflowDialogState,
} from "../src/ui/workflow-dialog.js";
import { openWorkflowFromFleet, showWorkflowsMenu, type WorkflowMenuDeps } from "../src/ui/workflow-menu.js";
import { workflowEntryData } from "../src/workflow/entry.js";
import { extractMeta } from "../src/workflow/meta.js";
import { buildPhaseGroups, gerund, type WorkflowAgentEntry, type WorkflowEntry } from "../src/workflow/progress.js";
import {
  createWorkflowTask,
  formatWorkflowNotification,
  resolveResumeTarget,
  updateWorkflowProgressBatch,
  type WorkflowTask,
} from "../src/workflow/task.js";
import { ctx } from "./helpers/boot-extension.js";

const START = 1_000_000;
const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function agent(partial: Partial<WorkflowAgentEntry> & { index: number }): WorkflowAgentEntry {
  return { type: "workflow_agent", label: `agent-${partial.index}`, phaseIndex: 0, state: "start", ...partial };
}

function settled(id: string, over: Partial<WorkflowTask> = {}): WorkflowTask {
  return Object.assign(createWorkflowTask({ id, script: "", startTime: START }), { status: "completed", endTime: START + 10 }, over);
}

describe("workflow task record", () => {
  it("treats an empty batch as no change, so a renderer sees the same version", () => {
    const task = createWorkflowTask({ id: "wf_empty", script: "", startTime: START });
    updateWorkflowProgressBatch(task, []);
    expect(task.progressVersion).toBe(0);
    updateWorkflowProgressBatch(task, [agent({ index: 0 })]);
    expect(task.progressVersion).toBe(1);
  });

  it("names this session's runs when a resume id matches none of them", () => {
    const tasks = new Map([["wf_known", settled("wf_known")]]);
    expect(resolveResumeTarget("wf_typo", tasks)).toEqual({
      ok: false,
      message: 'No workflow run "wf_typo" in this session. Runs this session: wf_known.',
    });
  });

  it("resumes a run without a script file from an empty script path", () => {
    const tasks = new Map([["wf_inline", settled("wf_inline", { journalPath: "/tmp/journal.jsonl" })]]);
    expect(resolveResumeTarget("wf_inline", tasks)).toEqual({
      ok: true, runId: "wf_inline", journalPath: "/tmp/journal.jsonl", scriptPath: "",
    });
  });

  it("reports a failure with no message, and an unnamed run, by what it has", () => {
    const text = formatWorkflowNotification(settled("wf_bare", { status: "failed" }), START + 10);
    expect(text).toContain("<status>Error: unknown</status>");
    expect(text).toContain('<summary>Workflow "wf_bare" failed');
  });

  it("credits replayed agents to the run they came from, or to an earlier run when unnamed", () => {
    const named = formatWorkflowNotification(settled("wf_r", { replayedCount: 2, resumedFrom: "wf_prev" }), START + 10);
    expect(named).toContain(", 2 replayed from wf_prev</summary>");
    const anonymous = formatWorkflowNotification(settled("wf_r", { replayedCount: 1 }), START + 10);
    expect(anonymous).toContain(", 1 replayed from an earlier run</summary>");
    expect(formatWorkflowNotification(settled("wf_r"), START + 10)).not.toContain("replayed from");
  });

  it("truncates a long result in the notification and says so", () => {
    const text = formatWorkflowNotification(settled("wf_long", { value: "x".repeat(5000) }), START + 10);
    expect(text).toContain(`<result>${"x".repeat(4000)}\n...(truncated)</result>`);
  });
});

describe("workflow session entry", () => {
  it("falls back to the run id and omits meta for an unnamed run", () => {
    const data = workflowEntryData(settled("wf_entry"));
    expect(data.name).toBe("wf_entry");
    expect(data).not.toHaveProperty("meta");
  });

  it("draws nothing for an entry that carries no data", () => {
    expect(renderWorkflowEntryCard(undefined, plainTheme)).toBeUndefined();
  });
});

describe("workflow progress", () => {
  it("files an un-phased agent under phase 0 once any agent declares a phase", () => {
    const groups = buildPhaseGroups([agent({ index: 0, phaseIndex: undefined }), agent({ index: 1, phaseIndex: 1 })]);
    expect(groups.map(group => [group.title, group.agents.map(a => a.label)])).toEqual([
      ["Phase 0", ["agent-0"]],
      ["Phase 1", ["agent-1"]],
    ]);
  });

  it.each([
    ["Write", "Writing"],
    ["Agree", "Agreeing"],
    ["Dye", "Dyeing"],
  ])("handles the final e of %s", (input, expected) => {
    expect(gerund(input)).toBe(expected);
  });
});

describe("workflow meta scanner", () => {
  it("ends an unterminated string at the line break, so the brace after it still closes meta", () => {
    expect(() => extractMeta("export const meta = { name: 'x\n}\nreturn 1;")).toThrow(/could not be evaluated/);
  });

  it("skips an escaped backtick inside a template string", () => {
    const parsed = extractMeta("export const meta = { name: `say \\`hi\\``, description: `d` };\nreturn 1;");
    expect(parsed.meta.name).toBe("say `hi`");
  });

  it("quotes a host-side syntax error by its message alone", () => {
    expect(() => extractMeta('export const meta = { name: "x" description: "y" };')).toThrow(
      /could not be evaluated: Unexpected identifier 'description'\n/,
    );
  });
});

function dialogInput(progress: readonly WorkflowEntry[], state: Partial<WorkflowDialogState> = {}): WorkflowDialogInput {
  const task: WorkflowCardTask = { status: "running", workflowName: "views", startTime: START };
  return { width: 100, now: START + 1000, progress, task, state: { ...initialWorkflowDialogState(), ...state } };
}

const routed: TierDisclosure = {
  kind: "routed", tier: "cheap", profile: "router/cheap",
  model: { provider: "router", id: "cheap", name: "Cheap", api: "pi-virtual" },
} as TierDisclosure;

describe("workflow dialog layout", () => {
  it("lays out at the default width when none is given", () => {
    const { width: _width, ...unsized } = dialogInput([agent({ index: 0 })]);
    expect(layoutWorkflowDialog(unsized)).toEqual(layoutWorkflowDialog({ ...unsized, width: 80 }));
  });

  it("highlights only the selected compact row's label beside its tier flag", () => {
    const lines = layoutWorkflowDialog(
      dialogInput([
        agent({ index: 1, label: "one", modelTier: routed }),
        agent({ index: 2, label: "two", modelTier: routed }),
      ], { level: "agent" }),
    );
    const segments = lines.flat();
    expect(segments.find(segment => segment.text === " one")).toMatchObject({ color: "accent" });
    expect(segments.find(segment => segment.text === " two")).toEqual({ text: " two", color: undefined });
  });

  it("colours a failed phase that is not selected as an error", () => {
    const lines = layoutWorkflowDialog(dialogInput([
      { type: "workflow_phase", index: 0, title: "Scan" },
      { type: "workflow_phase", index: 1, title: "Verify" },
      agent({ index: 0, phaseIndex: 0 }),
      agent({ index: 1, phaseIndex: 1, state: "error" }),
    ]));
    expect(lines.flat().find(segment => segment.text === "Verify")).toMatchObject({ color: "error" });
  });

  it("counts a single hidden prompt line in the singular", () => {
    const prompt = ["one", "two", "three", "four", "five"].join("\n");
    const text = plainWorkflowDialogLines(
      layoutWorkflowDialog(dialogInput([agent({ index: 0, promptPreview: prompt })], { level: "agent" })),
    ).join("\n");
    expect(text).toMatch(/1 more line\s*│/);
    expect(text).not.toContain("1 more lines");
  });
});

describe("workflow dialog component", () => {
  const source = (): WorkflowDialogSource => {
    const { state: _state, width: _width, now: _now, ...rest } = dialogInput([agent({ index: 0 })]);
    return rest;
  };

  it("stops repainting on the spinner once cancelled, before it is disposed", () => {
    vi.useFakeTimers();
    const requestRender = vi.fn();
    const done = vi.fn();
    const dialog = new WorkflowDialog({ requestRender } as unknown as TUI, source, plainTheme, done);
    vi.advanceTimersByTime(WORKFLOW_DIALOG_SPINNER_MS);
    expect(requestRender).toHaveBeenCalledTimes(1);

    dialog.handleInput("\x03");
    expect(done).toHaveBeenCalledWith(undefined);
    requestRender.mockClear();
    vi.advanceTimersByTime(WORKFLOW_DIALOG_SPINNER_MS * 3);
    expect(requestRender).not.toHaveBeenCalled();
    dialog.dispose();
  });

  it("ignores an unbound key without repainting", () => {
    const requestRender = vi.fn();
    const dialog = new WorkflowDialog({ requestRender } as unknown as TUI, source, plainTheme, () => {});
    dialog.handleInput("z");
    expect(requestRender).not.toHaveBeenCalled();
    dialog.dispose();
  });

  it("clears its spinner timer once, however often it is disposed", () => {
    const clear = vi.spyOn(globalThis, "clearInterval");
    const dialog = new WorkflowDialog({ requestRender: vi.fn() } as unknown as TUI, source, plainTheme, () => {});
    dialog.dispose();
    dialog.dispose();
    expect(clear).toHaveBeenCalledTimes(1);
  });
});

/** Opens `task` through the fleet entry point and hands back the live dialog. */
function inspect(task: WorkflowTask) {
  let dialog: WorkflowDialog | undefined;
  const context = ctx({ ui: {
    notify: vi.fn(),
    custom: vi.fn(async (factory: (tui: TUI, theme: Theme, keys: undefined, done: () => void) => WorkflowDialog) => {
      dialog = factory({ requestRender: vi.fn() } as unknown as TUI, plainTheme, undefined, () => {});
      dialog.dispose();
      return undefined;
    }),
  } }) as unknown as ExtensionCommandContext;
  const deps: WorkflowMenuDeps = {
    tasks: new Map([[task.id, task]]),
    getRecord: () => undefined,
    viewAgentConversation: async () => {},
    getCtx: () => context,
  };
  return { context, deps, key: (data: string) => dialog?.handleInput(data) };
}

describe("workflow menu", () => {
  it("names an unnamed run by its id when it is stopped", async () => {
    const task = createWorkflowTask({ id: "wf_unnamed", script: "", startTime: START });
    const f = inspect(task);
    await openWorkflowFromFleet(task.id, f.deps);
    f.key("x");
    expect(task.abortController.signal.aborted).toBe(true);
    expect(f.context.ui.notify).toHaveBeenCalledWith('Stopped workflow "wf_unnamed".', "info");
  });

  it("says nothing when a run without a control handle cannot pause or resume", async () => {
    const running = createWorkflowTask({ id: "wf_running", script: "", startTime: START });
    const f = inspect(running);
    await openWorkflowFromFleet(running.id, f.deps);
    f.key("p");
    expect(running.status).toBe("running");

    const paused = Object.assign(createWorkflowTask({ id: "wf_paused", script: "", startTime: START }), { status: "paused" as const });
    const g = inspect(paused);
    await openWorkflowFromFleet(paused.id, g.deps);
    g.key("p");
    expect(paused.status).toBe("paused");

    expect(f.context.ui.notify).not.toHaveBeenCalled();
    expect(g.context.ui.notify).not.toHaveBeenCalled();
  });

  it("labels each run by name or id with a singular or plural agent count", async () => {
    const lone = Object.assign(createWorkflowTask({ id: "wf_lone", script: "", startTime: START + 1 }), { agentCount: 1 });
    const named = Object.assign(
      createWorkflowTask({ id: "wf_named", script: "", startTime: START, meta: { name: "review", description: "d" } }),
      { agentCount: 2, status: "completed" as const },
    );
    const select = vi.fn(async () => undefined);
    const context = ctx({ ui: { notify: vi.fn(), select, custom: vi.fn() } }) as unknown as ExtensionCommandContext;
    await showWorkflowsMenu(context, {
      tasks: new Map([[lone.id, lone], [named.id, named]]),
      getRecord: () => undefined,
      viewAgentConversation: async () => {},
      getCtx: () => context,
    });
    expect(select).toHaveBeenCalledWith("Workflows", [
      "wf_lone — running, 1 agent · wf_lone",
      "review — completed, 2 agents · wf_named",
    ]);
    expect(context.ui.custom).not.toHaveBeenCalled();
  });
});
