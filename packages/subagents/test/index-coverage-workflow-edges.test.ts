/** Workflow wiring edges: resume without a source, journal replay, a relative flag path, a tool already inactive. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension, { WORKFLOW_FILE_FLAG } from "../src/index.js";
import { ctx, flush, type Hermetic, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

const managerKey = Symbol.for("pi-subagents:manager");
const HEAD = 'export const meta = { name: "edge", description: "an edge probe" };\n';
const oneAgent = `${HEAD}return await agent("first");\n`;

let hermetic: Hermetic;
let lifecycle: Map<string, any> | undefined;

beforeEach(() => {
  vi.mocked(runAgent).mockReset();
  vi.mocked(runAgent).mockImplementation(async () => ({ responseText: "agent said hi", session: { dispose: vi.fn(), messages: [] }, aborted: false, steered: false }) as any);
});
afterEach(async () => {
  await lifecycle?.get("session_shutdown")?.();
  lifecycle = undefined;
  Reflect.deleteProperty(globalThis, managerKey);
  await flush();
  hermetic.restore();
});

function boot(settings: Record<string, unknown> = { workflowsEnabled: true }, flags: Record<string, boolean | string> = {}) {
  hermetic = hermeticDir({ settings: { schedulingEnabled: false, outputTranscript: false, ...settings } });
  const b = makePi(flags);
  subagentsExtension(b.pi);
  lifecycle = b.lifecycle;
  return b;
}
const workflowCtx = (overrides: Record<string, unknown> = {}) => ctx({ cwd: hermetic.dir, ...overrides });
const uiCtx = () => workflowCtx({ hasUI: true, ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn(), addAutocompleteProvider: vi.fn(), onTerminalInput: vi.fn(() => vi.fn()) } });

async function awaitSettled(b: ReturnType<typeof boot>, taskId: string) {
  await vi.waitFor(() => expect(b.pi.sendMessage.mock.calls.some((c: any[]) => String(c[0]?.content).includes(taskId))).toBe(true), { timeout: 10_000 });
}

describe("resuming a settled workflow", () => {
  it("re-runs its own script and replays the agent calls its journal recorded", async () => {
    const b = boot();
    const first = await b.tools.get("SubagentWorkflow").execute("tc-1", { script: oneAgent }, undefined, undefined, workflowCtx());
    const runId = /Task ID: (\S+)/.exec(textOf(first))![1];
    await awaitSettled(b, runId);
    expect(runAgent).toHaveBeenCalledTimes(1);

    // No script, path or name: the run id alone says what to run again.
    const resumed = await b.tools.get("SubagentWorkflow").execute("tc-2", { resumeFromRunId: runId }, undefined, undefined, workflowCtx());

    const text = textOf(resumed);
    const resumedId = /Task ID: (\S+)/.exec(text)![1];
    expect(text).toContain(`Resuming ${runId}: 1 recorded call(s) available to replay.`);
    await awaitSettled(b, resumedId);
    // Replayed from the journal: the second run paid for nothing.
    expect(runAgent).toHaveBeenCalledTimes(1);
  });
});

describe("a workflow whose script cannot be persisted", () => {
  it("still runs, without a saved script or journal", async () => {
    const b = boot();
    const blocked = join(hermetic.dir, "not-a-directory");
    writeFileSync(blocked, "");
    vi.stubEnv("TMPDIR", blocked);
    vi.stubEnv("XDG_STATE_HOME", join(blocked, "state"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await b.tools.get("SubagentWorkflow").execute("tc-1", { script: oneAgent }, undefined, undefined, workflowCtx());

      const text = textOf(result);
      expect(text).toContain('Workflow "edge" started in the background.');
      expect(text).not.toContain("Script: ");
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not persist workflow script"));
      await awaitSettled(b, /Task ID: (\S+)/.exec(text)![1]);
      expect(runAgent).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("--subagents-workflow-file", () => {
  it("resolves a relative path against the session cwd", async () => {
    const b = boot({ workflowsEnabled: true }, { [WORKFLOW_FILE_FLAG]: "flow.js" });
    writeFileSync(join(hermetic.dir, "flow.js"), oneAgent);
    const context = uiCtx();

    await b.lifecycle.get("session_start")?.({}, context);

    expect(context.ui.notify).toHaveBeenCalledWith("Running workflow edge…", "info");
    await vi.waitFor(() => expect(b.pi.appendEntry).toHaveBeenCalled(), { timeout: 10_000 });
  });

  it("runs once however often session_start fires", async () => {
    const b = boot({ workflowsEnabled: true }, { [WORKFLOW_FILE_FLAG]: "flow.js" });
    writeFileSync(join(hermetic.dir, "flow.js"), oneAgent);
    const context = uiCtx();

    await b.lifecycle.get("session_start")?.({}, context);
    await b.lifecycle.get("session_start")?.({}, context);

    expect(context.ui.notify.mock.calls.filter((c: any[]) => c[0] === "Running workflow edge…")).toHaveLength(1);
    await vi.waitFor(() => expect(b.pi.appendEntry).toHaveBeenCalled(), { timeout: 10_000 });
  });
});

describe("standing down for another workflow tool", () => {
  it("does not touch the active set when ours is already out of it", async () => {
    const b = boot({});
    mkdirSync(join(hermetic.dir, ".pi"), { recursive: true });
    b.pi.getAllTools.mockReturnValue([{ name: "Workflow", description: "another extension's tool", sourceInfo: { source: "other-ext", path: "/x/other.ts" } }]);
    b.pi.getActiveTools.mockReturnValue(["Agent"]);
    const context = uiCtx();

    await b.lifecycle.get("session_start")?.({}, context);

    expect(b.pi.setActiveTools).not.toHaveBeenCalled();
    expect(context.ui.notify.mock.calls.some((c: any[]) => /already provides a "Workflow" tool/.test(String(c[0])))).toBe(true);
  });
});
