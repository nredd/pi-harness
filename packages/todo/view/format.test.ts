import type { Theme } from "@earendil-works/pi-coding-agent";
import { makeTheme } from "@juicesharp/rpiv-test-utils";
import { describe, expect, it } from "vitest";
import type { AgentRunState } from "../state/agents.ts";
import type { Task } from "../tool/types.ts";
import {
	formatCommandTaskLine,
	formatOverlayTaskLine,
	overlayStatusGlyph,
	renderTodoCall,
	STATUS_GLYPH,
} from "./format.ts";

const recordingTheme = makeTheme({
	fg: (color, text) => `<${color}>${text}</${color}>`,
	strikethrough: (text) => `<strike>${text}</strike>`,
}) as unknown as Theme;

function task(overrides: Partial<Task> = {}): Task {
	return {
		id: 1,
		subject: "quiet task",
		status: "pending",
		...overrides,
	};
}

describe("overlayStatusGlyph exported palette", () => {
	it("preserves distinct status glyphs and the error-toned deleted contract", () => {
		expect([
			overlayStatusGlyph("pending", recordingTheme),
			overlayStatusGlyph("in_progress", recordingTheme),
			overlayStatusGlyph("completed", recordingTheme),
			overlayStatusGlyph("deferred", recordingTheme),
			overlayStatusGlyph("deleted", recordingTheme),
		]).toEqual([
			"<dim>○</dim>",
			"<warning>◐</warning>",
			"<success>✓</success>",
			"<muted>⊖</muted>",
			"<error>✗</error>",
		]);
		expect(STATUS_GLYPH.deleted).toBe("⊘");
	});
});

describe("formatOverlayTaskLine — semantic color hierarchy", () => {
	it("keeps pending subjects primary while rendering IDs quietly", () => {
		expect(formatOverlayTaskLine(task(), recordingTheme, true)).toBe(
			"<dim>○</dim> <dim>#1</dim> <text>quiet task</text>",
		);
	});

	it("emphasizes the current task while muting its supporting metadata", () => {
		expect(
			formatOverlayTaskLine(
				task({ status: "in_progress", activeForm: "Working", blockedBy: [2, 3] }),
				recordingTheme,
				true,
			),
		).toBe(
			"<warning>◐</warning> <dim>#1</dim> <accent>quiet task</accent> <muted>(Working)</muted> <muted>⛓ #2,#3</muted>",
		);
	});

	it("mutes and strikes completed subjects", () => {
		expect(formatOverlayTaskLine(task({ status: "completed" }), recordingTheme, false)).toBe(
			"<success>✓</success> <strike><muted>quiet task</muted></strike>",
		);
	});
});

describe("formatOverlayTaskLine — terminal control characters", () => {
	it("strips escape sequences from subject and activeForm before theming", () => {
		expect(
			formatOverlayTaskLine(
				task({ status: "in_progress", subject: "quiet\u001b[2Jtask", activeForm: "Work\u009bcing" }),
				recordingTheme,
				false,
			),
		).toBe("<warning>◐</warning> <accent>quiettask</accent> <muted>(Working)</muted>");
	});
});

describe("owner segment", () => {
	const lookup = (state: AgentRunState | undefined) => () => state;

	it("renders the owner dim after the subject, before activeForm", () => {
		expect(
			formatOverlayTaskLine(
				task({ status: "in_progress", owner: "auth-audit", activeForm: "auditing" }),
				recordingTheme,
				false,
				lookup(undefined),
			),
		).toBe("<warning>◐</warning> <accent>quiet task</accent> <dim>@auth-audit</dim> <muted>(auditing)</muted>");
	});

	it.each([
		["running", "<accent>running</accent>"],
		["done", "<success>done</success>"],
	] as const)("shows a live %s agent without touching the todo status", (state, painted) => {
		expect(
			formatOverlayTaskLine(
				task({ status: "in_progress", owner: "@auth-audit" }),
				recordingTheme,
				false,
				lookup(state),
			),
		).toBe(`<warning>◐</warning> <accent>quiet task</accent> <dim>@auth-audit</dim> ${painted}`);
	});

	it.each([
		["failed", "<error>✗ failed</error>"],
		["stopped", "<error>✗ stopped</error>"],
	] as const)("marks an in_progress todo whose agent %s as failed", (state, painted) => {
		expect(
			formatOverlayTaskLine(task({ status: "in_progress", owner: "w" }), recordingTheme, false, lookup(state)),
		).toBe(`<warning>◐</warning> <accent>quiet task</accent> <dim>@w</dim> ${painted}`);
	});

	it("shows a stopped agent plainly once its todo is no longer in_progress", () => {
		expect(formatOverlayTaskLine(task({ owner: "w" }), recordingTheme, false, lookup("stopped"))).toBe(
			"<dim>○</dim> <text>quiet task</text> <dim>@w</dim> <muted>stopped</muted>",
		);
	});

	it("prints only the owner in /todos when no lookup is given", () => {
		expect(formatCommandTaskLine(task({ owner: "w" }), "○")).toBe("  ○ #1 quiet task @w");
	});

	it("omits a blank owner entirely", () => {
		expect(formatOverlayTaskLine(task({ owner: " " }), recordingTheme, false, lookup("running"))).toBe(
			"<dim>○</dim> <text>quiet task</text>",
		);
	});

	it("prints the same segment uncolored for /todos", () => {
		expect(
			formatCommandTaskLine(task({ status: "in_progress", owner: "w", activeForm: "x" }), "◐", lookup("stopped")),
		).toBe("  ◐ #1 quiet task @w ✗ stopped (x)");
		expect(formatCommandTaskLine(task({ owner: "Sergii" }), "○", lookup(undefined))).toBe(
			"  ○ #1 quiet task @Sergii",
		);
	});
});

describe("renderTodoCall — partially streamed arguments", () => {
	const empty = { tasks: [], nextId: 1 };
	const plain = (args: Record<string, unknown>) =>
		renderTodoCall(args as never, recordingTheme, empty)
			.render(80)
			.join("")
			.replace(/<\/?[a-zA-Z]+>/g, "")
			.trim();

	it("shows just the tool title before the action has streamed in", () => {
		expect(plain({})).toBe("todo");
	});

	it("falls back to the raw action text when it has no glyph", () => {
		expect(plain({ action: "frobnicate" })).toBe("todo frobnicate");
	});
});
