/** Account-bound free reset orchestration. Only explicit confirmations can reach consume. */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	CODEX_PROVIDER,
	type CodexOffers,
	CodexResetError,
	eligibleGrant,
	parseOffers,
	readIdentity,
	record,
} from "./codex-contract.js";
import { type CodexSession, openCodexSession } from "./codex-session.js";
import type { ExhaustionTracker } from "./exhaustion.js";
import { type ResetAttempt, ResetJournal, type ResetOutcome } from "./reset-journal.js";
import type { UsageService } from "./usage.js";

export interface ResetInspection {
	binding: string;
	offers: CodexOffers;
	stale: boolean;
	pending?: ResetAttempt;
	usedGrants?: string[];
	message?: string;
}
export interface RedemptionResult {
	outcome: ResetOutcome;
	quotaRefreshed: boolean;
	offersRefreshed: boolean;
}
export interface CodexResetOptions {
	root: string;
	usage: Pick<UsageService, "get"> & Partial<Pick<UsageService, "invalidate">>;
	tracker?: Pick<ExhaustionTracker, "reconcile">;
	now?: () => number;
	getToken?: (ctx: ExtensionContext) => Promise<string | undefined>;
	open?: (ctx: ExtensionContext, signal?: AbortSignal) => Promise<CodexSession>;
}
interface CachedOffers {
	offers?: CodexOffers;
	read?: Promise<CodexOffers>;
	attemptedAt: number;
}
const ACTIVE = Symbol.for("pi-subscription-router.codex-reset-attempts");

/** Shared across reloads/copies. The durable ledger, not this set, guards separate processes. */
function active(): Set<string> {
	const host = globalThis as typeof globalThis & { [ACTIVE]?: Set<string> };
	host[ACTIVE] ??= new Set();
	return host[ACTIVE];
}

/** Detach a cancelled inspector without aborting another caller's shared, deadline-bounded read. */
function wait<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(new CodexResetError("cancelled", "Codex inspection cancelled."));
	return new Promise((resolve, reject) => {
		const abort = () => reject(new CodexResetError("cancelled", "Codex inspection cancelled."));
		signal.addEventListener("abort", abort, { once: true });
		void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}

/** Small provider-specific coordinator; no universal grants framework or session/goal wake integration. */
export class CodexResets {
	private readonly cache = new Map<string, CachedOffers>();
	private readonly now: () => number;
	private readonly token: NonNullable<CodexResetOptions["getToken"]>;
	private readonly open: NonNullable<CodexResetOptions["open"]>;
	constructor(private readonly options: CodexResetOptions) {
		this.now = options.now ?? Date.now;
		this.token = options.getToken ?? ((ctx) => ctx.modelRegistry.getApiKeyForProvider(CODEX_PROVIDER));
		this.open = options.open ?? ((ctx, signal) => openCodexSession({ getToken: () => this.token(ctx) }, signal));
	}

	/** Never use another account's cache, even if the selected model is unrelated to Codex. */
	async inspect(ctx: ExtensionContext, signal?: AbortSignal): Promise<ResetInspection> {
		const identity = await readIdentity(() => this.token(ctx), signal);
		const binding = identity.fingerprint;
		const journal = new ResetJournal(this.options.root, identity.accountScope, binding);
		const entries = await journal.entries();
		const pending = entries.find((entry) => entry.outcome === undefined)?.attempt;
		const usedGrants = entries
			.filter(({ outcome }) => outcome === "reset" || outcome === "alreadyRedeemed")
			.map(({ attempt }) => attempt.grant);
		let cached = this.cache.get(binding);
		if (!cached || this.now() - cached.attemptedAt >= 60_000) {
			cached = { offers: cached?.offers, attemptedAt: this.now() };
			this.cache.set(binding, cached);
			const owner = cached;
			owner.read = this.read(ctx, binding)
				.then((offers) => {
					owner.offers = offers;
					return offers;
				})
				.finally(() => {
					owner.read = undefined;
				});
		}
		try {
			const offers = cached.read ? await wait(cached.read, signal) : cached.offers;
			if (!offers)
				throw new CodexResetError("unavailable", "Codex offer refresh is backed off for one minute after failure.");
			return {
				binding,
				offers,
				pending,
				usedGrants,
				stale: this.now() - offers.checkedAt >= 60_000,
				message:
					"Offer reads share a cache and are limited to once/minute/account; confirmed redemption revalidates live.",
			};
		} catch (error) {
			if (error instanceof CodexResetError && error.kind === "cancelled") throw error;
			if (cached.offers)
				return {
					binding,
					offers: cached.offers,
					pending,
					usedGrants,
					stale: true,
					message: "Offer refresh failed; last-known details are stale. Redemption requires live revalidation.",
				};
			throw error;
		}
	}

	private async read(ctx: ExtensionContext, binding: string, signal?: AbortSignal): Promise<CodexOffers> {
		const session = await this.open(ctx, signal);
		try {
			if (session.identity.fingerprint !== binding)
				throw new CodexResetError("authentication", "Pi Codex account changed before inspection.");
			await session.checkIdentity();
			const payload = await session.request(
				"account/rateLimits/read",
				{ supportsLunaReserve: false, excludeResetCreditDetails: false },
				signal,
			);
			await session.checkIdentity();
			return parseOffers(payload, this.now());
		} finally {
			await session.close();
		}
	}

	/** Persist the logical attempt BEFORE dispatch. Uncertain outcomes keep that exact grant/key across reloads. */
	async redeem(
		ctx: ExtensionContext,
		preview: ResetInspection,
		grantId: string,
		confirmed: boolean,
		signal?: AbortSignal,
		reconcile = false,
	): Promise<RedemptionResult> {
		if (!confirmed)
			throw new CodexResetError("confirmation", "Explicit human confirmation is required for FREE reset consumption.");
		if (!this.options.usage.invalidate)
			throw new CodexResetError(
				"unsupported",
				"This embedding cannot invalidate authoritative quota evidence; redemption is disabled.",
			);
		if (signal?.aborted) throw new CodexResetError("cancelled", "Reset cancelled before admission.");
		const identity = await readIdentity(() => this.token(ctx), signal);
		const binding = identity.fingerprint;
		if (binding !== preview.binding)
			throw new CodexResetError("authentication", "Pi Codex account/workspace changed after confirmation.");
		if (active().has(identity.accountScope))
			throw new CodexResetError("busy", "A reset is already running for this account; no duplicate dispatched.");
		active().add(identity.accountScope);
		let session: CodexSession | undefined;
		let attempt: ResetAttempt | undefined;
		let dispatched = false;
		let confirmedOutcome: ResetOutcome | undefined;
		const journal = new ResetJournal(this.options.root, identity.accountScope, binding);
		try {
			session = await this.open(ctx, signal);
			if (session.identity.fingerprint !== binding)
				throw new CodexResetError("authentication", "Pi Codex account changed before redemption.");
			await session.checkIdentity();
			const offers = parseOffers(
				await session.request(
					"account/rateLimits/read",
					{ supportsLunaReserve: false, excludeResetCreditDetails: false },
					signal,
				),
				this.now(),
			);
			const entries = await journal.entries();
			const pending = entries.find((entry) => entry.outcome === undefined)?.attempt;
			if (reconcile) {
				if (!pending || pending.grant !== grantId || preview.pending?.key !== pending.key)
					throw new CodexResetError(
						"unknown",
						"No matching unresolved logical attempt; refresh before reconciliation.",
					);
				if (pending.binding !== binding)
					throw new CodexResetError(
						"authentication",
						"An unresolved reset belongs to a different Pi principal in this workspace. Return to the original account context before reconciliation.",
					);
				attempt = pending;
				// Reconcile by the documented idempotent consume, never a new UUID or a different grant.
				// Eligibility is still enforced by the server: an already-redeemed/expired grant may return its prior outcome.
			} else {
				const grant = eligibleGrant(offers, grantId, this.now());
				const original = eligibleGrant(preview.offers, grantId, this.now());
				if (grant.expiresAt !== original.expiresAt)
					throw new CodexResetError("confirmation", "Grant terms changed; inspect and confirm again.");
				attempt = await journal.claim(grantId, this.now(), grant.expiresAt);
			}
			await session.checkIdentity();
			const result = record(
				await session.request(
					"account/rateLimitResetCredit/consume",
					{ creditId: attempt.grant, idempotencyKey: attempt.key },
					signal,
					() => {
						dispatched = true;
					},
				),
			);
			const outcome = result.outcome;
			if (
				outcome !== "reset" &&
				outcome !== "alreadyRedeemed" &&
				outcome !== "nothingToReset" &&
				outcome !== "noCredit"
			)
				throw new CodexResetError(
					"unknown",
					"Codex returned an unknown consume outcome. Reconcile before any new attempt.",
				);
			confirmedOutcome = outcome;
			let quotaRefreshed = false;
			let offersRefreshed = false;
			try {
				await journal.settle(attempt, outcome);
			} finally {
				// Provider success remains authoritative even if local receipt durability fails.
				this.cache.delete(binding);
				if (outcome === "reset" || outcome === "alreadyRedeemed") {
					// Do not clear local blocks or counters. The authoritative collector refresh owns new quota evidence.
					this.options.usage.invalidate(CODEX_PROVIDER);
					try {
						await session.checkIdentity();
						const offers = parseOffers(
							await session.request(
								"account/rateLimits/read",
								{ supportsLunaReserve: false, excludeResetCreditDetails: false },
								signal,
							),
							this.now(),
						);
						await session.checkIdentity();
						this.cache.set(binding, { offers, attemptedAt: this.now() });
						offersRefreshed = true;
					} catch {
						/* Grant consumption is confirmed independently of offer-list refresh. */
					}
					try {
						await session.checkIdentity();
						const refreshed = await this.options.usage.get(ctx, CODEX_PROVIDER, {
							fresh: true,
							notBefore: this.now(),
							signal,
						});
						await session.checkIdentity();
						quotaRefreshed = refreshed.status === "available" && refreshed.expiresAt > this.now();
						if (quotaRefreshed) this.options.tracker?.reconcile(refreshed);
					} catch {
						/* Redemption remains confirmed even when identity/refresh subsequently fails. */
					}
				}
			}
			return { outcome, quotaRefreshed, offersRefreshed };
		} catch (error) {
			if (attempt && error instanceof CodexResetError && error.kind === "unsupported") {
				throw new CodexResetError(
					"unsupported",
					"Codex does not support this documented consume method; no fallback attempted. Any prior unresolved attempt is retained.",
				);
			}
			// A published claim is already visible to other processes. Local non-dispatch cannot
			// release it: a reconciler may have dispatched the same key and lost its response.
			if (confirmedOutcome === "reset" || confirmedOutcome === "alreadyRedeemed")
				throw new CodexResetError(
					"journal",
					"FREE reset confirmed by Codex, but its local receipt could not be saved. Do NOT consume another grant; reconcile the retained attempt.",
				);
			if (dispatched)
				throw new CodexResetError(
					"unknown",
					"Reset outcome is UNKNOWN. Its durable grant/key is retained. Inspect, then explicitly reconcile the SAME attempt; do not spend another grant.",
				);
			throw error;
		} finally {
			try {
				await session?.close();
			} finally {
				active().delete(identity.accountScope);
			}
		}
	}
}
