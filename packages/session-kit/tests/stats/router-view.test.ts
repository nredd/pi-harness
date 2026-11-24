import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTestTempDir } from "@nredd/pi-test-lib/temp-dir";
import { expect, it } from "vitest";
import { readRouterQuota } from "../../src/stats/router-quota.ts";

const NOW = 1_800_000_000_000;
const fixture = new URL("../fixtures/router-view.json", import.meta.url);

async function place(root: string): Promise<string> {
	const dir = join(root, "router-state", "v1");
	await mkdir(dir, { recursive: true });
	const path = join(dir, "view.json");
	await copyFile(fixture, path);
	return path;
}

// The router package checks each fixture view against its writer output, and
// scripts/tests/test_router_view_fixture.py keeps both copies identical.
it("reads fresh and stale gauges, a meter, a pool and a mark from the router writer fixture", async ({
	onTestFinished,
}) => {
	const root = makeTestTempDir("kit-router-view-", onTestFinished);
	await place(root);
	const rows = await readRouterQuota(root, NOW);
	expect(rows.map(({ label, head, basis, old }) => [label, head, basis, old])).toEqual([
		["Gemini 5h", { kind: "gauge", percent: 35 }, "reported", false],
		["Anthropic five_hour", { kind: "gauge", percent: 25 }, "reported", false],
		["OpenAI 5h (assumed span)", { kind: "gauge", percent: 15 }, "reported", false],
		["Producing collector weekly (stale)", { kind: "gauge", percent: 40 }, "reported", true],
		["Producing collector daily (stale)", { kind: "text", text: "1/5 requests" }, "reported", true],
		["Producing collector paid (stale)", { kind: "text", text: "10 credits balance" }, undefined, true],
		["Producing collector daily", { kind: "text", text: "blocked until 2027-01-15 08:01 UTC" }, "observed", false],
	]);
});

it("accepts exactly the 1 MiB the router writer caps at and rejects one byte more", async ({ onTestFinished }) => {
	const root = makeTestTempDir("kit-router-view-", onTestFinished);
	const path = await place(root);
	const row = JSON.stringify([{ provider: "faux", marks: [{ window: "daily", until: NOW + 60_000 }] }]);
	const atLimit = row.padEnd(1024 * 1024, " ");
	await writeFile(path, atLimit);
	expect(await readRouterQuota(root, NOW)).toHaveLength(1);
	await writeFile(path, `${atLimit} `);
	expect(await readRouterQuota(root, NOW)).toEqual([]);
});
