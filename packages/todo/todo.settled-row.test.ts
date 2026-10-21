import { describe, expect, it } from "vitest";
import { settledRow } from "./.test-support/settled-row.ts";

describe.each(["update", "delete"] as const)("settled %s live fallback", (action) => {
	it("invalidates the cached collapsed row when its task subject changes", async () => {
		const fixture = await settledRow(action);
		try {
			expect(fixture.screen()).toContain("original subject");
			fixture.change("changed subject");
			await fixture.ui.settle();
			expect(fixture.screen()).toContain("changed subject");
			expect(fixture.screen()).not.toContain("original subject");
		} finally {
			await fixture.ui.dispose();
			fixture.terminal.dispose();
		}
	});
});
