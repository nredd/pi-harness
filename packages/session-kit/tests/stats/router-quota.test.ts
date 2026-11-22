import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTestTempDir } from "@nredd/pi-test-lib/temp-dir";
import { beforeEach, expect, it } from "vitest";
import { readRouterQuota } from "../../src/stats/router-quota.ts";

const NOW = 1_800_000_000_000;
let dir: string;
let view: string;

beforeEach(({ onTestFinished }) => {
	dir = makeTestTempDir("stats-router-", onTestFinished);
	const root = join(dir, "router-state", "v1");
	mkdirSync(root, { recursive: true });
	view = join(root, "view.json");
});

it("fails open for a missing, corrupt, non-file or oversized view", async () => {
	expect(await readRouterQuota(dir, NOW)).toEqual([]);
	writeFileSync(view, "[");
	expect(await readRouterQuota(dir, NOW)).toEqual([]);
	writeFileSync(
		view,
		`[{"provider":"future-provider","marks":[{"window":"daily","until":${NOW + 60_000}}]}]${" ".repeat(1024 * 1024)}`,
	);
	expect(await readRouterQuota(dir, NOW)).toEqual([]);
	mkdirSync(join(dir, "other", "router-state", "v1", "view.json"), { recursive: true });
	expect(await readRouterQuota(join(dir, "other"), NOW)).toEqual([]);
});

it("ignores expired blocks and counts, and never uses an expired percentage", async () => {
	writeFileSync(
		view,
		JSON.stringify([
			null,
			{
				provider: "future-provider",
				snapshot: {
					status: "stale",
					windows: [
						{ name: "expired", usedPercent: 99, resetAt: NOW },
						{
							name: "live",
							basis: "observed",
							usedPercent: 30,
							resetAt: NOW + 60_000,
							resetRule: { timeZone: "invalid" },
						},
						{ name: "bad", usedPercent: "100" },
						{ usedPercent: 1 },
					],
				},
				meters: [
					{ name: "expired", quantity: { unit: "requests", used: 99 }, resetAt: NOW },
					{ name: "remaining", quantity: { unit: "credits", remaining: 12 } },
					{ name: "unknown", quantity: { unit: "tokens" } },
					{ name: "bad", quantity: { unit: "invalid", used: 2 } },
					{ quantity: { unit: "requests", used: 2 } },
				],
				marks: [
					{ window: "expired", until: NOW },
					{ window: "invalid", until: 9e15 },
					{ until: NOW + 1000 },
					{ window: "read", until: NOW + 60_000, families: [] },
				],
			},
			{
				provider: "error-provider",
				snapshot: { status: "error", windows: [{ name: "ignored", usedPercent: 99 }] },
			},
			{ provider: "stale-provider", snapshot: { status: "stale", windows: [] } },
		]),
	);
	expect(await readRouterQuota(dir, NOW)).toEqual([
		{
			label: "future-provider expired (stale)",
			head: { kind: "text", text: "" },
			basis: "reported",
			reset: "reset 0s ago, no newer reading",
			expired: true,
			old: true,
		},
		{
			label: "future-provider live (stale)",
			head: { kind: "gauge", percent: 30 },
			basis: "observed",
			reset: "resets in 1m",
			expired: false,
			old: true,
		},
		{
			label: "future-provider remaining",
			head: { kind: "text", text: "12 credits left" },
			basis: "reported",
			expired: false,
			old: true,
		},
		{
			label: "future-provider read",
			head: { kind: "text", text: "blocked until 2027-01-15 08:01 UTC" },
			basis: "reported",
			expired: false,
			old: false,
		},
		{ label: "error-provider", head: { kind: "text", text: "quota read error" }, expired: false, old: true },
		{ label: "stale-provider", head: { kind: "text", text: "quota read stale" }, expired: false, old: true },
	]);
});

it("dims an available snapshot past its expiry or age limit", async () => {
	const window = { name: "window", usedPercent: 40, resetAt: NOW + 60_000 };
	writeFileSync(
		view,
		JSON.stringify([
			{ provider: "expired", snapshot: { status: "available", windows: [window], expiresAt: NOW } },
			{ provider: "aged", snapshot: { status: "available", windows: [window], retrievedAt: NOW - 900_001 } },
		]),
	);
	expect((await readRouterQuota(dir, NOW)).map((row) => [row.label, row.old])).toEqual([
		["expired window (stale)", true],
		["aged window (stale)", true],
	]);
});
