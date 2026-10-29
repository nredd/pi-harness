import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Pass the temporary home through the production seam rather than mutating HOME.
const home = mkdtempSync(join(tmpdir(), "rpiv-todo-bun-"));
process.env.PI_OFFLINE = "1";
delete process.env.PI_CODING_AGENT_DIR;
process.env.XDG_CONFIG_HOME = join(home, ".config");
const { settledRow } = await import("./settled-row.ts");
afterAll(() => rmSync(home, { recursive: true, force: true }));

for (const action of ["update", "delete"] as const) {
	describe(`settled ${action} live fallback`, () => {
		it("invalidates the real collapsed TUI row", async () => {
			const fixture = await settledRow(action, home);
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
}
