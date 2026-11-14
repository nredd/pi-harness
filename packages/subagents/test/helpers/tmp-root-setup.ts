/**
 * Vitest setup: point `os.tmpdir()` at a disposable per-file root.
 *
 * `sessionTaskDir()` writes under `<transcript root>/<encoded-cwd>/<session>` (`$XDG_STATE_HOME/pi-subagents`,
 * sandboxed here to `<sandbox>/state`, falling back to `<tmpdir>/pi-subagents-<uid>`), and
 * every test cwd is itself a `mkdtemp` dir, so each session leaked one directory into the
 * user's real temp root (214k entries on one host). Sandboxing `TMPDIR` for the file makes
 * those writes, and every helper `mkdtemp`, land in a root removed after the file runs.
 *
 * The real root is exposed as `PI_TEST_REAL_TMPDIR` for the leak regression test.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

export const SANDBOX_PREFIX = "pi-subagents-test-tmp-";

/** Redirect `TMPDIR` into a fresh sandbox; the returned function removes it and restores env. */
export function sandboxTmpdir(): { sandbox: string; realTmp: string; restore: () => void } {
  const realTmp = realpathSync(process.env.PI_TEST_REAL_TMPDIR ?? tmpdir());
  const previousTmpdir = process.env.TMPDIR;
  const previousReal = process.env.PI_TEST_REAL_TMPDIR;
  const previousState = process.env.XDG_STATE_HOME;
  const sandbox = realpathSync(mkdtempSync(join(realTmp, SANDBOX_PREFIX)));
  process.env.PI_TEST_REAL_TMPDIR = realTmp;
  process.env.TMPDIR = sandbox;
  process.env.XDG_STATE_HOME = join(sandbox, "state");
  return {
    sandbox,
    realTmp,
    restore() {
      if (previousTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmpdir;
      if (previousState === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previousState;
      if (previousReal === undefined) delete process.env.PI_TEST_REAL_TMPDIR;
      else process.env.PI_TEST_REAL_TMPDIR = previousReal;
      rmSync(sandbox, { recursive: true, force: true });
    },
  };
}

const active = sandboxTmpdir();
afterAll(active.restore);
