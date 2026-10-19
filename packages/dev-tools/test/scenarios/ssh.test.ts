import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Harness } from "@earendil-works/pi-coding-agent/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDevTools } from "../../src/index.ts";
import { runTools, startSession } from "./support.ts";

const FAKE_SSH = join(import.meta.dirname, "..", "fixtures", "ssh", "fake-ssh");

describe("ssh_exec through a real session", () => {
	let harness: Harness;
	let work: string;

	beforeAll(async () => {
		work = mkdtempSync(join(tmpdir(), "pi-dev-tools-ssh-scenario-"));
		// `down` fails like a dead connection (exit 255, nothing run); any other known host runs locally.
		harness = await startSession(
			createDevTools({ ssh: { knownHosts: () => new Set(["home", "down"]), sshBin: FAKE_SSH } }),
			work,
		);
	});

	afterAll(() => {
		harness.cleanup();
		rmSync(work, { recursive: true, force: true });
	});

	it("validates the host, runs the script, and separates remote from ssh failures", async () => {
		const marker = join(work, "touched");
		const [failing, ok, down, unknown, injected] = await runTools(harness, [
			{ name: "ssh_exec", args: { host: "home", command: "echo hi; exit 4" } },
			{ name: "ssh_exec", args: { host: "home", command: `touch ${marker}`, cwd: work } },
			{ name: "ssh_exec", args: { host: "down", command: "id" } },
			{ name: "ssh_exec", args: { host: "evil", command: "id" } },
			{ name: "ssh_exec", args: { host: "-oProxyCommand=id", command: "id" } },
		]);

		// A non-zero remote exit is a normal result (think `grep`), not a tool error.
		expect(failing.isError).toBe(false);
		expect(failing.structured).toEqual({
			host: "home",
			remoteExit: 4,
			sshExit: 0,
			state: "command-failed",
			truncated: false,
		});
		expect(failing.text).toContain("hi");
		expect(ok.isError, ok.text).toBe(false);
		expect((ok.structured as { state: string }).state).toBe("ok");
		expect(existsSync(marker)).toBe(true);
		expect(down.isError).toBe(true);
		expect(down.structured).toMatchObject({ state: "ssh-failed", remoteExit: null });
		expect(down.text).toContain("may not have run");
		for (const refused of [unknown, injected]) {
			expect(refused.isError).toBe(true);
			expect(refused.text).toMatch(/not a Host entry|not a plain host alias/);
		}
	});
});
