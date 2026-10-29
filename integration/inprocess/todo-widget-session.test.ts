/** The real todo widget receives heading clicks and wheel input from core's interactive host. */
import { expect, it } from "vitest";
import { click, rowOf, TodoFixture, todo, turn, wheel } from "./todo-support.ts";

const SUBJECTS = ["Alpha task", "Bravo task"];
const EXPANDED = /^\s*▾ [●○] Todos \(2 open\)/;
const COLLAPSED = /^\s*▸ [●○] Todos \(2 open\)/;
const HEADING = /^\s*▾ [●○] Todos \(3 done, 25 open\)/;

/** Transcript subjects do not count: require each task's tree connector and stable ID under the widget heading. */
function tasksListed(screen: string, listed: boolean): void {
	for (const [index, subject] of SUBJECTS.entries()) {
		expect(new RegExp(`[├└]─ .*#${index + 1} .*${subject}`).test(screen), screen).toBe(listed);
	}
}

it("heading click hides and restores tasks", async () => {
	const fixture = await TodoFixture.create();
	try {
		const host = await fixture.start();
		await turn(
			host,
			SUBJECTS.map((subject) => todo({ action: "create", subject })),
		);
		expect(rowOf(host, EXPANDED)).toBeGreaterThanOrEqual(0);
		tasksListed(host.viewport().join("\n"), true);

		await click(host, 6, rowOf(host, EXPANDED));
		const collapsedRow = rowOf(host, COLLAPSED);
		const collapsed = host.viewport().join("\n");
		tasksListed(collapsed, false);
		// The widget's only row after its heading is its existing blank spacer.
		expect(host.viewport()[collapsedRow + 1]?.trim()).toBe("");
		expect(collapsed).not.toMatch(/(?:to expand|collapsed)/);

		await click(host, 6, rowOf(host, COLLAPSED));
		expect(rowOf(host, EXPANDED)).toBeGreaterThanOrEqual(0);
		tasksListed(host.viewport().join("\n"), true);
	} finally {
		await fixture.dispose();
	}
});

it("wheel reaches all batched tasks with correct counts", async () => {
	const fixture = await TodoFixture.create();
	try {
		const host = await fixture.start(140, 40);
		await turn(host, [
			todo({
				ops: Array.from({ length: 28 }, (_, i) => ({
					action: "create",
					subject: `Item ${String(i + 1).padStart(2, "0")}`,
				})),
			}),
			todo({
				ops: Array.from({ length: 3 }, (_, i) => ({
					action: "update",
					id: i + 1,
					status: "completed",
					evidence: `proof ${i + 1}`,
				})),
			}),
		]);
		expect(host.harness.eventsOfType("tool_execution_end")).toHaveLength(2);
		expect(rowOf(host, HEADING)).toBeGreaterThanOrEqual(0);
		const initial = host.viewport().join("\n");
		expect(initial).toContain("Item 01");
		expect(initial).not.toContain("Item 28");
		expect(initial).toMatch(/└─ ↓ (\d+) below/);

		const row = rowOf(host, HEADING) + 3;
		const seen = new Set<string>();
		for (let i = 0; i < 28; i++) {
			for (const text of host.viewport()) {
				const match = /[├└]─ .*Item (\d+)/.exec(text);
				if (match?.[1]) seen.add(match[1]);
			}
			await wheel(host, 10, row, true);
		}
		const bottom = host.viewport().join("\n");
		expect(bottom).toMatch(/└─ .*Item 28/);
		expect(bottom).not.toContain("below");
		expect(bottom).toMatch(/├─ ↑ \d+ above/);
		expect(seen.size).toBe(28);
		for (let i = 0; i < 28; i++) await wheel(host, 10, row, false);
		const top = host.viewport().join("\n");
		expect(top).toMatch(/[├└]─ .*Item 01/);
		expect(top).not.toContain("above");
		expect(top).toMatch(/└─ ↓ \d+ below/);
	} finally {
		await fixture.dispose();
	}
});
