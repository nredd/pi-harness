/** Selection policy through Pi's real credential-aware registry, never a resolver mock. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { explainModel, modelConfigurationWarnings } from "../src/model-explanation.js";
import { setAgentModels, setModelAliases, setModelScopeProvider } from "../src/model-resolver.js";
import { setScopeModelsEnabled } from "../src/model-scope.js";
import { admitModelSelection, describeSelection, type ModelSelection, selectModel } from "../src/model-selection.js";
import { setModelTiers } from "../src/model-tiers.js";
import { loadSettings } from "../src/settings.js";

let dir: string;
let registry: ModelRegistry;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "model-selection-"));
  const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  registry = new ModelRegistry(runtime);
  registry.registerProvider("selection-test", {
    api: "openai-completions", baseUrl: "http://localhost:1", apiKey: "fixture-not-a-secret",
    models: ["parent", "definition", "wildcard", "typed", "explicit", "gpt-5-test", "gpt-6-test"].map(id => ({
      id, name: id, reasoning: false, input: ["text"], contextWindow: 1000, maxTokens: 100,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })),
  });
  registry.registerVirtualModel({ provider: "router", id: "default", name: "Router default", route: () => {
    throw new Error("selection must not route or make a network request");
  } });
});
afterEach(() => {
  setAgentModels(undefined);
  setModelAliases(undefined);
  setModelScopeProvider(undefined);
  setScopeModelsEnabled(false);
  setModelTiers(undefined, undefined);
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const ref = (id: string) => `selection-test/${id}`;
function select(definitionModel?: string, paramModel?: string) {
  return selectModel({ agentType: "Scout", definitionModel, paramModel, parentModel: registry.find("selection-test", "parent"), registry, cwd: dir });
}

describe("selectModel", () => {
  it("checks injected-home scope while retaining trusted tier policy", () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "");
    const homeDir = join(dir, "home");
    const agentDir = join(homeDir, ".pi", "agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ enabledModels: [ref("parent")] }));
    setScopeModelsEnabled(true);
    setModelTiers({ cheap: [ref("explicit")] }, undefined);
    const request = { homeDir, agentType: "Scout", parentModel: registry.find("selection-test", "parent"), registry, cwd: dir };
    // Explicit physical choices are errors, but trusted tier choices warn and run.
    expect(selectModel({ ...request, paramModel: ref("explicit") })).toContain("Model not in scope");
    expect(selectModel({ ...request, paramModel: "@cheap" })).toMatchObject({
      requested: "@cheap", outcome: "resolved", model: { id: "explicit" },
      tierBinding: { kind: "static", tier: "cheap", members: [ref("explicit")] },
      scopeWarning: expect.stringContaining("out-of-scope"),
    });
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ enabledModels: [ref("explicit")] }));
    expect(selectModel({ ...request, paramModel: ref("explicit") })).toMatchObject({ model: { id: "explicit" } });
    expect(selectModel({ ...request, paramModel: "@cheap" })).not.toHaveProperty("scopeWarning");
  });

  it("returns the original input and winning source at every precedence level", () => {
    setAgentModels({ scout: ref("typed"), "*": ref("wildcard") });
    expect(select(ref("definition"), ref("explicit"))).toMatchObject({ requested: ref("explicit"), source: "param", model: { id: "explicit" }, outcome: "resolved" });
    expect(select(ref("definition"))).toMatchObject({ requested: ref("typed"), source: "agentModels:type", model: { id: "typed" } });
    setAgentModels({ "*": ref("wildcard") });
    expect(select(ref("definition"))).toMatchObject({ requested: ref("wildcard"), source: "agentModels:*", model: { id: "wildcard" } });
    setAgentModels(undefined);
    expect(select(ref("definition"))).toMatchObject({ requested: ref("definition"), source: "definition", model: { id: "definition" } });
    expect(select()).toMatchObject({ source: "parent", outcome: "inherited", model: { id: "parent" } });
  });

  it("retains fuzzy, alias, virtual and provider-retry behavior", () => {
    setModelAliases({ portable: [ref("explicit")] });
    expect(select(undefined, "portable")).toMatchObject({ model: { id: "explicit" } });
    expect(select(undefined, "gpt")).toMatchObject({ model: { id: "gpt-6-test" } });
    expect(select(undefined, "absent/explicit")).toMatchObject({ model: { provider: "selection-test", id: "explicit" } });
    expect(select(undefined, "router/default")).toMatchObject({ model: { api: "pi-virtual", provider: "router", id: "default" } });
  });

  it("treats a registered but unauthenticated pin as unavailable through the real registry", () => {
    registry.registerProvider("selection-unavailable", {
      api: "openai-completions", baseUrl: "http://localhost:1",
      models: [{ id: "unavailable-pin", name: "Unavailable pin", reasoning: false, input: ["text"],
        contextWindow: 1000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    });
    expect(registry.find("selection-unavailable", "unavailable-pin")).toBeDefined();
    expect(registry.getAvailable().some(model => model.provider === "selection-unavailable")).toBe(false);
    expect(select("selection-unavailable/unavailable-pin")).toMatchObject({ outcome: "fallback", model: { id: "parent" } });
    expect(select(undefined, "selection-unavailable/unavailable-pin")).toContain("Model not found");
  });

  it("uses dispatch scope for fuzzy resolution and unresolved explicit-model diagnostics", () => {
    let scopeContext: { cwd: string; homeDir?: string } | undefined;
    setModelScopeProvider((_registry, context) => {
      scopeContext = context;
      return context ? new Set([ref("parent"), ref("gpt-5-test")]) : new Set([ref("gpt-6-test")]);
    });
    const selected = select(undefined, "gpt");
    expect(selected).toMatchObject({ model: { id: "gpt-5-test" } });
    const result = select(undefined, "missing-model");
    expect(scopeContext).toEqual({ cwd: dir, homeDir: undefined });
    expect(result).toContain(`  ${ref("parent")}`);
    expect(result).not.toContain(ref("explicit"));
  });

  it("discloses an unresolved config without falling through to another config source", () => {
    setAgentModels({ scout: "does-not-exist", "*": ref("wildcard") });
    expect(select(ref("definition"))).toMatchObject({
      requested: "does-not-exist", source: "agentModels:type", outcome: "fallback", model: { id: "parent" },
      fallback: { input: "does-not-exist", used: "selection-test/parent" },
    });
    expect(select(undefined, "does-not-exist")).toContain('Model not found: "does-not-exist"');
  });
});

describe("effective model explanation", () => {
  it.each([
    ["explicit", { scout: ref("typed"), "*": ref("wildcard") }, ref("definition"), "gpt", "param"],
    ["type", { scout: ref("typed"), "*": ref("wildcard") }, ref("definition"), undefined, "agentModels:type"],
    ["wildcard", { "*": ref("wildcard") }, ref("definition"), undefined, "agentModels:*"],
    ["definition", {}, ref("definition"), undefined, "definition"],
    ["parent", {}, undefined, undefined, "parent"],
    ["missing", {}, "fixture/missing", undefined, "definition"],
    ["unmapped", {}, "@missing", undefined, "definition"],
    ["static", {}, "@cheap", undefined, "definition"],
    ["routed", {}, "@review", undefined, "definition"],
    ["alias", {}, "portable", undefined, "definition"],
    ["unknown explicit", {}, undefined, "missing", "param"],
  ] as const)("matches dispatch without admission: %s", (_name, overrides, definitionModel, paramModel, source) => {
    setAgentModels(overrides);
    setModelAliases({ portable: [ref("explicit")] });
    setModelTiers({ cheap: [ref("typed")], review: ["router/default"] }, undefined);
    const request = { agentType: "Scout", definitionModel, paramModel, parentModel: registry.find("selection-test", "parent"), registry, cwd: dir };
    const selection = selectModel(request);
    const explanation = explainModel(request);
    expect(explanation.source).toBe(source);
    if (typeof selection === "string") {
      expect(explanation.outcome).toBe("error");
      expect(explanation.text).not.toContain("Available models:");
    } else {
      expect(explanation.outcome).toBe(selection.outcome);
      expect(explanation.selected).toBe(`${selection.model?.provider}/${selection.model?.id}`);
    }
    expect(explanation.text).toContain("Admitted physical model: unknown");
    expect(explanation.text).toContain("Answering model: unknown");
    expect(explanation.text).toContain("not a reservation");
    expect(explanation.text).not.toContain("localhost");
    if (source === "agentModels:type") expect(explanation.text).toContain(`Shadowed definition: ${ref("definition")}`);
    if (_name === "routed") {
      expect(explanation.virtual).toBe(true);
      expect(explanation.text).toContain("Exact binding: routed router/default");
    }
    if (_name === "static") expect(explanation.text).toContain(`Exact binding: static ${ref("typed")}`);
  });

  it.each(["error", "inherit"] as const)("reports configured failure policy truthfully: %s", mode => {
    setModelTiers({}, { onUnmapped: mode, onUnavailable: mode });
    const request = { agentType: "Scout", definitionModel: "@absent", parentModel: undefined, registry, cwd: dir };
    expect(explainModel(request).summary).toContain(mode === "error" ? "error; no dispatch" : "fallback: inherit");
    expect(explainModel(request).summary.includes("fallback: inherit")).toBe(mode === "inherit");
    expect(explainModel(request).text).toContain(`unmapped=${mode}; unavailable=${mode}`);
    expect(explainModel(request).text).toContain("Exact binding: unmapped");
    expect(explainModel(request).selected).toBeUndefined();
  });

  it("explains enterprise whole-field replacement rather than a merged personal binding", () => {
    const agentDir = join(dir, "agent");
    mkdirSync(agentDir);
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    writeFileSync(join(agentDir, "subagents.json"), JSON.stringify({
      agentModels: { scout: "@personal", "*": "@personal" }, modelTiers: { personal: [ref("typed")] },
      modelResolution: { onUnmapped: "error", onUnavailable: "error" },
    }));
    writeFileSync(join(agentDir, "enterprise.local.json"), JSON.stringify({ version: 1, subagents: {
      agentModels: { "*": "@work" }, modelTiers: { work: [ref("explicit")] },
      modelResolution: { onUnmapped: "inherit", onUnavailable: "inherit" },
    } }), { mode: 0o600 });
    const settings = loadSettings(dir);
    setAgentModels(settings.agentModels);
    setModelTiers(settings.modelTiers, settings.modelResolution);
    const request = { agentType: "Scout", definitionModel: ref("definition"), paramModel: "  ", parentModel: registry.find("selection-test", "parent"), registry, cwd: dir };
    expect(selectModel(request)).toMatchObject({ source: "agentModels:*", model: { id: "explicit" } });
    const explanation = explainModel(request);
    expect(explanation).toMatchObject({ source: "agentModels:*", selected: ref("explicit"), outcome: "resolved" });
    expect(explanation.text).toContain(`Shadowed definition: ${ref("definition")}`);
    expect(explanation.text).not.toContain("personal");
    expect(explanation.text).toContain("unmapped=inherit; unavailable=inherit");
  });

  it("never discloses raw errors, unsafe requests, overlays or object parameters", () => {
    const request = { agentType: "Scout", paramModel: "!credential-command https://private.invalid", parentModel: undefined, registry, cwd: dir };
    const explanation = explainModel(request);
    expect(explanation.text).toContain("[redacted]");
    expect(explanation.text).not.toMatch(/credential-command|private.invalid|Available models|fixture-not-a-secret/);
    expect(explainModel({ ...request, paramModel: registry.find("selection-test", "explicit") }).selected).toBe(ref("explicit"));
    expect(explainModel({ ...request, paramModel: undefined }).text).toContain("Selected: unknown");
  });

  it("uses only registered metadata for startup diagnostics, not credential or quota availability", () => {
    setModelTiers({ cheap: [ref("typed")] }, { onUnavailable: "error", onUnmapped: "error" });
    const getAvailable = vi.spyOn(registry, "getAvailable").mockImplementation(() => { throw new Error("must not inspect credentials"); });
    const request = { agentType: "Scout", definitionModel: "@cheap", parentModel: undefined, registry, cwd: dir };
    expect(modelConfigurationWarnings([request])).toEqual([]);
    expect(modelConfigurationWarnings([{ ...request, definitionModel: "@missing" }])).toEqual([expect.stringContaining("error; no dispatch")]);
    expect(getAvailable).not.toHaveBeenCalled();
  });

  it("keeps scope refusals private and trusted scope warnings visible", () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "");
    const homeDir = join(dir, "home");
    mkdirSync(join(homeDir, ".pi", "agent"), { recursive: true });
    writeFileSync(join(homeDir, ".pi", "agent", "settings.json"), JSON.stringify({ enabledModels: [ref("parent")] }));
    setScopeModelsEnabled(true);
    const request = { homeDir, agentType: "Scout", parentModel: undefined, registry, cwd: dir };
    expect(explainModel({ ...request, definitionModel: ref("typed") }).text).toContain("Scope warning:");
    expect(explainModel({ ...request, paramModel: ref("typed") }).outcome).toBe("error");
  });
});

describe("admitModelSelection", () => {
  const events = { on: (_channel: string, _handler: (data: unknown) => void) => () => {}, emit: () => {} };
  const bound = (members: string[]): ModelSelection => ({
    source: "param", model: undefined, outcome: "resolved", tierBinding: { kind: "static", tier: "cheap", members },
  });

  it("makes no admission for a selection without a prepared binding", async () => {
    const selection: ModelSelection = { source: "param", model: registry.find("selection-test", "parent"), outcome: "resolved" };
    expect(await admitModelSelection(selection, registry, events)).toBeUndefined();
    expect(selection.tierAdmitted).toBeUndefined();
  });

  it("returns the recorded block when an already-admitted selection was exhausted", async () => {
    const block = { model: "@cheap", wait: false };
    const selection: ModelSelection = { ...bound([ref("explicit")]), tierAdmitted: true, tier: { kind: "exhausted", tier: "cheap", block, skipped: [] } };
    expect(await admitModelSelection(selection, registry, events)).toBe(block);
  });

  it("names the tier in the fallback when the selection carries no requested text", async () => {
    const parent = registry.find("selection-test", "parent");
    const selection = { ...bound(["ghost/absent"]), tierParent: parent };
    expect(await admitModelSelection(selection, registry, events)).toBeUndefined();
    expect(selection).toMatchObject({ outcome: "fallback", model: parent, fallback: { input: "@cheap", used: ref("parent") } });
    expect(selection.tierBinding).toBeUndefined();
  });

  it("refuses to inherit when the policy says an unavailable tier is an error", async () => {
    setModelTiers({}, { onUnavailable: "error" });
    await expect(admitModelSelection(bound(["ghost/absent"]), registry, events)).rejects.toThrow("Model tier @cheap is unavailable.");
  });
});

describe("describeSelection", () => {
  it("labels an admitted model the registry does not know from its provider and id alone", () => {
    const selection: ModelSelection = {
      source: "param", model: registry.find("router", "default"), outcome: "resolved",
      tier: { kind: "routed", tier: "cheap", model: registry.find("router", "default")!, profile: "router/default", admitted: "ghost/absent" },
    };
    expect(describeSelection(selection, registry)).toMatchObject({ modelId: "ghost/absent" });
  });
});
