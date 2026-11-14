/**
 * output-file.ts — Streaming JSONL output file for agent transcripts.
 *
 * Creates a per-agent output file that streams conversation turns as JSONL,
 * matching Claude Code's task output file format.
 */

import { accessSync, appendFileSync, chmodSync, constants, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { type ModelFallback, modelFallbackNote } from "./model-resolver.js";
import { type TierDisclosure, tierDisclosure, tierNote } from "./model-tiers.js";

/**
 * Project/global default for writing a subagent's `.output` transcript; a custom
 * agent's `output_transcript` overrides it per agent.
 *
 * State lives here rather than in an index.ts closure because both spawn paths
 * need it — the top-level Agent tool and the nested delegation tools. Same
 * reason `scopeModels` lives in model-scope.ts: a setting only one path can read
 * is a setting the other path silently ignores.
 */
let outputTranscriptDefault = true;

export function getOutputTranscriptDefault(): boolean { return outputTranscriptDefault; }
export function setOutputTranscriptDefault(b: boolean): void { outputTranscriptDefault = b; }

/**
 * Encode a cwd path as a filesystem-safe directory name. Handles:
 *   - POSIX:   "/home/user/project"        → "home-user-project"
 *   - Windows: "C:\Users\foo\project"      → "Users-foo-project"
 *   - UNC:     "\\\\server\\share\\project"  → "server-share-project"
 */
export function encodeCwd(cwd: string): string {
  return cwd
    .replace(/[/\\]/g, "-")        // both separators → dash
    .replace(/^[A-Za-z]:-/, "")    // strip Windows drive prefix ("C:-")
    .replace(/^-+/, "");           // strip leading dashes (POSIX root, UNC)
}

/** Session task dirs untouched for this long are pruned at session start (30 days). */
export const TRANSCRIPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** Upper bound on session dirs examined per prune, so a huge root never stalls startup. */
const PRUNE_SCAN_LIMIT = 1000;

/** Create `root` owner-only (0700) and prove it is usable; throws when it is not. */
function prepareRoot(root: string): void {
  // Parents keep the default mode: only the pi-subagents root itself is private.
  mkdirSync(dirname(root), { recursive: true });
  mkdirSync(root, { recursive: true, mode: 0o700 });
  // chmod is a no-op on Windows and throws on some Windows filesystems.
  // On Unix we still want to enforce 0o700 past umask, so only swallow on Windows.
  try {
    chmodSync(root, 0o700);
  } catch (err) {
    if (process.platform !== "win32") throw err;
  }
  accessSync(root, constants.R_OK | constants.W_OK | constants.X_OK);
}

/**
 * The transcript root, created owner-only. Prefers `$XDG_STATE_HOME/pi-subagents`
 * (default `~/.local/state/pi-subagents`) because `tmpdir()` is wiped by tmpfs
 * mounts and systemd-tmpfiles on Linux (#900); a relative `XDG_STATE_HOME` is
 * ignored per the XDG spec. Falls back to `<tmpdir>/pi-subagents-<uid>` when the
 * state root cannot be created or written, and that failure is the one thrown.
 */
export function transcriptRoot(): string {
  try {
    const xdg = process.env.XDG_STATE_HOME;
    const base = xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".local", "state");
    const root = join(base, "pi-subagents");
    prepareRoot(root);
    return root;
  } catch { /* fall through to the temp root */ }
  const root = join(tmpdir(), `pi-subagents-${process.getuid?.() ?? 0}`);
  prepareRoot(root);
  return root;
}

/**
 * The per-session scratch directory, created if missing.
 * Layout: {transcriptRoot}/{encoded-cwd}/{sessionId}/tasks
 *
 * Shared with the workflow tool, which persists each invocation's script here so
 * iterating on one is edit-file-then-rerun — the same convention, one directory.
 */
export function sessionTaskDir(cwd: string, sessionId: string): string {
  const dir = join(transcriptRoot(), encodeCwd(cwd), sessionId, "tasks");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Newest mtime of a session dir, its `tasks` dir and the files in it; stops at the first fresh one. */
function newestActivity(sessionDir: string, cutoff: number): number {
  let newest = lstatSync(sessionDir).mtimeMs;
  const tasks = join(sessionDir, "tasks");
  try {
    newest = Math.max(newest, lstatSync(tasks).mtimeMs);
    for (const name of readdirSync(tasks)) {
      if (newest > cutoff) break;
      newest = Math.max(newest, lstatSync(join(tasks, name)).mtimeMs);
    }
  } catch { /* no tasks dir or a file vanished: judge by what was read */ }
  return newest;
}

/**
 * Remove session task dirs (transcripts, workflow scripts and journals) with no
 * activity for `maxAgeMs`, so the state root does not grow forever. Never touches
 * `keepSessionId`, the `detached` spool, or anything through a symlink. Examines at
 * most {@link PRUNE_SCAN_LIMIT} session dirs per call (the rest wait for the next
 * start) and holds no directory handle open: `readdirSync` closes before recursing.
 * Best effort: any filesystem error skips that entry. Returns the dirs removed.
 */
export function pruneStaleTranscripts(keepSessionId?: string, now = Date.now(), maxAgeMs = TRANSCRIPT_RETENTION_MS): number {
  const cutoff = now - maxAgeMs;
  let scanned = 0;
  let removed = 0;
  let root: string;
  try {
    root = transcriptRoot();
  } catch {
    return 0;
  }
  const dirs = (parent: string) => {
    try {
      return readdirSync(parent, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
  };
  for (const cwdName of dirs(root)) {
    if (cwdName === "detached") continue;
    const cwdDir = join(root, cwdName);
    for (const sessionName of dirs(cwdDir)) {
      if (scanned++ >= PRUNE_SCAN_LIMIT) return removed;
      if (sessionName === keepSessionId) continue;
      const sessionDir = join(cwdDir, sessionName);
      try {
        if (newestActivity(sessionDir, cutoff) > cutoff) continue;
        rmSync(sessionDir, { recursive: true, force: true });
        removed++;
      } catch { /* skip: next start retries */ }
    }
    try { rmdirSync(cwdDir); } catch { /* not empty: keep */ }
  }
  return removed;
}

/** Create the output file path, ensuring the directory exists. */
export function createOutputFilePath(cwd: string, agentId: string, sessionId: string): string {
  return join(sessionTaskDir(cwd, sessionId), `${agentId}.output`);
}

/**
 * Ensure a transcript file exists without disturbing what is already in it.
 *
 * A resume reuses the agent's existing transcript (same deterministic path), so
 * it must never call `writeInitialEntry` — that truncates, discarding turns the
 * completion notification still points the user at, and any history the session
 * has since compacted away is gone for good. Appending nothing creates the file
 * when this is the agent's first transcript and is a no-op when it is not.
 */
export function ensureOutputFile(path: string): void {
  try {
    appendFileSync(path, "", "utf-8");
  } catch { /* ignore — streaming writes are best-effort too */ }
}

/** Append the model-fallback disclosure as a transcript line (best effort, like streaming writes). */
export function appendModelFallbackEntry(path: string, agentId: string, fallback: ModelFallback): void {
  try {
    // A resumed agent reuses its transcript, which may already say it.
    if (existsSync(path) && readFileSync(path, "utf-8").includes('"type":"model-fallback"')) return;
    appendFileSync(
      path,
      `${JSON.stringify({ isSidechain: true, agentId, type: "model-fallback", modelFallback: fallback, note: modelFallbackNote(fallback), timestamp: new Date().toISOString() })}\n`,
      "utf-8",
    );
  } catch { /* ignore */ }
}

/** Append tier provenance separately from assistant messages for durable replay. */
export function appendModelTierEntry(path: string, agentId: string, modelTier: TierDisclosure): void {
  try {
    appendFileSync(path, `${JSON.stringify({ isSidechain: true, agentId, type: "model-tier", modelTier: tierDisclosure(modelTier), note: tierNote(modelTier), timestamp: new Date().toISOString() })}\n`, "utf-8");
  } catch { /* transcript writes are best effort */ }
}

/** Write the initial user prompt entry. */
export function writeInitialEntry(path: string, agentId: string, prompt: string, cwd: string): void {
  const entry = {
    isSidechain: true,
    agentId,
    type: "user",
    message: { role: "user", content: prompt },
    timestamp: new Date().toISOString(),
    cwd,
  };
  writeFileSync(path, JSON.stringify(entry) + "\n", "utf-8");
}

/**
 * Subscribe to session events and flush new messages to the output file on each turn_end.
 * Returns a cleanup function that does a final flush and unsubscribes.
 */
export function streamToOutputFile(
  session: AgentSession,
  path: string,
  agentId: string,
  cwd: string,
  startIndex?: number,
): () => void {
  // Index of the first message this stream is responsible for. A resume hands
  // in the session's length as of just before the run: the session already
  // holds every prior turn, and re-emitting those would duplicate history that
  // is already in the file. A spawn has already written its prompt as the
  // initial entry, so it starts after the first user message — found on the
  // first flush, because pi puts a system message ahead of it and adds both
  // only once the prompt runs.
  let writtenCount = startIndex;

  const flush = () => {
    const messages = session.messages;
    if (writtenCount === undefined) {
      const prompt = messages.findIndex((m) => m.role === "user");
      if (prompt === -1) return;
      writtenCount = prompt + 1;
    }
    while (writtenCount < messages.length) {
      const msg = messages[writtenCount++];
      // Pi's prompt and tool-loadout records; a Claude Code transcript has no
      // such entry.
      if (msg.role === "system") continue;
      const entry = {
        isSidechain: true,
        agentId,
        type: msg.role === "assistant" ? "assistant" : msg.role === "user" ? "user" : "toolResult",
        message: msg,
        timestamp: new Date().toISOString(),
        cwd,
      };
      try {
        appendFileSync(path, JSON.stringify(entry) + "\n", "utf-8");
      } catch { /* ignore write errors */ }
    }
  };

  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "turn_end") flush();
    // Compaction replaces session.messages with a shorter, summarized array,
    // leaving writtenCount past the new end — without re-anchoring, the flush
    // loop would never match again and streaming would halt for good (#145).
    // Flush before it runs so any not-yet-flushed tail still reaches the file,
    // then re-anchor to the rebuilt array once it lands. The re-anchor is
    // deferred a microtask because on the overflow-retry path pi trims the
    // trailing error assistant message AFTER emitting compaction_end —
    // anchoring synchronously would sit one past the trimmed array and skip
    // the first post-compaction message. Aborted/failed compactions leave
    // session.messages untouched, so only successful ones re-anchor.
    if (event.type === "compaction_start") flush();
    if (event.type === "compaction_end" && !event.aborted && event.result) {
      queueMicrotask(() => { writtenCount = session.messages.length; });
    }
  });

  return () => {
    flush();
    unsubscribe();
  };
}
