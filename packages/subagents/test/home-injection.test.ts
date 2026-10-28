import * as fs from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
    lstatSync: vi.fn(actual.lstatSync),
    statSync: vi.fn(actual.statSync),
    readdirSync: vi.fn(actual.readdirSync),
    readFileSync: vi.fn(actual.readFileSync),
    mkdirSync: vi.fn(actual.mkdirSync),
    realpathSync: vi.fn(actual.realpathSync),
  };
});

import { findAgentFile } from "../src/agent-file-toggle.js";
import { loadCustomAgents } from "../src/custom-agents.js";
import { readEnabledModels } from "../src/enabled-models.js";
import { readEnterpriseLocalManifest } from "../src/enterprise-local.js";
import { normalizeHomePath, resolveAgentDir } from "../src/home-paths.js";
import { resolveCwdParam } from "../src/invocation-config.js";
import { buildMemoryBlock, buildReadOnlyMemoryBlock, resolveMemoryDir } from "../src/memory.js";
import { invalidatePackageCache, packageAgentDirs } from "../src/package-resources.js";
import { loadBudgetPolicy, loadSettings } from "../src/settings.js";
import { preloadSkills } from "../src/skill-loader.js";
import { listSavedWorkflows, readSavedWorkflow, resolveWorkflowScript } from "../src/workflow/saved.js";

const probes = [fs.existsSync, fs.lstatSync, fs.statSync, fs.readdirSync, fs.readFileSync, fs.mkdirSync, fs.realpathSync];
let home: string;
let cwd: string;
let previousAgentDir: string | undefined;

function write(path: string, content: string) {
  fs.mkdirSync(dirname(path), { recursive: true });
  fs.writeFileSync(path, content);
}

beforeEach(() => {
  home = fs.mkdtempSync(join(tmpdir(), "subagents-home-injection-"));
  cwd = join(home, "project");
  fs.mkdirSync(cwd);
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  delete process.env.PI_CODING_AGENT_DIR;
  invalidatePackageCache();
  vi.clearAllMocks();
});

afterEach(() => {
  // Assert even when a production catch swallows a filesystem error. Do not
  // replace the real home or rely on HOME having been set before Bun launched.
  try {
    const realHome = resolve(homedir());
    const paths = probes.flatMap(probe => vi.mocked(probe).mock.calls.map(call => resolve(String(call[0]))));
    expect(paths.filter(path => path === realHome || path.startsWith(realHome + sep))).toEqual([]);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    invalidatePackageCache();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

describe("home injection without real-home filesystem access", () => {
  it("reads both memory APIs and the legacy fallback only under the injected home", () => {
    const legacy = join(home, ".pi", "agent-memory", "scout");
    write(join(legacy, "MEMORY.md"), "ISOLATED MEMORY");
    expect(resolveMemoryDir("scout", "user", cwd, home)).toBe(legacy);
    expect(buildMemoryBlock("scout", "user", cwd, home)).toContain("ISOLATED MEMORY");
    expect(buildReadOnlyMemoryBlock("scout", "user", cwd, home)).toContain("ISOLATED MEMORY");
  });

  it("searches every skill root under the injected home, including missing skills", () => {
    write(join(home, ".agents", "skills", "injected.md"), "ISOLATED SKILL");
    expect(preloadSkills(["injected", "missing"], cwd, home).map(skill => skill.content))
      .toEqual(["ISOLATED SKILL", expect.stringContaining("not found")]);
  });

  it("loads and locates custom agents from the injected home", () => {
    const file = join(home, ".pi", "agent", "agents", "injected.md");
    write(file, "---\ndescription: isolated\n---\nISOLATED AGENT");
    const agents = loadCustomAgents(cwd, false, { homeDir: home });
    expect([...agents.keys()]).toEqual(["injected"]);
    expect(findAgentFile("injected", cwd, home)?.path).toBe(file);
  });

  it("reads global settings, enterprise settings and enabled models from the same home", () => {
    const agent = join(home, ".pi", "agent");
    write(join(agent, "subagents.json"), JSON.stringify({ maxConcurrent: 3 }));
    write(join(agent, "settings.json"), JSON.stringify({ enabledModels: ["test/model"] }));
    write(join(agent, "enterprise.local.json"), JSON.stringify({ version: 1, subagents: { maxActiveSubagents: 9 } }));
    fs.chmodSync(join(agent, "enterprise.local.json"), 0o600);
    expect(readEnterpriseLocalManifest(home)?.version).toBe(1);
    expect(loadSettings(cwd, home)).toMatchObject({ maxConcurrent: 3, maxActiveSubagents: 9 });
    expect(loadBudgetPolicy(home).maxActive).toBe(9);
    expect(readEnabledModels(cwd, home)).toEqual(["test/model"]);
  });

  it("resolves saved workflow lookup and error listings using the injected home", () => {
    const file = join(home, ".pi", "agent", "workflows", "injected.js");
    write(file, 'export const meta = { name: "injected", description: "test" };');
    expect(readSavedWorkflow("injected", cwd, home)).toMatchObject({ ok: true, path: file });
    expect(resolveWorkflowScript({ name: "injected" }, cwd, home)).toMatchObject({ ok: true, scriptPath: file });
    expect(listSavedWorkflows(cwd, home)).toEqual(["injected"]);
    expect(readSavedWorkflow("missing", cwd, home)).toMatchObject({ ok: false, message: expect.stringContaining("injected") });
  });

  it("isolates package settings and includes the home in the discovery cache key", () => {
    const pkg = join(home, "package");
    write(join(pkg, "package.json"), JSON.stringify({ name: "fixture", pi: { subagents: ["./agents"] } }));
    write(join(pkg, "agents", "scout.md"), "---\ndescription: test\n---\nTest");
    write(join(home, ".pi", "agent", "settings.json"), JSON.stringify({ packages: ["~/package"] }));
    expect(packageAgentDirs(cwd, { homeDir: home })).toEqual([join(pkg, "agents")]);
    // Even with a shared agentDir, tilde package sources belong to each home.
    process.env.PI_CODING_AGENT_DIR = join(home, ".pi", "agent");
    expect(packageAgentDirs(cwd, { homeDir: join(home, "other") })).toEqual([]);
  });

  it("preserves file URLs, drive letters, and platform-specific backslash tilde semantics", () => {
    const file = join(home, "agent space");
    process.env.PI_CODING_AGENT_DIR = pathToFileURL(file).href;
    expect(resolveAgentDir(home)).toBe(file);
    process.env.PI_CODING_AGENT_DIR = "C:\\agents";
    expect(resolveAgentDir(home)).toBe("C:\\agents");
    process.env.PI_CODING_AGENT_DIR = "~\\agents";
    expect(resolveAgentDir(home)).toBe(process.platform === "win32" ? join(home, "agents") : "~\\agents");
    process.env.PI_CODING_AGENT_DIR = "~/agents";
    expect(resolveAgentDir(home)).toBe(join(home, "agents"));
    process.env.PI_CODING_AGENT_DIR = "";
    expect(resolveAgentDir(home)).toBe(join(home, ".pi", "agent"));
    expect(normalizeHomePath("~", home)).toBe(home);
    expect(resolveCwdParam("~/work", cwd, home)).toBe(join(home, "work"));
  });

  it("preserves Pi's Windows path forms without changing the actual home", () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    try {
      for (const path of ["/c/agents", "/mnt/c/agents", "/cygdrive/c/agents", "C:\\agents"]) {
        expect(normalizeHomePath(path, home)).toBe("C:\\agents");
      }
      expect(normalizeHomePath("~\\agents", home)).toBe(join(home, "agents"));
      expect(normalizeHomePath("//server/share", home)).toBe("//server/share");
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });
});
