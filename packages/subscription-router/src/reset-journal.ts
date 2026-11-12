/** Private append-only redemption ledger. Exclusive publication serializes fresh attempts across processes. */
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import { CodexResetError } from "./codex-contract.js";

export const AttemptSchema = Type.Object(
	{
		version: Type.Literal(1),
		sequence: Type.Integer({ minimum: 1 }),
		binding: Type.String({ pattern: "^[a-f0-9]{64}$" }),
		scope: Type.String({ pattern: "^[a-f0-9]{64}$" }),
		key: Type.String({ pattern: "^[a-f0-9-]{36}$" }),
		grant: Type.String({ minLength: 1, maxLength: 1024 }),
		createdAt: Type.Integer({ minimum: 0 }),
		expiry: Type.Integer({ minimum: 0 }),
	},
	{ additionalProperties: false },
);
export const OutcomeSchema = Type.Object(
	{
		version: Type.Literal(1),
		key: Type.String({ pattern: "^[a-f0-9-]{36}$" }),
		outcome: Type.Union([
			Type.Literal("reset"),
			Type.Literal("alreadyRedeemed"),
			Type.Literal("nothingToReset"),
			Type.Literal("noCredit"),
			Type.Literal("notDispatched"),
		]),
	},
	{ additionalProperties: false },
);
export type ResetAttempt = Static<typeof AttemptSchema>;
export type ResetOutcome = Static<typeof OutcomeSchema>["outcome"];

/** Recognize only expected filesystem absences/conflicts; permission/corruption errors fail closed. */
function code(error: unknown, expected: string): boolean {
	return error instanceof Error && "code" in error && error.code === expected;
}

/** Existing insecure/symlink state is rejected, never silently repaired or read. */
async function privateDirectory(path: string): Promise<void> {
	await mkdir(path, { recursive: true, mode: 0o700 });
	const stat = await lstat(path);
	if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
		throw new CodexResetError("journal", "Codex reset state directory must be private and not a symlink.");
}

/** Read only private regular files, bounded before JSON parsing. */
async function read(path: string): Promise<unknown | undefined> {
	try {
		const stat = await lstat(path);
		if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.size > 8192) throw new Error();
		const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			return JSON.parse(await handle.readFile("utf8"));
		} finally {
			await handle.close();
		}
	} catch (error) {
		if (code(error, "ENOENT")) return undefined;
		throw new CodexResetError(
			"journal",
			"Codex reset state is unreadable, insecure or invalid; no mutation permitted.",
		);
	}
}

/** Publish a fully written/fsynced immutable file without overwriting another process's claim. */
async function publish(path: string, value: unknown): Promise<boolean> {
	const temporary = join(dirname(path), `.write-${randomUUID()}`);
	const handle = await open(temporary, "wx", 0o600);
	try {
		await handle.writeFile(JSON.stringify(value));
		await handle.sync();
		await handle.close();
		try {
			await link(temporary, path);
		} catch (error) {
			if (code(error, "EEXIST")) return false;
			throw error;
		}
		const directory = await open(dirname(path), "r");
		try {
			await directory.sync();
		} finally {
			await directory.close();
		}
		return true;
	} finally {
		await handle.close();
		await unlink(temporary);
	}
}

/** IDs are local-only state; no tokens, account identifiers, raw server responses or private URLs are stored. */
export class ResetJournal {
	private readonly directory: string;
	constructor(
		private readonly root: string,
		private readonly scope: string,
		private readonly binding: string = scope,
	) {
		if (!/^[a-f0-9]{64}$/.test(binding) || !/^[a-f0-9]{64}$/.test(scope))
			throw new CodexResetError("journal", "Invalid reset account binding.");
		this.directory = join(root, scope);
	}

	/** Returns all immutable receipts, rejecting gaps/corruption rather than guessing whether a call dispatched. */
	async entries(): Promise<{ attempt: ResetAttempt; outcome?: ResetOutcome }[]> {
		await privateDirectory(this.root);
		await privateDirectory(this.directory);
		const names = await readdir(this.directory);
		const sequences = names
			.filter((name) => /^attempt-[1-9]\d*\.json$/.test(name))
			.map((name) => Number(name.slice(8, -5)))
			.sort((a, b) => a - b);
		if (names.some((name) => !/^(attempt|outcome)-[1-9]\d*\.json$|^\.write-[a-f0-9-]{36}$/.test(name)))
			throw new CodexResetError("journal", "Unrecognized Codex reset state; no mutation permitted.");
		const entries: { attempt: ResetAttempt; outcome?: ResetOutcome }[] = [];
		for (const [index, sequence] of sequences.entries()) {
			const attempt = await read(join(this.directory, `attempt-${sequence}.json`));
			const result = await read(join(this.directory, `outcome-${sequence}.json`));
			if (
				!Check(AttemptSchema, attempt) ||
				attempt.scope !== this.scope ||
				attempt.sequence !== sequence ||
				sequence !== index + 1 ||
				(index > 0 && entries[index - 1]?.outcome === undefined) ||
				(result !== undefined && (!Check(OutcomeSchema, result) || result.key !== attempt.key))
			)
				throw new CodexResetError("journal", "Codex reset journal is inconsistent; reconcile through the official UI.");
			entries.push({
				attempt,
				outcome: result === undefined ? undefined : (result as Static<typeof OutcomeSchema>).outcome,
			});
		}
		if (names.some((name) => /^outcome-/.test(name) && !sequences.includes(Number(name.slice(8, -5)))))
			throw new CodexResetError("journal", "Codex reset receipt has no matching attempt.");
		return entries;
	}

	/** A second process can claim only the same next sequence, and exclusive publication admits just one. */
	async claim(grant: string, now: number, expiry: number): Promise<ResetAttempt> {
		const entries = await this.entries();
		if (
			entries.some(
				({ outcome, attempt }) =>
					outcome === undefined || (attempt.grant === grant && (outcome === "reset" || outcome === "alreadyRedeemed")),
			)
		)
			throw new CodexResetError("busy", "An unresolved or already-used reset prevents a new attempt; reconcile first.");
		const attempt: ResetAttempt = {
			version: 1,
			sequence: entries.length + 1,
			binding: this.binding,
			scope: this.scope,
			key: randomUUID(),
			grant,
			createdAt: now,
			expiry,
		};
		if (!Check(AttemptSchema, attempt)) throw new CodexResetError("journal", "Reset attempt could not be validated.");
		if (!(await publish(join(this.directory, `attempt-${attempt.sequence}.json`), attempt)))
			throw new CodexResetError("busy", "Another reset attempt won admission; no additional reset dispatched.");
		return attempt;
	}

	/** Only supported, known outcomes settle an attempt. Absent receipt means pending/unknown, including after reload. */
	async settle(attempt: ResetAttempt, outcome: ResetOutcome): Promise<void> {
		const receipt = { version: 1, key: attempt.key, outcome };
		if (!Check(OutcomeSchema, receipt) || attempt.binding !== this.binding || attempt.scope !== this.scope)
			throw new CodexResetError("journal", "Invalid Codex reset receipt.");
		const path = join(this.directory, `outcome-${attempt.sequence}.json`);
		if (!(await publish(path, receipt))) {
			const existing = await read(path);
			if (
				!Check(OutcomeSchema, existing) ||
				existing.key !== attempt.key ||
				(existing.outcome !== outcome &&
					!(["reset", "alreadyRedeemed"].includes(existing.outcome) && ["reset", "alreadyRedeemed"].includes(outcome)))
			)
				throw new CodexResetError("unknown", "Conflicting reset evidence; do not consume another grant.");
		}
	}
}
