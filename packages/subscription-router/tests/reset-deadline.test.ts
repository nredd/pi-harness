import { expect, it } from "vitest";
import { anchorReset } from "../src/reset-deadline.ts";

it("floors elapsed milliseconds before projecting the wall deadline", () => {
	let monotonic = 10.25;
	const deadline = anchorReset(1100, 1000, monotonic, () => monotonic);
	monotonic += 1.75;
	expect(deadline(900)).toBe(999);
	monotonic += 0.25;
	expect(deadline(900)).toBe(998);
});

it("ratchets to the smallest budget observed, including at expiry", () => {
	let monotonic = 10;
	const deadline = anchorReset(1100, 1000, monotonic, () => monotonic);
	monotonic += 20;
	expect(deadline(1060)).toBe(1100);
	expect(deadline(1000)).toBe(1040);
	expect(deadline(1100)).toBe(1100);
	expect(deadline(900)).toBe(900);
	monotonic += 1;
	expect(deadline(900)).toBe(899);
});
