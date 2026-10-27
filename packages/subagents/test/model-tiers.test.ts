/** Tier matching uses Pi's real credential-aware registry, never fuzzy registry doubles. */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeEvicted } from "../src/agent-manager.js";
import { DEFAULT_AGENTS } from "../src/default-agents.js";
import { setAgentModels, setModelAliases, setModelScopeProvider } from "../src/model-resolver.js";
import { setScopeModelsEnabled } from "../src/model-scope.js";
import { admitModelSelection, describeSelection, modelSelectionNote, selectModel } from "../src/model-selection.js";
import { parseTierBinding, resolveTier, setModelTiers, tierDisclosure } from "../src/model-tiers.js";
import { appendModelTierEntry } from "../src/output-file.js";
import { loadSettings } from "../src/settings.js";
import { AgentResultView } from "../src/ui/agent-row.js";
import type { AgentDetails } from "../src/ui/agent-widget.js";
import { fallbackFlag } from "../src/ui/fallback-flag.js";
import { appendJournal, readJournal, type WorkflowJournalEntry } from "../src/workflow/journal.js";
import { runWorkflow } from "../src/workflow/runtime.js";

let dir: string;
let registry: ModelRegistry;
const ref = (id: string) => `tier-test/${id}`;
const costs = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "model-tiers-"));
  const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  registry = new ModelRegistry(runtime);
  registry.registerProvider("tier-test", {
    api: "openai-completions", baseUrl: "http://localhost:1", apiKey: "fixture-not-a-secret",
    models: ["parent", "a", "b", "gpt-6-luna", "gpt-7-luna", "tier-unique-pin", "revision@20240620"].map(id => ({
      id, name: id, reasoning: false, input: ["text"], contextWindow: 1000, maxTokens: 100, cost: costs,
    })),
  });
  registry.registerProvider("no-tier-credentials", {
    api: "openai-completions", baseUrl: "http://localhost:1",
    models: [{ id: "a", name: "a", reasoning: false, input: ["text"], contextWindow: 1000, maxTokens: 100, cost: costs }],
  });
});
afterEach(() => {
  setModelTiers(undefined, undefined);
  setAgentModels(undefined);
  setModelAliases(undefined);
  setModelScopeProvider(undefined);
  setScopeModelsEnabled(false);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

function select(model: string) {
  return selectModel({ agentType: "Scout", paramModel: model, parentModel: registry.find("tier-test", "parent"), registry, cwd: dir });
}
const open = async () => ({ quotaSignal: false });

describe("exact model tiers", () => {
  it("keeps Explore's bare stopgap pinned to exact authenticated Anthropic Haiku without local aliases", async () => {
    registry.registerProvider("anthropic", {
      api: "anthropic-messages", baseUrl: "http://localhost:1", apiKey: "fixture-not-a-secret",
      models: ["claude-haiku-4-5", "claude-haiku-5-5"].map(id => ({ id, name: id, reasoning: false, input: ["text"], contextWindow: 1000, maxTokens: 100, cost: costs })),
    });
    const request = { agentType: "Explore", definitionModel: DEFAULT_AGENTS.get("Explore")?.model,
      parentModel: registry.find("tier-test", "parent"), registry, cwd: dir };
    setModelTiers({}, { onUnavailable: "error" });
    expect(selectModel(request)).toMatchObject({ source: "definition", outcome: "resolved", model: { provider: "anthropic", id: "claude-haiku-4-5" } });
    setModelAliases({ "claude-haiku-4-5": [ref("b")] });
    expect(selectModel(request)).toMatchObject({ tierBinding: { kind: "static", members: [ref("b")] } });
    setModelAliases(undefined);
    for (const definitionModel of ["claude-haiku-4.5", "constructor", "toString", "__proto__"]) {
      expect(selectModel({ ...request, definitionModel })).toContain("Model not found");
    }
  });
  it("selects the first credentialed static member and lists skips without a router", async () => {
    setModelTiers({ cheap: ["no-tier-credentials/a", ref("b")] }, {});
    const outcome = await resolveTier("cheap", { registry, admit: open });
    expect(outcome).toMatchObject({ kind: "static", tier: "cheap", member: ref("b"), model: { id: "b" },
      skipped: [{ ref: "no-tier-credentials/a", why: "no-credentials" }], quotaSignal: false });
  });

  it("retains quota refusal reasons while admitting the next static member", async () => {
    setModelTiers({ cheap: [ref("a"), ref("b")] }, {});
    const admit = vi.fn(async (model: string) => model === ref("a")
      ? { quotaSignal: true, block: { model, resetAt: 1234 } } : { quotaSignal: true });
    expect(await resolveTier("cheap", { registry, admit })).toMatchObject({ kind: "static", member: ref("b"),
      skipped: [{ ref: ref("a"), why: "quota" }], quotaSignal: true });
    expect(admit.mock.calls.map(([model]) => model)).toEqual([ref("a"), ref("b")]);
  });

  it("returns exhausted rather than inheriting when all static members refuse", async () => {
    setModelTiers({ cheap: [ref("a"), ref("b")], default: [ref("parent")] }, {});
    const admit = vi.fn(async (model: string) => ({ quotaSignal: true, block: { model, resetAt: 1234, wait: false } }));
    expect(await resolveTier("cheap", { registry, admit })).toMatchObject({ kind: "exhausted", tier: "cheap", block: { wait: false }, skipped: [{ why: "quota" }, { why: "quota" }] });
    expect(admit.mock.calls.map(([model]) => model)).toEqual([ref("a"), ref("b")]);
  });

  it("accepts exact revision-qualified model ids without treating @ as tier nesting", async () => {
    const member = ref("revision@20240620");
    setModelTiers({ cheap: [member] }, {});
    expect(await resolveTier("cheap", { registry, admit: open })).toMatchObject({ kind: "static", member, model: { id: "revision@20240620" } });
    setModelAliases({ enterprise: [member] });
    expect(select("enterprise")).toMatchObject({ model: { id: "revision@20240620" }, tierBinding: { kind: "static" } });
    expect(selectModel({ agentType: "Scout", definitionModel: member, parentModel: registry.find("tier-test", "parent"), registry, cwd: dir })).toMatchObject({ outcome: "resolved", model: { id: "revision@20240620" } });
    expect(parseTierBinding("cheap", ["@other"])).toBeUndefined();
  });

  it("keeps fuzzy matching exclusive to explicit non-tier tool inputs", () => {
    expect(select("gpt")).toMatchObject({ model: { id: "gpt-7-luna" }, source: "param" });
    const request = { agentType: "Scout", parentModel: registry.find("tier-test", "parent"), registry, cwd: dir };
    expect(selectModel({ ...request, definitionModel: "gpt" })).toMatchObject({ outcome: "fallback", model: { id: "parent" } });
    setAgentModels({ Scout: "missing-provider/gpt-6-luna" });
    expect(selectModel(request)).toMatchObject({ outcome: "fallback", model: { id: "parent" } });
    setModelTiers(undefined, { onUnavailable: "error" });
    expect(selectModel(request)).toContain("Model not found");
  });

  it("does not fuzzy match a missing entry or borrow a sibling/provider", async () => {
    setModelTiers({ cheap: ["missing/gpt-6-luna"] }, {});
    expect(await resolveTier("cheap", { registry, admit: open })).toEqual({ kind: "unavailable", tier: "cheap", tried: ["missing/gpt-6-luna"] });
    setModelTiers({ cheap: [ref("gpt-6")] }, {});
    expect(await resolveTier("cheap", { registry, admit: open })).toMatchObject({ kind: "unavailable" });
    expect(registry.getAvailable().some(model => model.id === "tier-unique-pin")).toBe(true);
    setModelTiers({ cheap: ["missing-provider/tier-unique"] }, {});
    expect(await resolveTier("cheap", { registry, admit: open })).toMatchObject({ kind: "unavailable" });
  });

  it("ignores enabledModels and newer siblings even for an explicit tier", async () => {
    setModelTiers({ cheap: [ref("gpt-6-luna")] }, {});
    const before = await resolveTier("cheap", { registry, admit: open });
    registry.registerProvider("tier-test", {
      api: "openai-completions", baseUrl: "http://localhost:1", apiKey: "fixture-not-a-secret",
      models: ["parent", "gpt-6-luna", "gpt-7-luna", "gpt-8-luna"].map(id => ({ id, name: id, reasoning: false, input: ["text"], contextWindow: 1000, maxTokens: 100, cost: costs })),
    });
    expect(registry.find("tier-test", "gpt-8-luna")).toBeDefined();
    setModelScopeProvider(() => new Set([ref("gpt-7-luna")]));
    mkdirSync(join(dir, ".pi"));
    writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ enabledModels: [ref("parent")] }));
    setScopeModelsEnabled(true);
    expect(await resolveTier("cheap", { registry, admit: open })).toEqual(before);
    expect(select("@cheap")).toMatchObject({ requested: "@cheap", model: { id: "gpt-6-luna" } });
  });

  it.each(["inherit", "error"] as const)("honors unavailable policy after a registry change between preflight and admission (%s)", async mode => {
    setModelTiers({ cheap: [ref("b")] }, { onUnavailable: mode });
    const selection = select("@cheap");
    if (typeof selection === "string") throw new Error(selection);
    registry.unregisterProvider("tier-test");
    const events = { on: (_channel: string, _handler: (data: unknown) => void) => () => {}, emit: () => {} };
    const admission = admitModelSelection(selection, registry, events);
    if (mode === "error") await expect(admission).rejects.toThrow("Model tier @cheap is unavailable.");
    else {
      await admission;
      expect(selection).toMatchObject({ outcome: "fallback", model: { id: "parent" }, tier: { kind: "unavailable" } });
      expect(selection.tierBinding).toBeUndefined();
      expect(selection.tierParent).toBeUndefined();
    }
  });

  it.each(["inherit", "error"] as const)("reports an absent router with policy %s", mode => {
    setModelTiers({ cheap: ["router/cheap"] }, { onUnavailable: mode });
    const selection = select("@cheap");
    if (mode === "error") expect(selection).toBe("Model tier @cheap is unavailable.");
    else {
      expect(selection).toMatchObject({ model: { id: "parent" }, tier: { kind: "unavailable", tier: "cheap" } });
      if (typeof selection !== "string") expect(modelSelectionNote({ modelTier: selection.tier })).toContain("unavailable");
    }
  });

  it.each(["inherit", "error"] as const)("reports an unmapped tier with policy %s", mode => {
    setModelTiers({}, { onUnmapped: mode });
    const selection = select("@cheap");
    if (mode === "error") expect(selection).toBe("Model tier @cheap is unmapped.");
    else expect(selection).toMatchObject({ model: { id: "parent" }, tier: { kind: "unmapped", tier: "cheap" } });
  });

  it("keeps legacy modelAliases as exact static tiers", async () => {
    setModelAliases({ "claude-haiku-4-5": ["no-tier-credentials/a", ref("b")] });
    const selection = select("claude-haiku-4-5");
    expect(typeof selection).not.toBe("string");
    if (typeof selection === "string") throw new Error(selection);
    const events = { on: (_channel: string, _handler: (data: unknown) => void) => () => {}, emit: () => {} };
    await admitModelSelection(selection, registry, events);
    expect(selection.tier).toMatchObject({ kind: "static", member: ref("b"), skipped: [{ why: "no-credentials" }] });
  });

  it("labels the admitted physical model without replacing the router virtual model", async () => {
    registry.registerVirtualModel({ provider: "router", id: "cheap", name: "cheap", route: () => { throw new Error("not dispatched"); } });
    setModelTiers({ cheap: ["router/cheap"] }, {});
    const outcome = await resolveTier("cheap", { registry, admit: async () => ({ quotaSignal: true, resolvedModel: ref("b") }) });
    expect(outcome).toMatchObject({ kind: "routed", profile: "router/cheap", admitted: ref("b"), model: { api: "pi-virtual", id: "cheap" } });
    expect(describeSelection({ model: outcome.kind === "routed" ? outcome.model : undefined, tier: outcome, source: "param", outcome: "resolved" }, registry)).toEqual({ modelName: "b", modelId: ref("b") });
  });
});

describe("durable tier disclosure", () => {
  it.each(["unmapped", "unavailable"] as const)("names %s tier inheritance in the collapsed leading flag", async kind => {
    setModelTiers(kind === "unavailable" ? { cheap: ["absent/model"] } : {}, {});
    const modelTier = await resolveTier("cheap", { registry, admit: open });
    expect(fallbackFlag({ fg: (_color, text) => text }, { modelTier })).toBe(`[@cheap ${kind}]`);
  });
  it("retains outcomes and notes through journal replay and replay-of-replay", async () => {
    setModelTiers({ cheap: [ref("b")] }, {});
    const modelTier = tierDisclosure(await resolveTier("cheap", { registry, admit: open }));
    const modelNote = modelSelectionNote({ modelTier });
    const entries: WorkflowJournalEntry[] = [];
    const host = { spawnAgent: vi.fn(async () => ({ ok: true, text: `${modelNote}\n\nanswer`, modelNote, modelTier })), abortAgent: () => {} };
    const script = 'export const meta = { name: "tiers", description: "Tier replay" }; return await agent("answer", { model: "@cheap" });';
    const first = await runWorkflow({ script, host, journal: { entries: [], append: entry => entries.push(entry) } });
    expect(first.status).toBe("completed");
    expect(entries[0]?.modelTier).toEqual(modelTier);
    const path = join(dir, "tiers.jsonl");
    for (const entry of entries) appendJournal(path, entry);
    expect(readJournal(path)[0]?.modelTier).toEqual(modelTier);
    const rewritten: WorkflowJournalEntry[] = [];
    const second = await runWorkflow({ script, host, journal: { entries: readJournal(path), append: entry => rewritten.push(entry) } });
    expect(second.replayedCount).toBe(1);
    expect(second.progress).toContainEqual(expect.objectContaining({ type: "workflow_agent", cached: true, modelTier, modelNote }));
    expect(rewritten[0]).toMatchObject({ modelTier: JSON.parse(JSON.stringify(modelTier)), modelNote });
    const third = await runWorkflow({ script, host, journal: { entries: rewritten } });
    expect(third.replayedCount).toBe(1);
    expect(third.value).toContain(modelNote);
    expect(host.spawnAgent).toHaveBeenCalledTimes(1);
  });

  it("never persists credential-bearing model headers or provider URLs", async () => {
    setModelTiers({ cheap: [ref("b")] }, {});
    const outcome = await resolveTier("cheap", { registry, admit: open });
    if (outcome.kind !== "static") throw new Error("Expected static tier");
    outcome.model.headers = { Authorization: "fixture-private-header" };
    outcome.model.baseUrl = "https://fixture-private-endpoint";
    const transcript = join(dir, "safe.output");
    const journal = join(dir, "safe.jsonl");
    appendModelTierEntry(transcript, "agent", outcome);
    appendJournal(journal, { index: 0, key: "safe", ok: true, modelTier: outcome });
    for (const path of [transcript, journal]) {
      const text = readFileSync(path, "utf-8");
      expect(text).not.toContain("fixture-private");
      expect(text).not.toContain("headers");
      expect(text).not.toContain("baseUrl");
      expect(text).toContain(ref("b"));
    }
  });

  it("rejects corrupt tier provenance in journals without dropping valid earlier entries", () => {
    const path = join(dir, "bad-tier.jsonl");
    appendJournal(path, { index: 0, key: "valid", ok: true, modelTier: { kind: "unmapped", tier: "cheap" } });
    writeFileSync(path, `${JSON.stringify({ index: 1, key: "bad", ok: true, modelTier: { kind: "invented", tier: "cheap" } })}\n`, { flag: "a" });
    writeFileSync(path, `${JSON.stringify({ index: 2, key: "missing-identity", ok: true, modelTier: { kind: "static", tier: "cheap", model: { provider: "tier-test", id: "b" }, member: ref("b"), skipped: [], quotaSignal: false } })}\n`, { flag: "a" });
    expect(readJournal(path).map(entry => entry.key)).toEqual(["valid"]);
  });

  it("keeps tier provenance in evicted-id text and transcript JSONL", async () => {
    setModelTiers({ cheap: [ref("b")] }, {});
    const modelTier = tierDisclosure(await resolveTier("cheap", { registry, admit: open }));
    expect(describeEvicted({ id: "evicted", type: "Scout", description: "test", status: "completed", evictedAfterMin: 10, modelTier })).toContain(`Model: @cheap -> ${ref("b")}`);
    const path = join(dir, "transcript.output");
    appendModelTierEntry(path, "agent", modelTier);
    const entry = JSON.parse(readFileSync(path, "utf-8"));
    expect(entry).toMatchObject({ type: "model-tier", modelTier: JSON.parse(JSON.stringify(modelTier)), note: modelSelectionNote({ modelTier }) });
  });

  it.each([0, 1, 2, 4, 8, 12, 40, 80])("preserves a whole leading tier flag at width %i", async width => {
    setModelTiers({ cheap: [ref("b")] }, {});
    const modelTier = tierDisclosure(await resolveTier("cheap", { registry, admit: open }));
    const details: AgentDetails = { displayName: "Scout", description: "a".repeat(200), subagentType: "Scout", toolUses: 0,
      tokens: "", durationMs: 0, status: "completed", modelTier, modelNote: modelSelectionNote({ modelTier }) };
    const view = new AgentResultView(details, "answer", false, { getRecord: () => undefined, getActivity: () => undefined, showCost: () => false }, { fg: (_color, text) => text, bold: text => text });
    const [line] = view.render(width);
    expect(visibleWidth(line!)).toBeLessThanOrEqual(width);
    if (width) expect(line).toMatch(/\[@cheap\]|\[fb\]|!/);
    else expect(line).toBe("");
  });
});

describe("tier configuration boundary", () => {
  it("fuzzes every ASCII separator without case folding or whitespace normalization", () => {
    for (let code = 0; code < 128; code++) {
      const character = String.fromCharCode(code);
      const binding = parseTierBinding(`a${character}b`, [ref("a")]);
      expect(binding !== undefined, `ASCII ${code}`).toBe(/^[a-z0-9._-]$/.test(character));
    }
  });
  it.each(["", " ", "@", "@cheap", "Cheap", "a b", "../cheap", "a/b", "a\n", "💥", "a@b", "a:b"])("rejects odd tier key %j", tier => {
    expect(parseTierBinding(tier, [ref("a")])).toBeUndefined();
  });

  it.each([["@other"], ["router/cheap", ref("a")], ["router/a", "router/b"], ["a"], [], ["a/"], ["/b"], [" a/b"], ["a/b "], [123]])("rejects malformed or nested binding %j", (...members) => {
    expect(parseTierBinding("cheap", members)).toBeUndefined();
  });

  it("is case sensitive and treats @ alone as a visible unmapped request", () => {
    setModelTiers({ cheap: [ref("a")] }, {});
    for (const input of ["@Cheap", "@", "@ cheap", "@cheap "]) {
      const selection = select(input);
      // Surrounding whitespace is trimmed; whitespace inside a tier is not.
      expect(selection).toMatchObject(input === "@cheap " ? { tierBinding: { tier: "cheap" } } : { tier: { kind: "unmapped" } });
    }
    expect(select("   ")).toMatchObject({ source: "parent", outcome: "inherited" });
  });

  it("ignores project tiers and policy, permits enterprise overrides and warns on invalid bindings", () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", dir);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeFileSync(join(dir, "subagents.json"), JSON.stringify({ modelTiers: { cheap: [ref("a")], bad: ["@cheap"] }, modelResolution: { onUnmapped: "error" } }));
    mkdirSync(join(dir, ".pi"));
    writeFileSync(join(dir, ".pi", "subagents.json"), JSON.stringify({ modelTiers: { cheap: [ref("b")] }, modelResolution: { onUnmapped: "inherit" } }));
    expect(loadSettings(dir)).toMatchObject({ modelTiers: { cheap: [ref("a")] }, modelResolution: { onUnmapped: "error" } });
    expect(loadSettings(dir).modelTiers).not.toHaveProperty("bad");
    const manifest = join(dir, "enterprise.local.json");
    writeFileSync(manifest, JSON.stringify({ version: 1, subagents: { modelTiers: { cheap: [ref("b")] } } }));
    chmodSync(manifest, 0o600);
    expect(loadSettings(dir).modelTiers).toEqual({ cheap: [ref("b")] });
    expect(warn.mock.calls.flat().join("\n")).toContain("Ignoring invalid modelTiers");
    expect(warn.mock.calls.flat().join("\n")).toContain("project .pi/subagents.json");
  });
});
