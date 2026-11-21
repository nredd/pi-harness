import type { ExhaustionMark } from "./exhaustion.ts";
import type { CreditPool, UsageMeter, UsageSnapshot, UsageSpanSource } from "./usage.ts";

export interface ProviderDisplay {
	full: string;
	compact: string;
	footer?: { show?: Array<{ name: string } | { durationMs: number }>; placeholder?: boolean };
}

type ViewSnapshot = UsageSnapshot<UsageSpanSource>;

export interface ProviderView {
	provider: string;
	display: ProviderDisplay;
	access: "subscription" | "metered" | "unknown";
	snapshot?: ViewSnapshot;
	meters: UsageMeter[];
	pools: CreditPool[];
	marks: ExhaustionMark[];
}

/** RPC data, inside the existing success envelope. The legacy fields retain their shape and order. */
export interface UsageReplyV2 {
	version: 2;
	snapshots: ViewSnapshot[];
	blocks: ExhaustionMark[];
	views: ProviderView[];
}

function defaultDisplay(provider: string): ProviderDisplay {
	switch (provider) {
		case "anthropic":
			return {
				full: "Anthropic",
				compact: "Anth",
				footer: { show: [{ name: "five_hour" }, { name: "seven_day" }], placeholder: true },
			};
		case "openai-codex":
			return { full: "OpenAI", compact: "OAI", footer: { show: [{ durationMs: 604_800_000 }], placeholder: true } };
		default:
			return { full: provider, compact: provider };
	}
}

/**
 * Project providers in caller order, with their latest snapshots and already-active marks.
 * Keep the original snapshot intact (including assumed spans and stale/error status) so
 * consumers can retain legacy rendering. Never infer access from a provider id or a mark.
 */
export function describe(
	providers: readonly string[],
	snapshots: readonly ViewSnapshot[],
	marks: readonly ExhaustionMark[],
	displays?: ReadonlyMap<string, ProviderDisplay>,
): ProviderView[] {
	return providers.map((provider) => {
		const snapshot = snapshots.find((reading) => reading.provider === provider);
		return {
			provider,
			display: displays?.get(provider) ?? defaultDisplay(provider),
			access: snapshot?.access ?? "unknown",
			...(snapshot === undefined ? {} : { snapshot }),
			meters: snapshot?.meters ?? [],
			pools: snapshot?.pools ?? [],
			marks: marks.filter((mark) => mark.provider === provider),
		};
	});
}
