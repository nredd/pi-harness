/**
 * output-file.ts — Streaming JSONL output file for agent transcripts.
 *
 * Creates a per-agent output file that streams conversation turns as JSONL,
 * matching Claude Code's task output file format.
 */

import { accessSync, appendFileSync, chmodSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
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

/** Session task dirs untouched for this long are pruned (30 days). */
export const TRANSCRIPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** Upper bound on session dirs enumerated and examined per prune, so a huge root never costs a whole walk. */
const PRUNE_SCAN_LIMIT = 1000;
/** Where the previous prune stopped, so successive starts sweep the whole root. */
const PRUNE_CURSOR_FILE = ".prune-cursor";

/** Create `root` owner-only (0700) and prove it is usable; throws when it is not. */
function prepareRoot(root: string): void {
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
 * The default transcript root: `$XDG_STATE_HOME/pi-subagents`, else
 * `~/.local/state/pi-subagents`. The one place that decides where transcripts live
 * absent an override, because `tmpdir()` is wiped by tmpfs mounts and
 * systemd-tmpfiles on Linux (#900). A relative `XDG_STATE_HOME` is ignored per the
 * XDG spec.
 */
function defaultTranscriptRoot(): string {
  const xdg = process.env.XDG_STATE_HOME;
  const base = xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".local", "state");
  return join(base, "pi-subagents");
}

/** `PI_SUBAGENTS_TRANSCRIPT_DIR` (absolute) is the root itself and wins over the default. */
function configuredTranscriptRoot(): string {
  const override = process.env.PI_SUBAGENTS_TRANSCRIPT_DIR;
  return override && isAbsolute(override) ? override : defaultTranscriptRoot();
}

/** A real directory we own is trusted; `"absent"` means nothing is there yet. */
function inspectRoot(path: string): boolean | "absent" {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(path);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : false;
  }
  const uid = process.getuid?.();
  return st.isDirectory() && (uid === undefined || st.uid === uid);
}

let freshTempRoot: { base: string; path: string } | undefined;

/**
 * The shared temp location is attacker-reachable (`/tmp` is world-writable), so the
 * predictable `<tmpdir>/pi-subagents-<uid>` is used only when it is a real directory
 * owned by this user. Otherwise (a symlink, a file, another user's dir) a fresh
 * `mkdtemp` directory, stable for the process, takes its place and the predictable
 * path is never walked, written or pruned.
 */
export function tempFallbackRoot(): string {
  const base = tmpdir();
  const root = join(base, `pi-subagents-${process.getuid?.() ?? 0}`);
  let state = inspectRoot(root);
  if (state === "absent") {
    prepareRoot(root);
    state = inspectRoot(root);
  }
  if (state === true) {
    prepareRoot(root);
    return root;
  }
  if (freshTempRoot?.base !== base || inspectRoot(freshTempRoot.path) !== true) {
    freshTempRoot = { base, path: mkdtempSync(`${root}-`) };
  }
  return freshTempRoot.path;
}

/**
 * The transcript root, created owner-only: `PI_SUBAGENTS_TRANSCRIPT_DIR` if set,
 * else the default state dir. Falls back to {@link tempFallbackRoot} when that
 * cannot be created or written; a failure there is the one thrown.
 */
export function transcriptRoot(): string {
  try {
    const root = configuredTranscriptRoot();
    // Parents keep the default mode: only the pi-subagents root itself is private.
    mkdirSync(dirname(root), { recursive: true });
    prepareRoot(root);
    return root;
  } catch { /* fall through to the temp root */ }
  return tempFallbackRoot();
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

/** Sub-directory names of `parent`, sorted; unreadable or symlinked entries are skipped. */
function subdirs(parent: string): string[] {
  try {
    return readdirSync(parent, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

/** mtime of `path` without following a symlink; undefined when it vanished. */
function mtimeOf(path: string): number | undefined {
  try {
    return lstatSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

function readCursor(root: string): [string, string] | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(join(root, PRUNE_CURSOR_FILE), "utf-8"));
    if (Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && typeof value[1] === "string") {
      return [value[0], value[1]];
    }
  } catch { /* missing or corrupt: sweep from the start */ }
  return undefined;
}

function writeCursor(root: string, cursor: [string, string] | undefined): void {
  try {
    if (cursor) writeFileSync(join(root, PRUNE_CURSOR_FILE), JSON.stringify(cursor), "utf-8");
    else rmSync(join(root, PRUNE_CURSOR_FILE), { force: true });
  } catch { /* the next start just sweeps from the same place */ }
}

export interface PruneOptions {
  /** Session ids never pruned, in any cwd dir (the live session and anything it references). */
  keepSessionIds?: readonly string[];
  now?: number;
  maxAgeMs?: number;
}

/**
 * Remove session task dirs (transcripts, workflow scripts and journals) with no
 * activity for `maxAgeMs`, so the state root does not grow forever. Never touches
 * `keepSessionIds`, the `detached` spool, or anything through a symlink.
 *
 * Bounded: enumeration itself stops after {@link PRUNE_SCAN_LIMIT} session dirs, in
 * sorted order from a cursor persisted in the root, so successive calls sweep the
 * whole root and one call never walks more than that. The collected dirs are
 * examined oldest first. Holds no directory handle open (`readdirSync` closes
 * before recursing). Best effort: any filesystem error skips that entry. Returns
 * the dirs removed.
 */
export function pruneStaleTranscripts(options: PruneOptions = {}): number {
  const { now = Date.now(), maxAgeMs = TRANSCRIPT_RETENTION_MS } = options;
  const keep = new Set(options.keepSessionIds);
  const cutoff = now - maxAgeMs;
  let root: string;
  try {
    root = transcriptRoot();
  } catch {
    return 0;
  }
  const cwdNames = subdirs(root).filter((name) => name !== "detached");
  const cursor = readCursor(root);
  const start = cursor ? Math.max(0, cwdNames.findIndex((name) => name >= cursor[0])) : 0;
  const order = [...cwdNames.slice(start), ...cwdNames.slice(0, start)];

  const candidates: { cwdName: string; sessionDir: string; mtime: number }[] = [];
  let last: [string, string] | undefined;
  let full = false;
  const collect = (cwdName: string, accept: (sessionName: string) => boolean): void => {
    for (const sessionName of subdirs(join(root, cwdName))) {
      if (full) return;
      if (!accept(sessionName) || keep.has(sessionName)) continue;
      const sessionDir = join(root, cwdName, sessionName);
      const mtime = mtimeOf(sessionDir);
      if (mtime === undefined) continue;
      candidates.push({ cwdName, sessionDir, mtime });
      last = [cwdName, sessionName];
      full = candidates.length >= PRUNE_SCAN_LIMIT;
    }
  };
  for (const [i, cwdName] of order.entries()) {
    if (full) break;
    collect(cwdName, cursor && i === 0 && cwdName === cursor[0] ? (name) => name > cursor[1] : () => true);
  }
  // Wrap: the head of the cursor's own cwd dir, skipped on the way in.
  if (!full && cursor && cwdNames.includes(cursor[0])) collect(cursor[0], (name) => name <= cursor[1]);
  writeCursor(root, full ? last : undefined);

  // Oldest first, so the likeliest-stale dirs are judged before the budget runs out.
  candidates.sort((x, y) => x.mtime - y.mtime);
  let removed = 0;
  const touched = new Set<string>();
  for (const { cwdName, sessionDir } of candidates) {
    try {
      if (newestActivity(sessionDir, cutoff) > cutoff) continue;
      rmSync(sessionDir, { recursive: true, force: true });
      removed++;
      touched.add(cwdName);
    } catch { /* skip: next start retries */ }
  }
  for (const cwdName of touched) {
    try { rmdirSync(join(root, cwdName)); } catch { /* not empty: keep */ }
  }
  return removed;
}

/**
 * Prune off the startup path: runs on the next macrotask, never throws, and never
 * keeps the process alive. The walk is synchronous but capped (see
 * {@link pruneStaleTranscripts}), so it cannot stall the event loop for long.
 */
export function schedulePrune(options?: PruneOptions): void {
  setImmediate(() => {
    try { pruneStaleTranscripts(options); } catch { /* best effort */ }
  }).unref();
}

/** The session id in a pi session file name (`<timestamp>_<id>.jsonl`). */
export function sessionIdFromSessionFile(file: string): string {
  const stem = basename(file).replace(/\.jsonl$/, "");
  return stem.slice(stem.lastIndexOf("_") + 1);
}

/**
 * Keep what the current session still points at alive: touch the session dirs of
 * referenced transcripts (a resumed or forked session's records and eviction notes
 * name them) so retention measures from now, and return every session id to exempt
 * from the next prune, including the fork source's.
 */
export function retainReferencedTranscripts(transcripts: Iterable<string>, parentSessionFile?: string): string[] {
  const ids = new Set<string>();
  if (parentSessionFile) ids.add(sessionIdFromSessionFile(parentSessionFile));
  let root: string;
  try {
    root = transcriptRoot();
  } catch {
    return [...ids];
  }
  const now = new Date();
  for (const transcript of transcripts) {
    const rel = relative(root, transcript);
    const parts = rel.split(sep);
    // <encoded-cwd>/<session>/tasks/<file>
    if (rel.startsWith("..") || isAbsolute(rel) || parts.length !== 4 || parts[2] !== "tasks") continue;
    ids.add(parts[1]);
    const sessionDir = join(root, parts[0], parts[1]);
    for (const dir of [join(sessionDir, "tasks"), sessionDir]) {
      try { utimesSync(dir, now, now); } catch { /* gone: nothing to keep */ }
    }
  }
  return [...ids];
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

/** Where `path` lands under the temp fallback root, when it sits under the transcript root and that differs. */
function relocatedToTemp(path: string): string | undefined {
  try {
    const rel = relative(transcriptRoot(), path);
    if (rel.startsWith("..") || isAbsolute(rel)) return undefined;
    const alt = join(tempFallbackRoot(), rel);
    return alt === path ? undefined : alt;
  } catch {
    return undefined;
  }
}

/**
 * Write the initial user prompt entry and return the path actually written. A full
 * or read-only state volume (ENOSPC/EROFS) retries once under the temp root, so the
 * Agent call is not failed over a transcript; callers must use the returned path.
 */
export function writeInitialEntry(path: string, agentId: string, prompt: string, cwd: string): string {
  const entry = {
    isSidechain: true,
    agentId,
    type: "user",
    message: { role: "user", content: prompt },
    timestamp: new Date().toISOString(),
    cwd,
  };
  const line = JSON.stringify(entry) + "\n";
  try {
    writeFileSync(path, line, "utf-8");
    return path;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const alt = code === "ENOSPC" || code === "EROFS" ? relocatedToTemp(path) : undefined;
    if (alt === undefined) throw err;
    mkdirSync(dirname(alt), { recursive: true });
    writeFileSync(alt, line, "utf-8");
    return alt;
  }
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
