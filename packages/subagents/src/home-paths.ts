/** User-scoped paths. Omitted homes keep Pi's call-time runtime defaults. */
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Mirror Pi's agent-dir override semantics without changing the process environment. */
export function resolveAgentDir(homeDir?: string): string {
  if (homeDir === undefined) return getAgentDir();
  const configured = process.env.PI_CODING_AGENT_DIR;
  if (!configured) return join(homeDir, ".pi", "agent");
  return normalizeHomePath(configured, homeDir);
}

/** Pi's normalizePath is not exported by its public package entry point. */
export function normalizeHomePath(path: string, homeDir = homedir()): string {
  // Match Pi's native normalization of Git Bash, WSL and Cygwin drive paths.
  if (process.platform === "win32" && path.startsWith("/") && !path.startsWith("//") && !path.includes("\\")) {
    const [, letter, remainder] = path.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i) ?? [];
    if (letter) path = `${letter.toUpperCase()}:\\${remainder?.replaceAll("/", "\\") ?? ""}`;
  }
  if (path === "~") return homeDir;
  if (path.startsWith("~/") || (process.platform === "win32" && path.startsWith("~\\"))) {
    return join(homeDir, path.slice(2));
  }
  return path.startsWith("file://") ? fileURLToPath(path) : path;
}
