/**
 * Exclusive writer ownership of a child transcript across pi processes (#1247).
 *
 * A claim is a small file beside the transcript, published atomically with an
 * exclusive `link` (or, on a volume without hard links, an exclusive create),
 * that names the writing process (pid, host, PID domain and a per-claim token).
 * Every run that writes a persisted child transcript holds one for the whole
 * run and removes it when the run settles. A claim left by a crash is taken
 * over only when its holder is verifiably gone: same host, same verified PID
 * domain (Linux only: PID namespace and boot id) and `kill(pid, 0)` reports
 * `ESRCH`. Anything else (another host, another or unverified PID domain, a
 * live pid, an unreadable claim, a takeover lock left in place, a hard-linked
 * transcript) refuses the run: in doubt, nobody writes.
 */
import { randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	linkSync,
	lstatSync,
	openSync,
	readFileSync,
	readlinkSync,
	readSync,
	realpathSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { validChildPath } from "./saved-child-session.ts";

/** Appended to the canonical transcript path to name its writer claim. */
export const WRITER_CLAIM_SUFFIX = ".writer";
/** Appended to the claim path while a stale claim is being taken over. */
export const TAKEOVER_SUFFIX = ".takeover";
/** A claim is a few dozen bytes; anything larger is not one this code wrote. */
const CLAIM_MAX_BYTES = 4096;
/** `link` errors that mean the volume has no hard links (exFAT, some network shares), not a race. */
const NO_HARD_LINKS = new Set(["EPERM", "ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EXDEV"]);

/** A held claim; `release` removes it only while it is still this claim. */
export interface TranscriptClaim {
	/** The canonical transcript path the claim covers, and the one to write. */
	readonly file: string;
	release(): void;
}

interface ClaimHolder {
	pid: number;
	host: string;
	domain: string | undefined;
}

/**
 * What a pid is relative to, verified: on Linux the PID namespace plus the
 * boot id (two containers sharing a host name and a session directory see
 * different pids; two hosts can share a namespace number, never a boot id).
 * Undefined everywhere else, and on Linux when either cannot be read: a
 * platform name does not identify a PID domain (two Macs with one host name
 * sharing a sessions volume both say `darwin`), and a claim from an unknown
 * domain is never taken over automatically.
 */
export function pidDomainOf(
	platform: NodeJS.Platform,
	readLink: (path: string) => string,
	readText: (path: string) => { toString(): string },
): string | undefined {
	if (platform !== "linux") return undefined;
	try {
		const namespace = readLink("/proc/self/ns/pid");
		const boot = readText("/proc/sys/kernel/random/boot_id").toString().trim();
		return /^pid:\[\d+\]$/.test(namespace) && boot !== "" ? `${namespace} boot ${boot}` : undefined;
	} catch {
		return undefined;
	}
}

/** This process's PID domain; an object so tests can stand in for another namespace. */
export const claimHost = {
	pidDomain: (): string | undefined => pidDomainOf(process.platform, readlinkSync, readFileSync),
};

function errorCode(error: unknown): unknown {
	return (error as NodeJS.ErrnoException | undefined)?.code;
}

function removeQuietly(path: string): void {
	try {
		unlinkSync(path);
	} catch {
		/* left in place */
	}
}

/** `dev:ino` of a stat result. */
function fileId(stats: { dev: number; ino: number }): string {
	return `${stats.dev}:${stats.ino}`;
}

/**
 * Publish `body` at `path` only if nothing is there yet; false when something
 * is. The body is written to a private staging file first and linked into
 * place, so a failed write (`ENOSPC`) never leaves a partial claim: at worst a
 * stray staging file this attempt created. On a volume without hard links the
 * body is written in place with an exclusive create instead (never an
 * overwriting rename): a partial one reads as unreadable, so it refuses, and
 * a failed write removes it while it is still the file this call created.
 * Other errors pass through.
 */
function createExclusive(path: string, body: string): boolean {
	const staging = `${path}.${randomUUID()}.tmp`;
	const fd = openSync(staging, "wx");
	try {
		try {
			writeFileSync(fd, body);
		} finally {
			closeSync(fd);
		}
		linkSync(staging, path);
		return true;
	} catch (error) {
		if (errorCode(error) === "EEXIST") return false;
		if (NO_HARD_LINKS.has(errorCode(error) as string)) return createInPlace(path, body);
		throw error;
	} finally {
		removeQuietly(staging);
	}
}

/** `createExclusive` without a link: an exclusive create of `path` itself. */
function createInPlace(path: string, body: string): boolean {
	let fd: number;
	try {
		fd = openSync(path, "wx");
	} catch (error) {
		if (errorCode(error) === "EEXIST") return false;
		throw error;
	}
	const created = fileId(fstatSync(fd));
	try {
		writeFileSync(fd, body);
	} catch (error) {
		try {
			if (fileId(lstatSync(path)) === created) unlinkSync(path);
		} catch {
			/* left in place: unreadable, so it refuses */
		}
		throw error;
	} finally {
		closeSync(fd);
	}
	return true;
}

/**
 * The claim's raw text, undefined when it no longer exists, or "" (unreadable)
 * for a link, a non-regular file or one over `CLAIM_MAX_BYTES`. Only a path
 * `lstat` shows as a regular file is opened, without blocking or following
 * links where the platform can (absent flags, e.g. on Windows, read as 0),
 * and the descriptor must be that same file (`dev:ino`), so a FIFO or a
 * planted or swapped-in link cannot stall or redirect the read even without
 * `O_NOFOLLOW`. Other errors pass through.
 */
function readClaim(path: string): string | undefined {
	let before: string;
	let fd: number;
	try {
		const stats = lstatSync(path);
		if (!stats.isFile()) return "";
		before = fileId(stats);
		fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return undefined;
		if (errorCode(error) === "ELOOP") return "";
		throw error;
	}
	try {
		const stats = fstatSync(fd);
		if (!stats.isFile() || fileId(stats) !== before) return "";
		const buffer = Buffer.alloc(CLAIM_MAX_BYTES + 1);
		const length = readSync(fd, buffer, 0, buffer.length, 0);
		return length > CLAIM_MAX_BYTES ? "" : buffer.toString("utf8", 0, length);
	} finally {
		closeSync(fd);
	}
}

/** Whether anything (a file, a link, a directory) is at `path`. Errors other than missing pass through. */
function present(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch (error) {
		if (errorCode(error) === "ENOENT") return false;
		throw error;
	}
}

function parseHolder(raw: string): ClaimHolder | undefined {
	try {
		const value = JSON.parse(raw) as Partial<ClaimHolder> | null;
		if (typeof value?.pid === "number" && Number.isSafeInteger(value.pid) && value.pid > 0) {
			if (typeof value.host === "string") {
				const domain = typeof value.domain === "string" ? value.domain : undefined;
				return { pid: value.pid, host: value.host, domain };
			}
		}
	} catch {
		// Malformed: reported as unreadable below.
	}
	return undefined;
}

/** Only `ESRCH` proves the process gone; any other answer (`EPERM` included) counts as alive. */
function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return errorCode(error) !== "ESRCH";
	}
}

/** Why `raw` still holds the transcript, or undefined when its holder is verifiably gone. */
function holderReason(raw: string, claimPath: string): string | undefined {
	const holder = parseHolder(raw);
	if (holder === undefined) return `unreadable writer claim; remove ${claimPath} once no pi process writes it`;
	if (holder.host !== hostname()) {
		return `writer claim held by pid ${holder.pid} on host ${holder.host}; remove ${claimPath} once it has exited`;
	}
	// A pid from another PID namespace says nothing about this one's.
	const domain = claimHost.pidDomain();
	if (domain !== undefined && holder.domain !== undefined && holder.domain !== domain) {
		return `writer claim held by pid ${holder.pid} in another PID namespace; remove ${claimPath} once it has exited`;
	}
	if (processAlive(holder.pid)) {
		return `writer claim held by pid ${holder.pid}${holder.pid === process.pid ? " (this process)" : ""}`;
	}
	// Gone here, but without a verified domain on both sides "here" may not be where it ran.
	if (domain === undefined || holder.domain !== domain) {
		return `writer claim held by pid ${holder.pid} in an unverified PID namespace (automatic takeover needs Linux); remove ${claimPath} once it has exited`;
	}
	return undefined;
}

function inUse(reason: string, file: string): string {
	return `child session is in use (${reason}): ${file}`;
}

function takeoverRefusal(lockPath: string, file: string): Error {
	return new Error(
		`another process is taking over this child session's stale writer claim, or one crashed doing so; remove ${lockPath} if none is: ${file}`,
	);
}

/**
 * Replace a verified-stale claim under a takeover lock, so two processes that
 * both saw it stale cannot both take it. Re-reads the claim under the lock: a
 * claim that changed since it was judged stale is a new holder, not ours to drop.
 */
function takeOver(claimPath: string, stale: string, body: string, file: string): void {
	const lockPath = `${claimPath}${TAKEOVER_SUFFIX}`;
	if (!createExclusive(lockPath, body)) throw takeoverRefusal(lockPath, file);
	try {
		if (readClaim(claimPath) !== stale) {
			throw new Error(`child session's writer claim changed while it was being taken over; retry: ${file}`);
		}
		unlinkSync(claimPath);
		if (!createExclusive(claimPath, body)) {
			throw new Error(`child session was claimed by another process during takeover: ${file}`);
		}
	} finally {
		// A lock that cannot be removed keeps refusing claims, which is the safe side.
		removeQuietly(lockPath);
	}
}

/** Remove the claim at `claimPath` only while it is still `body`. */
function releaseOwn(claimPath: string, body: string): void {
	try {
		if (readClaim(claimPath) === body) unlinkSync(claimPath);
	} catch {
		/* left in place */
	}
}

/**
 * A fresh (not takeover) publish of `body` at `claimPath`; false when a claim
 * is already there. A takeover lock that appeared since the caller's probe (a
 * taker that dropped the stale claim, then crashed or is about to publish)
 * means this claim may sit where the taker's belongs: it is dropped again and
 * the run refused.
 */
function publishFresh(claimPath: string, body: string, file: string): boolean {
	if (!createExclusive(claimPath, body)) return false;
	const lockPath = `${claimPath}${TAKEOVER_SUFFIX}`;
	if (present(lockPath)) {
		releaseOwn(claimPath, body);
		throw takeoverRefusal(lockPath, file);
	}
	return true;
}

/**
 * The canonical spelling of `file` a claim covers, or undefined for a path no
 * claim can cover (relative, `..`, or a dangling link). Falls back to the
 * canonical directory only when the transcript itself does not exist yet;
 * every other error (`EACCES`, `ELOOP`, `ENOTDIR`) passes through unchanged.
 */
function canonicalTranscript(file: string): string | undefined {
	if (!validChildPath(file)) return undefined;
	try {
		return realpathSync(file);
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw error;
	}
	// Missing, or a link to nothing: a dangling link's target is not ours to name.
	if (present(file)) return undefined;
	return join(realpathSync(dirname(file)), basename(file));
}

/**
 * Take exclusive writer ownership of the transcript at `file`, or throw a
 * refusal. The claim covers the canonical spelling, so two symlinked spellings
 * share one claim; a transcript with a second hard link is refused, since its
 * other name would get a claim of its own. I/O errors other than "already
 * exists" or "missing" are rethrown unchanged.
 */
export function claimTranscript(file: string): TranscriptClaim {
	const canonical = canonicalTranscript(file);
	if (canonical === undefined) {
		throw new Error(`cannot establish writer ownership of child session: ${file}`);
	}
	const claimPath = `${canonical}${WRITER_CLAIM_SUFFIX}`;
	const lockPath = `${claimPath}${TAKEOVER_SUFFIX}`;
	// A takeover in flight, or one a crash interrupted after dropping the stale
	// claim: either way the fresh create below would not see it.
	if (present(lockPath)) throw takeoverRefusal(lockPath, file);
	const links = linkCount(canonical);
	if (links > 1) {
		throw new Error(`cannot establish writer ownership of child session with ${links} hard links: ${file}`);
	}
	const body = JSON.stringify({
		pid: process.pid,
		host: hostname(),
		domain: claimHost.pidDomain(),
		token: randomUUID(),
	});
	if (!publishFresh(claimPath, body, file)) {
		const held = readClaim(claimPath);
		// Released between the two calls: one more exclusive create decides it.
		if (held === undefined) {
			if (!publishFresh(claimPath, body, file)) {
				throw new Error(`child session was claimed by another process; retry: ${file}`);
			}
		} else {
			const reason = holderReason(held, claimPath);
			if (reason !== undefined) throw new Error(inUse(reason, file));
			takeOver(claimPath, held, body, file);
		}
	}
	return {
		file: canonical,
		release() {
			// Best effort: a claim left behind names this pid, so it refuses until
			// this process exits and is then taken over as stale (Linux) or removed.
			releaseOwn(claimPath, body);
		},
	};
}

/**
 * Why a writer claim holds the transcript at `canonicalFile` now, without
 * taking it, or undefined when it has none or only a verifiably stale one. An
 * early answer for a caller about to dispatch or report; `claimTranscript`
 * still decides. The path is used as given: pass the canonical spelling.
 */
export function writerClaimHolder(canonicalFile: string): string | undefined {
	const claimPath = `${canonicalFile}${WRITER_CLAIM_SUFFIX}`;
	const held = readClaim(claimPath);
	return held === undefined ? undefined : holderReason(held, claimPath);
}

/** `writerClaimHolder` for any spelling of `file`, as the refusal `claimTranscript` would throw. */
export function heldClaimRefusal(file: string): string | undefined {
	const canonical = canonicalTranscript(file);
	const reason = canonical === undefined ? "cannot establish writer ownership" : writerClaimHolder(canonical);
	return reason === undefined ? undefined : inUse(reason, file);
}

/** `dev:ino` of `file`, or "missing"; other stat errors pass through. */
function identity(file: string): string {
	try {
		const stats = statSync(file);
		return `${stats.dev}:${stats.ino}`;
	} catch (error) {
		if (errorCode(error) === "ENOENT") return "missing";
		throw error;
	}
}

/** Hard links to `file`, 0 when it does not exist yet; other stat errors pass through. */
function linkCount(file: string): number {
	try {
		return statSync(file).nlink;
	} catch (error) {
		if (errorCode(error) === "ENOENT") return 0;
		throw error;
	}
}

/**
 * Claim `file`, run `verify` under the claim, then `open` the canonical path
 * the claim covers, so later writes land where the claim is even if a link in
 * `file` is retargeted. Refuses when the transcript is not the same file
 * before the check and after the open. The claim is pushed onto `claims`
 * before anything can throw, so the caller releases it on every path.
 *
 * `open` takes a path, not a descriptor, so the binding is a same-file check
 * around it rather than a guarantee: a swap and swap back inside the open is
 * not detected.
 */
export function openClaimed<T>(
	file: string,
	claims: TranscriptClaim[],
	open: (canonical: string) => T,
	verify?: () => string | undefined,
): T {
	const claim = claimTranscript(file);
	claims.push(claim);
	const before = identity(claim.file);
	const refusal = verify?.();
	if (refusal !== undefined) throw new Error(refusal);
	const opened = open(claim.file);
	if (canonicalTranscript(file) !== claim.file || identity(claim.file) !== before) {
		throw new Error(`child session changed while it was being reopened: ${file}`);
	}
	return opened;
}

/**
 * Claim a freshly created persisted session's transcript (not on disk until
 * its first flush) and return the manager that writes the claimed path. When
 * the session directory was reached through a link, `recreate` builds a new
 * manager in the canonical directory instead, so a link retargeted mid-run
 * cannot move the writes away from the claim. Claims go onto `claims`.
 */
export function claimCreated<T extends { getSessionFile?(): string | undefined }>(
	manager: T,
	claims: TranscriptClaim[],
	recreate: (canonicalDir: string) => T,
): T {
	const file = manager.getSessionFile?.();
	if (!file) return manager;
	const claim = claimTranscript(file);
	claims.push(claim);
	if (claim.file === file) return manager;
	claim.release();
	// Nothing is on disk yet, so dropping the first manager loses nothing.
	return claimCreated(recreate(dirname(claim.file)), claims, () => {
		throw new Error(`child session directory changed while the session was created: ${claim.file}`);
	});
}
