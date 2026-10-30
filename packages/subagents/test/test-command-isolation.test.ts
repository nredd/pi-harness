/** Exercise the public npm test entry point, not a hand-isolated Vitest invocation. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
// Test-only reuse: this does not add a runtime dependency between the packages.
import { run } from "../../dev-tools/src/core/process.ts";
import { captureOwnedProcess, diagnoseOwnedProcess } from "./helpers/owned-process-diagnostic.ts";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const CHILD_TIMEOUT_MS = 60_000;

it("the opt-in live smoke entry point retains its operator-backed Vitest command", () => {
  const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  expect(manifest.scripts["test:e2e"]).toBe("vitest run e2e --reporter=verbose");
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
    // Await the owned runner's tree termination/pipe closure before removing HOME.
    const result = await run({
      cmd: "npm",
      args: ["test", "--", "test/background-by-default.test.ts", "--coverage.enabled=false", "--maxWorkers=1"],
      cwd: packageDir,
      timeoutMs: CHILD_TIMEOUT_MS,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        PI_CODING_AGENT_DIR: agentDir,
        PI_SUBAGENTS_CONFIG_DIR: agentDir,
      },
    });
    expect(result.spawnError).toBeUndefined();
    expect(result.timedOut).toBe(false);
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("3 passed");
    // Isolation must not repair or erase the caller's config to get green.
    expect(readFileSync(join(agentDir, "subagents.json"), "utf8")).toBe(cfg);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, CHILD_TIMEOUT_MS + 10_000);

it("the test command runner kills TERM-resistant descendants holding inherited pipes before returning", async () => {
  let captured: ReturnType<typeof captureOwnedProcess> | undefined;
  const result = await run({
    cmd: "sh",
    // The descendant inherits both ignored TERM and stdout/stderr. A direct-child
    // timeout would leave it alive with the pipes open until the 30s sleep ends.
    args: ["-c", "trap '' TERM; sleep 30 & descendant=$!; echo $descendant; echo owned-descendant:$descendant >&2; echo ready >&2; wait"],
    timeoutMs: 500,
    onStderrLine: (line) => {
      const match = /^owned-descendant:(\d+)$/.exec(line);
      if (match) captured = captureOwnedProcess(Number(match[1]));
    },
  });
  expect(result.stderr).toContain("ready");
  expect(result.timedOut).toBe(true);
  expect(result.termSignal).toBe("SIGKILL");
  expect(result.durationMs).toBeLessThan(8_000);
  const descendant = Number(result.stdout.trim());
  expect(descendant).toBeGreaterThan(0);
  // Unlike checking only the leader's exit or closed pipes, this detects orphans.
  try {
    expect(() => process.kill(descendant, 0)).toThrow(/ESRCH/);
  } catch (error) {
    const diagnostic = await captured?.then(diagnoseOwnedProcess).catch(() => undefined);
    console.error("owned descendant cleanup diagnostic", JSON.stringify(diagnostic));
    throw error;
  }
}, 10_000);
