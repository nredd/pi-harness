import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultPackageManager, type ResolvedResource, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isAmbientUserAgentsSkill, preloadSkills } from "../src/skill-loader.js";

const presetRoot = join(import.meta.dirname, "../../preset");

interface Sandbox {
  root: string;
  cwd: string;
  agentDir: string;
  homeDir: string;
  settingsManager: SettingsManager;
}

function createSandbox(projectTrusted: boolean): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "pi-preloaded-skill-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  mkdirSync(cwd, { recursive: true });
  const homeDir = join(root, "home");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  return { root, cwd, agentDir, homeDir, settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted }) };
}

function writeSkill(root: string, name: string, content: string): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name}\n---\n${content}\n`);
}

describe("preloadSkills", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("does not let an untrusted project shadow a trusted global skill", async () => {
    const box = createSandbox(false);
    roots.push(box.root);
    writeSkill(join(box.agentDir, "skills"), "review", "GLOBAL");
    writeSkill(join(box.cwd, ".pi", "skills"), "review", "HOSTILE");

    const [skill] = await preloadSkills(["review"], box.cwd, box);

    expect(skill?.content).toContain("GLOBAL");
    expect(skill?.content).not.toContain("HOSTILE");
  });

  it("gives a trusted project skill precedence over a global skill", async () => {
    const box = createSandbox(true);
    roots.push(box.root);
    writeSkill(join(box.agentDir, "skills"), "review", "GLOBAL");
    writeSkill(join(box.cwd, ".pi", "skills"), "review", "PROJECT");

    const [skill] = await preloadSkills(["review"], box.cwd, box);

    expect(skill?.content).toContain("PROJECT");
  });

  it("does not let a project filter re-enable a globally disabled native resource", async () => {
    const box = createSandbox(true);
    roots.push(box.root);
    const review = join(box.agentDir, "skills", "review");
    writeSkill(join(box.agentDir, "skills"), "review", "DISABLED GLOBAL");
    box.settingsManager.setProjectSkillPaths([review, `-${review}`]);

    const [skill] = await preloadSkills(["review"], box.cwd, box);

    expect(skill?.content).toContain("not found");
    expect(skill?.content).not.toContain("DISABLED GLOBAL");
  });

  it("does not let a project exclusion resurrect through compatibility lookup", async () => {
    const box = createSandbox(true);
    roots.push(box.root);
    writeSkill(join(box.cwd, ".pi", "skills"), "review", "DISABLED PROJECT");
    box.settingsManager.setProjectSkillPaths(["-skills/review"]);

    const [skill] = await preloadSkills(["review"], box.cwd, box);

    expect(skill?.content).toContain("not found");
    expect(skill?.content).not.toContain("DISABLED PROJECT");
  });

  it("recovers a global skill hidden by a rejected project symlink alias", async () => {
    const box = createSandbox(true);
    roots.push(box.root);
    const global = join(box.agentDir, "skills", "review");
    writeSkill(join(box.agentDir, "skills"), "review", "GLOBAL");
    mkdirSync(join(box.cwd, ".pi", "skills"), { recursive: true });
    symlinkSync(global, join(box.cwd, ".pi", "skills", "review"));

    const [skill] = await preloadSkills(["review"], box.cwd, box);

    expect(skill?.content).toContain("GLOBAL");
  });

  it("refuses a project symlink without hiding a package skill alias", async () => {
    const box = createSandbox(true);
    roots.push(box.root);
    const packageRoot = join(box.root, "package");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "fixture", pi: { skills: ["./skills"] } }));
    writeSkill(join(packageRoot, "skills"), "review", "PACKAGED");
    box.settingsManager.setPackages([packageRoot]);
    mkdirSync(join(box.cwd, ".pi", "skills"), { recursive: true });
    symlinkSync(join(packageRoot, "skills", "review"), join(box.cwd, ".pi", "skills", "review"));

    const [skill] = await preloadSkills(["review"], box.cwd, box);

    expect(skill?.content).toContain("PACKAGED");
  });

  it.each([
    ["resolved-identity exclusion", "../../package", [], false],
    ["explicit allowlist", "absolute", ["skills/review"], true],
  ] as const)("honors a package %s behind a rejected project alias", async (_label, source, skills, allowed) => {
    const box = createSandbox(true);
    roots.push(box.root);
    const packageRoot = join(box.root, "package");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "fixture", pi: { skills: ["./skills"] } }));
    writeSkill(join(packageRoot, "skills"), "review", "FILTERED-PACKAGE-REVIEW");
    box.settingsManager.setPackages([packageRoot]);
    box.settingsManager.setProjectPackages([{ source: source === "absolute" ? packageRoot : source, skills: [...skills] }]);
    // Native package discovery has the right decision until the unsafe alias
    // wins canonical deduplication. Keep that control at the real SDK boundary.
    const native = await new DefaultPackageManager({ cwd: box.cwd, agentDir: box.agentDir, settingsManager: box.settingsManager }).resolve(async () => "skip");
    const candidate = native.skills.find(resource => resource.metadata.origin === "package" && resource.path === join(packageRoot, "skills", "review", "SKILL.md"));
    expect(candidate?.enabled).toBe(allowed);
    mkdirSync(join(box.cwd, ".pi", "skills"), { recursive: true });
    symlinkSync(join(packageRoot, "skills", "review"), join(box.cwd, ".pi", "skills", "review"));

    const [skill] = await preloadSkills(["review"], box.cwd, box);

    if (allowed) {
      expect(skill?.content).toContain("FILTERED-PACKAGE-REVIEW");
      expect(skill?.content).not.toContain("not found");
    } else {
      expect(skill?.content).toContain("not found");
      expect(skill?.content).not.toContain("FILTERED-PACKAGE-REVIEW");
    }
  });

  it("recovers a package behind a rejected project alias with string sources and install roots", async () => {
    const box = createSandbox(true);
    roots.push(box.root);
    const packageRoot = join(box.root, "package");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "fixture", pi: { skills: ["./skills"] } }));
    writeSkill(join(packageRoot, "skills"), "review", "STRING-SOURCE-REVIEW");
    box.settingsManager.setPackages([packageRoot]);
    box.settingsManager.setProjectPackages(["../../package"]);
    mkdirSync(join(box.cwd, ".pi", "npm"), { recursive: true });
    mkdirSync(join(box.cwd, ".pi", "git"), { recursive: true });
    mkdirSync(join(box.cwd, ".pi", "skills"), { recursive: true });
    symlinkSync(join(packageRoot, "skills", "review"), join(box.cwd, ".pi", "skills", "review"));

    const [skill] = await preloadSkills(["review"], box.cwd, box);

    expect(skill?.content).toContain("STRING-SOURCE-REVIEW");
  });

  it("keeps a project package exclusion over the global fallback", async () => {
    const box = createSandbox(true);
    roots.push(box.root);
    const packageRoot = join(box.root, "package");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "fixture", pi: { skills: ["./skills"] } }));
    writeSkill(join(packageRoot, "skills"), "review", "PACKAGED");
    box.settingsManager.setPackages([packageRoot]);
    box.settingsManager.setProjectPackages([{ source: packageRoot, skills: [] }]);

    const [skill] = await preloadSkills(["review"], box.cwd, box);

    expect(skill?.content).toContain("not found");
  });

  it("does not restore a package excluded by the project behind a rejected alias", async () => {
    const box = createSandbox(true);
    roots.push(box.root);
    const packageRoot = join(box.root, "package");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "fixture", pi: { skills: ["./skills"] } }));
    writeSkill(join(packageRoot, "skills"), "review", "PACKAGED");
    box.settingsManager.setPackages([packageRoot]);
    box.settingsManager.setProjectPackages([{ source: packageRoot, skills: ["-skills/review"] }]);
    mkdirSync(join(box.cwd, ".pi", "skills"), { recursive: true });
    symlinkSync(join(packageRoot, "skills", "review"), join(box.cwd, ".pi", "skills", "review"));

    const [skill] = await preloadSkills(["review"], box.cwd, box);

    expect(skill?.content).toContain("not found");
    expect(skill?.content).not.toContain("PACKAGED");
  });

  it("refuses a symlinked project skill root before it can shadow a global skill", async () => {
    const box = createSandbox(true);
    roots.push(box.root);
    writeSkill(join(box.agentDir, "skills"), "review", "GLOBAL");
    const external = join(box.root, "external");
    writeSkill(external, "review", "SYMLINKED PROJECT");
    mkdirSync(join(box.cwd, ".pi"), { recursive: true });
    symlinkSync(external, join(box.cwd, ".pi", "skills"));

    const [skill] = await preloadSkills(["review"], box.cwd, box);

    expect(skill?.content).toContain("GLOBAL");
    expect(skill?.content).not.toContain("SYMLINKED PROJECT");
  });

  it("refuses a symlinked project skill file before it can shadow a global skill", async () => {
    const box = createSandbox(true);
    roots.push(box.root);
    writeSkill(join(box.agentDir, "skills"), "review", "GLOBAL");
    const external = join(box.root, "external.md");
    writeFileSync(external, "---\nname: review\ndescription: review\n---\nSYMLINKED PROJECT\n");
    mkdirSync(join(box.cwd, ".pi", "skills"), { recursive: true });
    symlinkSync(external, join(box.cwd, ".pi", "skills", "review.md"));

    const [skill] = await preloadSkills(["review"], box.cwd, box);

    expect(skill?.content).toContain("GLOBAL");
    expect(skill?.content).not.toContain("SYMLINKED PROJECT");
  });

  it("refuses a symlinked .pi parent before it can shadow a global skill", async () => {
    const box = createSandbox(true);
    roots.push(box.root);
    writeSkill(join(box.agentDir, "skills"), "review", "GLOBAL");
    const external = join(box.root, "external");
    writeSkill(join(external, "skills"), "review", "SYMLINKED PROJECT");
    symlinkSync(external, join(box.cwd, ".pi"));

    const [skill] = await preloadSkills(["review"], box.cwd, box);

    expect(skill?.content).toContain("GLOBAL");
    expect(skill?.content).not.toContain("SYMLINKED PROJECT");
  });

  it("refuses a symlinked ancestor .agents parent before it can shadow a global skill", async () => {
    const box = createSandbox(true);
    roots.push(box.root);
    const workspace = join(box.root, "workspace");
    const cwd = join(workspace, "nested");
    mkdirSync(join(workspace, ".git"), { recursive: true });
    mkdirSync(cwd, { recursive: true });
    writeSkill(join(box.agentDir, "skills"), "review", "GLOBAL");
    const external = join(box.root, "external");
    writeSkill(join(external, "skills"), "review", "SYMLINKED PROJECT");
    symlinkSync(external, join(workspace, ".agents"));
    const settingsManager = SettingsManager.create(cwd, box.agentDir, { projectTrusted: true });

    const [skill] = await preloadSkills(["review"], cwd, { ...box, settingsManager });

    expect(skill?.content).toContain("GLOBAL");
    expect(skill?.content).not.toContain("SYMLINKED PROJECT");
  });

  it("refuses a symlinked ancestor .agents skill root before it can shadow a global skill", async () => {
    const box = createSandbox(true);
    roots.push(box.root);
    const workspace = join(box.root, "workspace");
    const cwd = join(workspace, "nested");
    mkdirSync(join(workspace, ".git"), { recursive: true });
    mkdirSync(cwd, { recursive: true });
    writeSkill(join(box.agentDir, "skills"), "review", "GLOBAL");
    const external = join(box.root, "external");
    writeSkill(external, "review", "SYMLINKED PROJECT");
    mkdirSync(join(workspace, ".agents"), { recursive: true });
    symlinkSync(external, join(workspace, ".agents", "skills"));
    const settingsManager = SettingsManager.create(cwd, box.agentDir, { projectTrusted: true });

    const [skill] = await preloadSkills(["review"], cwd, { ...box, settingsManager });

    expect(skill?.content).toContain("GLOBAL");
    expect(skill?.content).not.toContain("SYMLINKED PROJECT");
  });

  it.each([
    ["SKILL.md file", "review/SKILL.md"],
    ["directory", "review"],
  ])("refuses a symlinked ancestor .agents skill %s before it can shadow a global skill", async (_kind, entry) => {
    const box = createSandbox(true);
    roots.push(box.root);
    const workspace = join(box.root, "workspace");
    const cwd = join(workspace, "nested");
    mkdirSync(join(workspace, ".git"), { recursive: true });
    mkdirSync(cwd, { recursive: true });
    writeSkill(join(box.agentDir, "skills"), "review", "GLOBAL");
    const external = join(box.root, "external");
    writeSkill(external, "review", "SYMLINKED PROJECT");
    mkdirSync(join(workspace, ".agents", "skills", "review"), { recursive: true });
    if (entry === "review") rmSync(join(workspace, ".agents", "skills", "review"), { recursive: true });
    symlinkSync(join(external, entry), join(workspace, ".agents", "skills", entry));
    const settingsManager = SettingsManager.create(cwd, box.agentDir, { projectTrusted: true });

    const [skill] = await preloadSkills(["review"], cwd, { ...box, settingsManager });

    expect(skill?.content).toContain("GLOBAL");
    expect(skill?.content).not.toContain("SYMLINKED PROJECT");
  });

  it("ignores an ancestor .agents that is a plain file", async () => {
    const box = createSandbox(true);
    roots.push(box.root);
    const workspace = join(box.root, "workspace");
    const cwd = join(workspace, "nested");
    mkdirSync(join(workspace, ".git"), { recursive: true });
    mkdirSync(cwd, { recursive: true });
    writeSkill(join(box.agentDir, "skills"), "review", "GLOBAL");
    writeFileSync(join(workspace, ".agents"), "not a directory");
    const settingsManager = SettingsManager.create(cwd, box.agentDir, { projectTrusted: true });

    const [skill] = await preloadSkills(["review"], cwd, { ...box, settingsManager });

    expect(skill?.content).toContain("GLOBAL");
  });

  it.each(["..", "../escape", "a/b", "a\\b", "has space", ".hidden", "", "x".repeat(129)])("never matches the traversal-shaped name %j", async (name) => {
    const box = createSandbox(true);
    roots.push(box.root);
    writeSkill(join(box.agentDir, "skills"), "review", "GLOBAL");
    writeFileSync(join(box.root, "escape.md"), "---\nname: escape\ndescription: escape\n---\nESCAPED\n");

    const [skill] = await preloadSkills([name], box.cwd, box);

    expect(skill?.content).toContain("not found");
    expect(skill?.content).not.toContain("ESCAPED");
  });

  it("follows a symlinked user skills root like Pi", async () => {
    const box = createSandbox(true);
    roots.push(box.root);
    const external = join(box.root, "external");
    writeSkill(external, "review", "LINKED ROOT");
    symlinkSync(external, join(box.agentDir, "skills"));

    const [skill] = await preloadSkills(["review"], box.cwd, box);

    expect(skill?.content).toContain("LINKED ROOT");
  });

  it("follows a symlinked user skill directory like Pi", async () => {
    const box = createSandbox(true);
    roots.push(box.root);
    const external = join(box.root, "external");
    writeSkill(external, "review", "LINKED USER");
    mkdirSync(join(box.agentDir, "skills"), { recursive: true });
    symlinkSync(join(external, "review"), join(box.agentDir, "skills", "review"));

    const [skill] = await preloadSkills(["review"], box.cwd, box);

    expect(skill?.content).toContain("LINKED USER");
  });

  it("follows a symlinked legacy user flat file", async () => {
    const box = createSandbox(true);
    roots.push(box.root);
    const external = join(box.root, "review.md");
    writeFileSync(external, "LINKED LEGACY FLAT");
    mkdirSync(join(box.homeDir, ".pi", "skills"), { recursive: true });
    symlinkSync(external, join(box.homeDir, ".pi", "skills", "review.md"));

    const [skill] = await preloadSkills(["review"], box.cwd, { ...box, homeDir: box.homeDir });

    expect(skill?.content).toBe("LINKED LEGACY FLAT");
  });

  it("preserves an injected home's .agents skill root", async () => {
    const box = createSandbox(false);
    roots.push(box.root);
    writeSkill(join(box.homeDir, ".agents", "skills"), "review", "INJECTED AGENTS");

    const [skill] = await preloadSkills(["review"], box.cwd, { ...box, homeDir: box.homeDir });

    expect(skill?.content).toContain("INJECTED AGENTS");
  });

  it("preserves legacy user roots and explicit flat-file lookup", async () => {
    const box = createSandbox(false);
    roots.push(box.root);
    mkdirSync(join(box.homeDir, ".pi", "skills"), { recursive: true });
    writeFileSync(join(box.homeDir, ".pi", "skills", "review.md"), "LEGACY FLAT");

    const [skill] = await preloadSkills(["review"], box.cwd, { ...box, homeDir: box.homeDir });

    expect(skill?.content).toBe("LEGACY FLAT");
  });

  it("finds a preset-packaged skill with an injected home", async () => {
    const box = createSandbox(false);
    roots.push(box.root);
    const home = box.homeDir;
    box.settingsManager.setPackages([presetRoot]);

    const [skill] = await preloadSkills(["coding-like-redd"], box.cwd, { ...box, homeDir: home });

    expect(skill?.content).toContain("## Python Development");
  });

  it("does not install a missing configured package while discovering skills", async () => {
    const box = createSandbox(false);
    roots.push(box.root);
    box.settingsManager.setPackages(["npm:preload-install-probe-missing"]);
    let installAttempted = false;
    const manager = DefaultPackageManager.prototype as unknown as {
      installParsedSource: () => Promise<void>;
    };
    const install = vi.spyOn(manager, "installParsedSource").mockImplementation(async () => {
      installAttempted = true;
      throw new Error("INSTALL ATTEMPT");
    });
    vi.stubEnv("PI_OFFLINE", "");
    delete process.env.PI_OFFLINE;

    try {
      const [skill] = await preloadSkills(["missing"], box.cwd, box);
      expect(skill).toEqual({ name: "missing", content: "(Skill \"missing\" not found in Pi's configured skill resources)" });
      expect(installAttempted).toBe(false);
    } finally {
      install.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("treats only the runtime home's auto-discovered user .agents skills as ambient", () => {
    const skill = (path: string, scope: "user" | "project", source: string): ResolvedResource => ({
      path,
      enabled: true,
      metadata: { source, scope, origin: "top-level" },
    });
    const ambientPath = "/runtime/.agents/skills/review/SKILL.md";
    expect(isAmbientUserAgentsSkill(skill(ambientPath, "user", "auto"), "/injected", "/runtime")).toBe(true);
    expect(isAmbientUserAgentsSkill(skill(ambientPath, "user", "auto"), undefined, "/runtime")).toBe(false);
    expect(isAmbientUserAgentsSkill(skill(ambientPath, "user", "auto"), "/runtime", "/runtime")).toBe(false);
    expect(isAmbientUserAgentsSkill(skill(ambientPath, "user", "npm:pkg"), "/injected", "/runtime")).toBe(false);
    expect(isAmbientUserAgentsSkill(skill(ambientPath, "project", "auto"), "/injected", "/runtime")).toBe(false);
    expect(isAmbientUserAgentsSkill(skill("/injected/.agents/skills/a/SKILL.md", "user", "auto"), "/injected", "/runtime")).toBe(false);
  });

  it("reports a missing named skill without reading a path", async () => {
    const box = createSandbox(false);
    roots.push(box.root);

    const [skill] = await preloadSkills(["missing"], box.cwd, box);

    expect(skill).toEqual({ name: "missing", content: "(Skill \"missing\" not found in Pi's configured skill resources)" });
  });
});
