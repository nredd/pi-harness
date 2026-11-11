import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../../src/config.ts";
import {
	MESSAGE_TYPE,
	MONITOR_STARTED_EVENT,
	MONITOR_STOPPED_EVENT,
	register,
	TOOL_NAMES,
} from "../../src/monitor/index.ts";
import { psInfo, rootDir, writePidfile } from "../../src/monitor/pidfiles.ts";
import { ControlledProcesses, FakeClock } from "../scenarios/support.ts";
import { alive, cleanupProcs, deadPid, spawnSleeper, tempDir, waitFor } from "./helpers.ts";
import { STAY } from "./stay.ts";

const shutdowns: (() => Promise<void>)[] = [];

// biome-ignore lint/suspicious/noExplicitAny: a fake pi only needs the surface the extension touches
type Any = any;

function fakePi(sessionName?: string) {
	const handlers = new Map<string, Any[]>();
	const tools = new Map<string, Any>();
	const commands = new Map<string, Any>();
	const shortcuts = new Map<string, Any>();
	const sendMessage = vi.fn();
	const emitted: Array<[string, Any]> = [];
	let active = ["read", ...TOOL_NAMES];
	const entries: Any[] = [];
	const pi = {
		events: { emit: (channel: string, data: unknown) => emitted.push([channel, data]) },
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
	shutdowns.push(() => emit("session_shutdown", fakeCtx()));
	return { pi: pi as Any, tools, commands, shortcuts, sendMessage, emit, emitted, entries, active: () => active };
}

function fakeCtx(mode = "tui", sessionId = "sess-A", entries: Any[] = []) {
	return {
		mode,
		cwd: process.cwd(),
		sessionManager: { getSessionId: () => sessionId, getBranch: () => entries },
		ui: { notify: vi.fn(), setWidget: vi.fn() },
	};
}

let tmp: ReturnType<typeof tempDir>;
let savedTmp: string | undefined;

beforeEach(() => {
	tmp = tempDir();
	savedTmp = process.env.TMPDIR;
	process.env.TMPDIR = tmp.dir;
});
afterEach(async () => {
	try {
		await Promise.all(shutdowns.splice(0).map((shutdown) => shutdown()));
	} finally {
		if (savedTmp === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = savedTmp;
		cleanupProcs();
		tmp.cleanup();
	}
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

	it("reports running monitors and what wakes the parent when a run settles, and nothing once they stop", async () => {
		const f = fakePi();
		register(f.pi, defaultConfig());
		const ctx = fakeCtx();
		await f.emit("session_start", ctx);
		await f.emit("agent_settled", ctx);
		expect(ctx.ui.notify).not.toHaveBeenCalled();

		const start = (name: string, extra: Record<string, unknown> = {}) =>
			f.tools
				.get("monitor_start")
				.execute("1", { argv: ["node", "-e", STAY], name, ...extra }, undefined, undefined, ctx);
		expect((await start("ci", { match: "PASS|FAIL" })).isError).toBe(false);
		expect((await start("log")).isError).toBe(false);
		await f.emit("agent_settled", ctx);
		expect(ctx.ui.notify.mock.calls).toEqual([
			['Run ended with 2 monitors running, armed: m1 "ci" on /PASS|FAIL/ or exit, m2 "log" on exit', "info"],
		]);

		await f.commands.get("monitor").handler("stop all", ctx);
		ctx.ui.notify.mockClear();
		await f.emit("agent_settled", ctx);
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});

	it("announces each monitor once on pi.events as it starts and stops", async () => {
		const f = fakePi();
		register(f.pi, defaultConfig());
		const ctx = fakeCtx("tui", "sess-E");
		await f.emit("session_start", ctx);
		expect(f.emitted).toEqual([]);
		const start = (name: string) =>
			f.tools.get("monitor_start").execute("1", { argv: ["node", "-e", STAY], name }, undefined, undefined, ctx);
		await start("ci");
		await start("log");
		expect(f.emitted).toEqual([
			[MONITOR_STARTED_EVENT, { sessionId: "sess-E", id: "m1", name: "ci", wake: false }],
			[MONITOR_STARTED_EVENT, { sessionId: "sess-E", id: "m2", name: "log", wake: false }],
		]);
		f.emitted.length = 0;
		await f.tools.get("monitor_stop").execute("2", { id: "m1" }, undefined, undefined, ctx);
		expect(f.emitted).toEqual([[MONITOR_STOPPED_EVENT, { sessionId: "sess-E", id: "m1", name: "ci", wake: false }]]);
		// Shutdown kills the rest silently, so it must announce them itself, once.
		f.emitted.length = 0;
		await f.emit("session_shutdown", ctx, { type: "session_shutdown", reason: "quit" });
		expect(f.emitted).toEqual([[MONITOR_STOPPED_EVENT, { sessionId: "sess-E", id: "m2", name: "log", wake: false }]]);
	});

	it("carries the wake condition and linked todo on both lifecycle events", async () => {
		const f = fakePi();
		register(f.pi, defaultConfig());
		const ctx = fakeCtx("tui", "sess-L");
		await f.emit("session_start", ctx);
		const run = (params: object) =>
			f.tools.get("monitor_start").execute("1", { argv: ["node", "-e", STAY], ...params }, undefined, undefined, ctx);
		expect((await run({ name: "ci", match: "PASS|FAIL", todo: 3 })).isError).toBe(false);
		expect((await run({ name: "poll", wake: true, todo: [4, 5, 4] })).isError).toBe(false);
		const ci = { sessionId: "sess-L", id: "m1", name: "ci", wake: false, match: "PASS|FAIL", todos: [3] };
		expect(f.emitted).toEqual([
			[MONITOR_STARTED_EVENT, ci],
			[MONITOR_STARTED_EVENT, { sessionId: "sess-L", id: "m2", name: "poll", wake: true, todos: [4, 5] }],
		]);
		f.emitted.length = 0;
		await f.tools.get("monitor_stop").execute("2", { id: "m1" }, undefined, undefined, ctx);
		expect(f.emitted).toEqual([[MONITOR_STOPPED_EVENT, ci]]);
	});

	it("rejects a todo link that is not a positive integer id", async () => {
		const f = fakePi();
		register(f.pi, defaultConfig());
		const ctx = fakeCtx("tui", "sess-V");
		await f.emit("session_start", ctx);
		const run = await f.tools
			.get("monitor_start")
			.execute("1", { argv: ["node", "-e", STAY], name: "bad", todo: 0 }, undefined, undefined, ctx);
		expect(run.isError).toBe(true);
		expect(f.emitted).toEqual([]);
	});

	it("reports nothing at settle in a child session", async () => {
		const f = fakePi("general-purpose#0123abcd");
		register(f.pi, defaultConfig());
		const ctx = fakeCtx();
		await f.emit("session_start", ctx);
		await f.emit("agent_settled", ctx);
		expect(ctx.ui.notify).not.toHaveBeenCalled();
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

describe("monitor extension with controlled children", () => {
	async function boot() {
		const f = fakePi();
		const clock = new FakeClock(0);
		const children = new ControlledProcesses(clock);
		register(f.pi, defaultConfig(), tmp.dir, { clock, spawnMonitor: children.spawn });
		const ctx = fakeCtx();
		await f.emit("session_start", ctx);
		const start = (params: Record<string, unknown>) =>
			f.tools.get("monitor_start").execute("1", params, undefined, undefined, ctx);
		return { f, ctx, clock, children, start, cmd: f.commands.get("monitor") };
	}

	it("is unavailable before a session starts, without throwing", async () => {
		const f = fakePi();
		register(f.pi, defaultConfig());
		const ctx = fakeCtx();
		for (const [name, params] of [
			["monitor_read", { id: "m1" }],
			["monitor_stop", { id: "m1" }],
		] as const) {
			expect(await f.tools.get(name).execute("1", params, undefined, undefined, ctx)).toEqual({
				content: [{ type: "text", text: "monitors are not available in this session" }],
				details: undefined,
				isError: true,
			});
		}
		expect(
			f.commands
				.get("monitor")
				.getArgumentCompletions("")
				.map((c: Any) => c.value),
		).toEqual(["list", "stop all"]);
	});

	it("describes exit codes, unknown codes and match triggers in /monitor list", async () => {
		const { f, ctx, clock, children, start, cmd } = await boot();
		await start({ argv: ["fixture"], name: "ok", match: "PASS" });
		const ok = children.last;
		await start({ argv: ["fixture"], name: "odd", wake: true });
		const odd = children.last;
		clock.advance(5_000);
		ok.exit(0);
		odd.exit(null);
		await waitFor(() => f.sendMessage.mock.calls.length === 2);
		expect(f.sendMessage.mock.calls.map(([, options]: Any[]) => options)).toEqual([
			{ triggerTurn: true, deliverAs: "followUp" },
			{ triggerTurn: true, deliverAs: "followUp" },
		]);
		await cmd.handler("stop all", ctx);
		expect(ctx.ui.notify).toHaveBeenLastCalledWith("no running monitors", "info");
		await cmd.handler("list", ctx);
		expect(ctx.ui.notify.mock.calls.at(-1)?.[0]).toBe(
			[
				'm1 "ok" exited (code 0) after 5s, 0 lines, pid 900000, match /PASS/: fixture',
				'm2 "odd" exited (code ?) after 5s, 0 lines, pid 900001, wake: fixture',
			].join("\n"),
		);
	});
});
