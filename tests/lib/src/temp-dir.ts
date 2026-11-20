import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Retry transient removal errors such as EBUSY and EPERM. */
export const CLEANUP_RETRY_OPTIONS = { maxRetries: 3, retryDelay: 50 } as const;

/** Allocate a scratch directory and register its removal with the owning test's cleanup hook. */
export function makeTestTempDir(prefix: string, onCleanup: (cleanup: () => void) => void): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	const cleanup = () => rmSync(dir, { recursive: true, force: true, ...CLEANUP_RETRY_OPTIONS });
	try {
		onCleanup(cleanup);
	} catch (error) {
		try {
			cleanup();
		} catch (cleanupError) {
			throw new AggregateError([error, cleanupError], "Could not register or remove the test scratch directory");
		}
		throw error;
	}
	return dir;
}
