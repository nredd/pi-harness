/** Workflow card thinking level after routing (#886), through the actual SubagentWorkflow tool and the run's agent pane. */
import { afterEach, expect, it, vi } from "vitest";
import { answer, calls, outcomes, ScenarioSession } from "./helpers/scenario-session.js";

let fixture: ScenarioSession;
afterEach(async () => {
  await fixture?.dispose();
  Reflect.deleteProperty(globalThis, Symbol.for("pi-subagents:manager"));
});

const SCRIPT =
  'export const meta = { name: "wf886", description: "x" }; return await agent("probe", { label: "probe child", model: "vroute/default", effort: "high" });';

it("workflow card relabels thinking after routing, while running and after settle", async () => {
  fixture = new ScenarioSession({ workflowsEnabled: true });
  const hold = fixture.heldTool();
  // Physical model cannot reason: asked high, ran off. No modelTier on a plain virtual model.
  const physical = fixture.physical("fauxphys", "physical", [calls({ name: "hold", args: {} }), answer("CHILD DONE")], false);
  const h = await fixture.start({ terminal: true });
  const model = physical.getModel();
  h.session.modelRuntime.registerVirtualModel({
    provider: "vroute",
    id: "default",
    name: "vroute default",
    thinkingLevels: ["off", "low", "high"],
    route: async request => ({ model, thinkingLevel: request.thinkingLevel }),
  });
  h.setResponses([calls({ name: "SubagentWorkflow", args: { script: SCRIPT } }), answer("STARTED")]);
  await h.session.prompt("go");
  expect(outcomes(h, "SubagentWorkflow")[0]?.text).toContain("Task ID:");
  await hold.entered;
  const host = fixture.host;
  if (!host) throw new Error("No terminal host");
  host.input("\x1b[97;6u"); // open the fleet list
  await host.settle();
  host.input("\x1b[B");
  await host.settle();
  host.input("\x1b[B");
  await host.settle();
  host.input("\r"); // open the run's dialog
  await host.settle();
  host.input("\r"); // open the selected agent
  await host.settle();
  // Running, after the first answered message: the physical model and the level it really ran at.
  fixture.clock.advance(1000);
  await vi.waitFor(async () => {
    await host.settle();
    fixture.clock.advance(1000);
    expect(host.viewport().join("\n")).toContain("thinking: off (asked high)");
  });
  expect(host.viewport().join("\n")).not.toContain("thinking: high");

  hold.release();
  // Settled: the same agent pane, now done, keeps the level it ran at.
  await vi.waitFor(async () => {
    await host.settle();
    fixture.clock.advance(1000);
    const pane = host.viewport().join("\n");
    expect(pane).toContain("Completed");
    expect(pane).toContain("thinking: off (asked high)");
    expect(pane).not.toContain("thinking: high");
  });
});
