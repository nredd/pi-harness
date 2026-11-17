/** Native-process proof that headless scenarios never evaluate the fork's testing host. */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isolatedHomeEnv } from "@nredd/pi-test-lib/isolated-home";
import { runTree } from "@nredd/pi-test-lib/run-tree";
import { expect, it } from "vitest";

const fixture = new URL("./fixtures/scenario-session.ts", import.meta.url).href;
const faux = new URL("../../../tests/lib/src/faux.ts", import.meta.url).href;

/** Record the native runtime's evaluated graph, and refuse the two fork-only boundaries. */
const guard = `
const imports = new Set();
function check(specifier) {
 imports.add(specifier);
 if (specifier.includes("pi-coding-agent/testing") || specifier.includes("pi-coding-agent/dist/testing") || specifier.endsWith("scenario-terminal.ts")) {
  throw new Error("FORK_BOUNDARY: " + specifier);
 }
}
if (globalThis.Bun) {
 const {readFileSync} = await import("node:fs");
 Bun.plugin({name: "headless-graph", setup(build) {
  build.onResolve({filter: /.*/}, args => { check(args.path); });
  // Observe only the relevant ESM boundary, leaving third-party CommonJS loading native.
  build.onLoad({filter: /scenario-session\\.ts$|tests\\/lib\\/src\\/harness\\.ts$|pi-coding-agent\\/dist\\/.*\\.js$/}, args => {
   check(args.path);
   const extension = args.path.split(".").at(-1);
   return {contents: readFileSync(args.path, "utf8"), loader: ["ts", "tsx", "jsx"].includes(extension) ? extension : "js"};
  });
 }});
} else {
 const {registerHooks} = await import("node:module");
 registerHooks({resolve(specifier, context, next) { check(specifier); return next(specifier, context); }});
}
`;

/** Launch the current engine, with a disposable home and no inherited provider credentials. */
async function run(body: string) {
	const root = mkdtempSync(join(tmpdir(), "scenario-headless-process-"));
	const home = join(root, "home");
	const temp = join(root, "tmp");
	mkdirSync(home);
	mkdirSync(temp);
	try {
		const result = await runTree(process.execPath, ["--input-type=module", "-e", guard + body], {
			cwd: fileURLToPath(new URL("..", import.meta.url)),
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
		return JSON.parse(result.stdout);
	} finally {
		rmSync(root, { recursive: true, force: true });
		expect(existsSync(root)).toBe(false);
	}
}

it("runs and persists a real physical child without evaluating a fork testing module", async () => {
	const result = await run(`
const {ScenarioSession, answer, spawn} = await import(${JSON.stringify(fixture)});
const {toolCalls, outcomes} = await import(${JSON.stringify(faux)});
const {existsSync, readFileSync} = await import("node:fs");
const f = new ScenarioSession({rememberAgents: true});
const root = f.root;
let receipt;
try {
 const physical = f.physical("kid", "child", [answer("CHILD HEADLESS")]);
 const h = await f.start();
 h.setResponses([toolCalls(spawn("native child")), answer("PARENT HEADLESS")]);
 const completed = f.completion();
 await h.session.prompt("spawn");
 await completed;
 const id = outcomes(h, "Agent")[0].text.match(/Agent ID: (\\S+)/)[1];
 const record = f.record(id);
 const file = record.session.sessionManager.getSessionFile();
 receipt = {
  status: record.status, result: record.result, calls: physical.state.callCount,
  persisted: existsSync(file) && readFileSync(file, "utf8").includes("CHILD HEADLESS"),
  parent: h.session.getLastAssistantText(), imports: [...imports],
 };
} finally { await f.dispose(); }
console.log(JSON.stringify({...receipt, cleaned: !existsSync(root)}));
`);
	expect(result).toMatchObject({
		status: "completed",
		result: "CHILD HEADLESS",
		calls: 1,
		persisted: true,
		parent: "PARENT HEADLESS",
		cleaned: true,
	});
	expect(result.imports).toEqual(expect.arrayContaining([expect.stringContaining("/fixtures/scenario-session.ts")]));
	expect(result.imports).toEqual(
		expect.arrayContaining([expect.stringMatching(/@nredd\/pi-test-lib\/harness|\/tests\/lib\/src\/harness.ts/)]),
	);
	expect(result.imports).toEqual(expect.arrayContaining([expect.stringMatching(/@earendil-works\/pi-coding-agent/)]));
});

it.each(["@earendil-works/pi-coding-agent/testing", "@earendil-works/pi-coding-agent/testing/interactive"])(
	"refuses the injected eager import %s in the native graph",
	async (specifier) => {
		const result = await run(`
const sdk = await import("@earendil-works/pi-coding-agent");
let error;
try { await import(${JSON.stringify(specifier)}); }
catch (cause) { error = cause.message; }
console.log(JSON.stringify({publicSdk: typeof sdk.AgentSession === "function", error, imports: [...imports]}));
`);
		// Bun reports an absent export as a missing package; prove the root exists first.
		expect(result.publicSdk).toBe(true);
		expect(result.error).toMatch(
			/FORK_BOUNDARY|not exported|not defined by "exports"|Cannot find package '@earendil-works\/pi-coding-agent'/,
		);
	},
);

it("refuses a terminal request at the separate fork boundary", async () => {
	const result = await run(`
const {ScenarioSession} = await import(${JSON.stringify(fixture)});
const f = new ScenarioSession();
let error;
try { await f.start({terminal: true}); }
catch (cause) { error = cause.message; }
finally { await f.dispose(); }
console.log(JSON.stringify({error, imports: [...imports]}));
`);
	expect(result.error).toContain("FORK_BOUNDARY: ./scenario-terminal.ts");
});
