/** Completion notices and lifecycle payloads for records the manager would never leave half-settled. */
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as AgentRunnerModule from "../src/agent-runner.js";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof AgentRunnerModule>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import type { AgentRecord } from "../src/types.js";
import { ctx, type Hermetic, hermeticDir, makePi } from "./helpers/boot-extension.js";

const managerKey = Symbol.for("pi-subagents:manager");
const registry = () => (globalThis as any)[managerKey] as { getRecord(id: string): AgentRecord | undefined };

function booted() {
  env = hermeticDir({ settings: { outputTranscript: false, fallbackSubagent: "none" } });
  Reflect.deleteProperty(globalThis, managerKey);
  const b = makePi();
  subagentsExtension(b.pi);
  return b;
}

async function spawnBackground(b: ReturnType<typeof makePi>, description: string): Promise<void> {
  await b.tools.get("Agent").execute("call", {
    prompt: "go", description, subagent_type: "general-purpose", run_in_background: true,
  }, undefined, undefined, ctx());
}

let env: Hermetic | undefined;
afterEach(() => {
  env?.restore();
  env = undefined;
  vi.restoreAllMocks();
  vi.useRealTimers();
  Reflect.deleteProperty(globalThis, managerKey);
});

describe("failure notice for a record that lost its error text and completion time", () => {
  it("says unknown and measures the run to now instead of reading as instant", async () => {
    vi.useFakeTimers();
    vi.mocked(runAgent).mockImplementation(async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 1_000));
      throw new Error("child died");
    });
    const b = booted();
    // The failed lifecycle event is emitted before the notice is snapshotted: strip what a
    // settled record normally carries so the notice has to fall back.
    b.pi.events.emit.mockImplementation((channel: string, data: { id: string }) => {
      if (channel !== "subagents:failed") return;
      const record = registry().getRecord(data.id)!;
      record.error = undefined;
      record.completedAt = undefined;
    });

    await spawnBackground(b, "lossy child");
    await vi.advanceTimersByTimeAsync(1_200);

    expect(b.pi.sendMessage).toHaveBeenCalledTimes(1);
    const [message] = b.pi.sendMessage.mock.calls[0] as [{ content: string; details: { durationMs: number; error?: string } }];
    expect(message.content).toContain("<status>Error: unknown</status>");
    expect(message.content).toContain("Error: unknown");
    expect(message.content).toContain("<duration_ms>1000</duration_ms>");
    expect(message.details.durationMs).toBe(1_000);

    await b.lifecycle.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, ctx());
  });
});
