/**
 * OAuth-backed subscription usage: the Anthropic and ChatGPT Codex collectors,
 * a normalized per-provider cache, and the per-model block decision built on it.
 *
 * The built-in adapters were ported from the nredd/pi-subagents fork
 * (`src/subscription-usage.ts`). Additional adapters can register in-process.
 *
 * Fetching is deliberately conservative: successful reads are cached for five
 * minutes, `fresh` reads within a minute share one response, and a failed read
 * backs the provider off (1m, 2m, 5m, then 15m) so a throttled endpoint is not
 * hammered. Credentials are passed only to the registered adapter for the provider.
 */

import { addAbortListener } from "node:events";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { normalizeReading } from "./collector-reading.ts";
import { type CollectorReading, type CollectorRegistration, registrationFor } from "./collectors.ts";

import type { ProviderConfig } from "./config.ts";

export { parseAnthropic, parseCodex } from "./builtin-collectors.ts";

import { type ModelRef, refKey } from "./model-ref.ts";

export { COLLECTED_PROVIDERS } from "./collectors.ts";

/** How long a successful read is served from cache to plain `get` calls. */
const CACHE_TTL_MS = 5 * 60_000;
/** Minimum spacing between user-initiated (`force`) refreshes per provider. */
const MANUAL_REFRESH_INTERVAL_MS = 60_000;
/** A `fresh` read reuses a snapshot retrieved this recently, so concurrent confirmations share one read. */
const FRESH_REUSE_WINDOW_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
/** Failure backoff steps; the last entry is the cap. Reset on the next success. */
const FAILURE_BACKOFF_MS = [60_000, 2 * 60_000, 5 * 60_000, 15 * 60_000] as const;
/** Upper bound on a server-supplied `Retry-After`, so a bogus header cannot park a provider for days. */
const RETRY_AFTER_CEILING_MS = 60 * 60_000;
/** `available`: fresh data. `stale`: old data kept after an expiry or failed refresh. */
export type UsageStatus = "available" | "stale" | "unavailable" | "error";

export interface Quantity {
	unit: "requests" | "tokens" | "usd" | "credits";
	used?: number;
	limit?: number;
	remaining?: number;
}

type CollectedSpanSource = "reported" | "assumed";
export type UsageSpanSource = CollectedSpanSource | "inferred";

/** One normalized quota window with a truthful percentage. Legacy collectors default to collected spans. */
export interface UsageWindow<SpanSource extends UsageSpanSource = CollectedSpanSource> {
	/** Provider-native window name, e.g. `five_hour`, `seven_day_opus`, `5h`. */
	name: string;
	/** 0-100; values over 100 are clamped so over-limit still blocks. */
	usedPercent: number;
	/** Epoch milliseconds, when known. */
	resetAt?: number;
	/** Full quota-window duration in milliseconds, when known. */
	durationMs?: number;
	/**
	 * Provenance of `name` and `durationMs`, for display only (never read by scoring or admission).
	 * `reported`: the provider stated the span (Anthropic's fixed windows, Codex `limit_window_seconds`).
	 * `assumed`: guessed from position because the provider stated none. Absent on older snapshots.
	 * `inferred`: derived from indirect evidence, e.g. a failure hint.
	 */
	spanSource?: SpanSource;
	/** `provider` windows gate every model; `model` windows gate only matching `families`. */
	scope: "provider" | "model";
	/** Family tokens a `model`-scoped window applies to, e.g. `["opus"]`. See `modelMatchesFamily`. */
	families?: string[];
	/** Absent on legacy windows. */
	kind?: "rolling" | "calendar";
	/** For calendar windows only; `at` is local HH:mm in `timeZone`. */
	resetRule?: { at: string; timeZone: string; every: "day" | "week" };
	/** Display and evidence only; never read by scoring. */
	quantity?: Quantity;
	/** Absent means reported. */
	basis?: "reported" | "observed" | "inferred";
}

/** A bucket without a truthful percentage. An absent limit is unknown. */
export type UsageMeter = Omit<UsageWindow<UsageSpanSource>, "usedPercent"> & { quantity: Quantity };

/** Display only; a balance never bypasses a quota window. */
export interface CreditPool {
	name: string;
	unit: "usd" | "credits";
	role: "overage" | "prepaid";
	balance?: number;
	unlimited?: boolean;
	appliesAfter?: string[];
}

/** Normalized quota state for one provider at one point in time. */
export interface UsageSnapshot<SpanSource extends UsageSpanSource = CollectedSpanSource> {
	provider: string;
	status: UsageStatus;
	windows: UsageWindow<SpanSource>[];
	meters?: UsageMeter[];
	pools?: CreditPool[];
	access?: "subscription" | "metered";
	/** Paid credits. Only `unlimited` affects decisions; a balance never bypasses a window. */
	credits?: { available: boolean; unlimited: boolean; balance?: string };
	retrievedAt: number;
	expiresAt: number;
	message?: string;
}

/** The part of `ExtensionContext` usage reads. Unlike the ctx itself, it stays valid after its session is disposed. */
export type RegistryContext = Pick<ExtensionContext, "modelRegistry">;

/** Side-effecting dependencies, injectable for tests. */
export interface UsageTransport {
	fetch(input: string, init: RequestInit): Promise<Response>;
	now(): number;
	getAccessToken(ctx: RegistryContext, provider: string): Promise<string | undefined>;
}

/** Whether a model must not be dispatched on included quota right now, and why. */
export const COLLECTOR_EVIDENCE = Symbol.for("pi-subscription-router.collector-evidence");

export interface UsageDecision {
	[COLLECTOR_EVIDENCE]?: AbortSignal;
	block: boolean;
	message?: string;
	window?: string;
	resetAt?: number;
	/** Scope of the exhausted window: which models the block also covers. */
	scope?: "provider" | "model";
	families?: string[];
}

/**
 * True when `family` appears in `modelId` as a whole token: bounded on each side
 * by the string edge or one of `-./:`, case-insensitive. `opus` matches
 * `claude-opus-4-1` and `us.anthropic.claude-opus-4-1-v1:0`, not `claude-magnopus`.
 */
export function modelMatchesFamily(modelId: string, family: string): boolean {
	const escaped = family.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(?:^|[-./:])${escaped}(?:$|[-./:])`, "i").test(modelId);
}

function errorSnapshot(provider: string, status: "error" | "unavailable", now: number, message: string): UsageSnapshot {
	return { provider, status, windows: [], retrievedAt: now, expiresAt: now, message };
}

/** `cached` with its last-known windows, marked stale and expired as of `now`. */
function staleSnapshot(cached: UsageSnapshot, now: number, message: string | undefined): UsageSnapshot {
	return { ...cached, status: "stale", expiresAt: now, message };
}

function isoMinute(epochMs: number): string {
	return `${new Date(epochMs).toISOString().slice(0, 16)}Z`;
}

/** `Retry-After` as milliseconds from `now`: delta-seconds or an HTTP-date. */
function retryAfterMs(header: string | null, now: number): number | undefined {
	if (!header) return undefined;
	const trimmed = header.trim();
	const ms = /^\d+$/.test(trimmed) ? Number(trimmed) * 1000 : Date.parse(trimmed) - now;
	return Number.isFinite(ms) ? ms : undefined;
}

interface FetchOutcome {
	snapshot: UsageSnapshot;
	/** True when a network read was attempted and failed; drives the backoff. */
	failed: boolean;
	retryAfterMs?: number;
}

/** Options for `UsageService.get`. */
export interface UsageGetOptions {
	/** User-initiated; limited to once per minute per provider. */
	force?: boolean;
	/** Bypass the TTL, but reuse a read from the last minute. */
	fresh?: boolean;
	/**
	 * Epoch ms. Reuse a cached or in-flight read only if it started at or after
	 * this, e.g. the failure a confirmation is about. Concurrent confirmations of
	 * the same failure still share one request.
	 */
	notBefore?: number;
	/** Detaches only this caller; a shared in-flight read continues. */
	signal?: AbortSignal;
}

/** Initiation-ordered reads retain local evidence without publishing superseded results. */
interface UsageRead {
	startedAt: number;
	read: Promise<UsageSnapshot>;
	snapshot?: UsageSnapshot;
	newer?: UsageRead;
}

/** Resolve adapter IDs without changing the provider whose credentials are read. */
export function collectorIdFor(provider: string, providers: Readonly<Record<string, ProviderConfig>>): string {
	return providers[provider]?.collector?.id ?? provider;
}

/** Subscription quota state for OAuth-backed consumer plans. */
export class UsageService {
	private readonly collectors = new Map<
		string,
		{ registration: CollectorRegistration; binding: CollectorRegistration; unbind: AbortController }
	>();
	private providers: Readonly<Record<string, ProviderConfig>> = {};
	private readonly evidence = new WeakMap<UsageSnapshot, CollectorRegistration>();
	private readonly cache = new Map<string, UsageSnapshot>();
	private readonly generations = new Map<string, number>();
	private readonly lastManualRefreshAt = new Map<string, number>();
	private readonly inFlight = new Map<string, UsageRead>();
	private readonly backoff = new Map<string, { failures: number; until: number }>();

	constructor(
		private readonly transport: UsageTransport = {
			fetch,
			now: () => Date.now(),
			getAccessToken: (ctx, provider) => ctx.modelRegistry.getApiKeyForProvider(provider),
		},
	) {}

	/** Apply provider declarations before serving reads for this config. */
	configureCollectors(providers: Readonly<Record<string, ProviderConfig>> = {}): void {
		this.providers = providers;
		for (const [provider, { registration, unbind }] of this.collectors) {
			if (registration !== registrationFor(collectorIdFor(provider, providers))) unbind.abort();
		}
	}

	/**
	 * Current usage for `provider`: cached while younger than five minutes, else a
	 * network read (see `UsageGetOptions` for `fresh` and `force`). During failure
	 * backoff nothing touches the network: the last snapshot comes back `stale`,
	 * or an `error` snapshot when there is none. Never rejects.
	 */
	async get(ctx: RegistryContext, provider: string, options: UsageGetOptions = {}): Promise<UsageSnapshot> {
		const now = this.transport.now();
		if (options.signal?.aborted) return errorSnapshot(provider, "error", now, "Usage request was cancelled.");
		const collector = this.currentCollector(provider);
		if (!collector)
			return errorSnapshot(provider, "unavailable", now, "No subscription usage collector exists for this provider.");
		const generation = this.generations.get(provider) ?? 0;
		const cached = this.cache.get(provider);
		const force = options.force === true;
		if (!force && cached?.status === "available") {
			if (!options.fresh && cached.expiresAt > now) return cached;
			const reusable = options.notBefore === undefined || cached.retrievedAt >= options.notBefore;
			if (options.fresh && reusable && now - cached.retrievedAt < FRESH_REUSE_WINDOW_MS) return cached;
		}
		const backoff = this.backoff.get(provider);
		if (backoff && backoff.until > now) {
			const until = new Date(backoff.until).toISOString();
			return this.withStale(cached, provider, now, `Backing off after a failed usage request until ${until}.`);
		}
		if (force) {
			if (now - (this.lastManualRefreshAt.get(provider) ?? 0) < MANUAL_REFRESH_INTERVAL_MS) {
				return this.withStale(cached, provider, now, "Manual refresh is limited to once per minute.");
			}
			this.lastManualRefreshAt.set(provider, now);
		}
		const refresh = this.refresh(ctx, provider, collector, now, options.notBefore);
		const snapshot = await waitForCaller(refresh.read, options.signal, () => {
			// The one outer deadline owns fallback selection. Inner waits must not
			// race it with separate timers or extend it for each newer owner.
			let fallback: UsageSnapshot | undefined;
			const consider = (candidate: UsageSnapshot | undefined) => {
				if (
					candidate?.status === "available" &&
					candidate.retrievedAt >= Math.max(refresh.startedAt, options.notBefore ?? refresh.startedAt) &&
					(!fallback || candidate.retrievedAt >= fallback.retrievedAt)
				)
					fallback = candidate;
			};
			for (let entry: UsageRead | undefined = refresh; entry; entry = entry.newer) consider(entry.snapshot);
			consider(this.cache.get(provider));
			return fallback;
		});
		if (!options.signal?.aborted && collector.signal.aborted) {
			return errorSnapshot(provider, "unavailable", now, "Usage collector changed during the read.");
		}
		if (generation !== (this.generations.get(provider) ?? 0) && !options.signal?.aborted) {
			const current = this.peek(provider);
			return current?.status === "available" && current.retrievedAt >= (options.notBefore ?? 0)
				? current
				: errorSnapshot(
						provider,
						"error",
						this.transport.now(),
						"Usage evidence preceded a verified reset; confirmation requires a new read.",
					);
		}
		if (!snapshot) {
			return errorSnapshot(
				provider,
				"error",
				now,
				options.signal?.aborted ? "Usage request was cancelled." : "Usage request timed out.",
			);
		}
		return snapshot;
	}

	/** Discard only this provider's cached evidence and prior read ownership after verified server mutation. */
	invalidate(provider: string): void {
		this.generations.set(provider, (this.generations.get(provider) ?? 0) + 1);
		this.cache.delete(provider);
		this.inFlight.delete(provider);
		this.backoff.delete(provider);
	}

	/** Cached snapshot without any network read; expired data is reported `stale`. */
	peek(provider: string): UsageSnapshot | undefined {
		this.currentCollector(provider);
		const cached = this.cache.get(provider);
		if (!cached) return undefined;
		const now = this.transport.now();
		return cached.expiresAt > now ? cached : this.withStale(cached, provider, now, "Cached usage data is stale.");
	}

	/**
	 * Whether `model` is blocked on included quota, from cached data only. Blocks
	 * when a matching window is exhausted in fresh data, or in stale data whose
	 * known reset is still ahead (staleness cannot refill a window early). Stale
	 * data with an unknown or past reset, missing data, and failed reads fail open.
	 * An unlimited plan never blocks; a credit balance never bypasses a window.
	 */
	decisionFor(model: ModelRef, snapshot = this.peek(model.provider)): UsageDecision {
		if (!snapshot || (snapshot.status !== "available" && snapshot.status !== "stale")) return { block: false };
		const registration = this.evidence.get(snapshot);
		if (registration?.signal.aborted || snapshot.credits?.unlimited === true) return { block: false };
		const now = this.transport.now();
		const exhausted = snapshot.windows.find(
			(window) =>
				window.usedPercent >= 100 &&
				(window.scope === "provider" ||
					window.families?.some((family) => modelMatchesFamily(model.id, family)) === true) &&
				(window.resetAt === undefined ? snapshot.status === "available" : window.resetAt > now),
		);
		if (!exhausted) return { block: false };
		const reset = exhausted.resetAt ? new Date(exhausted.resetAt).toISOString() : "an unknown time";
		const decision: UsageDecision = {
			block: true,
			window: exhausted.name,
			resetAt: exhausted.resetAt,
			scope: exhausted.scope,
			families: exhausted.families,
			message: `${refKey(model)}: ${exhausted.name} is exhausted and resets ${reset}.`,
		};
		if (registration) Object.defineProperty(decision, COLLECTOR_EVIDENCE, { value: registration.signal });
		return decision;
	}

	/** Human-readable one-liner for UI and tool output. */
	format(snapshot: UsageSnapshot | undefined): string {
		if (!snapshot) return "usage unavailable (not checked)";
		if (snapshot.status !== "available") return `usage ${snapshot.status}: ${snapshot.message ?? "not available"}`;
		return snapshot.windows
			.map((window) => {
				const reset = window.resetAt ? `, resets ${new Date(window.resetAt).toLocaleTimeString()}` : "";
				return `${window.name} ${Math.round(window.usedPercent)}% used${reset}`;
			})
			.join("; ");
	}

	/**
	 * System-prompt rendering with coarse 25% buckets and UTC minute resets only for
	 * exhausted windows, so the text (and the prompt-cache prefix) stays stable
	 * across ordinary turns. Stale snapshots keep their last-known windows.
	 */
	formatForPrompt(snapshot: UsageSnapshot | undefined): string {
		if (!snapshot) return "usage unavailable";
		if (snapshot.windows.length === 0) return `usage ${snapshot.status}`;
		return snapshot.windows
			.map((window) => {
				const used = window.usedPercent;
				const bucket =
					used >= 100
						? window.resetAt
							? `exhausted until ${isoMinute(window.resetAt)}`
							: "exhausted, reset unknown"
						: used < 25
							? "<25%"
							: used < 50
								? "25-50%"
								: used < 75
									? "50-75%"
									: "75-100%";
				return `${window.name} ${bucket}`;
			})
			.join("; ");
	}

	private withStale(cached: UsageSnapshot | undefined, provider: string, now: number, message: string): UsageSnapshot {
		return cached ? this.stale(cached, now, message) : errorSnapshot(provider, "error", now, message);
	}

	private stale(cached: UsageSnapshot, now: number, message: string | undefined): UsageSnapshot {
		const stale = staleSnapshot(cached, now, message);
		const registration = this.evidence.get(cached);
		if (registration) this.evidence.set(stale, registration);
		return stale;
	}

	private currentCollector(provider: string): CollectorRegistration | undefined {
		const registration = registrationFor(collectorIdFor(provider, this.providers));
		const current = this.collectors.get(provider);
		if (current?.registration === registration) return current?.binding;
		current?.unbind.abort();
		if (!registration) return undefined;
		const unbind = new AbortController();
		const binding = {
			collector: registration.collector,
			signal: AbortSignal.any([registration.signal, unbind.signal]),
		};
		this.collectors.set(provider, { registration, binding, unbind });
		addAbortListener(binding.signal, () => {
			this.invalidate(provider);
			this.lastManualRefreshAt.delete(provider);
			this.collectors.delete(provider);
		});
		return binding;
	}

	private refresh(
		ctx: RegistryContext,
		provider: string,
		registration: CollectorRegistration,
		now: number,
		notBefore?: number,
	): UsageRead {
		const existing = this.inFlight.get(provider);
		if (existing && (notBefore === undefined || existing.startedAt >= notBefore)) return existing;
		const retired = () => errorSnapshot(provider, "unavailable", now, "Usage collector changed during the read.");
		const refresh = this.fetchSnapshot(ctx, provider, registration, now)
			.then(async (outcome) => {
				if (registration.signal.aborted) return retired();
				this.evidence.set(outcome.snapshot, registration);
				entry.snapshot = outcome.snapshot;
				// A post-failure read may supersede a slow warm-up. Only the newest
				// initiated read owns cache/backoff writes, regardless of completion order.
				if (this.inFlight.get(provider)?.read !== refresh) {
					// Follow only later owners, never older reads: the dependency graph
					// is acyclic. The caller's total wait is bounded across supersessions.
					const newer = this.inFlight.get(provider);
					const latest = newer ? await newer.read : this.cache.get(provider);
					if (registration.signal.aborted) return retired();
					const freshEnough = (snapshot: UsageSnapshot | undefined): snapshot is UsageSnapshot =>
						snapshot?.status === "available" && snapshot.retrievedAt >= Math.max(now, notBefore ?? now);
					if (freshEnough(latest)) return latest;
					// This caller can use its exact live result, but must not overwrite
					// the newer owner's cache or clear the newer failure's backoff.
					if (freshEnough(outcome.snapshot)) return outcome.snapshot;
					if (latest) return latest;
					return errorSnapshot(
						provider,
						"error",
						this.transport.now(),
						"Usage request was superseded by a newer read.",
					);
				}
				if (outcome.snapshot.status === "available") {
					this.cache.set(provider, outcome.snapshot);
					this.backoff.delete(provider);
				} else if (outcome.failed) {
					this.recordFailure(provider, outcome.retryAfterMs);
				}
				const cached = this.cache.get(provider);
				if (outcome.snapshot.status !== "available" && cached) {
					const stale = this.stale(cached, this.transport.now(), outcome.snapshot.message);
					this.cache.set(provider, stale);
					return stale;
				}
				return outcome.snapshot;
			})
			.finally(() => {
				if (this.inFlight.get(provider)?.read === refresh) this.inFlight.delete(provider);
			});
		const entry: UsageRead = { startedAt: now, read: refresh };
		if (existing) existing.newer = entry;
		this.inFlight.set(provider, entry);
		return entry;
	}

	private recordFailure(provider: string, retryAfter: number | undefined): void {
		const failures = (this.backoff.get(provider)?.failures ?? 0) + 1;
		// The ladder ascends, so its largest reached step is the step for this failure count.
		const step = Math.max(...FAILURE_BACKOFF_MS.slice(0, failures));
		const delay = Math.min(Math.max(step, retryAfter ?? 0), RETRY_AFTER_CEILING_MS);
		this.backoff.set(provider, { failures, until: this.transport.now() + delay });
	}

	private async fetchSnapshot(
		ctx: RegistryContext,
		provider: string,
		{ collector, signal: lifetime }: CollectorRegistration,
		now: number,
	): Promise<FetchOutcome> {
		const unfetched = (status: "error" | "unavailable", message: string): FetchOutcome => ({
			snapshot: errorSnapshot(provider, status, now, message),
			failed: false,
		});
		let token: string | undefined;
		const lookupTimedOut = Symbol("credential lookup timeout");
		let lookupTimer: ReturnType<typeof setTimeout> | undefined;
		try {
			// Core owns refresh/persistence. Bound only our wait; its API has no
			// cancellation parameter, so a late owner result is ignored, not aborted.
			const result = await Promise.race([
				this.transport.getAccessToken(ctx, provider),
				new Promise<typeof lookupTimedOut>((resolve) => {
					lookupTimer = setTimeout(() => resolve(lookupTimedOut), REQUEST_TIMEOUT_MS);
				}),
			]);
			if (result === lookupTimedOut) {
				return { ...unfetched("error", "OAuth credential lookup timed out."), failed: true };
			}
			token = result;
		} catch {
			return unfetched("error", "OAuth credential lookup failed.");
		} finally {
			clearTimeout(lookupTimer);
		}
		if (!token) return unfetched("unavailable", "No OAuth credential is available for this provider.");

		const failure = (message: string, retryAfter?: number): FetchOutcome => ({
			snapshot: errorSnapshot(provider, "error", now, message),
			failed: true,
			retryAfterMs: retryAfter,
		});
		const controller = new AbortController();
		const signal = AbortSignal.any([controller.signal, lifetime]);
		let timedOut = false;
		const timeout = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, REQUEST_TIMEOUT_MS);
		try {
			signal.throwIfAborted();
			if (collector.acceptsCredential?.(token) === false) {
				return unfetched("unavailable", "API-key auth has no subscription usage window.");
			}
			signal.throwIfAborted();
			let parsed: CollectorReading | undefined;
			if (collector.kind === "http") {
				const { url, ...init } = collector.request(token);
				const response = await this.transport.fetch(url, { ...init, signal });
				if (!response.ok) {
					return failure(
						`Usage request failed (${response.status}).`,
						retryAfterMs(response.headers.get("retry-after"), this.transport.now()),
					);
				}
				const payload: unknown = await response.json();
				signal.throwIfAborted();
				parsed = collector.parse(payload);
			} else {
				// Custom reads get the same deadline even if the adapter ignores abort.
				const read = collector.read({ token, signal, now: () => this.transport.now() });
				parsed = await untilAborted(read, signal);
			}
			const reading = normalizeReading(parsed);
			if (!reading) return failure("Usage response had an unsupported shape.");
			return {
				snapshot: { provider, status: "available", retrievedAt: now, expiresAt: now + CACHE_TTL_MS, ...reading },
				failed: false,
			};
		} catch (error) {
			const aborted = error instanceof Error && error.name === "AbortError";
			if (aborted) return failure(timedOut ? "Usage request timed out." : "Usage request was cancelled.");
			return failure("Usage request failed.");
		} finally {
			clearTimeout(timeout);
		}
	}
}

/** Bound awaited work even when an adapter ignores the signal. */
async function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	let listener: Disposable | undefined;
	const cancelled = new Promise<never>((_, reject) => {
		listener = addAbortListener(signal, () => reject(signal.reason));
	});
	try {
		return await Promise.race([cancelled, work]);
	} finally {
		listener?.[Symbol.dispose]();
	}
}

/** Prefer the completed read; at the total deadline use live evidence, never on abort. */
function waitForCaller(
	refresh: Promise<UsageSnapshot>,
	signal: AbortSignal | undefined,
	onTimeout: () => UsageSnapshot | undefined,
): Promise<UsageSnapshot | undefined> {
	// The credential lookup runs synchronously inside `refresh` and may abort the signal
	// before the listener below exists; an `abort` listener added afterwards never fires.
	if (signal?.aborted) return Promise.resolve(undefined);
	return new Promise((resolve) => {
		let settled = false;
		const finish = (snapshot?: UsageSnapshot) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			resolve(snapshot);
		};
		const abort = () => finish();
		// One credential lookup plus one fetch, regardless of supersession count. Re-check
		// the signal: a foreign listener can stop the `abort` event before ours runs.
		const timer = setTimeout(() => finish(signal?.aborted ? undefined : onTimeout()), 2 * REQUEST_TIMEOUT_MS);
		signal?.addEventListener("abort", abort, { once: true });
		void refresh.then(finish);
	});
}
