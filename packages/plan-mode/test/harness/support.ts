import os from "node:os";
import path from "node:path";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { Key, type KeyId, matchesKey } from "@earendil-works/pi-tui";
import {
  createRecordingContext,
  createRecordingPi,
  expectNoSubscriberErrors,
  type RecordingContextOptions,
  type RecordingPi,
  type RecordingPiOptions,
} from "@nredd/pi-test-lib/pi";
import { afterEach } from "vitest";

const created: RecordingPi[] = [];
afterEach(() => {
  expectNoSubscriberErrors(created.splice(0));
});

/** The shared recording `ExtensionAPI`, with the tools Plan expects active and a builtin catalogue. */
export function createPlanPi(
  options: Pick<RecordingPiOptions, "activeTools" | "allTools" | "thinkingLevel" | "clampThinkingLevel"> = {},
) {
  const activeTools = [...(options.activeTools ?? [])];
  const recording = createRecordingPi({
    ...options,
    autoActivate: false,
    activeTools,
    allTools: options.allTools ?? activeTools.map((name) => builtinTool(name)),
  });
  created.push(recording);
  return recording;
}

/**
 * The shared recording context. Plan's tests pass UI members (`select`, `input`, `custom`, ...)
 * and context members (`isIdle`, `sessionManager`, ...) side by side in one bag.
 */
export function createPlanContext(overrides: Record<string, unknown> = {}) {
  const pasteOverride = overrides.pasteToEditor as ((text: string) => void) | undefined;
  const selectOverride = overrides.select as
    | ((title: string, options: string[]) => Promise<string | undefined>)
    | undefined;
  const inputOverride = overrides.input as ((title: string, placeholder?: string) => Promise<unknown>) | undefined;
  const defaultCustom = async (factory: unknown) => {
    if (!selectOverride) return undefined;
    const harness = createCustomSelectorHarness(factory, 100);
    const options: string[] = [];
    for (let index = 0; index < 200; index += 1) {
      const selected = selectedKitRow(harness.render());
      if (!selected || options.includes(selected)) break;
      options.push(selected);
      harness.handleInput("tui.select.down");
    }
    for (let index = 0; index < options.length; index += 1) {
      harness.handleInput("tui.select.up");
    }
    if (options.length === 0 && harness.isFocusable && inputOverride) {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const response = await inputOverride(harness.render().join("\n"), "");
        if (isRecord(response) && response.kind === "closed") {
          harness.handleInput("\u0003");
          return harness.result;
        }
        if (response === undefined || (isRecord(response) && response.kind === "cancelled")) {
          harness.handleInput("tui.select.cancel");
          return harness.result;
        }
        const value = isRecord(response) && response.kind === "submitted" ? response.value : response;
        if (typeof value !== "string") throw new Error("Mock input must return a string or exit");
        harness.setFocused(true);
        if (attempt > 0) harness.handleInput("\u0015");
        harness.handleInput(value);
        harness.handleInput("tui.input.submit");
        await harness.waitForPending();
        if (harness.result !== undefined) return harness.result;
      }
      throw new Error("Mock input exceeded its retry limit");
    }
    const selected = await selectOverride(harness.render().join("\n"), options);
    if (selected === "\u0003") {
      harness.handleInput("\u0003");
      return harness.result;
    }
    if (selected === undefined) {
      harness.handleInput("tui.select.cancel");
      return harness.result;
    }
    const selectedIndex = Math.max(
      0,
      options.findIndex((option) => option === selected || option.startsWith(selected) || selected.startsWith(option)),
    );
    for (let index = 0; index < selectedIndex; index += 1) {
      harness.handleInput("tui.select.down");
    }
    harness.handleInput("tui.select.confirm");
    if (harness.result !== undefined) return harness.result;
    await harness.waitForPending();
    await Promise.resolve();
    if (harness.result !== undefined) return harness.result;
    harness.handleInput("tui.select.cancel");
    return harness.result;
  };
  const customOverride = overrides.custom as ((factory: unknown, options?: unknown) => Promise<unknown>) | undefined;
  const custom =
    customOverride && selectOverride
      ? async (factory: unknown, options?: unknown) => {
          const probe = createCustomSelectorHarness(factory, 100);
          const standard = probe.isPiTuiKitScreen;
          probe.dispose();
          return standard ? defaultCustom(factory) : customOverride(factory, options);
        }
      : (customOverride ?? defaultCustom);

  const {
    cwd,
    mode,
    hasUI,
    model,
    editorText,
    theme,
    onTerminalInput,
    pasteToEditor: _paste,
    confirm,
    input,
    select,
    editor,
    custom: _custom,
    sessionManager,
    modelRegistry,
    ...rest
  } = overrides;
  const recording = createRecordingContext({
    cwd: cwd as string | undefined,
    hasUI: (hasUI ?? (mode === "tui" || mode === "rpc")) as boolean,
    model: model as RecordingContextOptions["model"],
    editorText: editorText === undefined ? undefined : String(editorText),
    ui: {
      ...(theme === undefined ? {} : { theme }),
      ...(onTerminalInput === undefined ? {} : { onTerminalInput }),
      ...(confirm === undefined ? {} : { confirm }),
      ...(input === undefined ? {} : { input }),
      ...(select === undefined ? {} : { select }),
      ...(editor === undefined ? {} : { editor }),
      ...(pasteOverride
        ? {
            pasteToEditor: (value: string) => {
              recording.pastedEditorTexts.push(value);
              pasteOverride(value);
            },
          }
        : {}),
      custom,
    } as RecordingContextOptions["ui"],
    // A host that reports no mode (pre-0.79) is a case Plan handles; the shared default would pick "print".
    overrides: {
      ...rest,
      mode: mode ?? (hasUI ? "tui" : undefined),
      // Replaced wholesale, never merged: Plan feature-detects members, so a richer default changes its path.
      sessionManager: sessionManager ?? {
        getSessionId: () => "test-session",
        getSessionName: () => undefined,
        getBranch: () => [],
        getEntries: () => [],
      },
      modelRegistry: modelRegistry ?? {
        getApiKeyAndHeaders: async () => ({ ok: false, error: "missing" }),
        getAvailable: () => [],
        getAll: () => [],
        isUsingOAuth: () => false,
      },
    } as RecordingContextOptions["overrides"],
  });
  return recording;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function selectedKitRow(lines: readonly string[]): string | undefined {
  const line = lines.find((candidate) => candidate.startsWith("→ ") || candidate.startsWith("› "));
  if (!line) return undefined;
  return line
    .slice(2)
    .replace(/^\[(?:x| |-)\]\s+/u, "")
    .split(/\s{2,}/u)[0]
    ?.trim();
}

export function createCustomSelectorHarness(
  factory: unknown,
  width = 100,
  keybindingsOverride?: {
    matches(data: string, key: string): boolean;
    getKeys(key: string): readonly string[];
  },
  terminalRows = 24,
) {
  if (typeof factory !== "function") throw new Error("Expected a custom component factory");
  let result: unknown;
  let resolveResult!: (value: unknown) => void;
  const resultPromise = new Promise<unknown>((resolve) => {
    resolveResult = resolve;
  });
  const terminal = { rows: terminalRows };
  const component = (
    factory as (...args: unknown[]) => {
      render(width: number): string[];
      handleInput(data: string): void;
      handleMouse?(event: { type: string; button: string; x: number; y: number }): unknown;
    }
  )(
    { terminal, requestRender() {} },
    {
      fg(_color: string, text: string) {
        return text;
      },
      bold(text: string) {
        return text;
      },
    },
    keybindingsOverride ?? {
      matches(data: string, key: string) {
        const bindings: Record<string, KeyId> = {
          "tui.select.up": Key.up,
          "tui.select.down": Key.down,
          "tui.select.pageUp": Key.pageUp,
          "tui.select.pageDown": Key.pageDown,
          "tui.select.confirm": Key.enter,
          "tui.select.cancel": Key.escape,
          "tui.input.submit": Key.enter,
        };
        const binding = bindings[key];
        return (
          (binding !== undefined && matchesKey(data, binding)) ||
          (key === "tui.select.cancel" && matchesKey(data, Key.ctrl("c")))
        );
      },
      getKeys(key: string): readonly string[] {
        if (key === "tui.select.up") return ["up"];
        if (key === "tui.select.down") return ["down"];
        if (key === "tui.select.confirm" || key === "tui.input.submit") return ["enter"];
        if (key === "tui.select.cancel") return ["escape", "ctrl+c"];
        return [];
      },
    },
    (value: unknown) => {
      result = value;
      resolveResult(value);
    },
  );
  return {
    handleInput(data: string) {
      const inputData: Record<string, string> = {
        "tui.select.up": "\u001b[A",
        "tui.select.down": "\u001b[B",
        "tui.select.pageUp": "\u001b[5~",
        "tui.select.pageDown": "\u001b[6~",
        "tui.select.confirm": "\r",
        "tui.select.cancel": "\u001b",
        "tui.input.submit": "\r",
      };
      component.handleInput(inputData[data] ?? data);
      return component.render(width);
    },
    handleMouse(event: { type: string; button: string; x: number; y: number }) {
      return component.handleMouse?.(event);
    },
    render(renderWidth = width) {
      return component.render(renderWidth);
    },
    setTerminalRows(rows: number) {
      terminal.rows = rows;
    },
    invalidate() {
      (component as { invalidate?: () => void }).invalidate?.();
    },
    setFocused(focused: boolean) {
      if ("focused" in component) (component as { focused: boolean }).focused = focused;
    },
    async waitForPending() {
      await (component as { waitForPending?: () => Promise<void> }).waitForPending?.();
    },
    dispose() {
      (component as { dispose?: () => void }).dispose?.();
    },
    resultPromise,
    get isPiTuiKitScreen() {
      return (component as { __piTuiKitScreen?: true }).__piTuiKitScreen === true;
    },
    get isFocusable() {
      return "focused" in component;
    },
    get result() {
      return result;
    },
  };
}

export function driveCustomSelector(
  factory: unknown,
  inputs: readonly string[],
  width = 100,
): { renders: string[][]; result: unknown } {
  const harness = createCustomSelectorHarness(factory, width);
  const renders = inputs.map((input) => harness.handleInput(input));
  return { renders, result: harness.result };
}

export function builtinTool(name: string): ToolInfo {
  return {
    name,
    sourceInfo: { source: "builtin", scope: "builtin" },
  } as unknown as ToolInfo;
}

export function extensionTool(name: string): ToolInfo {
  return {
    name,
    sourceInfo: { source: "extension", scope: "user", path: path.join(os.tmpdir(), name) },
  } as unknown as ToolInfo;
}
