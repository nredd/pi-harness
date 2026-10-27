/** Fleet disclosure policy, counts and width safety, independent of agent execution. */
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { AgentManager } from "../src/agent-manager.js";
import type { AgentRecord } from "../src/types.js";
import { FleetList, type FleetUICtx, type FleetWorkflow, renderFleetSummary } from "../src/ui/fleet-list.js";
import { FakeClock } from "./helpers/fake-clock.js";

const theme = {
  fg: (_color: string, text: string) => `\x1b[36m${text}\x1b[39m`,
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
};
const NOW = Date.parse("2020-01-01T00:00:00.000Z");
const record = (id: number, status: AgentRecord["status"] = "running"): AgentRecord => ({
  id: `a${id}`, type: "general-purpose", description: "調査 🧠 \x1b[31mlong description\x1b[39m".repeat(20),
  status, startedAt: NOW - 1000, completedAt: status === "running" || status === "queued" ? undefined : NOW,
  toolUses: 0, lifetimeUsage: { input: 100, output: 0, cacheWrite: 0, cost: 0.25 }, compactionCount: 0,
});
const workflow = (status: FleetWorkflow["status"]): FleetWorkflow => ({
  id: "wf_abc123", name: "audit", status, doneCount: 1, totalCount: 2, startedAt: NOW, completedAt: NOW, tokens: 100,
});

/** Real controller and component; no session is required to count pending starts. */
function setup(agents: AgentRecord[] = []) {
  const clock = new FakeClock();
  const abort = vi.fn();
  const steer = vi.fn();
  const fleet = new FleetList({ listAgents: () => agents, abort, steer } as unknown as AgentManager,
    new Map(), () => true, undefined, undefined, undefined, undefined, undefined, undefined, clock);
  let component: { render(width: number): string[]; invalidate(): void; dispose?(): void } | undefined;
  const tui: { requestRender(): void; focusedComponent?: unknown } = { requestRender: vi.fn() };
  let editor = "";
  const ui: FleetUICtx = {
    setWidget: (_key, factory) => { component = factory?.(tui, theme); },
    onTerminalInput: () => () => {}, getEditorText: () => editor,
    notify: vi.fn(), custom: () => new Promise(() => {}),
  };
  fleet.setUICtx(ui);
  fleet.update();
  return { fleet, ui, tui, clock, abort, steer, render: (width = 200) => component?.render(width) ?? [], setEditor: (text: string) => { editor = text; } };
}

/** A session need only exist to make an expanded row openable. */
function openable(id: number): AgentRecord {
  return { ...record(id), session: { messages: [], subscribe: () => () => {} } as unknown as NonNullable<AgentRecord["session"]> };
}

describe("collapsed fleet", () => {
  it.each([0, 1, 3, 8])("renders exactly one summary line for %i agents, without overflow or spacers", count => {
    const agents = Array.from({ length: count }, (_, i) => openable(i));
    const line = renderFleetSummary(agents, [], 0, true, 200, theme);
    expect(line.split("\n")).toHaveLength(1);
    expect(stripTerminalSequences(line)).toContain(`${count} running`);
    expect(line).not.toContain("more");
    const h = setup(agents);
    // Preserve the existing empty-state contract: no registered widget when idle.
    expect(h.render()).toHaveLength(count === 0 ? 0 : 1);
    if (count > 0) {
      h.fleet.toggleCollapse();
      expect(h.render()).toHaveLength(4 + Math.min(count, 5));
      h.fleet.toggleCollapse();
      expect(h.render()).toEqual([line]);
    }
    h.fleet.dispose();
  });

  it.each([
    ["running", "1 running"], ["queued", "1 queued"], ["completed", "1 done"],
    ["steered", "1 done"], ["error", "1 failed"], ["aborted", "1 failed"], ["stopped", "1 stopped"],
  ] as const)("counts %s including session-less/waiting records", (state, label) => {
    const h = setup([record(1, state)]);
    expect(stripTerminalSequences(h.render()[0])).toContain(label);
    if (state === "error" || state === "aborted") expect(stripTerminalSequences(h.render()[0])).toMatch(/^\[1 failed\]/);
    h.fleet.dispose();
  });

  it.each(["running", "paused", "completed", "failed", "killed"] as const)("counts %s workflow containers without counting children twice", state => {
    const child = { ...record(1), workflowId: "wf_abc123" };
    const nested = { ...record(2), parentAgentId: "a1" };
    const h = setup([child, nested]);
    h.fleet.setWorkflowSource(() => [workflow(state)], () => {});
    h.fleet.update();
    const label = state === "running" ? "running" : state === "paused" ? "paused" : state === "completed" ? "done" : "failed";
    const text = stripTerminalSequences(h.render()[0]);
    expect(text).toContain(`1 ${label}`);
    expect(text).not.toContain("2 running");
    expect(text).not.toContain("~$"); // child usage belongs to the workflow, not an independent agent
    h.fleet.dispose();
  });

  it("surfaces quota-parked work with no record and refreshes when it clears", () => {
    const h = setup();
    let parked = 2;
    h.fleet.setParkedSource(() => parked);
    h.fleet.update();
    expect(stripTerminalSequences(h.render()[0])).toMatch(/^\[2 parked\]/);
    expect(h.render()).toHaveLength(1);
    h.fleet.toggleCollapse(); // no openable rows: still one summary
    expect(h.render()).toHaveLength(1);
    parked = 0;
    h.fleet.update();
    expect(h.render()).toEqual([]);
    h.fleet.dispose();
  });

  it("totals mixed states and cost, with leading fallback independent of model display", () => {
    const agents = [record(1), record(2, "queued"), record(3, "completed"), record(4, "error"), record(5, "stopped"), record(6, "aborted")];
    agents[0].modelFallback = { input: "missing", used: "test/child" };
    const text = stripTerminalSequences(renderFleetSummary(agents, [], 2, true, 250, theme));
    expect(text).toBe("[2 failed, 2 parked, 1 fallback] agents: 1 running, 1 queued, 2 failed, 1 stopped, 1 done, 2 parked · ~$1.50 · ctrl+shift+a to expand");
    expect(renderFleetSummary(agents, [], 0, false, 250, theme)).not.toContain("~$");
    expect(renderFleetSummary([record(1)], [], 0, true, 250, theme)).toContain("~$0.25");
    agents[0].lifetimeUsage.cost = 0;
    expect(renderFleetSummary([agents[0]], [], 0, true, 250, theme)).not.toContain("~$");
  });

  it("keeps failure/parked/blocked/fallback counts ahead of truncation at every width 20..80", () => {
    const agents = [record(1, "error"), record(2)];
    agents[1].modelFallback = { input: "missing", used: "test/child" };
    for (let width = 20; width <= 80; width++) {
      const line = renderFleetSummary(agents, [workflow("paused")], 2, true, width, theme);
      const text = stripTerminalSequences(line);
      expect(visibleWidth(line), `${width}: ${text}`).toBeLessThanOrEqual(width);
      expect(line.split("\n")).toHaveLength(1);
      if (width < "[1 failed, 2 parked, 1 paused, 1 fallback]".length) expect(text).toMatch(/^\[E1 P2 B1 F1\]/);
      else expect(text).toMatch(/^\[1 failed, 2 parked, 1 paused, 1 fallback\]/);
      expect(line).not.toContain("\ufffd");
    }
  });

  it("retains explicit disclosure through ticks, roster growth, invalidation and UI rebind", () => {
    const agents = [openable(1)];
    const h = setup(agents);
    expect(h.render()).toHaveLength(1); // default, independent of roster size
    h.fleet.toggleCollapse();
    agents.push(openable(2), openable(3));
    h.clock.advance(200);
    expect(h.render()).toHaveLength(7);
    h.fleet.setUICtx({ ...h.ui });
    h.fleet.update();
    expect(h.render()).toHaveLength(7);
    h.fleet.toggleCollapse();
    h.clock.advance(200);
    expect(h.render()).toHaveLength(1);
    expect(h.abort).not.toHaveBeenCalled();
    expect(h.steer).not.toHaveBeenCalled();
    h.fleet.dispose();
  });

  it("temporarily expands for arrows, restores collapse on escape and preserves prompt input", () => {
    const h = setup([openable(1)]);
    h.setEditor("draft");
    expect(h.fleet.handleKey("\x1b[B")).toBeUndefined();
    expect(h.render()).toHaveLength(1);
    h.setEditor("");
    expect(h.fleet.handleKey("\x1b[D")).toEqual({ consume: true });
    expect(h.render()).toHaveLength(5);
    h.fleet.handleKey("\x1b");
    expect(h.render()).toHaveLength(1);
    // Toggle with a non-empty editor works without consuming/editing its draft.
    h.setEditor("draft");
    h.fleet.toggleCollapse();
    expect(h.render()).toHaveLength(5);
    h.fleet.handleKey("\x1b[B");
    expect(h.render()).toHaveLength(5);
    h.fleet.dispose();
  });

  it("never toggles a disabled fleet or steals disclosure from another focused component", () => {
    const h = setup([openable(1)]);
    h.tui.focusedComponent = { handleInput: () => {} };
    h.fleet.toggleCollapse();
    expect(h.render()).toHaveLength(1);
    h.fleet.setEnabled(false);
    h.fleet.toggleCollapse();
    expect(h.render()).toEqual([]);
    h.fleet.setEnabled(true);
    expect(h.render()).toHaveLength(1);
    h.fleet.dispose();
  });
});
