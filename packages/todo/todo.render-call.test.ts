import { createMockPi, makeTheme } from "@juicesharp/rpiv-test-utils";
import { describe, expect, it, vi } from "vitest";
import { registerTodoTool } from "./.test-support/home-fixtures.ts";

type RenderState = { taskSnapshot?: unknown; onRenderStateChange?: () => void };

function renderCallOf() {
	const { pi, captured } = createMockPi();
	registerTodoTool(pi);
	const tool = captured.tools.get("todo");
	if (!tool?.renderCall) throw new Error("todo renderCall not registered");
	const renderCall = tool.renderCall;
	return (state: RenderState, invalidate: () => void, extra: object = { probe: false }) =>
		renderCall({ action: "list" } as never, makeTheme() as never, { state, invalidate, ...extra } as never);
}

describe("todo renderCall — live fallback invalidation", () => {
	it("invalidates a row that still has no result snapshot when the render state changes", () => {
		const render = renderCallOf();
		const state: RenderState = {};
		const invalidate = vi.fn();
		render(state, invalidate);
		state.onRenderStateChange?.();
		expect(invalidate).toHaveBeenCalledTimes(1);
	});

	it("leaves a row alone once its result snapshot has settled", () => {
		const render = renderCallOf();
		const state: RenderState = {};
		const invalidate = vi.fn();
		render(state, invalidate);
		state.taskSnapshot = { tasks: [], nextId: 1 };
		state.onRenderStateChange?.();
		expect(invalidate).not.toHaveBeenCalled();
	});

	it("treats a context without `probe` (upstream 1.5 shape) as a real render", () => {
		const render = renderCallOf();
		const state: RenderState = {};
		const invalidate = vi.fn();
		render(state, invalidate, {});
		state.onRenderStateChange?.();
		expect(invalidate).toHaveBeenCalledTimes(1);
	});

	it("leaves a probe render alone", () => {
		const render = renderCallOf();
		const state: RenderState = {};
		render(state, vi.fn(), { probe: true });
		expect(state.onRenderStateChange).toBeUndefined();
	});
});
