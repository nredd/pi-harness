/** Tier requests traverse the real Pi registry, router extension, child sessions and schedule store. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createTestUiContext, fauxAssistantMessage } from "@earendil-works/pi-coding-agent/testing";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_AGENTS } from "../../packages/subagents/src/default-agents.ts";
import { setAgentModels } from "../../packages/subagents/src/model-resolver.ts";
import { setModelTiers, type TierDisclosure } from "../../packages/subagents/src/model-tiers.ts";
import { type ChainEntry, parseConfig } from "../../packages/subscription-router/src/config.ts";
import {
	createSubscriptionRouter,
	type SubscriptionRouterOptions,
} from "../../packages/subscription-router/src/index.ts";
import { GoalStack, outcomes, tool } from "./goal-support.ts";

const CHAIN: [ChainEntry, ChainEntry] = [
	{ provider: "tier-haiku", id: "haiku" },
	{ provider: "tier-luna", id: "luna" },
];
const ref = (index: 0 | 1) => `${CHAIN[index]?.provider}/${CHAIN[index]?.id}`;

describe("model-tier/router stack", () => {
	let stack: GoalStack;
	afterEach(async () => {
		await stack?.cleanup();
		delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-harness:tier-router")];
	});

	function configure(members = ["router/cheap"], overrides: Record<string, unknown> = {}): void {
		const dir = join(stack.home.root, "agent");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "settings.json"),
			JSON.stringify({ extensions: [fileURLToPath(new URL("./fixtures/tier-router.ts", import.meta.url))] }),
		);
		writeFileSync(
			join(dir, "subagents.json"),
			JSON.stringify({
				fleetView: false,
				rememberAgents: true,
				modelTiers: { cheap: members },
				modelResolution: { onUnmapped: "error", onUnavailable: "error" },
				agentModels: { "*": "@cheap" },
				...overrides,
			}),
		);
	}

	function router(policy: "wait" | "fail" = "wait"): ExtensionFactory {
		const [cheap] = parseConfig(
			JSON.parse(
				readFileSync(
					new URL("../../packages/subscription-router/examples/subscription-router.json", import.meta.url),
					"utf8",
				),
			),
		);
		if (!cheap) throw new Error("Missing shipped cheap profile");
		expect(cheap).toMatchObject({
			id: "cheap",
			strategy: "ordered",
			exhaustion: { policy: "wait" },
			chain: [
				{ provider: "anthropic", id: "claude-haiku-5-5" },
				{ provider: "openai-codex", id: "gpt-6-luna" },
			],
		});
		const options: SubscriptionRouterOptions = {
			config: {
				ok: true,
				profiles: [
					{ ...cheap, chain: CHAIN, exhaustion: { policy } },
					{ id: "default", name: "Default must never run", strategy: "ordered", chain: [CHAIN[0]] },
				],
			},
			usage: stack.usage,
			tracker: stack.tracker,
			now: () => stack.clock.now(),
		};
		(globalThis as Record<symbol, unknown>)[Symbol.for("pi-harness:tier-router")] = options;
		return createSubscriptionRouter(options);
	}

	/** The public manager registry, not a replacement manager or admission mock. */
	function manager() {
		const entry = (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagents:manager")];
		if (!entry) throw new Error("Missing real subagent manager");
		return entry as {
			waitForAll(): Promise<void>;
			getRecord(id: string):
				| {
						id: string;
						modelTier?: TierDisclosure;
						previousModelTier?: TierDisclosure;
						outputFile?: string;
						sessionFile?: string;
				  }
				| undefined;
		};
	}

	it.each(["routed", "static", "unmapped", "unavailable", "enterprise"] as const)(
		"built-in Explore resolves @cheap visibly: %s",
		async (kind) => {
			stack = await GoalStack.create();
			expect(DEFAULT_AGENTS.get("Explore")?.model).toBe("@cheap");
			configure(kind === "static" ? [ref(0)] : undefined, {
				agentModels: {},
				...(kind === "unmapped" || kind === "enterprise" ? { modelTiers: {} } : {}),
			});
			if (kind === "enterprise")
				writeFileSync(
					join(stack.home.root, "agent/enterprise.local.json"),
					JSON.stringify({
						version: 1,
						subagents: { modelAliases: { "claude-haiku-4-5": [ref(0)] } },
					}),
					{ mode: 0o600 },
				);
			const physical = stack.registerPhysical(CHAIN);
			const h = await stack.start([await stack.subagents(), ...(kind === "unavailable" ? [] : [router()])], {
				useModelRuntimeStream: true,
			});
			physical[0]?.setResponses([fauxAssistantMessage("EXPLORE CHEAP ANSWER")]);
			h.setResponses([
				tool("Agent", {
					subagent_type: "Explore",
					description: "built-in cheap",
					prompt: "answer",
					run_in_background: false,
				}),
				fauxAssistantMessage("DRIVER DONE"),
			]);
			await h.session.prompt("explore");
			const result = outcomes(h, "Agent")[0];
			if (kind === "unmapped" || kind === "unavailable") {
				expect(result?.isError, JSON.stringify(result)).toBe(true);
				expect(result?.text).toContain(`@cheap is ${kind}`);
				expect(physical.map((p) => p.state.callCount)).toEqual([0, 0]);
			} else {
				expect(result?.isError).toBe(false);
				expect(result?.text).toContain(`Model: @cheap -> ${ref(0)}`);
				expect(result?.text).toContain(kind === "routed" ? "via router/cheap" : "(static");
				expect(result?.text).toContain("EXPLORE CHEAP ANSWER");
				expect(physical.map((p) => p.state.callCount)).toEqual([1, 0]);
			}
		},
	);

	it.each(["Agent", "nested", "RPC", "mention"] as const)(
		"real-router %s honors wildcard and definition tiers",
		async (path) => {
			stack = await GoalStack.create();
			configure(undefined, {
				modelTiers: { cheap: ["router/cheap"], defined: ["router/cheap"] },
				agentModels: { "*": "@cheap", delegator: ref(0) },
				agentMentions: "direct",
			});
			const agents = join(stack.home.root, "agent/agents");
			mkdirSync(agents, { recursive: true });
			writeFileSync(
				join(agents, "scout.md"),
				"---\ndescription: Tier scout\nmodel: '@defined'\ntools: read\n---\nAnswer.",
			);
			for (const source of ["wildcard", "definition"])
				writeFileSync(
					join(agents, `scout-${source}.md`),
					"---\ndescription: Tier scout\nmodel: '@defined'\ntools: read\n---\nAnswer.",
				);
			writeFileSync(
				join(agents, "delegator.md"),
				"---\ndescription: Delegator\nallowed_subagents: scout\ntools: read\n---\nDelegate.",
			);
			const physical = stack.registerPhysical(CHAIN);
			stack.usage.set(CHAIN[0]?.provider, 100);
			let pi!: ExtensionAPI;
			const admissions: string[] = [];
			const usages: unknown[] = [];
			const h = await stack.start(
				[
					await stack.subagents(),
					router(),
					(api) => {
						pi = api;
						api.events.on("router:rpc:admit", (raw) => admissions.push((raw as { model: string }).model));
						api.events.on("subagents:usage", (raw) => usages.push(raw));
					},
				],
				{ useModelRuntimeStream: true },
			);
			h.session.extensionRunner.setUIContext(
				createTestUiContext({ notify: (text) => stack.notifications.push(text) }),
				"tui",
			);
			for (const source of ["wildcard", "definition"] as const) {
				setAgentModels(source === "wildcard" ? { "*": "@cheap", delegator: ref(1) } : { delegator: ref(1) });
				physical[1]?.setResponses(
					path === "nested"
						? [
								tool("Agent", { subagent_type: "scout", description: "nested tier", prompt: "answer" }),
								fauxAssistantMessage("NESTED TIER ANSWER"),
								fauxAssistantMessage("DELEGATOR DONE"),
							]
						: [fauxAssistantMessage("TIER ANSWER")],
				);
				const before = usages.length;
				if (path === "RPC") {
					const requestId = `tier-${source}`;
					const reply = new Promise<unknown>((resolve) =>
						pi.events.on(`subagents:rpc:spawn:reply:${requestId}`, resolve),
					);
					pi.events.emit("subagents:rpc:spawn", { requestId, type: "scout", prompt: "answer" });
					expect(await reply).toMatchObject({ success: true });
					await manager().waitForAll();
				} else if (path === "mention") {
					// Fresh handle per iteration: the second dispatch must select the definition, not resume the first.
					const name = `scout-${source}`;
					expect(await h.session.extensionRunner.emitInput(`@${name} answer`, undefined, "interactive")).toMatchObject({
						action: "handled",
					});
					await manager().waitForAll();
				} else {
					h.setResponses([
						tool("Agent", {
							subagent_type: path === "nested" ? "delegator" : "scout",
							description: "parity tier",
							prompt: "answer",
							run_in_background: false,
						}),
						fauxAssistantMessage("DRIVER DONE"),
					]);
					await h.session.prompt("dispatch");
				}
				expect(usages.slice(before)).toContainEqual(
					expect.objectContaining({
						model: ref(1),
						modelTier: expect.objectContaining({
							kind: "routed",
							tier: source === "wildcard" ? "cheap" : "defined",
							profile: "router/cheap",
							admitted: ref(1),
							answered: ref(1),
						}),
					}),
				);
			}
			expect(admissions.filter((model) => model.startsWith("router/"))).toEqual(["router/cheap", "router/cheap"]);
			expect(physical[0]?.state.callCount).toBe(0);
			expect(physical[1]?.state.callCount).toBe(path === "nested" ? 6 : 2);
		},
	);

	it("runs the original admitted selection even if bindings change before runner construction", async () => {
		stack = await GoalStack.create();
		configure([ref(0), ref(1)]);
		const physical = stack.registerPhysical(CHAIN);
		stack.usage.set(CHAIN[0]?.provider, 100);
		const admissions: string[] = [];
		const h = await stack.start(
			[
				await stack.subagents(),
				router(),
				(pi) => {
					pi.events.on("router:rpc:admit", (raw) => admissions.push((raw as { model: string }).model));
					pi.events.on("subagents:started", () => {
						setModelTiers({ cheap: [ref(0)] }, {});
						setAgentModels({ "*": ref(0) });
					});
				},
			],
			{ useModelRuntimeStream: true },
		);
		physical[1]?.setResponses([fauxAssistantMessage("ADMITTED MEMBER ANSWER")]);
		h.setResponses([
			tool("Agent", {
				subagent_type: "general-purpose",
				description: "one admission",
				prompt: "answer",
				run_in_background: false,
			}),
			fauxAssistantMessage("DRIVER DONE"),
		]);
		await h.session.prompt("dispatch");
		expect(admissions).toEqual([ref(0), ref(1)]);
		expect(physical.map((p) => p.state.callCount)).toEqual([0, 1]);
		expect(outcomes(h, "Agent")[0]?.text).toContain(`Model: @cheap -> ${ref(1)} (static)`);
		expect(outcomes(h, "Agent")[0]?.text).toContain("ADMITTED MEMBER ANSWER");
	});

	it.each([
		"changed",
		"unavailable-inherit",
		"unmapped-inherit",
		"unavailable-error",
		"unmapped-error",
		"live",
	] as const)("real-router continuation discloses its actual outcome: %s", async (change) => {
		stack = await GoalStack.create();
		configure(undefined, { agentMentions: "direct" });
		const physical = stack.registerPhysical(CHAIN);
		const started: unknown[] = [];
		const completed: { id: string; modelTier?: unknown; modelNote?: string }[] = [];
		const admissions: string[] = [];
		const h = await stack.start(
			[
				await stack.subagents(),
				router(),
				(api) => {
					api.events.on("subagents:started", (raw) => started.push(raw));
					api.events.on("subagents:completed", (raw) => completed.push(raw as (typeof completed)[number]));
					api.events.on("router:rpc:admit", (raw) => admissions.push((raw as { model: string }).model));
				},
			],
			{ useModelRuntimeStream: true },
		);
		physical[0]?.setResponses([fauxAssistantMessage("ORIGINAL")]);
		h.setResponses([
			tool("Agent", {
				subagent_type: "general-purpose",
				description: "continuation",
				prompt: "answer",
				run_in_background: false,
			}),
			fauxAssistantMessage("DRIVER DONE"),
		]);
		await h.session.prompt("dispatch");
		const first = completed[0];
		if (!first) throw new Error("Original tier did not complete");
		const original = manager().getRecord(first.id);
		if (!original) throw new Error("Original tier record missing");
		const previous = original.modelTier;
		expect(previous).toMatchObject({ kind: "routed", profile: "router/cheap", admitted: ref(0) });
		if (change !== "live") {
			stack.clock.advance(11 * 60_000);
			expect(manager().getRecord(original.id)).toBeUndefined();
		}
		const unavailable = change.startsWith("unavailable");
		const unmapped = change.startsWith("unmapped");
		setModelTiers(unmapped ? {} : { cheap: [unavailable ? "router/absent" : ref(1)] }, {
			onUnavailable: change.endsWith("error") ? "error" : "inherit",
			onUnmapped: change.endsWith("error") ? "error" : "inherit",
		});
		h.session.extensionRunner.setUIContext(
			createTestUiContext({ notify: (text) => stack.notifications.push(text) }),
			"tui",
		);
		physical[1]?.setResponses([fauxAssistantMessage("CONTINUED")]);
		physical[0]?.setResponses([fauxAssistantMessage("LIVE CONTINUED")]);
		h.setResponses([fauxAssistantMessage("PARENT INHERITED")]);
		await h.session.extensionRunner.emitInput("@general-purpose continue", undefined, "interactive");
		await manager().waitForAll();
		if (change.endsWith("error")) {
			expect(completed).toHaveLength(1);
			expect(started).toHaveLength(1);
			expect(stack.notifications.join("\n")).toContain(`@cheap is ${unavailable ? "unavailable" : "unmapped"}`);
			expect(physical.map((p) => p.state.callCount)).toEqual([1, 0]);
			return;
		}
		const latest = completed.at(-1);
		if (!latest) throw new Error("Continuation did not complete");
		const record = manager().getRecord(latest.id);
		if (!record) throw new Error("Continuation record missing");
		if (change === "live") {
			expect(record.id).toBe(original.id);
			expect(record.modelTier).toMatchObject({ kind: "routed", admitted: ref(0) });
			expect(admissions).toEqual(["router/cheap"]);
		} else {
			expect(record.previousModelTier).toEqual(previous);
			const kind = unavailable ? "unavailable" : unmapped ? "unmapped" : "static";
			expect(record.modelTier).toMatchObject({ kind, tier: "cheap" });
			expect(latest.modelTier).toEqual(record.modelTier);
			expect(started.at(-1)).toMatchObject({ modelTier: expect.objectContaining({ kind }) });
			if (change === "changed") {
				expect(latest.modelNote).toContain(`Model: @cheap -> ${ref(1)} (static)`);
				expect(admissions).toEqual(["router/cheap", ref(1)]);
			} else {
				expect(latest.modelNote).toContain(`@cheap is ${kind}; inheriting the parent model`);
				expect(latest.modelNote).not.toContain("via router/cheap");
				expect(admissions).toEqual(["router/cheap"]);
			}
		}
		// Result, durable history and transcript must agree with the actual continuation.
		h.setResponses([tool("get_subagent_result", { agent_id: latest.id }), fauxAssistantMessage("DRIVER DONE")]);
		await h.session.prompt("read the actual result");
		expect(outcomes(h, "get_subagent_result").at(-1)?.text).toContain(latest.modelNote);
		if (record.outputFile) expect(readFileSync(record.outputFile, "utf8")).toContain(JSON.stringify(record.modelTier));
		else {
			if (!record.sessionFile) throw new Error("Continuation session was not persisted");
			expect(readFileSync(record.sessionFile, "utf8")).toContain(
				change === "live" ? "LIVE CONTINUED" : change === "changed" ? "CONTINUED" : "PARENT INHERITED",
			);
		}
		const history = h.session.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === "subagents:record");
		expect(JSON.stringify(history.at(-1))).toContain(JSON.stringify(record.modelTier));
	});

	it.each([false, true])(
		"labels the admitted model before the first answer, blocked first member=%s",
		async (blocked) => {
			stack = await GoalStack.create();
			configure();
			const physical = stack.registerPhysical(CHAIN);
			if (blocked) stack.usage.set(CHAIN[0]?.provider, 100);
			const started: unknown[] = [];
			const completed: unknown[] = [];
			const h = await stack.start(
				[
					await stack.subagents(),
					router(),
					(pi) => {
						pi.events.on("subagents:started", (event) => started.push(event));
						pi.events.on("subagents:completed", (event) => completed.push(event));
					},
				],
				{ useModelRuntimeStream: true },
			);
			for (const provider of physical) provider.setResponses([fauxAssistantMessage("TIER ANSWER")]);
			h.setResponses([
				tool("Agent", {
					subagent_type: "general-purpose",
					description: "tier label",
					prompt: "answer",
					model: "@cheap",
					run_in_background: false,
				}),
				fauxAssistantMessage("DRIVER DONE"),
			]);
			await h.session.prompt("run the tier");
			const chosen = ref(blocked ? 1 : 0);
			const note = `Model: @cheap -> ${chosen} via router/cheap`;
			expect(started).toMatchObject([
				{
					modelTier: {
						kind: "routed",
						tier: "cheap",
						profile: "router/cheap",
						admitted: chosen,
						model: { provider: "router", id: "cheap", api: "pi-virtual" },
					},
					modelNote: note,
				},
			]);
			expect(completed).toMatchObject([{ modelNote: note, modelTier: { tier: "cheap", profile: "router/cheap" } }]);
			expect(outcomes(h, "Agent")[0]?.text).toContain(note);
			expect(physical.map((provider) => provider.state.callCount)).toEqual(blocked ? [0, 1] : [1, 0]);
		},
	);

	it("admits each exact static member through the real router and discloses a quota skip", async () => {
		stack = await GoalStack.create();
		configure([ref(0), ref(1)]);
		const physical = stack.registerPhysical(CHAIN);
		stack.usage.set(CHAIN[0]?.provider, 100);
		const h = await stack.start([await stack.subagents(), router()], { useModelRuntimeStream: true });
		physical[1]?.setResponses([fauxAssistantMessage("STATIC TIER ANSWER")]);
		h.setResponses([
			tool("Agent", {
				subagent_type: "general-purpose",
				description: "static tier",
				prompt: "answer",
				model: "@cheap",
				run_in_background: false,
			}),
			fauxAssistantMessage("DRIVER DONE"),
		]);
		await h.session.prompt("run the tier");
		expect(outcomes(h, "Agent")[0]?.text).toContain(`Model: @cheap -> ${ref(1)} (static); skipped ${ref(0)}: quota`);
		expect(physical.map((provider) => provider.state.callCount)).toEqual([0, 1]);
	});

	it("discloses a mid-run switch inside the same tier", async () => {
		stack = await GoalStack.create();
		configure();
		const physical = stack.registerPhysical(CHAIN);
		const h = await stack.start([await stack.subagents(), router()], { useModelRuntimeStream: true });
		physical[0]?.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "insufficient_quota",
				timestamp: stack.clock.now(),
			}),
		]);
		physical[1]?.setResponses([fauxAssistantMessage("RECOVERED INSIDE TIER")]);
		stack.usage.onRefresh = (provider) => {
			if (provider === CHAIN[0]?.provider) stack.usage.set(provider, 100);
		};
		h.setResponses([
			tool("Agent", {
				subagent_type: "general-purpose",
				description: "tier switch",
				prompt: "answer",
				model: "@cheap",
				run_in_background: false,
			}),
			fauxAssistantMessage("DRIVER DONE"),
		]);
		await h.session.prompt("run the tier");
		const result = outcomes(h, "Agent")[0];
		expect(result?.text).toContain(`Model: @cheap -> ${ref(1)} via router/cheap (switched from ${ref(0)} within tier)`);
		expect(result?.text).toContain("RECOVERED INSIDE TIER");
		expect(physical.map((provider) => provider.state.callCount)).toEqual([1, 1]);
	});

	it.each(["wait", "fail"] as const)("never borrows router/default when exhausted (%s)", async (policy) => {
		stack = await GoalStack.create();
		configure();
		const physical = stack.registerPhysical(CHAIN, 100);
		const jobs: { type: string; job?: { model?: string; quotaParked?: boolean } }[] = [];
		const admissions: string[] = [];
		let complete!: () => void;
		const finished = new Promise<void>((resolve) => {
			complete = resolve;
		});
		const h = await stack.start(
			[
				await stack.subagents(),
				router(policy),
				(pi) => {
					pi.events.on("subagents:scheduled", (event) => {
						jobs.push(event as (typeof jobs)[number]);
						if ((event as { type: string }).type === "error") complete();
					});
					pi.events.on("subagents:completed", () => complete());
					pi.events.on("router:rpc:admit", (raw) => admissions.push((raw as { model: string }).model));
				},
			],
			{ useModelRuntimeStream: true },
		);
		physical[1]?.setResponses([fauxAssistantMessage("ANSWER AFTER RESET")]);
		h.setResponses([
			tool("Agent", {
				subagent_type: "general-purpose",
				description: "park tier",
				prompt: "answer",
				model: "@cheap",
				run_in_background: true,
			}),
			fauxAssistantMessage("DRIVER DONE"),
		]);
		await h.session.prompt("run the tier");
		const result = outcomes(h, "Agent")[0];
		expect(result?.isError).toBe(policy === "fail");
		expect(result?.text).toContain("router/cheap is exhausted");
		expect(result?.text).not.toContain("router/default");
		expect(admissions).toEqual(["router/cheap"]);
		expect(physical.map((provider) => provider.state.callCount)).toEqual([0, 0]);
		if (policy === "fail") {
			expect(jobs).toEqual([]);
			return;
		}
		expect(jobs).toMatchObject([{ type: "added", job: { model: "@cheap", quotaParked: true } }]);
		// A fresh resolve at fire time sees changed quota, instead of replaying the admitted model.
		stack.clock.advance(3_659_000);
		stack.usage.set(CHAIN[0]?.provider, 100);
		stack.usage.set(CHAIN[1]?.provider, 0);
		h.setResponses([fauxAssistantMessage("NOTICED COMPLETION")]);
		stack.clock.advance(1000);
		await finished;
		expect(admissions).toEqual(["router/cheap", "router/cheap"]);
		expect(physical.map((provider) => provider.state.callCount)).toEqual([0, 1]);
		await h.session.waitForIdle();
	});
});
