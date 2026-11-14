/**
 * In-process harness: a real `AgentSession` around a scripted faux provider, built from the public
 * `@earendil-works/pi-coding-agent` root export plus the public `pi-ai` / `pi-agent-core` packages.
 * Runs against the fork release and upstream releases alike. The interactive host stays on the
 * fork's `/testing/interactive`.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import {
	type FauxModelDefinition,
	type FauxProviderRegistration,
	type FauxResponseStep,
	InMemoryCredentialStore,
	InMemoryModelsStore,
	type Model,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import {
	getApiProvider,
	registerApiProvider,
	registerFauxProvider,
	streamSimple,
	unregisterApiProviders,
} from "@earendil-works/pi-ai/compat";
import {
	AgentSession,
	type AgentSessionEvent,
	convertToLlm,
	type ExtensionRunner,
	type ExtensionUIContext,
	ModelRuntime,
	type ResourceLoader,
	SessionManager,
	type SessionStartEvent,
	SettingsManager,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { createTestExtensionsResult, createTestResourceLoader } from "./resources.ts";

export {
	type FauxModelDefinition,
	type FauxProviderRegistration,
	type FauxProviderState,
	type FauxResponseFactory,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
	fauxToolCall,
	type RegisterFauxProviderOptions,
} from "@earendil-works/pi-ai";
export { registerFauxProvider } from "@earendil-works/pi-ai/compat";
export {
	type CreateTestExtensionsResultInput,
	type CreateTestResourceLoaderOptions,
	createTestExtensionsResult,
	createTestResourceLoader,
} from "./resources.ts";

type Settings = NonNullable<Parameters<typeof SettingsManager.inMemory>[0]>;

/** Share restoration and cleanup ownership across harnesses using the same faux registration. */
const fauxRegistrations = new WeakMap<FauxProviderRegistration, () => void>();

type MessageTextPart = { type: "text"; text: string };

/** Text of a message's content, however it is shaped; `""` when it has none. */
export function getMessageText(message: unknown): string {
	if (!message || typeof message !== "object" || !("content" in message)) return "";
	const content = (message as { content?: string | Array<{ type: string; text?: string }> }).content;
	if (content === undefined) return "";
	if (typeof content === "string") return content;
	return content
		.filter((part): part is MessageTextPart => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

/** Text of every user message in the transcript. */
export function getUserTexts(harness: Harness): string[] {
	return harness.session.messages
		.filter((message) => message.role === "user")
		.map((message) => getMessageText(message));
}

/** Text of every assistant message in the transcript. */
export function getAssistantTexts(harness: Harness): string[] {
	return harness.session.messages
		.filter((message) => message.role === "assistant")
		.map((message) => getMessageText(message));
}

/** The latest result of `toolName` in the session transcript. */
export function getToolResult(harness: Harness, toolName: string): ToolResultMessage {
	const result = harness.session.messages
		.filter((message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === toolName)
		.at(-1);
	if (!result) throw new Error(`No ${toolName} tool result`);
	return result;
}

/** One color per foreground token. The tokens are the published theme schema's required set. */
const FOREGROUND_TOKENS = [
	"accent",
	"border",
	"borderAccent",
	"borderMuted",
	"success",
	"error",
	"warning",
	"muted",
	"dim",
	"text",
	"thinkingText",
	"userMessageText",
	"customMessageText",
	"customMessageLabel",
	"toolTitle",
	"toolOutput",
	"mdHeading",
	"mdLink",
	"mdLinkUrl",
	"mdCode",
	"mdCodeBlock",
	"mdCodeBlockBorder",
	"mdQuote",
	"mdQuoteBorder",
	"mdHr",
	"mdListBullet",
	"toolDiffAdded",
	"toolDiffRemoved",
	"toolDiffContext",
	"syntaxComment",
	"syntaxKeyword",
	"syntaxFunction",
	"syntaxVariable",
	"syntaxString",
	"syntaxNumber",
	"syntaxType",
	"syntaxOperator",
	"syntaxPunctuation",
	"thinkingOff",
	"thinkingMinimal",
	"thinkingLow",
	"thinkingMedium",
	"thinkingHigh",
	"thinkingXhigh",
	"thinkingMax",
	"bashMode",
] as const;
const BACKGROUND_TOKENS = [
	"selectedBg",
	"userMessageBg",
	"customMessageBg",
	"toolPendingBg",
	"toolSuccessBg",
	"toolErrorBg",
] as const;

let testTheme: Theme | undefined;

/** A deterministic theme built from public `Theme`, so tests never touch the global one. */
function getTestTheme(): Theme {
	testTheme ??= new Theme(
		Object.fromEntries(FOREGROUND_TOKENS.map((token) => [token, "#808080"])) as ConstructorParameters<typeof Theme>[0],
		Object.fromEntries(BACKGROUND_TOKENS.map((token) => [token, "#202020"])) as ConstructorParameters<typeof Theme>[1],
		"truecolor",
	);
	return testTheme;
}

/** An extension UI context that does nothing, with `overrides` applied. */
export function createTestUiContext(overrides: Partial<ExtensionUIContext> = {}): ExtensionUIContext {
	return {
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		notify: () => {},
		onTerminalInput: () => () => {},
		setStatus: () => {},
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		custom: async <T>() => undefined as T,
		pasteToEditor: () => {},
		setEditorText: () => {},
		getEditorText: () => "",
		editor: async () => undefined,
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		get theme() {
			return getTestTheme();
		},
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: false, error: "Theme switching not available in tests" }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
		...overrides,
	};
}

export interface HarnessOptions {
	/** Caller-owned faux registration, shared across runtime replacements. Cleanup does not unregister it. */
	fauxProvider?: FauxProviderRegistration;
	models?: FauxModelDefinition[];
	settings?: Partial<Settings>;
	tools?: AgentTool[];
	initialActiveToolNames?: string[];
	allowedToolNames?: string[];
	excludedToolNames?: string[];
	resourceLoader?: ResourceLoader;
	/** Reuse a runtime across sessions to test host-level isolation. */
	modelRuntime?: ModelRuntime;
	extensionFactories?: Parameters<typeof createTestExtensionsResult>[0];
	withConfiguredAuth?: boolean;
	/** Route agent requests through ModelRuntime rather than the faux provider directly. */
	useModelRuntimeStream?: boolean;
	modelsJson?: Record<string, unknown>;
	/** Session to continue, for example to test a resume. Default: a new in-memory session. */
	sessionManager?: SessionManager;
	/** Startup reason supplied by an enclosing session runtime. */
	sessionStartEvent?: SessionStartEvent;
	/** Working directory of the session and its extensions, owned by the caller. Default: `tempDir`. */
	cwd?: string;
	/** Outer request preparation that the session composes with its own. */
	prepareRequest?: ConstructorParameters<typeof Agent>[0]["prepareRequest"];
}

export interface Harness {
	session: AgentSession;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	/** In-memory credential store behind the model runtime (the fork export called this `authStorage`). */
	credentials: InMemoryCredentialStore;
	faux: FauxProviderRegistration;
	models: [Model<string>, ...Model<string>[]];
	getModel(): Model<string>;
	getModel(modelId: string): Model<string> | undefined;
	setResponses: (responses: FauxResponseStep[]) => void;
	appendResponses: (responses: FauxResponseStep[]) => void;
	getPendingResponseCount: () => number;
	events: AgentSessionEvent[];
	eventsOfType<T extends AgentSessionEvent["type"]>(type: T): Extract<AgentSessionEvent, { type: T }>[];
	/** The session's working directory: `options.cwd`, else `tempDir`. */
	cwd: string;
	/** Scratch directory the harness creates and `cleanup` removes. */
	tempDir: string;
	cleanup: () => void;
}

function createTempDir(): string {
	const tempDir = join(tmpdir(), `pi-suite-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });
	return tempDir;
}

/**
 * A function that re-registers `fauxProvider`'s transport after a session reload reset the API
 * registry; one per registration. The owner's `unregister` also drops the restored source.
 */
function restorerFor(fauxProvider: FauxProviderRegistration): () => void {
	const existing = fauxRegistrations.get(fauxProvider);
	if (existing) return existing;
	const provider = getApiProvider(fauxProvider.api);
	if (!provider) throw new Error(`Faux transport missing: ${fauxProvider.api}`);
	const sourceId = `harness-faux-${randomUUID()}`;
	const restore = () => registerApiProvider(provider, sourceId);
	// pi-ai does not expose the original source ID. Extend the owner's unregister callback
	// to remove restored registrations too; borrowed harnesses never invoke it on cleanup.
	const unregister = fauxProvider.unregister;
	fauxProvider.unregister = () => {
		unregisterApiProviders(sourceId);
		unregister();
	};
	fauxRegistrations.set(fauxProvider, restore);
	return restore;
}

/**
 * Build a real `AgentSession` around a scripted faux provider.
 *
 * Parameters:
 *   options (HarnessOptions): see each field.
 *
 * Returns:
 *   Promise<Harness>: the session, its scripted provider and a `cleanup` the caller must run.
 */
export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
	const tempDir = createTempDir();
	const cwd = options.cwd ?? tempDir;
	const fauxProvider: FauxProviderRegistration =
		options.fauxProvider ?? registerFauxProvider({ models: options.models });
	if (!options.fauxProvider) fauxProvider.setResponses([]);
	const restoreFauxProvider = restorerFor(fauxProvider);
	const model = fauxProvider.getModel();
	const toolMap = options.tools ? Object.fromEntries(options.tools.map((tool) => [tool.name, tool])) : undefined;
	const withConfiguredAuth = options.withConfiguredAuth ?? true;
	const extensionRunnerRef: { current?: ExtensionRunner } = {};
	// `AgentSession`'s constructor installs the runner and no agent hook fires before it returns.
	const runner = () => extensionRunnerRef.current as ExtensionRunner;

	const sessionManager = options.sessionManager ?? SessionManager.inMemory(cwd);
	const settingsManager = SettingsManager.inMemory(options.settings);

	const credentials = new InMemoryCredentialStore();
	if (withConfiguredAuth) {
		await credentials.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
	}
	const modelsPath = options.modelsJson === undefined ? null : join(tempDir, "models.json");
	if (modelsPath) writeFileSync(modelsPath, JSON.stringify(options.modelsJson));
	// An in-memory catalog store keeps file-backed catalog locks out of unit tests.
	const createdRuntime = await ModelRuntime.create({
		credentials,
		modelsPath,
		modelsStore: new InMemoryModelsStore(),
		allowModelNetwork: false,
	});
	if (withConfiguredAuth) {
		createdRuntime.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			apiKey: "faux-key",
			api: fauxProvider.api,
			models: fauxProvider.models.map((registeredModel) => ({
				id: registeredModel.id,
				name: registeredModel.name,
				api: registeredModel.api,
				reasoning: registeredModel.reasoning,
				input: registeredModel.input,
				inputLimits: registeredModel.inputLimits,
				cost: registeredModel.cost,
				contextWindow: registeredModel.contextWindow,
				maxTokens: registeredModel.maxTokens,
				baseUrl: registeredModel.baseUrl,
			})),
		});
	}

	const modelRuntime = options.modelRuntime ?? createdRuntime;
	const agent = new Agent({
		getApiKey: () => (withConfiguredAuth ? "faux-key" : undefined),
		streamFn: options.useModelRuntimeStream
			? (requestModel, context, requestOptions) => modelRuntime.streamSimple(requestModel, context, requestOptions)
			: streamSimple,
		initialState: { model, systemPrompt: "", tools: [] },
		convertToLlm,
		prepareRequest: options.prepareRequest,
		onPayload: async (payload) => {
			if (!runner().hasHandlers("before_provider_request")) return payload;
			return runner().emitBeforeProviderRequest(payload);
		},
		onResponse: async (response) => {
			if (!runner().hasHandlers("after_provider_response")) return;
			await runner().emit({
				type: "after_provider_response",
				status: response.status,
				headers: response.headers,
			});
		},
		transformContext: async (messages: AgentMessage[]) => runner().emitContext(messages),
	});
	const extensionsResult = options.extensionFactories
		? await createTestExtensionsResult(options.extensionFactories, cwd)
		: undefined;
	const resourceLoader =
		options.resourceLoader ??
		createTestResourceLoader({
			extensionsResult,
			reloadExtensions: async () => {
				// AgentSession.reload resets API providers before reloading extension resources.
				restoreFauxProvider();
				return createTestExtensionsResult(options.extensionFactories ?? [], cwd);
			},
		});

	const session = new AgentSession({
		agent,
		sessionManager,
		sessionStartEvent: options.sessionStartEvent,
		settingsManager,
		cwd,
		modelRuntime,
		resourceLoader,
		baseToolsOverride: toolMap,
		initialActiveToolNames: options.initialActiveToolNames,
		usesDefaultTools: options.initialActiveToolNames === undefined,
		allowedToolNames: options.allowedToolNames,
		excludedToolNames: options.excludedToolNames,
		extensionRunnerRef,
	});

	const events: AgentSessionEvent[] = [];
	session.subscribe((event) => {
		events.push(event);
	});

	return {
		session,
		sessionManager,
		settingsManager,
		credentials,
		faux: fauxProvider,
		models: fauxProvider.models,
		getModel: fauxProvider.getModel,
		setResponses: fauxProvider.setResponses,
		appendResponses: fauxProvider.appendResponses,
		getPendingResponseCount: fauxProvider.getPendingResponseCount,
		events,
		eventsOfType<T extends AgentSessionEvent["type"]>(type: T) {
			return events.filter((event): event is Extract<AgentSessionEvent, { type: T }> => event.type === type);
		},
		cwd,
		tempDir,
		cleanup() {
			session.dispose();
			if (!options.fauxProvider) fauxProvider.unregister();
			if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
		},
	};
}
