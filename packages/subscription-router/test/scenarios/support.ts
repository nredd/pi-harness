/** Real router/session composition with isolated, credential-free usage and faux physical providers. */
import type { ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
	createHarness,
	createTestUiContext,
	type FauxProviderRegistration,
	type Harness,
	registerFauxProvider,
} from "@earendil-works/pi-coding-agent/testing";
import type { Profile } from "../../src/config.js";
import { ExhaustionTracker } from "../../src/exhaustion.js";
import { createSubscriptionRouter } from "../../src/index.js";
import { type UsageGetOptions, UsageService, type UsageSnapshot } from "../../src/usage.js";

/** Fixed quota time; core retry timing is separately disabled with `baseDelayMs: 0`. */
export class Clock {
	private time = Date.parse("2030-01-01T00:00:00Z");
	now = (): number => this.time;

	/** Advance the quota clock without waiting for wall time. */
	advance(ms: number): void {
		this.time += ms;
	}
}

/** Mutable cached snapshots, using production eligibility/formatting but never credentials or fetch. */
export class CachedUsage extends UsageService {
	readonly snapshots = new Map<string, UsageSnapshot>();
	readonly reads: { provider: string; options: UsageGetOptions }[] = [];
	onRefresh?: (provider: string) => void;

	constructor(readonly clock: Clock) {
		super({
			now: clock.now,
			fetch: async () => {
				throw new Error("Scenario must not fetch usage");
			},
			getAccessToken: async () => {
				throw new Error("Scenario must not read credentials");
			},
		});
	}

	/** Set one source-fixture window with the same reset/duration for every provider. */
	set(provider: string, usedPercent: number, status: UsageSnapshot["status"] = "available", ageMs = 0): void {
		this.snapshots.set(provider, {
			provider,
			status,
			windows: [
				{
					name: "weekly",
					usedPercent,
					scope: "provider",
					resetAt: this.clock.now() + 3_600_000,
					durationMs: 3_600_000,
				},
			],
			retrievedAt: this.clock.now() - ageMs,
			expiresAt: ageMs > 0 || status === "stale" ? this.clock.now() : this.clock.now() + 60_000,
		});
	}

	override peek(provider: string): UsageSnapshot | undefined {
		return this.snapshots.get(provider);
	}

	override async get(_ctx: ExtensionContext, provider: string, options: UsageGetOptions = {}): Promise<UsageSnapshot> {
		this.reads.push({ provider, options });
		if (options.fresh) this.onRefresh?.(provider);
		const snapshot = this.peek(provider) ?? {
			provider,
			status: "unavailable" as const,
			windows: [],
			retrievedAt: this.clock.now(),
			expiresAt: this.clock.now(),
		};
		return { ...snapshot, retrievedAt: this.clock.now() };
	}
}

const PHYSICAL = [
	["spike-a", "sonnet-a"],
	["spike-b", "terra-b"],
	["spike-c", "third-c"],
] as const;

/** One isolated router session and its physical provider scripts. */
export interface RouterScenario {
	harness: Harness;
	providers: readonly [FauxProviderRegistration, FauxProviderRegistration, FauxProviderRegistration];
	tracker: ExhaustionTracker;
	notifications: string[];
	cleanup(): void;
}

/** Bind the real factory and three authenticated faux providers in one session, with no shared-symbol edits. */
export async function startRouter(
	usage: CachedUsage,
	strategy: Profile["strategy"] = "ordered",
	extensions: ExtensionFactory[] = [],
	settings: NonNullable<Parameters<typeof createHarness>[0]>["settings"] = {},
): Promise<RouterScenario> {
	const register = ([provider, id]: (typeof PHYSICAL)[number]): FauxProviderRegistration =>
		registerFauxProvider({ provider, models: [{ id }] });
	const providers = [register(PHYSICAL[0]), register(PHYSICAL[1]), register(PHYSICAL[2])] as const;
	const tracker = new ExhaustionTracker(usage.clock.now);
	const notifications: string[] = [];
	const profile: Profile = {
		id: "spike",
		name: "Router spike",
		strategy,
		chain: PHYSICAL.slice(0, strategy === "balanced" ? 3 : 2).map(([provider, id]) => ({ provider, id })),
	};
	let harness: Harness | undefined;
	try {
		harness = await createHarness({
			useModelRuntimeStream: true,
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 0 }, ...settings },
			extensionFactories: [
				...extensions,
				createSubscriptionRouter({
					config: { ok: true, profiles: [profile] },
					usage,
					tracker,
					now: usage.clock.now,
				}),
			],
		});
		for (const provider of providers) {
			const model = provider.getModel();
			harness.session.modelRuntime.registerProvider(model.provider, {
				baseUrl: model.baseUrl,
				apiKey: "faux",
				api: provider.api,
				models: provider.models,
			});
		}
		await harness.session.bindExtensions({
			mode: "rpc",
			uiContext: createTestUiContext({
				notify: (message) => {
					notifications.push(message);
				},
			}),
		});
		const model = harness.session.modelRuntime.getModel("router", "spike");
		if (!model) throw new Error("Real router factory did not register router/spike");
		await harness.session.setModel(model);
		const bound = harness;
		return {
			harness: bound,
			providers,
			tracker,
			notifications,
			cleanup: () => {
				bound.cleanup();
				for (const provider of providers) provider.unregister();
			},
		};
	} catch (error) {
		harness?.cleanup();
		for (const provider of providers) provider.unregister();
		throw error;
	}
}

/** Assistant completions for one prompt, including failed attempts (never silently discard errors). */
export async function prompt(
	scenario: RouterScenario,
): Promise<{ provider: string; stopReason: string; errorMessage?: string }[]> {
	const { harness } = scenario;
	const before = harness.events.length;
	await harness.session.prompt("exercise routing");
	return harness.events
		.slice(before)
		.flatMap((event) => (event.type === "message_end" && event.message.role === "assistant" ? [event.message] : []));
}
