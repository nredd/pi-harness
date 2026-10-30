import { spawn } from "node:child_process";

const PROBE_TIMEOUT_MS = 250;

type ProcessState = "missing" | "reused" | "zombie" | "present" | "unknown";
type ProbeFailure = "timeout" | "spawn_error" | "unparseable" | "start_identity_unavailable" | "probe_error";

interface KernelProcessState {
  pid: number;
  parentPid: number;
  groupId: number;
  state: string;
  startedAt: string;
  elapsed: string;
  cpuTime: string;
}

export interface OwnedProcessIdentity {
  pid: number;
  parentPid: number;
  groupId: number;
  startedAt: string;
  initialState: string;
  initialElapsed: string;
  initialCpuTime: string;
}

export type OwnedProcessCapture =
  | { status: "captured"; identity: OwnedProcessIdentity }
  | { status: "unavailable"; reason: ProbeFailure };

type ProcessProbeResult =
  | { status: "present"; process: KernelProcessState }
  | { status: "absent" }
  | { status: "unavailable"; reason: ProbeFailure };

type ProcessProbe = (pid: number) => Promise<ProcessProbeResult>;

export interface OwnedProcessDiagnostic {
  identity: OwnedProcessIdentity | undefined;
  state: ProcessState;
  reason?: `capture_${ProbeFailure | "not_recorded"}` | `probe_${ProbeFailure}`;
  observed?: {
    parentPid: number;
    groupId: number;
    kernelState: string;
    elapsed: string;
    cpuTime: string;
  };
}

/** Read bounded identity and execution fields for a known fixture PID, never command arguments or environments. */
const readProcessState: ProcessProbe = async (pid) => {
  const result = await new Promise<{ status: "output"; stdout: string } | ProcessProbeResult>((resolve) => {
    const child = spawn("ps", ["-p", String(pid), "-o", "pid=", "-o", "ppid=", "-o", "pgid=", "-o", "stat=", "-o", "lstart=", "-o", "etime=", "-o", "time="], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, PROBE_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return resolve({ status: "unavailable", reason: "timeout" });
      if (code === 1 && !stdout.trim()) return resolve({ status: "absent" });
      if (code !== 0) return resolve({ status: "unavailable", reason: "probe_error" });
      resolve({ status: "output", stdout });
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ status: "unavailable", reason: "spawn_error" });
    });
  });
  if (result.status !== "output") return result;
  const fields = result.stdout.trim().split(/\s+/);
  if (fields.length !== 11) return { status: "unavailable", reason: "unparseable" };
  const [actualPid, parentPid, groupId, state, weekday, month, day, time, year, elapsed, cpuTime] = fields;
  const numeric = [Number(actualPid), Number(parentPid), Number(groupId)];
  if (numeric.some((value) => !Number.isInteger(value) || value < 0)) return { status: "unavailable", reason: "unparseable" };
  if ([weekday, month, day, time, year].some((value) => value === "?" || value === "-")) {
    return { status: "unavailable", reason: "start_identity_unavailable" };
  }
  return {
    status: "present",
    process: {
      pid: numeric[0],
      parentPid: numeric[1],
      groupId: numeric[2],
      state,
      startedAt: `${weekday} ${month} ${day} ${time} ${year}`,
      elapsed,
      cpuTime,
    },
  };
};

/** Capture a fixture identity while its readiness marker proves the process is owned by this test. */
export async function captureOwnedProcess(pid: number, probe: ProcessProbe = readProcessState): Promise<OwnedProcessCapture> {
  const result = await probe(pid);
  if (result.status === "unavailable") return { status: "unavailable", reason: result.reason };
  if (result.status !== "present" || result.process.pid !== pid) return { status: "unavailable", reason: "unparseable" };
  const { process } = result;
  return {
    status: "captured",
    identity: {
      pid: process.pid,
      parentPid: process.parentPid,
      groupId: process.groupId,
      startedAt: process.startedAt,
      initialState: process.state,
      initialElapsed: process.elapsed,
      initialCpuTime: process.cpuTime,
    },
  };
}

/** Classify only a previously captured fixture PID, preserving the original cleanup assertion. */
export async function diagnoseOwnedProcess(capture: OwnedProcessCapture | undefined, probe: ProcessProbe = readProcessState): Promise<OwnedProcessDiagnostic> {
  if (!capture) return { identity: undefined, state: "unknown", reason: "capture_not_recorded" };
  if (capture.status === "unavailable") return { identity: undefined, state: "unknown", reason: `capture_${capture.reason}` };
  const { identity } = capture;
  const result = await probe(identity.pid);
  if (result.status === "absent") return { identity, state: "missing" };
  if (result.status === "unavailable") return { identity, state: "unknown", reason: `probe_${result.reason}` };
  const { process } = result;
  if (process.startedAt !== identity.startedAt) return { identity, state: "reused" };
  return {
    identity,
    state: process.state.startsWith("Z") ? "zombie" : "present",
    observed: {
      parentPid: process.parentPid,
      groupId: process.groupId,
      kernelState: process.state,
      elapsed: process.elapsed,
      cpuTime: process.cpuTime,
    },
  };
}
