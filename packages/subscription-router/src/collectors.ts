import { BUILTIN_COLLECTORS } from "./builtin-collectors.ts";
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
/** Pi provider IDs (`PROVIDER_ID` in `config.ts`), capped at 256 characters. */
const COLLECTOR_ID = /^[^\s/]{1,256}$/;

/**
 * True only for a primitive string ID. Never coerces: Pi resolves a non-string credential
 * argument as a model and reads its `provider`, which would bypass built-in reservation.
 */
export function isCollectorId(id: unknown): id is string {
	return typeof id === "string" && COLLECTOR_ID.test(id);
}

/** Identity and lifetime of one installation, not of the supplied adapter. */
export interface CollectorRegistration {
	readonly collector: Readonly<Collector>;
	readonly signal: AbortSignal;
}

interface CollectorRegistry {
	readonly version: 1;
	register(collector: Collector): () => void;
	registrationFor(id: string): CollectorRegistration | undefined;
	collectorFor(id: string): Readonly<Collector> | undefined;
	collectedProviders(): string[];
}

const builtins = new Map(
	BUILTIN_COLLECTORS.map((collector) => [
		collector.provider,
		Object.freeze({ collector, signal: new AbortController().signal }),
	]),
);

const ADAPTER_KEYS: readonly PropertyKey[] = [
	"provider",
	"display",
	"acceptsCredential",
	"kind",
	"request",
	"parse",
	"read",
];

/**
 * Read own enumerable fields (receiver state that methods reach through `this`) and each declared
 * field once. Own fields go through their descriptors, so an accessor runs exactly once; inherited
 * declared fields, e.g. class methods, are read once. Getters run here, before any registry state is read.
 */
function snapshotAdapter(adapter: Collector): Readonly<Collector> {
	const copy: Record<PropertyKey, unknown> = {};
	const keep = (key: PropertyKey, value: unknown) => {
		if (value !== undefined) Object.defineProperty(copy, key, { value, enumerable: true });
	};
	const seen = new Set<PropertyKey>();
	const descriptors: Record<PropertyKey, PropertyDescriptor> = Object.getOwnPropertyDescriptors(adapter);
	for (const key of Reflect.ownKeys(descriptors)) {
		const descriptor = descriptors[key] as PropertyDescriptor;
		if (!descriptor.enumerable && !ADAPTER_KEYS.includes(key)) continue;
		seen.add(key);
		keep(key, "value" in descriptor ? descriptor.value : descriptor.get?.call(adapter));
	}
	for (const key of ADAPTER_KEYS) {
		if (!seen.has(key)) keep(key, Reflect.get(adapter, key));
	}
	return Object.freeze(copy) as Readonly<Collector>;
}

function createRegistry(): CollectorRegistry {
	const entries = new Map<string, CollectorRegistration>();
	const controllers = new WeakMap<CollectorRegistration, AbortController>();
	return Object.freeze({
		version: 1 as const,
		register(adapter: Collector) {
			const collector = snapshotAdapter(adapter);
			// No extension code runs from here through predecessor selection and publication.
			const { provider } = collector;
			if (!isCollectorId(provider)) {
				throw new TypeError(
					"Collector provider must be a non-blank string ID without whitespace or slashes (at most 256 characters).",
				);
			}
			if (builtins.has(provider))
				throw new Error(`Cannot register collector "${provider}": ID is reserved for a built-in.`);
			const old = entries.get(provider);
			const lifetime = new AbortController();
			const entry = Object.freeze({ collector, signal: lifetime.signal });
			controllers.set(entry, lifetime);
			entries.set(provider, entry);
			if (old) controllers.get(old)?.abort();
			return () => {
				if (entries.get(provider) !== entry) return;
				entries.delete(provider);
				lifetime.abort();
			};
		},
		registrationFor: (id: string) => entries.get(id),
		collectorFor: (id: string) => registrationFor(id)?.collector,
		collectedProviders: () => [...entries.keys()],
	});
}

const REGISTRY_METHODS = ["register", "registrationFor", "collectorFor", "collectedProviders"] as const;

/**
 * Reuse a compatible registry from another copy of this module, or install a fresh one in a
 * non-writable, non-configurable slot so a later copy cannot split-brain it. This rejects buggy
 * registries; it does not authenticate trusted in-process code that installed the slot first.
 */
function sharedRegistry(): CollectorRegistry {
	const existing: unknown = Reflect.get(globalThis, COLLECTORS_KEY);
	if (existing === undefined) {
		const created = createRegistry();
		Object.defineProperty(globalThis, COLLECTORS_KEY, { value: created, writable: false, configurable: false });
		return created;
	}
	const candidate = existing as Partial<Record<string, unknown>> | null;
	if (candidate?.version !== 1) {
		throw new Error("Unsupported pi-subscription-router.collectors registry version (expected 1).");
	}
	if (REGISTRY_METHODS.some((method) => typeof candidate[method] !== "function")) {
		throw new Error("Refusing a malformed pi-subscription-router.collectors registry (version 1).");
	}
	return candidate as unknown as CollectorRegistry;
}

const registry = sharedRegistry();

/** Register or replace an external collector. Cleanup never removes a later registration. */
export function registerCollector(collector: Collector): () => void {
	return registry.register(collector);
}

export function registrationFor(id: string): CollectorRegistration | undefined {
	if (!isCollectorId(id)) return undefined;
	return builtins.get(id) ?? registry.registrationFor(id);
}

/** True only for a shipped adapter object, which the router does not bound like external evidence. */
export function isBuiltinCollector(collector: Readonly<Collector>): boolean {
	return builtins.get(collector.provider)?.collector === collector;
}

export function collectorFor(id: string): Readonly<Collector> | undefined {
	return registrationFor(id)?.collector;
}

export function collectedProviders(): string[] {
	// Another router copy's registry may predate string-only IDs.
	return [...new Set([...builtins.keys(), ...registry.collectedProviders().filter(isCollectorId)])];
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
