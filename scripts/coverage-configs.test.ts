/**
 * Every Vitest producer configuration is imported and its resolved `test.coverage` asserted, once. Each
 * reads its own `coverage/policy.json` entry at load time, so the policy file is faked here (only its
 * read) to give each package a distinct, exercised inventory.
 */
import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test, vi } from "vitest";

interface Coverage {
	provider: string;
	reporter: string[];
	reportsDirectory: string;
	reportOnFailure: boolean;
	include: string[];
	exclude: string[];
	thresholds?: Record<string, number | Record<string, number>>;
}

interface Entry {
	owned: string[];
	exclusions: { path: string }[];
	signals: { primary?: { report: string } };
}

type Loader = () => Promise<{ default: unknown }>;

interface Producer {
	config: string;
	policy: string;
	provider: string;
	reportsDirectory: string;
	load: Loader;
}

const PRODUCERS: Producer[] = [
	{
		config: "packages/computer-use/vitest.async.config.ts",
		policy: "computer-use-async",
		provider: "istanbul",
		reportsDirectory: "coverage/async",
		load: () => import("../packages/computer-use/vitest.async.config.ts"),
	},
	{
		config: "packages/computer-use/vitest.config.ts",
		policy: "computer-use-vitest",
		provider: "istanbul",
		reportsDirectory: "coverage/primary",
		load: () => import("../packages/computer-use/vitest.config.ts"),
	},
	{
		config: "packages/dev-tools/vitest.config.ts",
		policy: "dev-tools",
		provider: "istanbul",
		reportsDirectory: "coverage/primary",
		load: () => import("../packages/dev-tools/vitest.config.ts"),
	},
	{
		config: "packages/plan-mode/vitest.config.ts",
		policy: "plan-mode",
		provider: "istanbul",
		reportsDirectory: "coverage/primary",
		load: () => import("../packages/plan-mode/vitest.config.ts"),
	},
	{
		config: "packages/plan-mode/vitest.runtime-build.config.ts",
		policy: "runtime-build-tooling",
		provider: "istanbul",
		reportsDirectory: "packages/plan-mode/coverage/runtime-build-tooling",
		load: () => import("../packages/plan-mode/vitest.runtime-build.config.ts"),
	},
	{
		config: "packages/preset/vitest.config.ts",
		policy: "preset",
		provider: "istanbul",
		reportsDirectory: "coverage/primary",
		load: () => import("../packages/preset/vitest.config.ts"),
	},
	{
		config: "packages/resource-sampler/vitest.config.ts",
		policy: "resource-sampler",
		provider: "v8",
		reportsDirectory: "coverage/primary",
		load: () => import("../packages/resource-sampler/vitest.config.ts"),
	},
	{
		config: "packages/session-kit/vitest.config.ts",
		policy: "session-kit",
		provider: "v8",
		reportsDirectory: "coverage/primary",
		load: () => import("../packages/session-kit/vitest.config.ts"),
	},
	{
		config: "packages/subagents/vitest.config.ts",
		policy: "subagents",
		provider: "istanbul",
		reportsDirectory: "coverage/primary",
		load: () => import("../packages/subagents/vitest.config.ts"),
	},
	{
		config: "packages/subagents/vitest.runtime-build.config.ts",
		policy: "subagents-runtime-tooling",
		provider: "istanbul",
		reportsDirectory: "coverage/runtime-build-tooling",
		load: () => import("../packages/subagents/vitest.runtime-build.config.ts"),
	},
	{
		config: "packages/subagents/vitest.workflow-examples.config.ts",
		policy: "workflow-examples",
		provider: "istanbul",
		reportsDirectory: "coverage/workflow-examples",
		load: () => import("../packages/subagents/vitest.workflow-examples.config.ts"),
	},
	{
		config: "packages/subscription-router/vitest.config.ts",
		policy: "subscription-router",
		provider: "v8",
		reportsDirectory: "coverage/primary",
		load: () => import("../packages/subscription-router/vitest.config.ts"),
	},
	{
		config: "packages/todo/vitest.config.ts",
		policy: "todo",
		provider: "istanbul",
		reportsDirectory: "coverage/primary",
		load: () => import("../packages/todo/vitest.config.ts"),
	},
	{
		config: "integration/inprocess/vitest.config.ts",
		policy: "inprocess",
		provider: "v8",
		reportsDirectory: "coverage/primary",
		load: () => import("../integration/inprocess/vitest.config.ts"),
	},
	{
		config: "tests/lib/vitest.config.ts",
		policy: "test-lib",
		provider: "v8",
		reportsDirectory: "coverage/primary",
		load: () => import("../tests/lib/vitest.config.ts"),
	},
	{
		config: "integration/probes/vitest.config.ts",
		policy: "probes",
		provider: "v8",
		reportsDirectory: "coverage/primary",
		load: () => import("../integration/probes/vitest.config.ts"),
	},
	{
		config: "integration/providers/vitest.config.ts",
		policy: "providers",
		provider: "v8",
		reportsDirectory: "coverage/primary",
		load: () => import("../integration/providers/vitest.config.ts"),
	},
	{
		config: "scripts/vitest.config.ts",
		policy: "import-audit",
		provider: "v8",
		reportsDirectory: "scripts/coverage/primary",
		load: () => import("./vitest.config.ts"),
	},
];

/** Files at 0/0/0/0 on every OS; adding or dropping a pin must change this list too (#645). */
const ZERO_UNCOVERED_FILES = [
	"extensions/computer-use.ts",
	"scripts/build-native.mjs",
	"scripts/check-commit-messages.mjs",
	"scripts/check-docs-platform.mjs",
	"scripts/check-docs.mjs",
	"scripts/check-package-assets.mjs",
	"scripts/check-sync-ledger.mjs",
	"scripts/check-sync-reverts.mjs",
	"scripts/check-upstream-sync.mjs",
	"scripts/docs-generators/generate-source-references.mjs",
	"scripts/docs-generators/generate-tool-reference.mjs",
	"scripts/make-signing-cert.mjs",
	"scripts/rust-coverage.mjs",
	"scripts/setup-helper.mjs",
	"src/actions.ts",
	"src/bridge.ts",
	"src/cdp.ts",
	"src/config.ts",
	"src/contract.ts",
	"src/desktop.ts",
	"src/find-params.ts",
	"src/note.ts",
	"src/outline-store.ts",
	"src/outline.ts",
	"src/output.ts",
	"src/permissions.ts",
	"src/platform/architecture.ts",
	"src/platform/coerce.ts",
	"src/platform/index.ts",
	"src/platform/linux/backend.ts",
	"src/platform/linux/helper.ts",
	"src/platform/linux/wsl.ts",
	"src/platform/macos/backend.ts",
	"src/platform/macos/browser.ts",
	"src/platform/macos/helper-path.mjs",
	"src/platform/macos/helper.ts",
	"src/platform/macos/permissions.ts",
	"src/platform/windows/backend.ts",
	"src/platform/windows/helper.ts",
	"src/root-selection.ts",
	"src/runtime.ts",
	"src/state.ts",
	"src/view.ts",
];

/** The resolved non-coverage options of every producer, fixed before the factory (#863). Paths are repo-relative. */
const RESOLVED: Record<string, unknown> = {
	"integration/inprocess/vitest.config.ts": {
		test: { pool: "forks", maxWorkers: 2, testTimeout: 20000, setupFiles: ["tests/lib/src/home-setup.ts"] },
	},
	"integration/probes/vitest.config.ts": {
		test: {
			include: [
				"anthropic-block-types.test.ts",
				"latency.test.ts",
				"process-lifecycle.test.ts",
				"render.test.ts",
				"session-kit-child-scope.test.ts",
				"stack-resources.test.ts",
				"transcript-types.test.ts",
			],
			pool: "forks",
			maxWorkers: 2,
			testTimeout: 20000,
			setupFiles: ["tests/lib/src/home-setup.ts"],
		},
	},
	"integration/providers/vitest.config.ts": {
		test: {
			include: [
				"bun_runtime.test.ts",
				"extension_inventory.test.ts",
				"faux.test.ts",
				"preloads.test.ts",
				"usage_fixture.test.ts",
			],
			pool: "forks",
			maxWorkers: 2,
			testTimeout: 20000,
			setupFiles: ["tests/lib/src/home-setup.ts"],
		},
	},
	"packages/computer-use/vitest.async.config.ts": {
		test: {
			include: ["test/async.test.mjs", "test/async-observer.test.mjs", "test/async-safety.test.mjs"],
			pool: "forks",
			maxWorkers: 1,
			testTimeout: 20000,
			setupFiles: ["tests/lib/src/home-setup.ts"],
		},
	},
	"packages/computer-use/vitest.config.ts": {
		test: {
			dir: "test",
			pool: "forks",
			maxWorkers: 1,
			testTimeout: 20000,
			setupFiles: ["tests/lib/src/home-setup.ts"],
		},
	},
	"packages/dev-tools/vitest.config.ts": {
		test: { pool: "forks", maxWorkers: 2, setupFiles: ["tests/lib/src/home-setup.ts"], testTimeout: 20000 },
	},
	"packages/plan-mode/vitest.config.ts": {
		test: {
			maxWorkers: 2,
			environment: "node",
			env: { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "commit.gpgsign", GIT_CONFIG_VALUE_0: "false" },
			hookTimeout: 30000,
			include: ["test/**/*.test.ts"],
			globalSetup: ["packages/plan-mode/test/harness/vitest.global-setup.ts"],
			pool: "forks",
			runner: "packages/plan-mode/test/harness/vitest.runner.ts",
			setupFiles: ["tests/lib/src/home-setup.ts", "packages/plan-mode/test/harness/vitest.setup.ts"],
			teardownTimeout: 10000,
			testTimeout: 5000,
		},
	},
	"packages/plan-mode/vitest.runtime-build.config.ts": {
		test: {
			environment: "node",
			env: { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "commit.gpgsign", GIT_CONFIG_VALUE_0: "false" },
			hookTimeout: 30000,
			include: ["packages/plan-mode/test/build-runtime.test.ts"],
			globalSetup: ["packages/plan-mode/test/harness/vitest.global-setup.ts"],
			pool: "forks",
			runner: "packages/plan-mode/test/harness/vitest.runner.ts",
			setupFiles: ["packages/plan-mode/test/harness/vitest.setup.ts"],
			teardownTimeout: 10000,
			testTimeout: 5000,
		},
		root: ".",
	},
	"packages/preset/vitest.config.ts": {
		test: { pool: "forks", maxWorkers: 2, testTimeout: 20000, setupFiles: ["tests/lib/src/home-setup.ts"] },
	},
	"packages/resource-sampler/vitest.config.ts": {
		test: { maxWorkers: 1, setupFiles: ["tests/lib/src/home-setup.ts"] },
	},
	"packages/session-kit/vitest.config.ts": {
		test: {
			server: { deps: { inline: ["@nredd/pi-resource-sampler"] } },
			setupFiles: ["tests/lib/src/home-setup.ts"],
			pool: "forks",
			maxWorkers: 2,
			testTimeout: 20000,
		},
	},
	"packages/subagents/vitest.config.ts": {
		test: {
			maxWorkers: 2,
			setupFiles: ["tests/lib/src/home-setup.ts", "packages/subagents/test/helpers/tmp-root-setup.ts"],
			server: { deps: { inline: ["RE:/@earendil-works\\/pi-/"] } },
		},
		resolve: { dedupe: ["@earendil-works/pi-ai"] },
	},
	"packages/subagents/vitest.runtime-build.config.ts": {
		test: { maxWorkers: 1, include: ["test/runtime-scripts.test.ts"], testTimeout: 15000 },
	},
	"packages/subagents/vitest.workflow-examples.config.ts": {
		test: {
			env: { PI_WORKFLOW_EXAMPLE_COVERAGE: "1" },
			setupFiles: ["tests/lib/src/home-setup.ts", "packages/subagents/test/helpers/tmp-root-setup.ts"],
			server: { deps: { inline: ["RE:/@earendil-works\\/pi-/"] } },
			include: ["test/workflow-examples.test.ts"],
		},
		resolve: { dedupe: ["@earendil-works/pi-ai"] },
	},
	"packages/subscription-router/vitest.config.ts": {
		test: { maxWorkers: 2, setupFiles: ["tests/lib/src/home-setup.ts"] },
	},
	"packages/todo/vitest.config.ts": {
		test: {
			include: ["*.test.ts", "state/**/*.test.ts", "tool/**/*.test.ts", "view/**/*.test.ts"],
			setupFiles: ["tests/lib/src/home-setup.ts", "packages/todo/.test-support/setup.ts"],
			pool: "forks",
			maxWorkers: 2,
			hookTimeout: 30000,
			testTimeout: 15000,
			unstubGlobals: true,
			clearMocks: true,
			restoreMocks: true,
		},
		resolve: { alias: { "@juicesharp/rpiv-test-utils": "packages/todo/.test-support/upstream/index.ts" } },
	},
	"scripts/vitest.config.ts": {
		test: {
			include: [
				"scripts/coverage-configs.test.ts",
				"scripts/import_audit.test.ts",
				"scripts/merge-pr.test.ts",
				"scripts/router_contract.test.mjs",
				"scripts/run-vitest.test.ts",
			],
			pool: "forks",
			maxWorkers: 2,
			testTimeout: 20000,
			setupFiles: ["tests/lib/src/home-setup.ts"],
		},
		root: ".",
	},
	"tests/lib/vitest.config.ts": { test: { pool: "forks", maxWorkers: 2, setupFiles: ["tests/lib/src/home-setup.ts"] } },
};

const REPO = fileURLToPath(new URL("..", import.meta.url));
const PATH_OPTIONS = new Set(["setupFiles", "globalSetup", "runner"]);

/** The config minus its coverage block, as JSON with regexes spelled out and every path made repo-relative. */
function resolvedShape(producer: Producer, config: { root?: string; test?: Record<string, unknown> }): unknown {
	const base = config.root ?? resolve(REPO, dirname(producer.config));
	const repoRelative = (path: string) => relative(REPO, resolve(base, path));
	const { coverage: _coverage, ...test } = config.test ?? {};
	const paths = (value: unknown) =>
		Array.isArray(value) ? value.map((path: string) => repoRelative(path)) : repoRelative(value as string);
	const shape = {
		...config,
		...(config.root === undefined ? {} : { root: "." }),
		test: Object.fromEntries(
			Object.entries(test).map(([key, value]) => [key, PATH_OPTIONS.has(key) ? paths(value) : value]),
		),
	};
	return JSON.parse(
		JSON.stringify(shape, (_key, value) => (value instanceof RegExp ? `RE:${value}` : value)).replaceAll(`${REPO}`, ""),
	);
}

const POLICY_URL = new URL("../coverage/policy.json", import.meta.url);

/** Policy entries the faked `readFileSync` serves; null serves the real file. */
const served = vi.hoisted(() => ({ packages: null as Record<string, unknown> | null }));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		readFileSync: ((path: Parameters<typeof actual.readFileSync>[0], ...rest: unknown[]) =>
			served.packages !== null && String(path).endsWith("/coverage/policy.json")
				? JSON.stringify({ packages: served.packages })
				: (actual.readFileSync as (...args: unknown[]) => unknown)(path, ...rest)) as typeof actual.readFileSync,
	};
});

beforeEach(() => {
	vi.resetModules();
});

afterEach(() => {
	served.packages = null;
});

async function coverageOf({ load }: Producer): Promise<Coverage> {
	const coverage = ((await load()).default as { test?: { coverage?: Coverage } }).test?.coverage;
	assert.ok(coverage, "the configuration resolves a `test.coverage` block");
	return coverage;
}

function realPolicy(): Record<string, Entry> {
	return JSON.parse(readFileSync(POLICY_URL, "utf8")).packages;
}

test("the producer table is exactly the Vitest configurations the policy inventories", () => {
	const root = fileURLToPath(new URL("..", import.meta.url));
	const inventoried = new Set(
		(realPolicy()["import-audit"]?.owned ?? [])
			.flatMap((pattern) => globSync(pattern, { cwd: root }))
			.filter((path) => /(^|\/)\.?vitest[^/]*\.config\.ts$/.test(path)),
	);
	assert.deepEqual(PRODUCERS.map(({ config }) => config).sort(), [...inventoried].sort());
	assert.equal(new Set(PRODUCERS.map(({ policy }) => policy)).size, PRODUCERS.length);
});

for (const producer of PRODUCERS) {
	test(`${producer.config} reports text, LCOV and a statement summary from ${producer.provider} even on failure`, async () => {
		const policy = realPolicy()[producer.policy];
		assert.ok(policy, `${producer.policy} is in the policy`);
		const coverage = await coverageOf(producer);
		assert.equal(coverage.provider, producer.provider);
		assert.deepEqual(coverage.reporter, ["text", "lcov", "json-summary"]);
		assert.equal(coverage.reportsDirectory, producer.reportsDirectory);
		assert.equal(`${coverage.reportsDirectory}/lcov.info`, policy.signals.primary?.report);
		assert.equal(coverage.reportOnFailure, true);
		assert.deepEqual(coverage.include, policy.owned);
		assert.deepEqual(
			coverage.exclude,
			policy.exclusions.map(({ path }) => path),
		);
	});

	test(`${producer.config} takes its scope from the ${producer.policy} entry alone`, async () => {
		served.packages = Object.fromEntries(
			PRODUCERS.map(({ policy }) => [
				policy,
				{
					owned: [`owned-by-${policy}.ts`],
					exclusions: [{ path: `excluded-by-${policy}.ts` }, { path: `also-${policy}.ts` }],
				},
			]),
		);
		const coverage = await coverageOf(producer);
		assert.deepEqual(coverage.include, [`owned-by-${producer.policy}.ts`]);
		assert.deepEqual(coverage.exclude, [`excluded-by-${producer.policy}.ts`, `also-${producer.policy}.ts`]);
	});

	test(`${producer.config} fails to load when the policy lacks ${producer.policy}`, async () => {
		served.packages = Object.fromEntries(
			PRODUCERS.filter(({ policy }) => policy !== producer.policy).map(({ policy }) => [
				policy,
				{ owned: [], exclusions: [] },
			]),
		);
		await assert.rejects(producer.load(), TypeError);
	});
}

for (const producer of PRODUCERS) {
	test(`${producer.config} resolves the same non-coverage options as before the shared factory`, async () => {
		const config = (await producer.load()).default as { root?: string; test?: Record<string, unknown> };
		assert.deepEqual(resolvedShape(producer, config), RESOLVED[producer.config]);
	});
}

test("subagents runtime verification pins the complete script at zero L/F/B/S", async () => {
	const producer = PRODUCERS.find(({ policy }) => policy === "subagents-runtime-tooling");
	assert.ok(producer);
	assert.deepEqual((await coverageOf(producer)).thresholds, {
		"scripts/build-runtime.mjs": { lines: 100, functions: 100, branches: 100, statements: 100 },
	});
});

test("computer-use async verification pins the whole helper at zero L/F/B/S", async () => {
	const producer = PRODUCERS.find(({ policy }) => policy === "computer-use-async");
	assert.ok(producer);
	assert.deepEqual((await coverageOf(producer)).thresholds, {
		"scripts/check-async.mjs": { lines: 100, functions: 100, branches: 100, statements: 100 },
	});
});

test("computer-use-vitest is an enforced ratchet with a cap for every counter on both OSes (#645)", () => {
	const signal = realPolicy()["computer-use-vitest"]?.signals.primary as
		| { enforcement?: string; max_uncovered: Record<string, Record<string, number>> }
		| undefined;
	assert.ok(signal, "computer-use-vitest has a primary signal");
	assert.notEqual(signal.enforcement, "report-only");
	assert.deepEqual(Object.keys(signal.max_uncovered).sort(), ["darwin", "linux"]);
	for (const caps of Object.values(signal.max_uncovered)) {
		assert.deepEqual(Object.keys(caps).sort(), ["branches", "functions", "lines", "statements"]);
		for (const cap of Object.values(caps)) assert.ok(Number.isInteger(cap) && cap >= 0);
	}
});

test("computer-use pins every file already at zero uncovered, each owned (#645)", async () => {
	const producer = PRODUCERS.find(({ policy }) => policy === "computer-use-vitest");
	assert.ok(producer);
	const { thresholds, include } = await coverageOf(producer);
	assert.ok(thresholds, "the configuration pins files");
	const root = fileURLToPath(new URL("../packages/computer-use/", import.meta.url));
	const owned = new Set(include.flatMap((pattern) => globSync(pattern, { cwd: root })));
	const pinned = Object.keys(thresholds);
	assert.deepEqual(pinned.sort(), [...ZERO_UNCOVERED_FILES]);
	for (const path of pinned) {
		assert.ok(owned.has(path), `${path} is an owned source file`);
		assert.deepEqual(thresholds[path], { lines: 100, functions: 100, branches: 100, statements: 100 });
	}
});
