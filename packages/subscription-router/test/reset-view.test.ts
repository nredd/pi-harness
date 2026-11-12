import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { ResetView } from "../src/reset-view.js";

describe("native reset schedule screen", () => {
	it("wraps narrow panes, scrolls and resizes without hiding access to details", () => {
		let rows = 8;
		const render = vi.fn();
		const done = vi.fn();
		const view = new ResetView(
			`Scheduled replenishment\n${"scope sample, reset UTC detail ".repeat(40)}`,
			() => rows,
			render,
			done,
		);
		const first = view.render(20);
		expect(first.length).toBeLessThanOrEqual(rows);
		expect(first.every((line) => visibleWidth(line) <= 20)).toBe(true);
		view.handleInput("j");
		expect(view.render(20)).not.toEqual(first);
		view.handleInput("k");
		expect(view.render(20)).toEqual(first);
		view.handleInput("\u001b[6~");
		expect(view.render(20)).not.toEqual(first);
		view.handleInput("\u001b[5~");
		expect(view.render(20)).toEqual(first);
		view.handleInput("ignored");
		view.invalidate();
		rows = 12;
		expect(view.render(80).length).toBeLessThanOrEqual(rows);
		expect(view.render(1).every((line) => visibleWidth(line) <= 1)).toBe(true);
		view.handleInput("r");
		expect(done).toHaveBeenLastCalledWith(true);
		for (const key of ["q", "\u001b", "\u0003"]) {
			view.handleInput(key);
			expect(done).toHaveBeenLastCalledWith(false);
		}
		expect(render).toHaveBeenCalled();
	});
});
