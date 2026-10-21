import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach } from "vitest";

// Set HOME before dynamically importing production modules, as upstream does.
const home = mkdtempSync(join(tmpdir(), "rpiv-todo-tests-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.PI_OFFLINE = "1";
delete process.env.PI_CODING_AGENT_DIR;
delete process.env.XDG_CONFIG_HOME;

beforeEach(async () => {
	delete process.env.PI_CODING_AGENT_DIR;
	delete process.env.XDG_CONFIG_HOME;
	const todo = await import("../todo.ts");
	todo.__resetState();
	const i18n = await import("@juicesharp/rpiv-i18n");
	i18n.__resetState();
	delete (globalThis as Record<symbol, unknown>)[Symbol.for("rpiv-i18n")];
	rmSync(join(home, ".config"), { recursive: true, force: true });
	rmSync(join(home, ".pi"), { recursive: true, force: true });
});
afterAll(() => rmSync(home, { recursive: true, force: true }));
