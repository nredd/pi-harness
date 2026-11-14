/** Resource loading for in-process tests: extensions from factories, no filesystem discovery. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	createExtensionRuntime,
	createSyntheticSourceInfo,
	DefaultResourceLoader,
	type ExtensionFactory,
	type InlineExtension,
	type LoadExtensionsResult,
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
	return { name: String(index + 1), factory: input.factory, path: input.path || undefined };
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
		for (const [index, extension] of result.extensions.entries()) {
			const path = resolved[index]?.path;
			if (path === undefined) continue;
			extension.path = path;
			extension.resolvedPath = path;
			extension.sourceInfo = createSyntheticSourceInfo(path, { source: "local", baseDir: dirname(path) });
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
