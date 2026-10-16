// Node preload (`--import`) for the Anthropic auth scenarios; never installed.
//
// Redirects every `fetch` aimed at an Anthropic API or OAuth host to the local mock in
// `HARNESS_ANTHROPIC_MOCK`, keeping path and query, so no fake credential ever leaves the machine
// and the token endpoint can be scripted. It is inherited by child node processes through
// `NODE_OPTIONS`, which also covers extensions that refresh in a subprocess.
//
// It also BLOCKS and records node `child_process` calls that launch `claude` or `security` (the
// macOS keychain tool, absolute path included, which a PATH shim cannot stop). Only those two
// binaries are touched; every other subprocess runs normally. Coverage is node-level: a native
// addon or a shell pipeline spawned some other way is not seen.
import { appendFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { basename } from "node:path";

const mock = process.env.HARNESS_ANTHROPIC_MOCK;
if (!mock) throw new Error("redirect_anthropic.mjs needs HARNESS_ANTHROPIC_MOCK");

const REDIRECTED_HOSTS = new Set([
	"api.anthropic.com",
	"console.anthropic.com",
	"platform.claude.com",
	"claude.ai",
]);
let innerFetch = globalThis.fetch;

const redirecting = (input, init) => {
	const raw = input instanceof Request ? input.url : String(input);
	const url = new URL(raw);
	if (!REDIRECTED_HOSTS.has(url.hostname)) return innerFetch(input, init);
	const target = new URL(`${url.pathname}${url.search}`, mock);
	return innerFetch(input instanceof Request ? new Request(target, input) : target, init);
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
	const first = String(file ?? "").trim().split(/\s+/)[0] ?? "";
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
