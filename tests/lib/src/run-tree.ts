/** Run a child in its own process group and kill the whole group on timeout, so no descendant outlives the test. */
import { spawn } from "node:child_process";

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
 *   options ({ cwd, env, timeoutMs }): `timeoutMs` bounds the whole tree, not just the leader.
 *
 * Returns:
 *   Promise<TreeResult>: resolves on `close`, so every inherited pipe has drained.
 */
export function runTree(
	command: string,
	args: string[],
	options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<TreeResult> {
	return new Promise((resolve) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env,
			detached: true,
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
			// A negative pid signals the group the detached child leads; a spawn failure clears this timer first.
			process.kill(-(child.pid as number), "SIGKILL");
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
