/**
 * branch-coverage-workflow-core.test.ts — the edges of the workflow core that
 * the behavioural suites never reach: the VM boundary's refusals, results a
 * host returns with fields missing, replay of a torn journal entry, a
 * validator that throws something other than an `Error`, and the saved-workflow
 * listing's guards. Each test pins the observable outcome of one branch.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Check, Errors } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentManager } from "../src/agent-manager.js";
import { registerAgents } from "../src/agent-types.js";
import type { TierDisclosure } from "../src/model-tiers.js";
import { packageWorkflowFiles, resetPackageState } from "../src/package-resources.js";
import type { AgentRecord } from "../src/types.js";
import { createWorkflowHost } from "../src/workflow/host.js";
import { appendJournal, readJournal, type WorkflowJournalEntry } from "../src/workflow/journal.js";
import { compileJsonSchema } from "../src/workflow/json-schema.js";
import type { WorkflowAgentEntry, WorkflowEntry } from "../src/workflow/progress.js";
import {
  assertBoundarySafe,
  MAX_SCRIPT_LENGTH,
  type RunWorkflowOptions,
  runWorkflow,
  type WorkflowHost,
  type WorkflowRunResult,
  type WorkflowSpawnRequest,
  type WorkflowSpawnResult,
} from "../src/workflow/runtime.js";
import { listSavedWorkflows, readSavedWorkflow } from "../src/workflow/saved.js";

// Pass-through by default; individual tests make the validator throw a
// non-Error, which no real schema can be made to do on demand.
vi.mock("typebox/value", async importOriginal => {
  const real = await importOriginal<{ Check: typeof Check; Errors: typeof Errors }>();
  return { ...real, Check: vi.fn(real.Check), Errors: vi.fn(real.Errors) };
});

const HEAD = 'export const meta = { name: "probe", description: "a test workflow" };\n';
const OBJECT_SCHEMA = "{ type: 'object', properties: { a: { type: 'number' } }, required: ['a'] }";
const UNMAPPED: TierDisclosure = { kind: "unmapped", tier: "cheap" };

function stubHost(reply: (request: WorkflowSpawnRequest) => WorkflowSpawnResult = r => ({ ok: true, text: `ok:${r.prompt}` })) {
  const calls: WorkflowSpawnRequest[] = [];
  const host: WorkflowHost = {
    async spawnAgent(request) {
      calls.push(request);
      return reply(request);
    },
    abortAgent() {},
  };
  return { host, calls };
}

function run(body: string, options: Omit<RunWorkflowOptions, "script">): Promise<WorkflowRunResult> {
  return runWorkflow({ script: HEAD + body, ...options });
}

const agentRows = (progress: readonly WorkflowEntry[]): WorkflowAgentEntry[] =>
  progress.filter((entry): entry is WorkflowAgentEntry => entry.type === "workflow_agent");

afterEach(() => {
  vi.mocked(Check).mockReset();
  vi.mocked(Errors).mockReset();
});

describe("the VM boundary refuses what the journal cannot carry", () => {
  it.each([
    ["a non-finite number", { n: Number.NaN }, "args.n"],
    ["a BigInt", { n: 1n }, "args.n"],
    ["a symbol", { s: Symbol("x") }, "args.s"],
    ["a function", { f: () => 1 }, "args.f"],
  ])("rejects %s with its path", (what, value, path) => {
    expect(() => assertBoundarySafe(value, "args")).toThrow(`Cannot pass ${what} across the workflow VM boundary (at ${path}).`);
  });

  it("rejects a cycle", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => assertBoundarySafe(cyclic, "args")).toThrow("a circular structure across the workflow VM boundary (at args.self)");
  });

  it("allows the same object twice when it is not a cycle", () => {
    const shared = { x: 1 };
    expect(() => assertBoundarySafe({ a: shared, b: [shared, shared] }, "args")).not.toThrow();
  });

  it("rejects a sparse array at the hole", () => {
    // biome-ignore lint/suspicious/noSparseArray: the hole is the point
    expect(() => assertBoundarySafe({ list: [1, , 3] }, "args")).toThrow("a sparse array across the workflow VM boundary (at args.list[1])");
  });
});

describe("agent labels derived from the prompt", () => {
  it("falls back to `agent` for a prompt whose first line is blank", async () => {
    const stub = stubHost();
    await run("return await agent('\\nsecond line');", { host: stub.host });
    expect(stub.calls[0]?.label).toBe("agent");
  });

  it("truncates a long first line to 60 characters", async () => {
    const stub = stubHost();
    await run(`return await agent('${"x".repeat(80)}');`, { host: stub.host });
    expect(stub.calls[0]?.label).toBe(`${"x".repeat(59)}…`);
  });
});

describe("host results with fields missing", () => {
  it("reads a successful result with no text as the empty string", async () => {
    const result = await run("return JSON.stringify(await agent('go'));", { host: stubHost(() => ({ ok: true })).host });
    expect(result.value).toBe('""');
    expect(agentRows(result.progress).at(-1)).toMatchObject({ state: "done", resultPreview: "" });
  });

  it("names a failure that carried no error", async () => {
    const result = await run("return await agent('go');", { host: stubHost(() => ({ ok: false })).host });
    expect(result.value).toBeNull();
    expect(agentRows(result.progress).at(-1)).toMatchObject({ state: "error", error: "Agent failed." });
  });

  it("fails a schema'd call whose host returned no text at all", async () => {
    const result = await run(`return await agent('go', { schema: ${OBJECT_SCHEMA} });`, {
      host: stubHost(() => ({ ok: true })).host,
    });
    expect(result.value).toBeNull();
    expect(agentRows(result.progress).at(-1)?.error).toBe("The agent did not return structured output: its answer was not JSON.");
  });

  it("puts a tier the host reports at startup on the row", async () => {
    const stub = stubHost(request => {
      request.onResolved?.({ modelTier: UNMAPPED });
      return { ok: true, text: "x" };
    });
    const result = await run("return await agent('go');", { host: stub.host });
    expect(agentRows(result.progress).at(-1)?.modelTier).toEqual(UNMAPPED);
  });
});

describe("replaying a journal entry that lost its text", () => {
  async function journalOf(script: string, text: string): Promise<WorkflowJournalEntry[]> {
    const entries: WorkflowJournalEntry[] = [];
    await run(script, { host: stubHost(() => ({ ok: true, text })).host, journal: { append: e => entries.push(e) } });
    return entries.map(({ text: _text, ...rest }) => rest);
  }

  it("replays it as the empty string when the call had no schema", async () => {
    const script = "return JSON.stringify(await agent('go'));";
    const torn = await journalOf(script, "answer");
    const live = stubHost();
    const result = await run(script, { host: live.host, journal: { entries: torn } });
    expect(live.calls).toHaveLength(0);
    expect(result.replayedCount).toBe(1);
    expect(result.value).toBe('""');
  });

  it("runs a schema'd call live instead of replaying text that cannot satisfy it", async () => {
    const script = `return await agent('go', { schema: ${OBJECT_SCHEMA} });`;
    const torn = await journalOf(script, '{"a":1}');
    const live = stubHost(() => ({ ok: true, text: '{"a":2}' }));
    const result = await run(script, { host: live.host, journal: { entries: torn } });
    expect(live.calls).toHaveLength(1);
    expect(result.replayedCount).toBe(0);
    expect(result.value).toEqual({ a: 2 });
  });
});

describe("nested workflow loading", () => {
  it("reports a non-Error thrown by the body transform as a catchable failure", async () => {
    const child = 'export const meta = { name: "audit", description: "d" };\nreturn 1;\n';
    const host: WorkflowHost = { ...stubHost().host, loadWorkflow: () => ({ ok: true, script: child }) };
    const result = await run("try { await workflow('audit'); return 'no'; } catch (e) { return e.message; }", {
      host,
      transformScriptBody: ({ script, body }) => {
        if (script === child) throw "transform refused";
        return body;
      },
    });
    expect(result.status).toBe("completed");
    expect(result.value).toBe('workflow("audit"): transform refused');
  });
});

describe("compileJsonSchema with a validator that misbehaves", () => {
  const schema = { type: "object", properties: { a: { type: "number" } }, required: ["a"] };

  it("reports a non-Error thrown while smoke-testing the schema", () => {
    vi.mocked(Check).mockImplementationOnce(() => {
      throw "walker exploded";
    });
    expect(compileJsonSchema(schema)).toEqual({
      ok: false,
      message: "agent() opts.schema is not a schema this runtime can validate: walker exploded",
    });
  });

  it("reports a non-Error thrown while checking a value", () => {
    const compiled = compileJsonSchema(schema);
    if (!compiled.ok) throw new Error(compiled.message);
    vi.mocked(Check).mockImplementationOnce(() => {
      throw "value exploded";
    });
    expect(compiled.compiled.check({ a: 1 })).toBe("the value could not be validated: value exploded");
  });

  it("anchors an error with no instancePath at the root", () => {
    const compiled = compileJsonSchema(schema);
    if (!compiled.ok) throw new Error(compiled.message);
    vi.mocked(Errors).mockImplementationOnce(() => [{ message: "bad root" }] as unknown as ReturnType<typeof Errors>);
    expect(compiled.compiled.check({})).toBe("$: bad root");
  });

  it("falls back to a generic message when listing the errors throws", () => {
    const compiled = compileJsonSchema(schema);
    if (!compiled.ok) throw new Error(compiled.message);
    vi.mocked(Errors).mockImplementationOnce(() => {
      throw new Error("cannot enumerate");
    });
    expect(compiled.compiled.check({})).toBe("the value does not match the required schema");
  });

  it("quotes at most five errors", () => {
    const wide = {
      type: "object",
      properties: Object.fromEntries(["a", "b", "c", "d", "e", "f", "g"].map(k => [k, { type: "number" }])),
    };
    const compiled = compileJsonSchema(wide);
    if (!compiled.ok) throw new Error(compiled.message);
    const verdict = compiled.compiled.check({ a: "1", b: "1", c: "1", d: "1", e: "1", f: "1", g: "1" });
    expect(typeof verdict === "string" && verdict.split("; ")).toHaveLength(5);
  });
});

describe("journal entries carrying the resume mark", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wf-journal-branch-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("keeps `resumed: true` and drops any other value", () => {
    const path = join(dir, "run.jsonl");
    appendJournal(path, { index: 0, key: "k0", ok: true, text: "kept", resumed: true });
    writeFileSync(path, `${JSON.stringify({ index: 1, key: "k1", ok: true, resumed: "yes" })}\n`, { flag: "a" });
    expect(readJournal(path)).toEqual([{ index: 0, key: "k0", ok: true, text: "kept", resumed: true }]);
  });
});

describe("saved workflow edges", () => {
  const SCRIPT = "export const meta = { name: 'demo', description: 'A demo' }\nreturn 1\n";
  let tmpDir: string;
  let agentDir: string;
  let prevAgentDir: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-wf-branch-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-wf-branch-agentdir-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    resetPackageState();
  });

  afterEach(() => {
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    resetPackageState();
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  });

  /** A package declaring individual workflow files, registered in pi's user settings. */
  function installFiles(files: Record<string, string | { symlinkTo: string }>): string {
    const root = join(tmpDir, "packages", "file-flows");
    mkdirSync(root, { recursive: true });
    // An undeclared real file inside the package, so a declared symlink to it
    // passes the containment check and reaches the read.
    writeFileSync(join(root, "impl.js"), SCRIPT);
    for (const [name, content] of Object.entries(files)) {
      const path = join(root, name);
      if (typeof content === "string") writeFileSync(path, content);
      else symlinkSync(content.symlinkTo, path);
    }
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "file-flows", version: "1.0.0", pi: { subagents: { workflows: Object.keys(files).map(f => `./${f}`) } } }),
    );
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [root] }));
    resetPackageState();
    return root;
  }

  it("does not resolve a declared file that is a symlink", () => {
    const root = installFiles({ "linked.js": { symlinkTo: "impl.js" } });
    // Declared and resolved: the refusal below is the read's, not discovery's.
    expect(packageWorkflowFiles(tmpDir).get("linked")).toBe(join(root, "linked.js"));
    const result = readSavedWorkflow("linked", tmpDir);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain('No saved workflow named "linked"');
  });

  it("lists only safely named, real workflow files a package declares", () => {
    installFiles({ "good.js": SCRIPT, "with space.js": SCRIPT, "plain.js": "module.exports = 1\n" });
    expect(listSavedWorkflows(tmpDir)).toEqual(["good"]);
  });

  it("leaves a file too large to be a workflow out of the listing", () => {
    const root = join(tmpDir, ".pi", "workflows");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "small.js"), SCRIPT);
    writeFileSync(join(root, "huge.js"), `${SCRIPT}//${"x".repeat(MAX_SCRIPT_LENGTH)}\n`);
    expect(listSavedWorkflows(tmpDir)).toEqual(["small"]);
  });
});

describe("the workflow host at its edges", () => {
  const pi = (exec: ExtensionAPI["exec"] = vi.fn()) => ({ exec }) as unknown as ExtensionAPI;
  const ctx = (cwd = process.cwd()) =>
    ({
      cwd,
      model: undefined,
      modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
      ui: { notify: vi.fn() },
    }) as unknown as ExtensionContext;
  const request = (overrides: Partial<WorkflowSpawnRequest> = {}): WorkflowSpawnRequest => ({
    agentId: "wf-agent-0",
    index: 0,
    prompt: "go",
    label: "go",
    agentType: "general-purpose",
    ...overrides,
  });

  /** A manager whose spawn settles straight away on `record`, after `during` runs. */
  function managerFor(record: Partial<AgentRecord>, during?: (opts: Record<string, unknown>) => Promise<void>) {
    const full = { id: "rec-1", status: "completed", toolUses: 0, ...record } as AgentRecord;
    return {
      getRecord: () => full,
      async spawnAndWait(_pi: unknown, _ctx: unknown, _type: unknown, _prompt: unknown, opts: Record<string, unknown>, onSpawned?: (id: string) => void) {
        onSpawned?.(full.id);
        await during?.(opts);
        return { id: full.id, record: full };
      },
    } as unknown as AgentManager;
  }

  beforeEach(() => registerAgents(new Map()));

  it("passes a success with no usage and no result through as an empty answer", async () => {
    const host = createWorkflowHost({ pi: pi(), ctx: ctx(), manager: managerFor({ structuredRetried: true }) });
    const result = await host.spawnAgent(request());
    expect(result).toEqual({ ok: true, text: "", structuredRetried: true });
  });

  it("names the status of a failure that carried no error", async () => {
    const host = createWorkflowHost({ pi: pi(), ctx: ctx(), manager: managerFor({ status: "error" }) });
    expect(await host.spawnAgent(request())).toEqual({ ok: false, error: "Agent error." });
  });

  it("reports nothing beyond the record id when a tiered record never resolved a model", async () => {
    const reported: unknown[] = [];
    const host = createWorkflowHost({ pi: pi(), ctx: ctx(), manager: managerFor({ modelTier: UNMAPPED }) });
    await host.spawnAgent(request({ onResolved: info => reported.push(info) }));
    expect(reported).toEqual([{ recordId: "rec-1" }]);
  });

  it("returns a non-Error the manager throws as the agent's failure", async () => {
    const manager = {
      async spawnAndWait() {
        throw "manager refused";
      },
    } as unknown as AgentManager;
    const host = createWorkflowHost({ pi: pi(), ctx: ctx(), manager });
    expect(await host.spawnAgent(request())).toEqual({ ok: false, error: "manager refused" });
  });

  it("fails the gate with a non-Error thrown while running it in the worktree", async () => {
    const exec = vi.fn(async () => {
      throw "exec refused";
    });
    const manager = managerFor({}, async opts => {
      await (opts.onBeforeWorktreeCleanup as (path: string) => Promise<void>)("/tmp/wt");
    });
    const host = createWorkflowHost({ pi: pi(exec as unknown as ExtensionAPI["exec"]), ctx: ctx(), manager });
    const result = await host.spawnAgent(request({ gate: "npm test" }));
    expect(result.gate).toEqual({ ok: false, output: "exec refused" });
  });

  it("hands the run's abort signal to the gate command", async () => {
    const signal = new AbortController().signal;
    const exec = vi.fn(async () => ({ stdout: "ok", stderr: "", code: 0, killed: false }));
    const host = createWorkflowHost({ pi: pi(exec as unknown as ExtensionAPI["exec"]), ctx: ctx(), manager: managerFor({}), signal });
    expect(await host.runGate?.("true", { agentId: "wf-agent-0" })).toEqual({ ok: true, output: "ok" });
    expect(exec).toHaveBeenCalledWith("sh", ["-c", "true"], expect.objectContaining({ signal }));
  });

  it("runs a gate through cmd on Windows", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    const exec = vi.fn(async () => ({ stdout: "", stderr: "", code: 0, killed: false }));
    const host = createWorkflowHost({ pi: pi(exec as unknown as ExtensionAPI["exec"]), ctx: ctx(), manager: managerFor({}) });
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    try {
      await host.runGate?.("npm test", { agentId: "wf-agent-0" });
    } finally {
      if (platform) Object.defineProperty(process, "platform", platform);
    }
    expect(exec).toHaveBeenCalledWith("cmd", ["/c", "npm test"], expect.any(Object));
  });
});
