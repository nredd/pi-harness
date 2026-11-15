/** Run a child in its own process group and kill the whole group on timeout, so no descendant outlives the test. */
import { type ChildProcess, spawn } from "node:child_process";

export interface TreeResult {
	status: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	/** Set when the child could not be spawned. */
	error?: Error;
}

/**
 * Parameters:
 *   command (string): executable.
 *   args (string[]): its arguments.
 *   options ({ cwd, env, timeoutMs, platform }): `timeoutMs` bounds the whole tree, not just the leader;
 *     `platform` defaults to the host and only a test overrides it.
 *
 * Returns:
 *   Promise<TreeResult>: resolves on `close`, so every inherited pipe has drained.
 */
export function runTree(
	command: string,
	args: string[],
	options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number; platform?: NodeJS.Platform },
): Promise<TreeResult> {
	const windows = (options.platform ?? process.platform) === "win32";
	return new Promise((resolve) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env,
			detached: !windows,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let error: Error | undefined;
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk;
		});
		const timer = setTimeout(() => {
			timedOut = true;
			killTree(child, windows);
		}, options.timeoutMs);
		child.on("error", (spawnError) => {
			error = spawnError;
		});
		child.on("close", (status, signal) => {
			clearTimeout(timer);
			resolve({ status, signal, stdout, stderr, timedOut, error });
		});
	});
}

/** SIGKILL the child's whole group; an already-gone group is dead, and Windows has no groups to signal. */
function killTree(child: ChildProcess, windows: boolean): void {
	if (windows) {
		child.kill("SIGKILL");
		return;
	}
	try {
		// A negative pid signals the group the detached child leads; a spawn failure clears the timer first.
		process.kill(-(child.pid as number), "SIGKILL");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill("SIGKILL");
	}
}
