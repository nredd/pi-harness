// Shared `LinuxHelperClient` fixture: a freshly imported `src/platform/linux/helper.ts` whose `spawn` yields fake
// children served by one Linux protocol engine. Callers reset the mock in their own `afterEach`
// (`vi.doUnmock("node:child_process")`, `vi.resetModules()`). No helper binary or X server runs.
import { vi } from "vitest";
import { createFakeChild, createFakeSpawn, createHelperEngine } from "../../test/support/fake-helper.mjs";

/**
 * Import the Linux helper module against a fake `spawn` and build a client whose install check always passes.
 * `script(children)` returns the engine handlers; every spawn yields a fresh fake child, collected in `children`.
 */
export async function linuxHelperClient(script) {
	const children = [];
	const engine = createHelperEngine({ profile: "envelope", protocolVersion: 10, platform: "Linux" });
	Object.assign(engine.handlers, script(children));
	const spawn = createFakeSpawn({
		"*": () => {
			const child = createFakeChild({ engine });
			children.push(child);
			return child;
		},
	});
	vi.resetModules();
	vi.doMock("node:child_process", async (original) => ({ ...(await original()), spawn }));
	const helper = await import("../../src/platform/linux/helper.ts");
	const client = new helper.LinuxHelperClient({ helperPath: "/nonexistent/linux-bridge" });
	vi.spyOn(client, "ensureInstalled").mockResolvedValue(undefined);
	return { client, children, spawn, helper };
}
