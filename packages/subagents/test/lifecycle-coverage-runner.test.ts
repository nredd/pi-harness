/** Real child construction with a scripted faux provider and explicit private roots. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { type AgentSession, type ExtensionAPI, type ExtensionContext, ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setRememberAgents } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import type { AgentConfig } from "../src/types.js";
import { registerFauxProvider } from "./helpers/pi-ai.js";
import { runAgent } from "./helpers/run-selected-agent.js";

let root: string;
let faux: ReturnType<typeof registerFauxProvider>;
let session: AgentSession | undefined;
let registry: ModelRegistry;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "lifecycle-runner-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
  setRememberAgents(false);
  faux = registerFauxProvider({ provider: "lifecycle-faux", models: [{ id: "model", reasoning: true }], tokensPerSecond: 1000000 });
  registry = new ModelRegistry(await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, refreshOnCreate: false }));
  registry.registerProvider("lifecycle-faux", { api: faux.api, apiKey: "fixture-not-a-secret", baseUrl: "http://localhost:1", models: [{ id: "model", name: "Model", reasoning: true, input: ["text"], contextWindow: 10000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
});
afterEach(() => { session?.dispose(); session = undefined; faux.unregister(); registerAgents(new Map()); setRememberAgents(true); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

/** The real SDK consumes this same provider model; no ambient auth or settings. */
function context() {
  const model = faux.getModel();
  return { cwd: root, model, getSystemPrompt: () => "Parent system", isProjectTrusted: () => false,
    sessionManager: { getBranch: () => [{ type: "message", message: { role: "user", content: "remember parent context" } }], getSessionFile: () => undefined },
    modelRegistry: registry,
  } as unknown as ExtensionContext;
}
const pi = { exec: async () => ({ code: 1, stdout: "", stderr: "" }), events: { emit: () => {} } } as unknown as ExtensionAPI;

describe("real child lifecycle boundaries", () => {
  it("uses the canonical fallback prompt for a direct runner call with an unknown type", async () => {
    registerAgents(new Map());
    faux.setResponses([fauxAssistantMessage("fallback completed")]);
    const result = await runAgent(context(), "missing-direct-runner-type", "work", { pi, homeDir: root, onSessionCreated: child => { session = child; } });
    expect(result.responseText).toBe("fallback completed");
    expect(session?.systemPrompt).toContain("missing-direct-runner-type");
    expect(session?.getActiveToolNames()).toContain("read");
  });

  it("inherits the actual parent prompt, excludes a denied builtin, and reports child extension startup failure", async () => {
    const config: AgentConfig = { name: "lifecycle-child", description: "child", displayName: "Child", systemPrompt: "Child system", promptMode: "replace", inheritContext: false, runInBackground: false, isolated: false, skills: false, extensions: [fileURLToPath(new URL("./fixtures/lifecycle-session-error.mjs", import.meta.url))], disallowedTools: ["bash"] };
    registerAgents(new Map([[config.name, config]]));
    const prompts: string[] = [];
    faux.setResponses([(ctx) => { for (const message of ctx.messages) if (message.role === "user") prompts.push(typeof message.content === "string" ? message.content : message.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n")); return fauxAssistantMessage("child completed"); }]);
    const onToolActivity = vi.fn();
    const result = await runAgent(context(), config.name, "new task", { pi, homeDir: root, inheritContext: true, thinkingLevel: "low", onToolActivity, onSessionCreated: child => { session = child; } });
    expect(result.responseText).toBe("child completed");
    expect(session?.thinkingLevel).toBe("low");
    expect(session?.getAllTools().map(tool => tool.name)).not.toContain("bash");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("[User]: remember parent context");
    expect(prompts[0]).toContain("# Your Task (below)\nnew task");
    expect(onToolActivity).toHaveBeenCalledWith({ type: "end", toolName: expect.stringContaining("extension-error:") });
    session?.dispose();
    session = undefined;
    registerAgents(new Map([[config.name, { ...config, disallowedTools: undefined }]]));
    faux.setResponses([fauxAssistantMessage("control completed")]);
    const control = await runAgent(context(), config.name, "control task", { pi, homeDir: root, onSessionCreated: child => { session = child; } });
    expect(control.responseText).toBe("control completed");
    expect(control.session.getAllTools().map(tool => tool.name)).toContain("bash");
  });
});
