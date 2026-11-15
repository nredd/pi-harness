/** #779: a real invalidated extension context poisons a shared route, not its requesting child. */
import { readFileSync } from "node:fs";
import { createHarness, type Harness } from "@earendil-works/pi-coding-agent/testing";
import { toolCalls } from "@nredd/pi-test-lib/faux";
import { afterEach, expect, it, vi } from "vitest";
import { answer, ScenarioSession, spawn } from "./helpers/scenario-session.js";

let fixture: ScenarioSession;
let owner: Harness;
const controllers: AbortController[] = [];
afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.abort();
  await fixture?.dispose();
  owner?.cleanup();
});

it.each([false, true])("terminates captured-context failure without retrying, including a fresh launch (midrun=%s)", { timeout: 30_000 }, async (midrun) => {
  fixture = new ScenarioSession({ rememberAgents: true });
  owner = await createHarness({ cwd: fixture.cwd });
  await owner.session.bindExtensions({ mode: "print" });
  const captured = owner.session.extensionRunner.createContext();
  const hold = fixture.heldTool();
  const physical = fixture.physical("fauxphys", "physical", [toolCalls({ name: "hold", args: {} }), answer("UNREACHABLE")]);
  let routes = 0;
  const h = await fixture.start({ factories: [pi => {
    pi.registerVirtualModel({
      provider: "captured", id: "default", name: "Captured owner route",
      route: async (_request, ctx) => {
        routes++;
        // The request context is alive. The extension's captured owner is not.
        expect(ctx.session?.sessionManager).toBeDefined();
        captured.getSystemPrompt();
        return { model: physical.getModel() };
      },
    });
  }] });
  if (!midrun) owner.session.dispose();
  for (let attempt = 0; attempt < 2; attempt++) {
    h.setResponses([toolCalls(spawn(`attempt ${attempt}`, { model: "captured/default" })), answer("PARENT ALIVE")]);
    await h.session.prompt("launch");
    const result = h.session.messages.filter(m => m.role === "toolResult" && m.toolName === "Agent").at(-1);
    const id = result?.content.flatMap(p => p.type === "text" ? [p.text] : []).join("\n").match(/Agent ID: (\S+)/)?.[1];
    if (!id) throw new Error("No child id");
    const record = fixture.record(id);
    if (record.abortController) controllers.push(record.abortController);
    if (midrun && attempt === 0) {
      await hold.entered;
      owner.session.dispose();
      hold.release();
    }
    // Old code parks here for 1s/3s/9s, then appends three doomed prompts.
    let settled = false;
    void record.promise?.then(() => { settled = true; });
    await vi.waitFor(() => expect(settled, "stale context must settle without backoff or a doomed prompt").toBe(true), { timeout: 2_000 });
    await record.promise;
    expect(record.status).toBe("error");
    expect(record.error).toContain("extension context became stale");
    expect(record.error).toContain("invalidation trigger is unknown");
    expect(record.session?.messages.filter(m => m.role === "user")).toHaveLength(1);
    const errors = record.session?.messages.filter(m => m.role === "assistant" && m.stopReason === "error") ?? [];
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ usage: { totalTokens: 0 } });
    expect(record.session?.messages.filter(m => m.role === "toolResult")).toHaveLength(midrun && attempt === 0 ? 1 : 0);
    const file = record.session?.sessionManager.getSessionFile();
    if (!file) throw new Error("Missing persisted transcript");
    const transcript = readFileSync(file, "utf8");
    expect(transcript).toContain("This extension ctx is stale");
    if (!record.outputFile) throw new Error("Missing output transcript");
    expect(readFileSync(record.outputFile, "utf8")).toContain("This extension ctx is stale");
    if (midrun && attempt === 0) expect(transcript).toContain('"toolName":"hold"');
  }
  expect(routes).toBe(midrun ? 3 : 2);
});
