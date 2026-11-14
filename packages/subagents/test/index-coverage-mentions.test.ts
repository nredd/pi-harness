/** `@handle` mention edges: a record with no handle, a finished record with no session, a tier-carrying resume. */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});
vi.mock("../src/mention-clone.js", () => ({ runMentionClone: vi.fn() }));

import { resumeAgent, runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { bootPi, ctx, flush, type Hermetic, hermeticDir, textOf } from "./helpers/boot-extension.js";

const managerKey = Symbol.for("pi-subagents:manager");
const registry = () => (globalThis as any)[managerKey];

let hermetic: Hermetic | undefined;
let lifecycle: Map<string, any> | undefined;

beforeEach(() => {
  vi.mocked(runAgent).mockReset();
  vi.mocked(resumeAgent).mockReset();
});
afterEach(async () => {
  await lifecycle?.get("session_shutdown")?.();
  Reflect.deleteProperty(globalThis, managerKey);
  lifecycle = undefined;
  hermetic?.restore();
  hermetic = undefined;
});

function boot(settings: Record<string, unknown> = {}) {
  hermetic = hermeticDir({ settings: { outputTranscript: false, agentMentions: "direct", ...settings } });
  const b = bootPi();
  subagentsExtension(b.pi);
  lifecycle = b.lifecycle;
  return b;
}

const fakeSession = () => ({ steer: vi.fn().mockResolvedValue(undefined), dispose: vi.fn(), subscribe: vi.fn(() => () => {}), messages: [], getActiveToolNames: vi.fn(() => []) }) as any;
const send = (text: string, uiCtx = ctx()) => lifecycle!.get("input")({ type: "input", text, source: "interactive" }, uiCtx);

async function spawnBackground(tools: Map<string, any>): Promise<string> {
  const r = await tools.get("Agent").execute(
    "tc-spawn", { prompt: "go", description: "find flaky tests", subagent_type: "Explore", run_in_background: true },
    undefined, undefined, ctx(),
  );
  return /Agent ID: (\S+)/.exec(textOf(r))![1];
}

describe("a live agent addressed by its id", () => {
  it("names the target by id when the record carries neither alias nor handle", async () => {
    const { tools } = boot();
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}) as any);
    const id = await spawnBackground(tools);
    await flush();
    const record = registry().getRecord(id);
    record.alias = undefined;
    record.handle = undefined;

    const uiCtx = ctx();
    expect(await send(`@${id} by id`, uiCtx)).toEqual({ action: "handled" });
    expect(uiCtx.ui.notify).toHaveBeenCalledWith(`Sent to @${id}`, "info");
  });
});

describe("a finished agent that kept no session", () => {
  it("is not resumed; the mention starts a fresh agent of its type", async () => {
    const { tools } = boot();
    vi.mocked(runAgent).mockResolvedValue({ responseText: "first", session: undefined, aborted: false, steered: false } as any);
    await spawnBackground(tools);
    await flush();
    vi.mocked(runAgent).mockClear();
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}) as any);

    expect(await send("@explore start over")).toEqual({ action: "handled" });

    expect(resumeAgent).not.toHaveBeenCalled();
    expect(runAgent).toHaveBeenCalledWith(expect.anything(), "Explore", "start over", expect.anything());
  });
});

describe("resuming an agent that ran on a tier", () => {
  it("records the tier in the fresh transcript the resume opens", async () => {
    const { tools } = boot({ outputTranscript: true });
    vi.mocked(runAgent).mockResolvedValue({ responseText: "first", session: fakeSession(), aborted: false, steered: false } as any);
    vi.mocked(resumeAgent).mockResolvedValue({ text: "second", failure: undefined } as any);
    const id = await spawnBackground(tools);
    await flush();
    const record = registry().getRecord(id);
    record.modelTier = { kind: "unmapped", tier: "fast" };

    expect(await send("@explore anything else?")).toEqual({ action: "handled" });
    await flush();

    const transcript = readFileSync(registry().getRecord(id).outputFile, "utf-8").trim().split("\n").map(line => JSON.parse(line));
    expect(transcript).toContainEqual(expect.objectContaining({ type: "model-tier", agentId: id, modelTier: { kind: "unmapped", tier: "fast" } }));
  });
});
