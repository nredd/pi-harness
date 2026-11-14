/** Resource loading for in-process tests: extensions from factories, no filesystem discovery. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	createExtensionRuntime,
	createSyntheticSourceInfo,
	DefaultResourceLoader,
	type Extension,
	type ExtensionFactory,
	type ExtensionRuntime,
	type InlineExtension,
	type LoadExtensionsResult,
	type RegisteredMcpServer,
	type ResourceLoader,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

/** A factory with the path it reports as its source, e.g. a package entry. */
export interface CreateTestExtensionsResultInput {
	factory: ExtensionFactory;
	path?: string;
}

type TestExtensionInput = InlineExtension | CreateTestExtensionsResultInput;

/** Extension identity the loader derives for input `index`, or the caller's `path` override. */
interface Resolved {
	name: string;
	factory: ExtensionFactory;
	path?: string;
}

/** Normalise `input` so the real loader names it exactly as the fork harness did. */
function resolve(input: TestExtensionInput, index: number): Resolved {
	if (typeof input === "function") return { name: String(index + 1), factory: input };
	if ("name" in input) return { name: input.name, factory: input.factory };
	// A path input is renamed afterwards; its temporary name must not collide with another input's.
	const path = input.path || undefined;
	return { name: path === undefined ? String(index + 1) : `${index + 1}\0path`, factory: input.factory, path };
}

/** A registration queued during loading, owned by the extension whose path it names. */
type Pending = { extensionPath: string };

/** Everything an extension registered under its loading identity, snapshotted before repointing. */
interface Owned {
	pending: Pending[];
	servers: RegisteredMcpServer[];
}

/**
 * Report `extension` as loaded from `path`, as the fork's loader did, including everything its
 * factory already registered under the inline name, MCP servers included.
 */
function repoint(extension: Extension, owned: Owned, path: string, runtime: ExtensionRuntime): void {
	const sourceInfo = createSyntheticSourceInfo(path, { source: "local", baseDir: dirname(path) });
	extension.path = path;
	extension.resolvedPath = path;
	extension.sourceInfo = sourceInfo;
	for (const tool of extension.tools.values()) tool.sourceInfo = sourceInfo;
	for (const command of extension.commands.values()) command.sourceInfo = sourceInfo;
	for (const owned of [...extension.flags.values(), ...extension.shortcuts.values()]) owned.extensionPath = path;
	for (const registration of owned.pending) registration.extensionPath = path;
	// `register()` replaces in place, so registration order is kept.
	for (const server of owned.servers) runtime.mcpServers.register({ ...server, extensionPath: path });
}

/**
 * Load `inputs` through the real extension loader, sharing one runtime and event bus.
 *
 * Parameters:
 *   inputs (TestExtensionInput[]): factories, named inline extensions or `{ factory, path }`.
 *   cwd (string): working directory the extensions see.
 *
 * Returns:
 *   Promise<LoadExtensionsResult>: the loaded extensions. A factory that throws rejects with its
 *   own error, never an entry in `errors`.
 */
export async function createTestExtensionsResult(
	inputs: TestExtensionInput[],
	cwd = process.cwd(),
): Promise<LoadExtensionsResult> {
	const resolved = inputs.map(resolve);
	// Path inputs load under a temporary name that no other input may share.
	const taken = new Set(resolved.filter(({ path }) => path === undefined).map(({ name }) => name));
	for (const input of resolved.filter(({ path }) => path !== undefined)) {
		while (taken.has(input.name)) input.name += "\0";
		taken.add(input.name);
	}
	const thrown: unknown[] = [];
	const agentDir = mkdtempSync(join(tmpdir(), "pi-test-resources-"));
	try {
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager: SettingsManager.inMemory(),
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			extensionFactories: resolved.map(({ name, factory }) => ({
				name,
				factory: async (pi) => {
					// Like the fork, stop at the first failure: later factories never run.
					if (thrown.length > 0) return;
					try {
						await factory(pi);
					} catch (error) {
						thrown.push(error);
						throw error;
					}
				},
			})),
		});
		await loader.reload();
		if (thrown.length > 0) throw thrown[0];
		const result = loader.getExtensions();
		// Snapshot ownership first: a final path may equal another input's temporary name.
		const queued: Pending[] = [
			...result.runtime.pendingProviderRegistrations,
			...result.runtime.pendingNativeProviderRegistrations,
			...result.runtime.pendingVirtualModelRegistrations,
		];
		const servers = result.runtime.mcpServers.list();
		const owned = result.extensions.map((extension) => ({
			extension,
			pending: queued.filter((entry) => entry.extensionPath === extension.path),
			servers: servers.filter((server) => server.extensionPath === extension.path),
		}));
		for (const [index, { extension, ...mine }] of owned.entries()) {
			const path = resolved[index]?.path;
			if (path !== undefined) repoint(extension, mine, path, result.runtime);
		}
		return result;
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
}

export interface CreateTestResourceLoaderOptions {
	extensionsResult?: LoadExtensionsResult;
	/** Recreate factories during the real session reload lifecycle. */
	reloadExtensions?: () => Promise<LoadExtensionsResult>;
}

/** A resource loader with the given extensions and no skills, prompts, themes, or context files. */
export function createTestResourceLoader(options: CreateTestResourceLoaderOptions = {}): ResourceLoader {
	let extensionsResult = options.extensionsResult ?? {
		extensions: [],
		errors: [],
		runtime: createExtensionRuntime(),
	};

	return {
		getExtensions: () => extensionsResult,
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => undefined,
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: () => {},
		reload: async () => {
			if (options.reloadExtensions) extensionsResult = await options.reloadExtensions();
		},
	};
}
