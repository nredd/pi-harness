import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import { exportPlanToFile } from "../src/plan-export.js";
import { readPlanModeSettings, updatePlanModeSettings } from "../src/settings.js";

vi.mock("node:fs/promises", { spy: true });
const actualFs = await vi.importActual<typeof fs>("node:fs/promises");
afterEach(() => {
  vi.mocked(fs.open).mockImplementation(actualFs.open);
  vi.mocked(fs.rm).mockImplementation(actualFs.rm);
  vi.mocked(fs.writeFile).mockImplementation(actualFs.writeFile);
});

test("export propagates non-collision write failures without claiming a successful publication", async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "pm-export-io-"));
  const path = join(directory, "plan.md");
  const failure = Object.assign(new Error("disk I/O failure"), { code: "EIO" });
  try {
    vi.spyOn(fs, "writeFile").mockImplementation(async (target, ...args) => {
      if (target === path) throw failure;
      return actualFs.writeFile(target, ...args);
    });
    await assert.rejects(exportPlanToFile("# Plan", path, directory), (error) => error === failure);
    await assert.rejects(fs.readFile(path), /ENOENT/);
  } finally {
    vi.restoreAllMocks();
    await actualFs.rm(directory, { recursive: true, force: true });
  }
});

/** These hooks gate real filesystem operations, not the settings parser or mutation queue. */
test("a canonical settings file arriving while legacy is read wins even when invalid", async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "pm-settings-race-"));
  const settingsPath = join(directory, "canonical.json");
  const legacySettingsPath = join(directory, "legacy.json");
  const open = actualFs.open;
  try {
    await fs.writeFile(legacySettingsPath, "{}");
    vi.spyOn(fs, "open").mockImplementation(async (path, ...args) => {
      if (path === legacySettingsPath) await fs.writeFile(settingsPath, "broken");
      return open(path, ...args);
    });
    await assert.rejects(
      updatePlanModeSettings({ thinkingLevel: "high" }, { settingsPath, legacySettingsPath }),
      /canonical.json.*invalid JSON/,
    );
    assert.equal(await fs.readFile(settingsPath, "utf8"), "broken");
    assert.equal(await fs.readFile(legacySettingsPath, "utf8"), "{}");
  } finally {
    vi.restoreAllMocks();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("a settings file growing after stat is rejected by the bounded read", async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "pm-settings-grow-"));
  const settingsPath = join(directory, "settings.json");
  const open = actualFs.open;
  try {
    await fs.writeFile(settingsPath, "{}");
    vi.spyOn(fs, "open").mockImplementation(async (path, ...args) => {
      const handle = await open(path, ...args);
      if (path === settingsPath) {
        const stat = handle.stat.bind(handle);
        vi.spyOn(handle, "stat").mockImplementation(async () => {
          const snapshot = await stat();
          await fs.writeFile(settingsPath, " ".repeat(1_048_577));
          return snapshot;
        });
      }
      return handle;
    });
    const result = await readPlanModeSettings(settingsPath);
    assert.equal(result.kind, "invalid");
    if (result.kind === "invalid") assert.match(result.reason, /exceeds.*bytes/);
  } finally {
    vi.restoreAllMocks();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("oversized merged settings refuse publication and preserve the original bytes", async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "pm-settings-size-"));
  const settingsPath = join(directory, "settings.json");
  try {
    // Compact input fits the read limit; pretty-printing an unknown retained array does not.
    const original = JSON.stringify({ retained: Array.from({ length: 30_000 }, () => 0) });
    await fs.writeFile(settingsPath, original);
    await assert.rejects(
      updatePlanModeSettings({ thinkingLevel: "high" }, { settingsPath }),
      /settings document exceeds/,
    );
    assert.equal(await fs.readFile(settingsPath, "utf8"), original);
    assert.deepEqual(await fs.readdir(directory), ["settings.json"]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("cleanup failure after publication does not misreport a successfully saved setting", async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "pm-settings-cleanup-"));
  const settingsPath = join(directory, "settings.json");
  const remove = actualFs.rm;
  let cleanupAttempts = 0;
  try {
    vi.spyOn(fs, "rm").mockImplementation(async (path, options) => {
      if (String(path).endsWith(".tmp")) {
        cleanupAttempts++;
        throw new Error("cleanup unavailable");
      }
      return remove(path, options);
    });
    assert.equal((await updatePlanModeSettings({ thinkingLevel: "high" }, { settingsPath })).thinkingLevel, "high");
    assert.equal(JSON.parse(await fs.readFile(settingsPath, "utf8")).thinkingLevel, "high");
    assert.equal(cleanupAttempts, 1);
    assert.deepEqual(await fs.readdir(directory), ["settings.json"]);
  } finally {
    vi.restoreAllMocks();
    await remove(directory, { recursive: true, force: true });
  }
});
