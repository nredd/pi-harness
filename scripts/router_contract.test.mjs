/**
 * In-process tests for the stock-Pi packed-router contract fixture. Its two imports are placeholders
 * `scripts/package_contracts.py` rewrites to the installed tarball, so here they are virtual mocks that
 * record what the fixture hands the real router; `test_package_contracts.py` runs it against stock Pi.
 */
import assert from "node:assert/strict";
import { test, vi } from "vitest";

const ANTHROPIC_USAGE = "https://api.anthropic.com/api/oauth/usage";
const CODEX_USAGE = "https://chatgpt.com/backend-api/wham/usage";

const recorded = vi.hoisted(() => ({ services: [], routers: [], registered: [] }));

vi.mock("PACKED_ROUTER_USAGE", () => ({
	UsageService: class {
		constructor(options) {
			this.options = options;
			this.reads = [];
			recorded.services.push(this);
		}
		async get(_context, provider) {
			const response = await this.options.fetch(provider === "anthropic" ? ANTHROPIC_USAGE : CODEX_USAGE);
			this.reads.push({ provider, body: await response.json() });
		}
	},
}));

vi.mock("PACKED_ROUTER_INDEX", () => ({
	createSubscriptionRouter: (options) => {
		recorded.routers.push(options);
		return (pi) => {
			recorded.registered.push(pi);
		};
	},
}));

const { default: routerContract, syntheticUsedPercent } = await import("./router_contract.mjs");

test("each scenario's synthetic utilization steers the router the way the contract expects", () => {
	assert.deepEqual(
		[syntheticUsedPercent("balanced", "anthropic", 1), syntheticUsedPercent("balanced", "openai-codex", 1)],
		[90, 20],
	);
	assert.deepEqual(
		[syntheticUsedPercent("fallback", "anthropic", 1), syntheticUsedPercent("fallback", "openai-codex", 2)],
		[100, 100],
	);
	assert.deepEqual(
		[
			syntheticUsedPercent("recovery", "anthropic", 1),
			syntheticUsedPercent("recovery", "anthropic", 2),
			syntheticUsedPercent("recovery", "openai-codex", 2),
		],
		[0, 100, 0],
	);
});

test("the fixture prewarms both providers' usage, then registers the packed three-provider router", async () => {
	const pi = { name: "recording ExtensionAPI" };
	const before = Date.now();
	await routerContract(pi);

	const [service] = recorded.services;
	assert.equal(recorded.services.length, 1);
	assert.equal(service.options.now, Date.now);
	assert.equal(await service.options.getAccessToken(), "synthetic-contract-token");
	// The unsubstituted placeholder mode is not a known scenario, so the fixture reports `balanced`.
	const [anthropic, codex] = service.reads;
	assert.equal(anthropic.provider, "anthropic");
	assert.equal(anthropic.body.five_hour.utilization, 90);
	assert.ok(Date.parse(anthropic.body.five_hour.resets_at) >= before);
	assert.equal(codex.provider, "openai-codex");
	assert.equal(codex.body.rate_limit.primary_window.used_percent, 20);
	assert.ok(codex.body.rate_limit.primary_window.reset_at * 1000 >= before);

	assert.equal(recorded.routers.length, 1);
	const [router] = recorded.routers;
	assert.equal(router.usage, service);
	assert.equal(router.config.ok, true);
	assert.deepEqual(
		router.config.profiles.map((profile) => [profile.id, profile.strategy, profile.chain]),
		[
			[
				"default",
				"balanced",
				[
					{ provider: "anthropic", id: "m-a" },
					{ provider: "openai-codex", id: "m-b" },
					{ provider: "local", id: "m-c" },
				],
			],
		],
	);
	assert.deepEqual(recorded.registered, [pi]);
});
