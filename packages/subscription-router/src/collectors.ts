import type { CreditPool, UsageMeter, UsageSnapshot, UsageWindow } from "./usage.ts";
import type { ProviderDisplay } from "./view.ts";

export interface CollectorReading {
	windows: UsageWindow[];
	meters?: UsageMeter[];
	pools?: CreditPool[];
	credits?: UsageSnapshot["credits"];
}

/** Trusted, read-only quota adapter for one Pi provider ID. */
export type Collector = {
	provider: string;
	display?: ProviderDisplay;
	acceptsCredential?(token: string): boolean;
} & (
	| {
			kind: "http";
			request(token: string): { url: string; method?: "GET" | "POST"; headers: Record<string, string>; body?: string };
			parse(payload: unknown): CollectorReading | undefined;
	  }
	| {
			kind: "custom";
			read(ctx: { token: string; signal: AbortSignal; now(): number }): Promise<CollectorReading | undefined>;
	  }
);

const COLLECTORS_KEY = Symbol.for("pi-subscription-router.collectors");
type Registration = { collector: Collector };
const host = globalThis as typeof globalThis & { [COLLECTORS_KEY]?: Map<string, Registration> };
host[COLLECTORS_KEY] ??= new Map();
const registry = host[COLLECTORS_KEY];

/** Register or replace a collector. Cleanup never removes a later registration. */
export function registerCollector(collector: Collector): () => void {
	const { provider } = collector;
	const entry = { collector };
	registry.set(provider, entry);
	return () => {
		if (registry.get(provider) === entry) registry.delete(provider);
	};
}

/** Loading another copy of the router must not clobber an existing registration. */
export function registerDefaultCollector(collector: Collector): void {
	if (!registry.has(collector.provider)) registerCollector(collector);
}

export function collectorFor(provider: string): Collector | undefined {
	return registry.get(provider)?.collector;
}

export function collectedProviders(): string[] {
	return [...registry.keys()];
}

/** @deprecated Use collectedProviders() for an ordinary array snapshot. */
export const COLLECTED_PROVIDERS: readonly string[] = new Proxy<string[]>([], {
	get: (_target, key) => Reflect.get(collectedProviders(), key),
	has: (_target, key) => Reflect.has(collectedProviders(), key),
	ownKeys: () => Reflect.ownKeys(collectedProviders()),
	getOwnPropertyDescriptor: (_target, key) => Reflect.getOwnPropertyDescriptor(collectedProviders(), key),
	set: () => false,
	defineProperty: () => false,
	deleteProperty: () => false,
	preventExtensions: () => false,
});
