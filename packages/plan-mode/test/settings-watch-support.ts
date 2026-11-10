import { basename } from "node:path";
import type { SettingsDirectoryListener, SettingsDirectoryWatcher } from "../src/plan-mode.js";

/**
 * Deterministic stand-in for the native directory watcher. Native delivery (FSEvents on macOS)
 * has host-dependent start latency, so unit tests publish the change themselves via `trigger`.
 */
export function createFakeSettingsWatch() {
  const live: { listener: SettingsDirectoryListener; closed: boolean }[] = [];
  return {
    /** Inject as `watchSettingsDirectory`. */
    watchSettingsDirectory(_directory: string, listener: SettingsDirectoryListener): SettingsDirectoryWatcher {
      const entry = { listener, closed: false };
      live.push(entry);
      return {
        close: () => {
          entry.closed = true;
        },
        on: () => undefined,
      };
    },
    /** Deliver a change for `settingsPath` to every watcher that is still open. */
    trigger(settingsPath: string, event = "change") {
      const open = live.filter((entry) => !entry.closed);
      if (open.length === 0) throw new Error("no open settings watcher to deliver the change to");
      for (const entry of open) entry.listener(event, basename(settingsPath));
    },
    openCount: () => live.filter((entry) => !entry.closed).length,
  };
}
