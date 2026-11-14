/**
 * boot-extension.ts: the recording `pi` / `ctx` pair the wiring tests use to boot the REAL
 * extension (src/index.ts) and drive its registered tools directly. Both come from the shared
 * doubles in `@nredd/pi-test-lib/pi`; this file only adds the views these tests read.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionShutdownEvent, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import {
  createRecordingContext,
  createRecordingPi,
  type RecordingPi,
  type RecordingPiOptions,
} from "@nredd/pi-test-lib/pi";
import { vi } from "vitest";

/** A `pi.on` lifecycle handler as the extension registers them; the map is keyed by event name. */
export type SessionStartHandler = (event: SessionStartEvent | SessionShutdownEvent, ctx: ExtensionContext) => Promise<void> | void;

export interface BootedPi {
  /** The recording `ExtensionAPI`; every method is a `vi.fn`. */
  pi: any;
  recording: RecordingPi;
  tools: Map<string, any>;
  /** `pi.on` handlers: the LAST one registered per event, which is all these tests drive. */
  lifecycle: Map<string, SessionStartHandler>;
  /** Same map as `lifecycle`, for tests that name it `handlers`. */
  handlers: Map<string, SessionStartHandler>;
  /** Custom entry renderers, by `customType`. */
  entryRenderers: Map<string, any>;
  /** Flags the extension registered, by name. */
  registeredFlags: Map<string, any>;
  /** Slash commands the extension registered, by name. */
  commands: Map<string, any>;
  /** `pi.events.on` subscribers: the LAST one per channel, for tests that feed the bus by hand. */
  busHandlers: Map<string, (raw: any) => unknown>;
  /** Same map as `busHandlers`, for tests that name it `events` or `eventHandlers`. */
  events: Map<string, (raw: any) => unknown>;
  eventHandlers: Map<string, (raw: any) => unknown>;
  /** Every `pi.events.emit`, in order. */
  emitted: { event: string; payload: any }[];
  /** The bus itself, for `bus.emit` / `bus.on` calls and spies. */
  bus: RecordingPi["bus"];
}

export interface BootOptions {
  /** Deliver `pi.events.emit` to `pi.events.on` subscribers. Default false: tests feed the bus by hand. */
  deliverEvents?: boolean;
  /** Replace any `ExtensionAPI` method. */
  overrides?: Partial<ExtensionAPI>;
  /** What `pi.exec` resolves with. */
  execResult?: RecordingPiOptions["execResult"];
}

/**
 * A recording ExtensionAPI (`@nredd/pi-test-lib/pi`) that also tracks the last `pi.on` handler
 * and `pi.events.on` subscriber per name.
 *
 * `flags` seeds what `pi.getFlag` returns, registered or not. It is deliberately separate from the
 * values passed to `registerFlag`: the host applies CLI values only AFTER every
 * extension has activated, so a test that seeds them here and reads them from
 * `session_start` reproduces the real ordering.
 */
export function bootPi(flags: Record<string, boolean | string> = {}, options: BootOptions = {}): BootedPi {
  const recording = createRecordingPi({
    deliverEvents: options.deliverEvents ?? false,
    execResult: options.execResult,
    overrides: { getFlag: vi.fn((name: string) => flags[name]), ...options.overrides },
  });
  const lifecycle = new Map<string, SessionStartHandler>();
  const busHandlers = new Map<string, (raw: any) => unknown>();
  const emitted: { event: string; payload: any }[] = [];
  const { pi, bus } = recording;
  const on = pi.on as (event: string, handler: SessionStartHandler) => () => void;
  (pi as any).on = vi.fn((event: string, handler: SessionStartHandler) => {
    lifecycle.set(event, handler);
    return on(event, handler);
  });
  const busOn = vi.mocked(bus.on).getMockImplementation() as typeof bus.on;
  const busEmit = vi.mocked(bus.emit).getMockImplementation() as typeof bus.emit;
  vi.mocked(bus.on).mockImplementation((channel, handler) => {
    busHandlers.set(channel, handler);
    const off = busOn(channel, handler);
    return () => {
      if (busHandlers.get(channel) === handler) busHandlers.delete(channel);
      off();
    };
  });
  vi.mocked(bus.emit).mockImplementation((channel, payload) => {
    emitted.push({ event: channel, payload });
    busEmit(channel, payload);
  });
  return {
    pi: pi as any,
    recording,
    tools: recording.tools,
    lifecycle,
    handlers: lifecycle,
    entryRenderers: recording.entryRenderers,
    registeredFlags: recording.flags,
    commands: recording.commands,
    busHandlers,
    events: busHandlers,
    eventHandlers: busHandlers,
    emitted,
    bus,
  };
}

/** A mock ExtensionContext — the second half of what a tool's `execute` receives. */
export function ctx(overrides: Record<string, unknown> = {}) {
  return createRecordingContext({
    // The interactive mode extensions normally run in. Set explicitly because
    // the `@handle` input hook is TUI-only, so an absent mode would make every
    // mention test exercise the headless fall-through instead.
    mode: "tui",
    hasUI: false,
    cwd: process.cwd(),
    overrides: {
      // Replaced wholesale, never merged: the extension feature-detects members, so a fuller
      // default changes which paths it takes.
      ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn(), addAutocompleteProvider: vi.fn() },
      modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
      sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
      ...overrides,
    } as never,
  }).ctx as any;
}

/** Text of a tool result. */
export const textOf = (r: any): string => r.content[0].text;

/** Let queued microtasks run — enough for the manager's internal chaining. */
export const flush = async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};

/**
 * Fire the extension's `session_start` the way pi does, with pi's canonical
 * project-trust answer on `ctx.isProjectTrusted()`. Project agents, the project's
 * `agent-tool-description.md` and the `Agent` tool's advertised types only appear
 * after this: the activation load is global-only by design.
 */
export async function startSession(
  lifecycle: Map<string, SessionStartHandler>,
  projectTrusted: boolean,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const handler = lifecycle.get("session_start");
  if (!handler) throw new Error("session_start handler was not registered");
  await handler({ type: "session_start", reason: "startup" }, ctx({ isProjectTrusted: () => projectTrusted, ...overrides }));
}

export interface Hermetic {
  dir: string;
  restore: () => void;
}

/**
 * Redirect cwd and `PI_CODING_AGENT_DIR` into a fresh temp dir, so the
 * developer's real settings and agent files can't reach the extension under
 * test. Call BEFORE instantiating the extension — settings are read at boot.
 */
export function hermeticDir(opts: {
  settings?: Record<string, unknown>;
  agentFiles?: Record<string, string>;
} = {}): Hermetic {
  // process.cwd() and project discovery use physical paths, including macOS /var.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-boot-")));
  const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "pi-boot-agentdir-")));
  const prevCwd = process.cwd();
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;

  mkdirSync(join(dir, ".pi"), { recursive: true });
  if (opts.settings) {
    writeFileSync(join(dir, ".pi", "subagents.json"), JSON.stringify(opts.settings));
  }
  if (opts.agentFiles) {
    mkdirSync(join(dir, ".pi", "agents"), { recursive: true });
    for (const [name, content] of Object.entries(opts.agentFiles)) {
      writeFileSync(join(dir, ".pi", "agents", `${name}.md`), content);
    }
  }

  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.chdir(dir);

  return {
    dir,
    restore() {
      process.chdir(prevCwd);
      if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
      rmSync(dir, { recursive: true, force: true });
      rmSync(agentDir, { recursive: true, force: true });
    },
  };
}
