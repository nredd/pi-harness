/** Filesystem TOCTOU and native permission failures at public resource boundaries. */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExtensionAPI, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionTaskDir } from "../src/output-file.js";
import { resolveDeclaredPaths } from "../src/package-resources.js";
import { preloadSkills } from "../src/skill-loader.js";
import { listSavedWorkflows } from "../src/workflow/saved.js";
import { createWorktree } from "../src/worktree.js";

const faults = vi.hoisted(() => ({ removeAfterExists: "", removeBeforeStat: "", unresolvable: "", chmod: false }));
vi.mock("node:fs", async original => {
  const actual = await original<typeof fs>();
  return { ...actual,
    existsSync: (path: fs.PathLike) => {
      const result = actual.existsSync(path);
      if (result && String(path) === faults.removeAfterExists) {
        faults.removeAfterExists = "";
        actual.rmSync(path, { recursive: true, force: true });
      }
      return result;
    },
    realpathSync: Object.assign((...args: Parameters<typeof fs.realpathSync>) => {
      if (String(args[0]) === faults.unresolvable) throw Object.assign(new Error(`EACCES: realpath ${String(args[0])}`), { code: "EACCES" });
      return actual.realpathSync(...args);
    }, { native: actual.realpathSync.native }),
    statSync: (...args: Parameters<typeof fs.statSync>) => {
      if (String(args[0]) === faults.removeBeforeStat) {
        faults.removeBeforeStat = "";
        actual.unlinkSync(args[0]);
      }
      return actual.statSync(...args);
    },
    chmodSync: (...args: Parameters<typeof fs.chmodSync>) => {
      if (faults.chmod) throw new Error("native chmod failed");
      return actual.chmodSync(...args);
    },
  };
});
let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), "lifecycle-filesystem-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
});
afterEach(() => { faults.removeAfterExists = ""; faults.removeBeforeStat = ""; faults.unresolvable = ""; faults.chmod = false; vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });

describe("resource filesystem races", () => {
  it("reports a git repository removed between validation and toplevel lookup", async () => {
    execFileSync("git", ["init", "-q", root]);
    const exec = vi.fn(async (_command: string, args: string[]) => {
      try {
        const stdout = execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        if (args.includes("--is-inside-work-tree")) fs.rmSync(join(root, ".git"), { recursive: true });
        return { code: 0, stdout, stderr: "" };
      } catch { return { code: 1, stdout: "", stderr: "repository disappeared" }; }
    });
    await expect(createWorktree({ exec } as unknown as ExtensionAPI, root, "race")).rejects.toThrow(`${root} has no git work tree toplevel (repository disappeared)`);
    expect(exec.mock.calls.map(([, args]) => args)).toEqual([["rev-parse", "--is-inside-work-tree"], ["rev-parse", "--show-toplevel"]]);
  });

  it("skips a declared package resource removed after its existence check", () => {
    const path = join(root, "removed.md");
    fs.writeFileSync(path, "agent");
    faults.removeAfterExists = path;
    expect(resolveDeclaredPaths(root, ["./removed.md"], "agents")).toMatchObject({ dirs: [], files: [] });
    expect(fs.existsSync(path)).toBe(false);
  });

  it("keeps preloading when an unrelated discovered skill cannot be canonicalized", async () => {
    const cwd = join(root, "project");
    const agentDir = join(root, "agent");
    for (const [name, content] of [["review", "GLOBAL"], ["other", "OTHER"]]) {
      fs.mkdirSync(join(agentDir, "skills", name), { recursive: true });
      fs.writeFileSync(join(agentDir, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name}\n---\n${content}\n`);
    }
    // The rejected project alias is what makes the loader canonicalize every candidate.
    fs.mkdirSync(join(cwd, ".pi", "skills"), { recursive: true });
    fs.symlinkSync(join(agentDir, "skills", "review"), join(cwd, ".pi", "skills", "review"));
    faults.unresolvable = join(agentDir, "skills", "other", "SKILL.md");

    const skills = await preloadSkills(["review", "other"], cwd, { agentDir, settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: true }) });

    expect(skills.map(skill => skill.content.split("\n").at(-1))).toEqual(["GLOBAL", "OTHER"]);
  });

  it("does not restore an uncanonicalizable package skill behind a rejected project alias", async () => {
    // Canonical root, so Pi's raw-path fallback for the faulted file still
    // collapses the package behind the project alias on every platform.
    const base = fs.realpathSync(root);
    const cwd = join(base, "project");
    const agentDir = join(base, "agent");
    const skillDir = join(base, "package", "skills", "review");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(join(base, "package", "package.json"), JSON.stringify({ name: "fixture", pi: { skills: ["./skills"] } }));
    fs.writeFileSync(join(skillDir, "SKILL.md"), "---\nname: review\ndescription: review\n---\nPACKAGED\n");
    const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
    settingsManager.setPackages([join(base, "package")]);
    fs.mkdirSync(join(cwd, ".pi", "skills"), { recursive: true });
    fs.symlinkSync(skillDir, join(cwd, ".pi", "skills", "review"));

    const [control] = await preloadSkills(["review"], cwd, { agentDir, settingsManager });
    faults.unresolvable = join(skillDir, "SKILL.md");
    const [skill] = await preloadSkills(["review"], cwd, { agentDir, settingsManager });

    expect(control?.content).toContain("PACKAGED");
    expect(skill?.content).toBe("(Skill \"review\" not found in Pi's configured skill resources)");
  });

  it("omits a saved script removed between directory listing and stat", () => {
    const dir = join(root, ".pi", "workflows");
    fs.mkdirSync(dir, { recursive: true });
    const path = join(dir, "removed.js");
    fs.writeFileSync(path, 'export const meta = {name:"removed", description:"d"};');
    faults.removeBeforeStat = path;
    expect(listSavedWorkflows(root, root)).toEqual([]);
    expect(fs.existsSync(path)).toBe(false);
  });

  it.skipIf(process.platform === "win32")("propagates native chmod failures rather than leaving a permissive transcript root", () => {
    faults.chmod = true;
    expect(() => sessionTaskDir(root, "lifecycle-session")).toThrow("native chmod failed");
    // The mock fails before any chmod, and never changes the shared temp root.
  });
});
