import { homedir } from "node:os";

/** Refuse a test boundary that could resolve fixture paths against another home. */
export function assertHomeDirectory(file: string, home = process.env.HOME, resolved = homedir()): void {
	if (home !== resolved) {
		throw new Error(
			`HOMEDIR GUARD: ${file}: os.homedir()=${JSON.stringify(resolved)} disagrees with HOME=${JSON.stringify(home)}. Inject the home directory instead of mutating HOME; launch Bun with an isolated HOME before process start.`,
		);
	}
}

/** The slice of a Vitest per-test hook the guard reads. */
export type GuardListener = (context: { task: { file: { filepath: string } } }) => void;

/**
 * Check the home at worker setup, then before and after every test.
 *
 * Parameters:
 *   testPath (string | undefined): file the worker is setting up, when Vitest knows it.
 *   hooks ({ beforeEach, afterEach }): Vitest's registration functions; tests inject recorders.
 *
 * Raises:
 *   Error: HOME already disagrees with os.homedir() at setup.
 */
export function installHomeGuard(
	testPath: string | undefined,
	hooks: { beforeEach(listener: GuardListener): void; afterEach(listener: GuardListener): void },
): void {
	assertHomeDirectory(testPath ?? "<unknown test file>");
	hooks.beforeEach(({ task }) => assertHomeDirectory(task.file.filepath));
	hooks.afterEach(({ task }) => assertHomeDirectory(task.file.filepath));
}
