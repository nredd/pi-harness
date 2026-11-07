import * as fs from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createMockPi } from "@juicesharp/rpiv-test-utils";
import { afterEach, expect, it, vi } from "vitest";
import { TEST_HOME } from "./.test-support/setup.ts";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof fs>();
	return { ...actual, existsSync: vi.fn(actual.existsSync) };
});

import { getCollapseOnResume, getMaxWidgetLines, loadConfig, resolveCollapseKey } from "./config.ts";
import registerTodo from "./index.ts";
import { registerTodoTool } from "./todo.ts";

/**
 * `existsSync` probes under the real home, excluding the injected `TEST_HOME`. The injected home
 * may itself live under the real home (e.g. `TMPDIR=$HOME/tmp`), so its subtree is not a leak.
 */
function realHomeProbes(): string[] {
	const within = (path: string, root: string) => path === root || path.startsWith(root + sep);
	const realHome = resolve(homedir());
	const injected = resolve(TEST_HOME);
	const paths = vi.mocked(fs.existsSync).mock.calls.map(([path]) => resolve(String(path)));
	return paths.filter((path) => within(path, realHome) && !within(path, injected));
}

afterEach(() => {
	expect(realHomeProbes()).toEqual([]);
});

it("detects a probe of the real home even while an injected home is active", () => {
	vi.mocked(fs.existsSync).mockClear();
	process.env.XDG_CONFIG_HOME = "";
	// Omitting `homeDir` falls back to the native home, which the guard must catch.
	loadConfig();
	expect(realHomeProbes()).toContain(resolve(homedir(), ".config", "rpiv-todo", "config.json"));
	vi.mocked(fs.existsSync).mockClear();
});

it("never probes the real legacy home when an isolated XDG config is missing", () => {
	vi.mocked(fs.existsSync).mockClear();
	process.env.XDG_CONFIG_HOME = join(TEST_HOME, "missing-xdg");
	const legacy = join(TEST_HOME, ".config", "rpiv-todo");
	fs.mkdirSync(legacy, { recursive: true });
	fs.writeFileSync(
		join(legacy, "config.json"),
		JSON.stringify({ maxWidgetLines: 27, collapseOnResume: false, collapseKey: "alt+o" }),
	);
	expect(loadConfig(TEST_HOME).maxWidgetLines).toBe(27);
	expect(getMaxWidgetLines(TEST_HOME)).toBe(27);
	expect(getCollapseOnResume(TEST_HOME)).toBe(false);
	expect(resolveCollapseKey(TEST_HOME)).toBe("alt+o");
	const { pi, captured } = createMockPi();
	registerTodoTool(pi, { homeDir: TEST_HOME });
	registerTodo(pi, undefined, { homeDir: TEST_HOME });
	expect(captured.shortcuts.has("alt+o")).toBe(true);
});

it("keeps missing-config defaults inside the injected home too", () => {
	vi.mocked(fs.existsSync).mockClear();
	process.env.XDG_CONFIG_HOME = join(TEST_HOME, "absent");
	expect(loadConfig(TEST_HOME)).toEqual({});
	expect(vi.mocked(fs.existsSync)).toHaveBeenCalledWith(join(TEST_HOME, "absent", "rpiv-todo", "config.json"));
});

it("resolves the home itself when no homeDir is injected", () => {
	vi.mocked(fs.existsSync).mockClear();
	// An absolute XDG config that exists keeps both entry points off the real home.
	process.env.XDG_CONFIG_HOME = join(TEST_HOME, "xdg-default");
	const dir = join(process.env.XDG_CONFIG_HOME, "rpiv-todo");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(join(dir, "config.json"), JSON.stringify({ collapseKey: "alt+p" }));
	const { pi, captured } = createMockPi();
	registerTodoTool(pi);
	registerTodo(pi);
	expect(captured.tools.has("todo")).toBe(true);
	expect(captured.shortcuts.has("alt+p")).toBe(true);
});
