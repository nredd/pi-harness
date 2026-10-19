/** Real multi-extension sessions, with one host identity shared by every fork. */
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

/** Same bound as harness/power.py `STOP_TIMEOUT_S`. */
const WAKE_STOP_TIMEOUT_MS = 5_000;
/** Captured at import so a test that patches global timers cannot unbound teardown. */
const nativeSetTimeout = globalThis.setTimeout;

/**
 * Wait for `child` to exit, at most `ms`.
 *
 * Parameters:
 *   child (ChildProcess): process already signalled.
 *   ms (number): bound in milliseconds.
 *
 * Returns:
 *   Promise<boolean>: true when it exited within the bound.
 */
async function exitedWithin(child: ChildProcess, ms: number): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<false>((resolve) => {
		timer = nativeSetTimeout(() => resolve(false), ms);
	});
	try {
		return await Promise.race([once(child, "exit").then(() => true as const), timeout]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Release the wake helper like harness/power.py: SIGTERM, bounded wait, then SIGKILL and one
 * more bounded wait.
 *
 * Parameters:
 *   wake (ChildProcess): the `caffeinate` helper.
 *
 * Raises:
 *   Error: the helper survived SIGKILL past the bound.
 */
async function stopWake(wake: ChildProcess): Promise<void> {
	if (wake.exitCode !== null || wake.signalCode !== null) return;
	wake.kill("SIGTERM");
	if (await exitedWithin(wake, WAKE_STOP_TIMEOUT_MS)) return;
	wake.kill("SIGKILL");
	if (!(await exitedWithin(wake, WAKE_STOP_TIMEOUT_MS)))
		throw new Error(`caffeinate ${wake.pid} survived SIGKILL for ${WAKE_STOP_TIMEOUT_MS} ms`);
}

/**
 * Isolate Pi and peers before imports. macOS holds the same process-scoped wake
 * assertions as harness/power.py: idle-only `-i` cannot prevent maintenance sleep.
 * `-w` releases assertions if the runner is killed before cleanup.
 */
export async function isolateStackHome(): Promise<{ root: string; cleanup(): Promise<void> }> {
	const root = mkdtempSync(join(tmpdir(), "pi-stack-"));
	const wake =
		process.platform === "darwin"
			? spawn("/usr/bin/caffeinate", ["-disu", "-w", String(process.pid)], { stdio: "ignore" })
			: undefined;
	if (wake) {
		try {
			await once(wake, "spawn");
		} catch (error) {
			rmSync(root, { recursive: true, force: true });
			throw new Error("Cannot hold macOS wake assertions for stack tests", { cause: error });
		}
	}
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
		async cleanup() {
			try {
				for (const [key, value] of previous) {
					if (value === undefined) delete process.env[key];
					else process.env[key] = value;
				}
				rmSync(root, { recursive: true, force: true });
			} finally {
				if (wake) await stopWake(wake);
			}
		},
	};
}

/**
 * Keep the real web/memory entries inert before either parent imports or child discovery.
 * Web 0.36.0 registers locally; session_start only resets/restores local caches. Eager
 * activation preserves every registered schema, cookies/browser UI are disabled, and
 * tests never execute its network tools (a fetch spy in specialists.test.ts enforces this).
 * PI_CODING_AGENT_DIR comes from isolateStackHome; the cache override also stays temporary.
 * Memory 0.4.2 reads PI_MEMORY_DIR at import. Updates/search/exit summaries are disabled,
 * but session_start STILL probes qmd. A first-on-PATH failing executable replaces that
 * external dependency for both parent and child loaders, with a log proving it was used.
 */
export function isolateResearchPackages(root: string): () => void {
	const bin = join(root, "bin");
	const memory = join(root, "memory");
	mkdirSync(bin, { recursive: true });
	mkdirSync(memory, { recursive: true });
	mkdirSync(join(root, "agent"), { recursive: true });
	writeFileSync(join(bin, "qmd"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$PI_MEMORY_DIR/qmd-calls"\nexit 1\n', {
		mode: 0o700,
	});
	writeFileSync(
		join(root, "agent/web-search.json"),
		JSON.stringify({ toolActivation: "eager", allowBrowserCookies: false, autoOpenBrowser: false }),
	);
	const previous = new Map<string, string | undefined>();
	for (const [key, value] of Object.entries({
		PATH: `${bin}:${process.env.PATH ?? ""}`,
		PI_MEMORY_DIR: memory,
		PI_MEMORY_QMD_UPDATE: "off",
		PI_MEMORY_NO_SEARCH: "1",
		PI_MEMORY_SNAPSHOT: "stable",
		PI_MEMORY_EXIT_SUMMARY: "0",
		PI_ALLOW_BROWSER_COOKIES: "0",
		FEYNMAN_ALLOW_BROWSER_COOKIES: "0",
		PI_WEB_ACCESS_CACHE_ROOT: join(root, "web-cache"),
	})) {
		previous.set(key, process.env[key]);
		process.env[key] = value;
	}
	return () => {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
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
export async function loadThirdParty(name: "workflow" | "deferred" | "web" | "memory"): Promise<ExtensionFactory> {
	const entries = {
		workflow: () => new URL("../extensions/workflow.ts", import.meta.resolve("@quintinshaw/pi-dynamic-workflows")),
		deferred: () => new URL(import.meta.resolve("pi-deferred-context-engine")),
		web: () => new URL("dist/index.js", import.meta.resolve("pi-web-access/package.json")),
		memory: () => new URL(import.meta.resolve("pi-memory")),
	};
	return loadFactory(entries[name]());
}

export interface StackOptions {
	cwd?: string;
	factories: ExtensionFactory[];
	settings?: HarnessOptions["settings"];
	useModelRuntimeStream?: boolean;
	withConfiguredAuth?: boolean;
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
