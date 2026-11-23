/**
 * Exclusive writer ownership of a child transcript across pi processes (#1247).
 *
 * A claim is a small file beside the transcript, created with `O_EXCL`, that
 * names the writing process (pid, host and a per-claim token). Every run that
 * writes a persisted child transcript holds one for the whole run and removes
 * it when the run settles. A claim left by a crash is taken over only when its
 * holder is verifiably gone: same host and `kill(pid, 0)` reports `ESRCH`.
 * Anything else (another host, a live or unknown pid, an unreadable claim, a
 * takeover already in progress) refuses the run: in doubt, nobody writes.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { canonicalChildPath } from "./saved-child-session.ts";

/** Appended to the canonical transcript path to name its writer claim. */
export const WRITER_CLAIM_SUFFIX = ".writer";
/** Appended to the claim path while a stale claim is being taken over. */
export const TAKEOVER_SUFFIX = ".takeover";

/** A held claim; `release` removes it only while it is still this claim. */
export interface TranscriptClaim {
	/** The canonical transcript path the claim covers. */
	readonly file: string;
	release(): void;
}

interface ClaimHolder {
	pid: number;
	host: string;
}

function errorCode(error: unknown): unknown {
	return (error as NodeJS.ErrnoException | undefined)?.code;
}

/** Create `path` exclusively; false when it already exists. Other errors pass through. */
function createExclusive(path: string, body: string): boolean {
	try {
		writeFileSync(path, body, { flag: "wx" });
		return true;
	} catch (error) {
		if (errorCode(error) === "EEXIST") return false;
		throw error;
	}
}

/** The claim's raw text, or undefined when it no longer exists. */
function readClaim(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		if (errorCode(error) === "ENOENT") return undefined;
		throw error;
	}
}

function parseHolder(raw: string): ClaimHolder | undefined {
	try {
		const value = JSON.parse(raw) as Partial<ClaimHolder> | null;
		if (typeof value?.pid === "number" && Number.isSafeInteger(value.pid) && value.pid > 0) {
			if (typeof value.host === "string") return { pid: value.pid, host: value.host };
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
	if (!processAlive(holder.pid)) return undefined;
	return `writer claim held by pid ${holder.pid}${holder.pid === process.pid ? " (this process)" : ""}`;
}

function inUse(reason: string, file: string): string {
	return `child session is in use (${reason}): ${file}`;
}

/**
 * Replace a verified-stale claim under a takeover lock, so two processes that
 * both saw it stale cannot both take it. Re-reads the claim under the lock: a
 * claim that changed since it was judged stale is a new holder, not ours to drop.
 */
function takeOver(claimPath: string, stale: string, body: string, file: string): void {
	const lockPath = `${claimPath}${TAKEOVER_SUFFIX}`;
	if (!createExclusive(lockPath, body)) {
		throw new Error(
			`another process is taking over this child session's stale writer claim; remove ${lockPath} if none is: ${file}`,
		);
	}
	try {
		if (readClaim(claimPath) !== stale) {
			throw new Error(`child session's writer claim changed while it was being taken over; retry: ${file}`);
		}
		unlinkSync(claimPath);
		if (!createExclusive(claimPath, body)) {
			throw new Error(`child session was claimed by another process during takeover: ${file}`);
		}
	} finally {
		// A lock that cannot be removed keeps refusing takeovers, which is the safe side.
		try {
			unlinkSync(lockPath);
		} catch {
			/* left in place */
		}
	}
}

/**
 * Take exclusive writer ownership of the transcript at `file`, or throw a
 * refusal. The claim covers the canonical spelling, so two links to one
 * transcript share one claim. I/O errors other than "already exists" or
 * "missing" are rethrown unchanged.
 */
export function claimTranscript(file: string): TranscriptClaim {
	const canonical = canonicalChildPath(file);
	if (canonical === undefined) {
		throw new Error(`cannot establish writer ownership of child session: ${file}`);
	}
	const claimPath = `${canonical}${WRITER_CLAIM_SUFFIX}`;
	const body = JSON.stringify({ pid: process.pid, host: hostname(), token: randomUUID() });
	if (!createExclusive(claimPath, body)) {
		const held = readClaim(claimPath);
		// Released between the two calls: one more exclusive create decides it.
		if (held === undefined) {
			if (!createExclusive(claimPath, body)) {
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
			// this process exits and is then taken over as stale.
			try {
				if (readClaim(claimPath) === body) unlinkSync(claimPath);
			} catch {
				/* left in place */
			}
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
	const canonical = canonicalChildPath(file);
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

/**
 * Claim `file`, run `verify` under the claim, then `open` it, refusing when
 * the transcript `file` names is not the same file before the check and after
 * the open. The claim is pushed onto `claims` before anything can throw, so
 * the caller releases it on every path.
 *
 * `open` takes a path, not a descriptor, so the binding is a same-file check
 * around it rather than a guarantee: a swap and swap back inside the open is
 * not detected.
 */
export function openClaimed<T>(
	file: string,
	claims: TranscriptClaim[],
	open: () => T,
	verify?: () => string | undefined,
): T {
	const claim = claimTranscript(file);
	claims.push(claim);
	const before = identity(claim.file);
	const refusal = verify?.();
	if (refusal !== undefined) throw new Error(refusal);
	const opened = open();
	if (canonicalChildPath(file) !== claim.file || identity(claim.file) !== before) {
		throw new Error(`child session changed while it was being reopened: ${file}`);
	}
	return opened;
}
