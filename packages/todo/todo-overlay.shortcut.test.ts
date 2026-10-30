import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	buildSessionEntries,
	createMockCtx,
	createMockPi,
	makeTheme,
	makeTodoToolResult,
} from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_HOME } from "./.test-support/setup.ts";
import registerTodo from "./index.ts";
import { __resetState } from "./todo.ts";

const CONFIG_PATH = join(TEST_HOME, ".config", "rpiv-todo", "config.json");

function writeConfigFile(contents: string): void {
	mkdirSync(dirname(CONFIG_PATH), { recursive: true });
	writeFileSync(CONFIG_PATH, contents, "utf-8");
}
function removeConfigFile(): void {
	rmSync(CONFIG_PATH, { force: true });
}

// Drives the composer's default export (index.ts) to verify the collapse/expand
// shortcut registration and handler guard ladder. registerTodo() builds a fresh
// closure each call, so isolation is automatic given __resetState() clears the
// store. The shortcut handler closes over the closure-local `todoOverlay` and
// re-reads it at fire time. A successful mutation lazily constructs the overlay,
// so driving session_start and tool_execution_end makes the toggle path reachable.
function setup() {
	__resetState();
	const { pi, captured } = createMockPi();
	registerTodo(pi, undefined, { homeDir: TEST_HOME });
	const sessionStart = captured.events.get("session_start")?.[0];
	const toolEnd = captured.events.get("tool_execution_end")?.[0] as
		| ((event: { toolName: string; isError: boolean }) => Promise<void>)
		| undefined;
	const tool = captured.tools.get("todo");
	if (!sessionStart) throw new Error("session_start handler not registered");
	if (!toolEnd) throw new Error("tool_execution_end handler not registered");
	if (!tool) throw new Error("todo tool not registered");
	return { captured, sessionStart, toolEnd, tool };
}

beforeEach(() => {
	__resetState();
	removeConfigFile();
});
afterEach(() => {
	__resetState();
	removeConfigFile();
});

describe("rpiv-todo — collapse/expand shortcut registration", () => {
	it("registers 'ctrl+shift+t' with a description at factory scope", () => {
		const { captured } = setup();
		const shortcut = captured.shortcuts.get("ctrl+shift+t");
		expect(shortcut).toBeDefined();
		expect(typeof shortcut?.description).toBe("string");
		expect(shortcut?.description).toContain("Collapse");
	});

	it("handler is a no-op in headless mode (!ctx.hasUI)", async () => {
		const { captured, sessionStart, toolEnd, tool } = setup();
		const ctx = createMockCtx({ sessionId: "s1", hasUI: true });
		await sessionStart?.({} as never, ctx as never);
		// Seed a task and pump tool_execution_end so the widget registers.
		await tool.execute?.(
			"tc",
			{ action: "create", subject: "a" } as never,
			undefined as never,
			undefined as never,
			ctx as never,
		);
		await toolEnd?.({ toolName: "todo", isError: false });

		const handler = captured.shortcuts.get("ctrl+shift+t")?.handler;
		expect(handler).toBeDefined();
		// Headless ctx: handler bails before touching the overlay — must not throw.
		await handler?.({ hasUI: false } as never);
		// The overlay (foreground) widget was registered exactly once — no toggle.
		expect(ctx.ui.setWidget as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
	});

	it("handler is a no-op before any session_start created the overlay (!todoOverlay)", async () => {
		const { captured } = setup();
		// No session_start fired yet → closure-local todoOverlay is undefined.
		const ctx = createMockCtx({ sessionId: "s1", hasUI: true });
		await captured.shortcuts.get("ctrl+shift+t")?.handler?.(ctx as never);
		expect(ctx.ui.setWidget as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
	});

	it("handler is a no-op when an empty session has not loaded the overlay", async () => {
		const { captured, sessionStart } = setup();
		// A UI-bearing empty session records the foreground binding without loading
		// or registering the overlay.
		const ctx = createMockCtx({ sessionId: "s1", hasUI: true });
		await sessionStart?.({} as never, ctx as never);
		expect(ctx.ui.setWidget as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();

		await captured.shortcuts.get("ctrl+shift+t")?.handler?.(ctx as never);
		// Still unloaded and unregistered — toggle never fired.
		expect(ctx.ui.setWidget as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
	});

	it("handler toggles the overlay when it is registered", async () => {
		const { captured, sessionStart, toolEnd, tool } = setup();
		const ctx = createMockCtx({ sessionId: "s1", hasUI: true });
		await sessionStart?.({} as never, ctx as never);
		await tool.execute?.(
			"tc",
			{ action: "create", subject: "a" } as never,
			undefined as never,
			undefined as never,
			ctx as never,
		);
		await toolEnd?.({ toolName: "todo", isError: false });

		const setWidget = ctx.ui.setWidget as ReturnType<typeof vi.fn>;
		const factory = setWidget.mock.calls[0][1] as (
			tui: { requestRender: (...args: unknown[]) => void },
			theme: { fg: (c: string, s: string) => string },
		) => { render: (w: number) => string[]; invalidate: () => void };
		const requestRender = vi.fn();
		const identityTheme = { fg: (_c: string, s: string) => s } as unknown as {
			fg: (c: string, s: string) => string;
		};
		const widget = factory({ requestRender }, identityTheme);

		const expanded = widget.render(200);
		expect(expanded).toHaveLength(3);
		expect(expanded[0]).toContain("▾");

		// Toggle -> collapses; forced redraw on the height step.
		await captured.shortcuts.get("ctrl+shift+t")?.handler?.(ctx as never);
		expect(requestRender).toHaveBeenCalledWith(true);
		const collapsed = widget.render(200);
		expect(collapsed).toHaveLength(2);
		expect(collapsed[0]).toContain("▸");

		// Toggle again -> re-expands.
		await captured.shortcuts.get("ctrl+shift+t")?.handler?.(ctx as never);
		expect(widget.render(200)[0]).toContain("▾");
	});
});

describe("rpiv-todo — collapse/expand shortcut config resolution", () => {
	// resolveCollapseKey() runs inside registerTodo() at factory scope, reading the
	// config file fresh from disk — so the config MUST be written before setup().

	it("registers the configured key (collapseKey: 'alt+o') instead of the default", () => {
		writeConfigFile(JSON.stringify({ collapseKey: "alt+o" }));
		const { captured } = setup();
		expect(captured.shortcuts.has("alt+o")).toBe(true);
		expect(captured.shortcuts.has("ctrl+shift+t")).toBe(false);
	});

	it("skips registerShortcut entirely when collapseKey is 'off'", () => {
		writeConfigFile(JSON.stringify({ collapseKey: "off" }));
		const { captured } = setup();
		expect(captured.shortcuts.size).toBe(0);
	});

	it("falls back to the default key when collapseKey is invalid", () => {
		writeConfigFile(JSON.stringify({ collapseKey: "ctr+t" }));
		const { captured } = setup();
		expect(captured.shortcuts.has("ctrl+shift+t")).toBe(true);
	});

	it("default config registers the default key (ctrl+shift+t)", () => {
		const { captured } = setup();
		expect(captured.shortcuts.has("ctrl+shift+t")).toBe(true);
	});
});

describe("rpiv-todo — collapsed on resume", () => {
	it("stays expanded on resume when collapseOnResume is false", async () => {
		writeConfigFile(JSON.stringify({ collapseOnResume: false }));
		const { sessionStart } = setup();
		const branch = buildSessionEntries([
			makeTodoToolResult({
				action: "create",
				params: { subject: "kept" },
				tasks: [{ id: 1, subject: "kept", status: "pending" }],
				nextId: 2,
			}),
		]);
		const ctx = createMockCtx({ branch, hasUI: true, sessionId: "s-off" });
		await sessionStart({ reason: "resume" } as never, ctx as never);
		const factory = (ctx.ui.setWidget as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
		const widget = factory({ requestRender: () => {} }, makeTheme());
		expect(widget.render(200)[0]).toContain("▾");
	});

	it.each([
		["resume", true],
		["startup", false],
		["reload", false],
	] as const)("session_start reason %s renders the panel collapsed: %s", async (reason, collapsed) => {
		const { sessionStart } = setup();
		const branch = buildSessionEntries([
			makeTodoToolResult({
				action: "create",
				params: { subject: "kept" },
				tasks: [{ id: 1, subject: "kept", status: "pending" }],
				nextId: 2,
			}),
		]);
		const ctx = createMockCtx({ branch, hasUI: true, sessionId: `s-${reason}` });
		await sessionStart({ reason } as never, ctx as never);
		const setWidget = ctx.ui.setWidget as ReturnType<typeof vi.fn>;
		const factory = setWidget.mock.calls[0]?.[1] as (
			tui: { requestRender: () => void },
			theme: unknown,
		) => { render: (w: number) => string[] };
		const widget = factory({ requestRender: () => {} }, makeTheme());
		expect(widget.render(200)[0]).toContain(collapsed ? "▸" : "▾");
	});
});
