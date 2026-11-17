/** A settled todo batch cannot acquire disclosure merely by moving its success mark. */
import { expect, it } from "vitest";
import { click, FINAL, rowOf, TodoFixture, todo, turn } from "./todo-support.ts";

/** Port the Python one-line oracle over the actual transcript, excluding the widget below it. */
function assertOneLine(rows: string[]): void {
	const start = rows.findIndex((text) => /^\s*go\s*$/.test(text)) + 1;
	expect(start, rows.join("\n")).toBeGreaterThan(0);
	const editor = rows.findIndex((text, i) => i >= start && /^─{20,}$/.test(text.trim()));
	expect(editor).toBeGreaterThan(start);
	const end = rows.reduce((last, text, i) => (i < editor && text.trim() === `│ ${FINAL}` ? i + 1 : last), 0);
	expect(end).toBeGreaterThan(start);
	for (let i = start; i < end; i++) {
		const row = rows[i] ?? "";
		if (!row.trim() || /^┄{20,}$/.test(row.trim())) continue;
		expect(row.startsWith("▾ "), row).toBe(false);
		const staticEntry = row.startsWith("  ") && (i === start || /^┄{20,}$/.test(rows[i - 1]?.trim() ?? ""));
		if (row.startsWith("▸ ") || staticEntry) {
			const follower = i + 1 < end ? (rows[i + 1] ?? "") : "";
			expect(
				!follower.trim() || /^(▸ |▾ )/.test(follower) || /^┄{20,}$/.test(follower.trim()),
				`${row} / ${follower}`,
			).toBe(true);
		} else {
			expect(row.trim()).toMatch(new RegExp(`^│ (${FINAL}|DONE)$`));
		}
	}
	expect(rows.slice(start, end).some((text) => text.startsWith("▾ "))).toBe(false);
}

it("batch result with no extra detail stays flat in core", async () => {
	const fixture = await TodoFixture.create();
	let probes = 0;
	try {
		const host = await fixture.start(140, 90, (pi) => {
			pi.registerToolRenderer((name, next) => {
				const renderers = next();
				if (name !== "todo" || !renderers?.renderResult) return renderers;
				const renderResult = renderers.renderResult;
				return {
					...renderers,
					renderResult(result, options, theme, context) {
						if (context.probe) probes++;
						return renderResult(result, options, theme, context);
					},
				};
			});
		});
		await turn(host, [
			todo({ ops: Array.from({ length: 4 }, (_, i) => ({ action: "create", subject: `Task ${i}` })) }),
		]);
		expect(probes).toBeGreaterThan(0);
		assertOneLine(host.viewport());
		const row = rowOf(host, /todo.*4 ops/);
		const original = host.viewport()[row];
		if (!original) throw new Error("Missing todo batch row");
		expect(original.startsWith("  ")).toBe(true);
		expect(original.trimStart().startsWith("todo")).toBe(true);
		expect(original).toContain("✓");
		await click(host, 6, row);
		expect(host.viewport()[row]).toBe(original);
		host.input("\x0f");
		await host.settle();
		expect(host.viewport().find((text) => /todo.*4 ops/.test(text))).toBe(original);
		assertOneLine(host.viewport());
	} finally {
		await fixture.dispose();
	}
});
