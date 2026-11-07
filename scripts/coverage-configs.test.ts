/**
 * Every Vitest producer configuration is imported and its resolved `test.coverage` asserted, once. Each
 * reads its own `coverage/policy.json` entry at load time, so the policy file is faked here (only its
 * read) to give each package a distinct, exercised inventory.
 */
import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test, vi } from "vitest";

interface Coverage {
	provider: string;
	reporter: string[];
	reportsDirectory: string;
	reportOnFailure: boolean;
	include: string[];
	exclude: string[];
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
		reportsDirectory: "coverage/runtime-build-tooling",
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
		config: "packages/todo/.vitest.config.ts",
		policy: "todo",
		provider: "istanbul",
		reportsDirectory: "coverage/primary",
		load: () => import("../packages/todo/.vitest.config.ts"),
	},
	{
		config: "integration/inprocess/vitest.config.ts",
		policy: "inprocess",
		provider: "v8",
		reportsDirectory: "coverage/primary",
		load: () => import("../integration/inprocess/vitest.config.ts"),
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
	test(`${producer.config} reports text and LCOV from ${producer.provider} even on failure`, async () => {
		const policy = realPolicy()[producer.policy];
		assert.ok(policy, `${producer.policy} is in the policy`);
		const coverage = await coverageOf(producer);
		assert.equal(coverage.provider, producer.provider);
		assert.deepEqual(coverage.reporter, ["text", "lcov"]);
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
