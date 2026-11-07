import { createMockCtx, createMockPi } from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import registerTodo from "./.test-support/home-fixtures.ts";
import { __resetState } from "./todo.ts";
import { PLAN_APPROVED_EVENT } from "./tool/types.ts";

type Handler = (...args: unknown[]) => unknown;
type OverlayModule = typeof import("./todo-overlay.ts");

const PLAN = "# T\n\n## Work\n- one\n";

function setup(importOverlay?: () => Promise<OverlayModule>) {
	const bus = new Map<string, Handler[]>();
	const { pi, captured } = createMockPi({
		events: {
			emit: vi.fn(),
			on: vi.fn((channel: string, handler: Handler) => {
				bus.set(channel, [...(bus.get(channel) ?? []), handler]);
				return () => {};
			}),
		},
	} as never);
	registerTodo(pi, importOverlay);
	const handler = (name: string) => {
		const found = captured.events.get(name)?.[0] as Handler | undefined;
		if (!found) throw new Error(`${name} not registered`);
		return found;
	};
	const tool = captured.tools.get("todo");
	if (!tool) throw new Error("todo tool not registered");
	const create = (ctx: unknown) =>
		tool.execute?.(
			"tc",
			{ action: "create", subject: "task" } as never,
			undefined as never,
			undefined as never,
			ctx as never,
		);
	return { bus, handler, create };
}

function fakeOverlay() {
	const instances: Array<Record<string, ReturnType<typeof vi.fn>>> = [];
	class Overlay {
		setUICtx = vi.fn();
		update = vi.fn();
		collapse = vi.fn();
		dispose = vi.fn();
		constructor() {
			instances.push(this as never);
		}
	}
	const importer = vi.fn(async () => ({ TodoOverlay: Overlay }) as unknown as OverlayModule);
	return { importer, instances };
}

beforeEach(() => __resetState());
afterEach(() => {
	__resetState();
	vi.restoreAllMocks();
});

describe("overlay refresh failures", () => {
	it("logs a non-Error rejection by its string form and keeps going", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { handler, create } = setup(() => Promise.reject("plain failure"));
		const ctx = createMockCtx({ hasUI: true, sessionId: "s1" });
		await handler("session_start")({ reason: "startup" }, ctx);
		await create(ctx);
		await expect(handler("tool_execution_end")({ toolName: "todo", isError: false })).resolves.toBeUndefined();
		expect(warn).toHaveBeenCalledWith(
			"[rpiv-todo] overlay refresh failed (will retry on next update): plain failure",
		);
	});
});

describe("tool_execution_end", () => {
	it.each([
		{ toolName: "other", isError: false },
		{ toolName: "todo", isError: true },
	])("does not touch the overlay for %j", async (event) => {
		const { importer } = fakeOverlay();
		const { handler, create } = setup(importer);
		const ctx = createMockCtx({ hasUI: true, sessionId: "s1" });
		await handler("session_start")({ reason: "startup" }, ctx);
		await create(ctx);
		await handler("tool_execution_end")(event);
		expect(importer).not.toHaveBeenCalled();
		await handler("tool_execution_end")({ toolName: "todo", isError: false });
		expect(importer).toHaveBeenCalledTimes(1);
	});
});

describe("plan approval in the foreground session", () => {
	it("refreshes the overlay when an approval seeds the active session", async () => {
		const { importer, instances } = fakeOverlay();
		const { bus, handler } = setup(importer);
		const ctx = createMockCtx({ hasUI: true, sessionId: "s1" });
		await handler("session_start")({ reason: "startup" }, ctx);
		expect(importer).not.toHaveBeenCalled();
		for (const h of bus.get(PLAN_APPROVED_EVENT) ?? [])
			await h({ version: 1, planId: "p1", plan: PLAN, sessionId: "s1" });
		expect(importer).toHaveBeenCalledTimes(1);
		expect(instances).toHaveLength(1);
		expect(instances[0].update).toHaveBeenCalled();
	});

	it("does not refresh for an approval seeded into a session that is not the foreground", async () => {
		const { importer } = fakeOverlay();
		const { bus, handler } = setup(importer);
		const foreground = createMockCtx({ hasUI: true, sessionId: "s1" });
		const child = createMockCtx({ hasUI: false, sessionId: "child" });
		await handler("session_start")({ reason: "startup" }, foreground);
		await handler("session_start")({ reason: "startup" }, child);
		for (const h of bus.get(PLAN_APPROVED_EVENT) ?? [])
			await h({ version: 1, planId: "p1", plan: PLAN, sessionId: "child" });
		expect(importer).not.toHaveBeenCalled();
	});
});

describe("session_shutdown", () => {
	it("rethrows a context failure that is not a stale-context error", async () => {
		const { handler } = setup();
		const ctx = createMockCtx({ sessionId: "s1" });
		Object.defineProperty(ctx, "sessionManager", {
			get() {
				throw new Error("disk on fire");
			},
		});
		await expect(handler("session_shutdown")({}, ctx)).rejects.toThrow("disk on fire");
	});

	it("swallows a stale-context failure with nothing to tear down", async () => {
		const { handler } = setup();
		const ctx = createMockCtx({ sessionId: "s1" });
		Object.defineProperty(ctx, "sessionManager", {
			get() {
				throw new Error("ctx is stale after session replacement");
			},
		});
		await expect(handler("session_shutdown")({}, ctx)).resolves.toBeUndefined();
	});
});
