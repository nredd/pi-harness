/** Disposable executable boundary: tests exercise our argv/exit/output mapping, not third-party implementations. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTestTempDir } from "@nredd/pi-test-lib/temp-dir";
import { onTestFinished } from "vitest";

export function wrapperFixture(manifest: "Cargo.toml" | "pyproject.toml") {
	const root = makeTestTempDir("dev-tools-wrapper-", onTestFinished);
	writeFileSync(join(root, manifest), "");
	const bin = join(root, "tool");
	return {
		root,
		bin,
		/**
		 * Replace only the private executable, keeping the wrapper's real process runner and locks.
		 * `interpreter` defaults to this runtime; `/bin/sh` starts far cheaper for exit-only bodies.
		 */
		script(body: string, interpreter = process.execPath) {
			writeFileSync(bin, `#!${interpreter}\n${body}\n`, { mode: 0o700 });
		},
	};
}
