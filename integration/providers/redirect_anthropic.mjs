// Harness-only runtime hook: Node `--import` or compiled Bun `BUN_OPTIONS --preload`.
//
// Redirects every `fetch` aimed at an Anthropic API or OAuth host to the local mock in
// `HARNESS_ANTHROPIC_MOCK`, keeping path and query, so no fake credential ever leaves the machine
// and the token endpoint can be scripted. It is inherited by child Node/Bun processes through
// `NODE_OPTIONS` / `BUN_OPTIONS`, including subprocess refreshes.
//
// It also BLOCKS and records node `child_process` calls that launch `claude` or `security` (the
// macOS keychain tool, absolute path included, which a PATH shim cannot stop). Only those two
// binaries are touched; every other subprocess runs normally. Node and direct Bun spawn APIs are
// covered; native addons, shell pipelines and other networking APIs are NOT sandboxed.
import { appendFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { basename } from "node:path";

const mock = process.env.HARNESS_ANTHROPIC_MOCK;
const nonce = process.env.HARNESS_AUTH_NONCE;
if (!mock || !nonce) throw new Error("redirect_anthropic.mjs needs HARNESS_ANTHROPIC_MOCK and HARNESS_AUTH_NONCE");
const endpoint = new URL(mock);
if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || endpoint.origin !== mock) {
	throw new Error("Auth transport requires an exact http://127.0.0.1 loopback origin");
}

const REDIRECTED_HOSTS = new Set(["api.anthropic.com", "console.anthropic.com", "platform.claude.com", "claude.ai"]);
let innerFetch = globalThis.fetch;

const redirecting = (input, init) => {
	const raw = input instanceof Request ? input.url : String(input);
	const url = new URL(raw);
	if (!REDIRECTED_HOSTS.has(url.hostname)) {
		if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.hostname !== "[::1]") {
			throw new Error(`harness refused non-loopback fetch: ${url.origin}`);
		}
		return innerFetch(input, { ...init, redirect: "error" });
	}
	const target = new URL(mock);
	target.pathname = url.pathname;
	target.search = url.search;
	return innerFetch(input instanceof Request ? new Request(target, input) : target, { ...init, redirect: "error" });
};

// pi installs undici's fetch over `globalThis.fetch` at startup. An accessor keeps the redirect in
// front of whatever it installs: later assignments replace the inner fetch, never the redirect.
Object.defineProperty(globalThis, "fetch", {
	configurable: true,
	enumerable: true,
	get: () => redirecting,
	set: (next) => {
		innerFetch = next;
	},
});

const FORBIDDEN = new Set(["claude", "security"]);
const blockedLog = process.env.HARNESS_BLOCKED_LOG;
const childProcess = createRequire(import.meta.url)("node:child_process");

const forbiddenName = (file) => {
	const first =
		String(file ?? "")
			.trim()
			.split(/\s+/)[0] ?? "";
	return FORBIDDEN.has(basename(first)) ? basename(first) : undefined;
};

for (const fn of ["exec", "execSync", "execFile", "execFileSync", "spawn", "spawnSync"]) {
	const original = childProcess[fn];
	childProcess[fn] = function (file, ...rest) {
		const name = forbiddenName(file);
		if (!name) return original.call(this, file, ...rest);
		if (blockedLog) appendFileSync(blockedLog, `${name} ${String(file)} (${fn})\n`);
		throw new Error(`harness blocked \`${name}\` via child_process.${fn}`);
	};
}
syncBuiltinESMExports();
// Bun's native spawn API does not pass through node:child_process.
if (globalThis.Bun) {
	for (const fn of ["spawn", "spawnSync"]) {
		const original = Bun[fn];
		Bun[fn] = function (command, ...rest) {
			const argv = Array.isArray(command) ? command : command?.cmd;
			const file = argv?.[0];
			const name = forbiddenName(file);
			if (!name) return original.call(this, command, ...rest);
			if (blockedLog) appendFileSync(blockedLog, `${name} ${String(file)} (Bun.${fn})\n`);
			throw new Error(`harness blocked \`${name}\` via Bun.${fn}`);
		};
	}
}
Object.defineProperty(globalThis, Symbol.for("pi-harness.auth-redirect"), {
	value: { mock, nonce },
	writable: false,
	configurable: false,
});
