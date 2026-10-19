/** Real multi-extension sessions, with one host identity shared by every fork. */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionFactory, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { createHarness, type Harness, type HarnessOptions } from "@earendil-works/pi-coding-agent/testing";

const ROOT = new URL("../../", import.meta.url);
const FORK_ENTRIES = {
	"pi-plan-mode": "dist/index.ts",
	"rpiv-todo": "index.ts",
	"pi-subagents": "src/index.ts",
} as const;
const OWNED_ENTRIES = {
	"@nredd/pi-dev-tools": "dev-tools",
	"@nredd/pi-session-kit": "session-kit",
	"@nredd/pi-subscription-router": "subscription-router",
} as const;
const HOSTS = [
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
	"@earendil-works/pi-ai",
	"typebox",
] as const;

export type ForkName = keyof typeof FORK_ENTRIES;
export type OwnedName = keyof typeof OWNED_ENTRIES;

/** Isolate Pi, rpiv's XDG/legacy config and optional peers before importing any entries. */
export function isolateStackHome(): { root: string; cleanup(): void } {
	const root = mkdtempSync(join(tmpdir(), "pi-stack-"));
	const previous = new Map<string, string | undefined>();
	for (const [key, value] of Object.entries({
		HOME: root,
		PI_CODING_AGENT_DIR: join(root, "agent"),
		XDG_CONFIG_HOME: join(root, ".config"),
	})) {
		previous.set(key, process.env[key]);
		process.env[key] = value;
	}
	return {
		root,
		cleanup() {
			for (const [key, value] of previous) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			rmSync(root, { recursive: true, force: true });
		},
	};
}

/** Refuse fork-local host copies before importing any extension code. */
export function assertHostIdentity(fork: ForkName): void {
	const directory = new URL(`forks/${fork}/`, ROOT);
	const parent = new URL("package.json", directory);
	for (const name of HOSTS) {
		const remove = fileURLToPath(new URL("node_modules/", directory));
		try {
			const expected = resolveHost(name, new URL(import.meta.url));
			const actual = resolveHost(name, parent);
			if (actual !== expected) {
				throw new Error(`${name}: fork resolved '${actual}', stack resolved '${expected}'`);
			}
		} catch (error) {
			throw new Error(
				`Host identity check failed for ${fork}: ${String(error)}. Delete '${remove}' and use root npm ci.`,
				{ cause: error },
			);
		}
	}
}

/** Both runtimes must use ESM import conditions and the actual importing directory. */
function resolveHost(name: string, parent: URL): string {
	// Bun supports an explicit import.meta.resolve parent. Node requires an experimental
	// flag for that parent, but its require resolver accepts import conditions instead.
	if (process.versions.bun) return realpathSync(fileURLToPath(import.meta.resolve(name, parent.href)));
	const resolution = { paths: undefined, conditions: new Set(["node", "import"]) };
	return realpathSync(createRequire(parent).resolve(name, resolution));
}

/** Import the declared real entry, not a copy or a test implementation. */
async function loadFactory(url: URL): Promise<ExtensionFactory> {
	const loaded: unknown = await import(/* @vite-ignore */ url.href);
	if (!loaded || typeof loaded !== "object" || !("default" in loaded) || typeof loaded.default !== "function") {
		throw new Error(`Extension '${url.href}' has no default factory`);
	}
	return loaded.default as ExtensionFactory;
}

/** Load a Gitlinked fork without installing anything in its checkout. */
export async function loadFork(fork: ForkName): Promise<ExtensionFactory> {
	assertHostIdentity(fork);
	return loadFactory(new URL(`forks/${fork}/${FORK_ENTRIES[fork]}`, ROOT));
}

/** Load an owned workspace's real source entry; callers may also pass its createXxx factory directly. */
export async function loadOwned(name: OwnedName): Promise<ExtensionFactory> {
	return loadFactory(new URL(`packages/${OWNED_ENTRIES[name]}/src/index.ts`, ROOT));
}

/** Load pinned third-party manifest entries from this workspace, never the live install. */
export async function loadThirdParty(name: "workflow" | "deferred"): Promise<ExtensionFactory> {
	const entry =
		name === "workflow"
			? new URL("../extensions/workflow.ts", import.meta.resolve("@quintinshaw/pi-dynamic-workflows"))
			: new URL(import.meta.resolve("pi-deferred-context-engine"));
	return loadFactory(entry);
}

export interface StackOptions {
	cwd?: string;
	factories: ExtensionFactory[];
	settings?: HarnessOptions["settings"];
	sessionManager?: HarnessOptions["sessionManager"];
	mode?: "print" | "json" | "rpc" | "tui";
	ui?: ExtensionUIContext;
}

/** Create and bind one real session; clean up even when startup fails. */
export async function startStack({ factories, mode = "print", ui, ...options }: StackOptions): Promise<Harness> {
	const harness = await createHarness({ ...options, extensionFactories: factories });
	try {
		await harness.session.bindExtensions({ mode, uiContext: ui });
		return harness;
	} catch (error) {
		harness.cleanup();
		throw error;
	}
}
