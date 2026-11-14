/** Isolated kit stacks and shared clocks; only provider replies and quota snapshots are doubles. */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext, ExtensionFactory, ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
	createTestUiContext,
	type FauxProviderRegistration,
	type Harness,
	type HarnessOptions,
	registerFauxProvider,
} from "@earendil-works/pi-coding-agent/testing";
import { FakeClock } from "@nredd/pi-test-lib/clock";
import { createSessionKit } from "../../packages/session-kit/src/index.ts";
import { configFor } from "../../packages/session-kit/test/fixtures/session.ts";
import type { Profile } from "../../packages/subscription-router/src/config.ts";
import { ExhaustionTracker } from "../../packages/subscription-router/src/exhaustion.ts";
import { createSubscriptionRouter } from "../../packages/subscription-router/src/index.ts";
import {
	type UsageGetOptions,
	UsageService,
	type UsageSnapshot,
	type UsageTransport,
} from "../../packages/subscription-router/src/usage.ts";
import { freezeNativeTimers } from "./native-timers.ts";
import { assertHostIdentity, isolateStackHome, startStack } from "./support.ts";

export { deferred } from "@nredd/pi-test-lib/deferred";
export { nextEvent, outcomes, toolCall as tool } from "@nredd/pi-test-lib/faux";
export {
	complete,
	goalStates,
	nudges,
	spoken,
	tick,
} from "../../packages/session-kit/test/fixtures/session.ts";

/** The usage transport's side effects, refused: stack scenarios read neither credentials nor the network. */
export const OFFLINE: Pick<UsageTransport, "fetch" | "getAccessToken"> = {
	fetch: async () => {
		throw new Error("No network in stack scenarios");
	},
	getAccessToken: async () => {
		throw new Error("No credentials in stack scenarios");
	},
};

/**
 * Point a session's model runtime at one physical faux transport, refusing a registration
 * core cannot authenticate before any scenario dispatches through it.
 *
 * Parameters:
 *   runtime (Pick<ModelRuntime, "registerProvider" | "getAuth">): the session's model runtime.
 *   physical (FauxProviderRegistration): transport owned by the stack.
 *
 * Raises:
 *   Error: core resolves no auth for the registered model.
 */
export async function routePhysical(
	runtime: Pick<ModelRuntime, "registerProvider" | "getAuth">,
	physical: FauxProviderRegistration,
): Promise<void> {
	const model = physical.getModel();
	runtime.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		apiKey: "faux",
		api: physical.api,
		models: physical.models,
	});
	if (!(await runtime.getAuth(model))) {
		throw new Error(`Missing faux auth for '${model.provider}/${model.id}'`);
	}
}

/** A cached provider-level quota snapshot; fresh confirmation never reads credentials or the network. */
export class StackUsage extends UsageService {
	readonly snapshots = new Map<string, UsageSnapshot>();
	readonly reads: { provider: string; options: UsageGetOptions }[] = [];
	onRefresh?: (provider: string) => void;

	constructor(readonly clock: FakeClock) {
		super({ now: () => clock.now(), ...OFFLINE });
	}

	/** Seed fresh windows, with a reset exactly one hour from the shared fake clock. */
	set(provider: string, usedPercent: number): void {
		this.snapshots.set(provider, {
			provider,
			status: "available",
			windows: [
				{
					name: "weekly",
					usedPercent,
					scope: "provider",
					resetAt: this.clock.now() + 3_600_000,
					durationMs: 3_600_000,
				},
			],
			retrievedAt: this.clock.now(),
			expiresAt: this.clock.now() + 3_600_000,
		});
	}

	override peek(provider: string): UsageSnapshot | undefined {
		return this.snapshots.get(provider);
	}

	override async get(_ctx: ExtensionContext, provider: string, options: UsageGetOptions = {}): Promise<UsageSnapshot> {
		this.reads.push({ provider, options });
		if (options.fresh) this.onRefresh?.(provider);
		const snapshot = this.peek(provider);
		if (!snapshot) throw new Error(`Missing usage for '${provider}'`);
		return { ...snapshot, retrievedAt: this.clock.now() };
	}
}

/** Own every session and its timers, shutting down before restoring the isolated home. */
export class GoalStack {
	readonly nativeTimers = freezeNativeTimers();
	readonly clock = new FakeClock();
	readonly usage = new StackUsage(this.clock);
	readonly tracker = new ExhaustionTracker(() => this.clock.now());
	readonly notifications: string[] = [];
	private readonly live: Harness[] = [];
	private readonly physical: FauxProviderRegistration[] = [];
	private serial = 0;

	private constructor(readonly home: Awaited<ReturnType<typeof isolateStackHome>>) {}

	/** Isolate the home (and hold macOS wake assertions) before freezing timers. */
	static async create(): Promise<GoalStack> {
		return new GoalStack(await isolateStackHome());
	}

	/** Own physical transports and quota seeds; callers keep scenario responses and assertions. */
	registerPhysical(chain: Profile["chain"], usedPercent = 0): FauxProviderRegistration[] {
		return chain.map(({ provider, id }) => {
			this.usage.set(provider, usedPercent);
			const registration = registerFauxProvider({ provider, models: [{ id }] });
			this.physical.push(registration);
			return registration;
		});
	}

	/**
	 * Import after home isolation and native-timer freezing. Every positive native timeout/
	 * interval stays inert through shutdown, proving passing outcomes need none to fire.
	 * Zero/omitted delays pass through: core retry uses baseDelayMs: 0, a real macrotask
	 * with no elapsed-time assertion; no core clock seam needed (orchestrator ruling, #33).
	 * Known residuals (diagnostics, NOT an exhaustive allowlist):
	 * - Admission fail-open timeout: 100 ms.
	 * - AgentManager retention sweep: periodic finished-record eviction.
	 * - Child-shutdown watchdog: 3 s.
	 * - Foreground spinner and AgentWidget repaint: 80 ms.
	 * - FleetList repaint: 200 ms.
	 * - rpiv-todo overlay prewarm: 2000 ms.
	 */
	async subagents(): Promise<ExtensionFactory> {
		assertHostIdentity("pi-subagents");
		const url = new URL("../../packages/subagents/src/index.ts", import.meta.url);
		const { createSubagentsExtension } = (await import(/* @vite-ignore */ url.href)) as {
			createSubagentsExtension(options: { clock: FakeClock }): ExtensionFactory;
		};
		return createSubagentsExtension({ clock: this.clock });
	}

	/** Real kit with no disk configuration or process-oriented modules enabled. */
	kit(): ExtensionFactory {
		return createSessionKit({
			config: configFor("goal", "loop"),
			agentDir: join(this.home.root, "agent"),
			monitorRoot: join(this.home.root, "monitors"),
			clock: this.clock,
		});
	}

	/** Real router sharing exactly the kit's quota/loop/wake clock. */
	router(chain: Profile["chain"], extra: Partial<Profile> = {}): ExtensionFactory {
		return createSubscriptionRouter({
			config: { ok: true, profiles: [{ id: "spike", name: "Spike", strategy: "ordered", chain, ...extra }] },
			usage: this.usage,
			tracker: this.tracker,
			now: () => this.clock.now(),
		});
	}

	/** Bind print by default so slash commands never add incidental kickoff prompts. */
	async start(
		factories: ExtensionFactory[],
		options: Pick<HarnessOptions, "settings" | "sessionManager" | "useModelRuntimeStream"> = {},
	): Promise<Harness> {
		const cwd = join(this.home.root, `work-${++this.serial}`);
		mkdirSync(cwd, { recursive: true });
		const h = await startStack({
			cwd,
			factories,
			withConfiguredAuth: true,
			ui: createTestUiContext({ notify: (text) => this.notifications.push(text) }),
			settings: { retry: { enabled: false }, compaction: { enabled: false } },
			...options,
		});
		this.live.push(h);
		for (const p of this.physical) await routePhysical(h.session.modelRuntime, p);
		return h;
	}

	/** Drain extension resources, then dispose their actual host sessions. */
	async cleanup(): Promise<void> {
		try {
			for (const h of this.live.splice(0).reverse()) {
				try {
					await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
				} finally {
					h.cleanup();
				}
			}
		} finally {
			try {
				for (const p of this.physical.splice(0)) p.unregister();
				await this.home.cleanup();
			} finally {
				this.nativeTimers.restore();
			}
		}
	}
}
