/** Resumed workflow child thinking level after routing (#906), through the actual SubagentWorkflow tool and the run's agent pane. */
import { outcomes, toolCalls } from "@nredd/pi-test-lib/faux";
import { afterEach, expect, it, vi } from "vitest";
import { answer, ScenarioSession } from "./helpers/scenario-session.js";

let fixture: ScenarioSession;
afterEach(async () => {
  await fixture?.dispose();
  Reflect.deleteProperty(globalThis, Symbol.for("pi-subagents:manager"));
});

const SCRIPT =
  'export const meta = { name: "wf906", description: "x" }; await agent("first", { label: "probe child", model: "vroute/default", effort: "high" }); return await agent("again", { resume: "probe child" });';

it("resumed workflow child shows the level it ran at while running, not only at settle", async () => {
  fixture = new ScenarioSession({ workflowsEnabled: true });
  const hold = fixture.heldTool();
  // Physical model cannot reason: asked high, ran off. First run answers at once; the resume holds mid-run.
  const physical = fixture.physical("fauxphys", "physical", [answer("FIRST DONE"), toolCalls({ name: "hold", args: {} }), answer("SECOND DONE")], false);
  const h = await fixture.start({ terminal: true });
  const model = physical.getModel();
  h.session.modelRuntime.registerVirtualModel({
    provider: "vroute",
    id: "default",
    name: "vroute default",
    thinkingLevels: ["off", "low", "high"],
    route: async request => ({ model, thinkingLevel: request.thinkingLevel }),
  });
  h.setResponses([toolCalls({ name: "SubagentWorkflow", args: { script: SCRIPT } }), answer("STARTED")]);
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
  host.input("\x1b[B"); // the resume's row, the second agent
  await host.settle();
  // Resumed and held mid-run: already relabeled from the answered message.
  await vi.waitFor(async () => {
    await host.settle();
    fixture.clock.advance(1000);
    expect(host.viewport().join("\n")).toContain("thinking: off (asked high)");
  });
  expect(host.viewport().join("\n")).not.toContain("thinking: high");

  hold.release();
  await vi.waitFor(async () => {
    await host.settle();
    fixture.clock.advance(1000);
    const pane = host.viewport().join("\n");
    expect(pane).toContain("Completed");
    expect(pane).toContain("thinking: off (asked high)");
  });
});
