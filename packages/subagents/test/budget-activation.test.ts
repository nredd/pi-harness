/** Incompatible reloads refuse the whole bind, before registering any usable surface. */
import { type ExtensionAPI, ExtensionStartupError } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import subagentsExtension from "../src/index.js";
import * as startupError from "../src/startup-error.js";

const key = Symbol.for("pi-subagents:process-budget");
const globals = globalThis as Record<symbol, unknown>;
const previous = globals[key];
afterEach(() => {
  vi.restoreAllMocks();
  if (previous === undefined) delete globals[key];
  else globals[key] = previous;
});

it("fails session_start with a restart diagnostic instead of leaving a partial activation", async () => {
  const predecessor = { version: -1, survivor: "must not be replaced" };
  globals[key] = predecessor;
  const pi = {
    on: vi.fn(),
    registerMessageRenderer: vi.fn(),
    registerEntryRenderer: vi.fn(),
    registerFlag: vi.fn(),
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    events: { on: vi.fn(), emit: vi.fn() },
  };

  // A factory throw is only a load warning on the host. Register the fatal
  // bind handler instead, with no tools, commands, managers or other handlers.
  expect(() => subagentsExtension(pi as unknown as ExtensionAPI)).not.toThrow();
  expect(pi.on).toHaveBeenCalledTimes(1);
  expect(pi.on.mock.calls[0][0]).toBe("session_start");
  const failBind = pi.on.mock.calls[0][1] as () => Promise<void>;
  await expect(failBind()).rejects.toBeInstanceOf(ExtensionStartupError);
  await expect(failBind()).rejects.toThrow(/Incompatible process budget.*Restart pi/);
  for (const register of [pi.registerMessageRenderer, pi.registerEntryRenderer, pi.registerFlag, pi.registerTool, pi.registerCommand, pi.events.on, pi.events.emit]) {
    expect(register).not.toHaveBeenCalled();
  }
  expect(globals[key]).toBe(predecessor);
});

it("refuses before registration when the host lacks the fatal-bind API", () => {
  const predecessor = { version: -1 };
  globals[key] = predecessor;
  vi.spyOn(startupError, "hostStartupErrorClass").mockReturnValue(undefined);
  const pi = { on: vi.fn(), registerMessageRenderer: vi.fn() };
  expect(() => subagentsExtension(pi as unknown as ExtensionAPI)).toThrow(/Restart pi.*lacks ExtensionStartupError; upgrade pi/);
  expect(pi.on).not.toHaveBeenCalled();
  expect(pi.registerMessageRenderer).not.toHaveBeenCalled();
  expect(globals[key]).toBe(predecessor);
});
