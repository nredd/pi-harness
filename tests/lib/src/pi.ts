/**
 * Recording doubles for pi's `ExtensionAPI` and `ExtensionContext`, for tests that load an
 * extension factory directly instead of booting a real host (use `harness.ts` for that).
 *
 * Typed against the public SDK types only, derived through indexed access so the module keeps
 * compiling when a release adds or reshapes members. The host contract mirrored here:
 * - `on` appends: a handler registered twice for one event is recorded twice, in order, and the
 *   returned function unsubscribes just that one
 * - `registerTool` with a duplicate name replaces the earlier tool (a `Map.set`, as in the loader)
 * - `getFlag` is `undefined` until `registerFlag` runs, then the seeded value, then the default
 * - `events` is a working bus whose handlers cannot interrupt their siblings
 */

import type {
	EntryRenderer,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionToolContext,
	ExtensionUIContext,
	MessageRenderer,
	RegisteredCommand,
	SessionEntry,
	SlashCommandInfo,
	ToolDefinition,
	ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";

type ShortcutOptions = Parameters<ExtensionAPI["registerShortcut"]>[1];
type FlagOptions = Parameters<ExtensionAPI["registerFlag"]>[1];
type ProviderConfig = Parameters<ExtensionAPI["registerProvider"]>[1];
type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;
type Model = Parameters<ExtensionAPI["setModel"]>[0];
type ExecResult = Awaited<ReturnType<ExtensionAPI["exec"]>>;
type Settings = ReturnType<ExtensionAPI["getSettings"]>;
type ModelRegistry = ExtensionContext["modelRegistry"];
type SessionManager = ExtensionContext["sessionManager"];

/** A handler as stored: one signature for every event, so a test can call it without casts. */
export type RecordedHandler = (event: unknown, ctx: ExtensionContext) => unknown;

/** What `registerShortcut` captured, keyed by key id. */
export type RecordedShortcut = ShortcutOptions;

export interface RecordingPiOptions {
	/** Names `getActiveTools` starts with. */
	activeTools?: string[];
	/**
	 * Add a tool to the active set when it is registered (a hidden tool is removed from it instead). Default true,
	 * as for a freshly loaded extension tool. Plan-style tests that manage the set themselves pass
	 * false.
	 */
	autoActivate?: boolean;
	/** Tool infos `getAllTools` returns. Mutate `RecordingPi.allTools` to change it later. */
	allTools?: ToolInfo[];
	/** Skill names surfaced from `getCommands` as `skill:<name>` entries. */
	skills?: readonly string[];
	/** Commands `getCommands` returns, after the skills. */
	commands?: SlashCommandInfo[];
	/**
	 * Flag values the host applies *after* activation (CLI values). Kept apart from `registerFlag`
	 * on purpose: a test seeds them here and reads them from `session_start`, the real ordering.
	 */
	flags?: Record<string, boolean | string>;
	/**
	 * Deliver `events.emit` payloads to the subscribers. Default true, as on pi's bus. Pass false to
	 * only record them, for a test that feeds subscribers by hand and must not hear the extension's
	 * own emits.
	 */
	deliverEvents?: boolean;
	thinkingLevel?: ThinkingLevel;
	/** Maps a requested level to the one the model supports. */
	clampThinkingLevel?: (level: ThinkingLevel) => ThinkingLevel;
	sessionName?: string;
	settings?: Settings;
	/** What `exec` resolves with. Default: empty stdout and stderr, exit 0. */
	execResult?: ExecResult;
	/** Replace any API method, e.g. `{ getCommands: () => [...] }`. */
	overrides?: Partial<ExtensionAPI>;
}

/** An event bus that records what was emitted and keeps the handlers of one emit independent. */
export interface RecordingBus {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => unknown): () => void;
	clear(): void;
	/** Live subscriptions by channel, in subscription order. */
	readonly subscribers: Map<string, ((data: unknown) => unknown)[]>;
	/** Every payload emitted, by channel, in order. */
	readonly emitted: Map<string, unknown[]>;
	/** Live subscriptions across all channels. */
	listenerCount(): number;
}

export interface RecordingPi {
	pi: ExtensionAPI;
	tools: Map<string, ToolDefinition>;
	commands: Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>;
	shortcuts: Map<string, RecordedShortcut>;
	/** Options each flag was registered with. */
	flags: Map<string, FlagOptions>;
	/** Handlers by event, in registration order. */
	handlers: Map<string, RecordedHandler[]>;
	messageRenderers: Map<string, MessageRenderer>;
	entryRenderers: Map<string, EntryRenderer>;
	/** Effective provider config by name; a later registration merges over an earlier one. */
	providers: Map<string, ProviderConfig>;
	providerRegistrations: { name: string; config: ProviderConfig }[];
	providerUnregistrations: string[];
	/** `appendEntry` calls, in order. */
	entries: { customType: string; data: unknown }[];
	/** `sendUserMessage` calls, in order. */
	sentUserMessages: { content: Parameters<ExtensionAPI["sendUserMessage"]>[0]; options?: unknown }[];
	/** `sendMessage` calls, in order. */
	sentMessages: { message: Parameters<ExtensionAPI["sendMessage"]>[0]; options?: unknown }[];
	/** Models passed to `setModel`, in order. */
	setModels: Model[];
	/** Levels `setThinkingLevel` settled on, in order. */
	thinkingLevels: ThinkingLevel[];
	/** Mutable: change what `getAllTools` returns. */
	allTools: ToolInfo[];
	bus: RecordingBus;
	readonly activeTools: string[];
	readonly thinkingLevel: ThinkingLevel;
	readonly sessionName: string | undefined;
	/** Set the active tools directly, as the host does outside `setActiveTools`. */
	setActive(names: string[]): void;
	/**
	 * Run every handler of `event` in order, awaiting each, and return the results in order.
	 * Folding results into later events is event-specific, so that stays with the caller.
	 */
	dispatch(event: string, payload: unknown, ctx: ExtensionContext): Promise<unknown[]>;
}

function createBus(deliver: boolean): RecordingBus {
	const subscriptions = new Map<string, ((data: unknown) => unknown)[]>();
	const emitted = new Map<string, unknown[]>();
	return {
		emitted,
		subscribers: subscriptions,
		emit: vi.fn((channel: string, data: unknown) => {
			emitted.set(channel, [...(emitted.get(channel) ?? []), data]);
			if (!deliver) return;
			for (const handler of [...(subscriptions.get(channel) ?? [])]) {
				try {
					void Promise.resolve(handler(data)).catch(() => undefined);
				} catch {
					// Match pi's bus: one observer cannot interrupt its siblings.
				}
			}
		}),
		on: vi.fn((channel: string, handler: (data: unknown) => unknown) => {
			subscriptions.set(channel, [...(subscriptions.get(channel) ?? []), handler]);
			return () => {
				const current = subscriptions.get(channel) ?? [];
				const index = current.indexOf(handler);
				if (index >= 0)
					subscriptions.set(
						channel,
						current.filter((_, at) => at !== index),
					);
			};
		}),
		clear() {
			subscriptions.clear();
		},
		listenerCount() {
			return [...subscriptions.values()].reduce((count, list) => count + list.length, 0);
		},
	};
}

function mergeProviderConfig(previous: ProviderConfig | undefined, next: ProviderConfig): ProviderConfig {
	return previous && typeof previous === "object" && typeof next === "object" ? { ...previous, ...next } : next;
}

/** A recording `ExtensionAPI`. Every method is a `vi.fn`, so call assertions work as well. */
export function createRecordingPi(options: RecordingPiOptions = {}): RecordingPi {
	const tools = new Map<string, ToolDefinition>();
	const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
	const shortcuts = new Map<string, RecordedShortcut>();
	const flags = new Map<string, FlagOptions>();
	const handlers = new Map<string, RecordedHandler[]>();
	const messageRenderers = new Map<string, MessageRenderer>();
	const entryRenderers = new Map<string, EntryRenderer>();
	const providers = new Map<string, ProviderConfig>();
	const providerRegistrations: RecordingPi["providerRegistrations"] = [];
	const providerUnregistrations: string[] = [];
	const entries: RecordingPi["entries"] = [];
	const sentUserMessages: RecordingPi["sentUserMessages"] = [];
	const sentMessages: RecordingPi["sentMessages"] = [];
	const setModels: Model[] = [];
	const thinkingLevels: ThinkingLevel[] = [];
	const bus = createBus(options.deliverEvents ?? true);
	const autoActivate = options.autoActivate ?? true;
	const skillCommands = (options.skills ?? []).map(
		(name) =>
			({
				name: `skill:${name}`,
				source: "skill",
				sourceInfo: { path: `/mock/skills/${name}/SKILL.md`, baseDir: `/mock/skills/${name}` },
			}) as unknown as SlashCommandInfo,
	);
	let activeTools = [...(options.activeTools ?? [])];
	let thinkingLevel: ThinkingLevel = options.thinkingLevel ?? "off";
	let sessionName = options.sessionName;
	const allTools: ToolInfo[] = options.allTools ?? [];
	const execResult: ExecResult = options.execResult ?? { stdout: "", stderr: "", code: 0, killed: false };

	const methods = {
		on: vi.fn((event: string, handler: RecordedHandler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			return () => {
				const current = handlers.get(event) ?? [];
				const index = current.indexOf(handler);
				if (index < 0) return;
				if (current.length === 1) handlers.delete(event);
				else
					handlers.set(
						event,
						current.filter((_, at) => at !== index),
					);
			};
		}),
		registerTool: vi.fn((tool: ToolDefinition) => {
			tools.set(tool.name, tool);
			if ((tool as { exposure?: string }).exposure === "hidden") {
				activeTools = activeTools.filter((name) => name !== tool.name);
			} else if (autoActivate && !activeTools.includes(tool.name)) {
				activeTools = [...activeTools, tool.name];
			}
		}),
		registerCommand: vi.fn((name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
			commands.set(name, command);
		}),
		registerShortcut: vi.fn((shortcut: string, shortcutOptions: RecordedShortcut) => {
			shortcuts.set(shortcut, shortcutOptions);
		}),
		registerFlag: vi.fn((name: string, flagOptions: FlagOptions) => {
			flags.set(name, flagOptions);
		}),
		getFlag: vi.fn((name: string) => {
			if (!flags.has(name)) return undefined;
			return options.flags && name in options.flags ? options.flags[name] : flags.get(name)?.default;
		}),
		registerMessageRenderer: vi.fn((customType: string, renderer: MessageRenderer) => {
			messageRenderers.set(customType, renderer);
		}),
		registerEntryRenderer: vi.fn((customType: string, renderer: EntryRenderer) => {
			entryRenderers.set(customType, renderer);
		}),
		registerProvider: vi.fn((name: string, config: ProviderConfig) => {
			providers.set(name, mergeProviderConfig(providers.get(name), config));
			providerRegistrations.push({ name, config });
		}),
		unregisterProvider: vi.fn((name: string) => {
			providers.delete(name);
			providerUnregistrations.push(name);
		}),
		appendEntry: vi.fn((customType: string, data?: unknown) => {
			entries.push({ customType, data });
		}),
		sendMessage: vi.fn((message: RecordingPi["sentMessages"][number]["message"], messageOptions?: unknown) => {
			sentMessages.push({ message, options: messageOptions });
		}),
		sendUserMessage: vi.fn((content: RecordingPi["sentUserMessages"][number]["content"], messageOptions?: unknown) => {
			sentUserMessages.push({ content, options: messageOptions });
		}),
		setSessionName: vi.fn((name: string) => {
			sessionName = name;
		}),
		getSessionName: vi.fn(() => sessionName),
		exec: vi.fn(async () => execResult),
		getActiveTools: vi.fn(() => [...activeTools]),
		setActiveTools: vi.fn((names: string[]) => {
			activeTools = names.filter(
				(name) => (tools.get(name) as { exposure?: string } | undefined)?.exposure !== "hidden",
			);
		}),
		getAllTools: vi.fn(() => [...allTools]),
		getCommands: vi.fn(() => [...skillCommands, ...(options.commands ?? [])]),
		getSettings: vi.fn(() => options.settings ?? ({} as Settings)),
		setModel: vi.fn(async (model: Model) => {
			setModels.push(model);
			return true;
		}),
		getThinkingLevel: vi.fn(() => thinkingLevel),
		setThinkingLevel: vi.fn((level: ThinkingLevel) => {
			thinkingLevel = options.clampThinkingLevel?.(level) ?? level;
			thinkingLevels.push(thinkingLevel);
		}),
		events: bus,
		...options.overrides,
	};

	return {
		pi: methods as unknown as ExtensionAPI,
		tools,
		commands,
		shortcuts,
		flags,
		handlers,
		messageRenderers,
		entryRenderers,
		providers,
		providerRegistrations,
		providerUnregistrations,
		entries,
		sentUserMessages,
		sentMessages,
		setModels,
		thinkingLevels,
		allTools,
		bus,
		get activeTools() {
			return [...activeTools];
		},
		get thinkingLevel() {
			return thinkingLevel;
		},
		get sessionName() {
			return sessionName;
		},
		setActive(names) {
			activeTools = [...names];
		},
		async dispatch(event, payload, ctx) {
			const results: unknown[] = [];
			for (const handler of [...(handlers.get(event) ?? [])]) results.push(await handler(payload, ctx));
			return results;
		},
	};
}

type Ui = ExtensionUIContext;

export interface RecordingContextOptions {
	cwd?: string;
	hasUI?: boolean;
	/** Default `"tui"` when `hasUI`, else `"print"`. */
	mode?: ExtensionContext["mode"];
	model?: ExtensionContext["model"];
	/** Entries `sessionManager.getBranch()` and `getEntries()` return. */
	branch?: SessionEntry[];
	sessionId?: string;
	sessionName?: string;
	/** Models `modelRegistry.getAvailable()` / `getAll()` return. */
	models?: ReturnType<ModelRegistry["getAvailable"]>;
	/** Initial editor text. */
	editorText?: string;
	idle?: boolean;
	pending?: boolean;
	trusted?: boolean;
	systemPrompt?: string;
	/** Replace individual UI members. */
	ui?: Partial<Ui>;
	/** Replace or extend the session manager. */
	sessionManager?: Partial<SessionManager>;
	/** Replace or extend the model registry. */
	modelRegistry?: Partial<ModelRegistry>;
	/** Replace any other context member, e.g. `{ getContextUsage: () => ... }`. */
	overrides?: Partial<RecordedContext>;
}

/**
 * What a tool's `execute` and a command's handler each receive, in one object. The session
 * replacement members of the command context (`newSession`, `fork`, `navigateTree`,
 * `switchSession`, `getSystemPromptOptions`) are absent unless a test passes them in
 * `overrides`: extensions feature-detect them, and a stub would change which path they take.
 */
export type RecordedContext = ExtensionToolContext & ExtensionCommandContext;

export interface RecordingContext {
	ctx: RecordedContext;
	/** `ui.notify` calls, in order. */
	notifications: { message: string; level?: string }[];
	/** Last value per `ui.setStatus` key; `undefined` is a clear. */
	statuses: Map<string, string | undefined>;
	widgets: Map<string, unknown>;
	pastedEditorTexts: string[];
	readonly footer: unknown;
	readonly editorText: string;
	/** Flip what `isIdle()` / `hasPendingMessages()` report. */
	setIdle(idle: boolean): void;
	setPending(pending: boolean): void;
}

/** A recording context: an `ExtensionToolContext` that is also an `ExtensionCommandContext`. */
export function createRecordingContext(options: RecordingContextOptions = {}): RecordingContext {
	const notifications: RecordingContext["notifications"] = [];
	const statuses = new Map<string, string | undefined>();
	const widgets = new Map<string, unknown>();
	const pastedEditorTexts: string[] = [];
	let footer: unknown;
	let editorText = options.editorText ?? "";
	let idle = options.idle ?? true;
	let pending = options.pending ?? false;
	const branch = options.branch ?? [];
	const models = options.models ?? [];
	const hasUI = options.hasUI ?? (options.mode === "tui" || options.mode === "rpc");

	const ui = {
		theme: { fg: (_role: string, text: string) => text },
		notify: vi.fn((message: string, level?: string) => {
			notifications.push({ message, level });
		}),
		setStatus: vi.fn((key: string, value: string | undefined) => {
			statuses.set(key, value);
		}),
		setWidget: vi.fn((key: string, value: unknown) => {
			widgets.set(key, value);
		}),
		setFooter: vi.fn((value: unknown) => {
			footer = value;
		}),
		setWorkingMessage: vi.fn(),
		setHiddenThinkingLabel: vi.fn(),
		onTerminalInput: vi.fn(() => () => undefined),
		addAutocompleteProvider: vi.fn(),
		setEditorComponent: vi.fn(),
		pasteToEditor: vi.fn((value: string) => {
			pastedEditorTexts.push(value);
			editorText += value;
		}),
		setEditorText: vi.fn((value: string) => {
			editorText = value;
		}),
		getEditorText: vi.fn(() => editorText),
		confirm: vi.fn(async () => true),
		input: vi.fn(async () => undefined),
		select: vi.fn(async () => undefined),
		editor: vi.fn(async () => undefined),
		custom: vi.fn(async () => undefined),
		...options.ui,
	};

	const sessionManager = {
		getBranch: vi.fn(() => branch),
		getEntries: vi.fn(() => branch),
		getLeafId: vi.fn(() => branch.at(-1)?.id ?? null),
		getSessionFile: vi.fn(() => "/tmp/test-session.jsonl"),
		getSessionId: vi.fn(() => options.sessionId ?? "test-session"),
		// pi reports an unnamed session as `undefined`
		getSessionName: vi.fn(() => options.sessionName),
		...options.sessionManager,
	};

	const modelRegistry = {
		find: vi.fn((provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id)),
		getAvailable: vi.fn(() => [...models]),
		getAll: vi.fn(() => [...models]),
		getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "test-key", headers: {} })),
		isUsingOAuth: vi.fn(() => false),
		...options.modelRegistry,
	};

	const ctx = {
		cwd: options.cwd ?? process.cwd(),
		mode: options.mode ?? (hasUI ? "tui" : "print"),
		hasUI,
		model: options.model,
		scopedModels: [],
		signal: undefined,
		ui,
		sessionManager,
		modelRegistry,
		tools: [],
		executeTool: vi.fn(),
		isIdle: vi.fn(() => idle),
		hasPendingMessages: vi.fn(() => pending),
		isProjectTrusted: vi.fn(() => options.trusted ?? false),
		abort: vi.fn(),
		shutdown: vi.fn(),
		compact: vi.fn(),
		reload: vi.fn(async () => undefined),
		waitForIdle: vi.fn(async () => undefined),
		getContextUsage: vi.fn(() => undefined),
		getSystemPrompt: vi.fn(() => options.systemPrompt ?? "parent"),
		...options.overrides,
	};

	return {
		ctx: ctx as unknown as RecordedContext,
		notifications,
		statuses,
		widgets,
		pastedEditorTexts,
		get footer() {
			return footer;
		},
		get editorText() {
			return editorText;
		},
		setIdle(value) {
			idle = value;
		},
		setPending(value) {
			pending = value;
		},
	};
}
