import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readClaude } from "../../../src/stats/harness/claude.ts";
import { probe } from "../../../src/stats/harness/common.ts";
import { readOpenCode } from "../../../src/stats/harness/opencode.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "psk-probe-"));
});
afterEach(() => {
	chmodSync(join(dir, "locked"), 0o700);
	rmSync(dir, { recursive: true, force: true });
});

/** A path whose parent cannot be searched: `stat` fails with EACCES, not ENOENT. */
function locked(): string {
	mkdirSync(join(dir, "locked", "inner"), { recursive: true });
	writeFileSync(join(dir, "locked", "inner", "opencode.db"), "x");
	chmodSync(join(dir, "locked"), 0o000);
	return join(dir, "locked", "inner");
}
const asRoot = process.getuid?.() === 0;

describe("probe", () => {
	it("reports only a missing path or the wrong kind as absent", async () => {
		writeFileSync(join(dir, "file"), "x");
		mkdirSync(join(dir, "locked"));
		expect(await probe(join(dir, "file"), "file")).toBe("found");
		expect(await probe(join(dir, "locked"), "directory")).toBe("found");
		expect(await probe(join(dir, "none"), "file")).toBe("absent");
		expect(await probe(join(dir, "file", "below"), "directory")).toBe("absent");
		expect(await probe(join(dir, "file"), "directory")).toBe("absent");
		expect(await probe(join(dir, "locked"), "file")).toBe("absent");
	});

	it.skipIf(asRoot)("reports an inaccessible path as unreadable, never as not installed", async () => {
		const inner = locked();
		expect(await probe(inner, "directory")).toBe("unreadable");
		expect(await readClaude(inner, {})).toMatchObject({
			found: true,
			calls: [],
			problems: ["claude: root unreadable"],
		});
		expect(await readOpenCode(join(inner, "opencode.db"))).toMatchObject({
			found: true,
			calls: [],
			problems: ["opencode: database inaccessible, skipped"],
		});
	});
});
