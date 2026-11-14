import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main, run } from "../../src/stats/cli.ts";
import { FAILURE_LIMIT } from "../../src/stats/snapshot.ts";
import { assistantLine, at, sessionFile } from "./fixtures.ts";
import { seedHarnessHome } from "./harness/home.ts";

let dir: string;
let source: string;
let viewer: string;
let output: string;
const argv = process.argv;
const exitCode = process.exitCode;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "stats-cli-"));
	source = join(dir, "source");
	viewer = join(dir, "viewer");
	output = join(dir, "output");
});
afterEach(() => {
	process.argv = argv;
	process.exitCode = exitCode;
	vi.restoreAllMocks();
	rmSync(dir, { recursive: true, force: true });
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
		expect(error).toHaveBeenCalledWith("opencode: scan incomplete, kept what was last published");
		// and says so when the previous snapshot cannot be read either
		writeFileSync(join(JSON.parse(log.mock.calls[2]?.[0] as string).snapshotDir, "manifest.json"), "{");
		await main();
		expect(JSON.parse(log.mock.calls[3]?.[0] as string).harnesses.opencode.failed).toBe("lost");
		expect(error).toHaveBeenCalledWith("opencode: scan incomplete, last published contents unreadable, dropped");
		expect(process.exitCode ?? 0).toBe(exitCode ?? 0);
		for (const argv of [
			["--replace-harnesses", "--replace-harnesses"],
			["--replace-harnesses", "x"],
		]) {
			process.argv = ["node", "pi-stats-export", "export", "--agent-dir", source, "--output", output, ...argv];
			await expect(main()).rejects.toThrow("usage: export");
		}
	});

	it("keeps Codex data when --codex-dir points nowhere, and exits nonzero after repeated failures", async () => {
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
		for (let run = 1; run <= FAILURE_LIMIT; run++) {
			process.argv = [...base, "--codex-dir", join(dir, "nonexistent")];
			await main();
			const status = JSON.parse(log.mock.calls[run]?.[0] as string).harnesses.codex;
			expect(status).toMatchObject({ failed: "kept", consecutiveFailures: run });
			expect(process.exitCode ?? 0).toBe(run >= FAILURE_LIMIT ? 1 : 0);
		}
		expect(error).toHaveBeenCalledWith(`codex: failed ${FAILURE_LIMIT} exports in a row`);
		process.exitCode = 0; // Bun cannot restore an unset exit code, so leave a clean one
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
