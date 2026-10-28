import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vitest";
import planMode from "../src/plan-mode.js";
import * as settings from "../src/settings.js";
import { createMockContext, createMockPi } from "./support.js";

const watchFixture = vi.hoisted(() => ({
  callback: undefined as undefined | ((event: string, name: string) => void),
  watcher: undefined as undefined | (EventEmitter & { close: () => void }),
}));
vi.mock("node:fs", async (original) => ({
  ...(await original<typeof import("node:fs")>()),
  watch: (_directory: string, _options: unknown, callback: typeof watchFixture.callback) => {
    watchFixture.callback = callback;
    return watchFixture.watcher;
  },
}));

/** Exercise the real debounce and error callbacks with an explicitly ready watch boundary. */
test("watch bursts cancel older reloads and watcher errors cancel pending work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "plan-watch-lifecycle-"));
  const settingsPath = join(directory, "settings.json");
  const watcher = new EventEmitter();
  let closed = 0;
  watchFixture.watcher = Object.assign(watcher, {
    close: () => {
      closed += 1;
    },
  });
  const readSettings = settings.readPlanModeSettings;
  const reads: ReturnType<typeof readSettings>[] = [];
  const readSpy = vi.spyOn(settings, "readPlanModeSettings").mockImplementation((...args) => {
    const read = readSettings(...args);
    reads.push(read);
    return read;
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    await writeFile(settingsPath, JSON.stringify({ thinkingLevel: "low" }));
    const mock = createMockPi({ activeTools: ["read"], thinkingLevel: "off" });
    planMode(mock.pi, { settingsPath });
    const context = createMockContext();
    await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, context.ctx);
    assert.ok(watchFixture.callback, "session startup must install the watcher before events are delivered");
    await writeFile(settingsPath, JSON.stringify({ thinkingLevel: "high" }));
    watchFixture.callback("change", "settings.json");
    await vi.advanceTimersByTimeAsync(50);
    watchFixture.callback("rename", "settings.json");
    await vi.advanceTimersByTimeAsync(74);
    await mock.commands.get("plan")?.handler("start", context.ctx);
    assert.equal(mock.thinkingLevel, "low", "the superseded deadline must not reload settings");
    await mock.commands.get("plan")?.handler("off", context.ctx);
    await vi.advanceTimersByTimeAsync(1);
    assert.equal(reads.length, 2, "only the surviving deadline may start a settings read");
    await reads.at(-1);
    await vi.advanceTimersByTimeAsync(0);
    await mock.commands.get("plan")?.handler("start", context.ctx);
    assert.equal(mock.thinkingLevel, "high", "the surviving reload must apply the real file contents");
    await mock.commands.get("plan")?.handler("off", context.ctx);
    await writeFile(settingsPath, JSON.stringify({ thinkingLevel: "medium" }));
    watchFixture.callback("change", "settings.json");
    watcher.emit("error", new Error("watch backend closed"));
    assert.equal(closed, 1);
    await vi.advanceTimersByTimeAsync(100);
    await mock.commands.get("plan")?.handler("start", context.ctx);
    assert.equal(mock.thinkingLevel, "high", "an errored watch must cancel its pending reload");
    assert.equal(reads.length, 2, "cancelled reload must not start another filesystem read");
    await mock.events.get("session_shutdown")?.[0]?.({ reason: "quit" }, context.ctx);
    assert.equal(closed, 1, "shutdown must not close an already stopped watcher twice");
  } finally {
    vi.useRealTimers();
    readSpy.mockRestore();
    watchFixture.callback = undefined;
    watchFixture.watcher = undefined;
    await rm(directory, { recursive: true, force: true });
  }
});
