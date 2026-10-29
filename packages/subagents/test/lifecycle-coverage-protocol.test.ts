/** Malformed host RPC is rejected at the real worker event boundary. */
import type { Worker } from "node:worker_threads";
import * as workerThreads from "node:worker_threads";
import { describe, expect, it, vi } from "vitest";
import { runWorkflow, type WorkflowHost, type WorkflowSpawnResult } from "../src/workflow/runtime.js";

const captured = vi.hoisted(() => ({ worker: undefined as Worker | undefined }));
vi.mock("node:worker_threads", async original => {
  const actual = await original<typeof workerThreads>();
  return { ...actual, Worker: class extends actual.Worker {
    constructor(...args: ConstructorParameters<typeof actual.Worker>) { super(...args); captured.worker = this; }
  } };
});

describe("worker protocol boundary", () => {
  it("returns a fatal unknown-method envelope without starting another child", async () => {
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    let stop!: (result: WorkflowSpawnResult) => void;
    const held = new Promise<WorkflowSpawnResult>(resolve => { stop = resolve; });
    const host: WorkflowHost = { spawnAgent: vi.fn(() => { started(); return held; }), abortAgent: vi.fn(() => stop({ ok: false, error: "cancelled" })) };
    const controller = new AbortController();
    const run = runWorkflow({ script: 'export const meta = {name:"protocol", description:"d"};\nreturn await agent("held");', host, signal: controller.signal });
    await ready;
    const worker = captured.worker;
    if (!worker) throw new Error("real worker was not created");
    const respond = vi.spyOn(worker, "postMessage");
    try {
      // A worker from another protocol version can send an unknown method.
      // Deliver that event at Node's public EventEmitter seam, not a private
      // runtime helper; postMessage still talks to the actual worker thread.
      worker.emit("message", { type: "call", callId: 997, method: "unknown-method", payload: {} });
      expect(respond).toHaveBeenCalledWith({ type: "response", callId: 997, ok: false, value: undefined, error: 'Unknown workflow host method "unknown-method".', fatal: true, modelNote: undefined, spent: 0 });
      expect(host.spawnAgent).toHaveBeenCalledTimes(1);
    } finally { controller.abort(); respond.mockRestore(); }
    expect(await run).toMatchObject({ status: "killed", error: "Workflow aborted." });
    expect(host.abortAgent).toHaveBeenCalledExactlyOnceWith("wf-agent-0");
  });
});
