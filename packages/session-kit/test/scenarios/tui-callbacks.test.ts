import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerMon } from "../../src/mon/index.ts";
import { snapshot } from "../mon/fixtures.ts";
import { assistant, history } from "./stats-support.ts";
import { configFor, deferred, TerminalFixture } from "./support.ts";

let fixture: TerminalFixture | undefined;
afterEach(async () => {
	await fixture?.dispose();
	fixture = undefined;
});

/** Observe real mounted command components and a live theme change without replacing the UI host. */
function overlayProbe(admission?: { entered: () => void; wait: Promise<void> }) {
	let mounted: Component | undefined;
	let recolored = false;
	const extension: ExtensionFactory = (pi) => {
		pi.on("session_start", (_event, ctx) => {
			const custom = ctx.ui.custom.bind(ctx.ui);
			ctx.ui.custom = (factory, options) =>
				custom(async (tui, theme, kb, done) => {
					const liveTheme = new Proxy(theme, {
						get(target, key, receiver) {
							if (key === "fg")
								return (...args: Parameters<typeof theme.fg>) =>
									`${recolored ? "\u001b[35m" : ""}${target.fg(...args)}`;
							return Reflect.get(target, key, receiver);
						},
					});
					admission?.entered();
					await admission?.wait;
					mounted = await factory(tui, liveTheme, kb, done);
					return mounted;
				}, options);
		});
	};
	return {
		extension,
		component(): Component {
			if (!mounted) throw new Error("No mounted command component");
			return mounted;
		},
		/** Prove invalidation preserves data/layout but takes fresh theme colors. */
		retheme(): void {
			const component = this.component();
			const before = component.render(100);
			recolored = true;
			component.invalidate();
			const after = component.render(100);
			expect(after).not.toEqual(before);
			expect(after.some((line) => line.includes("\u001b[35m"))).toBe(true);
			expect(after.map(visibleWidth)).toEqual(before.map(visibleWidth));
		},
	};
}

/** Unsigned Git fixture with child-only scratch HOME/config and explicit empty hooks/templates. */
function dirtyRepo(root: string, inherited: NodeJS.ProcessEnv = process.env): void {
	const home = mkdtempSync(join(tmpdir(), "psk-git-home-"));
	const hooks = join(home, "hooks");
	const templates = join(home, "templates");
	mkdirSync(hooks);
	mkdirSync(templates);
	const config = join(home, "gitconfig");
	writeFileSync(config, "");
	const env = {
		...Object.fromEntries(Object.entries(inherited).filter(([key]) => !key.startsWith("GIT_"))),
		HOME: home,
		XDG_CONFIG_HOME: home,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_SYSTEM: "/dev/null",
		GIT_CONFIG_GLOBAL: config,
	};
	const git = (...args: string[]) =>
		execFileSync(
			"git",
			[
				"-c",
				"user.name=fixture",
				"-c",
				"user.email=fixture@example.invalid",
				"-c",
				"commit.gpgsign=false",
				"-c",
				`core.hooksPath=${hooks}`,
				"-c",
				`init.templateDir=${templates}`,
				...args,
			],
			{ cwd: root, env },
		);
	try {
		git("init", "-q");
		writeFileSync(join(root, "tracked.txt"), "before\n");
		git("add", "tracked.txt");
		git("commit", "-qm", "fixture");
		writeFileSync(join(root, "tracked.txt"), "after\n");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

describe("mounted public command callback outcomes", () => {
	it.each(["invalid config", "hooks and templates"])("isolates fixture Git from hostile inherited %s", (kind) => {
		fixture = new TerminalFixture();
		const hostile = join(fixture.root, "hostile");
		const hooks = join(hostile, "hooks");
		const templates = join(hostile, "templates");
		const repo = join(fixture.root, "repo");
		for (const directory of [hooks, join(templates, "hooks"), repo]) mkdirSync(directory, { recursive: true });
		const marker = join(hostile, "hook-ran");
		const hook = `#!/bin/sh\nprintf hostile > ${JSON.stringify(marker)}\nexit 1\n`;
		for (const path of [join(hooks, "pre-commit"), join(templates, "hooks", "pre-commit")]) {
			writeFileSync(path, hook);
			chmodSync(path, 0o755);
		}
		writeFileSync(join(templates, "copied-global-template"), "must not be copied");
		const config = join(hostile, ".gitconfig");
		writeFileSync(
			config,
			kind === "invalid config"
				? "[unterminated\n"
				: `[core]\n hooksPath = ${hooks}\n[init]\n templateDir = ${templates}\n`,
		);
		const env = {
			...process.env,
			HOME: hostile,
			XDG_CONFIG_HOME: hostile,
			GIT_CONFIG_GLOBAL: config,
			GIT_CONFIG_SYSTEM: config,
			GIT_TEMPLATE_DIR: templates,
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: "core.hooksPath",
			GIT_CONFIG_VALUE_0: hooks,
		};
		if (kind === "invalid config") {
			const control = spawnSync("git", ["config", "--file", config, "--list"], { env, encoding: "utf8" });
			expect(control.status).not.toBe(0);
			expect(control.stderr).toContain("bad config line");
		} else {
			const control = join(hostile, "unisolated-control");
			expect(spawnSync("git", ["init", "-q", control], { env }).status).toBe(0);
			expect(existsSync(join(control, ".git", "copied-global-template"))).toBe(true);
			expect(spawnSync(join(hooks, "pre-commit"), [], { env }).status).toBe(1);
			expect(existsSync(marker)).toBe(true);
			rmSync(marker);
		}
		dirtyRepo(repo, env);
		expect(readFileSync(join(repo, "tracked.txt"), "utf8")).toBe("after\n");
		expect(existsSync(marker)).toBe(false);
		expect(existsSync(join(repo, ".git", "copied-global-template"))).toBe(false);
		expect(existsSync(join(repo, ".git", "hooks", "pre-commit"))).toBe(false);
	});

	it("diff invalidation keeps the selected patch and refreshes its live theme", async () => {
		fixture = new TerminalFixture();
		dirtyRepo(fixture.root);
		const probe = overlayProbe();
		await fixture.startTerminal(configFor("diff"), { extensionFactories: [probe.extension] });
		await fixture.open("/diff");
		expect(probe.component().render(100).join("\n")).toContain("after");
		probe.retheme();
		expect(probe.component().render(100).join("\n")).toContain("after");
		await fixture.close();
	});

	it("stats Models renders an empty selected range without leaking future usage, even after invalidation", async () => {
		fixture = new TerminalFixture();
		const probe = overlayProbe();
		history(fixture.agentDir, [assistant(fixture.clock.now() + 86_400_000, "physical", "future-model", 7)]);
		await fixture.startTerminal(configFor("stats"), { extensionFactories: [probe.extension] });
		await fixture.open("/stats");
		await fixture.key("\t");
		const body = probe.component().render(100).join("\n");
		expect(body).toContain("No usage in this range.");
		expect(body).not.toContain("future-model");
		probe.retheme();
		expect(probe.component().render(100).join("\n")).toContain("No usage in this range.");
		await fixture.close();
	});

	it("mon navigation, help paging and invalidation keep the real sample and dispose it on close", async () => {
		fixture = new TerminalFixture();
		const ownFixture = fixture;
		const probe = overlayProbe();
		const sampled = deferred<void>();
		const dispose = vi.fn();
		const sample = vi.fn(async () => {
			sampled.resolve();
			return snapshot();
		});
		const register: ExtensionFactory = (pi) =>
			registerMon(pi, { createSource: () => ({ sample, dispose }), clock: ownFixture.clock });
		await fixture.startTerminal(configFor(), { rows: 20, extensionFactories: [register, probe.extension] });
		await fixture.open("/mon");
		await sampled.promise;
		await fixture.requireHost().settle();
		expect(probe.component().render(100).join("\n")).toContain("LIVE");
		probe.retheme();
		const dashboard = fixture.requireHost().viewport().join("\n");
		await fixture.key("x");
		expect(fixture.requireHost().viewport().join("\n")).toEqual(dashboard);
		await fixture.key("\u001b[6~");
		await fixture.key("\u001b[5~");
		await fixture.key("?");
		const first = fixture.requireHost().viewport().join("\n");
		expect(first).toContain("Keys");
		await fixture.key("x");
		expect(fixture.requireHost().viewport().join("\n")).toEqual(first);
		await fixture.key("\u001b[6~");
		const later = fixture.requireHost().viewport().join("\n");
		expect(later).not.toEqual(first);
		expect(later).not.toContain("Keys");
		await fixture.key("\u001b[5~");
		expect(fixture.requireHost().viewport().join("\n")).toEqual(first);
		await fixture.key("G");
		expect(fixture.requireHost().viewport().join("\n")).toContain("No kill, locks or scheduling.");
		await fixture.key("g");
		expect(fixture.requireHost().viewport().join("\n")).toEqual(first);
		await fixture.close();
		expect(dispose).toHaveBeenCalledOnce();
		expect(sample).toHaveBeenCalledOnce();
		expect(fixture.clock.pending).toBe(0);
	});

	it("a deferred mon factory invalidated by shutdown stays blank and never creates a sampler", async () => {
		fixture = new TerminalFixture();
		const ownFixture = fixture;
		const entered = deferred<void>();
		const admission = deferred<void>();
		const probe = overlayProbe({ entered: () => entered.resolve(), wait: admission.promise });
		const createSource = vi.fn(() => ({ sample: async () => snapshot(), dispose: vi.fn() }));
		const register: ExtensionFactory = (pi) => registerMon(pi, { createSource, clock: ownFixture.clock });
		const host = await fixture.startTerminal(configFor(), { extensionFactories: [register, probe.extension] });
		const opening = host.harness.session.prompt("/mon");
		await entered.promise;
		const shutdown = host.harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
		admission.resolve();
		await Promise.all([opening, shutdown]);
		const component = probe.component();
		expect(component.render(100)).toEqual([]);
		component.invalidate();
		expect(component.render(100)).toEqual([]);
		expect(createSource).not.toHaveBeenCalled();
		expect(fixture.clock.pending).toBe(0);
	});

	it("a failed mon source factory reports failure and does not poison the next opener", async () => {
		fixture = new TerminalFixture();
		const ownFixture = fixture;
		const createSource = vi.fn(() => ({ sample: async () => snapshot(), dispose: vi.fn() }));
		createSource.mockImplementationOnce(() => {
			throw new Error("fixture source unavailable");
		});
		const register: ExtensionFactory = (pi) => registerMon(pi, { createSource, clock: ownFixture.clock });
		const host = await fixture.startTerminal(configFor(), { extensionFactories: [register] });
		await host.harness.session.prompt("/mon");
		await host.settle();
		expect(host.viewport().join("\n")).toContain("fixture source unavailable");
		expect(fixture.clock.pending).toBe(0);
		await fixture.open("/mon");
		expect(createSource).toHaveBeenCalledTimes(2);
		await fixture.close();
		expect(fixture.clock.pending).toBe(0);
	});

	it("stats loading failures notify and clear the loading status without opening an overlay", async () => {
		fixture = new TerminalFixture();
		writeFileSync(fixture.agentDir, "blocked agent directory");
		const host = await fixture.startTerminal(configFor("stats"));
		await host.harness.session.prompt("/stats");
		await host.settle();
		const shown = host.viewport().join("\n");
		expect(shown).toContain("/stats:");
		expect(shown).toMatch(/ENOTDIR|EEXIST/);
		expect(shown).not.toContain("stats: loading");
		expect(shown).not.toContain("q/Esc close");
	});
});
