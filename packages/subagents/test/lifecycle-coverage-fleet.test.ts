/** Fleet keys must act on the visible owner and recover after failed overlays. */
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { AgentManager } from "../src/agent-manager.js";
import type { AgentRecord } from "../src/types.js";
import type { Theme } from "../src/ui/agent-widget.js";
import type { ConversationViewer } from "../src/ui/conversation-viewer.js";
import { FleetList, type FleetUICtx } from "../src/ui/fleet-list.js";
import { FakeClock } from "./helpers/fake-clock.js";

const theme: Theme = { fg: (_color, text) => text, bold: text => text };

function fixture(sessionFor?: (record: AgentRecord) => AgentRecord["session"]) {
  const clock = new FakeClock();
  const session = { messages: [], subscribe: () => () => {} } as unknown as AgentSession;
  const record = { id: "observed", type: "general-purpose", description: "observed", status: "running", session, startedAt: clock.now(), toolUses: 0 } as AgentRecord;
  const abort = vi.fn(() => { record.status = "stopped"; return true; });
  const steer = vi.fn(() => true);
  let build: Exclude<Parameters<FleetUICtx["setWidget"]>[1], undefined> | undefined;
  let viewer: ConversationViewer | undefined;
  let finish!: () => void;
  let reject!: (error: Error) => void;
  const overlay = new Promise<undefined>((resolve, fail) => { finish = () => resolve(undefined); reject = fail; });
  const tui = { mode: "regular", terminal: { columns: 120, rows: 30 }, requestRender: vi.fn() };
  const custom = vi.fn((factory: Parameters<FleetUICtx["custom"]>[0]) => {
    viewer = factory(tui, theme, {}, finish) as ConversationViewer;
    return overlay;
  });
  const ui = { notify: vi.fn(), setWidget: vi.fn((_key, factory) => { build = factory; }), getEditorText: () => "", onTerminalInput: () => () => {}, custom } as unknown as FleetUICtx;
  const fleet = new FleetList({ listAgents: () => [record], abort, steer } as unknown as AgentManager, new Map(), () => false, undefined, undefined, () => "hidden", (_record, notify) => {
    notify("background action prepared");
    return { available: () => false, send: vi.fn() };
  }, () => false, () => [], clock, { sessionFor });
  fleet.setUICtx(ui);
  fleet.update();
  if (!build) throw new Error("fleet not registered");
  const component = build(tui, theme);
  const open = () => { fleet.handleKey("\x1b[B"); fleet.handleKey("\x1b[B"); fleet.handleKey("\r"); };
  return { fleet, ui, abort, steer, record, custom, overlay, finish, reject, open, component, viewer: () => {
    if (!viewer) throw new Error("viewer not built");
    return viewer;
  } };
}

describe("fleet overlay lifecycle", () => {
  it("reports a session lost by its lookup collaborator without opening or acknowledging a viewer", () => {
    const sessionFor = vi.fn(() => undefined);
    const f = fixture(sessionFor);
    try {
      f.open();
      expect(sessionFor).toHaveBeenCalledExactlyOnceWith(f.record);
      expect(f.ui.notify).toHaveBeenCalledWith("Agent is running — no session available.", "info");
      expect(f.custom).not.toHaveBeenCalled();
      expect(f.record.resultConsumed).not.toBe(true);
      expect(f.fleet.handleKey("\x1b[A")).toEqual({ consume: true });
    } finally { f.fleet.dispose(); }
  });

  it("opens the session supplied by the lookup collaborator", async () => {
    const f = fixture(record => record.session);
    try { f.open(); expect(f.custom).toHaveBeenCalledOnce(); f.finish(); await f.overlay; }
    finally { f.viewer().dispose(); f.fleet.dispose(); }
  });
  it("closes a live viewer during fleet disposal without registering the list again", async () => {
    const f = fixture();
    try {
      f.open();
      f.fleet.dispose();
      await f.overlay;
      expect(f.ui.setWidget).toHaveBeenLastCalledWith("fleet", undefined);
      expect(f.fleet.handleKey("\x1b[B")).toBeUndefined();
    } finally { f.viewer().dispose(); f.fleet.dispose(); }
  });

  it("returns navigation after the workflow inspector rejects without acknowledging it", async () => {
    const f = fixture();
    const open = vi.fn(() => Promise.reject(new Error("inspector failed")));
    const workflow = { id: "wf", name: "failed workflow", status: "failed" as const, doneCount: 0, totalCount: 1, startedAt: 1, completedAt: 2, tokens: 0 };
    f.fleet.setWorkflowSource(() => [workflow], open);
    try {
      f.open();
      await expect(open.mock.results[0].value).rejects.toThrow("inspector failed");
      expect(f.fleet.handleKey("\x1b[A")).toEqual({ consume: true });
      expect(f.custom).not.toHaveBeenCalled();
      // A rejected inspection must retain the unread alert even after its runtime disappears.
      f.fleet.setWorkflowSource(() => [], open);
      expect(f.component.render(120).join("\n")).toContain("failed workflow");
    } finally { f.fleet.dispose(); }
  });

  it("routes viewer stop and steer to its manager and surfaces the background-action notice", async () => {
    const f = fixture();
    try {
      f.open();
      const viewer = f.viewer();
      viewer.handleInput("\r");
      viewer.handleInput("new instruction");
      viewer.handleInput("\r");
      expect(f.steer).toHaveBeenCalledExactlyOnceWith("observed", "new instruction");
      viewer.handleInput("x");
      viewer.handleInput("x");
      expect(f.abort).toHaveBeenCalledExactlyOnceWith("observed");
      expect(f.ui.notify).toHaveBeenCalledWith('Stopped "observed".', "info");
      expect(f.ui.notify).toHaveBeenCalledWith("background action prepared", "info");
      f.finish();
      await f.overlay;
    } finally { f.viewer().dispose(); f.fleet.dispose(); }
  });

  it("returns keyboard navigation to the fleet after the overlay rejects", async () => {
    const f = fixture();
    f.record.status = "error";
    f.fleet.update();
    try {
      f.open();
      f.reject(new Error("overlay failed"));
      await expect(f.overlay).rejects.toThrow("overlay failed");
      expect(f.record.resultConsumed).not.toBe(true);
      expect(f.fleet.handleKey("\x1b[A")).toEqual({ consume: true });
    } finally { f.viewer().dispose(); f.fleet.dispose(); }
  });

  it("reports and acknowledges a workflow whose failed record has outlived its inspector", () => {
    const f = fixture();
    try {
      f.fleet.ingestFailure({ id: "gone-workflow", type: "workflow", description: "old run", status: "failed", startedAt: 1, completedAt: 2 });
      f.open(); // workflow is ahead of the agent in the roster
      expect(f.ui.notify).toHaveBeenCalledWith("workflow: old run (failed).", "error");
      expect(f.custom).not.toHaveBeenCalled();
      expect(f.component.render(120).join("\n")).not.toContain("old run");
    } finally { f.fleet.dispose(); }
  });
});
