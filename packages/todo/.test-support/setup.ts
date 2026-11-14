import { sandboxConfigHome } from "@nredd/pi-test-lib/sandbox";
import { afterAll, beforeEach } from "vitest";

// Keep config I/O isolated without mutating HOME, which Bun caches at process start.
const sandbox = sandboxConfigHome();
export const TEST_HOME = sandbox.home;
process.env.PI_OFFLINE = "1";

beforeEach(async () => {
	sandbox.reset();
	const todo = await import("../todo.ts");
	todo.__resetState();
	(await import("../state/agents.ts")).__resetAgents();
	(await import("../state/monitors.ts")).__resetMonitors();
	const i18n = await import("@juicesharp/rpiv-i18n");
	i18n.__resetState();
	delete (globalThis as Record<symbol, unknown>)[Symbol.for("rpiv-i18n")];
});
afterAll(sandbox.restore);
