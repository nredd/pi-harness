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

/**
 * The pid a lock file names; `null` for a missing path, a directory or contents that are no pid, which no
 * live owner could have written. Any other read failure throws: an owner we could not inspect is not dead.
 */
async function owner(path: string): Promise<number | null> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if (["ENOENT", "EISDIR"].includes(String((error as NodeJS.ErrnoException).code))) return null;
		throw error;
	}
	const pid = Number(text.trim());
	return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

/** Publish `path` atomically with this process's pid in it (hard link); EEXIST if it already exists. */
async function create(path: string): Promise<void> {
	const tmp = `${path}.${randomUUID()}.tmp`;
	await writeFile(tmp, String(process.pid), { flag: "wx", mode: 0o600 });
	try {
		await link(tmp, path);
	} finally {
		await unlink(tmp);
	}
}

/**
 * Run `fn` holding the lock at `path`. A live owner fails with `busy`; a lock whose owner is dead (or whose
 * contents are no pid) is cleared.
 *
 * The lock only ever changes under a second lock, `<path>.reclaim`, created exclusively and held for the
 * few filesystem calls it takes to inspect and take `path`; a contender that cannot get it fails with
 * `busy` rather than waiting. So nobody can delete a lock between another process's check and its own
 * create, and the lock is never removed by anyone but its owner or a process that has just seen it dead.
 * Nothing recovers a guard left by a process that died inside that window: the export fails `busy` until
 * the file is deleted, never running two at once. A reused pid also reads as live; both are documented.
 */
export async function withLock<T>(path: string, busy: string, fn: () => Promise<T>): Promise<T> {
	await mkdir(dirname(path), { recursive: true });
	const guard = `${path}.reclaim`;
	try {
		await create(guard);
	} catch (error) {
		throw (error as NodeJS.ErrnoException).code === "EEXIST" ? new Error(busy) : error;
	}
	try {
		const pid = await owner(path);
		if (pid !== null && alive(pid)) throw new Error(busy);
		await rm(path, { recursive: true, force: true });
		await create(path);
	} finally {
		await rm(guard, { force: true });
	}
	try {
		return await fn();
	} finally {
		if ((await owner(path)) === process.pid) await rm(path, { force: true });
	}
}
