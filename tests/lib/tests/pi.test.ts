import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createRecordingContext, createRecordingPi } from "../src/pi.ts";

const tool = (name: string, extra: object = {}) => ({ name, parameters: {}, ...extra }) as unknown as ToolDefinition;

describe("createRecordingPi", () => {
	it("records a handler registered twice for one event, in order", async () => {
		const rec = createRecordingPi();
		const order: string[] = [];
		rec.pi.on("session_start", () => void order.push("a"));
		rec.pi.on("session_start", () => void order.push("b"));
		expect(rec.handlers.get("session_start")).toHaveLength(2);
		await rec.dispatch("session_start", {}, createRecordingContext().ctx);
		expect(order).toEqual(["a", "b"]);
	});

	it("unsubscribes only the registration it returned for, even for a repeated callback", async () => {
		const rec = createRecordingPi();
		const ctx = createRecordingContext().ctx;
		const shared = vi.fn();
		const other = vi.fn();
		const first = rec.pi.on("turn_end", shared);
		rec.pi.on("turn_end", shared);
		rec.pi.on("turn_end", other);
		first();
		first();
		await rec.dispatch("turn_end", {}, ctx);
		expect(shared).toHaveBeenCalledTimes(1);
		expect(other).toHaveBeenCalledTimes(1);
		expect(rec.handlers.get("turn_end")).toHaveLength(2);
	});

	it("keeps a repeated bus callback registered once per subscription", () => {
		const rec = createRecordingPi();
		const seen = vi.fn();
		const first = rec.pi.events.on("c", seen);
		rec.pi.events.on("c", seen);
		first();
		first();
		rec.pi.events.emit("c", 1);
		expect(seen).toHaveBeenCalledTimes(1);
		expect(rec.bus.listenerCount()).toBe(1);
	});

	it("drops the event key when its last handler unsubscribes", () => {
		const rec = createRecordingPi();
		rec.pi.on("turn_end", () => undefined)();
		expect(rec.handlers.has("turn_end")).toBe(false);
	});

	it("lets a duplicate tool name replace the earlier tool, as the loader does", () => {
		const rec = createRecordingPi();
		const first = tool("t");
		const second = tool("t");
		rec.pi.registerTool(first);
		rec.pi.registerTool(second);
		expect(rec.tools.size).toBe(1);
		expect(rec.tools.get("t")).toBe(second);
		expect(rec.activeTools).toEqual(["t"]);
	});

	it("activates tools unless hidden or autoActivate is off", () => {
		const rec = createRecordingPi({ activeTools: ["read"] });
		rec.pi.registerTool(tool("a"));
		rec.pi.registerTool(tool("h", { exposure: "hidden" }));
		expect(rec.pi.getActiveTools()).toEqual(["read", "a"]);
		rec.pi.setActiveTools(["read", "h", "a"]);
		expect(rec.activeTools).toEqual(["read", "a"]);
		const manual = createRecordingPi({ autoActivate: false, activeTools: ["h"] });
		manual.pi.registerTool(tool("a"));
		expect(manual.activeTools).toEqual(["h"]);
		manual.pi.registerTool(tool("h", { exposure: "hidden" }));
		expect(manual.activeTools).toEqual([]);
	});

	it("returns a flag only once registered: seeded value, then default", () => {
		const rec = createRecordingPi({ flags: { seeded: "cli" } });
		expect(rec.pi.getFlag("seeded")).toBeUndefined();
		rec.pi.registerFlag("seeded", { type: "string", default: "d" });
		rec.pi.registerFlag("plain", { type: "boolean", default: true });
		expect(rec.pi.getFlag("seeded")).toBe("cli");
		expect(rec.pi.getFlag("plain")).toBe(true);
		expect([...rec.flags.keys()]).toEqual(["seeded", "plain"]);
	});

	it("records commands, shortcuts, renderers, entries and messages", () => {
		const rec = createRecordingPi({ sessionName: "n" });
		const handler = async () => {};
		rec.pi.registerCommand("c", { handler });
		rec.pi.registerShortcut("ctrl+x", { handler });
		rec.pi.registerMessageRenderer("m", (() => undefined) as never);
		rec.pi.registerEntryRenderer("e", (() => undefined) as never);
		rec.pi.appendEntry("custom", { n: 1 });
		rec.pi.sendMessage({ customType: "x", content: "c", display: true });
		rec.pi.sendUserMessage("hi", { deliverAs: "steer" });
		expect(rec.commands.get("c")?.handler).toBe(handler);
		expect(rec.shortcuts.has("ctrl+x")).toBe(true);
		expect(rec.messageRenderers.has("m")).toBe(true);
		expect(rec.entryRenderers.has("e")).toBe(true);
		expect(rec.entries).toEqual([{ customType: "custom", data: { n: 1 } }]);
		expect(rec.sentMessages).toHaveLength(1);
		expect(rec.sentUserMessages).toEqual([{ content: "hi", options: { deliverAs: "steer" } }]);
		expect(rec.pi.getSessionName()).toBe("n");
		rec.pi.setSessionName("m2");
		expect(rec.sessionName).toBe("m2");
	});

	it("merges provider registrations and records unregistration", () => {
		const rec = createRecordingPi();
		rec.pi.registerProvider("p", { baseUrl: "a", api: "x" } as never);
		rec.pi.registerProvider("p", { baseUrl: "b" } as never);
		expect(rec.providers.get("p")).toEqual({ baseUrl: "b", api: "x" });
		expect(rec.providerRegistrations).toHaveLength(2);
		rec.pi.unregisterProvider("p");
		expect(rec.providers.has("p")).toBe(false);
		expect(rec.providerUnregistrations).toEqual(["p"]);
	});

	it("tracks thinking level with clamping, and models", async () => {
		const rec = createRecordingPi({ clampThinkingLevel: () => "low" });
		rec.pi.setThinkingLevel("high");
		expect(rec.thinkingLevel).toBe("low");
		expect(rec.thinkingLevels).toEqual(["low"]);
		expect(await rec.pi.setModel({ id: "m" } as never)).toBe(true);
		expect(rec.setModels).toHaveLength(1);
	});

	it("surfaces skills and commands from getCommands, all tools from allTools", () => {
		const rec = createRecordingPi({ skills: ["s"], allTools: [{ name: "a" } as never] });
		expect(rec.pi.getCommands().map((c) => c.name)).toEqual(["skill:s"]);
		rec.allTools.push({ name: "b" } as never);
		expect(rec.pi.getAllTools().map((t) => t.name)).toEqual(["a", "b"]);
	});

	it("runs exec with the seeded result and honours overrides", async () => {
		const rec = createRecordingPi({ overrides: { getSettings: (() => ({ x: 1 })) as ExtensionAPI["getSettings"] } });
		expect(await rec.pi.exec("a", [])).toEqual({ stdout: "", stderr: "", code: 0, killed: false });
		expect(rec.pi.getSettings()).toEqual({ x: 1 });
	});

	describe("event bus", () => {
		it("delivers to subscribers, logs payloads, isolates failing observers", async () => {
			const rec = createRecordingPi();
			const seen = vi.fn();
			rec.pi.events.on("c", () => {
				throw new Error("boom");
			});
			rec.pi.events.on("c", async () => {
				throw new Error("async boom");
			});
			const off = rec.pi.events.on("c", seen);
			rec.pi.events.emit("c", 1);
			expect(seen).toHaveBeenCalledWith(1);
			expect(rec.bus.emitted.get("c")).toEqual([1]);
			expect(rec.bus.listenerCount()).toBe(3);
			off();
			rec.pi.events.emit("c", 2);
			expect(seen).toHaveBeenCalledTimes(1);
			rec.bus.clear();
			expect(rec.bus.listenerCount()).toBe(0);
		});
	});

	it("records emits without delivering them when deliverEvents is off", () => {
		const rec = createRecordingPi({ deliverEvents: false });
		const seen = vi.fn();
		rec.pi.events.on("c", seen);
		rec.pi.events.emit("c", 1);
		expect(seen).not.toHaveBeenCalled();
		expect(rec.bus.emitted.get("c")).toEqual([1]);
		expect(rec.bus.subscribers.get("c")).toHaveLength(1);
	});

	it("tolerates a repeated unsubscribe, an unheard emit and an event with no handlers", async () => {
		const rec = createRecordingPi();
		const off = rec.pi.on("turn_end", () => undefined);
		off();
		off();
		const stop = rec.pi.events.on("c", () => undefined);
		stop();
		stop();
		const cleared = rec.pi.events.on("c", () => undefined);
		rec.bus.clear();
		cleared();
		rec.pi.events.emit("nobody", 1);
		expect(await rec.dispatch("none", {}, createRecordingContext().ctx)).toEqual([]);
	});

	it("reports defaults for settings, thinking level and unclamped levels", () => {
		const rec = createRecordingPi();
		expect(rec.pi.getSettings()).toEqual({});
		expect(rec.pi.getThinkingLevel()).toBe("off");
		rec.pi.setThinkingLevel("high");
		expect(rec.pi.getThinkingLevel()).toBe("high");
		expect(createRecordingPi({ settings: { a: 1 } as never }).pi.getSettings()).toEqual({ a: 1 });
	});

	it("directly sets the active tools", () => {
		const rec = createRecordingPi();
		rec.setActive(["x"]);
		expect(rec.pi.getActiveTools()).toEqual(["x"]);
	});
});

describe("createRecordingContext", () => {
	it("defaults to a headless context", () => {
		const { ctx } = createRecordingContext({ cwd: "/w" });
		expect(ctx).toMatchObject({ cwd: "/w", hasUI: false, mode: "print" });
		expect(ctx.isIdle()).toBe(true);
		expect(ctx.hasPendingMessages()).toBe(false);
		expect(ctx.isProjectTrusted()).toBe(false);
		expect(ctx.getSystemPrompt()).toBe("parent");
		expect(ctx.sessionManager.getSessionId()).toBe("test-session");
		expect(ctx.sessionManager.getSessionName()).toBeUndefined();
		expect(ctx.sessionManager.getLeafId()).toBeNull();
	});

	it("derives mode and hasUI from each other", () => {
		expect(createRecordingContext({ hasUI: true }).ctx.mode).toBe("tui");
		expect(createRecordingContext({ mode: "rpc" }).ctx.hasUI).toBe(true);
	});

	it("records UI traffic and editor state", async () => {
		const rec = createRecordingContext({ editorText: "a", sessionName: "n", sessionId: "s" });
		rec.ctx.ui.notify("m", "warning");
		rec.ctx.ui.setStatus("k", "v");
		rec.ctx.ui.setStatus("k", undefined);
		rec.ctx.ui.setWidget("w", ["x"]);
		rec.ctx.ui.setFooter(undefined);
		rec.ctx.ui.pasteToEditor("b");
		rec.ctx.ui.setEditorText("c");
		expect(rec.notifications).toEqual([{ message: "m", level: "warning" }]);
		expect(rec.statuses.get("k")).toBeUndefined();
		expect(rec.statuses.has("k")).toBe(true);
		expect(rec.widgets.get("w")).toEqual(["x"]);
		expect(rec.pastedEditorTexts).toEqual(["b"]);
		expect(rec.editorText).toBe("c");
		expect(rec.footer).toBeUndefined();
		expect(rec.ctx.sessionManager.getSessionId()).toBe("s");
		expect(rec.ctx.sessionManager.getSessionName()).toBe("n");
		expect(await rec.ctx.ui.confirm("t", "m")).toBe(true);
		expect(await rec.ctx.ui.select("t", [])).toBeUndefined();
	});

	it("stubs the remaining UI and context members", async () => {
		const { ctx } = createRecordingContext({ trusted: true, systemPrompt: "sp", pending: true });
		expect(ctx.ui.theme.fg("accent" as never, "t")).toBe("t");
		expect(ctx.ui.onTerminalInput(() => undefined)()).toBeUndefined();
		expect(ctx.ui.getEditorText()).toBe("");
		expect(await ctx.ui.input("t")).toBeUndefined();
		expect(await ctx.ui.editor("t")).toBeUndefined();
		expect(await ctx.ui.custom(() => ({}) as never)).toBeUndefined();
		expect(ctx.sessionManager.getSessionFile()).toBe("/tmp/test-session.jsonl");
		expect(ctx.modelRegistry.getAll()).toEqual([]);
		expect(await ctx.modelRegistry.getApiKeyAndHeaders({} as never)).toMatchObject({ ok: true });
		expect(ctx.modelRegistry.isUsingOAuth({} as never)).toBe(false);
		expect(ctx.isProjectTrusted()).toBe(true);
		expect(ctx.getSystemPrompt()).toBe("sp");
		expect(ctx.hasPendingMessages()).toBe(true);
		expect(ctx.getContextUsage()).toBeUndefined();
		const commandCtx = ctx;
		await commandCtx.waitForIdle();
		await commandCtx.reload();
		expect((ctx as { newSession?: unknown }).newSession).toBeUndefined();
		for (const call of [
			() => ctx.ui.setWorkingMessage("w"),
			() => ctx.ui.setHiddenThinkingLabel("h"),
			() => ctx.ui.addAutocompleteProvider(() => ({}) as never),
			() => ctx.ui.setEditorComponent(undefined),
			() => ctx.abort(),
			() => ctx.shutdown(),
			() => ctx.compact(),
		]) {
			expect(call).not.toThrow();
		}
	});

	it("serves branch, models and idle state, and takes overrides", () => {
		const model = { provider: "p", id: "m" } as never;
		const rec = createRecordingContext({
			branch: [{ id: "e1" } as never],
			models: [model],
			ui: { confirm: async () => false },
			overrides: { cwd: "/o" },
		});
		expect(rec.ctx.sessionManager.getLeafId()).toBe("e1");
		expect(rec.ctx.sessionManager.getBranch()).toHaveLength(1);
		expect(rec.ctx.sessionManager.getEntries()).toHaveLength(1);
		expect(rec.ctx.modelRegistry.find("p", "m")).toBe(model);
		expect(rec.ctx.modelRegistry.getAvailable()).toEqual([model]);
		expect(rec.ctx.cwd).toBe("/o");
		rec.setIdle(false);
		rec.setPending(true);
		expect(rec.ctx.isIdle()).toBe(false);
		expect(rec.ctx.hasPendingMessages()).toBe(true);
	});
});
