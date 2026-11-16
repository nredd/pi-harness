import { describe, expect, it } from "vitest";
import { axisLabel, duration } from "../../src/stats/format.ts";

describe("axisLabel", () => {
	it("keeps a decimal when rounding would misplace the gridline, in every unit", () => {
		expect(axisLabel(2500)).toBe("2.5k");
		expect(axisLabel(2_500_000)).toBe("2.5M");
		expect(axisLabel(2_500_000_000)).toBe("2.5B");
		expect(axisLabel(3_000_000_000)).toBe("3B");
		expect(axisLabel(500)).toBe("500");
	});
});

describe("duration", () => {
	it("drops a zero remainder at every unit", () => {
		expect(duration(2 * 86_400_000)).toBe("2d");
		expect(duration(2 * 86_400_000 + 4 * 3_600_000)).toBe("2d 4h");
		expect(duration(3 * 3_600_000)).toBe("3h");
		expect(duration(3 * 3_600_000 + 5 * 60_000)).toBe("3h 5m");
	});
});
