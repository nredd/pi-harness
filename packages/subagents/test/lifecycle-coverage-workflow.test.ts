/** Real worker protocol failures and cancellation without timer-based orchestration. */
import { describe, expect, it, vi } from "vitest";
import { assertBoundarySafe, runWorkflow, type WorkflowControl, type WorkflowHost, type WorkflowSpawnResult } from "../src/workflow/runtime.js";

const HEAD = 'export const meta = {name: "lifecycle", description: "worker boundaries"};\n';
const host = (): WorkflowHost => ({ spawnAgent: vi.fn(async request => ({ ok: true, text: request.prompt })), abortAgent: vi.fn() });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe("workflow lifecycle boundaries", () => {
  it.each([
    { args: { private: undefined }, path: "args.private" },
    { args: [undefined], path: "args[0]" },
  ])("rejects nested undefined at $path before creating a worker or spawning", async ({ args, path }) => {
    const adapter = host();
    await expect(runWorkflow({ script: HEAD + 'return await agent("never");', args, host: adapter }))
      .rejects.toThrow(`Cannot pass undefined across the workflow VM boundary (at ${path}).`);
    expect(adapter.spawnAgent).not.toHaveBeenCalled();
    const control = await runWorkflow({ script: HEAD + 'return typeof args;', host: adapter });
    expect(control).toMatchObject({ status: "completed", value: "undefined", agentCount: 0 });
  });

  it("rejects symbol-keyed inputs instead of silently losing their fields across JSON", () => {
    expect(() => assertBoundarySafe({ [Symbol("private")]: "not JSON" }, "args")).toThrow("Cannot pass an object with symbol keys across the workflow VM boundary (at args).");
  });

  it.each([new Error("host spawn failed"), "host spawn failed"])("turns host spawn rejection into a failed child, not a failed script: %s", async error => {
    const adapter = host();
    adapter.spawnAgent = vi.fn(async () => { throw error; });
    const result = await runWorkflow({ script: HEAD + 'return await agent("p");', host: adapter });
    expect(result).toMatchObject({ status: "completed", value: null, agentCount: 1 });
    expect(result.progress).toContainEqual(expect.objectContaining({ type: "workflow_agent", state: "error", error: "host spawn failed" }));
  });

  it.each([new Error("load failed"), "load failed"])("lets scripts recover from nested workflow load rejection: %s", async error => {
    const adapter = host();
    adapter.loadWorkflow = () => { throw error; };
    const result = await runWorkflow({ script: HEAD + 'try { await workflow("child"); } catch (error) { return error.message; }', host: adapter });
    expect(result).toMatchObject({ status: "completed", value: 'workflow("child"): load failed', agentCount: 0 });
    expect(adapter.spawnAgent).not.toHaveBeenCalled();
  });

  it("reports an invalid nested script to its caller before starting a child", async () => {
    const adapter = host();
    adapter.loadWorkflow = () => ({ ok: true, script: "not a workflow" });
    const result = await runWorkflow({ script: HEAD + 'try { await workflow("child"); } catch (error) { return error.message; }', host: adapter });
    expect(result.status).toBe("completed");
    expect(result.value).toContain("must begin with");
    expect(adapter.spawnAgent).not.toHaveBeenCalled();
  });

  it("skips an agent already parked behind the semaphore without consuming its permit", async () => {
    const first = deferred<WorkflowSpawnResult>();
    const adapter = host();
    adapter.spawnAgent = vi.fn(request => request.index === 0 ? first.promise : Promise.resolve({ ok: true, text: request.prompt }));
    let control: WorkflowControl | undefined;
    const result = await runWorkflow({
      script: HEAD + 'return await Promise.all([agent("first"), agent("skip"), agent("last")]);', host: adapter, concurrency: 1,
      onControl: value => { control = value; },
      onProgress: entries => {
        if (entries.some(entry => entry.type === "workflow_agent" && entry.index === 2 && entry.startedAt === undefined)) {
          expect(control?.skip(1)).toBe(true);
          first.resolve({ ok: true, text: "first" });
        }
      },
    });
    expect(result).toMatchObject({ status: "completed", value: ["first", null, "last"] });
    expect(vi.mocked(adapter.spawnAgent).mock.calls.map(([request]) => request.index)).toEqual([0, 2]);
    expect(result.progress).toContainEqual(expect.objectContaining({ index: 1, skipped: true, error: "Skipped by user." }));
  });

  it("drains already queued permits when cancelled and never starts queued children", async () => {
    const first = deferred<WorkflowSpawnResult>();
    const adapter = host();
    adapter.spawnAgent = vi.fn(() => first.promise);
    adapter.abortAgent = vi.fn(() => first.resolve({ ok: false, error: "aborted" }));
    const controller = new AbortController();
    const result = await runWorkflow({
      script: HEAD + 'return await Promise.all([agent("first"), agent("second"), agent("last")]);', host: adapter, concurrency: 1, signal: controller.signal,
      onProgress: entries => {
        if (entries.some(entry => entry.type === "workflow_agent" && entry.index === 2)) controller.abort();
      },
    });
    expect(result).toMatchObject({ status: "killed", error: "Workflow aborted." });
    expect(adapter.spawnAgent).toHaveBeenCalledTimes(1);
    expect(adapter.abortAgent).toHaveBeenCalledExactlyOnceWith("wf-agent-0");
  });

  it("settles a hostile thrown-value diagnostic getter without replacing the original failure", async () => {
    const adapter = host();
    const result = await runWorkflow({ script: HEAD + 'throw { get message() { throw new Error("diagnostic getter failed"); } };', host: adapter });
    expect(result).toMatchObject({ status: "failed", error: "Workflow threw an unreadable error.", agentCount: 0 });
    expect(result.errorStack).toBeUndefined();
    expect(adapter.spawnAgent).not.toHaveBeenCalled();
  });
});
