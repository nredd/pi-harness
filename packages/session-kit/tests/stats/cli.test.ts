import { mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTestTempDir } from "@nredd/pi-test-lib/temp-dir";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main, run } from "../../src/stats/cli.ts";
import { assistantLine, at, sessionFile } from "../fixtures/stats/fixtures.ts";
import { seedHarnessHome } from "../fixtures/stats/harness/home.ts";

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
				"clock-rollback, unreadable-history and missing-manifest safeguards and unfreezing recovery files; drops " +
				"published history absent from the scan (sealed months included), and viewers holding a newer snapshot never import it; " +
				"they accept this machine again only from a later export timestamped at or after the snapshot they hold",
		);
	});

	it("cleans recovery only on its own command with only its own flags", async () => {
		seed(source);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const clean = ["node", "pi-stats-export", "clean-recovery", "--agent-dir", source, "--output", output];
		process.argv = clean;
		await expect(main()).rejects.toThrow("Recovery cleanup refused: no outbox for this machine");
		process.argv = ["node", "pi-stats-export", "export", "--agent-dir", source, "--output", output];
		await main();
		process.argv = clean;
		await main();
		const cleaned = JSON.parse(log.mock.calls[1]?.[0] as string);
		expect(cleaned).toMatchObject({ removed: [], kept: [] });
		for (const extra of [["--input", output], ["--harness", "pi"], ["--replace-harnesses"]]) {
			process.argv = [...clean, ...extra];
			await expect(main()).rejects.toThrow("usage: export");
		}
		process.argv = ["node", "pi-stats-export", "clean-recovery", "--agent-dir", source];
		await expect(main()).rejects.toThrow("clean-recovery --agent-dir DIR --output OUT");
	});

	it("requires an explicit agent directory for cleanup", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(Date, "now").mockReturnValue(at("2026-11-02", 3));
		const path = join(source, "sessions", "project", "session.jsonl");
		const first = assistantLine({ ms: at("2026-11-02", 1), provider: "provider", model: "model", input: 1 });
		const second = assistantLine({ ms: at("2026-11-02", 2), provider: "provider", model: "model", input: 2 });
		const exported = ["node", "pi-stats-export", "export", "--agent-dir", source, "--output", output];
		sessionFile(path, { startMs: at("2026-11-02", 1), lines: [first] });
		process.argv = exported;
		await main();
		const { snapshotDir } = JSON.parse(log.mock.calls[0]?.[0] as string);
		// An unreadable manifest freezes the first generation, which the next export then covers.
		writeFileSync(join(snapshotDir, "manifest.json"), "corrupt");
		sessionFile(path, { startMs: at("2026-11-02", 1), lines: [first, second] });
		vi.spyOn(console, "error").mockImplementation(() => {});
		await main();
		const listing = () => readdirSync(dir, { recursive: true }).map(String).sort();
		const before = listing();
		vi.stubEnv("PI_CODING_AGENT_DIR", source);
		try {
			process.argv = ["node", "pi-stats-export", "clean-recovery", "--output", output];
			await expect(main()).rejects.toThrow("clean-recovery --agent-dir DIR --output OUT");
		} finally {
			vi.unstubAllEnvs();
		}
		expect(listing()).toEqual(before);
		// The same files are deletable once the installation is named.
		process.argv = ["node", "pi-stats-export", "clean-recovery", "--agent-dir", source, "--output", output];
		await main();
		expect(JSON.parse(log.mock.calls[2]?.[0] as string).removed).toHaveLength(1);
	});

	it("prints recovery cleanup warnings and still exits 0", async () => {
		process.exitCode = 0; // Bun cannot restore an unset exit code left by an earlier test
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const warning = "redundant recovery file removal failed (they stay protected): EACCES=1";
		vi.resetModules();
		vi.doMock("../../src/stats/snapshot.ts", () => ({
			cleanRecovery: async () => ({
				machineId: "m",
				snapshotDir: "d",
				removed: [],
				failed: ["f"],
				kept: [],
				warnings: [warning],
			}),
			exportStats: async () => ({}),
			importStats: async () => ({}),
		}));
		try {
			const cli = await import("../../src/stats/cli.ts");
			process.argv = ["node", "pi-stats-export", "clean-recovery", "--agent-dir", source, "--output", output];
			await cli.run();
		} finally {
			vi.doUnmock("../../src/stats/snapshot.ts");
			vi.resetModules();
		}
		expect(JSON.parse(log.mock.calls[0]?.[0] as string).failed).toEqual(["f"]);
		expect(error).toHaveBeenCalledExactlyOnceWith(warning);
		expect(process.exitCode ?? 0).toBe(0);
	});

	it("exits nonzero when the manifest changed under cleanup", async () => {
		process.exitCode = 0;
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "log").mockImplementation(() => {});
		const warning = "recovery cleanup stopped: the active manifest changed; 1 redundant files left in place";
		vi.resetModules();
		vi.doMock("../../src/stats/snapshot.ts", () => ({
			cleanRecovery: async () => ({
				machineId: "m",
				snapshotDir: "d",
				removed: [],
				failed: [],
				kept: [{ file: "f", reason: "changed" }],
				warnings: [warning],
			}),
			exportStats: async () => ({}),
			importStats: async () => ({}),
		}));
		try {
			const cli = await import("../../src/stats/cli.ts");
			process.argv = ["node", "pi-stats-export", "clean-recovery", "--agent-dir", source, "--output", output];
			await cli.run();
		} finally {
			vi.doUnmock("../../src/stats/snapshot.ts");
			vi.resetModules();
		}
		expect(error).toHaveBeenCalledExactlyOnceWith(warning);
		expect(process.exitCode).toBe(1);
	});

	it("reports a non-Error failure generically", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.resetModules();
		vi.doMock("../../src/stats/snapshot.ts", () => ({
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
