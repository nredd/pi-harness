/** Real private filesystem failures and schema diagnostics, without changing HOME. */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isDisabledContent } from "../src/agent-file-toggle.js";
import { loadCustomAgents } from "../src/custom-agents.js";
import { enterpriseLocalPath, readEnterpriseLocalManifest } from "../src/enterprise-local.js";
import { detectEnv } from "../src/env.js";
import { isTierDisclosure, tierNote } from "../src/model-tiers.js";
import { listPiPackages, resetPackageState } from "../src/package-resources.js";
import { budgetUsage, enqueueBudget, pumpBudget } from "../src/process-budget.js";
import { ScheduleStore } from "../src/schedule-store.js";
import { loadSettings } from "../src/settings.js";
import { DEFAULT_AGENT_NAMES, type ScheduledSubagent } from "../src/types.js";
import { compileJsonSchema } from "../src/workflow/json-schema.js";
import { listSavedWorkflows } from "../src/workflow/saved.js";
import { createWorkflowTask, resolveResumeTarget, workflowResultText } from "../src/workflow/task.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "subagent-lifecycle-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); resetPackageState(); rmSync(root, { recursive: true, force: true }); });

function job(): ScheduledSubagent {
  return { id: "job", name: "job", description: "d", schedule: "5m", scheduleType: "interval", intervalMs: 300000, subagent_type: "general-purpose", prompt: "p", enabled: true, createdAt: "2020-01-01T00:00:00Z", runCount: 0 };
}

describe("private persistence boundaries", () => {
  it("does not report an unparseable agent file as successfully disabled", () => {
    expect(isDisabledContent("---\nenabled: false\nbroken: [unterminated\n---\nbody")).toBe(false);
  });

  it("skips a missing declared package agent and an unreadable local agent root", () => {
    mkdirSync(join(root, "agent"), { recursive: true });
    writeFileSync(join(root, "agent", "agents"), "not a directory");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const missing = join(root, "missing.md");
    expect(loadCustomAgents(root, true, { homeDir: root, packageDirs: [], packageFiles: [missing], projectTrusted: false })).toEqual(new Map());
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`Skipping package agent ${missing}`));
  });

  it("contains malformed configured package rows without inventing installed resources", () => {
    mkdirSync(join(root, "agent"), { recursive: true });
    writeFileSync(join(root, "agent", "settings.json"), JSON.stringify({ packages: [null] }));
    expect(listPiPackages(root, false, root)).toEqual([]);
  });

  it("lists no workflows when a saved-workflow root is a regular file", () => {
    const project = join(root, "project");
    mkdirSync(join(project, ".pi"), { recursive: true });
    writeFileSync(join(project, ".pi", "workflows"), "not a directory");
    expect(listSavedWorkflows(project, root)).toEqual([]);
  });

  it("drops malformed trusted model-policy maps with field-specific warnings", () => {
    mkdirSync(join(root, "agent"), { recursive: true });
    writeFileSync(join(root, "agent", "subagents.json"), JSON.stringify({ modelTiers: [], agentModels: [], modelAliases: [] }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(loadSettings(join(root, "project"), root)).toEqual({ modelTiers: {} });
    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      "[pi-subagents] Ignoring modelTiers: expected an object of tier -> model list.",
      "[pi-subagents] Ignoring modelAliases: expected an object of alias -> provider/model candidates.",
      "[pi-subagents] Ignoring agentModels: expected an object of agent type -> model.",
    ]);
  });

  it.each([null, { version: 1, settings: [] }, { version: 1, models: { providers: [] } }])("rejects invalid private manifest %j without logging payloads", manifest => {
    const path = enterpriseLocalPath(root);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(manifest), { mode: 0o600 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(readEnterpriseLocalManifest(root)).toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain("Ignoring invalid");
    expect(warn.mock.calls[0][0]).not.toContain(JSON.stringify(manifest));
  });

  it("reports bounded lock contention without overwriting the owner or backing file", () => {
    const path = join(root, "jobs.json");
    const store = new ScheduleStore(path);
    store.add(job());
    const before = readFileSync(path, "utf8");
    writeFileSync(`${path}.lock`, String(process.pid));
    // The production lock has no injected clock. Advance only its synchronous
    // deadline reads, not real time, so the bounded retry path never sleeps.
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now += 51);
    expect(() => store.update("job", { name: "wrong" })).toThrow(`Failed to acquire schedule lock: ${path}.lock`);
    expect(readFileSync(`${path}.lock`, "utf8")).toBe(String(process.pid));
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("bounds retries even when the lock cannot be read as a PID file", () => {
    const path = join(root, "jobs.json");
    const store = new ScheduleStore(path);
    mkdirSync(`${path}.lock`);
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now += 51);
    expect(() => store.add(job())).toThrow("Failed to acquire schedule lock");
    expect(store.list()).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("surfaces a real lock-create permission failure instead of retrying forever", () => {
    const dir = join(root, "readonly");
    mkdirSync(dir);
    const store = new ScheduleStore(join(dir, "jobs.json"));
    chmodSync(dir, 0o500);
    try {
      expect(() => store.add(job())).toThrow(/EACCES|EPERM/);
      expect(store.list()).toEqual([]);
    } finally { chmodSync(dir, 0o700); }
  });
});

describe("diagnostic and schema boundaries", () => {
  it("releases a process-budget lease when a grant consumer throws", () => {
    const before = budgetUsage();
    const grant = vi.fn(() => { throw new Error("consumer failed"); });
    const cancel = enqueueBudget({ depth: 1, ready: () => true, grant });
    pumpBudget();
    expect(grant).toHaveBeenCalledOnce();
    expect(budgetUsage()).toEqual(before);
    cancel();
  });

  it("formats object workflow results and rejects a prior run without a journal", () => {
    const task = createWorkflowTask({ id: "wf_prior", script: "", startTime: 1000 });
    task.status = "completed";
    task.value = { answer: 42 };
    expect(workflowResultText(task)).toBe('{\n  "answer": 42\n}');
    expect(resolveResumeTarget(task.id, new Map([[task.id, task]]))).toEqual({ ok: false, message: 'Workflow "wf_prior" has no journal to resume from.' });
  });

  it("validates historical unavailable and exhausted tier provenance without resolving today's models", () => {
    expect(isTierDisclosure({ kind: "unavailable", tier: "cheap", tried: ["p/a", "p/b"] })).toBe(true);
    expect(isTierDisclosure({ kind: "unavailable", tier: "cheap", tried: [1] })).toBe(false);
    const valid = { kind: "exhausted", tier: "cheap", skipped: [{ ref: "p/a", why: "quota" }, { ref: "p/b", why: "no-credentials" }], block: { model: "@cheap", wait: true, resetAt: 1000 } };
    expect(isTierDisclosure(valid)).toBe(true);
    expect(isTierDisclosure({ ...valid, skipped: [{ ref: "p/a", why: "unknown" }] })).toBe(false);
    expect(isTierDisclosure({ ...valid, block: { model: "@cheap", resetAt: Infinity } })).toBe(false);
    expect(tierNote({ kind: "static", tier: "cheap", model: { provider: "p", id: "b", name: "B", api: "openai-completions" }, member: "p/b", skipped: [{ ref: "p/a", why: "quota" }], quotaSignal: true })).toBe("Model: @cheap -> p/b (static); skipped p/a: quota");
  });

  it("reports an unknown branch when git detection succeeds but branch lookup rejects", async () => {
    const exec = vi.fn().mockResolvedValueOnce({ code: 0, stdout: "true\n", stderr: "" }).mockRejectedValueOnce(new Error("missing git"));
    const env = await detectEnv({ exec } as unknown as ExtensionAPI, root);
    expect(env).toMatchObject({ isGitRepo: true, branch: "unknown" });
    expect(exec).toHaveBeenNthCalledWith(2, "git", ["branch", "--show-current"], { cwd: root, timeout: 5000 });
  });

  it("preserves the shipped default-agent namespace", () => {
    expect(DEFAULT_AGENT_NAMES).toEqual(["general-purpose", "Explore", "Plan"]);
  });

  it("rejects a schema with an invalid pattern before a child is launched", () => {
    const result = compileJsonSchema({ type: "object", patternProperties: { "[": { type: "string" } } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("not a schema this runtime can validate");
  });

  it("rejects a circular schema before paying for a child request", () => {
    const schema: Record<string, unknown> = { type: "object" };
    schema.self = schema;
    expect(compileJsonSchema(schema)).toEqual({ ok: false, message: "agent() opts.schema must be JSON-serializable." });
  });

  it("returns a validation diagnostic rather than throwing when a payload getter fails", () => {
    const compiled = compileJsonSchema({ type: "object", properties: { x: { type: "string" } } });
    if (!compiled.ok) throw new Error(compiled.message);
    const payload = { get x() { throw new Error("payload failed"); } };
    expect(compiled.compiled.check(payload)).toBe("the value could not be validated: payload failed");
  });
});
