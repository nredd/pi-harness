import { readFileSync } from "node:fs";

export interface LinuxProcessIdentity {
  pid: number;
  parentPid: number;
  groupId: number;
  startTicks: string;
}

export type LinuxProcessSnapshot =
  | { status: "present"; identity: LinuxProcessIdentity; kernelState: string; userTicks: string; systemTicks: string; exitCode: string | undefined }
  | { status: "missing" }
  | { status: "unavailable"; reason: "unsupported" | "invalid_pid" | "read_error" | "malformed" };

type StatReader = (path: string) => string;

/** Read only a fixture PID's kernel stat record, with no subprocess or asynchronous scheduling. */
export function captureLinuxProcess(pid: number, read: StatReader = (path) => readFileSync(path, "utf8"), platform = process.platform): LinuxProcessSnapshot {
  if (platform !== "linux") return { status: "unavailable", reason: "unsupported" };
  if (!Number.isSafeInteger(pid) || pid <= 1) return { status: "unavailable", reason: "invalid_pid" };
  let stat: string;
  try {
    stat = read(`/proc/${pid}/stat`);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { status: "missing" };
    return { status: "unavailable", reason: "read_error" };
  }
  // comm may contain spaces and parentheses. Do not return, log or interpret it.
  const end = stat.lastIndexOf(")");
  if (stat.length > 4096 || !stat.startsWith(`${pid} (`) || end < 0) return { status: "unavailable", reason: "malformed" };
  const fields = stat.slice(end + 1).trim().split(/\s+/);
  // Relative to field 3 (state): ppid=1, pgrp=2, utime=11, stime=12, starttime=19, exit_code=49.
  if (fields.length < 20 || !/^[RSDZTWtXxKWPIN]$/.test(fields[0]) || [1, 2, 11, 12, 19].some((index) => !/^\d+$/.test(fields[index]))) {
    return { status: "unavailable", reason: "malformed" };
  }
  const parentPid = Number(fields[1]);
  const groupId = Number(fields[2]);
  if (![parentPid, groupId].every(Number.isSafeInteger)) return { status: "unavailable", reason: "malformed" };
  return {
    status: "present",
    identity: { pid, parentPid, groupId, startTicks: fields[19] },
    kernelState: fields[0],
    userTicks: fields[11],
    systemTicks: fields[12],
    exitCode: fields[49] && /^\d+$/.test(fields[49]) ? fields[49] : undefined,
  };
}

/** Classify the synchronous sample against readiness identity, never interpreting mere existence as execution. */
export function classifyLinuxBoundary(initial: LinuxProcessSnapshot | undefined, observed: LinuxProcessSnapshot): string {
  if (initial?.status !== "present") return "identity_unavailable";
  if (observed.status !== "present") return observed.status;
  if (observed.identity.pid !== initial.identity.pid || observed.identity.startTicks !== initial.identity.startTicks) return "reused";
  return observed.kernelState === "Z" ? "zombie" : "present_not_execution_proof";
}
