/** Actual entry paths + manager, real Pi registry/resolver; only child execution is stubbed. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { join, relative } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { initTheme, ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { FakeClock } from "@nredd/pi-test-lib/clock";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager, describeEvicted } from "../src/agent-manager.ts";
import * as runner from "../src/agent-runner.ts";
import { registerAgents } from "../src/agent-types.ts";
import { NOTIFICATION_HOLD_MS } from "../src/completion-outbox.ts";
import { loadCustomAgents } from "../src/custom-agents.ts";
import { createSubagentsExtension } from "../src/index.ts";
import { explainModel } from "../src/model-explanation.ts";
import { setAgentModels, setModelAliases } from "../src/model-resolver.ts";
import { setScopeModelsEnabled } from "../src/model-scope.ts";
import { setModelTiers, tierBinding } from "../src/model-tiers.ts";
import { createNestedSubagentTools } from "../src/nested-tools.ts";
import { SubagentScheduler } from "../src/schedule.ts";
import { resolveStorePath, ScheduleStore } from "../src/schedule-store.ts";
import * as settings from "../src/settings.ts";
import type { FleetUICtx } from "../src/ui/fleet-list.ts";
import { FLEET_STATE_ENTRY, FLEET_STATE_VERSION } from "../src/ui/fleet-state.ts";
import { createWorkflowHost } from "../src/workflow/host.ts";
import { bootPi, flush, type Hermetic, hermeticDir, ctx as makeCtx, startSession } from "./fixtures/boot-extension.ts";

vi.mock("../src/agent-runner.ts", async (importOriginal) => ({
	...(await importOriginal<typeof runner>()),
	runAgent: vi.fn(),
	resumeAgent: vi.fn(),
}));

const ref = (id: string) => `selection-path/${id}`;
const paths = ["Agent", "nested", "scheduled", "RPC", "mention", "workflow"] as const;
type Path = (typeof paths)[number];
let sandbox: Hermetic;
let registry: ModelRegistry;
let parent: ReturnType<ModelRegistry["find"]>;
let boot: ReturnType<typeof bootPi>;
let context: ReturnType<typeof makeCtx>;
let manager: AgentManager;
let scheduler: SubagentScheduler;
let clock: FakeClock;
let blockedUntil: number | undefined;
let admissionModels: string[];
let refuseStaleParent: boolean;
let admittedModel: string | undefined;

function bus() {
	const handlers = new Map<string, Set<(data: unknown) => void>>();
	return {
		on(event: string, handler: (data: unknown) => void) {
			const group = handlers.get(event) ?? new Set();
			group.add(handler);
			handlers.set(event, group);
			return () => {
				group.delete(handler);
			};
		},
		emit(event: string, data: unknown) {
			for (const handler of handlers.get(event) ?? []) handler(data);
		},
	};
}

const disclosureTest = it.extend<{ showFleetModel?: boolean }>({ showFleetModel: false });
const disclosureWithModel = disclosureTest.extend<{ showFleetModel?: boolean }>({ showFleetModel: true });

disclosureTest.beforeEach(async ({ showFleetModel }) => {
	sandbox = hermeticDir({
		settings: {
			agentMentions: "direct",
			backgroundByDefault: false,
			...(showFleetModel === undefined ? {} : { showModel: showFleetModel }),
		},
		agentFiles: {
			scout: `---\ndescription: scout\ndisplay_name: Scout Label\ntools: read\nmodel: ${ref("definition")}\n---\nScout.`,
		},
	});
	const runtime = await ModelRuntime.create({
		authPath: join(sandbox.dir, "auth.json"),
		modelsPath: null,
		refreshOnCreate: false,
	});
	registry = new ModelRegistry(runtime);
	registry.registerProvider("selection-path", {
		api: "openai-completions",
		baseUrl: "http://localhost:1",
		apiKey: "fixture-not-a-secret",
		models: [
			"parent",
			"definition",
			"wildcard",
			"typed",
			"explicit",
			"claude-4-5-sonnet",
			"claude-5-sonnet",
			"claude-5-5-sonnet",
			"claude-5-6-sonnet",
		].map((id) => ({
			id,
			name: ref(id),
			reasoning: false,
			input: ["text"],
			contextWindow: 1000,
			maxTokens: 100,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		})),
	});
	registry.registerVirtualModel({
		provider: "router",
		id: "default",
		name: "Router default",
		route: () => {
			throw new Error("not dispatched");
		},
	});
	parent = registry.find("selection-path", "parent");
	context = makeCtx({ cwd: sandbox.dir, model: parent, modelRegistry: registry, isProjectTrusted: () => true });
	clock = new FakeClock();
	blockedUntil = undefined;
	admissionModels = [];
	refuseStaleParent = false;
	admittedModel = undefined;
	boot = bootPi();
	boot.pi.events = bus();
	// Answer admission synchronously, without any real router or network calls.
	boot.pi.events.on("router:rpc:admit", ({ requestId, model }: { requestId: string; model: string }) => {
		admissionModels.push(model);
		boot.pi.events.emit(`router:rpc:admit:reply:${requestId}`, {
			success: true,
			data:
				blockedUntil !== undefined
					? { ok: false, resetAt: blockedUntil }
					: refuseStaleParent && model === ref("parent")
						? { ok: false, wait: false }
						: { ok: true, resolvedModel: admittedModel },
		});
	});
	createSubagentsExtension({ clock })(boot.pi);
	await startSession(boot.lifecycle, true, context);
	manager = new AgentManager(undefined, 10, undefined, undefined, undefined, undefined, clock);
	scheduler = new SubagentScheduler({ clock });
	scheduler.start(boot.pi, context, manager, new ScheduleStore(join(sandbox.dir, "jobs.json")));
	vi.mocked(runner.runAgent).mockReset();
	vi.mocked(runner.resumeAgent).mockReset();
	vi.mocked(runner.runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
		const sessionFile = join(sandbox.dir, `${options.agentId}.jsonl`);
		writeFileSync(sessionFile, "{}");
		const session = {
			model: options.model,
			dispose: vi.fn(),
			subscribe: () => () => {},
			sessionManager: { getSessionFile: () => sessionFile },
		} as unknown as AgentSession;
		options.onSessionCreated?.(session);
		return { responseText: "done", session, aborted: false, steered: false };
	});
	vi.mocked(runner.resumeAgent).mockResolvedValue({ text: "resumed", aborted: false, steered: false });
});
afterEach(async () => {
	scheduler.stop();
	await manager.dispose();
	await boot.lifecycle.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, context);
	setAgentModels(undefined);
	setModelAliases(undefined);
	setScopeModelsEnabled(false);
	setModelTiers(undefined, undefined);
	delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagents:manager")];
	sandbox.restore();
});

describe("/agents tier proposals", () => {
	const agentDir = () => process.env.PI_CODING_AGENT_DIR!;
	const globalSettings = () => join(agentDir(), "subagents.json");
	const enterpriseSettings = () => join(agentDir(), "enterprise.local.json");
	const snapshot = (root: string) =>
		readdirSync(root, { recursive: true, withFileTypes: true })
			.map((entry) => {
				const path = join(entry.parentPath, entry.name);
				const digest = entry.isFile()
					? createHash("sha256").update(readFileSync(path)).digest("hex")
					: String(lstatSync(path).mode);
				return `${relative(root, path)}: ${digest}`;
			})
			.sort();
	const route = () => {
		throw new Error("A proposal must not route");
	};
	const register = (id: string, provider = "router") =>
		registry.registerVirtualModel({ provider, id, name: id, route });
	async function runProposal(hasUI = true) {
		const roots = [agentDir(), sandbox.dir];
		const before = roots.map(snapshot);
		const notify = vi.fn<(message: string, level: string) => void>();
		await boot.commands
			.get("agents")
			.handler(" propose-tiers ", makeCtx({ hasUI, modelRegistry: registry, ui: { notify } }));
		expect(roots.map(snapshot)).toEqual(before);
		expect(admissionModels).toEqual([]);
		expect(boot.pi.sendMessage).not.toHaveBeenCalled();
		return notify;
	}

	async function preview() {
		const notify = await runProposal();
		expect(notify).toHaveBeenCalledExactlyOnceWith(expect.any(String), "info");
		return notify.mock.calls[0]![0];
	}

	it("returns headless without reading settings or profiles or emitting output", async () => {
		const load = vi.spyOn(settings, "loadTierProposalSettings");
		const list = vi.spyOn(registry, "getAll");
		try {
			expect(await runProposal(false)).not.toHaveBeenCalled();
			expect(load).not.toHaveBeenCalled();
			expect(list).not.toHaveBeenCalled();
		} finally {
			load.mockRestore();
			list.mockRestore();
		}
	});

	it("reports a throwing trusted settings read to the UI without exposing the raw error", async () => {
		const load = vi.spyOn(settings, "loadTierProposalSettings").mockImplementationOnce(() => {
			throw new Error("synthetic private read failure");
		});
		try {
			expect(await runProposal()).toHaveBeenCalledExactlyOnceWith(
				"Could not read trusted settings or registered router profiles for the tier proposal.",
				"error",
			);
		} finally {
			load.mockRestore();
		}
	});

	it("lists registered profiles in order and proposes only exact matches without applying or writing", async () => {
		register("review");
		register("cheap");
		register("frontier-extra");
		register("Deep");
		register("deep", "other-provider");
		const projectSettings = join(sandbox.dir, ".pi", "subagents.json");
		writeFileSync(projectSettings, JSON.stringify({ modelTiers: {} }));
		const display = await preview();
		expect(display).toContain(
			"Registered router profiles: router/cheap, router/default, router/frontier-extra, router/review.",
		);
		expect(display).toContain("No matching registered profile: @deep, @frontier.");
		expect(display).toContain("If you approve");
		expect(JSON.parse(display.slice(display.indexOf("{")))).toEqual({
			modelTiers: { cheap: ["router/cheap"], default: ["router/default"], review: ["router/review"] },
		});
		expect(await preview()).toBe(display);
		expect(tierBinding("cheap")).toBeUndefined();
	});

	it("proposes nothing when no router profiles are registered", async () => {
		registry.unregisterVirtualModel("router", "default");
		expect(await preview()).toBe(
			"Registered router profiles: none.\nNo matching registered profile: @cheap, @deep, @default, @frontier, @review.\nNo bindings proposed.",
		);
	});

	it("does not substitute an unrelated profile or use a nonvirtual router entry", async () => {
		registry.unregisterVirtualModel("router", "default");
		const physical = registry.find("selection-path", "parent")!;
		register("other");
		const models = registry.getAll();
		vi.spyOn(registry, "getAll").mockReturnValueOnce([...models, { ...physical, provider: "router", id: "cheap" }]);
		const display = await preview();
		expect(display).toContain("Registered router profiles: router/other.");
		expect(display).toContain("No matching registered profile: @cheap, @deep, @default, @frontier, @review.");
		expect(display).toContain("No bindings proposed.");
	});

	it("proposes all five tiers without reporting a missing profile when all are registered", async () => {
		for (const tier of ["review", "frontier", "cheap", "deep"]) register(tier);
		const display = await preview();
		expect(display).not.toContain("No matching");
		expect(JSON.parse(display.slice(display.indexOf("{")))).toEqual({
			modelTiers: {
				cheap: ["router/cheap"],
				deep: ["router/deep"],
				default: ["router/default"],
				frontier: ["router/frontier"],
				review: ["router/review"],
			},
		});
	});

	it.each([{}, { cheap: ["selection-path/definition"] }])("leaves an explicit map alone: %j", async (modelTiers) => {
		const initial = JSON.stringify({ modelTiers });
		writeFileSync(globalSettings(), initial);
		expect(await preview()).toBe(
			"Registered router profiles: router/default.\nNo proposal: modelTiers is already configured (an empty map counts).",
		);
	});

	it("honors an explicit empty tier map in the trusted enterprise overlay", async () => {
		writeFileSync(
			join(agentDir(), "enterprise.local.json"),
			JSON.stringify({ version: 1, subagents: { modelTiers: {} } }),
			{ mode: 0o600 },
		);
		expect(await preview()).toBe(
			"Registered router profiles: router/default.\nNo proposal: modelTiers is already configured (an empty map counts).",
		);
	});

	it("preserves the legacy Explore alias while proposing independent tiers", async () => {
		register("cheap");
		const initial = JSON.stringify({ modelAliases: { "Claude-Haiku-4-5": ["selection-path/definition"] } });
		writeFileSync(globalSettings(), initial);
		const display = await preview();
		expect(display).toContain("Skipped @cheap: a binding would shadow the legacy Explore alias.");
		expect(JSON.parse(display.slice(display.indexOf("{")))).toEqual({ modelTiers: { default: ["router/default"] } });
	});

	async function apply(
		confirm = vi.fn<(title: string, message: string) => Promise<boolean>>().mockResolvedValue(true),
		hasUI = true,
	) {
		const notify = vi.fn<(message: string, level: string) => void>();
		await boot.commands.get("agents").handler(
			" apply-tiers ",
			makeCtx({
				hasUI,
				cwd: sandbox.dir,
				modelRegistry: registry,
				ui: { notify, confirm },
			}),
		);
		expect(admissionModels).toEqual([]);
		expect(boot.pi.sendMessage).not.toHaveBeenCalled();
		return { confirm, notify };
	}

	it("declining the exact proposal leaves settings and routing untouched", async () => {
		const before = snapshot(agentDir());
		const confirm = vi.fn(async () => false);
		await apply(confirm);
		expect(confirm).toHaveBeenCalledExactlyOnceWith(
			"Save proposed modelTiers?",
			'Add {"default":["router/default"]} to global subagents.json?',
		);
		expect(snapshot(agentDir())).toEqual(before);
		expect(tierBinding("default")).toBeUndefined();
	});

	it("saves the confirmed exact matches globally and loads them from trusted settings", async () => {
		register("frontier-extra");
		register("review");
		register("Deep");
		const projectBefore = snapshot(sandbox.dir);
		const { confirm, notify } = await apply();
		const modelTiers = { default: ["router/default"], review: ["router/review"] };
		expect(confirm).toHaveBeenCalledExactlyOnceWith(
			"Save proposed modelTiers?",
			`Add ${JSON.stringify(modelTiers)} to global subagents.json?`,
		);
		expect(JSON.parse(readFileSync(globalSettings(), "utf8"))).toEqual({ modelTiers });
		expect(settings.loadTrustedSettings().modelTiers).toEqual(modelTiers);
		expect(snapshot(sandbox.dir)).toEqual(projectBefore);
		expect(tierBinding("review")).toBeUndefined();
		expect(notify).toHaveBeenCalledExactlyOnceWith(
			"Saved modelTiers to global subagents.json. Restart Pi to use the new bindings.",
			"info",
		);
	});

	it("preserves legacy aliases and unknown global settings while saving independent tiers", async () => {
		register("cheap");
		const original = {
			modelAliases: { "Claude-Haiku-4-5": ["selection-path/definition"] },
			futureOption: { active: true },
		};
		writeFileSync(globalSettings(), JSON.stringify(original));
		const overlay = JSON.stringify({ version: 1, subagents: { modelResolution: { allowFallback: false } } });
		writeFileSync(enterpriseSettings(), overlay, { mode: 0o600 });
		const { confirm } = await apply();
		expect(confirm).toHaveBeenCalledExactlyOnceWith(
			"Save proposed modelTiers?",
			'Add {"default":["router/default"]} to global subagents.json?',
		);
		expect(JSON.parse(readFileSync(globalSettings(), "utf8"))).toEqual({
			...original,
			modelTiers: { default: ["router/default"] },
		});
		expect(readFileSync(enterpriseSettings(), "utf8")).toBe(overlay);
	});

	it.each(["global", "enterprise"])("does not request approval over an explicit %s map", async (layer) => {
		// `router/default` is registered but must not replace this explicit binding.
		const config = { modelTiers: layer === "global" ? { default: ["selection-path/definition"] } : {} };
		if (layer === "global") writeFileSync(globalSettings(), JSON.stringify(config));
		else writeFileSync(enterpriseSettings(), JSON.stringify({ version: 1, subagents: config }), { mode: 0o600 });
		const before = snapshot(agentDir());
		expect((await apply()).confirm).not.toHaveBeenCalled();
		expect(snapshot(agentDir())).toEqual(before);
	});

	it("does not request approval or create settings without matching profiles", async () => {
		registry.unregisterVirtualModel("router", "default");
		const before = snapshot(agentDir());
		const { confirm, notify } = await apply();
		expect(confirm).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("No bindings proposed."), "info");
		expect(snapshot(agentDir())).toEqual(before);
	});

	it("does not request approval or create settings headless", async () => {
		const before = snapshot(agentDir());
		const { confirm, notify } = await apply(undefined, false);
		expect(confirm).not.toHaveBeenCalled();
		expect(notify).not.toHaveBeenCalled();
		expect(snapshot(agentDir())).toEqual(before);
	});

	it("preserves an explicit empty map added during confirmation", async () => {
		const original = '{ "modelTiers": {} }';
		const { notify } = await apply(
			vi.fn(async () => {
				writeFileSync(globalSettings(), original);
				return true;
			}),
		);
		expect(notify).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("proposal changed"), "warning");
		expect(readFileSync(globalSettings(), "utf8")).toBe(original);
	});

	it("does not save a stale proposal after profile registrations change", async () => {
		const before = snapshot(agentDir());
		const { notify } = await apply(
			vi.fn(async () => {
				register("review");
				return true;
			}),
		);
		expect(notify).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("proposal changed"), "warning");
		expect(snapshot(agentDir())).toEqual(before);
	});

	const tiers = { default: ["router/default"] };
	const member = '"modelTiers": {"default":["router/default"]}';
	const spacedValue = `{"keep": "${" ".repeat(200_000)}"`;
	const unusualKeys = String.raw`{"repeat": 1, "repeat": 2, "\"}{": 3`;
	it.each([
		["long string of spaces", `${spacedValue}  }\n`, `${spacedValue},${member}  }\n`],
		["duplicate keys and an escaped quote and braces in a key", `${unusualKeys}}`, `${unusualKeys},${member}}`],
		["empty compact object", "{}", `{${member}}`],
		["empty spaced object", "{ }", `{ ${member} }`],
		["empty multiline object", "{\n}\n", `{\n  ${member}\n}\n`],
		["compact object with a member", '{"keep": 1}', `{"keep": 1,${member}}`],
		["literal 9007199254740993", ' { "keep": 9007199254740993 }\n', ` { "keep": 9007199254740993, ${member} }\n`],
		[
			"nested object with CRLF and tabs",
			'{\r\n\t"nested": {"list": [{"brace": "}𝄞"}]},\r\n\t"escaped": "\\u0061"\r\n}\r\n',
			`{\r\n\t"nested": {"list": [{"brace": "}𝄞"}]},\r\n\t"escaped": "\\u0061",\r\n\t${member}\r\n}\r\n`,
		],
	])("inserts only modelTiers: %s", async (_name, source, expected) => {
		writeFileSync(globalSettings(), source);
		await apply();
		expect(readFileSync(globalSettings())).toEqual(Buffer.from(expected));
	});

	it("aborts if even whitespace in the approved snapshot changes during confirmation", async () => {
		writeFileSync(globalSettings(), '{"keep":1}\n');
		const edited = '{"keep":1} \n';
		const { notify } = await apply(
			vi.fn(async () => {
				writeFileSync(globalSettings(), edited);
				return true;
			}),
		);
		expect(notify).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("run /agents apply-tiers again"), "warning");
		expect(readFileSync(globalSettings(), "utf8")).toBe(edited);
	});

	it("refuses to redirect an approved save through a retargeted agent-directory symlink", async () => {
		const a = join(agentDir(), "a");
		const b = join(agentDir(), "b");
		const current = join(agentDir(), "current");
		const source = '{"keep":1}\n';
		for (const dir of [a, b]) {
			mkdirSync(dir);
			writeFileSync(join(dir, "subagents.json"), source);
		}
		symlinkSync(a, current, "junction");
		const original = agentDir();
		process.env.PI_CODING_AGENT_DIR = current;
		try {
			const { confirm, notify } = await apply(
				vi.fn(async () => {
					unlinkSync(current);
					symlinkSync(b, current, "junction");
					return true;
				}),
			);
			expect(confirm).toHaveBeenCalledOnce();
			expect(notify).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("settings directory changed"), "warning");
			for (const dir of [a, b]) {
				expect(readdirSync(dir)).toEqual(["subagents.json"]);
				expect(readFileSync(join(dir, "subagents.json"), "utf8")).toBe(source);
			}
		} finally {
			process.env.PI_CODING_AGENT_DIR = original;
		}
	});

	it("refuses a replaced file even when its mode and bytes match the proposal", async () => {
		const source = '{"keep":1}\n';
		const replacement = `${globalSettings()}.replacement`;
		writeFileSync(globalSettings(), source);
		writeFileSync(replacement, source);
		const replacedInode = lstatSync(replacement, { bigint: true }).ino;
		const { notify } = await apply(
			vi.fn(async () => {
				renameSync(replacement, globalSettings());
				return true;
			}),
		);
		expect(notify).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("settings file was replaced"), "warning");
		expect(readFileSync(globalSettings(), "utf8")).toBe(source);
		expect(lstatSync(globalSettings(), { bigint: true }).ino).toBe(replacedInode);
	});

	it("preserves edits made at the replacement boundary and cleans up its lock", async () => {
		writeFileSync(globalSettings(), '{"keep":1}\n');
		const { snapshot: approved } = settings.loadTierProposalSettings(true);
		const edited = '{"keep":2}\n';
		await expect(
			settings.saveProposedModelTiers(tiers, approved, undefined, () => {
				expect(lstatSync(`${globalSettings()}.lock`).isFile()).toBe(true);
				writeFileSync(globalSettings(), edited);
			}),
		).rejects.toThrow(/run \/agents apply-tiers again/);
		expect(readFileSync(globalSettings(), "utf8")).toBe(edited);
		expect(readdirSync(agentDir())).not.toContain("subagents.json.lock");
		expect(readdirSync(agentDir()).some((name) => name.startsWith(".subagents-tiers-"))).toBe(false);
	});

	it("serializes two cooperating saves from the same snapshot", async () => {
		writeFileSync(globalSettings(), "{}\n");
		const { snapshot: approved } = settings.loadTierProposalSettings(true);
		const results = await Promise.allSettled([
			settings.saveProposedModelTiers(tiers, approved),
			settings.saveProposedModelTiers({ review: ["router/review"] }, approved),
		]);
		expect(results[0]).toEqual({ status: "fulfilled", value: undefined });
		expect(results[1]).toMatchObject({ status: "rejected", reason: expect.any(settings.TierSettingsChangedError) });
		expect(JSON.parse(readFileSync(globalSettings(), "utf8"))).toEqual({ modelTiers: tiers });
	});

	it("fails closed when the lock is held and leaves it alone", async () => {
		writeFileSync(`${globalSettings()}.lock`, "held");
		const before = snapshot(agentDir());
		const { notify } = await apply();
		expect(notify).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("holds the global settings lock"), "error");
		expect(snapshot(agentDir())).toEqual(before);
	});

	it.each(["not JSON", "null", "42", "[]", Buffer.from([0x7b, 0xff, 0x7d])])(
		"refuses to replace invalid global config: %s",
		async (raw) => {
			writeFileSync(globalSettings(), raw);
			const before = snapshot(agentDir());
			const { confirm, notify } = await apply();
			expect(confirm).not.toHaveBeenCalled();
			expect(notify).toHaveBeenCalledExactlyOnceWith(
				"Could not read trusted settings or registered router profiles for the tier proposal.",
				"error",
			);
			expect(snapshot(agentDir())).toEqual(before);
		},
	);

	async function expectNonregularRefused() {
		const before = snapshot(agentDir());
		const { confirm, notify } = await apply();
		expect(confirm).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledExactlyOnceWith(
			expect.stringContaining("Expected a regular global settings file"),
			"error",
		);
		expect(snapshot(agentDir())).toEqual(before);
	}

	it("refuses a directory or symlink to a directory before reading", async () => {
		const directory = `${globalSettings()}.directory`;
		mkdirSync(directory);
		symlinkSync(directory, globalSettings(), "junction");
		await expectNonregularRefused();
	});

	it("refuses a nonregular target before reading", async () => {
		if (process.platform === "win32") mkdirSync(globalSettings());
		else execFileSync("mkfifo", [globalSettings()]);
		await expectNonregularRefused();
	});

	it("refuses a Unix socket before reading (directory on Windows)", async () => {
		if (process.platform === "win32") {
			mkdirSync(globalSettings());
			await expectNonregularRefused();
			return;
		}
		const server = createServer();
		const cwd = process.cwd();
		// A relative bind keeps the socket address below sun_path's limit even
		// when the isolated runner nests this hermetic agent directory deeply.
		process.chdir(agentDir());
		try {
			server.listen("subagents.json");
			await once(server, "listening");
			try {
				expect(lstatSync(globalSettings()).isSocket()).toBe(true);
				await expectNonregularRefused();
			} finally {
				const closed = once(server, "close");
				server.close();
				await closed;
			}
		} finally {
			process.chdir(cwd);
		}
	});

	async function expectNoWriteAccess() {
		const before = snapshot(agentDir());
		const { confirm, notify } = await apply();
		expect(confirm).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("No write access"), "error");
		expect(snapshot(agentDir())).toEqual(before);
	}

	it("refuses to replace a read-only 0444 global settings file", async () => {
		writeFileSync(globalSettings(), "{}\n");
		chmodSync(globalSettings(), 0o444);
		try {
			await expectNoWriteAccess();
		} finally {
			chmodSync(globalSettings(), 0o600);
		}
	});

	it("refuses a 0464 file owned by the caller (0444 on Windows)", async () => {
		writeFileSync(globalSettings(), "{}\n");
		chmodSync(globalSettings(), process.platform === "win32" ? 0o444 : 0o464);
		try {
			await expectNoWriteAccess();
		} finally {
			chmodSync(globalSettings(), 0o600);
		}
	});

	it("refuses a macOS ACL write deny (0464 mode deny on other Unix hosts)", async () => {
		writeFileSync(globalSettings(), "{}\n", { mode: 0o600 });
		try {
			if (process.platform === "darwin") {
				const owner = execFileSync("id", ["-un"], { encoding: "utf8" }).trim();
				execFileSync("chmod", ["+a", `${owner} deny write`, globalSettings()]);
			} else {
				chmodSync(globalSettings(), process.platform === "win32" ? 0o444 : 0o464);
			}
			await expectNoWriteAccess();
		} finally {
			if (process.platform === "darwin") execFileSync("chmod", ["-N", globalSettings()]);
			chmodSync(globalSettings(), 0o600);
		}
	});

	it("rechecks access at the replacement boundary", async () => {
		writeFileSync(globalSettings(), "{}\n", { mode: 0o600 });
		const { snapshot: approved } = settings.loadTierProposalSettings(true);
		try {
			await expect(
				settings.saveProposedModelTiers(tiers, approved, undefined, () => {
					chmodSync(globalSettings(), process.platform === "win32" ? 0o444 : 0o464);
				}),
			).rejects.toThrow(/No write access/);
			expect(readFileSync(globalSettings(), "utf8")).toBe("{}\n");
		} finally {
			chmodSync(globalSettings(), 0o600);
		}
	});

	it("preserves the original mode on replacement", async () => {
		writeFileSync(globalSettings(), "{}\n");
		chmodSync(globalSettings(), 0o640);
		const mode = lstatSync(globalSettings()).mode & 0o777;
		await apply();
		expect(JSON.parse(readFileSync(globalSettings(), "utf8"))).toEqual({ modelTiers: tiers });
		expect(lstatSync(globalSettings()).mode & 0o777).toBe(mode);
	});

	it.each(["global", "enterprise"])("the writer refuses to save over an existing %s tier field", async (layer) => {
		const config = { modelTiers: null };
		if (layer === "global") writeFileSync(globalSettings(), JSON.stringify(config));
		else writeFileSync(enterpriseSettings(), JSON.stringify({ version: 1, subagents: config }), { mode: 0o600 });
		const before = snapshot(agentDir());
		const { snapshot: approved } = settings.loadTierProposalSettings(true);
		await expect(settings.saveProposedModelTiers(tiers, approved)).rejects.toThrow(/modelTiers/);
		expect(snapshot(agentDir())).toEqual(before);
	});
});

async function invoke(path: Path, model?: string | null) {
	if (path === "Agent") {
		await boot.tools
			.get("Agent")
			.execute(
				"call",
				{ subagent_type: "scout", description: "test", prompt: "go", run_in_background: false, model },
				undefined,
				undefined,
				context,
			);
	} else if (path === "nested") {
		const tool = createNestedSubagentTools({
			manager,
			pi: boot.pi,
			parentAgentId: "owner",
			depth: 1,
			maxSubagentDepth: 2,
			allowedSubagents: "all",
			configCwd: sandbox.dir,
			projectTrusted: true,
		})[0]!;
		await tool.execute(
			"nested",
			{ subagent_type: "scout", description: "test", prompt: "go", model },
			undefined,
			undefined,
			context,
		);
	} else if (path === "scheduled") {
		scheduler.addJob({
			name: "test",
			description: "test",
			subagent_type: "scout",
			prompt: "go",
			schedule: "+1s",
			model: model as string | undefined,
		});
		clock.advance(1000);
	} else if (path === "RPC") {
		await new Promise<void>((resolve, reject) => {
			boot.pi.events.on("subagents:rpc:spawn:reply:parity", (reply: { success: boolean; error?: string }) =>
				reply.success ? resolve() : reject(new Error(reply.error)),
			);
			boot.pi.events.emit("subagents:rpc:spawn", {
				requestId: "parity",
				type: "scout",
				prompt: "go",
				options: { description: "test", model },
			});
		});
	} else if (path === "mention") {
		await boot.lifecycle.get("input")?.({ type: "input", text: "@scout go", source: "interactive" } as never, context);
	} else {
		await createWorkflowHost({ pi: boot.pi, ctx: context, manager }).spawnAgent({
			index: 0,
			agentId: "wf-agent-1",
			agentType: "scout",
			label: "test",
			prompt: "go",
			model: model as string | undefined,
		});
	}
	await flush();
	const invocation = vi.mocked(runner.runAgent).mock.calls.at(-1);
	const root = (globalThis as Record<symbol, { getRecord(id: string): ReturnType<AgentManager["getRecord"]> }>)[
		Symbol.for("pi-subagents:manager")
	]!;
	const record = invocation
		? (manager.getRecord(invocation[3].agentId!) ?? root.getRecord(invocation[3].agentId!))
		: undefined;
	return { invocation, record };
}

describe.each(paths)("%s model selection parity", (path) => {
	it("retains the same exact tier outcome across entry paths", async () => {
		setModelTiers({ cheap: [ref("typed")] }, {});
		setAgentModels({ scout: "@cheap", "*": ref("wildcard") });
		const { invocation, record } = await invoke(path);
		expect(invocation?.[3].model).toMatchObject({ provider: "selection-path", id: "typed" });
		expect(record?.modelTier).toMatchObject({ kind: "static", tier: "cheap", member: ref("typed"), skipped: [] });
		expect(record?.modelSelection).toMatchObject({ requested: "@cheap", source: "agentModels:type" });
	});

	if (path !== "mention")
		it("preserves a fuzzy explicit version through the shared selection path", async () => {
			const { invocation, record } = await invoke(path, "sonnet-5-5");
			expect(invocation?.[3].model).toMatchObject({ provider: "selection-path", id: "claude-5-5-sonnet" });
			expect(record?.modelSelection).toMatchObject({ requested: "sonnet-5-5", source: "param" });
		});

	if (path !== "mention")
		it("honors an explicit tier over agentModels", async () => {
			setModelTiers({ cheap: [ref("explicit")] }, {});
			setAgentModels({ scout: ref("typed") });
			const { invocation, record } = await invoke(path, "@cheap");
			expect(invocation?.[3].model).toMatchObject({ id: "explicit" });
			expect(record?.modelSelection).toMatchObject({ requested: "@cheap", source: "param" });
		});
	it("honors a type override over wildcard and frontmatter", async () => {
		setAgentModels({ SCOUT: ref("typed"), "*": ref("wildcard") });
		const { invocation, record } = await invoke(path);
		expect(invocation?.[3].model).toMatchObject({ provider: "selection-path", id: "typed" });
		expect(record?.modelSelection).toMatchObject({
			requested: ref("typed"),
			source: "agentModels:type",
			outcome: "resolved",
		});
	});

	it("honors wildcard over frontmatter, including router selections", async () => {
		setAgentModels({ "*": "router/default" });
		const { invocation, record } = await invoke(path);
		expect(invocation?.[3].model).toMatchObject({ api: "pi-virtual", provider: "router", id: "default" });
		expect(record?.modelSelection).toMatchObject({
			requested: "router/default",
			source: "agentModels:*",
			outcome: "resolved",
		});
	});

	it("resolves aliases from frontmatter through the same resolver", async () => {
		writeFileSync(
			join(sandbox.dir, ".pi", "agents", "scout.md"),
			"---\ndescription: scout\ntools: read\nmodel: portable\n---\nScout.",
		);
		registerAgents(loadCustomAgents(sandbox.dir, false, { projectTrusted: true }));
		setModelAliases({ portable: [ref("typed")] });
		const { invocation, record } = await invoke(path);
		expect(invocation?.[3].model).toMatchObject({ id: "typed" });
		expect(record?.modelSelection).toMatchObject({ requested: "portable", source: "definition" });
	});

	it("inherits the parent when no model input is configured", async () => {
		writeFileSync(join(sandbox.dir, ".pi", "agents", "scout.md"), "---\ndescription: scout\ntools: read\n---\nScout.");
		registerAgents(loadCustomAgents(sandbox.dir, false, { projectTrusted: true }));
		const { invocation, record } = await invoke(path);
		expect(invocation?.[3].model).toBe(parent);
		expect(record?.modelSelection).toMatchObject({ source: "parent", outcome: "inherited", model: parent });
	});

	it.each(["", "  "])("skips a blank definition %j without recording a request", async (blank) => {
		writeFileSync(
			join(sandbox.dir, ".pi", "agents", "scout.md"),
			`---\ndescription: scout\ntools: read\nmodel: ${JSON.stringify(blank)}\n---\nScout.`,
		);
		registerAgents(loadCustomAgents(sandbox.dir, false, { projectTrusted: true }));
		const { invocation, record } = await invoke(path);
		expect(invocation?.[3].model).toBe(parent);
		expect(record?.modelSelection).toMatchObject({ source: "parent", outcome: "inherited" });
		expect(record?.modelSelection?.requested).toBeUndefined();
	});

	it.each(["", "  "])("skips blank configured overrides %j down to the definition", async (blank) => {
		setAgentModels({ scout: blank, "*": blank });
		const { invocation, record } = await invoke(path);
		expect(invocation?.[3].model).toMatchObject({ id: "definition" });
		expect(record?.modelSelection).toMatchObject({
			requested: ref("definition"),
			source: "definition",
			outcome: "resolved",
		});
	});

	if (path !== "mention")
		it.each(["", "  "])("skips a blank explicit model %j down to configured routing", async (blank) => {
			setAgentModels({ scout: ref("typed") });
			const { invocation, record } = await invoke(path, blank);
			expect(invocation?.[3].model).toMatchObject({ id: "typed" });
			expect(record?.modelSelection).toMatchObject({
				requested: ref("typed"),
				source: "agentModels:type",
				outcome: "resolved",
			});
		});

	it("stores the unavailable request and parent fallback once", async () => {
		setAgentModels({ scout: "missing-model", "*": ref("wildcard") });
		const { invocation, record } = await invoke(path);
		expect(invocation?.[3].model).toBe(parent);
		expect(record?.modelSelection).toMatchObject({
			requested: "missing-model",
			source: "agentModels:type",
			outcome: "fallback",
			model: parent,
		});
		expect(record?.modelFallback).toBe(record?.modelSelection?.fallback);
		expect(record?.modelFallback).toEqual({ input: "missing-model", used: ref("parent") });
	});

	it("warns and proceeds for an out-of-scope configured model", async () => {
		writeFileSync(join(sandbox.dir, ".pi", "settings.json"), JSON.stringify({ enabledModels: [ref("parent")] }));
		setScopeModelsEnabled(true);
		setAgentModels({ scout: ref("typed") });
		const { invocation, record } = await invoke(path);
		expect(invocation?.[3].model).toMatchObject({ id: "typed" });
		expect(record?.modelSelection?.scopeWarning).toBe(`Agent "Scout Label" using out-of-scope model "${ref("typed")}"`);
	});

	if (path !== "mention")
		it("refuses an unresolved explicit model instead of inheriting or selecting config", async () => {
			setAgentModels({ scout: ref("typed") });
			await invoke(path, "missing-model").catch(() => {});
			expect(runner.runAgent).not.toHaveBeenCalled();
			if (path === "scheduled") expect(scheduler.list()[0]!.lastStatus).toBe("error");
		});

	if (path !== "mention")
		it("refuses an explicit out-of-scope model", async () => {
			writeFileSync(join(sandbox.dir, ".pi", "settings.json"), JSON.stringify({ enabledModels: [ref("parent")] }));
			setScopeModelsEnabled(true);
			await invoke(path, ref("explicit")).catch(() => {});
			expect(runner.runAgent).not.toHaveBeenCalled();
		});

	if (path !== "mention")
		it("keeps an explicit override ahead of configured routing", async () => {
			setAgentModels({ "*": "router/default", scout: ref("typed") });
			const { invocation, record } = await invoke(path, ref("explicit"));
			expect(invocation?.[3].model).toMatchObject({ id: "explicit" });
			expect(record?.modelSelection).toMatchObject({ requested: ref("explicit"), source: "param" });
		});
});

it.each([ref("claude-5-5-sonnet"), "router/default"])(
	"echoes safe resolved identity at spawn and completion: %s",
	async (model) => {
		const result = await boot.tools.get("Agent").execute(
			"identity",
			{
				subagent_type: "scout",
				description: "identity",
				prompt: "go",
				model,
				run_in_background: true,
			},
			undefined,
			undefined,
			context,
		);
		const expected =
			model === "router/default"
				? "Resolved model: router/default (routing alias; physical response model: unknown)."
				: `Resolved model: ${model}.`;
		expect(result.content[0].text).toContain(expected);
		expect(result.details.modelNote).toBeUndefined();
		await flush();
		clock.advance(200);
		const notices: string[] = vi
			.mocked(boot.pi.sendMessage)
			.mock.calls.map((args: unknown[]) => JSON.stringify(args[0]));
		expect(notices.some((notice) => notice.includes(expected))).toBe(true);
		expect(notices.join("\n")).not.toContain("fixture-not-a-secret");
	},
);

async function startFleetSession() {
	const setWidget = vi.fn<FleetUICtx["setWidget"]>();
	context.hasUI = true;
	Object.assign(context.ui, { setWidget, onTerminalInput: () => () => {} });
	context.sessionManager.getBranch = () => [
		{ type: "custom", customType: FLEET_STATE_ENTRY, data: { version: FLEET_STATE_VERSION, collapsed: false } },
	];
	await startSession(boot.lifecycle, true, context);
	return (description: string) => {
		const widget = setWidget.mock.calls.findLast(([key]) => key === "fleet")?.[1];
		if (typeof widget !== "function") throw new Error("No fleet widget");
		const rows = widget({ terminal: { columns: 120, rows: 40 }, requestRender: () => {} }, {
			fg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		} as Parameters<typeof widget>[1]).render(120);
		const matches = rows.filter((line) => line.includes(description));
		if (matches.length !== 1 || !matches[0]) {
			throw new Error(`Expected one fleet row for ${description}, found ${matches.length}`);
		}
		return matches[0];
	};
}

/** The wording shared by every shadow note; negative assertions use it so a wording change cannot pass vacuously. */
const SHADOW_FRAGMENT = "overrides definition model";

const disclosures = [
	{
		name: "unmapped",
		definition: "@unmapped",
		note: "Note: model tier @unmapped is unmapped; inheriting the parent model.",
		settings: "Exact binding: unmapped.",
		flag: "[@unmapped unmapped]",
		selected: "parent",
		tierKind: "unmapped",
	},
	{
		name: "mapped",
		definition: "@mapped",
		note: "Model: @mapped -> selection-path/typed (static)",
		settings: "Exact binding: static selection-path/typed",
		flag: "[@mapped]",
		selected: "typed",
		tierKind: "static",
	},
	{
		name: "unavailable",
		definition: "@unavailable",
		note: "Note: model tier @unavailable is unavailable; inheriting the parent model.",
		settings: "Exact binding: static selection-path/absent",
		flag: "[@unavailable unavailable]",
		selected: "parent",
		tierKind: "unavailable",
	},
	{
		name: "wildcard",
		definition: "@mapped",
		overrides: { "*": ref("wildcard") },
		note: "Resolved model: selection-path/wildcard.",
		shadow: 'Note: agentModels["*"] overrides definition model @mapped.',
		settings: "Shadowed definition: @mapped",
		selected: "wildcard",
	},
	{
		name: "explicit parameter",
		definition: "@mapped",
		overrides: { "*": ref("wildcard") },
		param: ref("explicit"),
		note: "Resolved model: selection-path/explicit.",
		settings: "Shadowed agentModels:*: selection-path/wildcard",
		selected: "explicit",
	},
];

async function prepareDisclosure(sample: (typeof disclosures)[number]) {
	writeFileSync(
		join(sandbox.dir, ".pi", "agents", "scout.md"),
		`---\ndescription: scout\ntools: read\nmodel: "${sample.definition}"\noutput_transcript: true\n---\nScout.`,
	);
	const renderFleetRow = await startFleetSession();
	setAgentModels(sample.overrides);
	setModelTiers({ mapped: [ref("typed")], unavailable: [ref("absent")] }, {});
	const run = (description: string, background: boolean) =>
		boot.tools
			.get("Agent")
			.execute(
				description,
				{ subagent_type: "scout", description, prompt: "go", model: sample.param, run_in_background: background },
				undefined,
				undefined,
				context,
			);
	return { renderFleetRow, run };
}

// Inspect the fleet and notice after the child has settled and the outbox hold has elapsed.
async function settleDisclosureRun() {
	await flush();
	clock.advance(NOTIFICATION_HOLD_MS);
}

disclosureWithModel.each(disclosures)("discloses $name across model-tier surfaces", async (sample) => {
	const { renderFleetRow, run } = await prepareDisclosure(sample);
	const expectResult = (text: string, status: string) => {
		expect(text).toContain(`${sample.note}\n\n${status}`);
		if (sample.shadow) {
			expect(sample.shadow).toContain(SHADOW_FRAGMENT);
			expect(text).toContain(sample.shadow);
		} else expect(text).not.toContain(SHADOW_FRAGMENT);
	};

	const start = await run("background", true);
	expectResult(start.content[0].text, "Agent started in background.");
	await settleDisclosureRun();
	const notice = vi
		.mocked(boot.pi.sendMessage)
		.mock.calls.find(([message]: [{ customType: string }]) => message.customType === "subagent-notification");
	expect(notice?.[0].content).toContain(`<model-note>${sample.note.replace("->", "-&gt;")}</model-note>`);
	expect(notice?.[0].content).not.toContain(SHADOW_FRAGMENT);

	const transcript = /^Output file: (.+)$/m.exec(start.content[0].text)?.[1];
	if (!transcript) throw new Error("Agent start did not report a transcript");
	const entries = readFileSync(transcript, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	const tierEntries = entries.filter((entry) => entry.type === "model-tier");
	if (sample.tierKind) {
		expect(tierEntries).toEqual([
			expect.objectContaining({ note: sample.note, modelTier: expect.objectContaining({ kind: sample.tierKind }) }),
		]);
	} else {
		expect(tierEntries).toEqual([]);
		expect(entries.some((entry) => entry.type === "model-fallback")).toBe(false);
	}

	const row = renderFleetRow("background");
	expect(row).toContain(ref(sample.selected));
	if (sample.flag) expect(row).toContain(sample.flag);
	else expect(row).not.toMatch(/\[@|\[fallback/);

	const completed = await run("foreground", false);
	expectResult(completed.content[0].text, "Agent completed");
	vi.mocked(runner.runAgent).mockRejectedValueOnce(new Error("fixture failure"));
	const failed = await run("failed", false);
	expectResult(failed.content[0].text, "Agent failed: fixture failure");

	const [nestedAgent] = createNestedSubagentTools({
		manager,
		pi: boot.pi,
		parentAgentId: "owner",
		depth: 1,
		maxSubagentDepth: 2,
		allowedSubagents: "all",
		configCwd: sandbox.dir,
		projectTrusted: true,
	});
	if (!nestedAgent) throw new Error("Missing nested Agent tool");
	const runNested = async (description: string) => {
		const result = await nestedAgent.execute(
			description,
			{ subagent_type: "scout", description, prompt: "go", model: sample.param },
			undefined,
			undefined,
			context,
		);
		const content = result.content[0];
		if (content?.type !== "text") throw new Error("Nested Agent did not return text");
		return content.text;
	};
	expectResult(await runNested("nested"), "done");
	vi.mocked(runner.runAgent).mockRejectedValueOnce(new Error("nested fixture failure"));
	expectResult(await runNested("nested failure"), "Agent failed: nested fixture failure");

	const preview = explainModel({
		agentType: "scout",
		definitionModel: sample.definition,
		paramModel: sample.param,
		parentModel: parent,
		registry,
		cwd: sandbox.dir,
	});
	expect(preview.text).toContain(sample.settings);
	if (sample.param) expect(preview.text).toContain("Shadowed definition: @mapped");
	expect(preview.text).toContain(`Selected: ${ref(sample.selected)}.`);
});

disclosureTest.each(disclosures.filter((sample) => sample.flag))(
	"keeps the $name tier flag in the fleet with model display off",
	async (sample) => {
		const { renderFleetRow, run } = await prepareDisclosure(sample);
		await run("background", true);
		await settleDisclosureRun();
		const row = renderFleetRow("background");
		expect(row).toContain(sample.flag);
		expect(row).not.toContain(ref(sample.selected));
	},
);

it("reserves the concurrency slot before awaiting tier admission", async () => {
	setModelTiers({ cheap: [ref("typed")] }, {});
	setAgentModels({ scout: "@cheap" });
	manager.setMaxConcurrent(1);
	const first = manager.spawn(boot.pi, context, "scout", "first", { description: "first", isBackground: true });
	const second = manager.spawn(boot.pi, context, "scout", "second", { description: "second", isBackground: true });
	expect(manager.getRecord(first)?.status).toBe("running");
	expect(manager.getRecord(second)?.status).toBe("queued");
	await manager.waitForAll();
	expect(runner.runAgent).toHaveBeenCalledTimes(2);
});

it("releases the concurrency slot on tier refusal before starting another child", async () => {
	setModelTiers({ cheap: [ref("typed")] }, {});
	setAgentModels({ scout: "@cheap" });
	manager.setMaxConcurrent(1);
	const resetAt = clock.now() + 1000;
	blockedUntil = resetAt;
	const refused = manager.spawn(boot.pi, context, "scout", "refused", { description: "refused", isBackground: true });
	await expect(manager.awaitStartup(refused)).rejects.toThrow(
		new Error(
			`Model: @cheap is exhausted. Subscription quota for @cheap is exhausted; it resets at ${new Date(resetAt).toISOString()}. The agent was not started.`,
		),
	);
	expect(runner.runAgent).not.toHaveBeenCalled();
	blockedUntil = undefined;
	const next = manager.spawn(boot.pi, context, "scout", "next", { description: "next", isBackground: true });
	expect(manager.getRecord(next)?.status).toBe("running");
	await manager.waitForAll();
	expect(runner.runAgent).toHaveBeenCalledTimes(1);
});

it("does not launch a child aborted during tier admission", async () => {
	setModelTiers({ cheap: [ref("typed")] }, {});
	setAgentModels({ scout: "@cheap" });
	const signal = new AbortController();
	const id = manager.spawn(boot.pi, context, "scout", "cancelled", {
		description: "cancelled",
		isBackground: true,
		signal: signal.signal,
	});
	signal.abort();
	await expect(manager.awaitStartup(id)).rejects.toThrow("Agent aborted during model admission");
	expect(runner.runAgent).not.toHaveBeenCalled();
});

it("updates workflow resolution from the admitted model to the answering model", async () => {
	setModelTiers({ cheap: ["router/default"] }, {});
	const resolved: { recordId?: string; modelId?: string; modelNote?: string }[] = [];
	const transcript = join(sandbox.dir, "tier-answer.output");
	admittedModel = ref("typed");
	vi.mocked(runner.runAgent).mockImplementationOnce(async (_ctx, _type, _prompt, options) => {
		const session = {
			model: options.model,
			dispose: vi.fn(),
			sessionManager: { getSessionFile: () => undefined },
		} as unknown as AgentSession;
		await Promise.resolve();
		const record = manager.getRecord(options.agentId!);
		if (!record) throw new Error("Missing workflow record");
		record.outputFile = transcript;
		options.onSessionCreated?.(session);
		options.onAssistantUsage?.(
			{ input: 1, output: 1, cacheWrite: 0, cost: 0 },
			{ api: "openai-completions", provider: "selection-path", model: "explicit" },
		);
		return { responseText: "answer", session, aborted: false, steered: false };
	});
	const result = await createWorkflowHost({ pi: boot.pi, ctx: context, manager }).spawnAgent({
		agentId: "tier-workflow",
		index: 0,
		agentType: "scout",
		label: "tier workflow",
		prompt: "go",
		model: "@cheap",
		onResolved: (info) => resolved.push(info),
	});
	expect(result.modelTier).toMatchObject({ kind: "routed", tier: "cheap", profile: "router/default" });
	expect(resolved.some((info) => info.modelId === ref("typed"))).toBe(true);
	expect(resolved.at(-1)?.modelId).toBe(ref("explicit"));
	expect(result.modelNote).toContain(`switched from ${ref("typed")} within tier`);
	expect(result.modelTier).toMatchObject({ admitted: ref("typed"), answered: ref("explicit") });
	const lines = readFileSync(transcript, "utf-8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	expect(lines.at(-1)).toMatchObject({
		type: "model-tier",
		modelTier: { answered: ref("explicit") },
		note: result.modelNote,
	});
	const id = resolved.find((info) => info.recordId)?.recordId;
	if (!id) throw new Error("Workflow did not report a record id");
	clock.advance(11 * 60_000);
	const evicted = manager.getEvictedNote(id);
	expect(evicted?.modelTier).toMatchObject({ answered: ref("explicit") });
	if (!evicted) throw new Error("Missing evicted workflow note");
	expect(describeEvicted(evicted)).toContain(`Model: @cheap -> ${ref("explicit")}`);
});

it("relabels the answering model on a tier record that writes no transcript", async () => {
	setModelTiers({ cheap: ["router/default"] }, {});
	setAgentModels({ scout: "@cheap" });
	admittedModel = ref("typed");
	vi.mocked(runner.runAgent).mockImplementationOnce(async (_ctx, _type, _prompt, options) => {
		const session = {
			model: options.model,
			dispose: vi.fn(),
			sessionManager: { getSessionFile: () => undefined },
		} as unknown as AgentSession;
		options.onSessionCreated?.(session);
		options.onAssistantUsage?.(
			{ input: 1, output: 1, cacheWrite: 0, cost: 0 },
			{ api: "openai-completions", provider: "selection-path", model: "explicit" },
		);
		return { responseText: "answer", session, aborted: false, steered: false };
	});
	const id = manager.spawn(boot.pi, context, "scout", "go", { description: "no transcript", isBackground: true });
	await manager.waitForAll();
	const record = manager.getRecord(id)!;
	expect(record.outputFile).toBeUndefined();
	expect(record.modelTier).toMatchObject({ kind: "routed", admitted: ref("typed"), answered: ref("explicit") });
	expect(record.invocation?.modelId).toBe(ref("explicit"));
});

it("shows the same configured model in the agents menu instead of the definition default", async () => {
	setAgentModels({ scout: "router/default" });
	initTheme("dark", false);
	let rendered = "";
	context.ui.select = vi
		.fn()
		.mockImplementationOnce((_title: string, options: string[]) =>
			options.find((option) => option.startsWith("Agent types (")),
		);
	context.ui.custom = vi.fn(
		(
			factory: (tui: object, theme: undefined, keys: object, done: () => void) => { render(width: number): string[] },
		) => {
			rendered = factory({}, undefined, {}, () => {})
				.render(120)
				.join("\n");
			return undefined;
		},
	);
	await boot.commands.get("agents").handler("", context);
	const scoutRow = rendered.split("\n").find((line) => line.includes("scout"));
	expect(scoutRow).toContain("default");
	expect(scoutRow).not.toContain("definition");
});

it("treats RPC null as no explicit override while still applying configured routing", async () => {
	setAgentModels({ "*": "router/default" });
	const { invocation, record } = await invoke("RPC", null);
	expect(invocation?.[3].model).toMatchObject({ provider: "router", id: "default" });
	expect(record?.modelSelection).toMatchObject({ source: "agentModels:*", requested: "router/default" });
});

it("reselects quota-parked defaults at fire time instead of freezing the admitted request", async () => {
	setAgentModels({ scout: "router/default" });
	blockedUntil = clock.now() + 60_000;
	await boot.tools.get("Agent").execute(
		"park",
		{
			subagent_type: "scout",
			description: "parked",
			prompt: "go",
			run_in_background: true,
		},
		undefined,
		undefined,
		context,
	);
	const [job] = new ScheduleStore(resolveStorePath(sandbox.dir, "s1")).list();
	expect(job!.quotaParked).toBe(true);
	expect(job!.model).toBeUndefined();
	expect(admissionModels).toEqual(["router/default"]);
	expect(runner.runAgent).not.toHaveBeenCalled();
	refuseStaleParent = true;
	setAgentModels({ scout: ref("typed") });
	blockedUntil = undefined;
	clock.advance(120_000);
	await flush();
	expect(admissionModels).toEqual(["router/default", ref("typed")]);
	expect(vi.mocked(runner.runAgent).mock.calls.at(-1)?.[3].model).toMatchObject({ id: "typed" });
});

it("keeps an explicit quota-parked alias request and re-resolves it at fire time", async () => {
	setModelAliases({ portable: ["router/default"] });
	blockedUntil = clock.now() + 60_000;
	await boot.tools.get("Agent").execute(
		"park-explicit",
		{
			subagent_type: "scout",
			description: "parked explicit",
			prompt: "go",
			model: "portable",
			run_in_background: true,
		},
		undefined,
		undefined,
		context,
	);
	const [job] = new ScheduleStore(resolveStorePath(sandbox.dir, "s1")).list();
	expect(job!.quotaParked).toBe(true);
	expect(job!.model).toBe("portable");
	expect(admissionModels).toEqual(["router/default"]);
	expect(runner.runAgent).not.toHaveBeenCalled();
	refuseStaleParent = true;
	setModelAliases({ portable: [ref("explicit")] });
	setAgentModels({ scout: ref("typed") });
	blockedUntil = undefined;
	clock.advance(120_000);
	await flush();
	const options = vi.mocked(runner.runAgent).mock.calls.at(-1)?.[3];
	expect(admissionModels).toEqual(["router/default", ref("explicit")]);
	expect(options?.model).toMatchObject({ id: "explicit" });
	expect(options?.modelSelection).toMatchObject({ requested: "portable", source: "param" });
});

it("reopens an unavailable-tier run on a literal model with only current fallback disclosure", async () => {
	setModelTiers({ cheap: ["missing/model"] }, { onUnavailable: "inherit" });
	setAgentModels({ scout: "@cheap" });
	const { record } = await invoke("Agent");
	const root = (globalThis as Record<symbol, { getRecord(id: string): ReturnType<AgentManager["getRecord"]> }>)[
		Symbol.for("pi-subagents:manager")
	]!;
	expect(record?.sessionFile).toBeDefined();
	expect(record?.modelFallback).toEqual({ input: "@cheap", used: ref("parent") });
	expect(record?.modelTier).toMatchObject({ kind: "unavailable", tier: "cheap" });
	clock.advance(11 * 60_000);
	expect(root.getRecord(record!.id)).toBeUndefined();
	setAgentModels({ scout: ref("explicit") });
	await boot.lifecycle.get("input")?.({ type: "input", text: "@scout again", source: "interactive" } as never, context);
	await flush();
	const options = vi.mocked(runner.runAgent).mock.calls.at(-1)?.[3];
	const reopened = root.getRecord(options!.agentId!);
	expect(options?.resumeSessionFile).toBe(record?.sessionFile);
	expect(options?.model).toMatchObject({ id: "explicit" });
	expect(reopened?.modelSelection).toMatchObject({ requested: ref("explicit"), source: "agentModels:type" });
	expect(reopened?.modelFallback).toBeUndefined();
	expect(reopened?.previousModelFallback).toEqual(record?.modelFallback);
	expect(reopened?.previousModelTier).toEqual(record?.modelTier);
});

it("does not retain unavailable-tier fallback provenance when a reopen request fails", async () => {
	setModelTiers({ cheap: ["missing/model"] }, { onUnavailable: "inherit" });
	setAgentModels({ scout: "@cheap" });
	const { record } = await invoke("Agent");
	const root = (globalThis as Record<symbol, { getRecord(id: string): ReturnType<AgentManager["getRecord"]> }>)[
		Symbol.for("pi-subagents:manager")
	]!;
	clock.advance(11 * 60_000);
	setModelTiers({ cheap: ["missing/model"] }, { onUnavailable: "error" });
	await boot.lifecycle.get("input")?.({ type: "input", text: "@scout again", source: "interactive" } as never, context);
	await flush();
	expect(vi.mocked(runner.runAgent)).toHaveBeenCalledTimes(1);
	expect(root.getRecord(record!.id)).toBeUndefined();
	expect(context.ui.notify).toHaveBeenCalledWith(
		expect.stringContaining("Model tier @cheap is unavailable."),
		"warning",
	);
});

it("keeps the prior tier separate from an evicted mention's new literal selection", async () => {
	setModelTiers({ cheap: [ref("typed")] }, {});
	setAgentModels({ scout: "@cheap" });
	const { record } = await invoke("Agent");
	const originalTier = record?.modelTier;
	expect(originalTier).toMatchObject({ kind: "static", tier: "cheap", member: ref("typed") });
	clock.advance(11 * 60_000);
	setAgentModels({ scout: ref("explicit") });
	await boot.lifecycle.get("input")?.({ type: "input", text: "@scout again", source: "interactive" } as never, context);
	await flush();
	const options = vi.mocked(runner.runAgent).mock.calls.at(-1)?.[3];
	const root = (globalThis as Record<symbol, { getRecord(id: string): ReturnType<AgentManager["getRecord"]> }>)[
		Symbol.for("pi-subagents:manager")
	]!;
	expect(options?.resumeSessionFile).toBe(record?.sessionFile);
	expect(root.getRecord(options!.agentId!)?.previousModelTier).toEqual(originalTier);
	expect(root.getRecord(options!.agentId!)?.modelTier).toBeUndefined();
	expect(options?.modelSelection).toMatchObject({ outcome: "resolved", model: { id: "explicit" } });
});

it("retains the tier selection and disclosure on a live resume despite changed bindings", async () => {
	setModelTiers({ cheap: [ref("typed")] }, {});
	setAgentModels({ scout: "@cheap" });
	const { record } = await invoke("Agent");
	const tier = record!.modelTier;
	setModelTiers({ cheap: [ref("explicit")] }, {});
	const result = await boot.tools.get("Agent").execute(
		"tier-resume",
		{
			subagent_type: "scout",
			description: "again",
			prompt: "again",
			resume: record!.id,
			model: "@missing",
			run_in_background: false,
		},
		undefined,
		undefined,
		context,
	);
	expect(record!.modelTier).toBe(tier);
	expect(record!.session?.model).toMatchObject({ id: "typed" });
	expect(result.details.modelTier).toEqual(tier);
	expect(result.content[0].text).toContain(`Model: @cheap -> ${ref("typed")}`);
	expect(result.content[0].text).not.toContain("@missing");
});

it("ignores new model inputs on Agent resume and reads the original record disclosure", async () => {
	setAgentModels({ scout: "missing-model" });
	const { record } = await invoke("Agent");
	const selection = record!.modelSelection;
	setAgentModels({ scout: "router/default" });
	const result = await boot.tools.get("Agent").execute(
		"resume",
		{
			subagent_type: "not-the-original-type",
			description: "again",
			prompt: "again",
			resume: record!.id,
			model: "another-missing-model",
			run_in_background: false,
		},
		undefined,
		undefined,
		context,
	);
	expect(runner.resumeAgent).toHaveBeenCalled();
	expect(record!.modelSelection).toBe(selection);
	expect(result.details.modelNote).toContain('configured model "missing-model"');
	expect(result.content[0].text).not.toContain("another-missing-model");
});

it("retains the record's original selection on resume despite changed config", async () => {
	setAgentModels({ scout: "missing-model" });
	const { record } = await invoke("nested");
	expect(record).toBeDefined();
	const selection = record!.modelSelection;
	setAgentModels({ scout: "router/default" });
	await manager.resume(record!.id, "again");
	expect(record!.modelSelection).toBe(selection);
	expect(record!.session?.model).toBe(parent);
	expect(runner.resumeAgent).toHaveBeenCalled();
});

describe("schedule and quota-park results claim no resolved identity", () => {
	const call = (params: Record<string, unknown>) =>
		boot.tools
			.get("Agent")
			.execute(
				"claim",
				{ subagent_type: "scout", description: "claim", prompt: "go", ...params },
				undefined,
				undefined,
				context,
			);

	it.each([ref("explicit"), "@cheap"])("omits it on a scheduled result: %s", async (model) => {
		setModelTiers({ cheap: [ref("typed"), ref("explicit")] }, {});
		const result = await call({ model, schedule: "+1h" });
		expect(result.content[0].text).toContain("Scheduled");
		expect(result.content[0].text).not.toContain("Resolved model:");
	});

	it.each([ref("explicit"), "@cheap"])("omits it on a quota-park result: %s", async (model) => {
		setModelTiers({ cheap: [ref("typed"), ref("explicit")] }, {});
		blockedUntil = clock.now() + 60_000;
		const result = await call({ model, run_in_background: true });
		expect(result.content[0].text).toContain("Queued");
		expect(result.content[0].text).not.toContain("Resolved model:");
	});
});
