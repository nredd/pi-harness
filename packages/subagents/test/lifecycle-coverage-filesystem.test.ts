/** Filesystem TOCTOU and native permission failures at public resource boundaries. */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionTaskDir } from "../src/output-file.js";
import { resolveDeclaredPaths } from "../src/package-resources.js";
import { listSavedWorkflows } from "../src/workflow/saved.js";
import { createWorktree } from "../src/worktree.js";

const faults = vi.hoisted(() => ({ removeAfterExists: "", removeBeforeStat: "", chmod: false }));
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
afterEach(() => { faults.removeAfterExists = ""; faults.removeBeforeStat = ""; faults.chmod = false; vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });

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
