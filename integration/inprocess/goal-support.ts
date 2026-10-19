/** Isolated kit stacks and shared clocks; only provider replies and quota snapshots are doubles. */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
	createTestUiContext,
	type FauxProviderRegistration,
	type Harness,
	type HarnessOptions,
	registerFauxProvider,
} from "@earendil-works/pi-coding-agent/testing";
import { createSessionKit } from "../../packages/session-kit/src/index.ts";
import { configFor, FakeClock } from "../../packages/session-kit/test/scenarios/support.ts";
import type { Profile } from "../../packages/subscription-router/src/config.ts";
import { ExhaustionTracker } from "../../packages/subscription-router/src/exhaustion.ts";
import { createSubscriptionRouter } from "../../packages/subscription-router/src/index.ts";
import {
	type UsageGetOptions,
	UsageService,
	type UsageSnapshot,
} from "../../packages/subscription-router/src/usage.ts";
import { assertHostIdentity, isolateStackHome, startStack } from "./support.ts";

export {
	complete,
	deferred,
	goalStates,
	nextEvent,
	nudges,
	outcomes,
	spoken,
	tick,
	tool,
} from "../../packages/session-kit/test/scenarios/support.ts";

/** A cached provider-level quota snapshot; fresh confirmation never reads credentials or the network. */
export class StackUsage extends UsageService {
	readonly snapshots = new Map<string, UsageSnapshot>();
	readonly reads: { provider: string; options: UsageGetOptions }[] = [];
	onRefresh?: (provider: string) => void;

	constructor(readonly clock: FakeClock) {
		super({
			now: () => clock.now(),
			fetch: async () => {
				throw new Error("No network in stack scenarios");
			},
			getAccessToken: async () => {
				throw new Error("No credentials in stack scenarios");
			},
		});
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
	readonly home = isolateStackHome();
	readonly clock = new FakeClock();
	readonly usage = new StackUsage(this.clock);
	readonly tracker = new ExhaustionTracker(() => this.clock.now());
	readonly notifications: string[] = [];
	private readonly live: Harness[] = [];
	private readonly physical: FauxProviderRegistration[] = [];
	private serial = 0;

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
	 * Import after home isolation; scheduling and completion delivery share the fake clock.
	 * Residual fork-native timers (not driven by clock.advance):
	 * - quota-admission.ts's 100 ms fail-open timeout is cancelled by the cached router reply.
	 *   Admission tests assert the exact returned quota block, which a timeout cannot produce.
	 * - AgentManager's retention sweep only evicts old finished records, not dispatches or
	 *   notices. These tests never wait for retention; the interval is unref'd in its constructor
	 *   and cleared by dispose(), reached through cleanup()'s awaited quit shutdown below.
	 * Follow-up fork seams: pass Clock to checkAdmission and AgentManager retention/cleanup
	 * (including retention timestamps). No asserted path here needs either native timer to fire.
	 */
	async subagents(): Promise<ExtensionFactory> {
		assertHostIdentity("pi-subagents");
		const url = new URL("../../forks/pi-subagents/src/index.ts", import.meta.url);
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
		for (const p of this.physical) {
			const model = p.getModel();
			h.session.modelRuntime.registerProvider(model.provider, {
				baseUrl: model.baseUrl,
				apiKey: "faux",
				api: p.api,
				models: p.models,
			});
			if (!(await h.session.modelRuntime.getAuth(model))) {
				throw new Error(`Missing faux auth for '${model.provider}/${model.id}'`);
			}
		}
		return h;
	}

	/** Drain extension resources, then dispose their actual host sessions. */
	async cleanup(): Promise<void> {
		for (const h of this.live.reverse()) {
			await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			h.cleanup();
		}
		for (const p of this.physical.splice(0)) p.unregister();
		this.home.cleanup();
	}
}
