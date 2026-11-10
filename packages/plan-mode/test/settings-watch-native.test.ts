import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import planMode from "../src/plan-mode.js";
import * as settings from "../src/settings.js";
import { nativeWatchBudgetMs, nativeWatchTestName } from "./harness/test-timeout-policy.js";
import { createMockContext, createMockPi } from "./support.js";

/** Leaves the test budget (`nativeWatchBudgetMs`) room to report the failure itself. */
const nativeStartWaitMs = 20_000;

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
