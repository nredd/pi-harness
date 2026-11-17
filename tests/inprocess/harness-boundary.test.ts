/** Native graph controls for the public-SDK stack fixture, on both supported hosts. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isolatedHomeEnv } from "@nredd/pi-test-lib/isolated-home";
import { runTree } from "@nredd/pi-test-lib/run-tree";
import { expect, it } from "vitest";

const fixture = new URL("./support.ts", import.meta.url).href;
const harness = new URL("../lib/src/harness.ts", import.meta.url).href;
const faux = new URL("../lib/src/faux.ts", import.meta.url).href;

/** Observe native imports rather than relying on Vitest's transformed module graph. */
const guard = `
const imports = new Set();
function check(specifier) {
 imports.add(specifier);
 if (specifier.includes("pi-coding-agent/testing") || specifier.includes("pi-coding-agent/dist/testing") || specifier.includes("pi-tui/testing") || specifier.includes("pi-tui/dist/testing")) {
  throw new Error("FORK_BOUNDARY: " + specifier);
 }
}
if (globalThis.Bun) {
 const {readFileSync} = await import("node:fs");
 Bun.plugin({name: "stack-headless-graph", setup(build) {
  build.onResolve({filter: /.*/}, args => { check(args.path); });
  build.onLoad({filter: /tests\\/inprocess\\/support\\.ts$|tests\\/lib\\/src\\/harness\\.ts$|pi-(coding-agent|tui)\\/dist\\/.*\\.js$/}, args => {
   check(args.path);
   return {contents: readFileSync(args.path, "utf8"), loader: args.path.endsWith(".ts") ? "ts" : "js"};
  });
 }});
} else {
 const {registerHooks} = await import("node:module");
 registerHooks({resolve(specifier, context, next) { check(specifier); return next(specifier, context); }});
}
`;

/** What a native child prints: shared by both scenarios, each filling only its own fields. */
interface Receipt {
	first?: string;
	results?: { isError: boolean; text: string }[];
	pending?: number;
	cleaned?: boolean;
	imports?: string[];
	publicSdk?: boolean;
	error?: string;
}

/** Launch this engine without provider credentials, then remove every fixture path. */
async function run(body: string): Promise<Receipt> {
	const root = mkdtempSync(join(tmpdir(), "stack-headless-process-"));
	const home = join(root, "home");
	const temp = join(root, "tmp");
	mkdirSync(home);
	mkdirSync(temp);
	try {
		const result = await runTree(process.execPath, ["--input-type=module", "-e", guard + body], {
			cwd: fileURLToPath(new URL(".", import.meta.url)),
			env: {
				PATH: process.env.PATH,
				...isolatedHomeEnv(home),
				TMPDIR: temp,
				TMP: temp,
				TEMP: temp,
				PI_OFFLINE: "1",
				PI_NO_LOCAL_LLM: "1",
				JITI_FS_CACHE: "false",
			},
			timeoutMs: 5_000,
		});
		expect(result.error).toBeUndefined();
		expect(result.timedOut).toBe(false);
		expect(result.status, result.stderr || result.stdout).toBe(0);
		return JSON.parse(result.stdout) as Receipt;
	} finally {
		rmSync(root, { recursive: true, force: true });
		expect(existsSync(root)).toBe(false);
	}
}

it("prompts a real public stack and refuses an unavailable tool without fork testing exports", async () => {
	const result = await run(`
const {isolateStackHome, startStack} = await import(${JSON.stringify(fixture)});
const {fauxAssistantMessage} = await import(${JSON.stringify(harness)});
const {toolCall, outcomes} = await import(${JSON.stringify(faux)});
const {existsSync} = await import("node:fs");
const home = await isolateStackHome();
let h, receipt;
try {
 h = await startStack({cwd: home.root, factories: []});
 h.setResponses([fauxAssistantMessage("STACK OK"), toolCall("missing_tool", {}), fauxAssistantMessage("refused")]);
 await h.session.prompt("hello");
 const first = h.session.getLastAssistantText();
 await h.session.prompt("call missing");
 receipt = {first, results: outcomes(h, "missing_tool"), pending: h.getPendingResponseCount(), imports: [...imports]};
} finally { h?.cleanup(); await home.cleanup(); }
console.log(JSON.stringify({...receipt, cleaned: !existsSync(home.root)}));
`);
	expect(result).toMatchObject({ first: "STACK OK", pending: 0, cleaned: true, results: [{ isError: true }] });
	expect(result.results?.[0]?.text).toContain("missing_tool");
	// The shared public harness was evaluated, and no fork testing specifier was ever resolved.
	expect(result.imports).toEqual(
		expect.arrayContaining([expect.stringMatching(/(?:pi-test-lib\/harness|harness\.ts)$/)]),
	);
	expect(
		result.imports?.filter((specifier) => /(?:pi-coding-agent|pi-tui)\/(?:dist\/)?testing/.test(specifier)),
	).toEqual([]);
});

/** Whether the installed host package publishes `specifier`'s subpath in its `exports` map. */
function hostExports(specifier: string): boolean {
	const [scope, name, ...subpath] = specifier.split("/");
	let directory = dirname(fileURLToPath(import.meta.url));
	while (!existsSync(join(directory, "node_modules", scope ?? "", name ?? "", "package.json")))
		directory = dirname(directory);
	directory = join(directory, "node_modules", scope ?? "", name ?? "");
	const { exports } = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as {
		exports?: Record<string, unknown>;
	};
	return Object.hasOwn(exports ?? {}, `./${subpath.join("/")}`);
}

it.each([
	"@earendil-works/pi-coding-agent/testing",
	"@earendil-works/pi-coding-agent/testing/interactive",
	"@earendil-works/pi-tui/testing",
])("refuses injected fork import %s", async (specifier) => {
	const result = await run(`
const sdk = await import("@earendil-works/pi-coding-agent");
let error;
try { await import(${JSON.stringify(specifier)}); } catch (cause) { error = cause.message; }
console.log(JSON.stringify({publicSdk: typeof sdk.AgentSession === "function", error}));
`);
	expect(result.publicSdk).toBe(true);
	// Node's resolve hook always runs first. Bun's `onResolve` only runs for a subpath the host exports, so
	// a stock host on Bun fails earlier with its own resolution error; that case expects exactly that.
	if (hostExports(specifier) || !process.versions.bun) {
		// Bun's `onLoad` names the resolved file rather than the specifier, so match the package and `testing`.
		const name = specifier.split("/")[1];
		expect(result.error).toMatch(new RegExp(`^FORK_BOUNDARY: .*${name}.*testing`));
	} else {
		expect(result.error).toMatch(/^Cannot find package '@earendil-works\/pi-/);
	}
});
