/** Exercise the public npm test entry point, not a hand-isolated Vitest invocation. */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const CHILD_TIMEOUT_MS = 60_000;

it("npm test cannot inherit operator model tiers through HOME or explicit config roots", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-subagents-hostile-home-"));
  const agentDir = join(home, ".pi", "agent");
  const cfg = JSON.stringify({
    agentModels: { "*": "@default" },
    modelTiers: { default: ["router/default"] },
    modelResolution: { onUnmapped: "error", onUnavailable: "error" },
  });
  try {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "subagents.json"), cfg);
    const result = spawnSync(
      "npm",
      ["test", "--", "test/background-by-default.test.ts", "--coverage.enabled=false", "--maxWorkers=1"],
      {
        cwd: packageDir,
        encoding: "utf8",
        timeout: CHILD_TIMEOUT_MS,
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          XDG_CONFIG_HOME: join(home, ".config"),
          PI_CODING_AGENT_DIR: agentDir,
          PI_SUBAGENTS_CONFIG_DIR: agentDir,
        },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("3 passed");
    // Isolation must not repair or erase the caller's config to get green.
    expect(readFileSync(join(agentDir, "subagents.json"), "utf8")).toBe(cfg);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, CHILD_TIMEOUT_MS + 5_000);
