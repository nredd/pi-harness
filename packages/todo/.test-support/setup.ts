import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach } from "vitest";

// Keep config I/O isolated without mutating HOME, which Bun caches at process start.
export const TEST_HOME = mkdtempSync(join(tmpdir(), "rpiv-todo-tests-"));
process.env.PI_OFFLINE = "1";
delete process.env.PI_CODING_AGENT_DIR;
process.env.XDG_CONFIG_HOME = join(TEST_HOME, ".config");

beforeEach(async () => {
	delete process.env.PI_CODING_AGENT_DIR;
	process.env.XDG_CONFIG_HOME = join(TEST_HOME, ".config");
	const todo = await import("../todo.ts");
	todo.__resetState();
	const i18n = await import("@juicesharp/rpiv-i18n");
	i18n.__resetState();
	delete (globalThis as Record<symbol, unknown>)[Symbol.for("rpiv-i18n")];
	rmSync(join(TEST_HOME, ".config"), { recursive: true, force: true });
	rmSync(join(TEST_HOME, ".pi"), { recursive: true, force: true });
});
afterAll(() => rmSync(TEST_HOME, { recursive: true, force: true }));
