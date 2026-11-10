/**
 * Vitest setup: point `os.tmpdir()` at a disposable per-file root.
 *
 * `sessionTaskDir()` writes under `<tmpdir>/pi-subagents-<uid>/<encoded-cwd>/<session>`, and
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

const realTmp = process.env.PI_TEST_REAL_TMPDIR ?? tmpdir();
const previousTmpdir = process.env.TMPDIR;
const previousReal = process.env.PI_TEST_REAL_TMPDIR;
const sandbox = realpathSync(mkdtempSync(join(realTmp, "pi-subagents-test-tmp-")));

process.env.PI_TEST_REAL_TMPDIR = realTmp;
process.env.TMPDIR = sandbox;

afterAll(() => {
  if (previousTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = previousTmpdir;
  if (previousReal === undefined) delete process.env.PI_TEST_REAL_TMPDIR;
  else process.env.PI_TEST_REAL_TMPDIR = previousReal;
  rmSync(sandbox, { recursive: true, force: true });
});
