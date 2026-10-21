import assert from "node:assert/strict";
import { readFile, rename, writeFile } from "node:fs/promises";
import { vi } from "vitest";

/** Wait for an extension-observable read before testing a newly installed native watcher. */
export async function waitForSettingsWatch(settingsPath: string, hasReloaded: () => boolean) {
  const initial = await readFile(settingsPath, "utf8");
  const temporaryPath = `${settingsPath}.watch-ready`;
  // Native watcher startup can miss or coalesce immediate writes. Republish the
  // unchanged settings until the extension observes one, rather than sleeping.
  await vi.waitFor(
    async () => {
      if (!hasReloaded()) {
        await writeFile(temporaryPath, initial);
        await rename(temporaryPath, settingsPath);
      }
      assert.ok(hasReloaded(), "settings watcher must observe a read before the test mutation");
    },
    // Leave room for the extension's 75 ms debounce between publications.
    { timeout: 2_000, interval: 150 },
  );
}
