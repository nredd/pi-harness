/**
 * `bound` (`src/core/output.ts`) caches one spill directory per process under `os.tmpdir()` and never
 * removes it. A test file whose tools truncate output calls this at module scope: the file runs in a
 * `TMPDIR` sandbox removed after its last test, so the spill directory goes with it.
 */

import { sandboxTmpdir } from "@nredd/pi-test-lib/sandbox";
import { afterAll, beforeAll } from "vitest";

/** Sandbox `TMPDIR` for the calling file; returns a getter for the sandbox path, valid inside tests. */
export function sandboxSpillRoot(): () => string {
	let tmp: ReturnType<typeof sandboxTmpdir> | undefined;
	beforeAll(() => {
		tmp = sandboxTmpdir();
	});
	afterAll(() => tmp?.restore());
	return () => {
		if (!tmp) throw new Error("sandboxSpillRoot is only valid inside a test");
		return tmp.sandbox;
	};
}
