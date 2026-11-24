/**
 * Confirmed quota exhaustion, per `(provider, family)`.
 *
 * A mark needs evidence (see `evidence.ts` and `Router.confirm`): a fresh usage
 * read that shows the block, or a failure the provider's thresholds accept. A
 * read-confirmed mark carries no `evidence` field; a failure-inferred one says
 * `inferred`, how it expires and why. A transient per-minute 429 never removes a
 * model from its chain. A mark with a known reset lasts until that reset.
 * Without one it backs off exponentially, 5 minutes doubling up to 60, keyed on
 * how often the same scope was re-confirmed.
 */

import { addAbortListener } from "node:events";
import type { EvidenceDecision } from "./evidence.ts";
import type { ResetDeadline } from "./reset-deadline.ts";
import { COLLECTOR_EVIDENCE, COLLECTOR_RESET, modelMatchesFamily, type UsageSnapshot } from "./usage.ts";

const BACKOFF_BASE_MS = 5 * 60_000;
const BACKOFF_CAP_MS = 60 * 60_000;

/** One confirmed block. `families` undefined means the whole provider. */
export interface ExhaustionMark {
	provider: string;
	families?: string[];
	window: string;
	until: number;
	/** Whether `until` came from the provider rather than the backoff. */
	resetKnown: boolean;
	confirmations: number;
	/** Absent on read-confirmed marks, which keep exactly the six fields above. */
	evidence?: "inferred" | "observed";
	expiry?: "hinted" | "window-reset" | "backoff";
	cause?: "quota" | "billing";
	/** When an evidence-carrying mark was written. Provenance only: dedupe keys on the failure (L7), never on this. */
	markedAt?: number;
}

/** Where a mark's evidence came from: a fresh usage read unless it says otherwise. */
export function markEvidence(mark: ExhaustionMark): "read" | "inferred" | "observed" {
	return mark.evidence ?? "read";
}

import { type ModelRef, refKey } from "./model-ref.ts";

function scopeKey(provider: string, families: readonly string[] | undefined): string {
	return families?.length ? `${provider}:${[...families].sort().join(",")}` : `${provider}:*`;
}

/** Tracks confirmed exhaustion so routing can skip blocked families without a network read. */
export class ExhaustionTracker {
	private readonly marks = new Map<string, { mark: ExhaustionMark; deadline?: ResetDeadline }>();
	private readonly lifetimes = new Map<string, Disposable>();
	/** Failures (`model@timestamp`) already counted by each live evidence-carrying mark. */
	private readonly counted = new Map<string, ReadonlySet<string>>();
	private readonly listeners = new Set<() => void>();

	constructor(private readonly now: () => number = Date.now) {}

	/**
	 * Record confirmed evidence: the mark, or nothing when an inferred deadline (`hinted` or
	 * `window-reset`) already passed before confirmation finished. Only a decision without a
	 * deadline backs off, so an elapsed hint is never replaced by a fresh backoff.
	 */
	record(model: ModelRef, decision: EvidenceDecision): ExhaustionMark | undefined {
		// One clock sample for the check and the write: crossing the deadline between two samples
		// would otherwise turn a valid deadline into a fresh backoff.
		const now = this.now();
		const anchor = decision[COLLECTOR_RESET];
		const resetAt = anchor?.(now) ?? decision.resetAt;
		if ((anchor || decision.expiry === "hinted" || decision.expiry === "window-reset") && (resetAt ?? -Infinity) <= now)
			return undefined;
		return this.write(model, decision, now, resetAt);
	}

	/** Record a confirmed block for the scope of `decision` and return the mark. Routing uses `record`. */
	mark(model: ModelRef, decision: EvidenceDecision): ExhaustionMark {
		const now = this.now();
		return this.write(model, decision, now, decision[COLLECTOR_RESET]?.(now) ?? decision.resetAt);
	}

	private write(model: ModelRef, decision: EvidenceDecision, now: number, resetAt: number | undefined): ExhaustionMark {
		const families = decision.scope === "model" ? decision.families : undefined;
		const key = scopeKey(model.provider, families);
		const stored = this.marks.get(key);
		const previous = stored && this.project(stored, now);
		// L7: one failure, keyed by model and message timestamp, counts once while its mark is live.
		// Distinct failures count separately even when both precede the first confirmation, so dedupe
		// never compares `markedAt` with the failure time.
		const failure = decision.evidenceAt === undefined ? undefined : `${refKey(model)}@${decision.evidenceAt}`;
		const counted = previous !== undefined && previous.until > now ? this.counted.get(key) : undefined;
		if (previous && failure !== undefined && counted?.has(failure)) return previous;
		// A block that lifted more than a full backoff cycle ago is a new episode.
		const recent = previous !== undefined && now - previous.until < BACKOFF_CAP_MS;
		const confirmations = (recent ? previous.confirmations : 0) + 1;
		const resetKnown = resetAt !== undefined && resetAt > now;
		const backoff = Math.min(
			BACKOFF_BASE_MS * 2 ** (confirmations - 1),
			BACKOFF_CAP_MS,
			decision.maxBlockMs ?? Infinity,
		);
		const mark: ExhaustionMark = {
			provider: model.provider,
			families,
			window: decision.window ?? "included quota",
			until: resetKnown ? resetAt : now + backoff,
			resetKnown,
			confirmations,
		};
		if (decision.evidence) {
			// Late or weaker evidence counts, but never shortens a live mark: keep the later deadline.
			if (previous !== undefined && previous.until > now && previous.until >= mark.until) {
				const kept = { ...previous, confirmations };
				this.marks.set(key, { ...stored, mark: kept });
				if (failure !== undefined) this.counted.set(key, new Set(counted).add(failure));
				this.notify();
				return kept;
			}
			mark.evidence = decision.evidence;
			if (decision.expiry) mark.expiry = decision.expiry;
			if (decision.cause) mark.cause = decision.cause;
			mark.markedAt = now;
		}
		this.detach(key);
		this.marks.set(key, { mark, deadline: resetKnown ? decision[COLLECTOR_RESET] : undefined });
		if (failure === undefined) this.counted.delete(key);
		else this.counted.set(key, new Set(counted).add(failure));
		const signal = decision[COLLECTOR_EVIDENCE];
		if (signal)
			this.lifetimes.set(
				key,
				addAbortListener(signal, () => this.remove(key)),
			);
		this.notify();
		return mark;
	}

	/** Project a read-confirmed deadline without changing the stored mark or its evidence. */
	private project({ mark, deadline }: { mark: ExhaustionMark; deadline?: ResetDeadline }, now: number): ExhaustionMark {
		const until = deadline?.(now) ?? mark.until;
		return until === mark.until ? mark : { ...mark, until };
	}

	/** The live mark covering `model`, if any. Expired marks are kept so a quick re-confirmation grows the backoff. */
	blocking(model: ModelRef): ExhaustionMark | undefined {
		const now = this.now();
		for (const stored of this.marks.values()) {
			const mark = this.project(stored, now);
			if (mark.until <= now || mark.provider !== model.provider) continue;
			if (!mark.families || mark.families.some((family) => modelMatchesFamily(model.id, family))) return mark;
		}
		return undefined;
	}

	/** Live marks, for status output. */
	active(): ExhaustionMark[] {
		const now = this.now();
		return [...this.marks.values()].map((stored) => this.project(stored, now)).filter((mark) => mark.until > now);
	}

	/**
	 * Reconcile only an exactly matching window/scope from fresh authoritative non-exhausted
	 * evidence. A usage read never clears an inferred mark: it did not confirm that block.
	 */
	reconcile(snapshot: UsageSnapshot): void {
		if (snapshot.status !== "available" || snapshot.expiresAt <= this.now()) return;
		for (const [key, { mark }] of this.marks) {
			if (mark.provider !== snapshot.provider || mark.evidence) continue;
			if (
				snapshot.windows.some(
					(window) =>
						window.name === mark.window &&
						window.usedPercent < 100 &&
						window.scope === (mark.families?.length ? "model" : "provider") &&
						scopeKey(snapshot.provider, window.scope === "model" ? window.families : undefined) ===
							scopeKey(mark.provider, mark.families),
				)
			)
				this.remove(key);
		}
	}

	/** Subscribe to mark additions, updates and removals. */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => void this.listeners.delete(listener);
	}

	/** Forget every mark, e.g. from `/router reset`. */
	clear(): void {
		for (const key of this.marks.keys()) this.remove(key);
	}

	private notify(): void {
		for (const listener of this.listeners) listener();
	}

	private remove(key: string): void {
		this.detach(key);
		this.marks.delete(key);
		this.counted.delete(key);
		this.notify();
	}

	private detach(key: string): void {
		this.lifetimes.get(key)?.[Symbol.dispose]();
		this.lifetimes.delete(key);
	}
}
