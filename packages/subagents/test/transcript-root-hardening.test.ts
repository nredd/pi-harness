// #900 follow-ups from the PR critic: an explicit override, ENOSPC/EROFS relocation, a deferred and
// cursor-bounded prune, a hardened temp fallback root and references that keep transcripts alive.
// Own file because it mocks `node:fs`/`node:os` the way output-file-path.test.ts does.

import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir as realTmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakeTmp = vi.hoisted(() => ({ dir: "" }));
const writeFault = vi.hoisted(() => ({ code: undefined as string | undefined, match: "" }));
const mkdirFault = vi.hoisted(() => ({ match: "" }));
const mkdirRace = vi.hoisted(() => ({ path: "", victim: "", symlink: undefined as undefined | ((target: string, path: string) => void) }));
const realpathFault = vi.hoisted(() => ({ on: false }));
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
    realpathSync: Object.assign((...args: Parameters<typeof actual.realpathSync>) => {
      if (realpathFault.on) throw new Error("EIO: realpath");
      return actual.realpathSync(...args);
    }, actual.realpathSync),
    mkdirSync: (...args: Parameters<typeof actual.mkdirSync>) => {
      if (mkdirRace.path && String(args[0]) === mkdirRace.path) {
        // The attacker wins the window between "absent" and mkdir.
        mkdirRace.symlink?.(mkdirRace.victim, mkdirRace.path);
        mkdirRace.path = "";
        throw Object.assign(new Error("EEXIST: mkdir"), { code: "EEXIST" });
      }
      if (mkdirFault.match && String(args[0]) === mkdirFault.match) throw Object.assign(new Error("EACCES: mkdir"), { code: "EACCES" });
      return actual.mkdirSync(...args);
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
  mkdirFault.match = "";
  mkdirRace.path = "";
  realpathFault.on = false;
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

  it.skipIf(process.platform === "win32")("never chmods, marks or prunes a pre-existing dir that lacks pi's marker", () => {
    const dir = join(fakeTmp.dir, "notes");
    mkdirSync(join(dir, "proj", "notes", "deep"), { recursive: true });
    writeFileSync(join(dir, "proj", "notes", "deep", "file.txt"), "mine");
    chmodSync(dir, 0o755);
    const when = new Date(Date.now() - STALE);
    utimesSync(join(dir, "proj", "notes"), when, when);
    process.env.PI_SUBAGENTS_TRANSCRIPT_DIR = dir;
    expect(transcriptRoot()).toBe(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o755);
    expect(existsSync(join(dir, ".pi-subagents-root"))).toBe(false);
    expect(pruneStaleTranscripts({ now: Date.now() + 2 * STALE })).toBe(0);
    expect(readFileSync(join(dir, "proj", "notes", "deep", "file.txt"), "utf-8")).toBe("mine");
  });

  it.skipIf(process.platform === "win32")("adopts a pre-existing dir once the owner drops the marker in it", () => {
    const dir = join(fakeTmp.dir, "owned");
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(dir, 0o755);
    writeFileSync(join(dir, ".pi-subagents-root"), "");
    process.env.PI_SUBAGENTS_TRANSCRIPT_DIR = dir;
    transcriptRoot();
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const old = join(dir, "proj", "old");
    mkdirSync(join(old, "tasks"), { recursive: true });
    const when = new Date(Date.now() - STALE);
    utimesSync(old, when, when);
    utimesSync(join(old, "tasks"), when, when);
    expect(pruneStaleTranscripts()).toBe(1);
  });

  it("writes the marker into a root pi creates", () => {
    expect(existsSync(join(transcriptRoot(), ".pi-subagents-root"))).toBe(true);
  });

  it("falls back to the temp root when creating the dir fails for a reason other than it existing", () => {
    const dir = join(fakeTmp.dir, "denied");
    process.env.PI_SUBAGENTS_TRANSCRIPT_DIR = dir;
    mkdirFault.match = dir;
    expect(transcriptRoot()).toBe(join(fakeTmp.dir, `pi-subagents-${UID}`));
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

  const hashed = () => join(fakeTmp.dir, `pi-subagents-${UID}-${createHash("sha256").update(`${UID}:${fakeTmp.dir}`).digest("hex").slice(0, 8)}`);

  it.skipIf(process.platform === "win32")("uses a deterministic per-uid dir when the plain name is refused, so processes share it", () => {
    symlinkSync(fakeTmp.dir, join(fakeTmp.dir, `pi-subagents-${UID}`));
    expect(transcriptRoot()).toBe(hashed());
    expect(statSync(hashed()).mode & 0o777).toBe(0o700);
  });

  it.skipIf(process.platform === "win32")("only then falls back to a fresh mkdtemp dir", () => {
    symlinkSync(fakeTmp.dir, join(fakeTmp.dir, `pi-subagents-${UID}`));
    symlinkSync(fakeTmp.dir, hashed());
    const root = transcriptRoot();
    expect(root).not.toBe(hashed());
    expect(root.startsWith(join(fakeTmp.dir, `pi-subagents-${UID}-`))).toBe(true);
    expect(lstatSync(root).isDirectory()).toBe(true);
    expect(transcriptRoot()).toBe(root);
  });

  it.skipIf(process.platform === "win32")("never chmods or marks a symlink target planted between the absent check and mkdir", () => {
    const victim = join(fakeTmp.dir, "victim-notes");
    mkdirSync(victim, { mode: 0o755 });
    chmodSync(victim, 0o755);
    mkdirRace.path = join(fakeTmp.dir, `pi-subagents-${UID}`);
    mkdirRace.victim = victim;
    mkdirRace.symlink = symlinkSync;
    const root = transcriptRoot();
    expect(root).toBe(hashed());
    expect(existsSync(join(victim, ".pi-subagents-root"))).toBe(false);
    expect(statSync(victim).mode & 0o777).toBe(0o755);
  });

  it("refuses a root that vanishes before it can be inspected", () => {
    mkdirSync(join(fakeTmp.dir, `pi-subagents-${UID}`));
    lstatCalls.vanish = `pi-subagents-${UID}`;
    expect(transcriptRoot()).toBe(hashed());
  });

  it("creates a missing tmpdir instead of throwing", () => {
    const real = fakeTmp.dir;
    fakeTmp.dir = join(real, "gone");
    process.env.XDG_STATE_HOME = unwritable(real);
    try {
      expect(transcriptRoot()).toBe(join(real, "gone", `pi-subagents-${UID}`));
    } finally {
      fakeTmp.dir = real;
    }
  });

  it("still uses the plain name when the real tmpdir cannot be resolved for the hash", () => {
    realpathFault.on = true;
    expect(transcriptRoot()).toBe(join(fakeTmp.dir, `pi-subagents-${UID}`));
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

describe("prune only deletes pi-shaped session dirs", () => {
  let root: string;
  beforeEach(() => {
    root = transcriptRoot();
  });
  const when = () => new Date(Date.now() - STALE);
  /** `<root>/proj/<id>` with `tasks/` plus whatever `extra` adds, all stale. */
  function shaped(id: string, extra: (dir: string) => void = () => {}): string {
    const dir = join(root, "proj", id);
    mkdirSync(join(dir, "tasks"), { recursive: true });
    writeFileSync(join(dir, "tasks", "a1.output"), "x");
    extra(dir);
    for (const name of readdirSync(join(dir, "tasks"))) {
      try { utimesSync(join(dir, "tasks", name), when(), when()); } catch { /* dangling or exotic entry */ }
    }
    for (const p of [join(dir, "tasks"), dir]) utimesSync(p, when(), when());
    return dir;
  }

  it("accepts .output, .workflow.js and .workflow.jsonl files", () => {
    const dir = shaped("ok", (d) => {
      writeFileSync(join(d, "tasks", "wf_1.workflow.js"), "x");
      writeFileSync(join(d, "tasks", "wf_1.workflow.jsonl"), "x");
    });
    expect(pruneStaleTranscripts()).toBe(1);
    expect(existsSync(dir)).toBe(false);
  });

  it.each([
    ["a sibling file next to tasks", (d: string) => writeFileSync(join(d, "notes.txt"), "x")],
    ["a sibling directory next to tasks", (d: string) => mkdirSync(join(d, "src"))],
    ["a foreign file in tasks", (d: string) => writeFileSync(join(d, "tasks", "readme.md"), "x")],
    ["a directory in tasks", (d: string) => mkdirSync(join(d, "tasks", "nested.output"))],
  ])("skips a dir with %s", (_name, extra) => {
    const dir = shaped("odd", extra);
    expect(pruneStaleTranscripts()).toBe(0);
    expect(existsSync(dir)).toBe(true);
  });

  it.skipIf(process.platform === "win32")("skips a dir whose tasks entry is a symlink named like a transcript", () => {
    const outside = join(fakeTmp.dir, "outside.txt");
    writeFileSync(outside, "mine");
    const dir = shaped("link", (d) => symlinkSync(outside, join(d, "tasks", "evil.output")));
    expect(pruneStaleTranscripts()).toBe(0);
    expect(existsSync(dir)).toBe(true);
    expect(readFileSync(outside, "utf-8")).toBe("mine");
  });

  it.skipIf(process.platform === "win32")("skips a dir whose tasks is a symlink", () => {
    const outside = join(fakeTmp.dir, "outside");
    mkdirSync(outside);
    const dir = join(root, "proj", "tl");
    mkdirSync(dir, { recursive: true });
    symlinkSync(outside, join(dir, "tasks"));
    utimesSync(dir, when(), when());
    expect(pruneStaleTranscripts()).toBe(0);
    expect(existsSync(dir)).toBe(true);
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

  it("touches the fork source's dirs in every cwd so other processes keep them too", () => {
    const a = session("c1", "src-id", STALE);
    const b = session("c2", "src-id", STALE);
    const other = session("c1", "unrelated", STALE);
    retainReferencedTranscripts([], "/s/2026_src-id.jsonl");
    for (const dir of [a, b]) {
      expect(Date.now() - statSync(dir).mtimeMs).toBeLessThan(DAY);
      expect(Date.now() - statSync(join(dir, "tasks")).mtimeMs).toBeLessThan(DAY);
    }
    expect(Date.now() - statSync(other).mtimeMs).toBeGreaterThan(DAY);
  });

  it.skipIf(process.platform === "win32")("never touches through a symlink or in a root without the marker", () => {
    const outside = join(fakeTmp.dir, "outside-src");
    mkdirSync(join(outside, "tasks"), { recursive: true });
    const when = new Date(Date.now() - STALE);
    utimesSync(outside, when, when);
    mkdirSync(join(root, "c1"), { recursive: true });
    symlinkSync(outside, join(root, "c1", "src-id"));
    retainReferencedTranscripts([], "/s/2026_src-id.jsonl");
    expect(Date.now() - statSync(outside).mtimeMs).toBeGreaterThan(DAY);

    const dir = session("c2", "src-id", STALE);
    rmSync(join(root, ".pi-subagents-root"));
    process.env.PI_SUBAGENTS_TRANSCRIPT_DIR = root;
    retainReferencedTranscripts([join(dir, "tasks", "a1.output")], "/s/2026_src-id.jsonl");
    expect(Date.now() - statSync(dir).mtimeMs).toBeGreaterThan(DAY);
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
