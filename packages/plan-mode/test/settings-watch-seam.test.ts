import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import planMode from "../src/plan-mode.js";
import { createFakeSettingsWatch } from "./settings-watch-support.js";
import { createPlanContext, createPlanPi } from "./support.js";

test("an injected watcher delivers reloads and is closed on shutdown", async () => {
  const directory = await mkdtemp(join(tmpdir(), "plan-watch-seam-"));
  const settingsPath = join(directory, "settings.json");
  const watch = createFakeSettingsWatch();
  try {
    await writeFile(settingsPath, JSON.stringify({ thinkingLevel: "low" }));
    const mock = createPlanPi({ activeTools: ["read"], thinkingLevel: "off" });
    planMode(mock.pi, { settingsPath, watchSettingsDirectory: watch.watchSettingsDirectory });
    const context = createPlanContext();
    assert.throws(() => watch.trigger(settingsPath), /no open settings watcher/);
    await mock.handlers.get("session_start")?.[0]?.({ reason: "startup" }, context.ctx);
    assert.equal(watch.openCount(), 1);
    await writeFile(settingsPath, JSON.stringify({ thinkingLevel: "high" }));
    watch.trigger(settingsPath);
    await vi.waitFor(async () => {
      await mock.commands.get("plan")?.handler("start", context.ctx);
      const level = mock.thinkingLevel;
      await mock.commands.get("plan")?.handler("off", context.ctx);
      expect(level).toBe("high");
    });
    await mock.handlers.get("session_shutdown")?.[0]?.({ reason: "quit" }, context.ctx);
    assert.equal(watch.openCount(), 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
