import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";

// The probe is a CLI script: its body runs at import, reading `process.argv`. Each test re-imports it
// in process (so V8 coverage sees it) with a fresh module registry and its own argv.
const PROBE = new URL("./anthropic-block-types.mjs", import.meta.url).href;
// The root workspace's installed pi-ai build, the same tree `make install` hands every package.
const PI_AI = resolve(import.meta.dirname, "../../node_modules/@earendil-works/pi-ai");

const argv = process.argv;
let exitCode: typeof process.exitCode;
let root = "";

beforeEach(() => {
	exitCode = process.exitCode;
	process.exitCode = 0;
	root = mkdtempSync(join(tmpdir(), "anthropic-block-types-"));
	vi.resetModules();
});

afterEach(() => {
	process.argv = argv;
	// Bun does not clear a sticky failure when assigned undefined.
	process.exitCode = exitCode ?? 0;
	vi.restoreAllMocks();
	rmSync(root, { recursive: true, force: true });
});

/** Import the probe as `node anthropic-block-types.mjs ...roots`, capturing its console output. */
async function run(...roots: string[]) {
	process.argv = [argv[0] ?? "node", "anthropic-block-types.mjs", ...roots];
	const log = vi.spyOn(console, "log").mockImplementation(() => {});
	const error = vi.spyOn(console, "error").mockImplementation(() => {});
	const outcome = await import(PROBE).then(
		() => undefined,
		(reason: unknown) => reason,
	);
	return { outcome, logged: log.mock.calls.map(String), errors: error.mock.calls.map(String) };
}

test("with no package root it prints usage and exits 2", async () => {
	const { outcome, logged, errors } = await run();
	assert.equal(outcome, undefined);
	assert.equal(process.exitCode, 2);
	assert.deepEqual(errors, ["Usage: node probes/anthropic-block-types.mjs <built-pi-ai-root> [...]"]);
	assert.deepEqual(logged, []);
});

test("the installed pi-ai keeps wire text and wire thinking blocks as they were sent", async () => {
	const { outcome, logged, errors } = await run(PI_AI);
	assert.equal(outcome, undefined);
	assert.equal(process.exitCode, 0);
	assert.deepEqual(errors, []);
	assert.deepEqual(logged, [
		`${PI_AI}: wire text -> normalized text: PASS`,
		`${PI_AI}: wire thinking -> normalized thinking: PASS`,
	]);
});

test("a build that misclassifies the stream fails the probe with the provider's error", async () => {
	const fake = join(root, "pi-ai");
	mkdirSync(join(fake, "dist", "api"), { recursive: true });
	writeFileSync(join(fake, "package.json"), '{ "type": "module" }\n');
	writeFileSync(
		join(fake, "dist", "api", "anthropic-messages.js"),
		'export const stream = () => ({ result: async () => ({ stopReason: "error", errorMessage: "misclassified", content: [] }) });\n',
	);
	writeFileSync(
		join(fake, "dist", "compat.js"),
		"export const getModel = (provider, id) => ({ provider, id });\nexport const normalizeContext = (context) => context;\n",
	);
	const { outcome, logged } = await run(fake);
	assert.ok(outcome instanceof assert.AssertionError, String(outcome));
	assert.equal(outcome.actual, "error");
	assert.equal(outcome.expected, "toolUse");
	assert.match(outcome.message, /^misclassified/);
	assert.deepEqual(logged, []);
});
