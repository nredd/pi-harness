import { BUILTIN_COLLECTORS } from "./builtin-collectors.ts";
import type { ExhaustionMark } from "./exhaustion.ts";
import type { CreditPool, UsageMeter, UsageSnapshot, UsageSpanSource } from "./usage.ts";

export interface ProviderDisplay {
	full: string;
	compact: string;
	footer?: { show?: Array<{ name: string } | { durationMs: number }>; placeholder?: boolean };
}

type ViewSnapshot = UsageSnapshot<UsageSpanSource>;
// View data is a wire DTO; recursively map its objects and arrays to readonly types.
type ReadonlyView<T> = { readonly [K in keyof T]: ReadonlyView<T[K]> };

export interface ProviderView {
	readonly provider: string;
	readonly display: ReadonlyView<ProviderDisplay>;
	readonly access: "subscription" | "metered" | "unknown";
	readonly snapshot?: ReadonlyView<ViewSnapshot>;
	readonly meters: readonly ReadonlyView<UsageMeter>[];
	readonly pools: readonly ReadonlyView<CreditPool>[];
	readonly marks: readonly ReadonlyView<ExhaustionMark>[];
}

/** RPC data, inside the existing success envelope. The legacy fields retain their shape and order. */
export interface UsageReplyV2 {
	version: 2;
	snapshots: ViewSnapshot[];
	blocks: ExhaustionMark[];
	views: readonly ProviderView[];
}

function defaultDisplay(provider: string): ProviderDisplay {
	return (
		BUILTIN_COLLECTORS.find((collector) => collector.provider === provider)?.display ?? {
			full: provider,
			compact: provider,
		}
	);
}

/**
 * Project providers in caller order, with their latest snapshots and already-active marks.
 * For equal retrievedAt values, keep the first snapshot in input order.
 * Copy the view data without changing readings (including assumed spans and stale/error status)
 * so consumers can retain legacy rendering. Never infer access from a provider id or a mark.
 */
export function describe(
	providers: readonly string[],
	snapshots: readonly ViewSnapshot[],
	marks: readonly ExhaustionMark[],
	displays?: ReadonlyMap<string, ProviderDisplay>,
): readonly ProviderView[] {
	const latest = new Map<string, ViewSnapshot>();
	for (const reading of snapshots) {
		const previous = latest.get(reading.provider);
		if (previous === undefined || reading.retrievedAt > previous.retrievedAt) {
			latest.set(reading.provider, reading);
		}
	}
	return providers.map((provider) => {
		const snapshot = latest.get(provider);
		return structuredClone({
			provider,
			display: displays?.get(provider) ?? defaultDisplay(provider),
			access: snapshot?.access ?? "unknown",
			...(snapshot === undefined ? {} : { snapshot }),
			meters: snapshot?.meters ?? [],
			pools: snapshot?.pools ?? [],
			marks: marks.filter((mark) => mark.provider === provider),
		});
	});
}
