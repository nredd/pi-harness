import { spawn } from "node:child_process";

const PROBE_TIMEOUT_MS = 250;

type ProcessState = "missing" | "reused" | "zombie" | "present";

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

export interface OwnedProcessDiagnostic {
  identity: OwnedProcessIdentity | undefined;
  state: ProcessState;
  observed?: {
    parentPid: number;
    groupId: number;
    kernelState: string;
    elapsed: string;
    cpuTime: string;
  };
}

/** Read bounded identity and execution fields for a known fixture PID, never command arguments or environments. */
async function readProcessState(pid: number): Promise<KernelProcessState | undefined> {
  const output = await new Promise<string | undefined>((resolve) => {
    const child = spawn("ps", ["-p", String(pid), "-o", "pid=", "-o", "ppid=", "-o", "pgid=", "-o", "stat=", "-o", "lstart=", "-o", "etime=", "-o", "time="], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), PROBE_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? stdout : undefined);
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(undefined);
    });
  });
  if (!output) return undefined;
  const fields = output.trim().split(/\s+/);
  if (fields.length !== 11) return undefined;
  const [actualPid, parentPid, groupId, state, weekday, month, day, time, year, elapsed, cpuTime] = fields;
  const numeric = [Number(actualPid), Number(parentPid), Number(groupId)];
  if (numeric.some((value) => !Number.isInteger(value) || value < 0)) return undefined;
  return {
    pid: numeric[0],
    parentPid: numeric[1],
    groupId: numeric[2],
    state,
    startedAt: `${weekday} ${month} ${day} ${time} ${year}`,
    elapsed,
    cpuTime,
  };
}

/** Capture a fixture identity while its readiness marker proves the process is owned by this test. */
export async function captureOwnedProcess(pid: number): Promise<OwnedProcessIdentity | undefined> {
  const state = await readProcessState(pid);
  if (!state || state.pid !== pid) return undefined;
  return {
    pid: state.pid,
    parentPid: state.parentPid,
    groupId: state.groupId,
    startedAt: state.startedAt,
    initialState: state.state,
    initialElapsed: state.elapsed,
    initialCpuTime: state.cpuTime,
  };
}

/** Classify only a previously captured fixture PID, preserving the original cleanup assertion. */
export async function diagnoseOwnedProcess(identity: OwnedProcessIdentity | undefined): Promise<OwnedProcessDiagnostic> {
  if (!identity) return { identity, state: "missing" };
  const state = await readProcessState(identity.pid);
  if (!state) return { identity, state: "missing" };
  if (state.startedAt !== identity.startedAt) return { identity, state: "reused" };
  return {
    identity,
    state: state.state.startsWith("Z") ? "zombie" : "present",
    observed: {
      parentPid: state.parentPid,
      groupId: state.groupId,
      kernelState: state.state,
      elapsed: state.elapsed,
      cpuTime: state.cpuTime,
    },
  };
}
