import { homedir } from "node:os";

/** Refuse a test boundary that could resolve fixture paths against another home. */
export function assertHomeDirectory(file: string, home = process.env.HOME, resolved = homedir()): void {
	if (home !== resolved) {
		throw new Error(
			`HOMEDIR GUARD: ${file}: os.homedir()=${JSON.stringify(resolved)} disagrees with HOME=${JSON.stringify(home)}. Inject the home directory instead of mutating HOME; launch Bun with an isolated HOME before process start.`,
		);
	}
}
