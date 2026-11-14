/**
 * Fresh `router/default` startup, quota dispatch and resume through core's real startup path
 * (`createAgentSessionServices` -> `resolveCliModel` -> `createAgentSessionFromServices`).
 * Only provider replies and quota snapshots are doubles; no credentials, no network.
 *
 * Owner decision (nredd/dotfiles#84): fresh personal startup selects `router/default`;
 * resume/continue keeps the session's last model, including an explicit physical model.
 *
 * TODO: move to top-level `tests/` once #867 lands, and swap the local helpers for
 * `@nredd/pi-test-lib` once #891 merges.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
	type ExtensionFactory,
	ModelRuntime,
	resolveCliModel,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
	createTestUiContext,
	type FauxProviderRegistration,
	fauxAssistantMessage,
} from "@earendil-works/pi-coding-agent/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigResult, Profile } from "../../packages/subscription-router/src/config.ts";
import { createSubscriptionRouter } from "../../packages/subscription-router/src/index.ts";
import type { UsageGetOptions } from "../../packages/subscription-router/src/usage.ts";
import { GoalStack, routePhysical } from "./goal-support.ts";

const CHAIN: Profile["chain"] = [
	{ provider: "spike-a", id: "sonnet-a" },
	{ provider: "spike-b", id: "terra-b" },
];
const VIRTUAL = "router/default";
const PROFILE: Profile = { id: "default", name: "Router default", strategy: "ordered", chain: CHAIN };
const ROUTER_ON: ConfigResult = { ok: true, profiles: [PROFILE] };
const ROUTER_DISABLED: ConfigResult = { ok: false, error: "disabled for this test" };

type Selection = `${string}/${string}`;

/** One started session; `selected` is read from the live session, never from settings. */
interface Started {
	session: Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"];
	modelFallbackMessage: string | undefined;
	runtime: ModelRuntime;
	selected(): Selection;
}

interface LaunchOptions {
	/** Factory list; `"missing"` loads no router package at all. */
	router?: ConfigResult | "missing";
	/** Global `settings.json` keys, merged over the fixture defaults. */
	settings?: Record<string, unknown>;
	/** Project `.pi/settings.json` keys. */
	project?: Record<string, unknown>;
	/** CLI `--model` pattern. */
	cliModel?: string;
	sessionManager?: SessionManager;
}

describe("router/default startup, quota dispatch and resume", () => {
	let stack: GoalStack;
	let physical: FauxProviderRegistration[];
	let cwd: string;
	let agentDir: string;
	let sessionDir: string;
	let started: Started[];
	let fetched: unknown[];
	const settingsPath = () => join(agentDir, "settings.json");
	const savedSettings = () => JSON.parse(readFileSync(settingsPath(), "utf8")) as Record<string, unknown>;
	const modelChanges = (s: Started) =>
		s.session.sessionManager
			.getBranch()
			.flatMap((entry) => (entry.type === "model_change" ? [`${entry.provider}/${entry.modelId}`] : []));
	const answer = (text: string) => fauxAssistantMessage(text);
	const respondOn = (index: number, text: string) => {
		const target = physical[index];
		if (!target) throw new Error(`No physical provider at index ${index}`);
		target.setResponses([answer(text)]);
	};
	const calls = () => physical.map((p) => p.state.callCount);

	beforeEach(async () => {
		stack = await GoalStack.create();
		physical = stack.registerPhysical(CHAIN, 0);
		cwd = join(stack.home.root, "work");
		agentDir = join(stack.home.root, "agent");
		sessionDir = join(stack.home.root, "sessions");
		for (const dir of [cwd, join(cwd, ".pi"), agentDir, sessionDir]) mkdirSync(dir, { recursive: true });
		writeFileSync(
			settingsPath(),
			JSON.stringify({
				defaultProvider: "router",
				defaultModel: "default",
				retry: { enabled: false },
				compaction: { enabled: false },
			}),
		);
		started = [];
		fetched = [];
		// Nothing on the startup or dispatch path may reach the network.
		vi.stubGlobal("fetch", async (...args: unknown[]) => {
			fetched.push(args[0]);
			throw new Error("No network in startup scenarios");
		});
	});

	/** Shut down and dispose one started session, even if its shutdown handlers throw. */
	async function close(s: Started): Promise<void> {
		started.splice(started.indexOf(s), 1);
		try {
			await s.session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
		} finally {
			s.session.dispose();
		}
	}

	afterEach(async () => {
		vi.unstubAllGlobals();
		try {
			for (const s of [...started].reverse()) await close(s);
		} finally {
			await stack.cleanup();
		}
	});

	/** Start like the CLI: services, `--model` resolution, session from services, then bind. */
	async function launch(options: LaunchOptions = {}): Promise<Started> {
		if (options.settings) writeFileSync(settingsPath(), JSON.stringify({ ...savedSettings(), ...options.settings }));
		if (options.project) writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify(options.project));
		const factories: ExtensionFactory[] =
			options.router === "missing"
				? []
				: [
						createSubscriptionRouter({
							config: options.router ?? ROUTER_ON,
							usage: stack.usage,
							tracker: stack.tracker,
							now: () => stack.clock.now(),
						}),
					];
		const runtime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
		});
		for (const p of physical) await routePhysical(runtime, p);
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			modelRuntime: runtime,
			resourceLoaderOptions: { extensionFactories: factories, noSkills: true, noPromptTemplates: true, noThemes: true },
		});
		const cli = options.cliModel ? resolveCliModel({ cliModel: options.cliModel, modelRuntime: runtime }) : undefined;
		if (cli?.error) throw new Error(cli.error);
		const { session, modelFallbackMessage } = await createAgentSessionFromServices({
			services,
			sessionManager: options.sessionManager ?? SessionManager.create(cwd, sessionDir),
			model: cli?.model,
			noTools: "all",
		});
		const result: Started = {
			session,
			modelFallbackMessage,
			runtime,
			selected: () => `${session.model?.provider}/${session.model?.id}`,
		};
		started.push(result);
		await session.bindExtensions({
			mode: "print",
			uiContext: createTestUiContext({ notify: (text) => stack.notifications.push(text) }),
		});
		return result;
	}

	/** Assistant text per turn, oldest first. */
	const texts = (s: Started) =>
		s.session.messages.flatMap((m) =>
			m.role === "assistant" ? [m.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("")] : [],
		);

	/** The physical model that answered each assistant turn, oldest first. */
	const answered = (s: Started) =>
		s.session.messages.flatMap((m) => (m.role === "assistant" ? [`${m.provider}/${m.model}`] : []));

	describe("fresh startup", () => {
		it("selects router/default and dispatches by the current quota snapshot", async () => {
			const s = await launch();
			expect(s.selected()).toBe(VIRTUAL);
			expect(s.modelFallbackMessage).toBeUndefined();

			respondOn(0, "on a");
			await s.session.prompt("one");
			stack.usage.set("spike-a", 100);
			respondOn(1, "on b");
			await s.session.prompt("two");
			stack.usage.set("spike-a", 10);
			respondOn(0, "on a again");
			await s.session.prompt("three");

			expect(answered(s)).toEqual(["spike-a/sonnet-a", "spike-b/terra-b", "spike-a/sonnet-a"]);
			expect(texts(s)).toEqual(["on a", "on b", "on a again"]);
			expect(calls()).toEqual([2, 1]);
			expect(fetched).toEqual([]);
		});

		it("never persists the routed physical model as the default or the selection", async () => {
			const s = await launch();
			respondOn(0, "on a");
			await s.session.prompt("one");
			stack.usage.set("spike-a", 100);
			respondOn(1, "on b");
			await s.session.prompt("two");

			expect(s.selected()).toBe(VIRTUAL);
			expect(modelChanges(s)).toEqual([VIRTUAL]);
			expect(savedSettings()).toMatchObject({ defaultProvider: "router", defaultModel: "default" });
		});

		it("refuses the whole chain once every provider is exhausted, without a physical call", async () => {
			const s = await launch();
			stack.usage.set("spike-a", 100);
			stack.usage.set("spike-b", 100);
			await s.session.prompt("blocked");
			const failed = s.session.messages.filter((m) => m.role === "assistant").at(-1);
			expect(failed).toMatchObject({ stopReason: "error" });
			expect(failed?.role === "assistant" ? failed.errorMessage : "").toMatch(
				/router\/default: every model is unavailable/,
			);

			expect(calls()).toEqual([0, 0]);
			expect(s.selected()).toBe(VIRTUAL);
		});
	});

	describe("quota freshness at startup", () => {
		it("does not wait on a quota refresh while starting", async () => {
			// Cold cache and a refresh that never settles: startup must still complete. Warm-up only
			// covers providers with a usage collector, so this chain uses one.
			const collected: Profile["chain"] = [{ provider: "anthropic", id: "faux-warm" }];
			physical.push(...stack.registerPhysical(collected, 0));
			stack.usage.snapshots.clear();
			const reads: { provider: string; options: UsageGetOptions }[] = [];
			stack.usage.get = (_ctx, provider, options = {}) => {
				reads.push({ provider, options });
				return new Promise(() => {});
			};
			const s = await launch({ router: { ok: true, profiles: [{ ...PROFILE, chain: collected }] } });

			expect(s.selected()).toBe(VIRTUAL);
			// Background warm-up only: never forced, never fresh.
			expect(reads.length).toBeGreaterThan(0);
			expect(reads.every(({ options }) => !options.fresh && !options.force)).toBe(true);
			expect(fetched).toEqual([]);
			// A cold cache fails open to the first chain entry, still without waiting.
			respondOn(2, "cold ok");
			await s.session.prompt("go");
			expect(answered(s)).toEqual(["anthropic/faux-warm"]);
		});

		it("does not refresh for a warm cache during startup or routing", async () => {
			const s = await launch();
			respondOn(0, "warm ok");
			await s.session.prompt("go");
			expect(stack.usage.reads).toEqual([]);
			expect(s.selected()).toBe(VIRTUAL);
		});

		it("honors a stale snapshot's last-known exhaustion until its reset", async () => {
			stack.usage.set("spike-a", 100);
			const exhausted = stack.usage.snapshots.get("spike-a");
			if (!exhausted) throw new Error("Missing seeded snapshot");
			stack.usage.snapshots.set("spike-a", { ...exhausted, status: "stale" });
			const s = await launch();
			respondOn(1, "b while a is stale");
			await s.session.prompt("go");
			expect(answered(s)).toEqual(["spike-b/terra-b"]);

			// Past the recorded reset the stale block no longer applies.
			stack.clock.advance(3_600_001);
			respondOn(0, "a after reset");
			await s.session.prompt("again");
			expect(answered(s).at(-1)).toBe("spike-a/sonnet-a");
		});

		it("fails open when usage is unavailable", async () => {
			stack.usage.snapshots.set("spike-a", {
				provider: "spike-a",
				status: "unavailable",
				windows: [],
				retrievedAt: stack.clock.now(),
				expiresAt: stack.clock.now(),
				message: "offline",
			});
			const s = await launch();
			respondOn(0, "fail open");
			await s.session.prompt("go");
			expect(answered(s)).toEqual(["spike-a/sonnet-a"]);
		});
	});

	describe("router unavailable", () => {
		for (const mode of ["missing", "disabled"] as const) {
			it(`falls back to a physical model and keeps the saved default when the router is ${mode}`, async () => {
				const s = await launch({ router: mode === "missing" ? "missing" : ROUTER_DISABLED });
				expect(s.selected()).not.toBe(VIRTUAL);
				expect(s.session.model?.provider).toMatch(/^spike-/);
				expect(s.session.model?.api).not.toBe("pi-virtual");
				if (mode === "disabled")
					expect(stack.notifications.join("\n")).toContain("subscription-router: ignoring config");
				// The fallback is never written back over the user's `router/default`.
				expect(savedSettings()).toMatchObject({ defaultProvider: "router", defaultModel: "default" });
				const index = physical.findIndex((p) => p.getModel().provider === s.session.model?.provider);
				respondOn(index, "fallback ok");
				await s.session.prompt("go");
				expect(answered(s)).toHaveLength(1);
			});
		}

		it("restores the physical model a router/default session last used when the router is gone", async () => {
			const first = await launch();
			respondOn(0, "on a");
			await first.session.prompt("one");
			const file = first.session.sessionManager.getSessionFile() as string;
			await close(first);

			const resumed = await launch({ router: "missing", sessionManager: SessionManager.open(file, sessionDir) });
			// Core drops an unregistered virtual selection and keeps the physical model that answered last.
			expect(resumed.selected()).toBe("spike-a/sonnet-a");
			expect(savedSettings()).toMatchObject({ defaultProvider: "router", defaultModel: "default" });
		});
	});

	describe("session restore", () => {
		/** Run one prompted turn, dispose, and return the session file. */
		async function persisted(select?: Selection): Promise<string> {
			const s = await launch();
			if (select) {
				const [provider, id] = select.split("/") as [string, string];
				const model = s.runtime.getModel(provider, id);
				if (!model) throw new Error(`No model ${select}`);
				await s.session.setModel(model);
			}
			const index = select === "spike-b/terra-b" ? 1 : 0;
			respondOn(index, "turn");
			await s.session.prompt("one");
			const file = s.session.sessionManager.getSessionFile() as string;
			await close(s);
			return file;
		}

		it("resumes an explicit physical model over the saved router/default", async () => {
			const file = await persisted("spike-b/terra-b");
			// An explicit physical model is not rerouted, even once its provider reads exhausted.
			stack.usage.set("spike-b", 100);
			const resumed = await launch({ sessionManager: SessionManager.open(file, sessionDir) });
			expect(resumed.selected()).toBe("spike-b/terra-b");
			respondOn(1, "still b");
			await resumed.session.prompt("two");
			expect(answered(resumed).at(-1)).toBe("spike-b/terra-b");
			expect(savedSettings()).toMatchObject({ defaultProvider: "router", defaultModel: "default" });
		});

		it("continues the most recent session on its physical model", async () => {
			await persisted("spike-b/terra-b");
			const resumed = await launch({ sessionManager: SessionManager.continueRecent(cwd, sessionDir) });
			expect(resumed.selected()).toBe("spike-b/terra-b");
		});

		it("restores router/default when it was the last selection, then keeps routing", async () => {
			const file = await persisted();
			const resumed = await launch({ sessionManager: SessionManager.open(file, sessionDir) });
			expect(resumed.selected()).toBe(VIRTUAL);
			expect(modelChanges(resumed)).toEqual([VIRTUAL]);
			stack.usage.set("spike-a", 100);
			respondOn(1, "rerouted");
			await resumed.session.prompt("two");
			expect(answered(resumed).at(-1)).toBe("spike-b/terra-b");
			expect(resumed.selected()).toBe(VIRTUAL);
		});

		it("restores router/default over a different saved default", async () => {
			const file = await persisted();
			const resumed = await launch({
				sessionManager: SessionManager.open(file, sessionDir),
				settings: { defaultProvider: "spike-b", defaultModel: "terra-b" },
			});
			expect(resumed.selected()).toBe(VIRTUAL);
		});
	});

	describe("explicit overrides of the saved default", () => {
		it("CLI --model wins over the saved router/default", async () => {
			const s = await launch({ cliModel: "spike-b/terra-b" });
			expect(s.selected()).toBe("spike-b/terra-b");
			expect(savedSettings()).toMatchObject({ defaultProvider: "router", defaultModel: "default" });
		});

		it("CLI --model router/default wins over a saved physical default", async () => {
			const s = await launch({
				cliModel: VIRTUAL,
				settings: { defaultProvider: "spike-b", defaultModel: "terra-b" },
			});
			expect(s.selected()).toBe(VIRTUAL);
		});

		it("project settings win over the saved global default", async () => {
			const s = await launch({ project: { defaultProvider: "spike-b", defaultModel: "terra-b" } });
			expect(s.selected()).toBe("spike-b/terra-b");
		});

		it("CLI --model wins over project settings", async () => {
			const s = await launch({
				cliModel: VIRTUAL,
				project: { defaultProvider: "spike-b", defaultModel: "terra-b" },
			});
			expect(s.selected()).toBe(VIRTUAL);
		});
	});
});
