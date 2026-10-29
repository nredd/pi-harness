/** Selection policy through Pi's real credential-aware registry, never a resolver mock. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAgentModels, setModelAliases, setModelScopeProvider } from "../src/model-resolver.js";
import { setScopeModelsEnabled } from "../src/model-scope.js";
import { selectModel } from "../src/model-selection.js";
import { setModelTiers } from "../src/model-tiers.js";

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

  it("advertises only models from the dispatch scope when an explicit model does not resolve", () => {
    let scopeContext: { cwd: string; homeDir?: string } | undefined;
    setModelScopeProvider((_registry, context) => {
      scopeContext = context;
      return new Set([ref("parent")]);
    });
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
