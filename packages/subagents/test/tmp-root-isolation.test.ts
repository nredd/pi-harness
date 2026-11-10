/** Test sessions must not leak subagent output dirs into the user's real temp root (#678). */
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { sessionTaskDir } from "../src/output-file.js";

it("sandboxes tmpdir() away from the real temp root", () => {
  const real = process.env.PI_TEST_REAL_TMPDIR;
  expect(real).toBeTruthy();
  expect(tmpdir()).not.toBe(real);
  expect(tmpdir().startsWith(join(real!, "pi-subagents-test-tmp-"))).toBe(true);
});

it("writes session task dirs under the sandbox and leaves the real root untouched", () => {
  const real = process.env.PI_TEST_REAL_TMPDIR!;
  const cwd = mkdtempSync(join(tmpdir(), "pi-boot-"));
  const dir = sessionTaskDir(cwd, "leak-probe-session");
  expect(dir.startsWith(tmpdir())).toBe(true);
  const uid = process.getuid?.() ?? 0;
  const leaked = join(real, `pi-subagents-${uid}`, cwd.replace(/[/\\]/g, "-").replace(/^-+/, ""));
  expect(existsSync(dir)).toBe(true);
  expect(existsSync(leaked)).toBe(false);
});
