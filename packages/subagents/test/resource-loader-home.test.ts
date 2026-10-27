import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { normalizeResourceSettings } from "../src/resource-loader.js";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const helper = fileURLToPath(new URL("./helpers/real-loader-home.ts", import.meta.url));
const pinnedBunVersion = readFileSync(fileURLToPath(new URL("../../../.bun-version", import.meta.url)), "utf8").trim();
let bundleDir: string;

beforeAll(async () => {
  if (process.env.PI_EXPECT_BUN_RUNTIME === "1") expect(process.versions.bun).toBe(pinnedBunVersion);
  // Bundle only owned TypeScript, leaving the real Pi SDK/package manager
  // external. A colocated disposable module retains native npm resolution.
  bundleDir = mkdtempSync(join(packageRoot, ".real-loader-home-"));
  await build({
    configFile: false, root: packageRoot, logLevel: "silent",
    build: { ssr: helper, outDir: bundleDir, minify: false, rolldownOptions: { output: { entryFileNames: "probe.mjs" } } },
  });
});
afterAll(() => { if (bundleDir) rmSync(bundleDir, { recursive: true, force: true }); });

describe("real resource-loader settings home", () => {
  for (const mode of ["runner", "clone"]) {
    it.each(["global", "project"])(`${mode} isolates %s settings from a decoy ambient home`, scope => {
      const root = mkdtempSync(join(tmpdir(), "real-loader-home-"));
      const ambient = join(root, "ambient");
      mkdirSync(ambient);
      const env: NodeJS.ProcessEnv = { ...process.env, HOME: ambient, USERPROFILE: ambient, XDG_CONFIG_HOME: join(ambient, ".config"), PI_OFFLINE: "1", PI_HOME_FIXTURE_ROOT: root, PI_HOME_FIXTURE_MODE: mode, PI_HOME_FIXTURE_SCOPE: scope };
      delete env.PI_CODING_AGENT_DIR;
      delete env.PI_CODING_AGENT_SESSION_DIR;
      try {
        // HOME changes only at process creation, so Node and Bun both see the
        // same disposable ambient home. The production code never mutates it.
        const args = [join(bundleDir, "probe.mjs")];
        const child = spawnSync(process.execPath, args, { env, encoding: "utf8", timeout: 10000 });
        expect(child.status, child.stdout + child.stderr).toBe(0);
        const result = JSON.parse(readFileSync(join(root, "result.json"), "utf8"));
        expect(result.runtime).toBe(process.versions.bun ?? "node");
        expect(result.forbiddenProbes).toEqual([]);
        expect(result.sawInjectedPackage).toBe(true);
        expect(result.sawInjectedExtension).toBe(true);
        expect(result.loaded.sort()).toEqual(mode === "runner" ? ["INJECTED:extension", "INJECTED:package"] : []);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

it("#179 characterizes Pi's ambient .agents/skills scan before loader-level noSkills", () => {
  const root = mkdtempSync(join(tmpdir(), "real-loader-home-"));
  const ambient = join(root, "ambient");
  mkdirSync(ambient);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: ambient, USERPROFILE: ambient, XDG_CONFIG_HOME: join(ambient, ".config"), PI_OFFLINE: "1", PI_HOME_FIXTURE_ROOT: root, PI_HOME_FIXTURE_MODE: "runner", PI_HOME_FIXTURE_SCOPE: "global" };
  delete env.PI_CODING_AGENT_DIR;
  delete env.PI_CODING_AGENT_SESSION_DIR;
  try {
    const child = spawnSync(process.execPath, [join(bundleDir, "probe.mjs")], { env, encoding: "utf8", timeout: 10000 });
    expect(child.status, child.stdout + child.stderr).toBe(0);
    const result = JSON.parse(readFileSync(join(root, "result.json"), "utf8"));
    expect(result.runtime).toBe(process.versions.bun ?? "node");
    // Flip when #179 gives the host package manager an injected-home seam.
    expect(result.ambientSkillProbes).not.toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("normalizes copied settings and package filters without changing other source forms", () => {
  const settings = {
    extensions: ["~/ext.js", "!~/skip/**", "+~/include.js", "-~/exclude.js", "builtin:mcp", "relative.js", "file:///tmp/ext.js"],
    skills: ["~/skills"], prompts: ["~/prompts"], themes: ["~/themes"],
    packages: ["~/package", "npm:fixture", { source: "~/filtered", extensions: ["!~/skip/**", "./index.js"] }],
  };
  const snapshot = structuredClone(settings);
  const normalized = normalizeResourceSettings(settings, "/injected");
  expect(normalized.extensions).toEqual(["/injected/ext.js", "!/injected/skip/**", "+/injected/include.js", "-/injected/exclude.js", "builtin:mcp", "relative.js", "file:///tmp/ext.js"]);
  expect(normalized.packages).toEqual(["/injected/package", "npm:fixture", { source: "/injected/filtered", extensions: ["!/injected/skip/**", "./index.js"] }]);
  expect(normalized.skills).toEqual(["/injected/skills"]);
  expect(normalized.prompts).toEqual(["/injected/prompts"]);
  expect(normalized.themes).toEqual(["/injected/themes"]);
  expect(settings).toEqual(snapshot);
});
