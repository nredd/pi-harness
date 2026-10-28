/** Nested control failures and queued waits, scoped to the parent that owns them. */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNestedSubagentTools, type NestedAgentManager } from "../src/nested-tools.js";
import type { AgentRecord } from "../src/types.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lifecycle-nested-")); vi.stubEnv("PI_CODING_AGENT_DIR", join(dir, "agent")); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const parent = { id: "parent", type: "general-purpose", description: "parent", status: "running", rootSessionId: "lifecycle-root" } as AgentRecord;
  const child = { id: "child", type: "general-purpose", parentAgentId: "parent", description: "child", status: "running", toolUses: 0, startedAt: 1, result: "answer" } as AgentRecord;
  const records = new Map([[parent.id, parent], [child.id, child]]);
  const spawnAndWait = vi.fn<NestedAgentManager["spawnAndWait"]>().mockRejectedValue(new Error("worktree copy failed"));
  const manager = { getRecord: (id: string) => records.get(id), spawnAndWait } as unknown as NestedAgentManager;
  const ctx = { cwd: dir, modelRegistry: { getAll: () => [], getAvailable: () => [] } } as unknown as ExtensionContext;
  const tools = createNestedSubagentTools({ homeDir: dir, manager, pi: {} as ExtensionAPI, parentAgentId: parent.id, depth: 1, maxSubagentDepth: 2, allowedSubagents: "all", configCwd: dir, projectTrusted: false });
  const tool = (name: string) => {
    const found = tools.find(candidate => candidate.name === name);
    if (!found) throw new Error(`Missing nested tool ${name}`);
    return found;
  };
  return { parent, child, records, spawnAndWait, ctx, tool };
}

describe("nested lifecycle boundaries", () => {
  it("attaches a real nested transcript before session creation and flushes the child's answer", async () => {
    const f = fixture();
    const unsubscribe = vi.fn();
    const session = { messages: [{ role: "user", content: "p" }, { role: "assistant", content: [{ type: "text", text: "child transcript answer" }] }], subscribe: vi.fn(() => unsubscribe) } as unknown as AgentSession;
    f.spawnAndWait.mockImplementation(async (_pi, _ctx, _type, _prompt, options, onSpawned) => {
      onSpawned?.(f.child.id);
      options.onSessionCreated?.(session);
      f.child.status = "completed";
      return { id: f.child.id, record: f.child };
    });
    try {
      const result = await f.tool("Agent").execute("call", { prompt: "p", description: "d", subagent_type: "general-purpose" }, undefined, undefined, f.ctx);
      expect(result.isError).toBe(false);
      expect(f.child.outputFile).toBeDefined();
      expect(f.child.outputCleanup).toBeTypeOf("function");
      f.child.outputCleanup?.();
      const rows = readFileSync(f.child.outputFile!, "utf8").trim().split("\n").map(line => JSON.parse(line));
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ type: "user", agentId: "child", message: { content: "p" } });
      expect(rows[1]).toMatchObject({ type: "assistant", agentId: "child", message: { content: [{ type: "text", text: "child transcript answer" }] } });
      expect(unsubscribe).toHaveBeenCalledOnce();
    } finally { if (f.child.outputFile) rmSync(dirname(f.child.outputFile), { recursive: true, force: true }); }
  });

  it("returns the actual startup failure instead of escaping the parent's tool batch", async () => {
    const f = fixture();
    const result = await f.tool("Agent").execute("call", { prompt: "p", description: "d", subagent_type: "general-purpose" }, undefined, undefined, f.ctx);
    expect(result).toMatchObject({ isError: true, content: [{ type: "text", text: "worktree copy failed" }] });
  });

  it.each([new Error("delivery failed"), "delivery failed"])("reports live steer rejection %s without queuing a duplicate", async error => {
    const f = fixture();
    const steer = vi.fn().mockRejectedValue(error);
    f.child.session = { steer } as unknown as AgentSession;
    const result = await f.tool("steer_subagent").execute("call", { agent_id: f.child.id, message: "instruction" }, undefined, undefined, f.ctx);
    expect(steer).toHaveBeenCalledExactlyOnceWith("instruction");
    expect(result).toMatchObject({ isError: true, content: [{ type: "text", text: "Failed to steer nested agent: delivery failed" }] });
    expect(f.child.pendingSteers).toBeUndefined();
  });

  it("confirms only a successfully delivered live steer", async () => {
    const f = fixture();
    const steer = vi.fn().mockResolvedValue(undefined);
    f.child.session = { steer } as unknown as AgentSession;
    const result = await f.tool("steer_subagent").execute("call", { agent_id: f.child.id, message: "instruction" }, undefined, undefined, f.ctx);
    expect(steer).toHaveBeenCalledExactlyOnceWith("instruction");
    expect(result).toMatchObject({ isError: false, content: [{ type: "text", text: "Steering message sent to nested agent child." }] });
  });

  it("waits for a queued child to leave the queue and then returns its settled answer", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.child.status = "queued";
    const result = f.tool("get_subagent_result").execute("call", { agent_id: f.child.id, wait: true }, undefined, undefined, f.ctx);
    f.child.status = "completed";
    f.child.promise = Promise.resolve("answer");
    await vi.advanceTimersByTimeAsync(250);
    expect(await result).toMatchObject({ isError: false, content: [{ type: "text", text: "answer" }] });
    expect(vi.getTimerCount()).toBe(0);
  });
});
