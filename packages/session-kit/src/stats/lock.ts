/** Exclusive, dead-owner-reclaiming lock file. Node builtins only. */
import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
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

/** Publish `path` atomically with this process's pid in it (hard link); `false` if it already exists. */
async function tryAcquire(path: string): Promise<boolean> {
	const tmp = `${path}.${randomUUID()}.tmp`;
	await writeFile(tmp, String(process.pid), { flag: "wx", mode: 0o600 });
	try {
		await link(tmp, path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	} finally {
		await unlink(tmp);
	}
}

/** Take attempts before giving up: each one either gets the lock or sees another process make progress. */
const ATTEMPTS = 3;

/**
 * Run `fn` holding the lock at `path`; a live owner fails with `busy`. A lock whose owner is dead (or whose
 * contents are no pid) is reclaimed under a second lock, `<path>.reclaim`: reclaimers take turns, and each
 * re-reads the lock once it holds that guard, so one that lost the race sees its predecessor's live lock and
 * leaves it alone instead of deleting it. A guard left by a dead reclaimer is cleared the same way.
 */
export async function withLock<T>(path: string, busy: string, fn: () => Promise<T>): Promise<T> {
	await mkdir(dirname(path), { recursive: true });
	const guard = `${path}.reclaim`;
	let held = false;
	for (let attempt = 0; !held; attempt++) {
		held = await tryAcquire(path);
		if (held) break;
		const pid = await owner(path);
		if (attempt === ATTEMPTS - 1 || (pid !== null && alive(pid))) throw new Error(busy);
		if (await tryAcquire(guard)) {
			try {
				const now = await owner(path);
				if (now === null || !alive(now)) await rm(path, { recursive: true, force: true });
			} finally {
				await rm(guard, { force: true });
			}
		} else {
			const reclaimer = await owner(guard);
			if (reclaimer === null || !alive(reclaimer)) await rm(guard, { recursive: true, force: true });
		}
	}
	try {
		return await fn();
	} finally {
		if ((await owner(path)) === process.pid) await rm(path, { force: true });
	}
}
