import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../../src/config.ts";
import { MESSAGE_TYPE, register, TOOL_NAMES } from "../../src/monitor/index.ts";
import { psInfo, rootDir, writePidfile } from "../../src/monitor/pidfiles.ts";
import { alive, cleanupProcs, deadPid, spawnSleeper, tempDir, waitFor } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: a fake pi only needs the surface the extension touches
type Any = any;

function fakePi(sessionName?: string) {
	const handlers = new Map<string, Any[]>();
	const tools = new Map<string, Any>();
	const commands = new Map<string, Any>();
	const shortcuts = new Map<string, Any>();
	const sendMessage = vi.fn();
	let active = ["read", ...TOOL_NAMES];
	const entries: Any[] = [];
	const pi = {
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		on: (e: string, h: Any) => handlers.set(e, [...(handlers.get(e) ?? []), h]),
		registerTool: (t: Any) => {
			tools.set(t.name, t);
			if (t.exposure === "hidden") active = active.filter((name) => name !== t.name);
		},
		registerCommand: (n: string, c: Any) => commands.set(n, c),
		registerShortcut: (key: string, s: Any) => shortcuts.set(key, s),
		sendMessage,
		getSessionName: () => sessionName,
		getActiveTools: () => active,
		setActiveTools: (n: string[]) => {
			active = n;
		},
	};
	const emit = async (e: string, ctx: Any, event: Any = { type: e }) => {
		for (const h of handlers.get(e) ?? []) await h(event, ctx);
	};
	return { pi: pi as Any, tools, commands, shortcuts, sendMessage, emit, entries, active: () => active };
}

function fakeCtx(mode = "tui", sessionId = "sess-A", entries: Any[] = []) {
	return {
		mode,
		cwd: process.cwd(),
		sessionManager: { getSessionId: () => sessionId, getBranch: () => entries },
		ui: { notify: vi.fn(), setWidget: vi.fn() },
	};
}

const STAY = "setInterval(() => {}, 1000);";
let tmp: ReturnType<typeof tempDir>;
let savedTmp: string | undefined;

beforeEach(() => {
	tmp = tempDir();
	savedTmp = process.env.TMPDIR;
	process.env.TMPDIR = tmp.dir;
});
afterEach(() => {
	if (savedTmp === undefined) delete process.env.TMPDIR;
	else process.env.TMPDIR = savedTmp;
	cleanupProcs();
	tmp.cleanup();
});

describe("monitor extension", () => {
	it("annotates ONLY monitor_read as read-only", () => {
		const f = fakePi();
		register(f.pi, defaultConfig());
		expect([...f.tools.keys()].sort()).toEqual([...TOOL_NAMES].sort());
		expect(f.tools.get("monitor_read").annotations.readOnlyHint).toBe(true);
		expect(f.tools.get("monitor_start").annotations.readOnlyHint).toBe(false);
		expect(f.tools.get("monitor_stop").annotations.readOnlyHint).toBe(false);
	});

	it("runs start -> read -> stop through the tools and delivers messages with the right wake options", async () => {
		const f = fakePi();
		register(f.pi, defaultConfig());
		const ctx = fakeCtx();
		await f.emit("session_start", ctx);
		const start = await f.tools
			.get("monitor_start")
			.execute(
				"1",
				{ argv: ["node", "-e", `console.log("ERROR boom");${STAY}`], name: "w", match: "ERROR" },
				undefined,
				undefined,
				ctx,
			);
		expect(start.isError).toBe(false);
		expect(start.content[0].text).toMatch(/started m1 "w"/);
		expect(ctx.ui.setWidget).toHaveBeenCalledWith("session-kit:monitors", expect.any(Function), {
			placement: "aboveEditor",
		});

		await waitFor(() => f.sendMessage.mock.calls.length === 1, 6000);
		const [msg, opts] = f.sendMessage.mock.calls[0] as [Any, Any];
		expect(msg).toMatchObject({ customType: MESSAGE_TYPE, display: true });
		expect(msg.content).toContain("1: ERROR boom");
		expect(opts).toEqual({ triggerTurn: true, deliverAs: "followUp" });

		const read = await f.tools.get("monitor_read").execute("2", { id: "w", since: 0 }, undefined, undefined, ctx);
		expect(read.content[0].text).toContain("1: ERROR boom");
		expect(read.content[0].text).toContain("next since: 1");
		const again = await f.tools.get("monitor_read").execute("3", { id: "m1", since: 1 }, undefined, undefined, ctx);
		expect(again.content[0].text).toContain("(no new output)");

		const stop = await f.tools.get("monitor_stop").execute("4", { id: "m1" }, undefined, undefined, ctx);
		expect(stop.content[0].text).toContain("stopped");
		expect(ctx.ui.setWidget).toHaveBeenLastCalledWith("session-kit:monitors", undefined);
	});

	it("binds the configured collapse shortcut and toggles only a visible widget", async () => {
		const f = fakePi();
		const config = defaultConfig();
		config.monitor.collapseKey = "alt+m";
		register(f.pi, config);
		expect([...f.shortcuts.keys()]).toEqual(["alt+m"]);
		const ctx = fakeCtx();
		await f.emit("session_start", ctx);
		const handler = f.shortcuts.get("alt+m").handler;
		await handler({ hasUI: true });
		expect(ctx.ui.setWidget).not.toHaveBeenCalled();
		await f.tools
			.get("monitor_start")
			.execute("1", { argv: ["node", "-e", STAY], name: "w" }, undefined, undefined, ctx);
		const requestRender = vi.fn();
		const factory = ctx.ui.setWidget.mock.calls[0]?.[1];
		const component = factory({ requestRender }, { fg: (_c: string, t: string) => t });
		expect(component.render(80)).toHaveLength(3);
		await handler({ hasUI: false });
		expect(component.render(80)).toHaveLength(3);
		await handler({ hasUI: true });
		expect(requestRender).toHaveBeenLastCalledWith(true);
		expect(component.render(80)).toHaveLength(2);
		await f.tools.get("monitor_stop").execute("2", { id: "w" }, undefined, undefined, ctx);
	});

	it("registers no shortcut when collapseKey is off", () => {
		const f = fakePi();
		const config = defaultConfig();
		config.monitor.collapseKey = "off";
		register(f.pi, config);
		expect(f.shortcuts.size).toBe(0);
	});

	it("keeps passive output out of custom messages", async () => {
		const f = fakePi();
		register(f.pi, defaultConfig());
		const ctx = fakeCtx();
		await f.emit("session_start", ctx);
		await f.tools
			.get("monitor_start")
			.execute("1", { argv: ["node", "-e", `console.log("hi");${STAY}`], name: "w" }, undefined, undefined, ctx);
		await waitFor(async () => {
			const read = await f.tools.get("monitor_read").execute("2", { id: "w" }, undefined, undefined, ctx);
			return read.content[0].text.includes("1: hi");
		}, 6000);
		expect(f.sendMessage).not.toHaveBeenCalled();
		await f.emit("session_shutdown", ctx);
	});

	it("returns isError results for bad input and unknown ids instead of throwing", async () => {
		const f = fakePi();
		register(f.pi, defaultConfig());
		const ctx = fakeCtx();
		await f.emit("session_start", ctx);
		const bad = await f.tools.get("monitor_start").execute("1", { argv: [""], name: "w" }, undefined, undefined, ctx);
		expect(bad).toMatchObject({ isError: true });
		const missing = await f.tools.get("monitor_read").execute("1", { id: "zzz" }, undefined, undefined, ctx);
		expect(missing).toMatchObject({ isError: true });
		const stop = await f.tools.get("monitor_stop").execute("1", { id: "zzz" }, undefined, undefined, ctx);
		expect(stop).toMatchObject({ isError: true });
	});

	it("/monitor lists and stops", async () => {
		const f = fakePi();
		register(f.pi, defaultConfig());
		const ctx = fakeCtx();
		await f.emit("session_start", ctx);
		const cmd = f.commands.get("monitor");
		await cmd.handler("", ctx);
		expect(ctx.ui.notify).toHaveBeenLastCalledWith("no monitors", "info");
		await f.tools
			.get("monitor_start")
			.execute("1", { argv: ["node", "-e", STAY], name: "w" }, undefined, undefined, ctx);
		await cmd.handler("list", ctx);
		expect(ctx.ui.notify.mock.calls.at(-1)?.[0]).toMatch(/m1 "w" running/);
		expect(cmd.getArgumentCompletions("st").map((c: Any) => c.value)).toEqual(["stop all", "stop m1"]);
		await cmd.handler("stop nope", ctx);
		expect(ctx.ui.notify).toHaveBeenLastCalledWith('no monitor "nope"', "error");
		await cmd.handler("stop all", ctx);
		expect(ctx.ui.notify).toHaveBeenLastCalledWith("stopped m1", "info");
		await cmd.handler("bogus", ctx);
		expect(ctx.ui.notify.mock.calls.at(-1)?.[1]).toBe("warning");
	});

	it("kills every child on session_shutdown, whatever the reason", async () => {
		for (const reason of ["quit", "reload", "new", "resume", "fork"]) {
			const f = fakePi();
			register(f.pi, defaultConfig());
			const ctx = fakeCtx();
			await f.emit("session_start", ctx);
			const r = await f.tools
				.get("monitor_start")
				.execute("1", { argv: ["node", "-e", STAY], name: "w" }, undefined, undefined, ctx);
			const pid = r.details.pid as number;
			await f.emit("session_shutdown", ctx, { type: "session_shutdown", reason });
			await waitFor(() => !alive(pid));
		}
	});

	it("is inert in child sessions: tools hidden, nothing spawned", async () => {
		const f = fakePi("general-purpose#0123abcd");
		register(f.pi, defaultConfig());
		const ctx = fakeCtx();
		await f.emit("session_start", ctx);
		expect(f.active()).toEqual(["read"]);
		await expect(
			f.tools.get("monitor_start").execute("1", { argv: ["node", "-e", STAY], name: "w" }, undefined, undefined, ctx),
		).rejects.toThrow("monitor_start is not available in subagents");
		await f.commands.get("monitor").handler("", ctx);
		expect(ctx.ui.notify.mock.calls.at(-1)?.[1]).toBe("warning");
	});

	it("shows no widget outside the TUI", async () => {
		const f = fakePi();
		register(f.pi, defaultConfig());
		const ctx = fakeCtx("print");
		await f.emit("session_start", ctx);
		await f.tools
			.get("monitor_start")
			.execute("1", { argv: ["node", "-e", STAY], name: "w" }, undefined, undefined, ctx);
		expect(ctx.ui.setWidget).not.toHaveBeenCalled();
		await f.emit("session_shutdown", ctx);
	});

	it("sweeps a dead owner's orphan at session_start and leaves a live owner's alone", async () => {
		const dead = await spawnSleeper();
		const live = await spawnSleeper();
		const root = rootDir();
		writePidfile(join(root, "dead-sess"), "m1", {
			ownerPid: await deadPid(),
			childPid: dead.pid,
			pgid: dead.pid,
			startedAt: dead.startedAt,
			name: "o",
			command: (await psInfo(dead.pid))?.command ?? "",
		});
		writePidfile(join(root, "live-sess"), "m1", {
			ownerPid: process.pid,
			childPid: live.pid,
			pgid: live.pid,
			startedAt: live.startedAt,
			name: "l",
			command: (await psInfo(live.pid))?.command ?? "",
		});
		const f = fakePi();
		register(f.pi, defaultConfig());
		await f.emit("session_start", fakeCtx());
		await waitFor(() => !alive(dead.pid));
		expect(alive(live.pid)).toBe(true);
		await f.emit("session_shutdown", fakeCtx());
	});
});
