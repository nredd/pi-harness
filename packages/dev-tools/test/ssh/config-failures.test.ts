import * as fs from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { readKnownHosts, sshConfigPath } from "../../src/ssh/hosts.ts";
import { registerSshTools } from "../../src/ssh/index.ts";
import { createMockPi } from "../support.ts";
import { wrapperFixture } from "../wrapper-fixture.ts";

vi.mock("node:fs", async (original) => {
	const actual = await original<typeof import("node:fs")>();
	return { ...actual, globSync: vi.fn(actual.globSync) };
});
const home = vi.hoisted(() => ({ path: "/unused-fixture-home" }));
vi.mock("node:os", async (original) => ({ ...(await original<typeof import("node:os")>()), homedir: () => home.path }));
afterEach(() => vi.restoreAllMocks());

it("reads default host config and tilde includes against an injected home, never the user's home", async () => {
	const fixture = wrapperFixture("pyproject.toml");
	try {
		home.path = fixture.root;
		fs.mkdirSync(join(fixture.root, ".ssh"));
		fs.writeFileSync(join(fixture.root, ".ssh", "config"), "Include ~/extra\nInclude ~/missing\n");
		fs.writeFileSync(join(fixture.root, "extra"), "Host fixture\n");
		expect(sshConfigPath()).toBe(join(fixture.root, ".ssh", "config"));
		vi.spyOn(fs, "globSync").mockImplementation(() => {
			throw new Error("glob unavailable");
		});
		expect([...readKnownHosts()]).toEqual(["fixture"]);
		fixture.script('console.log("known-host-boundary\\n__PI_RC=0");');
		const mock = createMockPi();
		registerSshTools(mock.pi, { sshBin: fixture.bin });
		const result = await mock.call("ssh_exec", { host: "fixture", command: "printf fixture" }, fixture.root);
		expect(result.isError).toBe(false);
		expect(mock.text(result)).toContain("known-host-boundary");
	} finally {
		fixture.cleanup();
	}
});
