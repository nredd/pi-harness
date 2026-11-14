import { expect, test } from "vitest";
import { STATUS, WIDTHS } from "../src/terminal.ts";

test("exposes the status marker and ascending widths", () => {
	expect(STATUS).toBe("STATUS-LINE-OK");
	expect([...WIDTHS].sort((a, b) => a - b)).toEqual(WIDTHS);
});
