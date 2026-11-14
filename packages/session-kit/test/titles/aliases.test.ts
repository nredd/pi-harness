import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { loadModelAliases } from "../../src/titles/aliases.ts";

it("resolves default aliases only inside the disposable agent directory", () => {
	const dir = mkdtempSync(join(tmpdir(), "kit-aliases-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", dir);
	try {
		expect(loadModelAliases()).toEqual({});
		writeFileSync(join(dir, "enterprise.local.json"), "not JSON", { mode: 0o600 });
		expect(loadModelAliases()).toEqual({});
	} finally {
		vi.unstubAllEnvs();
		rmSync(dir, { recursive: true, force: true });
	}
});
