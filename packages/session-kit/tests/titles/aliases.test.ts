import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTestTempDir } from "@nredd/pi-test-lib/temp-dir";
import { expect, it, onTestFinished, vi } from "vitest";
import { loadModelAliases } from "../../src/titles/aliases.ts";

it("resolves default aliases only inside the disposable agent directory", () => {
	const dir = makeTestTempDir("kit-aliases-", onTestFinished);
	vi.stubEnv("PI_CODING_AGENT_DIR", dir);
	try {
		expect(loadModelAliases()).toEqual({});
		writeFileSync(join(dir, "enterprise.local.json"), "not JSON", { mode: 0o600 });
		expect(loadModelAliases()).toEqual({});
	} finally {
		vi.unstubAllEnvs();
	}
});
