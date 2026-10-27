/** #145: usage and compaction observers run inside the child's loop; a stale-ctx throw must not fail the run. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";

vi.mock("../src/agent-runner.js", () => ({ runAgent: vi.fn(), resumeAgent: vi.fn() }));

import { runAgent } from "../src/agent-runner.js";

const STALE = "This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.reload().";
const mockPi = {} as never;
const mockCtx = { cwd: "/tmp" } as never;

let manager: AgentManager | undefined;
afterEach(() => manager?.dispose());

/** Spawn one run whose runner calls `fire` with the observers the manager hands it. */
async function run(onCompact: () => void, onUsage: () => void, fire: (opts: Record<string, (...a: unknown[]) => void>) => void) {
  manager = new AgentManager(undefined, undefined, undefined, onCompact, onUsage);
  let thrown: unknown;
  vi.mocked(runAgent).mockImplementation((async (_c: unknown, _t: unknown, _p: unknown, opts: Record<string, (...a: unknown[]) => void>) => {
    try { fire(opts); } catch (error) { thrown = error; }
    return { responseText: "done", session: { dispose: vi.fn() }, aborted: false, steered: false };
  }) as never);
  const id = manager.spawn(mockPi, mockCtx, "general-purpose", "t", { description: "t", isBackground: true });
  const record = manager.getRecord(id)!;
  await record.promise;
  return { thrown, record };
}

describe("observer isolation", () => {
  it("drops a stale-ctx throw from the usage observer", async () => {
    const { thrown, record } = await run(() => {}, () => { throw new Error(STALE); }, o => o.onAssistantUsage({ input: 1, output: 1, cacheWrite: 0, cost: 0 }));
    expect(thrown).toBeUndefined();
    expect(record.status).toBe("completed");
  });

  it("drops a stale-ctx throw from the compaction observer", async () => {
    const { thrown, record } = await run(() => { throw new Error(STALE); }, () => {}, o => o.onCompaction({ reason: "threshold", tokensBefore: 1 }));
    expect(thrown).toBeUndefined();
    expect(record.compactionCount).toBe(1);
  });

  it("drops a stale-ctx throw silently", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await run(() => {}, () => { throw new Error(STALE); }, o => o.onAssistantUsage({ input: 1, output: 1, cacheWrite: 0, cost: 0 }));
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("logs a real observer defect once, and does not kill the run", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { thrown, record } = await run(() => {}, () => { throw new Error("boom"); }, o => {
      o.onAssistantUsage({ input: 1, output: 1, cacheWrite: 0, cost: 0 });
      o.onAssistantUsage({ input: 1, output: 1, cacheWrite: 0, cost: 0 });
    });
    expect(thrown).toBeUndefined();
    expect(record.status).toBe("completed");
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toContain("usage observer failed");
    log.mockRestore();
  });

  it("logs a compaction observer defect too", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { thrown } = await run(() => { throw new Error("boom"); }, () => {}, o => o.onCompaction({ reason: "threshold", tokensBefore: 1 }));
    expect(thrown).toBeUndefined();
    expect(log).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });
});
