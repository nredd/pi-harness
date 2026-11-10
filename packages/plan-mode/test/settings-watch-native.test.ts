import assert from "node:assert/strict";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import planMode from "../src/plan-mode.js";
import * as settings from "../src/settings.js";
import { nativeWatchBudgetMs, nativeWatchTestName } from "./harness/test-timeout-policy.js";
import { createFakeSettingsWatch } from "./settings-watch-support.js";
import { createMockContext, createMockPi } from "./support.js";

/** Leaves the test budget (`nativeWatchBudgetMs`) room to report the failure itself. */
const nativeStartWaitMs = 20_000;

test("an injected watcher delivers reloads and is closed on shutdown", async () => {
  const directory = await mkdtemp(join(tmpdir(), "plan-watch-seam-"));
  const settingsPath = join(directory, "settings.json");
  const watch = createFakeSettingsWatch();
  try {
    await writeFile(settingsPath, JSON.stringify({ thinkingLevel: "low" }));
    const mock = createMockPi({ activeTools: ["read"], thinkingLevel: "off" });
    planMode(mock.pi, { settingsPath, watchSettingsDirectory: watch.watchSettingsDirectory });
    const context = createMockContext();
    assert.throws(() => watch.trigger(settingsPath), /no open settings watcher/);
    await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, context.ctx);
    assert.equal(watch.openCount(), 1);
    await writeFile(settingsPath, JSON.stringify({ thinkingLevel: "high" }));
    watch.trigger(settingsPath);
    await vi.waitFor(async () => {
      await mock.commands.get("plan")?.handler("start", context.ctx);
      const level = mock.thinkingLevel;
      await mock.commands.get("plan")?.handler("off", context.ctx);
      expect(level).toBe("high");
    });
    await mock.events.get("session_shutdown")?.[0]?.({ reason: "quit" }, context.ctx);
    assert.equal(watch.openCount(), 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

/** The only test that depends on native delivery; it waits for stream start instead of racing it. */
test(nativeWatchTestName, { timeout: nativeWatchBudgetMs }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "plan-watch-native-"));
  const settingsPath = join(directory, "settings.json");
  const readSettings = settings.readPlanModeSettings;
  let sawHigh = false;
  const readSpy = vi.spyOn(settings, "readPlanModeSettings").mockImplementation(async (...args) => {
    const result = await readSettings(...args);
    if (result.kind === "loaded" && result.settings.thinkingLevel === "high") sawHigh = true;
    return result;
  });
  const mock = createMockPi({ activeTools: ["read"], thinkingLevel: "off" });
  const context = createMockContext();
  try {
    await writeFile(settingsPath, JSON.stringify({ thinkingLevel: "low" }));
    planMode(mock.pi, { settingsPath });
    await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, context.ctx);
    // Writes made before the native stream is live are dropped, so republish until one lands.
    await vi.waitFor(
      async () => {
        const temporaryPath = `${settingsPath}.next`;
        await writeFile(temporaryPath, JSON.stringify({ thinkingLevel: "high" }));
        await rename(temporaryPath, settingsPath);
        expect(sawHigh).toBe(true);
      },
      { timeout: nativeStartWaitMs, interval: 250 },
    );
  } finally {
    await mock.events.get("session_shutdown")?.[0]?.({ reason: "quit" }, context.ctx);
    readSpy.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
});
