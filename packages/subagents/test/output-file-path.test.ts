// README:142 promises the transcript root is owner-only `0700`. Transcripts
// hold the agent's full conversation — user prompts, file contents, tool output —
// in a shared temp dir, so that mode is the only thing keeping them from every
// other local user. `createOutputFilePath` is mocked in the one wiring test that
// touches it, so this body had never actually executed under test.
//
// This lives in its own file because it must mock `node:os`. The real root is
// `$XDG_STATE_HOME/pi-subagents` (or `<os-tmpdir>/pi-subagents-<uid>` as fallback) — one path shared by every worker AND by the
// e2e suites that spawn real agents. Mutating it directly makes the test race
// against anything else writing a transcript (observed: passes alone, fails
// intermittently in the full run). Redirecting `tmpdir()` gives each run its own
// root and removes the shared state entirely.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir as realTmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakeTmp = vi.hoisted(() => ({ dir: "" }));
const chmodFault = vi.hoisted(() => ({ error: undefined as Error | undefined }));
const readdirFault = vi.hoisted(() => ({ match: undefined as string | undefined }));
const fakeHome = vi.hoisted(() => ({ dir: "" }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readdirSync: (...args: Parameters<typeof actual.readdirSync>) => {
      if (readdirFault.match && String(args[0]).includes(readdirFault.match)) throw new Error("EACCES: readdir");
      return (actual.readdirSync as (...a: unknown[]) => unknown)(...args);
    },
    chmodSync: (...args: Parameters<typeof actual.chmodSync>) => {
      if (chmodFault.error) throw chmodFault.error;
      return actual.chmodSync(...args);
    },
  };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, tmpdir: () => fakeTmp.dir || actual.tmpdir(), homedir: () => fakeHome.dir || actual.homedir() };
});

import { createOutputFilePath, pruneStaleTranscripts, TRANSCRIPT_RETENTION_MS, transcriptRoot } from "../src/output-file.js";

const UID = process.getuid?.() ?? 0;
const AGENT = "agent-xyz";
const SESSION = "session-123";

const realState = process.env.XDG_STATE_HOME;
afterEach(() => {
  if (realState === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = realState;
});

/** An XDG_STATE_HOME that cannot be created (a path under a regular file), even for root. */
function unwritableState(dir: string): string {
  const blocker = join(dir, "blocker");
  writeFileSync(blocker, "");
  return join(blocker, "state");
}

describe("createOutputFilePath (temp fallback when the state dir is unwritable)", () => {
  let root: string;

  beforeEach(() => {
    // realpath: macOS resolves /var → /private/var, and the module joins the
    // raw tmpdir() value, so comparisons must use the same form.
    fakeTmp.dir = realpathSync(mkdtempSync(join(realTmpdir(), "pi-outpath-")));
    root = join(fakeTmp.dir, `pi-subagents-${UID}`);
    process.env.XDG_STATE_HOME = unwritableState(fakeTmp.dir);
  });

  afterEach(() => {
    chmodFault.error = undefined;
    readdirFault.match = undefined;
    fakeHome.dir = "";
    rmSync(fakeTmp.dir, { recursive: true, force: true });
    fakeTmp.dir = "";
  });

  it("builds the documented layout: <root>/<encoded-cwd>/<session>/tasks/<agent>.output", () => {
    const path = createOutputFilePath("/home/user/project", AGENT, SESSION);
    expect(path).toBe(join(root, "home-user-project", SESSION, "tasks", `${AGENT}.output`));
  });

  it("creates the directory chain so the first write cannot fail", () => {
    const path = createOutputFilePath("/home/user/project", AGENT, SESSION);
    expect(existsSync(join(path, ".."))).toBe(true);
    expect(statSync(join(path, "..")).isDirectory()).toBe(true);
  });

  it("keeps distinct cwds in separate subdirectories under the shared root", () => {
    const a = createOutputFilePath("/home/user/project", AGENT, SESSION);
    const b = createOutputFilePath("/home/user/other", "agent-2", SESSION);
    expect(a).toContain("home-user-project");
    expect(b).toContain("home-user-other");
    expect(a).not.toBe(b);
  });

  it.skipIf(process.platform === "win32")("creates the root owner-only", () => {
    createOutputFilePath("/home/user/project", AGENT, SESSION);
    expect(statSync(root).mode & 0o777).toBe(0o700);
  });

  it.skipIf(process.platform === "win32")("re-tightens a pre-existing world-readable root", () => {
    // The case the explicit chmod exists for. `mkdirSync(recursive: true)` does
    // NOT alter an existing directory's mode, so a root left behind by an older
    // version — or created by anything else under a permissive umask — would
    // keep its wide permissions and every transcript written into it would be
    // readable by every local user. (mkdir's own `mode: 0o700` cannot cover
    // this: umask only clears bits, so a fresh mkdir is never too permissive.)
    mkdirSync(root, { recursive: true, mode: 0o755 });
    chmodSync(root, 0o755); // defeat umask so the premise really holds
    expect(statSync(root).mode & 0o777).toBe(0o755);

    createOutputFilePath("/home/user/project", AGENT, SESSION);

    expect(statSync(root).mode & 0o777).toBe(0o700);
  });

  it("falls back to uid 0 in the root name where the platform has no getuid", () => {
    const original = Object.getOwnPropertyDescriptor(process, "getuid");
    Object.defineProperty(process, "getuid", { value: undefined, configurable: true });
    try {
      const path = createOutputFilePath("/home/user/project", AGENT, SESSION);
      expect(path).toBe(join(fakeTmp.dir, "pi-subagents-0", "home-user-project", SESSION, "tasks", `${AGENT}.output`));
    } finally {
      if (original) Object.defineProperty(process, "getuid", original);
      else delete (process as { getuid?: unknown }).getuid;
    }
  });

  describe("when chmod of the root fails", () => {
    const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
    afterEach(() => Object.defineProperty(process, "platform", realPlatform));

    it.skipIf(process.platform === "win32")("rethrows on Unix, where the 0700 mode is the transcript's only protection", () => {
      chmodFault.error = new Error("EPERM: chmod");
      expect(() => createOutputFilePath("/home/user/project", AGENT, SESSION)).toThrow("EPERM: chmod");
    });

    it("tolerates it on Windows, where chmod is a no-op or unsupported", () => {
      Object.defineProperty(process, "platform", { ...realPlatform, value: "win32" });
      chmodFault.error = new Error("EPERM: chmod");
      expect(createOutputFilePath("/home/user/project", AGENT, SESSION)).toContain(`${AGENT}.output`);
    });
  });
});

describe("transcriptRoot (#900)", () => {
  let state: string;

  beforeEach(() => {
    fakeTmp.dir = realpathSync(mkdtempSync(join(realTmpdir(), "pi-outpath-")));
    state = join(fakeTmp.dir, "state");
    process.env.XDG_STATE_HOME = state;
  });

  afterEach(() => {
    chmodFault.error = undefined;
    readdirFault.match = undefined;
    fakeHome.dir = "";
    rmSync(fakeTmp.dir, { recursive: true, force: true });
    fakeTmp.dir = "";
  });

  it("roots transcripts at $XDG_STATE_HOME/pi-subagents, off tmpdir()", () => {
    const path = createOutputFilePath("/home/user/project", AGENT, SESSION);
    expect(path).toBe(join(state, "pi-subagents", "home-user-project", SESSION, "tasks", `${AGENT}.output`));
    expect(existsSync(join(fakeTmp.dir, `pi-subagents-${UID}`))).toBe(false);
  });

  it.skipIf(process.platform === "win32")("makes the root 0700 and re-tightens an existing wide one", () => {
    const root = join(state, "pi-subagents");
    mkdirSync(root, { recursive: true, mode: 0o755 });
    chmodSync(root, 0o755);
    expect(transcriptRoot()).toBe(root);
    expect(statSync(root).mode & 0o777).toBe(0o700);
  });

  it("defaults to ~/.local/state when XDG_STATE_HOME is unset", () => {
    delete process.env.XDG_STATE_HOME;
    fakeHome.dir = fakeTmp.dir;
    expect(transcriptRoot()).toBe(join(fakeTmp.dir, ".local", "state", "pi-subagents"));
  });

  it("ignores a relative XDG_STATE_HOME per the XDG spec", () => {
    process.env.XDG_STATE_HOME = "relative/state";
    fakeHome.dir = fakeTmp.dir;
    expect(transcriptRoot()).toBe(join(fakeTmp.dir, ".local", "state", "pi-subagents"));
  });

  it("falls back to the temp root when the state root cannot be created", () => {
    process.env.XDG_STATE_HOME = unwritableState(fakeTmp.dir);
    expect(transcriptRoot()).toBe(join(fakeTmp.dir, `pi-subagents-${UID}`));
  });
});

describe("pruneStaleTranscripts (#900)", () => {
  const DAY = 24 * 60 * 60 * 1000;
  let root: string;

  /** Make `<root>/<cwd>/<session>/tasks/<file>` with every mtime set `ageMs` before now. */
  function session(cwd: string, id: string, ageMs: number, files = ["a.output"]): string {
    const dir = join(root, cwd, id);
    const tasks = join(dir, "tasks");
    mkdirSync(tasks, { recursive: true });
    const when = new Date(Date.now() - ageMs);
    for (const f of files) {
      writeFileSync(join(tasks, f), "x");
      utimesSync(join(tasks, f), when, when);
    }
    utimesSync(tasks, when, when);
    utimesSync(dir, when, when);
    return dir;
  }

  beforeEach(() => {
    fakeTmp.dir = realpathSync(mkdtempSync(join(realTmpdir(), "pi-outpath-")));
    process.env.XDG_STATE_HOME = join(fakeTmp.dir, "state");
    root = transcriptRoot();
  });

  afterEach(() => {
    chmodFault.error = undefined;
    readdirFault.match = undefined;
    fakeHome.dir = "";
    rmSync(fakeTmp.dir, { recursive: true, force: true });
    fakeTmp.dir = "";
  });

  it("removes sessions idle past retention and keeps recent ones", () => {
    const old = session("proj", "old", TRANSCRIPT_RETENTION_MS + DAY);
    const fresh = session("proj", "fresh", DAY);
    expect(pruneStaleTranscripts()).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it("keeps a session whose old dir has a recently appended transcript", () => {
    const dir = session("proj", "busy", TRANSCRIPT_RETENTION_MS + DAY, ["old.output", "live.output"]);
    const now = new Date();
    utimesSync(join(dir, "tasks", "live.output"), now, now);
    expect(pruneStaleTranscripts()).toBe(0);
    expect(existsSync(dir)).toBe(true);
  });

  it("never prunes the live session, even when stale", () => {
    const dir = session("proj", "live", TRANSCRIPT_RETENTION_MS + DAY);
    expect(pruneStaleTranscripts("live")).toBe(0);
    expect(existsSync(dir)).toBe(true);
  });

  it("drops a cwd dir left empty and keeps one still holding sessions", () => {
    session("gone", "old", TRANSCRIPT_RETENTION_MS + DAY);
    session("stays", "old", TRANSCRIPT_RETENTION_MS + DAY);
    session("stays", "fresh", DAY);
    pruneStaleTranscripts();
    expect(existsSync(join(root, "gone"))).toBe(false);
    expect(existsSync(join(root, "stays", "fresh"))).toBe(true);
  });

  it("leaves the detached spool, stray files and a session dir without tasks alone", () => {
    const detached = session("detached", "abc", TRANSCRIPT_RETENTION_MS + DAY);
    writeFileSync(join(root, "stray"), "x");
    const bare = join(root, "proj", "bare");
    mkdirSync(bare, { recursive: true });
    const when = new Date(Date.now() - DAY);
    utimesSync(bare, when, when);
    expect(pruneStaleTranscripts()).toBe(0);
    expect(existsSync(detached)).toBe(true);
    expect(existsSync(join(root, "stray"))).toBe(true);
    expect(existsSync(bare)).toBe(true);
  });

  it("prunes a stale session that has no tasks dir", () => {
    const bare = join(root, "proj", "bare");
    mkdirSync(bare, { recursive: true });
    const when = new Date(Date.now() - TRANSCRIPT_RETENTION_MS - DAY);
    utimesSync(bare, when, when);
    expect(pruneStaleTranscripts()).toBe(1);
    expect(existsSync(bare)).toBe(false);
  });

  it.skipIf(process.platform === "win32")("never follows a symlink out of the root", () => {
    const outside = join(fakeTmp.dir, "outside");
    mkdirSync(join(outside, "tasks"), { recursive: true });
    writeFileSync(join(outside, "tasks", "precious"), "x");
    mkdirSync(join(root, "proj"), { recursive: true });
    symlinkSync(outside, join(root, "proj", "link"));
    symlinkSync(outside, join(root, "linkcwd"));
    expect(pruneStaleTranscripts(undefined, Date.now() + 365 * DAY)).toBe(0);
    expect(existsSync(join(outside, "tasks", "precious"))).toBe(true);
  });

  it("examines a bounded number of sessions per call", () => {
    for (let i = 0; i < 1005; i++) mkdirSync(join(root, "bulk", `s${i}`, "tasks"), { recursive: true });
    expect(pruneStaleTranscripts(undefined, Date.now() + TRANSCRIPT_RETENTION_MS + DAY)).toBe(1000);
    expect(pruneStaleTranscripts(undefined, Date.now() + TRANSCRIPT_RETENTION_MS + DAY)).toBe(5);
  });

  it("does nothing when no root can be created", () => {
    chmodFault.error = new Error("EPERM: chmod");
    expect(pruneStaleTranscripts()).toBe(0);
  });

  it("skips a cwd dir it cannot read", () => {
    session("unreadable", "old", TRANSCRIPT_RETENTION_MS + DAY);
    readdirFault.match = "unreadable";
    expect(pruneStaleTranscripts()).toBe(0);
    readdirFault.match = undefined;
    expect(existsSync(join(root, "unreadable", "old"))).toBe(true);
  });

  it("tolerates a root path that is not a directory", () => {
    rmSync(root, { recursive: true, force: true });
    writeFileSync(root, "not a dir");
    expect(pruneStaleTranscripts()).toBe(0);
  });
});
