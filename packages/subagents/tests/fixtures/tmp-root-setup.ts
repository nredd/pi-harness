/**
 * Vitest setup: point `os.tmpdir()` at a disposable per-file root.
 *
 * `sessionTaskDir()` writes under `<tmpdir>/pi-subagents-<uid>/<encoded-cwd>/<session>`, and
 * every test cwd is itself a `mkdtemp` dir, so each session leaked one directory into the
 * user's real temp root (214k entries on one host). Sandboxing `TMPDIR` for the file makes
 * those writes, and every helper `mkdtemp`, land in a root removed after the file runs.
 *
 * `XDG_STATE_HOME` is sandboxed too (#900): transcripts live under `$XDG_STATE_HOME/pi-subagents`.
 * The real root is exposed as `PI_TEST_REAL_TMPDIR` for the leak regression test.
 */
import { sandboxTmpdir } from "@nredd/pi-test-lib/sandbox";
import { afterAll } from "vitest";

afterAll(sandboxTmpdir().restore);
