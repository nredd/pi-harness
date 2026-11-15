/**
 * Child process for the file lock tests. argv: mode lockDir workDir [startAtEpochMs] [timeoutMs]
 *
 * `crit`: take the lock, then prove mutual exclusion with a sentinel file (a second holder inside
 * the critical section records a VIOLATION) and bump a counter file. `wait`: just wait on the lock
 * with nothing else keeping the event loop alive, to prove the poll timer is unref'd.
 */
import { appendFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withFileLock } from "../../src/core/filelock.ts";

const [modeArg, lockArg, workArg, startAt, timeout] = process.argv.slice(2);
if (!modeArg || !lockArg || !workArg)
	throw new Error("usage: filelock-child <mode> <lockDir> <workDir> [startAt] [timeoutMs]");

const mode: string = modeArg;
const lockDir: string = lockArg;
const workDir: string = workArg;
const sentinel = join(workDir, "inside");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function run(): Promise<unknown> {
	return withFileLock(
		lockDir,
		async () => {
			if (mode === "wait") return;
			if (existsSync(sentinel)) appendFileSync(join(workDir, "violations"), `${process.pid}\n`);
			writeFileSync(sentinel, String(process.pid));
			await sleep(40);
			rmSync(sentinel, { force: true });
			appendFileSync(join(workDir, "entered"), `${process.pid}\n`);
		},
		{ timeoutMs: Number(timeout ?? 15_000) },
	);
}

// The poll timer is unref'd, so a lone waiter lets node exit. `crit` keeps itself alive; `wait` must not.
const keepAlive = mode === "wait" ? undefined : setInterval(() => {}, 1000);
const wait = Number(startAt ?? 0) - Date.now();
setTimeout(
	() => {
		run()
			.then(
				() => process.stdout.write("ok"),
				(e) => process.stdout.write(`err:${(e as Error).message}`),
			)
			.finally(() => clearInterval(keepAlive));
	},
	Math.max(wait, 0),
);
