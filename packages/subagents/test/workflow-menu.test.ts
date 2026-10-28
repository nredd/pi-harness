/** Inspector routing and stale-child outcomes, through the real dialog keys. */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { AgentRecord } from "../src/types.js";
import type { Theme } from "../src/ui/agent-widget.js";
import type { WorkflowDialog } from "../src/ui/workflow-dialog.js";
import { openWorkflowFromFleet, type WorkflowMenuDeps } from "../src/ui/workflow-menu.js";
import { createWorkflowTask } from "../src/workflow/task.js";
import { ctx } from "./helpers/boot-extension.js";

/** A single running child with a stable index, independent of row position. */
function inspector() {
  const task = createWorkflowTask({ id: "wf_selected", script: "", startTime: 1000 });
  task.workflowProgress = [{ type: "workflow_agent", index: 7, phaseIndex: 0, label: "child", state: "start", recordId: "child-id" }];
  task.agentCount = 1;
  const skip = vi.fn(() => false);
  const retry = vi.fn(() => false);
  task.control = { pause: vi.fn(), resume: vi.fn(), skip, retry };
  const hidden: boolean[] = [];
  let dialog: WorkflowDialog | undefined;
  const context = ctx({ ui: {
    notify: vi.fn(),
    custom: vi.fn(async (factory: (tui: TUI, theme: Theme, keys: undefined, done: () => void) => WorkflowDialog, options: { onHandle: (handle: { setHidden(value: boolean): void }) => void }) => {
      options.onHandle({ setHidden: value => hidden.push(value) });
      dialog = factory({ requestRender: vi.fn() } as unknown as TUI, { fg: (_color, text) => text, bold: text => text }, undefined, () => {});
      dialog.render(100);
      dialog.dispose();
      return undefined;
    }),
  } });
  const getRecord = vi.fn<WorkflowMenuDeps["getRecord"]>();
  const viewAgentConversation = vi.fn<WorkflowMenuDeps["viewAgentConversation"]>().mockResolvedValue(undefined);
  const getCtx = vi.fn((): ExtensionCommandContext | undefined => context);
  const deps: WorkflowMenuDeps = { tasks: new Map([[task.id, task]]), getRecord, viewAgentConversation, getCtx };
  return { task, skip, retry, hidden, context, deps, getRecord, viewAgentConversation, getCtx, dialog: () => {
    if (!dialog) throw new Error("inspector did not open");
    return dialog;
  } };
}

describe("workflow fleet inspector", () => {
  it("does not open a swept run or a run between sessions", async () => {
    const f = inspector();
    await openWorkflowFromFleet("missing", f.deps);
    f.getCtx.mockReturnValue(undefined);
    await openWorkflowFromFleet(f.task.id, f.deps);
    expect(f.context.ui.custom).not.toHaveBeenCalled();
  });

  it("reports a child swept after the dialog opened without opening an empty viewer", async () => {
    const f = inspector();
    await openWorkflowFromFleet(f.task.id, f.deps);
    f.dialog().handleInput("c");
    expect(f.getRecord).toHaveBeenCalledWith("child-id");
    expect(f.context.ui.notify).toHaveBeenCalledWith("No conversation left — agent records are dropped ten minutes after they finish.", "info");
    expect(f.viewAgentConversation).not.toHaveBeenCalled();
    expect(f.hidden).toEqual([]);
  });

  it.each([new Error("viewer broke"), "viewer broke"])("restores the inspector after viewer failure %s", async error => {
    const f = inspector();
    const record = { id: "child-id" } as AgentRecord;
    f.getRecord.mockReturnValue(record);
    f.viewAgentConversation.mockRejectedValue(error);
    await openWorkflowFromFleet(f.task.id, f.deps);
    f.dialog().handleInput("c");
    expect(f.hidden).toEqual([true]);
    await vi.waitFor(() => expect(f.hidden).toEqual([true, false]));
    expect(f.viewAgentConversation).toHaveBeenCalledWith(f.context, record);
    expect(f.context.ui.notify).toHaveBeenCalledWith("Could not open the conversation: viewer broke", "warning");
  });

  it("routes skip/retry to the selected runtime index and reports stale control outcomes", async () => {
    const f = inspector();
    await openWorkflowFromFleet(f.task.id, f.deps);
    f.dialog().handleInput("s");
    f.dialog().handleInput("r");
    expect(f.skip).toHaveBeenCalledWith(7);
    expect(f.retry).toHaveBeenCalledWith(7);
    expect(f.context.ui.notify).toHaveBeenCalledWith("Nothing to skip — that agent has already finished.", "info");
    expect(f.context.ui.notify).toHaveBeenCalledWith("Only a running agent can be retried.", "info");
    vi.mocked(f.context.ui.notify).mockClear();
    f.skip.mockReturnValue(true);
    f.retry.mockReturnValue(true);
    f.dialog().handleInput("s");
    f.dialog().handleInput("r");
    expect(f.context.ui.notify).not.toHaveBeenCalled();
  });
});
