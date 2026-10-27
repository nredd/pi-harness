/** Network-free real-loader probe, launched with a disposable ambient HOME at process start. */
import fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { dirname, join, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runAgent } from "../../src/agent-runner.js";
import { registerAgents } from "../../src/agent-types.js";
import { runMentionClone } from "../../src/mention-clone.js";
import type { AgentConfig } from "../../src/types.js";

async function main(): Promise<void> {
  const root = process.env.PI_HOME_FIXTURE_ROOT;
  const mode = process.env.PI_HOME_FIXTURE_MODE;
  const scope = process.env.PI_HOME_FIXTURE_SCOPE;
  if (!root || !mode || !scope) throw new Error("Expected root, runner|clone and global|project");
  const ambient = join(root, "ambient");
  if (process.env.HOME !== ambient) throw new Error("Probe must start with disposable HOME");
  const home = join(root, "injected");
  const cwd = join(root, "project");
  const agentDir = join(home, ".pi", "agent");
  const marker = join(root, "loaded.jsonl");
  function write(path: string, content: string): void {
    fs.mkdirSync(dirname(path), { recursive: true });
    fs.writeFileSync(path, content);
  }
  for (const [base, label] of [[ambient, "DECOY"], [home, "INJECTED"]]) {
    const extension = (kind: string) => `import { appendFileSync } from 'node:fs'; export default function(pi) { appendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(label + ":" + kind + "\n")}); }`;
    write(join(base, "extension.ts"), extension("extension"));
    write(join(base, "package", "package.json"), JSON.stringify({ name: "home-fixture", pi: { extensions: ["./index.ts"] } }));
    write(join(base, "package", "index.ts"), extension("package"));
  }
  const ambientSkillsDir = join(ambient, ".agents", "skills");
  write(join(ambientSkillsDir, "ambient-skill", "SKILL.md"), "---\nname: ambient-skill\ndescription: #179 fixture\n---\nambient\n");
  fs.mkdirSync(cwd, { recursive: true });
  const settingsPath = scope === "global" ? join(agentDir, "settings.json") : join(cwd, ".pi", "settings.json");
  write(settingsPath, JSON.stringify({ packages: [scope === "global" ? { source: "~/package" } : "~/package"], extensions: ["~/extension.ts"] }));

  const probes: string[] = [];
  const exists = fs.existsSync;
  const read = fs.readFileSync;
  fs.existsSync = new Proxy(exists, { apply(target, receiver, args) { probes.push(resolve(String(args[0]))); return Reflect.apply(target, receiver, args); } });
  fs.readFileSync = new Proxy(read, { apply(target, receiver, args) { probes.push(resolve(String(args[0]))); return Reflect.apply(target, receiver, args); } });
  if (process.versions.bun) {
    // Bun does not synchronize patched built-in named exports. Replace only
    // their export table; every filesystem call still delegates to real I/O.
    const { mock } = createRequire(import.meta.url)("bun:test");
    mock.module("node:fs", () => ({ ...fs }));
    mock.module("fs", () => ({ ...fs }));
  } else {
    syncBuiltinESMExports();
  }

  const ctx = {
    cwd, model: undefined, modelRegistry: {},
    getSystemPrompt: () => "fixture", isProjectTrusted: () => true,
    sessionManager: { getBranch: () => [] },
  } as unknown as ExtensionContext;
  const stop = "STOP_AFTER_REAL_LOADER";
  if (mode === "runner") {
    registerAgents(new Map<string, AgentConfig>([["home-fixture", {
      name: "home-fixture", description: "fixture", builtinToolNames: [], extensions: true, skills: false,
      systemPrompt: "fixture", promptMode: "replace", persistSession: false,
    }]]));
    try {
      await runAgent(ctx, "home-fixture", "fixture", {
        pi: {} as ExtensionAPI, homeDir: home,
        modelSelection: { source: "parent", outcome: "inherited", get model(): undefined { throw new Error(stop); } },
      });
      throw new Error("Expected stop before any model session");
    } catch (error) {
      if (!(error instanceof Error) || error.message !== stop) throw error;
    }
  } else {
    Object.defineProperty(ctx, "model", { get() { throw new Error(stop); } });
    const result = await runMentionClone({
      ctx, homeDir: home, type: "home-fixture", message: "fixture",
      agentTool: { name: "Agent", label: "Agent", description: "fixture", parameters: Type.Object({}), async execute() { throw new Error("No model may run"); } },
    });
    if (result.error !== stop) throw new Error(`Unexpected clone result: ${JSON.stringify(result)}`);
  }
  const forbidden = [join(ambient, "package"), join(ambient, "extension.ts")];
  const forbiddenProbes = probes.filter(path => forbidden.some(root => path === root || path.startsWith(root + sep)));
  const ambientSkillProbes = probes.filter(path => path === ambientSkillsDir || path.startsWith(ambientSkillsDir + sep));
  const loaded = fs.existsSync(marker) ? fs.readFileSync(marker, "utf8").trim().split("\n") : [];
  fs.writeFileSync(join(root, "result.json"), JSON.stringify({ runtime: process.versions.bun ?? "node", mode, scope, forbiddenProbes, ambientSkillProbes, loaded, sawInjectedPackage: probes.includes(join(home, "package", "package.json")), sawInjectedExtension: probes.includes(join(home, "extension.ts")) }));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
