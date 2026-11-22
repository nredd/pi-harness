import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";

/** Retry transient removal errors such as EBUSY and EPERM. */
export const CLEANUP_RETRY_OPTIONS = { maxRetries: 3, retryDelay: 50 } as const;

/**
 * Allocate a scratch directory whose removal the caller owns, for helpers with their own lifecycle
 * (a `restore` or a `finally`) rather than a test hook. `remove` is idempotent and targets the path
 * resolved at allocation, so a later `cwd` change under a relative `TMPDIR` or `baseDir` cannot
 * redirect it. `baseDir` and the prefix rules match `makeTestTempDir`.
 */
export function makeOwnedTempDir(
	prefix: string,
	{ baseDir = tmpdir() }: { baseDir?: string } = {},
): { dir: string; remove: () => void } {
	if (baseDir !== tmpdir() && (isAbsolute(prefix) || normalize(prefix).split(sep).includes(".."))) {
		throw new Error(`Test temp dir prefix must stay inside baseDir: ${JSON.stringify(prefix)}`);
	}
	const dir = mkdtempSync(join(baseDir, prefix));
	const target = resolve(dir);
	return { dir, remove: () => rmSync(target, { recursive: true, force: true, ...CLEANUP_RETRY_OPTIONS }) };
}

/**
 * Allocate a scratch directory and register its removal with the owning test's cleanup hook.
 * `baseDir` defaults to the OS temp directory. Set it to an existing directory when a fixture
 * must live there, and pass a prefix relative to that base: with an explicit `baseDir` an absolute
 * prefix or one that climbs out of the base (`..`) throws, so the fixture always stays inside it.
 */
export function makeTestTempDir(
	prefix: string,
	onCleanup: (cleanup: () => void) => void,
	options: { baseDir?: string } = {},
): string {
	const { dir, remove: cleanup } = makeOwnedTempDir(prefix, options);
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
