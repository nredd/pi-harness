import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize, sep } from "node:path";

/** Retry transient removal errors such as EBUSY and EPERM. */
export const CLEANUP_RETRY_OPTIONS = { maxRetries: 3, retryDelay: 50 } as const;

/**
 * Allocate a scratch directory and register its removal with the owning test's cleanup hook.
 * `baseDir` defaults to the OS temp directory. Set it to an existing directory when a fixture
 * must live there, and pass a prefix relative to that base: with an explicit `baseDir` an absolute
 * prefix or one that climbs out of the base (`..`) throws, so the fixture always stays inside it.
 */
export function makeTestTempDir(
	prefix: string,
	onCleanup: (cleanup: () => void) => void,
	{ baseDir = tmpdir() }: { baseDir?: string } = {},
): string {
	if (baseDir !== tmpdir() && (isAbsolute(prefix) || normalize(prefix).split(sep).includes(".."))) {
		throw new Error(`makeTestTempDir prefix must stay inside baseDir: ${JSON.stringify(prefix)}`);
	}
	const dir = mkdtempSync(join(baseDir, prefix));
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
