/** Selection policy through Pi's real credential-aware registry, never a resolver mock. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setAgentModels, setModelAliases, setModelScopeProvider } from "../src/model-resolver.js";
import { selectModel } from "../src/model-selection.js";

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
  rmSync(dir, { recursive: true, force: true });
});

const ref = (id: string) => `selection-test/${id}`;
function select(definitionModel?: string, paramModel?: string) {
  return selectModel({ agentType: "Scout", definitionModel, paramModel, parentModel: registry.find("selection-test", "parent"), registry, cwd: dir });
}

describe("selectModel", () => {
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

  it("discloses an unresolved config without falling through to another config source", () => {
    setAgentModels({ scout: "does-not-exist", "*": ref("wildcard") });
    expect(select(ref("definition"))).toMatchObject({
      requested: "does-not-exist", source: "agentModels:type", outcome: "fallback", model: { id: "parent" },
      fallback: { input: "does-not-exist", used: "selection-test/parent" },
    });
    expect(select(undefined, "does-not-exist")).toContain('Model not found: "does-not-exist"');
  });
});
