import { mkdirSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { makeTestTempDir } from "@nredd/pi-test-lib/temp-dir";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QUOTA_LABEL_MAX } from "../../src/stats/quota.ts";
import { readRouterQuota } from "../../src/stats/router-quota.ts";

vi.mock("node:fs/promises", { spy: true });

const NOW = 1_800_000_000_000;
let dir: string;
let view: string;

beforeEach(({ onTestFinished }) => {
	dir = makeTestTempDir("stats-router-", onTestFinished);
	const root = join(dir, "router-state", "v1");
	mkdirSync(root, { recursive: true });
	view = join(root, "view.json");
});

afterEach(() => vi.restoreAllMocks());

const validView = `[{"provider":"future-provider","marks":[{"window":"daily","until":${NOW + 60_000}}]}]`;

it.each([false, true])("rejects oversized files with a valid first chunk (grew after stat: %s)", async (grew) => {
	writeFileSync(view, validView + " ".repeat(1024 * 1024));
	const file = await fs.open(view);
	const info = await file.stat();
	if (grew) vi.spyOn(file, "stat").mockResolvedValue(Object.assign(info, { size: validView.length }));
	const read = file.read.bind(file);
	const shortRead = vi
		.spyOn(file, "read")
		.mockImplementationOnce((options) => read({ ...options, length: validView.length }));
	vi.mocked(fs.open).mockResolvedValueOnce(file);
	try {
		expect(await readRouterQuota(dir, NOW)).toEqual([]);
		expect(shortRead).toHaveBeenCalledTimes(grew ? 2 : 0);
	} finally {
		await file.close();
	}
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
			label: "future-provider remaining (stale)",
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

it.each(["reported", "read", "bogus", null, undefined])(
	"distinguishes absent and invalid provenance (%s)",
	async (source) => {
		writeFileSync(
			view,
			JSON.stringify([
				{
					provider: "provider",
					snapshot: { status: "available", windows: [{ name: "window", usedPercent: 10, basis: source }] },
					meters: [{ name: "meter", quantity: { unit: "requests", used: 1 }, basis: source }],
					marks: [{ window: "mark", until: NOW + 60_000, evidence: source }],
				},
			]),
		);
		const rows = await readRouterQuota(dir, NOW);
		const expected = {
			reported: [
				["provider window", "reported"],
				["provider meter", "reported"],
			],
			read: [["provider mark", "reported"]],
			absent: [
				["provider window", "reported"],
				["provider meter", "reported"],
				["provider mark", "reported"],
			],
		};
		const key = source === undefined ? "absent" : source;
		expect(rows.map(({ label, basis }) => [label, basis])).toEqual(
			key === "absent" || key === "reported" || key === "read" ? expected[key] : [],
		);
	},
);

it("shows unlimited pools and omits invalid or missing balances", async () => {
	writeFileSync(
		view,
		JSON.stringify([
			{
				provider: "provider",
				pools: [
					null,
					{ name: "invalid", unit: "tokens", balance: 12 },
					{ name: "missing", unit: "usd" },
					{ name: "valid", unit: "usd", unlimited: true },
				],
			},
		]),
	);
	expect(await readRouterQuota(dir, NOW)).toEqual([
		{ label: "provider valid", head: { kind: "text", text: "unlimited balance" }, expired: false, old: false },
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

it.each([
	["assumed", "provider day (assumed span)"],
	["inferred", "provider day (inferred span)"],
	["reported", "provider day"],
	[undefined, "provider day"],
])("labels a meter's %s span separately from its reported quantity", async (spanSource, label) => {
	const meter = { name: "day", spanSource, quantity: { unit: "requests", used: 3 } };
	writeFileSync(view, JSON.stringify([{ provider: "provider", meters: [meter] }]));
	expect(await readRouterQuota(dir, NOW)).toEqual([
		{ label, head: { kind: "text", text: "3 requests" }, basis: "reported", expired: false, old: false },
	]);
});

it("returns rows that callers cannot mutate", async () => {
	writeFileSync(view, validView);
	const rows = await readRouterQuota(dir, NOW);
	const row = rows[0];
	if (row?.head.kind !== "text") throw new Error("expected one text row");
	expect(row.head.text).toMatch(/^blocked until /);
	// @ts-expect-error the reader result is readonly
	rows.push(row);
	// @ts-expect-error row fields are readonly
	row.label = "changed";
	// @ts-expect-error head variants are readonly
	row.head.text = "changed";
});

it("clips long names but keeps span and stale qualifiers within the label limit", async () => {
	const giant = "x".repeat(10_000);
	const clipped = `${"x".repeat(39)}…`;
	writeFileSync(
		view,
		JSON.stringify([
			{
				provider: giant,
				display: { full: giant },
				snapshot: {
					status: "stale",
					windows: [{ name: giant, families: [giant], usedPercent: 5, spanSource: "inferred" }],
				},
				meters: [{ name: giant, families: [giant], spanSource: "assumed", quantity: { unit: "requests", used: 1 } }],
				pools: [{ name: giant, unit: "usd", balance: 2 }],
				marks: [{ window: giant, families: [giant], until: NOW + 60_000 }],
			},
		]),
	);
	const labels = (await readRouterQuota(dir, NOW)).map((row) => row.label);
	expect(labels).toEqual([
		`${clipped}/${clipped} ${clipped} (inferred span) (stale)`,
		`${clipped}/${clipped} ${clipped} (assumed span) (stale)`,
		`${clipped} ${clipped} (stale)`,
		`${clipped}/${clipped} ${clipped}`,
	]);
	expect(Math.max(...labels.map((l) => l.length))).toBeLessThanOrEqual(QUOTA_LABEL_MAX);
});
