import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { createMockCtx, createMockPi, createMockUI } from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	__resetState,
	registerTodoTool,
	setActiveRenderSession,
	type TaskAction,
} from "./.test-support/home-fixtures.ts";
import { TEST_HOME } from "./.test-support/setup.ts";
import { TodoOverlay } from "./todo-overlay.ts";

const identityTheme = {
	fg: (_c: string, s: string) => s,
	bg: (_c: string, s: string) => s,
	bold: (s: string) => s,
	strikethrough: (s: string) => s,
};

async function setup(
	actions: Array<{ action: TaskAction; [k: string]: unknown }>,
	uiOverrides: Partial<Omit<ExtensionUIContext, "theme">> = {},
) {
	__resetState();
	setActiveRenderSession("test-session");
	const { pi, captured } = createMockPi();
	registerTodoTool(pi);
	const tool = captured.tools.get("todo")!;
	const ctx = createMockCtx();
	for (const p of actions) {
		await tool.execute?.("tc", p as never, undefined as never, undefined as never, ctx as never);
	}
	const ui = createMockUI(uiOverrides) as unknown as ExtensionUIContext;
	const overlay = new TodoOverlay(TEST_HOME);
	overlay.setUICtx(ui);
	overlay.update();
	const setWidget = ui.setWidget as ReturnType<typeof vi.fn>;
	const factory = setWidget.mock.calls[0][1] as (
		tui: { requestRender: () => void },
		theme: typeof identityTheme,
	) => { render: (w: number) => string[]; invalidate: () => void };
	const widget = factory({ requestRender: vi.fn() }, identityTheme);
	return { widget, tool, ui, overlay };
}

beforeEach(() => {
	__resetState();
});
afterEach(() => {
	__resetState();
	vi.restoreAllMocks();
});

describe("TodoOverlay — heading", () => {
	it("includes an expanded disclosure marker and spelled-out counts", async () => {
		const { widget } = await setup([
			{ action: "create", subject: "a" },
			{ action: "create", subject: "b" },
			{ action: "update", id: 1, status: "completed", evidence: "ok" },
		]);
		const lines = widget.render(200);
		expect(lines[0]).toContain("▾");
		expect(lines[0]).toContain("Todos (1 done, 1 open)");
	});

	it("uses filled icon '●' when any task is active (pending/in_progress)", async () => {
		const { widget } = await setup([{ action: "create", subject: "a" }]);
		expect(widget.render(200)[0]).toContain("●");
	});

	it("uses hollow icon '○' when all tasks are completed", async () => {
		const { widget } = await setup([
			{ action: "create", subject: "a" },
			{ action: "update", id: 1, status: "completed", evidence: "ok" },
		]);
		expect(widget.render(200)[0]).toContain("○");
	});
});

describe("TodoOverlay — natural-order rendering (no overflow)", () => {
	it("renders one line per visible task plus heading, last row uses '└─'", async () => {
		const { widget } = await setup([
			{ action: "create", subject: "a" },
			{ action: "create", subject: "b" },
			{ action: "create", subject: "c" },
		]);
		const lines = widget.render(200);
		expect(lines).toHaveLength(5); // heading + 3 + trailing spacer
		expect(lines[1]).toContain("├─");
		expect(lines[2]).toContain("├─");
		expect(lines[3]).toContain("└─");
		expect(lines[4]).toBe(""); // trailing spacer below the panel
	});

	it("omits deleted tasks from the rendered output", async () => {
		const { widget } = await setup([
			{ action: "create", subject: "visible" },
			{ action: "create", subject: "gone" },
			{ action: "update", id: 2, status: "deleted" },
		]);
		const out = widget.render(200).join("\n");
		expect(out).toContain("visible");
		expect(out).not.toContain("gone");
	});
});

describe("TodoOverlay — per-task formatting", () => {
	it("pending task uses '○' glyph", async () => {
		const { widget } = await setup([{ action: "create", subject: "pending-task" }]);
		expect(widget.render(200)[1]).toContain("○");
		expect(widget.render(200)[1]).toContain("pending-task");
	});

	it("in_progress task uses '◐' glyph and appends (activeForm)", async () => {
		const { widget } = await setup([
			{ action: "create", subject: "do it", activeForm: "Doing it" },
			{ action: "update", id: 1, status: "in_progress" },
		]);
		const line = widget.render(200)[1];
		expect(line).toContain("◐");
		expect(line).toContain("do it");
		expect(line).toContain("(Doing it)");
	});

	it("completed tasks stay visible across renders", async () => {
		const { widget } = await setup([
			{ action: "create", subject: "done" },
			{ action: "update", id: 1, status: "completed", evidence: "ok" },
		]);
		const line = widget.render(200)[1];
		expect(line).toContain("✓");
		expect(line).toContain("done");
		expect(widget.render(200)[1]).toContain("done");
	});
});

describe("TodoOverlay — task IDs", () => {
	it("renders every visible task's stable ID independently of its subject at normal and narrow widths", async () => {
		const actions = Array.from({ length: 34 }, (_, i) => ({
			action: "create" as const,
			subject: i === 33 ? "subject #100" : `task ${i + 1}`,
		}));
		const { widget } = await setup(actions, { getToolsExpanded: () => true });

		const expanded = widget.render(200).join("\n");
		expect(expanded).toContain("#34");
		expect(expanded).toContain("subject #100");

		const narrow = widget.render(20).join("\n");
		expect(narrow).toContain("#34");
	});
});

describe("TodoOverlay — scrollable window", () => {
	function creates(n: number): Array<{ action: TaskAction; [k: string]: unknown }> {
		return Array.from({ length: n }, (_, i) => ({ action: "create" as const, subject: `t${i + 1}` }));
	}
	type Mouse = (e: Record<string, unknown>) => unknown;
	const wheel = (widget: unknown, wheelDelta: number) =>
		(widget as { handleMouse: Mouse }).handleMouse({ type: "wheel", button: "none", y: 3, wheelDelta });

	it("windows an overflowing list to the budget with a '↓ N below' hint", async () => {
		const { widget } = await setup(creates(30));
		const lines = widget.render(200);
		expect(lines).toHaveLength(13); // heading + 11 rows + trailing spacer
		expect(lines[lines.length - 1]).toBe("");
		expect(lines[lines.length - 2]).toContain("└─ ↓ 20 below");
		expect(lines.join("\n")).toContain("t10");
		expect(lines.join("\n")).not.toContain("t11");
	});

	it("does not engage at exactly the budget (11 tasks)", async () => {
		const { widget } = await setup(creates(11));
		const lines = widget.render(200);
		expect(lines).toHaveLength(13);
		expect(lines[lines.length - 2]).toContain("t11");
		expect(lines[lines.length - 2]).toContain("└─");
		expect(lines.join("\n")).not.toContain("below");
	});

	it("wheel scrolls by |wheelDelta| rows and shows both hints mid-list", async () => {
		const { widget } = await setup(creates(30));
		widget.render(200);
		expect(wheel(widget, 5)).toEqual({ handled: true });
		const lines = widget.render(200);
		expect(lines).toHaveLength(13);
		expect(lines[1]).toContain("↑ 5 above");
		expect(lines[2]).toContain("t6");
		expect(lines[lines.length - 2]).toContain("↓");
		expect(wheel(widget, -2)).toEqual({ handled: true });
		expect(widget.render(200)[1]).toContain("↑ 3 above");
	});

	it("reaches the last todo, then lets the wheel fall through at the limit", async () => {
		const { widget } = await setup(creates(30));
		widget.render(200);
		expect(wheel(widget, 999)).toEqual({ handled: true });
		const lines = widget.render(200);
		expect(lines).toHaveLength(13);
		expect(lines[lines.length - 2]).toContain("t30");
		expect(lines[lines.length - 2]).not.toContain("below");
		expect(wheel(widget, 3)).toBeUndefined();
	});

	it("lets the wheel fall through at the top and when the list fits", async () => {
		const { widget } = await setup(creates(30));
		widget.render(200);
		expect(wheel(widget, -3)).toBeUndefined();
		const small = await setup(creates(3));
		expect(wheel(small.widget, 3)).toBeUndefined();
	});

	it("scrolls to the in_progress task when it moves out of view, then stays put", async () => {
		const { widget, tool } = await setup(creates(30));
		widget.render(200);
		await tool.execute?.(
			"tc",
			{ action: "update", id: 25, status: "in_progress" } as never,
			undefined as never,
			undefined as never,
			createMockCtx() as never,
		);
		const out = widget.render(200).join("\n");
		expect(out).toContain("t25");
		wheel(widget, -2);
		expect(widget.render(200).join("\n")).toContain("t22");
	});

	it("counts every todo in the heading, completed or not", async () => {
		const actions = creates(30);
		for (let i = 1; i <= 4; i++) actions.push({ action: "update", id: i, status: "completed", evidence: "ok" });
		actions.push({ action: "update", id: 5, status: "deferred", reason: "later" });
		const { widget } = await setup(actions);
		expect(widget.render(200)[0]).toContain("Todos (4 done, 1 deferred, 25 open)");
	});

	it("omits the in-progress segment when nothing is in progress", async () => {
		const { widget } = await setup([
			{ action: "create", subject: "a" },
			{ action: "create", subject: "b" },
		]);
		expect(widget.render(200)[0]).toContain("Todos (2 open)");
		expect(widget.render(200)[0]).not.toContain("in progress");
	});

	it("calls out in-progress as a subset of open, expanded and collapsed", async () => {
		const { widget, overlay } = await setup([
			{ action: "create", subject: "a" },
			{ action: "create", subject: "b" },
			{ action: "create", subject: "c" },
			{ action: "update", id: 1, status: "in_progress" },
			{ action: "update", id: 2, status: "in_progress" },
		]);
		expect(widget.render(200)[0]).toContain("Todos (3 open, 2 in progress)");
		overlay.toggleCollapse();
		expect(widget.render(200)[0]).toContain("▸");
		expect(widget.render(200)[0]).toContain("Todos (3 open, 2 in progress)");
	});

	it("counts all open tasks as in progress when every one is", async () => {
		const { widget } = await setup([
			{ action: "create", subject: "a" },
			{ action: "update", id: 1, status: "in_progress" },
		]);
		expect(widget.render(200)[0]).toContain("Todos (1 open, 1 in progress)");
	});

	it("paints only the in-progress segment with the warning color", async () => {
		await setup([
			{ action: "create", subject: "a" },
			{ action: "update", id: 1, status: "in_progress" },
		]);
		const tagged = { ...identityTheme, fg: (c: string, s: string) => `<${c}>${s}</${c}>` };
		const ui = createMockUI() as unknown as ExtensionUIContext;
		const o = new TodoOverlay(TEST_HOME);
		o.setUICtx(ui);
		o.update();
		const factory = (ui.setWidget as ReturnType<typeof vi.fn>).mock.calls[0][1] as (
			tui: { requestRender: () => void },
			theme: typeof tagged,
		) => { render: (w: number) => string[] };
		const line = factory({ requestRender: vi.fn() }, tagged).render(200)[0];
		expect(line).toContain("<warning>1 in progress</warning>");
		expect(line).toContain("<accent>Todos (</accent><accent>1 open</accent><accent>, </accent>");
		expect(line).toContain("<accent>)</accent>");
	});

	it("keeps the in-progress segment before the plan suffix", async () => {
		const { widget } = await setup([
			{ action: "create", subject: "extra" },
			{ action: "update", id: 1, status: "in_progress" },
		]);
		const { applyPlanApproval } = await import("./state/plan.ts");
		const { commitState, getRenderState } = await import("./state/store.ts");
		commitState("test-session", applyPlanApproval(getRenderState(), "p1", "# T\n\n## Work\n- one\n- two\n").state);
		expect(widget.render(200)[0]).toContain("Todos (3 open, 1 in progress · 2/2 plan items open)");
	});

	it("shows a separate plan suffix only when non-plan todos exist", async () => {
		const { widget, tool } = await setup([{ action: "create", subject: "extra" }]);
		const { applyPlanApproval } = await import("./state/plan.ts");
		const { commitState, getRenderState } = await import("./state/store.ts");
		commitState("test-session", applyPlanApproval(getRenderState(), "p1", "# T\n\n## Work\n- one\n- two\n").state);
		expect(widget.render(200)[0]).toContain("Todos (3 open · 2/2 plan items open)");
		await tool.execute?.(
			"tc",
			{ action: "delete", id: 1 } as never,
			undefined as never,
			undefined as never,
			createMockCtx() as never,
		);
		expect(widget.render(200)[0]).toContain("Todos (2 open)");
		expect(widget.render(200)[0]).not.toContain("plan items open");
	});

	it("follows Pi's tool-output expansion mode and renders every task", async () => {
		let toolsExpanded = false;
		const { widget } = await setup(creates(17), { getToolsExpanded: () => toolsExpanded });
		expect(widget.render(200).join("\n")).not.toContain("t17");
		toolsExpanded = true;
		const expanded = widget.render(200);
		expect(expanded).toHaveLength(19); // heading + 17 tasks + trailing spacer
		expect(expanded.join("\n")).toContain("t17");
		expect(expanded.join("\n")).not.toContain("below");
		expect(expanded[expanded.length - 2]).toContain("└─");
		expect(wheel(widget, 3)).toBeUndefined();
	});

	it("keeps the configured budget when the host has no expansion-state API", async () => {
		const { widget } = await setup(creates(17));
		expect(widget.render(200).join("\n")).toContain("↓ 7 below");
	});

	it("collapse resets the scroll position", async () => {
		const { widget, overlay } = await setup(creates(30));
		widget.render(200);
		wheel(widget, 8);
		overlay.toggleCollapse();
		overlay.toggleCollapse();
		expect(widget.render(200)[1]).toContain("t1");
	});
});

describe("TodoOverlay — collapse/expand render", () => {
	it("reclaims exactly one row when collapsed at normal and narrow widths", async () => {
		const { widget, overlay } = await setup([
			{ action: "create", subject: "a" },
			{ action: "create", subject: "b" },
			{ action: "update", id: 1, status: "completed", evidence: "ok" },
		]);

		const expanded = widget.render(200);
		expect(expanded).toHaveLength(4); // heading + 2 tasks + trailing spacer

		overlay.toggleCollapse();
		const collapsed = widget.render(200);
		expect(collapsed).toHaveLength(2); // heading + trailing spacer
		expect(collapsed[0]).toContain("▸");
		expect(collapsed[0]).toContain("Todos (1 done, 1 open)");
		expect(collapsed[1]).toBe("");
		expect(collapsed).not.toContain("alt+t to expand");

		const narrow = widget.render(1);
		expect(narrow).toHaveLength(2);
		expect(narrow[1]).toBe("");
	});
});

describe("TodoOverlay — width truncation", () => {
	it("renders without throwing at small widths", async () => {
		const { widget } = await setup([
			{ action: "create", subject: "a very long subject that would overflow a narrow column" },
		]);
		expect(() => widget.render(20)).not.toThrow();
	});

	it("re-renders reflect live state changes without re-registering", async () => {
		const { widget, tool } = await setup([{ action: "create", subject: "first" }]);
		const out1 = widget.render(200).join("\n");
		expect(out1).toContain("first");
		await tool.execute?.(
			"tc",
			{ action: "create", subject: "second" } as never,
			undefined as never,
			undefined as never,
			createMockCtx() as never,
		);
		const out2 = widget.render(200).join("\n");
		expect(out2).toContain("first");
		expect(out2).toContain("second");
	});
});
