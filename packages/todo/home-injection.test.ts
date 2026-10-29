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

afterEach(() => {
	const realHome = resolve(homedir());
	const paths = vi.mocked(fs.existsSync).mock.calls.map(([path]) => resolve(String(path)));
	expect(paths.filter((path) => path === realHome || path.startsWith(realHome + sep))).toEqual([]);
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
