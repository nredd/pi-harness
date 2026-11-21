/** Keep exact project path assertions independent of a symlinked OS temp root. */
import { realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestTempDir } from "@nredd/pi-test-lib/temp-dir";
import { expect, it, onTestFinished, vi } from "vitest";
import { hermeticDir } from "./fixtures/boot-extension.ts";

it("canonicalizes hermetic roots before exposing paths or changing cwd", () => {
	const root = realpathSync(makeTestTempDir("pi-hermetic-link-", onTestFinished));
	const alias = join(root, "alias");
	symlinkSync(root, alias, "dir");
	vi.stubEnv("TMPDIR", alias);
	try {
		expect(tmpdir()).toBe(alias);
		const env = hermeticDir();
		try {
			expect(env.dir).toBe(realpathSync(env.dir));
			expect(env.dir).toBe(process.cwd());
			expect(process.env.PI_CODING_AGENT_DIR).toBe(realpathSync(process.env.PI_CODING_AGENT_DIR!));
		} finally {
			env.restore();
		}
	} finally {
		vi.unstubAllEnvs();
	}
});
