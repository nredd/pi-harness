/** The supported Codex rust-v0.167.2 app-server subset, never its private HTTP implementation. */
import { createHash } from "node:crypto";

export const CODEX_VERSION = "0.167.2";
export const CODEX_PROVIDER = "openai-codex";

/** Sanitized failures: server payloads, credentials and account identifiers never enter messages. */
export class CodexResetError extends Error {
	constructor(
		readonly kind: string,
		message: string,
	) {
		super(message);
		this.name = "CodexResetError";
	}
}

/** JWT-derived routing identity is trusted only as supplied by Pi's credential owner, not as JWT verification. */
export interface CodexIdentity {
	token: string;
	account: string;
	fingerprint: string;
	accountScope: string;
}

/** Bind both the principal and workspace; token rotation must not change this binding. */
export function codexIdentity(token: string | undefined): CodexIdentity {
	try {
		if (typeof token !== "string") throw new Error();
		const parts = token.split(".");
		const encoded = parts[1];
		if (parts.length !== 3 || !encoded) throw new Error();
		const claims = record(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")));
		const auth = record(claims["https://api.openai.com/auth"]);
		const account = auth.chatgpt_account_id;
		const principal = claims.sub;
		if (typeof account !== "string" || !account || typeof principal !== "string" || !principal) throw new Error();
		return {
			token,
			account,
			accountScope: createHash("sha256").update(account).digest("hex"),
			fingerprint: createHash("sha256")
				.update(JSON.stringify([principal, account]))
				.digest("hex"),
		};
	} catch {
		throw new CodexResetError(
			"authentication",
			"Current Pi Codex OAuth identity is unavailable; no separate CLI account will be used.",
		);
	}
}

/** Bound our wait on Pi-owned credential refresh without cancelling that shared credential owner. */
export async function readIdentity(
	getToken: () => Promise<string | undefined>,
	signal?: AbortSignal,
	timeoutMs = 10_000,
): Promise<CodexIdentity> {
	if (signal?.aborted) throw new CodexResetError("cancelled", "Codex authentication cancelled.");
	let timer: ReturnType<typeof setTimeout> | undefined;
	let abort: (() => void) | undefined;
	try {
		const identity = await Promise.race([
			getToken().then(codexIdentity),
			new Promise<never>((_resolve, reject) => {
				abort = () => reject(new CodexResetError("cancelled", "Codex authentication cancelled."));
				timer = setTimeout(
					() => reject(new CodexResetError("authentication", "Pi Codex credential lookup timed out.")),
					timeoutMs,
				);
				if (signal?.aborted) abort();
				else signal?.addEventListener("abort", abort, { once: true });
			}),
		]);
		if (signal?.aborted) throw new CodexResetError("cancelled", "Codex authentication cancelled.");
		return identity;
	} catch (error) {
		if (error instanceof CodexResetError) throw error;
		throw new CodexResetError("authentication", "Pi Codex credential lookup failed.");
	} finally {
		clearTimeout(timer);
		if (abort) signal?.removeEventListener("abort", abort);
	}
}

/** Safe object access at an untrusted protocol boundary. */
export function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new CodexResetError("protocol", "Codex returned an unsupported response shape.");
	return value as Record<string, unknown>;
}

/** One provider-reported promotional grant. Opaque IDs stay private and are never rendered. */
export interface ResetGrant {
	id: string;
	type: string;
	status: string;
	grantedAt: number;
	expiresAt: number | null;
}
export interface CodexOffers {
	count: number | null;
	grants: ResetGrant[] | null;
	/** Usage percentages, not fabricated allowance or per-grant applicability. */
	used: number[];
	checkedAt: number;
}

/** Validate provider values rather than interpreting absent detail as a verified empty balance. */
export function parseOffers(payload: unknown, now: number): CodexOffers {
	const root = record(payload);
	const limits = record(root.rateLimits);
	const used: number[] = [];
	for (const field of [limits.primary, limits.secondary]) {
		if (field == null) continue;
		const percent = record(field).usedPercent;
		if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0 || percent > 100)
			throw new CodexResetError("protocol", "Codex reported invalid quota usage.");
		used.push(percent);
	}
	const summary = root.rateLimitResetCredits == null ? null : record(root.rateLimitResetCredits);
	if (!summary) return { count: null, grants: null, used, checkedAt: now };
	const count = summary.availableCount;
	if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)
		throw new CodexResetError("protocol", "Codex reported an invalid reset balance.");
	if (summary.credits == null) return { count, grants: null, used, checkedAt: now };
	if (!Array.isArray(summary.credits)) throw new CodexResetError("protocol", "Codex reset details are unavailable.");
	const grants = summary.credits.map((value) => {
		const row = record(value);
		if (
			typeof row.id !== "string" ||
			!row.id ||
			row.id.length > 1024 ||
			typeof row.resetType !== "string" ||
			typeof row.status !== "string" ||
			!validSeconds(row.grantedAt) ||
			(row.expiresAt !== null && !validSeconds(row.expiresAt))
		)
			throw new CodexResetError("protocol", "Codex reported invalid reset details.");
		return {
			id: row.id,
			type: row.resetType,
			status: row.status,
			grantedAt: row.grantedAt * 1000,
			expiresAt: row.expiresAt === null ? null : row.expiresAt * 1000,
		};
	});
	if (new Set(grants.map((grant) => grant.id)).size !== grants.length)
		throw new CodexResetError("protocol", "Codex reported duplicate reset details.");
	return { count, grants, used, checkedAt: now };
}

/** Epoch seconds must fit a representable Date before conversion. */
function validSeconds(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && Number.isFinite(new Date(value * 1000).getTime());
}

/** Unknown/expired/ineligible grants never dispatch a mutation; the server remains the eligibility authority. */
export function eligibleGrant(offers: CodexOffers, id: string, now: number): ResetGrant & { expiresAt: number } {
	const grant = offers.grants?.find((item) => item.id === id);
	if (offers.count === 0)
		throw new CodexResetError("ineligible", "FREE reset eligibility: the provider reports zero available grants.");
	if (
		grant?.type !== "codexRateLimits" ||
		!["available", "redeeming", "redeemed"].includes(grant.status) ||
		offers.count === null ||
		grant.expiresAt === null ||
		offers.used.length === 0
	)
		throw new CodexResetError(
			"unverified",
			"FREE reset eligibility, covered main quota or expiry is unknown. Inspect the official Codex Usage UI.",
		);
	if (grant.status !== "available" || grant.expiresAt <= now || !offers.used.some((used) => used > 20))
		throw new CodexResetError(
			"ineligible",
			"FREE reset eligibility: this grant is expired, unavailable or no reported main allowance needs a reset.",
		);
	return { ...grant, expiresAt: grant.expiresAt };
}

/** Human-readable fields only. Missing applicability/history is not invented from a title or balance. */
export function formatOffers(offers: CodexOffers): string {
	return [
		`Codex FREE banked resets: ${offers.count === null ? "unknown (not verified zero)" : offers.count}; checked UTC ${new Date(offers.checkedAt).toISOString()}`,
		`Main quota: ${offers.used.length ? offers.used.map((used) => `${used}% used`).join(", ") : "unknown"}. Exact per-grant window applicability and history: not reported.`,
		...(offers.grants?.map(
			(grant, index) =>
				`Grant ${index + 1}: ${grant.type === "codexRateLimits" ? "main Codex quota" : "unsupported type"}; ${["available", "redeeming", "redeemed"].includes(grant.status) ? grant.status : "unknown status"}; granted UTC ${new Date(grant.grantedAt).toISOString()}; expiry ${grant.expiresAt === null ? "unknown" : new Date(grant.expiresAt).toISOString()}`,
		) ?? ["Grant details: unknown (count-only or unavailable)."]),
		"Only FREE earned grants are supported. No purchases, extra usage billing or automatic redemption.",
	].join("\n");
}
