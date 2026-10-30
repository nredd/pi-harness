import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { captureOwnedProcess, diagnoseOwnedProcess, type OwnedProcessIdentity } from "./helpers/owned-process-diagnostic.ts";

const children: ReturnType<typeof spawn>[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    const identity = await captureOwnedProcess(child.pid ?? -1);
    const diagnostic = await diagnoseOwnedProcess(identity);
    if (diagnostic.state === "present") child.kill("SIGKILL");
  }
});

describe("owned process diagnostics", () => {
  it("captures and reports a controlled live fixture without reading its arguments", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 1_000)"], { stdio: "ignore" });
    children.push(child);
    expect(child.pid).toBeTypeOf("number");

    const identity = await captureOwnedProcess(child.pid ?? -1);
    const diagnostic = await diagnoseOwnedProcess(identity);

    expect(identity).toMatchObject({ pid: child.pid, initialState: expect.any(String), startedAt: expect.any(String) });
    expect(diagnostic).toMatchObject({
      identity,
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

  it("reports a captured start mismatch as PID reuse", async () => {
    const identity: OwnedProcessIdentity = {
      pid: process.pid,
      parentPid: process.ppid,
      groupId: process.pid,
      startedAt: "not this process",
      initialState: "R",
      initialElapsed: "00:00",
      initialCpuTime: "00:00:00",
    };

    await expect(diagnoseOwnedProcess(identity)).resolves.toMatchObject({ identity, state: "reused" });
  });
});
