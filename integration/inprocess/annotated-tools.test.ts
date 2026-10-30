/** Real annotations consumed by the real Plan policy, never a copied admission table. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { Harness } from "@earendil-works/pi-coding-agent/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDevTools } from "../../packages/dev-tools/src/index.ts";
import { git, runTools } from "../../packages/dev-tools/test/scenarios/support.ts";
import { createSessionKit } from "../../packages/session-kit/src/index.ts";
import { ControlledProcesses, configFor, FakeClock } from "../../packages/session-kit/test/scenarios/support.ts";
import { isolateStackHome, loadFork, startStack } from "./support.ts";

const SSH = new URL("../../packages/dev-tools/test/fixtures/ssh/fake-ssh", import.meta.url).pathname;
const SCP = new URL("../../packages/dev-tools/test/fixtures/ssh/fake-scp", import.meta.url).pathname;

describe("Plan consumes stack annotations", () => {
	let home: Awaited<ReturnType<typeof isolateStackHome>>;
	let plan: ExtensionFactory;
	let h: Harness | undefined;
	let serial = 0;
	beforeAll(async () => {
		home = await isolateStackHome();
		plan = await loadFork("pi-plan-mode");
	});
	afterEach(async () => {
		if (h) {
			await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			h.cleanup();
			h = undefined;
		}
	});
	afterAll(() => home.cleanup());

	/** Seed safe roots and an actual git repository; no owner config or SSH connections. */
	async function open(extra: ExtensionFactory[] = []) {
		const cwd = join(home.root, `repo-${++serial}`);
		mkdirSync(cwd, { recursive: true });
		writeFileSync(join(cwd, "README.md"), "MUST NOT CHANGE\n");
		git(cwd, "init", "-q");
		git(cwd, "add", "README.md");
		git(cwd, "commit", "-q", "-m", "Initial");
		const cfg = join(home.root, "agent");
		mkdirSync(cfg, { recursive: true });
		writeFileSync(join(cfg, "pi-plan-mode.json"), JSON.stringify({ safeSubcommands: { ssh: ["home"] } }));
		h = await startStack({
			cwd,
			factories: [
				plan,
				createDevTools({ ssh: { knownHosts: () => new Set(["home"]), sshBin: SSH, scpBin: SCP } }),
				...extra,
			],
		});
		return h;
	}

	it("Plan admits annotated dev-tools reads", async () => {
		const h = await open();
		await h.session.prompt("/plan start");
		const results = await runTools(h, [
			{ name: "git_status", args: {} },
			{ name: "git_log", args: { max_count: 1 } },
			{ name: "git_worktree_list", args: {} },
			{ name: "ssh_exec", args: { host: "home", command: "ls /config" } },
		]);
		for (const result of results) {
			expect(result.text).not.toContain("Plan mode blocks");
			if (result.name !== "ssh_exec") expect(result.isError, result.text).toBe(false);
		}
	});

	it("Plan blocks mutating tools and unsafe typed ssh", async () => {
		const h = await open();
		const head = git(h.cwd, "rev-parse", "HEAD");
		const missing = join(h.cwd, "nope");
		const remote = join(h.cwd, "remote.txt");
		writeFileSync(remote, "MUST NOT COPY\n");
		await h.session.prompt("/plan start");
		const results = await runTools(h, [
			{ name: "git_commit", args: { subject: "Nope", paths: ["README.md"] } },
			{ name: "git_worktree_add", args: { branch: "nope" } },
			{ name: "git_worktree_remove", args: { path: missing } },
			{ name: "git_worktree_prune", args: { dry_run: true } },
			{ name: "ssh_exec", args: { host: "home", command: "rm -rf ~" } },
			{ name: "ssh_exec", args: { host: "home", command: "ls; rm x" } },
			{ name: "ssh_exec", args: { host: "evil", command: "ls" } },
			{ name: "ssh_pull", args: { host: "home", remote_path: remote, local_path: "README.md", overwrite: true } },
		]);
		for (const result of results) {
			expect(result.isError, result.text).toBe(true);
			expect(result.text).toContain("Plan mode blocks");
			expect(result.text).toContain(
				result.name === "ssh_exec" ? "blocks ssh_exec calls" : "not selected by the Plan policy",
			);
		}
		expect(readFileSync(join(h.cwd, "README.md"), "utf8")).toBe("MUST NOT CHANGE\n");
		expect(git(h.cwd, "rev-parse", "HEAD")).toBe(head);
		expect(git(h.cwd, "branch", "--list", "nope").trim()).toBe("");
		expect(existsSync(missing)).toBe(false);
	});

	it("Plan admits only monitor_read", async () => {
		const clock = new FakeClock();
		const processes = new ControlledProcesses(clock);
		const h = await open([
			createSessionKit({
				config: configFor("monitor"),
				agentDir: join(home.root, "kit"),
				monitorRoot: join(home.root, "monitors"),
				clock,
				spawnMonitor: processes.spawn,
			}),
		]);
		const [started] = await runTools(h, [
			{ name: "monitor_start", args: { name: "pre", argv: ["/bin/echo", "before-plan"] } },
		]);
		expect(started.isError, started.text).toBe(false);
		await processes.last.stdout("before-plan\n");
		await h.session.prompt("/plan start");
		const [read, start, stop] = await runTools(h, [
			{ name: "monitor_read", args: { id: "pre" } },
			{ name: "monitor_start", args: { name: "during", argv: ["/bin/echo", "MUST NOT SPAWN"] } },
			{ name: "monitor_stop", args: { id: "pre" } },
		]);
		expect(read.isError, read.text).toBe(false);
		expect(read.text).toContain("before-plan");
		for (const blocked of [start, stop]) {
			expect(blocked.isError).toBe(true);
			expect(blocked.text.toLowerCase()).toContain("plan mode");
		}
		expect(processes.calls).toHaveLength(1);
		expect(processes.last.alive).toBe(true);
		await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		expect(processes.last.alive).toBe(false);
		expect(clock.pending).toBe(0);
	});
});
