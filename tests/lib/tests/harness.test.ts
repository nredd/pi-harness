import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { getApiProvider, getApiProviders } from "@earendil-works/pi-ai/compat";
import { type ExtensionFactory, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, expect, test, vi } from "vitest";
import {
	createHarness,
	createTestExtensionsResult,
	createTestResourceLoader,
	createTestUiContext,
	fauxAssistantMessage,
	fauxText,
	getAssistantTexts,
	getMessageText,
	getToolResult,
	getUserTexts,
	type Harness,
	type HarnessOptions,
	registerFauxProvider,
} from "../src/harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

async function start(options: HarnessOptions = {}): Promise<Harness> {
	const harness = await createHarness({ settings: { retry: { enabled: false } }, ...options });
	harnesses.push(harness);
	return harness;
}

const echo: ExtensionFactory = (pi) => {
	pi.registerTool({
		name: "echo",
		label: "Echo",
		description: "Echo the value",
		parameters: Type.Object({ value: Type.String() }),
		async execute(_id, params) {
			return { content: [{ type: "text", text: `echo ${params.value}` }], details: {} };
		},
	});
};

test("getMessageText reads every content shape", () => {
	expect(getMessageText(undefined)).toBe("");
	expect(getMessageText("plain")).toBe("");
	expect(getMessageText({})).toBe("");
	expect(getMessageText({ content: undefined })).toBe("");
	expect(getMessageText({ content: "direct" })).toBe("direct");
	expect(
		getMessageText({ content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }] }),
	).toBe("a\nb");
});

test("createHarness needs no options", async () => {
	const h = await createHarness();
	try {
		expect(h.cwd).toBe(h.tempDir);
	} finally {
		h.cleanup();
	}
});

test("a prompt runs a real turn through the scripted provider", async () => {
	const h = await start();
	h.setResponses([fauxAssistantMessage([fauxText("hello")])]);
	expect(h.getPendingResponseCount()).toBe(1);
	await h.session.prompt("hi");
	expect(h.getPendingResponseCount()).toBe(0);
	expect(getUserTexts(h)).toEqual(["hi"]);
	expect(getAssistantTexts(h)).toEqual(["hello"]);
	expect(h.eventsOfType("agent_end")).toHaveLength(1);
	expect(h.getModel()).toBe(h.models[0]);
	expect(h.faux.state.callCount).toBe(1);
	h.appendResponses([fauxAssistantMessage([fauxText("again")])]);
	await h.session.prompt("more");
	expect(getAssistantTexts(h)).toEqual(["hello", "again"]);
	expect(h.settingsManager.getRetrySettings().enabled).toBe(false);
	expect(await h.credentials.read(h.models[0].provider)).toEqual({ type: "api_key", key: "faux-key" });
});

test("a tool result is found in the transcript, and a missing one throws", async () => {
	const h = await start({ extensionFactories: [echo] });
	h.setResponses([
		fauxAssistantMessage([{ type: "toolCall", id: "c1", name: "echo", arguments: { value: "x" } }], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage([fauxText("done")]),
	]);
	await h.session.prompt("go");
	expect(getMessageText(getToolResult(h, "echo"))).toBe("echo x");
	expect(() => getToolResult(h, "absent")).toThrow("No absent tool result");
});

test("the test UI context is inert, themed, and overridable", async () => {
	const ui = createTestUiContext();
	expect(await ui.select("t", ["a"])).toBeUndefined();
	expect(await ui.confirm("t", "m")).toBe(false);
	expect(await ui.input("t")).toBeUndefined();
	expect(await ui.editor("t")).toBeUndefined();
	expect(await ui.custom(() => ({ render: () => [], invalidate: () => {} }) as never)).toBeUndefined();
	ui.notify("n");
	ui.onTerminalInput(() => ({}))();
	ui.setStatus("k", undefined);
	ui.setWorkingMessage();
	ui.setWorkingVisible(true);
	ui.setWorkingIndicator();
	ui.setHiddenThinkingLabel();
	ui.setWidget("k", undefined);
	ui.setFooter(undefined);
	ui.setHeader(undefined);
	ui.setTitle("t");
	ui.pasteToEditor("p");
	ui.setEditorText("e");
	ui.addAutocompleteProvider((provider) => provider);
	ui.setEditorComponent(undefined);
	ui.setToolsExpanded(true);
	expect(ui.getEditorText()).toBe("");
	expect(ui.getEditorComponent()).toBeUndefined();
	expect(ui.getAllThemes()).toEqual([]);
	expect(ui.getTheme("dark")).toBeUndefined();
	expect(ui.setTheme("dark")).toEqual({ success: false, error: "Theme switching not available in tests" });
	expect(ui.getToolsExpanded()).toBe(false);
	expect(ui.theme).toBe(ui.theme);
	expect(ui.theme.fg("accent", "x")).toContain("x");
	expect(ui.theme.bg("selectedBg", "y")).toContain("y");
	const seen: string[] = [];
	createTestUiContext({ notify: (message) => seen.push(message) }).notify("loud");
	expect(seen).toEqual(["loud"]);
});

test("a caller-owned faux provider survives cleanup and is shared across harnesses", async () => {
	const faux = registerFauxProvider();
	try {
		const first = await start({ fauxProvider: faux });
		const second = await start({ fauxProvider: faux });
		first.setResponses([fauxAssistantMessage([fauxText("one")])]);
		await first.session.prompt("a");
		first.cleanup();
		expect(faux.getModel()).toBeDefined();
		second.setResponses([fauxAssistantMessage([fauxText("two")])]);
		await second.session.prompt("b");
		expect(getAssistantTexts(second)).toEqual(["two"]);
	} finally {
		faux.unregister();
	}
});

test("a faux provider whose transport is gone is refused", async () => {
	const faux = registerFauxProvider();
	faux.unregister();
	await expect(createHarness({ fauxProvider: faux })).rejects.toThrow("Faux transport missing");
});

test("a failed construction releases its scratch directory and owned provider", async () => {
	const previous = process.env.TMPDIR;
	const scratch = mkdtempSync(join(tmpdir(), "harness-fail-"));
	process.env.TMPDIR = scratch;
	const boom = new Error("factory exploded");
	const before = getApiProviders().length;
	try {
		await expect(
			createHarness({
				extensionFactories: [
					() => {
						throw boom;
					},
				],
			}),
		).rejects.toBe(boom);
		expect(readdirSync(scratch)).toEqual([]);
		expect(getApiProviders()).toHaveLength(before);
		// A caller-owned provider is never unregistered by a failed construction.
		const faux = registerFauxProvider();
		await expect(
			createHarness({
				fauxProvider: faux,
				extensionFactories: [
					() => {
						throw boom;
					},
				],
			}),
		).rejects.toBe(boom);
		expect(getApiProvider(faux.api)).toBeDefined();
		faux.unregister();
	} finally {
		if (previous === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = previous;
		rmSync(scratch, { recursive: true, force: true });
	}
});

test("reload restores a transport the registry reset dropped", async () => {
	const h = await start({ extensionFactories: [echo] });
	await h.session.reload();
	// The loader's own reload does not reset the registry, so the transport is already present.
	await h.session.resourceLoader.reload();
	h.setResponses([fauxAssistantMessage([fauxText("after reload")])]);
	await h.session.prompt("hi");
	expect(getAssistantTexts(h)).toEqual(["after reload"]);
	// Without factories the reload still yields an empty extension set.
	const bare = await start();
	await bare.session.reload();
	expect(bare.session.getAllTools().map((tool) => tool.name)).not.toContain("echo");
});

test("models, tools, active names, cwd, session and start event options reach the session", async () => {
	const root = mkdtempSync(join(tmpdir(), "harness-opts-"));
	try {
		const tool: AgentTool = {
			name: "base_tool",
			label: "Base",
			description: "Replaces built-ins",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
		};
		const sessionManager = SessionManager.inMemory(root);
		const h = await start({
			models: [{ id: "m-one" }, { id: "m-two" }],
			tools: [tool],
			initialActiveToolNames: ["base_tool"],
			cwd: root,
			sessionManager,
			sessionStartEvent: { type: "session_start", reason: "startup" },
		});
		expect(h.models.map((model) => model.id)).toEqual(["m-one", "m-two"]);
		expect(h.getModel("m-two")?.id).toBe("m-two");
		expect(h.cwd).toBe(root);
		expect(h.tempDir).not.toBe(root);
		expect(h.sessionManager).toBe(sessionManager);
		await h.session.bindExtensions({ mode: "print" });
		expect(h.session.getActiveToolNames()).toEqual(["base_tool"]);

		const allowed = await start({ extensionFactories: [echo], allowedToolNames: ["echo"], excludedToolNames: ["x"] });
		await allowed.session.bindExtensions({ mode: "print" });
		expect(allowed.session.getActiveToolNames()).toEqual(["echo"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("modelsJson is written for the runtime and removed with the scratch directory", async () => {
	const h = await start({
		modelsJson: {
			providers: {
				custom: { baseUrl: "http://127.0.0.1:1", apiKey: "k", api: "openai-completions", models: [{ id: "c1" }] },
			},
		},
	});
	expect(h.session.modelRuntime.getModel("custom", "c1")?.id).toBe("c1");
	const dir = h.tempDir;
	expect(existsSync(join(dir, "models.json"))).toBe(true);
	h.cleanup();
	expect(existsSync(dir)).toBe(false);
});

test("without configured auth no credential is stored and no key is supplied", async () => {
	const h = await start({ withConfiguredAuth: false });
	expect(await h.credentials.read(h.models[0].provider)).toBeUndefined();
	expect(h.session.agent.getApiKey?.("faux")).toBeUndefined();
	h.setResponses([fauxAssistantMessage([fauxText("keyless")])]);
	await expect(h.session.prompt("hi")).rejects.toThrow("No API key found");
});

test("useModelRuntimeStream routes through a shared runtime", async () => {
	const owner = await start();
	const stream = vi.spyOn(owner.session.modelRuntime, "streamSimple");
	const h = await start({ modelRuntime: owner.session.modelRuntime, useModelRuntimeStream: true });
	expect(h.session.modelRuntime).toBe(owner.session.modelRuntime);
	h.setResponses([fauxAssistantMessage([fauxText("routed")])]);
	await h.session.prompt("hi");
	expect(getAssistantTexts(h)).toEqual(["routed"]);
	expect(stream).toHaveBeenCalledTimes(1);
	const direct = await start();
	direct.setResponses([fauxAssistantMessage([fauxText("direct")])]);
	await direct.session.prompt("hi");
	expect(stream).toHaveBeenCalledTimes(1);
});

test("provider hooks and context transforms reach extension handlers", async () => {
	const calls: string[] = [];
	const hooks: ExtensionFactory = (pi) => {
		pi.on("before_provider_request", () => {
			calls.push("payload");
			return undefined;
		});
		pi.on("after_provider_response", (event) => {
			calls.push(`response:${event.status}`);
		});
		pi.on("context", () => {
			calls.push("context");
		});
	};
	const prepared: string[] = [];
	const h = await start({
		extensionFactories: [hooks],
		prepareRequest: async (request) => {
			prepared.push("prepared");
			return request;
		},
	});
	await h.session.bindExtensions({ mode: "print" });
	h.setResponses([fauxAssistantMessage([fauxText("ok")])]);
	await h.session.prompt("hi");
	expect(calls).toEqual(["context", "response:200"]);
	expect(prepared).not.toEqual([]);
	// The faux transport builds no wire payload, so drive the agent's payload hook directly.
	await h.session.agent.onPayload?.({ wire: 1 }, h.getModel());
	expect(calls.at(-1)).toBe("payload");
});

test("payload and response hooks pass through when no extension handles them", async () => {
	const h = await start();
	expect(await h.session.agent.onPayload?.({ wire: 1 }, h.getModel())).toEqual({ wire: 1 });
	await h.session.bindExtensions({ mode: "print" });
	expect(await h.session.agent.onPayload?.({ wire: 2 }, h.getModel())).toEqual({ wire: 2 });
	await h.session.agent.onResponse?.({ status: 200, headers: {} }, h.getModel());
});

test("a supplied resource loader replaces the factory loader", async () => {
	const resourceLoader = createTestResourceLoader({ extensionsResult: await createTestExtensionsResult([echo]) });
	const h = await start({ resourceLoader });
	await h.session.bindExtensions({ mode: "print" });
	expect(h.session.getAllTools().map((tool) => tool.name)).toContain("echo");
});

test("extension inputs are named like the loader names them, and a path input reports its source", async () => {
	const quiet: ExtensionFactory = () => {};
	const result = await createTestExtensionsResult(
		[
			echo,
			{ name: "named", factory: quiet },
			{ factory: quiet, path: "/pkg/dir/index.ts" },
			{ factory: quiet, path: "" },
		],
		"/",
	);
	expect(result.extensions.map((extension) => extension.path)).toEqual([
		"<inline:1>",
		"<inline:named>",
		"/pkg/dir/index.ts",
		"<inline:4>",
	]);
	const entry = result.extensions[2];
	expect(entry?.resolvedPath).toBe("/pkg/dir/index.ts");
	expect(entry?.sourceInfo).toMatchObject({ path: "/pkg/dir/index.ts", source: "local", baseDir: "/pkg/dir" });
	expect(result.errors).toEqual([]);
});

test("a path input reports its provenance on everything its factory registered", async () => {
	const registers: ExtensionFactory = (pi) => {
		pi.registerTool({
			name: "owned",
			label: "Owned",
			description: "Owned tool",
			parameters: Type.Object({}),
			execute: async () => ({ content: [], details: {} }),
		});
		pi.registerCommand("owned-cmd", { description: "Owned command", handler: async () => {} });
		pi.registerFlag("owned-flag", { type: "boolean" });
		pi.registerShortcut("ctrl+shift+o", { handler: async () => {} });
		pi.registerProvider("owned-provider", {
			baseUrl: "http://127.0.0.1:1",
			apiKey: "k",
			api: "openai-completions",
			models: [],
		});
	};
	const bystander: ExtensionFactory = (pi) => {
		pi.registerProvider("other-provider", {
			baseUrl: "http://127.0.0.1:1",
			apiKey: "k",
			api: "openai-completions",
			models: [],
		});
	};
	const result = await createTestExtensionsResult(
		[
			{ factory: registers, path: "/pkg/dir/index.ts" },
			{ name: "bystander", factory: bystander },
		],
		"/",
	);
	const [owned, other] = result.extensions;
	expect(owned?.tools.get("owned")?.sourceInfo.path).toBe("/pkg/dir/index.ts");
	expect(owned?.commands.get("owned-cmd")?.sourceInfo.path).toBe("/pkg/dir/index.ts");
	expect(owned?.flags.get("owned-flag")?.extensionPath).toBe("/pkg/dir/index.ts");
	expect(owned?.shortcuts.get("ctrl+shift+o")?.extensionPath).toBe("/pkg/dir/index.ts");
	expect(result.runtime.pendingProviderRegistrations.map(({ name, extensionPath }) => [name, extensionPath])).toEqual([
		["owned-provider", "/pkg/dir/index.ts"],
		["other-provider", "<inline:bystander>"],
	]);
	expect(other?.path).toBe("<inline:bystander>");
});

test("a path input's temporary identity never captures another input's registrations", async () => {
	const provider =
		(name: string): ExtensionFactory =>
		(pi) => {
			pi.registerProvider(name, { baseUrl: "http://127.0.0.1:1", apiKey: "k", api: "openai-completions", models: [] });
		};
	// The second input is literally named like the first input's positional name.
	const result = await createTestExtensionsResult(
		[
			{ factory: provider("from-path"), path: "/pkg/a.ts" },
			{ name: "1", factory: provider("from-named") },
			{ name: "1\0path", factory: provider("from-nul") },
			{ factory: provider("from-second-path"), path: "/pkg/b.ts" },
			// A final path equal to another input's temporary name must not merge their registrations.
			{ factory: provider("from-lookalike"), path: "<inline:6\0path>" },
			{ factory: provider("from-seventh"), path: "/pkg/c.ts" },
		],
		"/",
	);
	expect(result.runtime.pendingProviderRegistrations.map(({ name, extensionPath }) => [name, extensionPath])).toEqual([
		["from-path", "/pkg/a.ts"],
		["from-named", "<inline:1>"],
		["from-nul", "<inline:1\0path>"],
		["from-second-path", "/pkg/b.ts"],
		["from-lookalike", "<inline:6\0path>"],
		["from-seventh", "/pkg/c.ts"],
	]);
});

test("the default cwd is the process cwd, and a throwing factory rejects with its own error", async () => {
	const boom = new Error("factory exploded");
	await expect(
		createTestExtensionsResult([
			() => {
				throw boom;
			},
		]),
	).rejects.toBe(boom);
	const later = vi.fn();
	await expect(
		createTestExtensionsResult([
			() => {
				throw boom;
			},
			later,
		]),
	).rejects.toBe(boom);
	expect(later).not.toHaveBeenCalled();
	expect((await createTestExtensionsResult([])).extensions).toEqual([]);
});

test("the default test resource loader is empty and reloads only when asked", async () => {
	const bare = createTestResourceLoader();
	expect(bare.getExtensions().extensions).toEqual([]);
	expect(bare.getSkills()).toEqual({ skills: [], diagnostics: [] });
	expect(bare.getPrompts()).toEqual({ prompts: [], diagnostics: [] });
	expect(bare.getThemes()).toEqual({ themes: [], diagnostics: [] });
	expect(bare.getAgentsFiles()).toEqual({ agentsFiles: [] });
	expect(bare.getSystemPrompt()).toBeUndefined();
	expect(bare.getSystemPromptSource()).toBeUndefined();
	expect(bare.getAppendSystemPrompt()).toEqual([]);
	expect(bare.getAppendSystemPromptSources()).toEqual([]);
	bare.extendResources({});
	await bare.reload();
	expect(bare.getExtensions().extensions).toEqual([]);

	const reloaded = createTestResourceLoader({ reloadExtensions: () => createTestExtensionsResult([echo]) });
	await reloaded.reload();
	expect(reloaded.getExtensions().extensions).toHaveLength(1);
});
