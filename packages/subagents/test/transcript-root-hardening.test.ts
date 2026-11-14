// #900 follow-ups from the PR critic: an explicit override, ENOSPC/EROFS relocation, a deferred and
// cursor-bounded prune, a hardened temp fallback root and references that keep transcripts alive.
// Own file because it mocks `node:fs`/`node:os` the way output-file-path.test.ts does.

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir as realTmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakeTmp = vi.hoisted(() => ({ dir: "" }));
const writeFault = vi.hoisted(() => ({ code: undefined as string | undefined, match: "" }));
const chmodFault = vi.hoisted(() => ({ on: false }));
const lstatCalls = vi.hoisted(() => ({ count: 0, vanish: "" }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (writeFault.code && String(args[0]).includes(writeFault.match)) {
        throw Object.assign(new Error(`${writeFault.code}: write`), { code: writeFault.code });
      }
      return actual.writeFileSync(...args);
    },
    chmodSync: (...args: Parameters<typeof actual.chmodSync>) => {
      if (chmodFault.on) throw new Error("EPERM: chmod");
      return actual.chmodSync(...args);
    },
    lstatSync: (...args: Parameters<typeof actual.lstatSync>) => {
      lstatCalls.count++;
      if (lstatCalls.vanish && String(args[0]).endsWith(lstatCalls.vanish)) throw Object.assign(new Error("ENOENT: lstat"), { code: "ENOENT" });
      return (actual.lstatSync as (...a: unknown[]) => unknown)(...args);
    },
  };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, tmpdir: () => fakeTmp.dir || actual.tmpdir() };
});

import {
  pruneStaleTranscripts,
  retainReferencedTranscripts,
  schedulePrune,
  sessionIdFromSessionFile,
  TRANSCRIPT_RETENTION_MS,
  transcriptRoot,
  writeInitialEntry,
} from "../src/output-file.js";

const UID = process.getuid?.() ?? 0;
const DAY = 24 * 60 * 60 * 1000;
const STALE = TRANSCRIPT_RETENTION_MS + DAY;
const saved = { xdg: process.env.XDG_STATE_HOME, override: process.env.PI_SUBAGENTS_TRANSCRIPT_DIR };

function restoreEnv(key: "XDG_STATE_HOME" | "PI_SUBAGENTS_TRANSCRIPT_DIR", value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

/** A path under a regular file: cannot be created, even by root. */
function unwritable(dir: string): string {
  writeFileSync(join(dir, "blocker"), "");
  return join(dir, "blocker", "x");
}

beforeEach(() => {
  fakeTmp.dir = realpathSync(mkdtempSync(join(realTmpdir(), "pi-hardening-")));
  process.env.XDG_STATE_HOME = join(fakeTmp.dir, "state");
  delete process.env.PI_SUBAGENTS_TRANSCRIPT_DIR;
});

afterEach(() => {
  writeFault.code = undefined;
  chmodFault.on = false;
  lstatCalls.vanish = "";
  restoreEnv("XDG_STATE_HOME", saved.xdg);
  restoreEnv("PI_SUBAGENTS_TRANSCRIPT_DIR", saved.override);
  rmSync(fakeTmp.dir, { recursive: true, force: true });
  fakeTmp.dir = "";
});

describe("PI_SUBAGENTS_TRANSCRIPT_DIR", () => {
  it("wins over XDG_STATE_HOME and is the root itself, owner-only", () => {
    const dir = join(fakeTmp.dir, "elsewhere");
    process.env.PI_SUBAGENTS_TRANSCRIPT_DIR = dir;
    expect(transcriptRoot()).toBe(dir);
    if (process.platform !== "win32") expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(existsSync(join(fakeTmp.dir, "state"))).toBe(false);
  });

  it("is ignored when relative", () => {
    process.env.PI_SUBAGENTS_TRANSCRIPT_DIR = "relative/dir";
    expect(transcriptRoot()).toBe(join(fakeTmp.dir, "state", "pi-subagents"));
  });

  it("falls back to the temp root when unusable", () => {
    process.env.PI_SUBAGENTS_TRANSCRIPT_DIR = unwritable(fakeTmp.dir);
    expect(transcriptRoot()).toBe(join(fakeTmp.dir, `pi-subagents-${UID}`));
  });
});

describe("writeInitialEntry on a full or read-only disk", () => {
  const entry = (path: string) => writeInitialEntry(path, "a1", "do it", "/work");

  it.each(["ENOSPC", "EROFS"])("relocates under the temp root on %s", (code) => {
    const root = transcriptRoot();
    const path = join(root, "proj", "s1", "tasks", "a1.output");
    mkdirSync(join(root, "proj", "s1", "tasks"), { recursive: true });
    writeFault.code = code;
    writeFault.match = join(fakeTmp.dir, "state");
    const written = entry(path);
    expect(written).toBe(join(fakeTmp.dir, `pi-subagents-${UID}`, "proj", "s1", "tasks", "a1.output"));
    expect(readFileSync(written, "utf-8")).toContain('"agentId":"a1"');
  });

  it("returns the requested path when the write succeeds", () => {
    const root = transcriptRoot();
    mkdirSync(join(root, "p", "s", "tasks"), { recursive: true });
    const path = join(root, "p", "s", "tasks", "a1.output");
    expect(entry(path)).toBe(path);
  });

  it("rethrows other errors", () => {
    const root = transcriptRoot();
    mkdirSync(join(root, "p", "s", "tasks"), { recursive: true });
    writeFault.code = "EACCES";
    writeFault.match = join(fakeTmp.dir, "state");
    expect(() => entry(join(root, "p", "s", "tasks", "a1.output"))).toThrow("EACCES");
  });

  it("rethrows when the transcript is already under the temp root", () => {
    process.env.XDG_STATE_HOME = unwritable(fakeTmp.dir);
    const root = transcriptRoot();
    mkdirSync(join(root, "p", "s", "tasks"), { recursive: true });
    writeFault.code = "ENOSPC";
    writeFault.match = root;
    expect(() => entry(join(root, "p", "s", "tasks", "a1.output"))).toThrow("ENOSPC");
  });

  it.skipIf(process.platform === "win32")("rethrows when the temp root cannot be prepared either", () => {
    const root = transcriptRoot();
    mkdirSync(join(root, "p", "s", "tasks"), { recursive: true });
    writeFault.code = "ENOSPC";
    writeFault.match = join(fakeTmp.dir, "state");
    chmodFault.on = true;
    expect(() => entry(join(root, "p", "s", "tasks", "a1.output"))).toThrow("ENOSPC");
  });

  it("rethrows a path outside the transcript root", () => {
    writeFault.code = "ENOSPC";
    writeFault.match = "outside";
    expect(() => entry(join(fakeTmp.dir, "outside.output"))).toThrow("ENOSPC");
  });
});

describe("temp fallback root", () => {
  beforeEach(() => {
    process.env.XDG_STATE_HOME = unwritable(fakeTmp.dir);
  });

  it("is reused when it is a real directory we own", () => {
    const real = join(fakeTmp.dir, `pi-subagents-${UID}`);
    mkdirSync(real);
    expect(transcriptRoot()).toBe(real);
  });

  it.skipIf(process.platform === "win32")("is refused when it is a symlink, using a fresh private dir instead", () => {
    const victim = join(fakeTmp.dir, "victim");
    mkdirSync(join(victim, "proj", "old", "tasks"), { recursive: true });
    const when = new Date(Date.now() - STALE);
    utimesSync(join(victim, "proj", "old"), when, when);
    symlinkSync(victim, join(fakeTmp.dir, `pi-subagents-${UID}`));
    const root = transcriptRoot();
    expect(root).not.toBe(join(fakeTmp.dir, `pi-subagents-${UID}`));
    expect(root.startsWith(join(fakeTmp.dir, `pi-subagents-${UID}-`))).toBe(true);
    expect(lstatSync(root).isDirectory()).toBe(true);
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(transcriptRoot()).toBe(root);
    pruneStaleTranscripts({ now: Date.now() + 2 * STALE });
    expect(existsSync(join(victim, "proj", "old"))).toBe(true);
  });

  it.skipIf(process.platform === "win32")("is refused when another user owns it", () => {
    const foreign = join(fakeTmp.dir, `pi-subagents-${UID}`);
    mkdirSync(foreign);
    const original = Object.getOwnPropertyDescriptor(process, "getuid")!;
    Object.defineProperty(process, "getuid", { value: () => UID + 1, configurable: true });
    try {
      expect(transcriptRoot()).not.toBe(foreign);
    } finally {
      Object.defineProperty(process, "getuid", original);
    }
  });

  it("is refused when it is a regular file", () => {
    writeFileSync(join(fakeTmp.dir, `pi-subagents-${UID}`), "x");
    expect(lstatSync(transcriptRoot()).isDirectory()).toBe(true);
  });
});

describe("prune scheduling and cursor", () => {
  let root: string;
  function session(cwd: string, id: string, ageMs: number): string {
    const dir = join(root, cwd, id);
    mkdirSync(join(dir, "tasks"), { recursive: true });
    const when = new Date(Date.now() - ageMs);
    utimesSync(join(dir, "tasks"), when, when);
    utimesSync(dir, when, when);
    return dir;
  }
  beforeEach(() => {
    root = transcriptRoot();
  });

  it("schedulePrune returns before pruning and prunes on the next macrotask", async () => {
    const old = session("proj", "old", STALE);
    schedulePrune();
    expect(existsSync(old)).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(existsSync(old)).toBe(false);
  });

  it("schedulePrune swallows failures", async () => {
    writeFileSync(join(fakeTmp.dir, "x"), "");
    schedulePrune({ keepSessionIds: 5 as unknown as string[] });
    await new Promise((resolve) => setImmediate(resolve));
  });

  it("stops enumerating at the limit and resumes after the cursor on the next call", () => {
    for (let i = 0; i < 1000; i++) session("a", `fresh${String(i).padStart(4, "0")}`, DAY);
    const old = session("b", "old", STALE);
    lstatCalls.count = 0;
    expect(pruneStaleTranscripts()).toBe(0);
    // 1000 candidates plus at most a handful of per-session activity stats; never the 1001st dir.
    expect(lstatCalls.count).toBeLessThan(4100);
    expect(existsSync(old)).toBe(true);
    expect(pruneStaleTranscripts()).toBe(1);
    expect(existsSync(old)).toBe(false);
  });

  it("wraps to the start once the end of the root is reached", () => {
    const first = session("a", "s", STALE);
    session("b", "s", DAY);
    expect(pruneStaleTranscripts({ now: Date.now() })).toBe(1);
    expect(existsSync(first)).toBe(false);
    const again = session("a", "t", STALE);
    expect(pruneStaleTranscripts()).toBe(1);
    expect(existsSync(again)).toBe(false);
  });

  it("revisits sessions before the cursor in the cursor's own cwd dir", () => {
    for (let i = 0; i < 1000; i++) session("a", `s${String(i).padStart(4, "0")}`, DAY);
    pruneStaleTranscripts();
    const early = session("a", "s0000x", STALE);
    // Cursor sits after s0999; "s0000x" sorts before it and is only reached by wrapping.
    expect(pruneStaleTranscripts()).toBe(1);
    expect(existsSync(early)).toBe(false);
  });

  it("starts over when the cursor's cwd dir is gone", () => {
    for (let i = 0; i < 1000; i++) session("m", `s${i}`, DAY);
    pruneStaleTranscripts();
    rmSync(join(root, "m"), { recursive: true, force: true });
    const old = session("a", "old", STALE);
    expect(pruneStaleTranscripts()).toBe(1);
    expect(existsSync(old)).toBe(false);
  });

  it("skips a session dir that vanishes between listing and stat", () => {
    session("a", "ghost", STALE);
    const old = session("a", "old", STALE);
    lstatCalls.vanish = "ghost";
    expect(pruneStaleTranscripts()).toBe(1);
    expect(existsSync(old)).toBe(false);
  });

  it("tolerates a corrupt cursor file", () => {
    writeFileSync(join(root, ".prune-cursor"), "not json");
    const old = session("a", "old", STALE);
    expect(pruneStaleTranscripts()).toBe(1);
    expect(existsSync(old)).toBe(false);
    writeFileSync(join(root, ".prune-cursor"), JSON.stringify([1, 2]));
    const other = session("a", "old2", STALE);
    expect(pruneStaleTranscripts()).toBe(1);
    expect(existsSync(other)).toBe(false);
  });
});

describe("referenced transcripts", () => {
  let root: string;
  beforeEach(() => {
    root = transcriptRoot();
  });
  function session(cwd: string, id: string, ageMs: number): string {
    const dir = join(root, cwd, id);
    mkdirSync(join(dir, "tasks"), { recursive: true });
    writeFileSync(join(dir, "tasks", "a1.output"), "x");
    const when = new Date(Date.now() - ageMs);
    for (const p of [join(dir, "tasks", "a1.output"), join(dir, "tasks"), dir]) utimesSync(p, when, when);
    return dir;
  }

  it("keepSessionIds exempts sessions in any cwd", () => {
    const kept = session("p", "keep-me", STALE);
    const gone = session("p", "drop-me", STALE);
    expect(pruneStaleTranscripts({ keepSessionIds: ["keep-me"] })).toBe(1);
    expect(existsSync(kept)).toBe(true);
    expect(existsSync(gone)).toBe(false);
  });

  it("retainReferencedTranscripts touches referenced dirs and returns their session ids", () => {
    const dir = session("p", "fork-src", STALE);
    const path = join(dir, "tasks", "a1.output");
    expect(retainReferencedTranscripts([path])).toEqual(["fork-src"]);
    expect(Date.now() - statSync(dir).mtimeMs).toBeLessThan(DAY);
    expect(Date.now() - statSync(join(dir, "tasks")).mtimeMs).toBeLessThan(DAY);
    expect(pruneStaleTranscripts()).toBe(0);
    expect(existsSync(dir)).toBe(true);
  });

  it("ignores paths outside the root, malformed layouts and missing dirs", () => {
    expect(retainReferencedTranscripts(["/etc/passwd", join(fakeTmp.dir, "elsewhere", "a", "b", "c.output"), join(root, "only-cwd.output")])).toEqual([]);
    expect(retainReferencedTranscripts([join(root, "p", "missing", "tasks", "a1.output")])).toEqual(["missing"]);
  });

  it("also keeps the fork source session id taken from the parent session file name", () => {
    expect(retainReferencedTranscripts([], "/home/u/.pi/agent/sessions/--proj--/2026-11-14T00-00-00-000Z_abc-123.jsonl")).toEqual(["abc-123"]);
    expect(retainReferencedTranscripts([], undefined)).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("still returns the fork source id when no root can be created", () => {
    chmodFault.on = true;
    expect(retainReferencedTranscripts(["/x"], "/s/2026_src.jsonl")).toEqual(["src"]);
  });

  it("sessionIdFromSessionFile takes the part after the last underscore", () => {
    expect(sessionIdFromSessionFile("/x/2026_abc.jsonl")).toBe("abc");
    expect(sessionIdFromSessionFile("/x/plain.jsonl")).toBe("plain");
  });
});
