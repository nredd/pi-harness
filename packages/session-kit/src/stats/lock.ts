/** Exclusive, dead-owner-reclaiming lock file. Node builtins only. */
import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Whether `pid` is a live process: EPERM means it exists but is not ours. */
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** The pid a lock file names; `null` for anything else, which no live owner could have written. */
async function owner(path: string): Promise<number | null> {
	try {
		const pid = Number((await readFile(path, "utf8")).trim());
		return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
	} catch {
		return null;
	}
}

/** Publish `path` atomically with this process's pid in it (hard link), failing with EEXIST if held. */
async function acquire(path: string): Promise<void> {
	const tmp = `${path}.${randomUUID()}.tmp`;
	await writeFile(tmp, String(process.pid), { flag: "wx", mode: 0o600 });
	try {
		await link(tmp, path);
	} finally {
		await unlink(tmp);
	}
}

/**
 * Run `fn` holding the lock at `path`. A lock whose owner is dead is reclaimed (renamed away first, so two
 * reclaimers cannot both delete a live successor's lock); a live owner fails with `busy`.
 */
export async function withLock<T>(path: string, busy: string, fn: () => Promise<T>): Promise<T> {
	await mkdir(dirname(path), { recursive: true });
	for (let attempt = 0; ; attempt++) {
		try {
			await acquire(path);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const pid = await owner(path);
			// Still held after one reclaim means another process won the race for it.
			if (attempt > 0 || (pid !== null && alive(pid))) throw new Error(busy);
			const stale = `${path}.stale-${randomUUID()}`;
			// Losing this rename means another process is reclaiming the same dead lock: it owns the next step.
			await rename(path, stale).catch(() => {
				throw new Error(busy);
			});
			await rm(stale, { recursive: true, force: true });
		}
	}
	try {
		return await fn();
	} finally {
		if ((await owner(path)) === process.pid) await rm(path, { force: true });
	}
}
