import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";
import { captureLinuxProcess, classifyLinuxBoundary, type LinuxProcessSnapshot } from "./helpers/owned-linux-boundary.ts";

const pid = 42;

/** Build a kernel-format record with a deliberately awkward comm and exact field positions. */
function stat(state = "S", start = "12345678901234567890"): string {
  const fields = Array.from({ length: 50 }, () => "0");
  fields[0] = state;
  fields[1] = "10";
  fields[2] = "11";
  fields[11] = "12";
  fields[12] = "13";
  fields[19] = start;
  fields[49] = "9";
  return `${pid} (private ) fixture) ${fields.join(" ")}`;
}

const sample = (text = stat()): LinuxProcessSnapshot => captureLinuxProcess(pid, () => text, "linux");

describe("synchronous owned Linux boundary", () => {
  it("reads only the known PID stat path and omits comm", () => {
    const record = captureLinuxProcess(pid, (path) => {
      expect(path).toBe("/proc/42/stat");
      return stat();
    }, "linux");
    expect(record).toEqual({ status: "present", identity: { pid, parentPid: 10, groupId: 11, startTicks: "12345678901234567890" }, kernelState: "S", userTicks: "12", systemTicks: "13", exitCode: "9" });
    expect(JSON.stringify(record)).not.toContain("private");
  });

  it("separates zombies, identity changes and mere presence", () => {
    expect(classifyLinuxBoundary(sample(), sample(stat("Z")))).toBe("zombie");
    expect(classifyLinuxBoundary(sample(), sample(stat("R")))).toBe("present_not_execution_proof");
    expect(classifyLinuxBoundary(sample(), sample(stat("Z", "99")))).toBe("reused");
    expect(classifyLinuxBoundary(sample(), { status: "missing" })).toBe("missing");
    expect(classifyLinuxBoundary(undefined, sample())).toBe("identity_unavailable");
    expect(classifyLinuxBoundary(sample(), { status: "unavailable", reason: "read_error" })).toBe("unavailable");
  });

  it("preserves unsupported, malformed and inaccessible evidence", () => {
    expect(captureLinuxProcess(pid, () => stat(), "darwin")).toEqual({ status: "unavailable", reason: "unsupported" });
    for (const badPid of [0, 1, -1, 1.5, Number.NaN]) expect(captureLinuxProcess(badPid, () => stat(), "linux")).toEqual({ status: "unavailable", reason: "invalid_pid" });
    for (const text of ["", "42 (bad)", stat().replace("42 (", "43 ("), stat("?"), stat("S", "oops"), "x".repeat(4097)]) {
      expect(sample(text)).toEqual({ status: "unavailable", reason: "malformed" });
    }
    expect(captureLinuxProcess(pid, () => { throw Object.assign(new Error("not logged"), { code: "ENOENT" }); }, "linux")).toEqual({ status: "missing" });
    expect(captureLinuxProcess(pid, () => { throw new Error("not logged"); }, "linux")).toEqual({ status: "unavailable", reason: "read_error" });
  });

  it.skipIf(process.platform !== "linux")("classifies one owned fixture alive, unreaped and reaped without guessing from kill(0)", async () => {
    // The fixture's actual parent retains wait ownership throughout. WNOWAIT acknowledges
    // exit without reaping, providing a controlled zombie rather than a scheduling race.
    const script = `
import os
import signal
import sys
import time

pid = os.fork()
if pid == 0:
    time.sleep(5)
    os._exit(0)
try:
    print(pid, flush=True)
    sys.stdin.readline()
    os.kill(pid, signal.SIGKILL)
    os.waitid(os.P_PID, pid, os.WEXITED | os.WNOWAIT)
    print("unreaped", flush=True)
    sys.stdin.readline()
finally:
    os.waitpid(pid, 0)
`;
    const parent = spawn("python3", ["-c", script], { stdio: ["pipe", "pipe", "pipe"] });
    const closed = once(parent, "close");
    // EOF releases both parent protocol waits, including when a test assertion fails.
    const watchdog = setTimeout(() => parent.stdin.end(), 5_000);
    const lines = createInterface({ input: parent.stdout });
    const iterator = lines[Symbol.asyncIterator]();
    try {
      const first = await iterator.next();
      const descendant = Number(first.value);
      expect(descendant).toBeGreaterThan(1);
      const initial = captureLinuxProcess(descendant);
      expect(initial).toMatchObject({ status: "present", identity: { parentPid: parent.pid } });
      expect(classifyLinuxBoundary(initial, captureLinuxProcess(descendant))).toBe("present_not_execution_proof");
      parent.stdin.write("exit\n");
      expect((await iterator.next()).value).toBe("unreaped");
      const zombie = captureLinuxProcess(descendant);
      expect(classifyLinuxBoundary(initial, zombie)).toBe("zombie");
      expect(zombie).toMatchObject({ status: "present", kernelState: "Z", exitCode: "9" });
      // Same PID, no signal delivered. Existence alone cannot distinguish live from zombie.
      expect(() => process.kill(descendant, 0)).not.toThrow();
      parent.stdin.end("reap\n");
      expect((await closed)[0]).toBe(0);
      expect(classifyLinuxBoundary(initial, captureLinuxProcess(descendant))).toBe("missing");
    } finally {
      clearTimeout(watchdog);
      parent.stdin.end();
      await closed;
      lines.close();
    }
  }, 10_000);
});
