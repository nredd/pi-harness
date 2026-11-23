import { mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { lstat, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTestTempDir } from "@nredd/pi-test-lib/temp-dir";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main, run } from "../../src/stats/cli.ts";
import { assistantLine, at, sessionFile } from "../fixtures/stats/fixtures.ts";
import { seedHarnessHome } from "../fixtures/stats/harness/home.ts";

vi.mock("node:fs/promises", async (original) => {
	const actual = await original<typeof import("node:fs/promises")>();
	return { ...actual, lstat: vi.fn(actual.lstat), rmdir: vi.fn(actual.rmdir) };
});

let dir: string;
let source: string;
let viewer: string;
let output: string;
const argv = process.argv;
const exitCode = process.exitCode;

beforeEach(({ onTestFinished }) => {
	dir = makeTestTempDir("stats-cli-", onTestFinished);
	source = join(dir, "source");
	viewer = join(dir, "viewer");
	output = join(dir, "output");
});
afterEach(() => {
	process.argv = argv;
	process.exitCode = exitCode;
	vi.restoreAllMocks();
	vi.mocked(lstat).mockRestore();
	vi.mocked(rmdir).mockRestore();
});

/** Seed one counted assistant call under an injected agent directory. */
function seed(agentDir: string): void {
	sessionFile(join(agentDir, "sessions", "project", "session.jsonl"), {
		startMs: at("2026-10-01"),
		lines: [assistantLine({ ms: at("2026-10-01"), provider: "provider", model: "model", input: 1 })],
	});
}

describe("stats CLI", () => {
	it("imports source silently when the importer's entrypoint cannot be resolved", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		process.argv = [process.execPath, join(dir, "nonexistent-importer")];
		vi.resetModules();
		await expect(import("../../src/stats/cli.ts")).resolves.toHaveProperty("main");
		expect(log).not.toHaveBeenCalled();
		expect(error).not.toHaveBeenCalled();
		expect(process.exitCode ?? 0).toBe(exitCode ?? 0);
	});

	it("exports and imports explicit fixture directories from real argv", async () => {
		seed(source);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		process.argv = ["node", "pi-stats-export", "export", "--agent-dir", source, "--output", output];
		await main();
		const exported = JSON.parse(log.mock.calls[0]?.[0] as string);
		expect(exported.snapshotDir).toBe(join(output, "machines", exported.machineId));

		process.argv = ["node", "pi-stats-export", "import", "--agent-dir", viewer, "--input", output];
		await main();
		expect(JSON.parse(log.mock.calls[1]?.[0] as string)).toMatchObject({ imported: 1, problems: [] });
	});

	it("reports a suspected stale lock on repeated exports while a fresh import works", async () => {
		seed(source);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		process.argv = ["node", "pi-stats-export", "export", "--agent-dir", source, "--output", output];
		await main();
		const exported = JSON.parse(log.mock.calls[0]?.[0] as string);
		const lock = join(exported.snapshotDir, ".export.lock");
		const path = join(exported.snapshotDir, "manifest.json");
		const before = readFileSync(path);
		const now = at("2026-11-02");
		const old = new Date(now - 7_200_000);
		vi.spyOn(Date, "now").mockReturnValue(now);
		mkdirSync(lock);
		utimesSync(lock, old, old);
		const diagnostic =
			`Suspected stale export lock ${JSON.stringify(lock)} (age 7200s); ` +
			"verify no export is running before removing the lock directory, then retry";
		for (let attempt = 1; attempt <= 2; attempt++) {
			process.exitCode = 0;
			await run();
			expect(process.exitCode).toBe(1);
			expect(error).toHaveBeenNthCalledWith(attempt, diagnostic);
			expect(readdirSync(exported.snapshotDir)).toContain(".export.lock");
			expect(readFileSync(path)).toEqual(before);
		}
		expect(log).toHaveBeenCalledOnce();
		process.exitCode = 0;
		process.argv = ["node", "pi-stats-export", "import", "--agent-dir", viewer, "--input", output];
		await run();
		expect(process.exitCode).toBe(0);
		expect(JSON.parse(log.mock.calls[1]?.[0] as string)).toMatchObject({ imported: 1, problems: [] });
	});

	it("ends an owner-action refusal with one fixed pi-stats-refusal line, and nothing else with one", async () => {
		seed(source);
		const roots = seedHarnessHome(join(dir, "home"));
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const wide = ["--agent-dir", source, "--output", output, "--claude-dir", roots.claude, "--harness", "pi,claude"];
		const attempt = async (args: string[]): Promise<unknown[][]> => {
			error.mockClear();
			process.exitCode = 0;
			process.argv = ["node", "pi-stats-export", ...args];
			await run();
			expect(process.exitCode).toBe(1);
			return error.mock.calls;
		};
		const refusal = (code: string): unknown[] => [`pi-stats-refusal: {"code":"${code}"}`];
		// Publish mid-month, so a clock a day behind stays in its month and one a month behind does not.
		const wall = new Date();
		const published = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), 15);
		const clock = vi.spyOn(Date, "now").mockReturnValue(published);
		process.argv = ["node", "pi-stats-export", "export", ...wide];
		await main();
		const exported = JSON.parse(log.mock.calls[0]?.[0] as string);
		const manifestPath = join(exported.snapshotDir, "manifest.json");
		const shard = JSON.parse(readFileSync(manifestPath, "utf8")).shards[0].file as string;

		expect(await attempt(["export", "--agent-dir", source, "--output", output])).toEqual([
			[expect.stringMatching(/^Refusing to publish a narrower harness set/)],
			refusal("harness-set-narrowed"),
		]);
		clock.mockReturnValue(1);
		expect(await attempt(["export", ...wide])).toEqual([
			[expect.stringMatching(/^Published usage manifest exportedAt .* is more than 366 days ahead/)],
			refusal("watermark-ahead"),
		]);
		// A clock a month behind is refused, but that clears with time: retryable, so no code.
		clock.mockReturnValue(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth() - 1, 15));
		expect(await attempt(["export", ...wide])).toEqual([
			[expect.stringMatching(/^Clock .* is in an earlier month than the next export/)],
		]);
		clock.mockRestore();
		const bytes = readFileSync(join(exported.snapshotDir, shard));
		writeFileSync(join(exported.snapshotDir, shard), "corrupt");
		expect(await attempt(["export", ...wide])).toEqual([
			[expect.stringMatching(/^Published usage history is unreadable/)],
			refusal("history-unreadable"),
		]);
		writeFileSync(join(exported.snapshotDir, shard), bytes);
		// A corrupt state file holds the salt: its contents never reach stderr, only a fixed reason.
		const state = join(source, "pi-session-kit", "export-state.json");
		const salt = readFileSync(state);
		writeFileSync(state, '{"salt":"SECRET-CANARY');
		expect(await attempt(["export", ...wide])).toEqual([
			[`Invalid export state in ${JSON.stringify(state)}: not valid JSON`],
			refusal("export-state-invalid"),
		]);
		writeFileSync(state, salt);
		const manifest = readFileSync(manifestPath);
		rmSync(manifestPath);
		expect(await attempt(["export", ...wide])).toEqual([
			[expect.stringMatching(/^Published usage manifest is missing/)],
			refusal("manifest-missing"),
		]);
		writeFileSync(manifestPath, manifest);

		// Contention, usage and anything else unclassified carry no code: callers retry those.
		mkdirSync(join(exported.snapshotDir, ".export.lock"));
		expect(await attempt(["export", ...wide])).toEqual([[expect.stringMatching(/^Export lock is held/)]]);
		rmSync(join(exported.snapshotDir, ".export.lock"), { recursive: true });
		expect(await attempt(["export", "--bogus"])).toEqual([[expect.stringMatching(/^usage: export/)]]);
		// A clock behind the published export in its month publishes after it: a warning, never a code.
		vi.spyOn(Date, "now").mockReturnValue(published - 86_400_000);
		error.mockClear();
		process.exitCode = 0;
		process.argv = ["node", "pi-stats-export", "export", ...wide];
		await run();
		expect(process.exitCode).toBe(0);
		expect(log).toHaveBeenCalledTimes(2);
		expect(error.mock.calls).toEqual([[expect.stringMatching(/^clock is behind the last published export/)]]);
	});

	it("keeps a refusal's code, and its trailer last, when releasing the lock also fails", async () => {
		seed(source);
		const roots = seedHarnessHome(join(dir, "home"));
		vi.spyOn(console, "log").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		process.argv = ["node", "pi-stats-export", "export", "--agent-dir", source, "--output", output];
		process.argv.push("--claude-dir", roots.claude, "--harness", "pi,claude");
		await main();
		vi.mocked(rmdir).mockRejectedValueOnce(Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }));
		process.argv = ["node", "pi-stats-export", "export", "--agent-dir", source, "--output", output];
		process.exitCode = 0;
		await run();
		expect(process.exitCode).toBe(1);
		const lines = error.mock.calls.map(([line]) => line as string);
		expect(lines).toHaveLength(2);
		expect(lines[0]).toMatch(/^Refusing to publish a narrower harness set.*\\ncould not release export lock /);
		expect(lines.at(-1)).toBe('pi-stats-refusal: {"code":"harness-set-narrowed"}');
		process.exitCode = 0; // Bun cannot restore an unset exit code left by this test
	});

	it("never prints malformed identity bytes, and gives no refusal code", async () => {
		const identity = join(source, "pi-session-kit", "machine.json");
		mkdirSync(join(source, "pi-session-kit"), { recursive: true });
		writeFileSync(identity, '{"token":SECRET-IDENTITY-CANARY}');
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		process.argv = ["node", "pi-stats-export", "export", "--agent-dir", source, "--output", output];
		process.exitCode = 0;
		await run();
		expect(process.exitCode).toBe(1);
		expect(error).toHaveBeenCalledExactlyOnceWith(
			`Invalid installation identity in ${JSON.stringify(identity)}: not valid JSON`,
		);
		process.exitCode = 0; // Bun cannot restore an unset exit code left by this test
	});

	it("escapes control characters in a diagnostic, so a path cannot forge the trailer", async () => {
		const forged = join(dir, 'x\npi-stats-refusal: {"code":"history-unreadable"}\n\u001b[2K\ty');
		const failure = Object.assign(new Error(`EIO: i/o error, lstat '${forged}'`), { code: "EIO", path: forged });
		vi.mocked(lstat).mockRejectedValueOnce(failure);
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		process.argv = ["node", "pi-stats-export", "export", "--agent-dir", source, "--output", output];
		process.exitCode = 0;
		await run();
		expect(process.exitCode).toBe(1);
		// One line, no control characters: an unclassified failure never ends in a refusal-shaped line.
		expect(error).toHaveBeenCalledExactlyOnceWith(
			`EIO: i/o error, lstat '${join(dir, 'x\\npi-stats-refusal: {"code":"history-unreadable"}\\n\\u001b[2K\\ty')}'`,
		);
		process.exitCode = 0; // Bun cannot restore an unset exit code left by this test
	});

	it("exports sessions from an explicit --sessions-dir instead of the agent directory", async () => {
		seed(source);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const empty = join(dir, "empty-agent");
		const argvTail = ["--agent-dir", empty, "--output", output];
		process.argv = ["node", "pi-stats-export", "export", ...argvTail, "--sessions-dir", join(source, "sessions")];
		await main();
		const exported = JSON.parse(log.mock.calls[0]?.[0] as string);

		process.argv = ["node", "pi-stats-export", "import", "--agent-dir", viewer, "--input", output];
		await main();
		expect(JSON.parse(log.mock.calls[1]?.[0] as string)).toMatchObject({ imported: 1, problems: [] });
		expect(exported.snapshotDir).toBe(join(output, "machines", exported.machineId));
		// manifest plus the one shard holding the seeded call: the sessions came from --sessions-dir
		expect(readdirSync(exported.snapshotDir)).toHaveLength(2);
	});

	it("exports the selected harnesses from explicit root flags", async () => {
		const roots = seedHarnessHome(join(dir, "home"));
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		process.argv = [
			"node",
			"pi-stats-export",
			"export",
			...["--agent-dir", source, "--output", output, "--harness", "claude,codex,opencode"],
			...["--claude-dir", roots.claude, "--codex-dir", roots.codex, "--opencode-db", roots.opencode],
		];
		await main();
		const exported = JSON.parse(log.mock.calls[0]?.[0] as string);
		expect(Object.keys(exported.harnesses)).toEqual(["claude", "codex", "opencode"]);
		expect(exported.harnesses.claude).toEqual({ found: true, problems: [] });
	});

	it("refuses a narrower harness set unless --replace-harnesses, and reports a failed harness on stderr", async () => {
		const roots = seedHarnessHome(join(dir, "home"));
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const wide = ["--agent-dir", source, "--output", output, "--claude-dir", roots.claude, "--harness", "pi,claude"];
		process.argv = ["node", "pi-stats-export", "export", ...wide];
		await main();
		process.argv = ["node", "pi-stats-export", "export", "--agent-dir", source, "--output", output, "--harness", "pi"];
		await expect(main()).rejects.toThrow("--replace-harnesses");
		process.argv = [
			"node",
			"pi-stats-export",
			"export",
			"--agent-dir",
			source,
			"--output",
			output,
			"--replace-harnesses",
		];
		await main();
		expect(log).toHaveBeenCalledTimes(2);
		expect(JSON.parse(log.mock.calls[1]?.[0] as string).harnesses).toBeUndefined();
		// a harness that cannot be read is reported without failing the run
		const opencode = join(dir, "home", "bad.db");
		writeFileSync(opencode, "not a database");
		process.argv = [
			...["node", "pi-stats-export", "export", "--agent-dir", source, "--output", output],
			...["--harness", "pi,opencode", "--opencode-db", opencode, "--replace-harnesses"],
		];
		await main();
		expect(JSON.parse(log.mock.calls[2]?.[0] as string).harnesses.opencode.failed).toBe("kept");
		expect(error).toHaveBeenCalledWith("opencode: scan incomplete (1 in a row), kept what was last published");
		// and says so when the previous snapshot cannot be read either
		writeFileSync(join(JSON.parse(log.mock.calls[2]?.[0] as string).snapshotDir, "manifest.json"), "{");
		await main();
		expect(JSON.parse(log.mock.calls[3]?.[0] as string).harnesses.opencode.failed).toBe("lost");
		expect(error).toHaveBeenCalledWith(
			"opencode: scan incomplete (2 in a row), last published contents unreadable, dropped",
		);
		expect(process.exitCode ?? 0).toBe(exitCode ?? 0);
		for (const argv of [
			["--replace-harnesses", "--replace-harnesses"],
			["--replace-harnesses", "x"],
		]) {
			process.argv = ["node", "pi-stats-export", "export", "--agent-dir", source, "--output", output, ...argv];
			await expect(main()).rejects.toThrow("usage: export");
		}
	});

	it("keeps Codex data when --codex-dir points nowhere, and still exits 0 however often in a row", async () => {
		const roots = seedHarnessHome(join(dir, "home"));
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const base = [
			"node",
			"pi-stats-export",
			"export",
			"--agent-dir",
			source,
			"--output",
			output,
			"--harness",
			"pi,codex",
		];
		process.argv = [...base, "--codex-dir", roots.codex];
		await main();
		for (let run = 1; run <= 4; run++) {
			process.argv = [...base, "--codex-dir", join(dir, "nonexistent")];
			await main();
			const status = JSON.parse(log.mock.calls[run]?.[0] as string).harnesses.codex;
			expect(status).toMatchObject({ failed: "kept", consecutiveFailures: run });
			// published, so success however many times in a row: the failure is data, not an exit code
			expect(process.exitCode ?? 0).toBe(0);
		}
		expect(error).toHaveBeenCalledWith("codex: scan incomplete (4 in a row), kept what was last published");
		// the data survived all of it
		const manifestDir = JSON.parse(log.mock.calls[1]?.[0] as string).snapshotDir;
		expect(readdirSync(manifestDir).length).toBeGreaterThan(1);
	});

	it("reports a stale harness on import", async () => {
		const roots = seedHarnessHome(join(dir, "home"));
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		process.argv = [
			"node",
			"pi-stats-export",
			"export",
			"--agent-dir",
			source,
			"--output",
			output,
			"--harness",
			"pi,codex",
			"--codex-dir",
			roots.codex,
		];
		await main();
		const { snapshotDir } = JSON.parse(log.mock.calls[0]?.[0] as string);
		const path = join(snapshotDir, "manifest.json");
		const manifest = JSON.parse(readFileSync(path, "utf8"));
		manifest.lastGoodAt.codex = manifest.exportedAt - 3 * 24 * 60 * 60 * 1000;
		writeFileSync(path, JSON.stringify(manifest));
		process.argv = ["node", "pi-stats-export", "import", "--agent-dir", viewer, "--input", output];
		await main();
		expect(JSON.parse(log.mock.calls[1]?.[0] as string).stale).toHaveLength(1);
		expect(error).toHaveBeenCalledWith(expect.stringMatching(/: codex not read cleanly since \d{4}-/));
		expect(process.exitCode ?? 0).toBe(exitCode ?? 0);
	});

	it("rejects unknown or repeated harnesses and export-only flags on import", async () => {
		const base = ["node", "pi-stats-export", "export", "--agent-dir", source, "--output", output];
		for (const harness of ["gemini", "pi,pi", "pi,", ""]) {
			process.argv = [...base, "--harness", harness];
			await expect(main()).rejects.toThrow("usage: export");
		}
		for (const flag of [
			"--harness",
			"--claude-dir",
			"--codex-dir",
			"--opencode-db",
			"--sessions-dir",
			"--replace-harnesses",
		]) {
			process.argv = ["node", "pi-stats-export", "import", "--agent-dir", viewer, "--input", output, flag, "pi"];
			await expect(main()).rejects.toThrow("usage: export");
		}
	});

	it("rejects an export without --output and an import without --input", async () => {
		process.argv = ["node", "pi-stats-export", "export", "--agent-dir", source];
		await expect(main()).rejects.toThrow("usage: export");
		process.argv = ["node", "pi-stats-export", "import", "--agent-dir", source];
		await expect(main()).rejects.toThrow("usage: export");
		// The usage text names what replacement bypasses and costs.
		await expect(main()).rejects.toThrow(
			"--replace-harnesses: publish this scan as a replacement generation, bypassing the narrower-set, " +
				"unreadable-history, missing-manifest and later-month safeguards and unfreezing recovery files; drops " +
				"published history absent from the scan (sealed months included). Viewers holding a snapshot newer than " +
				"the replacement keep it until this machine exports a later one\n" +
				"  A clock behind the last published export in its month still publishes, just after it, with a warning",
		);
	});

	it("reports a non-Error failure generically", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.resetModules();
		vi.doMock("../../src/stats/snapshot.ts", () => ({
			ExportRefusal: class ExportRefusal extends Error {},
			IncompleteScan: class IncompleteScan extends Error {},
			exportStats: async () => {
				throw "plain string failure";
			},
			importStats: async () => ({}),
		}));
		try {
			const cli = await import("../../src/stats/cli.ts");
			process.argv = ["node", "pi-stats-export", "export", "--agent-dir", source, "--output", output];
			await cli.run();
		} finally {
			vi.doUnmock("../../src/stats/snapshot.ts");
			vi.resetModules();
		}
		expect(error).toHaveBeenCalledExactlyOnceWith("Stats operation failed");
		expect(process.exitCode).toBe(1);
	});

	it("prints a warning from a published export and still exits 0", async () => {
		process.exitCode = 0; // Bun cannot restore an unset exit code left by an earlier test
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		vi.resetModules();
		vi.doMock("../../src/stats/snapshot.ts", () => ({
			exportStats: async () => ({ machineId: "m", snapshotDir: "d", warnings: ["export state not recorded"] }),
			importStats: async () => ({}),
		}));
		try {
			const cli = await import("../../src/stats/cli.ts");
			process.argv = ["node", "pi-stats-export", "export", "--agent-dir", source, "--output", output];
			await cli.run();
		} finally {
			vi.doUnmock("../../src/stats/snapshot.ts");
			vi.resetModules();
		}
		expect(JSON.parse(log.mock.calls[0]?.[0] as string).warnings).toEqual(["export state not recorded"]);
		expect(error).toHaveBeenCalledExactlyOnceWith("export state not recorded");
		expect(process.exitCode ?? 0).toBe(0);
	});

	it("runs itself when it is the process entrypoint", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		process.argv = ["node", fileURLToPath(new URL("../../src/stats/cli.ts", import.meta.url)), "unknown"];
		vi.resetModules();
		await import("../../src/stats/cli.ts");
		await vi.waitFor(() => expect(error).toHaveBeenCalledWith(expect.stringContaining("usage: export")));
		expect(process.exitCode).toBe(1);
	});

	it("reports partial imports and malformed argv with nonzero exit codes", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		process.argv = ["node", "pi-stats-export", "import", "--agent-dir", viewer, "--input", output];
		await main();
		expect(JSON.parse(log.mock.calls[0]?.[0] as string).problems).toContain("Unreadable machines directory");
		expect(error).toHaveBeenCalledWith("Unreadable machines directory");
		expect(process.exitCode).toBe(1);

		process.exitCode = undefined;
		process.argv = ["node", "pi-stats-export", "unknown"];
		await run();
		expect(error).toHaveBeenLastCalledWith(expect.stringContaining("usage: export"));
		expect(process.exitCode).toBe(1);

		process.exitCode = undefined;
		process.argv = ["node", "pi-stats-export", "export", "--output", output, "--output", output];
		await run();
		expect(error).toHaveBeenLastCalledWith(expect.stringContaining("usage: export"));
		expect(process.exitCode).toBe(1);
	});
});
