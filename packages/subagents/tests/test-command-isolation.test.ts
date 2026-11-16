/** Exercise the public npm test entry point, not a hand-isolated Vitest invocation. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isolatedHomeEnv } from "@nredd/pi-test-lib/isolated-home";
import { runTree } from "@nredd/pi-test-lib/run-tree";
import { expect, it } from "vitest";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const CHILD_TIMEOUT_MS = 60_000;

it("the opt-in live smoke entry point retains its operator-backed Vitest command", () => {
  const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  expect(manifest.scripts["test:e2e"]).toBe("JITI_FS_CACHE=false vitest run scenarios --reporter=verbose");
});

it("npm test cannot inherit operator model tiers through HOME or explicit config roots", async () => {
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
    const result = await runTree(
      "npm",
      ["test", "--", "tests/background-by-default.test.ts", "--coverage.enabled=false", "--maxWorkers=1"],
      { cwd: packageDir, timeoutMs: CHILD_TIMEOUT_MS, env: { ...process.env, ...isolatedHomeEnv(home) } },
    );
    expect(result.error).toBeUndefined();
    expect(result.timedOut).toBe(false);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("3 passed");
    // Isolation must not repair or erase the caller's config to get green.
    expect(readFileSync(join(agentDir, "subagents.json"), "utf8")).toBe(cfg);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, CHILD_TIMEOUT_MS + 10_000);
