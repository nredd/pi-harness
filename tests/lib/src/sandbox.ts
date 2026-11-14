/** Disposable temp roots, agent dirs and config homes; each restores the environment it changed. */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Prefix of the `TMPDIR` sandbox, so leak checks can tell it from the real temp root. */
export const SANDBOX_PREFIX = "pi-test-tmp-";

/** Set (or, when `value` is undefined, delete) one environment variable. */
function setEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

/**
 * Redirect `TMPDIR` into a fresh sandbox so every `os.tmpdir()` write and helper `mkdtemp` lands in a
 * root removed on `restore`; `XDG_STATE_HOME` points at `<sandbox>/state` so state-dir writes (e.g.
 * subagent transcripts) are removed with it. The real root is exposed as `PI_TEST_REAL_TMPDIR`, and nested calls
 * sandbox inside the real one rather than inside each other.
 */
export function sandboxTmpdir(): { sandbox: string; realTmp: string; restore: () => void } {
	const realTmp = realpathSync(process.env.PI_TEST_REAL_TMPDIR ?? tmpdir());
	const previousTmpdir = process.env.TMPDIR;
	const previousReal = process.env.PI_TEST_REAL_TMPDIR;
	const previousState = process.env.XDG_STATE_HOME;
	const sandbox = realpathSync(mkdtempSync(join(realTmp, SANDBOX_PREFIX)));
	process.env.PI_TEST_REAL_TMPDIR = realTmp;
	process.env.TMPDIR = sandbox;
	process.env.XDG_STATE_HOME = join(sandbox, "state");
	return {
		sandbox,
		realTmp,
		restore() {
			setEnv("TMPDIR", previousTmpdir);
			setEnv("XDG_STATE_HOME", previousState);
			setEnv("PI_TEST_REAL_TMPDIR", previousReal);
			rmSync(sandbox, { recursive: true, force: true });
		},
	};
}

/**
 * Point `PI_CODING_AGENT_DIR` at a fresh directory under `parent`. `restore` puts back whatever the
 * variable held (a parent sandbox's directory, when nested) and removes the directory.
 */
export function sandboxAgentDir(parent = tmpdir()): { dir: string; restore: () => void } {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const dir = mkdtempSync(join(parent, "pi-test-agent-"));
	process.env.PI_CODING_AGENT_DIR = dir;
	return {
		dir,
		restore() {
			setEnv("PI_CODING_AGENT_DIR", previous);
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

/**
 * A disposable home for config I/O without mutating `HOME`, which Bun caches at process start.
 * `XDG_CONFIG_HOME` points at `<home>/.config` and `PI_CODING_AGENT_DIR` is unset. `reset` re-applies
 * that and empties `.config` and `.pi`, for a `beforeEach`; `restore` also removes the home.
 */
export function sandboxConfigHome(): { home: string; reset: () => void; restore: () => void } {
	const previous = { xdg: process.env.XDG_CONFIG_HOME, agent: process.env.PI_CODING_AGENT_DIR };
	const home = mkdtempSync(join(tmpdir(), "pi-test-home-"));
	const apply = () => {
		delete process.env.PI_CODING_AGENT_DIR;
		process.env.XDG_CONFIG_HOME = join(home, ".config");
	};
	apply();
	return {
		home,
		reset() {
			apply();
			rmSync(join(home, ".config"), { recursive: true, force: true });
			rmSync(join(home, ".pi"), { recursive: true, force: true });
		},
		restore() {
			setEnv("XDG_CONFIG_HOME", previous.xdg);
			setEnv("PI_CODING_AGENT_DIR", previous.agent);
			rmSync(home, { recursive: true, force: true });
		},
	};
}
