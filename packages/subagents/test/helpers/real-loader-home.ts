/**
 * Network-free real-loader probe, launched with a disposable ambient HOME at process start.
 * Best-effort JavaScript detector: native syscalls, child processes, and `process.binding("fs")` bypass it.
 */
import fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runAgent } from "../../src/agent-runner.js";
import { registerAgents } from "../../src/agent-types.js";
import { runMentionClone } from "../../src/mention-clone.js";
import type { AgentConfig } from "../../src/types.js";
import { type AmbientAccessBypass, exerciseAmbientAccessBypass } from "./ambient-access-bypass.js";

type TracedFunction = (...args: never[]) => unknown;

async function main(): Promise<void> {
  const root = process.env.PI_HOME_FIXTURE_ROOT;
  const mode = process.env.PI_HOME_FIXTURE_MODE;
  const scope = process.env.PI_HOME_FIXTURE_SCOPE;
  const bypass = process.env.PI_HOME_FIXTURE_BYPASS as AmbientAccessBypass | undefined;
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
  write(join(ambient, ".agents", "native-realpath-sync"), "native");
  write(join(ambient, ".agents", "native-realpath-callback"), "native");
  write(join(ambient, ".agents", "read-stream"), "read");
  fs.mkdirSync(join(ambient, ".agents", "glob-cwd"), { recursive: true });
  fs.mkdirSync(join(ambient, ".agents", "glob-pattern"), { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  const settingsPath = scope === "global" ? join(agentDir, "settings.json") : join(cwd, ".pi", "settings.json");
  write(settingsPath, JSON.stringify({ packages: [scope === "global" ? { source: "~/package" } : "~/package"], extensions: ["~/extension.ts"] }));

  const nativeRealpath = fs.realpathSync.native ?? fs.realpathSync;
  const ambientRoots = [resolve(ambient), nativeRealpath(ambient)];
  const probes: string[] = [];
  /** Record a path-like argument, pattern array, or `cwd` option without I/O. */
  function recordPath(value: unknown): void {
    if (Array.isArray(value)) {
      for (const entry of value) recordPath(entry);
      return;
    }
    if (value !== null && typeof value === "object" && "cwd" in value) recordPath(value.cwd);
    const path = value instanceof URL ? fileURLToPath(value) : Buffer.isBuffer(value) ? value.toString() : typeof value === "string" ? value : undefined;
    if (path !== undefined) probes.push(resolve(path));
  }
  /** Return the decoy-home-relative form of a lexical or canonical observed path. */
  function ambientRelative(path: string): string | undefined {
    const candidates = [path];
    try { candidates.push(nativeRealpath(path)); } catch { /* Missing paths are still observed by their lexical form. */ }
    for (const candidate of candidates) {
      for (const root of ambientRoots) {
        if (candidate === root || candidate.startsWith(root + sep)) return relative(root, candidate) || ".";
      }
    }
    return undefined;
  }
  /** Trace calls and constructors, including `realpath*.native`, on a filesystem API surface. */
  function traceFilesystemApi(api: object): void {
    function traceFunction(original: TracedFunction): TracedFunction {
      const traced = new Proxy(original, {
        apply(target, receiver, args) { for (const arg of args) recordPath(arg); return Reflect.apply(target, receiver, args); },
        construct(target, args, newTarget) { for (const arg of args) recordPath(arg); return Reflect.construct(target, args, newTarget); },
      });
      const native = Reflect.get(original, "native");
      if (typeof native === "function") Object.defineProperty(traced, "native", { configurable: true, writable: true, value: traceFunction(native as TracedFunction) });
      return traced;
    }
    for (const [name, original] of Object.entries(api)) {
      if (typeof original === "function") Object.defineProperty(api, name, { configurable: true, writable: true, value: traceFunction(original as TracedFunction) });
    }
  }
  traceFilesystemApi(fs);
  traceFilesystemApi(fs.promises);
  const runtime = globalThis as typeof globalThis & { Bun?: { file(path: string): unknown } };
  if (runtime.Bun) {
    const file = runtime.Bun.file.bind(runtime.Bun);
    runtime.Bun.file = new Proxy(file, { apply(target, receiver, args) { for (const arg of args) recordPath(arg); return Reflect.apply(target, receiver, args); } });
  }
  if (process.versions.bun) {
    // Bun does not synchronize patched built-in named exports. Replace only
    // their export table; every filesystem call still delegates to real I/O.
    const { mock } = createRequire(import.meta.url)("bun:test");
    mock.module("node:fs", () => ({ ...fs }));
    mock.module("fs", () => ({ ...fs }));
    mock.module("node:fs/promises", () => ({ ...fs.promises }));
    mock.module("fs/promises", () => ({ ...fs.promises }));
  } else {
    syncBuiltinESMExports();
  }

  if (bypass) await exerciseAmbientAccessBypass(ambient, bypass);

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
  const ambientAccesses = [...new Set(probes.map(ambientRelative).filter((path): path is string => path !== undefined))].sort();
  const loaded = fs.existsSync(marker) ? fs.readFileSync(marker, "utf8").trim().split("\n") : [];
  fs.writeFileSync(join(root, "result.json"), JSON.stringify({ runtime: process.versions.bun ?? "node", mode, scope, forbiddenProbes, ambientAccesses, loaded, sawInjectedPackage: probes.includes(join(home, "package", "package.json")), sawInjectedExtension: probes.includes(join(home, "extension.ts")) }));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
