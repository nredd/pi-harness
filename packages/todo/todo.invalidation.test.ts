import { buildSessionEntries, createMockCtx, createMockPi, makeTodoToolResult } from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import registerTodo from "./.test-support/home-fixtures.ts";
import { getActiveRenderSession, getState, replaceState } from "./state/store.ts";
import { __resetState } from "./todo.ts";
import { PLAN_APPROVED_EVENT } from "./tool/types.ts";

// Pins the substring `isStaleCtxError` matches in pi-core's invalidated-proxy error.
const STALE_CTX_MESSAGE = "This extension ctx is stale after session replacement or reload.";

// A ctx whose sessionManager getter throws — replayFromBranch reads
// ctx.sessionManager.getBranch() first, so this is where the stale proxy bites.
function throwingCtx(message: string) {
	return {
		hasUI: false,
		get sessionManager(): never {
			throw new Error(message);
		},
	};
}

const SEEDED = { tasks: [{ id: 1, subject: "keep me", status: "pending" }], nextId: 2 };
const SID = "s1";

function setup() {
	__resetState();
	const { pi, captured } = createMockPi();
	registerTodo(pi);
	return { captured };
}

beforeEach(() => {
	__resetState();
	vi.useFakeTimers();
});
afterEach(() => {
	__resetState();
	vi.clearAllTimers();
	vi.useRealTimers();
});

describe.each(["session_compact", "session_tree"] as const)("%s replay", (event) => {
	function replaySetup() {
		const update = vi.fn();
		class Overlay {
			setUICtx = vi.fn();
			update = update;
		}
		const { pi, captured } = createMockPi();
		registerTodo(pi, async () => ({ TodoOverlay: Overlay }) as unknown as typeof import("./todo-overlay.ts"));
		const start = captured.events.get("session_start")?.[0];
		const replay = captured.events.get(event)?.[0];
		if (!start || !replay) throw new Error("missing lifecycle handlers");
		return { start, replay, update };
	}

	it("replaces foreground state from the branch and refreshes the overlay", async () => {
		const { start, replay, update } = replaySetup();
		await start({} as never, createMockCtx({ sessionId: "fg", hasUI: true }) as never);
		const branch = buildSessionEntries([
			makeTodoToolResult({
				action: "create",
				params: { subject: "kept" },
				tasks: [{ id: 1, subject: "kept", status: "pending" }],
				nextId: 2,
			}),
		]);
		await replay({} as never, createMockCtx({ sessionId: "fg", branch }) as never);
		expect(getState("fg").tasks.map((task) => task.subject)).toEqual(["kept"]);
		expect(update).toHaveBeenCalledTimes(1);
		// An empty compacted branch must discard stale foreground tasks too.
		await replay({} as never, createMockCtx({ sessionId: "fg" }) as never);
		expect(getState("fg").tasks).toEqual([]);
		expect(update).toHaveBeenCalledTimes(2);
	});

	it("replays a child without refreshing or replacing the foreground", async () => {
		const { start, replay, update } = replaySetup();
		await start({} as never, createMockCtx({ sessionId: "fg", hasUI: true }) as never);
		replaceState("fg", SEEDED as never);
		replaceState("child", SEEDED as never);
		await replay({} as never, createMockCtx({ sessionId: "child" }) as never);
		expect(getState("child").tasks).toEqual([]);
		expect(getState("fg")).toEqual(SEEDED);
		expect(update).not.toHaveBeenCalled();
	});
});

describe("session_start invalidation", () => {
	it("leaves an approval pending and claims no foreground for a stale context", async () => {
		let approve: ((payload: unknown) => unknown) | undefined;
		const { pi, captured } = createMockPi({
			events: {
				on: vi.fn((name: string, callback: (payload: unknown) => unknown) => {
					if (name === PLAN_APPROVED_EVENT) approve = callback;
					return () => {};
				}),
				emit: vi.fn(),
			},
		} as never);
		registerTodo(pi);
		const start = captured.events.get("session_start")?.[0];
		const shutdown = captured.events.get("session_shutdown")?.[0];
		if (!start || !shutdown || !approve) throw new Error("missing lifecycle registration");
		await approve({ version: 1, sessionId: "later", planId: "p", plan: "# Plan\n- Keep pending" });
		// Identity resolves, but branch replay is stale. This detects falling
		// through the catch into sessionStarted, not just an undefined id.
		const stale = createMockCtx({ sessionId: "later", hasUI: true });
		stale.sessionManager.getBranch = () => {
			throw new Error(STALE_CTX_MESSAGE);
		};
		await expect(start({} as never, stale as never)).resolves.toBeUndefined();
		expect(getState("later").tasks).toEqual([]);
		expect(getActiveRenderSession()).toBe("");
		await shutdown({} as never, throwingCtx(STALE_CTX_MESSAGE) as never);
		expect(getActiveRenderSession()).toBe("");
		await start({} as never, createMockCtx({ sessionId: "later" }) as never);
		expect(getState("later").tasks.map((task) => task.subject)).toEqual(["Keep pending"]);
	});

	it("propagates an unexpected session_start error", async () => {
		const { captured } = setup();
		const start = captured.events.get("session_start")?.[0];
		if (!start) throw new Error("missing session_start");
		await expect(start({} as never, throwingCtx("real replay bug") as never)).rejects.toThrow("real replay bug");
	});
});

describe.each(["session_compact", "session_tree"] as const)("%s — stale ctx handling", (event) => {
	it("keeps current state on a stale ctx (replacement session replays)", async () => {
		const { captured } = setup();
		replaceState(SID, SEEDED as never);
		const handler = captured.events.get(event)?.[0];
		await expect(handler?.({} as never, throwingCtx(STALE_CTX_MESSAGE) as never)).resolves.toBeUndefined();
		// State untouched — no replay ran, the prior seed survives on the same session.
		expect(getState(SID)).toEqual(SEEDED);
	});

	it("propagates a non-stale replay error", async () => {
		const { captured } = setup();
		const handler = captured.events.get(event)?.[0];
		await expect(handler?.({} as never, throwingCtx("boom: real replay bug") as never)).rejects.toThrow("boom");
	});
});
