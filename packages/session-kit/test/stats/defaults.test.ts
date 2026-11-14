import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { freshnessLines } from "../../src/stats/freshness.ts";
import { CACHE_VERSION } from "../../src/stats/load.ts";
import { loadCombined, machineIdentity } from "../../src/stats/snapshot.ts";
import { assistantLine, sessionFile } from "./fixtures.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "kit-default-stats-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", dir);
	vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", undefined);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	rmSync(dir, { recursive: true, force: true });
});

it("uses the viewer clock when freshness callers omit now", () => {
	const now = Date.parse("2026-10-22T12:00:00Z");
	vi.spyOn(Date, "now").mockReturnValue(now);
	const lines = freshnessLines({
		machines: 1,
		remoteMachines: 0,
		incomplete: false,
		problems: [],
		importedAt: now - 60000,
	});
	expect(lines[0]).toBe("Viewer last import: 2026-10-22T11:59:00.000Z (1m ago)");
	expect(lines).toContain("Per-machine freshness unknown (no source metadata).");
});

it("persists an omitted-directory installation identity under the isolated agent dir", async () => {
	const identity = await machineIdentity();
	expect(identity).toEqual({ machineId: expect.stringMatching(/^[a-f0-9-]{36}$/), label: "Pi machine" });
	expect(JSON.parse(readFileSync(join(dir, "pi-session-kit", "machine.json"), "utf8"))).toEqual(identity);
	expect(await machineIdentity()).toEqual(identity);
});

it("loads real local history and its cache when callers omit the combined-loader directory", async () => {
	const ms = Date.parse("2026-10-22T12:00:00Z");
	sessionFile(join(dir, "sessions", "synthetic.jsonl"), {
		startMs: ms,
		lines: [assistantLine({ ms, provider: "synthetic", model: "fixture", input: 7, output: 3, cost: 0.25 })],
	});
	const loaded = await loadCombined();
	expect(loaded.calls).toEqual([
		expect.objectContaining({ provider: "synthetic", model: "fixture", input: 7, output: 3, cost: 0.25 }),
	]);
	expect(loaded.sessions).toHaveLength(1);
	expect(loaded.errors).toBe(0);
	expect(loaded.badLines).toBe(0);
	expect(loaded.coverage).toMatchObject({ machines: 1, remoteMachines: 0, incomplete: false, problems: [] });
	expect(loaded.coverage.sources).toEqual([{ ...(await machineIdentity()), local: true, incomplete: false }]);
	expect(JSON.parse(readFileSync(join(dir, "pi-session-kit", "stats-cache.json"), "utf8")).version).toBe(CACHE_VERSION);
});
