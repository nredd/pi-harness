import type { Theme } from "@earendil-works/pi-coding-agent";
import { createMockCtx, createMockPi, makeTheme } from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetState, registerTodoTool, setActiveRenderSession, TOOL_NAME } from "./.test-support/home-fixtures.ts";

const theme = makeTheme() as unknown as Theme;
const SESSION_ID = "foreground";

function text(node: unknown): string {
	return (node as unknown as { text: string }).text;
}

function setup() {
	__resetState();
	setActiveRenderSession(SESSION_ID);
	const { pi, captured } = createMockPi();
	registerTodoTool(pi);
	const tool = captured.tools.get(TOOL_NAME);
	if (!tool) throw new Error("todo tool was not registered");
	return tool;
}

async function call(tool: ReturnType<typeof setup>, params: Record<string, unknown>) {
	return tool.execute?.(
		"tc",
		params as never,
		undefined as never,
		undefined as never,
		createMockCtx({ sessionId: SESSION_ID }) as never,
	);
}

beforeEach(__resetState);
afterEach(__resetState);

describe("registered rendering callbacks", () => {
	it.each([1, 2])("renders a batch of %i operations with the correct plural", (count) => {
		const tool = setup();
		const ops = Array.from({ length: count }, () => ({ action: "list" }));
		expect(text(tool.renderCall?.({ ops } as never, theme, {} as never))).toBe(
			count === 1 ? "todo ≡ 1 op" : "todo ≡ 2 ops",
		);
	});

	it("echoes snapshot status without an explicit status and expands sanitized deferral reasons", async () => {
		const tool = setup();
		await call(tool, { action: "create", subject: "blocked" });
		const deferred = await call(tool, {
			action: "update",
			id: 1,
			status: "deferred",
			reason: "needs \u001b[31mreview\u001b[0m",
		});
		const render = (result: unknown, expanded: boolean) =>
			text(tool.renderResult?.(result as never, { expanded, isPartial: false } as never, theme, {} as never));
		expect(render(deferred, false)).toBe("⊖ deferred");
		expect(render(deferred, true)).toBe("⊖ deferred\nreason: needs review");
		const renamed = await call(tool, { action: "update", id: 1, subject: "waiting" });
		expect(render(renamed, false)).toBe("⊖ deferred");
		expect(render({ details: { action: "update", params: { id: 99 }, tasks: [], nextId: 1 } }, false)).toBe("✓");
	});
});

describe("registerTodoTool -- historical renderer state", () => {
	it("keeps a settled update row on its result snapshot after the live task changes", async () => {
		const tool = setup();
		await call(tool, { action: "create", subject: "historical subject" });
		const historical = await call(tool, { action: "update", id: 1, status: "in_progress" });
		const context = { state: {}, invalidate: vi.fn() };

		// Pi settles the result into the same ToolRenderContext state used by the
		// collapsed call row, then invalidates that cached row.
		tool.renderResult?.(historical as never, { expanded: false, isPartial: false } as never, theme, context as never);
		await Promise.resolve();
		expect(context.invalidate).toHaveBeenCalledTimes(1);
		expect(text(tool.renderCall?.({ action: "update", id: 1 } as never, theme, context as never))).toContain(
			"historical subject",
		);

		await call(tool, { action: "update", id: 1, subject: "today's subject" });
		for (const expanded of [false, true]) {
			expect(
				text(
					tool.renderCall?.({ action: "update", id: 1 } as never, theme, {
						...context,
						expanded,
					} as never),
				),
			).toContain("historical subject");
		}
		expect(context.invalidate).toHaveBeenCalledTimes(1);
	});

	it.each([{}, [null], [{ id: 1, subject: "invalid", status: "unknown" }]])(
		"does not capture malformed persisted error snapshots: %j",
		async (tasks) => {
			const tool = setup();
			await call(tool, { action: "create", subject: "valid task" });
			const context = { state: {}, invalidate: vi.fn() };
			const malformed = { details: { error: "failed", tasks, nextId: 2 } };
			tool.renderResult?.(
				malformed as never,
				{ expanded: false, isPartial: false } as never,
				theme,
				context as never,
			);
			await Promise.resolve();
			expect(context.state).toEqual({});
			expect(context.invalidate).not.toHaveBeenCalled();
			expect(text(tool.renderCall?.({ action: "update", id: 1 } as never, theme, context as never))).toContain(
				"valid task",
			);
		},
	);

	it("does not mutate or invalidate a throwaway renderer probe", async () => {
		const tool = setup();
		await call(tool, { action: "create", subject: "historical subject" });
		const result = await call(tool, { action: "update", id: 1, status: "in_progress" });
		const context = { state: {}, probe: true, invalidate: vi.fn() };

		tool.renderResult?.(result as never, { expanded: false, isPartial: false } as never, theme, context as never);

		expect(context.state).toEqual({});
		expect(context.invalidate).not.toHaveBeenCalled();
	});
});
