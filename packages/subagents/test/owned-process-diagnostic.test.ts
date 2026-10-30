import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureOwnedProcess, createOwnedProcessProbe, diagnoseOwnedProcess, type OwnedProcessCapture, type OwnedProcessIdentity } from "./helpers/owned-process-diagnostic.ts";

const children: ReturnType<typeof spawn>[] = [];
const unavailableReasons = ["timeout", "spawn_error", "unparseable", "start_identity_unavailable"] as const;

const captured = (identity: OwnedProcessIdentity): OwnedProcessCapture => ({ status: "captured", identity });

const identityFor = (pid: number): OwnedProcessIdentity => ({
  pid,
  parentPid: process.ppid,
  groupId: pid,
  startedAt: "not this process",
  initialState: "R",
  initialElapsed: "00:00",
  initialCpuTime: "00:00:00",
});

afterEach(async () => {
  for (const child of children.splice(0)) {
    const capture = await captureOwnedProcess(child.pid ?? -1);
    const diagnostic = await diagnoseOwnedProcess(capture);
    if (diagnostic.state === "present") child.kill("SIGKILL");
  }
});

describe("owned process diagnostics", () => {
  it("captures and reports a controlled live fixture without reading its arguments", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 1_000)"], { stdio: "ignore" });
    children.push(child);
    expect(child.pid).toBeTypeOf("number");

    const capture = await captureOwnedProcess(child.pid ?? -1);
    const diagnostic = await diagnoseOwnedProcess(capture);

    expect(capture).toMatchObject({ status: "captured", identity: { pid: child.pid, initialState: expect.any(String), startedAt: expect.any(String) } });
    expect(diagnostic).toMatchObject({
      identity: capture.status === "captured" ? capture.identity : undefined,
      state: "present",
      observed: {
        parentPid: expect.any(Number),
        groupId: expect.any(Number),
        kernelState: expect.any(String),
        elapsed: expect.any(String),
        cpuTime: expect.any(String),
      },
    });
  });

  it("reports a real empty process selection as missing", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 1_000)"], { stdio: "ignore" });
    const closed = once(child, "close");
    const capture = await captureOwnedProcess(child.pid ?? -1);
    await closed;

    expect(capture.status).toBe("captured");
    await expect(diagnoseOwnedProcess(capture)).resolves.toMatchObject({ state: "missing" });
  });

  it("reports an uncaptured fixture as unavailable", async () => {
    await expect(diagnoseOwnedProcess(undefined)).resolves.toEqual({ identity: undefined, state: "unknown", reason: "capture_not_recorded" });
  });

  it("reports a captured start mismatch as PID reuse", async () => {
    const identity = identityFor(process.pid);
    await expect(diagnoseOwnedProcess(captured(identity))).resolves.toMatchObject({ identity, state: "reused" });
  });

  it("reports only an explicit absent probe as missing", async () => {
    const identity = identityFor(process.pid);
    await expect(diagnoseOwnedProcess(captured(identity), async () => ({ status: "absent" }))).resolves.toEqual({ identity, state: "missing" });
  });

  it("reports an exit-one stderr failure as unavailable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "owned-process-probe-"));
    const probePath = join(dir, "ps");
    writeFileSync(probePath, "#!/bin/sh\nprintf '%s\\n' 'probe failed' >&2\nexit 1\n", { mode: 0o755 });
    try {
      const capture = await captureOwnedProcess(process.pid);
      const probe = createOwnedProcessProbe(probePath);
      await expect(captureOwnedProcess(process.pid, probe)).resolves.toEqual({ status: "unavailable", reason: "probe_error" });
      await expect(diagnoseOwnedProcess(capture, probe)).resolves.toMatchObject({ state: "unknown", reason: "probe_probe_error" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(unavailableReasons)("preserves an unavailable %s initial capture", async (reason) => {
    const capture = await captureOwnedProcess(process.pid, async () => ({ status: "unavailable", reason }));
    await expect(diagnoseOwnedProcess(capture)).resolves.toEqual({ identity: undefined, state: "unknown", reason: `capture_${reason}` });
  });

  it.each(unavailableReasons)("preserves an unavailable %s follow-up probe", async (reason) => {
    const identity = identityFor(process.pid);
    await expect(diagnoseOwnedProcess(captured(identity), async () => ({ status: "unavailable", reason }))).resolves.toEqual({ identity, state: "unknown", reason: `probe_${reason}` });
  });
});
