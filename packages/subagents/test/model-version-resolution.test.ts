/** Real registry controls for versioned fuzzy inputs; no provider requests. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveModel, setModelAliases, setModelScopeProvider } from "../src/model-resolver.js";

let root: string;
let registry: ModelRegistry;
const ids = ["claude-4-5-sonnet", "claude-5-sonnet", "claude-5-5-sonnet", "claude-5-6-sonnet"];

async function makeRegistry(order: string[], providers = ["version-fixture", "second-fixture"]): Promise<ModelRegistry> {
  const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, refreshOnCreate: false });
  const result = new ModelRegistry(runtime);
  for (const provider of providers) result.registerProvider(provider, {
    api: "openai-completions", baseUrl: "http://localhost:1", apiKey: "fixture-not-a-secret",
    models: order.map(id => ({ id, name: id, reasoning: false, input: ["text"], contextWindow: 1000, maxTokens: 100,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
  });
  return result;
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "model-version-"));
  registry = await makeRegistry(ids);
});
afterEach(() => {
  setModelAliases(undefined);
  setModelScopeProvider(undefined);
  rmSync(root, { recursive: true, force: true });
});

describe("versioned fuzzy resolution", () => {
  it.each([ids, [...ids].reverse()])("preserves the requested repeated version regardless of registry order: %j", async (...order) => {
    const result = resolveModel("sonnet-5-5", await makeRegistry(order));
    expect(result).toMatchObject({ id: "claude-5-5-sonnet" });
  });

  it.each(["sonnet 5 5", "sonnet-5.5", "sonnet-5-5-20261105"])("preserves version separators and optional dates: %s", query => {
    expect(resolveModel(query, registry)).toMatchObject({ id: "claude-5-5-sonnet" });
  });

  it("does not let enabled older versions replace the requested version", () => {
    setModelScopeProvider(() => new Set(["version-fixture/claude-4-5-sonnet"]));
    expect(resolveModel("sonnet-5-5", registry)).toMatchObject({ id: "claude-5-5-sonnet" });
  });

  it.each(["sonnet-5-5-5", "sonnet-55-5", "sonnet-7-5", "sonnet-6-5", "unknown-5-5"])("rejects unknown query %s", query => {
    expect(resolveModel(query, registry)).toContain("Model not found:");
  });

  it("rejects a missing generation rather than reusing its minor token", async () => {
    expect(resolveModel("sonnet-5-5", await makeRegistry(ids.slice(0, 2)))).toContain("Model not found:");
  });

  it.each(["claude-5-5-sonnet", "sonnet-5-5"])("breaks provider ties independently of registry order: %s", async query => {
    for (const providers of [["version-fixture", "second-fixture"], ["second-fixture", "version-fixture"]]) {
      expect(resolveModel(query, await makeRegistry(ids, providers))).toMatchObject({ provider: "second-fixture", id: "claude-5-5-sonnet" });
    }
  });

  it("preserves provider qualification, exact older models, and aliases", () => {
    expect(resolveModel("second-fixture/sonnet-5.5", registry)).toMatchObject({ provider: "second-fixture", id: "claude-5-5-sonnet" });
    expect(resolveModel("version-fixture/claude-4-5-sonnet", registry)).toMatchObject({ provider: "version-fixture", id: "claude-4-5-sonnet" });
    setModelAliases({ portable: ["second-fixture/claude-4-5-sonnet"] });
    expect(resolveModel("portable", registry)).toMatchObject({ provider: "second-fixture", id: "claude-4-5-sonnet" });
  });
});
