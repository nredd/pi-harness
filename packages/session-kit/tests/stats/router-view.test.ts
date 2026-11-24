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

// The fixture is the subscription-router writer's output for anthropic, openai-codex and a synthetic
// antigravity reading; the router package asserts its writer still emits it field for field, and
// scripts/tests/test_router_view_fixture.py keeps both copies identical.
it("reads the router writer's view for anthropic, openai-codex and antigravity", async ({ onTestFinished }) => {
	const root = makeTestTempDir("kit-router-view-", onTestFinished);
	await place(root);
	const rows = await readRouterQuota(root, NOW);
	expect(Object.fromEntries(rows.map(({ label, head }) => [label, head]))).toEqual({
		"Anthropic five_hour": { kind: "gauge", percent: 25 },
		"OpenAI 5h (assumed span)": { kind: "gauge", percent: 15 },
		"Gemini 5h": { kind: "gauge", percent: 35 },
	});
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
