/** Disposable executable boundary: tests exercise our argv/exit/output mapping, not third-party implementations. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function wrapperFixture(manifest: "Cargo.toml" | "pyproject.toml") {
	const root = mkdtempSync(join(tmpdir(), "dev-tools-wrapper-"));
	writeFileSync(join(root, manifest), "");
	const bin = join(root, "tool");
	return {
		root,
		bin,
		/** Replace only the private executable, keeping the wrapper's real process runner and locks. */
		script(body: string) {
			writeFileSync(bin, `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
		},
		cleanup() {
			rmSync(root, { recursive: true, force: true });
		},
	};
}
