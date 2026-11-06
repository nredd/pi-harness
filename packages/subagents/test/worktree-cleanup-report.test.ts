import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import { runAgent } from "../src/agent-runner.js";
import type { AgentRecord } from "../src/types.js";
import { cleanupWorktree, createWorktree } from "../src/worktree.js";

vi.mock("../src/agent-runner.js", () => ({ runAgent: vi.fn(), resumeAgent: vi.fn() }));
vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(),
  pruneWorktrees: vi.fn(),
  isWorktreeIsolationEnabled: () => true,
}));

const pi = {} as ExtensionAPI;
const ctx = { cwd: "/tmp" } as ExtensionContext;
const wt = { path: "/tmp/retained", workPath: "/tmp/retained", repoRoot: "/tmp/repo", branch: "pi-agent-x", baseSha: "abc" };
const failure = { hasChanges: true, path: wt.path, error: "commit failed" };

describe("worktree cleanup reporting", () => {
  let manager: AgentManager;
  beforeEach(() => {
    vi.mocked(createWorktree).mockResolvedValue(wt);
    vi.mocked(cleanupWorktree).mockResolvedValue(failure);
  });
  afterEach(async () => {
    await manager.dispose();
    vi.resetAllMocks();
  });

  it("fails a successful structured child and reports the retained path", async () => {
    vi.mocked(runAgent).mockResolvedValue({ responseText: "done", session: {} as never, aborted: false, steered: false, structuredJson: '{"ok":true}' });
    manager = new AgentManager();
    const { record } = await manager.spawnAndWait(pi, ctx, "X", "go", { description: "go", isolation: "worktree" });
    expect(record.status).toBe("error");
    expect(record.error).toContain("commit failed");
    expect(record.error).toContain(wt.path);
    expect(record.worktreeResult).toEqual(failure);
    expect(record.structuredJson).toBe('{"ok":true}');
  });

  it("reports a created branch alongside a retained worktree", async () => {
    vi.mocked(cleanupWorktree).mockResolvedValue({ ...failure, branch: "pi-agent-x" });
    vi.mocked(runAgent).mockResolvedValue({ responseText: "done", session: {} as never, aborted: false, steered: false });
    manager = new AgentManager();
    const { record } = await manager.spawnAndWait(pi, ctx, "X", "go", { description: "go", isolation: "worktree" });
    expect(record.error).toContain("branch `pi-agent-x` was created");
    expect(record.error).toContain(wt.path);
  });

  it("retains the runner error and cleanup failure on a rejected run", async () => {
    vi.mocked(runAgent).mockRejectedValue(new Error("runner failed"));
    manager = new AgentManager();
    const { record } = await manager.spawnAndWait(pi, ctx, "X", "go", { description: "go", isolation: "worktree" });
    expect(record.error).toContain("runner failed");
    expect(record.error).toContain(wt.path);
    expect(record.error).toContain("commit failed");
  });

  it("includes the retained path in an immediate startup failure", async () => {
    manager = new AgentManager(undefined, undefined, () => { throw new Error("start failed"); });
    await expect(manager.spawnAndWait(pi, ctx, "X", "go", { description: "go", isolation: "worktree" }))
      .rejects.toThrow(/start failed[\s\S]*\/tmp\/retained/);
  });

  it("preserves a non-Error startup exception with the cleanup failure", async () => {
    manager = new AgentManager(undefined, undefined, () => { throw "start failed"; });
    await expect(manager.spawnAndWait(pi, ctx, "X", "go", { description: "go", isolation: "worktree" }))
      .rejects.toThrow(/start failed[\s\S]*\/tmp\/retained/);
  });

  it("notifies a background owner when a stopped copy cannot be removed", async () => {
    let release!: (value: typeof wt) => void;
    vi.mocked(createWorktree).mockReturnValue(new Promise(resolve => { release = resolve; }));
    const seen: AgentRecord[] = [];
    manager = new AgentManager(record => { seen.push(record); });
    const id = manager.spawn(pi, ctx, "X", "go", { description: "go", isBackground: true, isolation: "worktree" });
    manager.abort(id);
    release(wt);
    await manager.awaitStartup(id);
    expect(seen).toHaveLength(1);
    expect(seen[0].status).toBe("stopped");
    expect(seen[0].result).toContain(wt.path);
    expect(seen[0].error).toContain("commit failed");
    expect(vi.mocked(runAgent)).not.toHaveBeenCalled();
  });
});
