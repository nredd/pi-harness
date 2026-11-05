/** Edge paths of the ssh tools driven through disposable ssh/scp stand-ins; nothing connects to a host. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerSshTools } from "../../src/ssh/index.ts";
import { createMockPi } from "../support.ts";
import { wrapperFixture } from "../wrapper-fixture.ts";

const fixtures: ReturnType<typeof wrapperFixture>[] = [];
afterEach(() => {
	for (const f of fixtures.splice(0)) f.cleanup();
});

/** Register the tools with `body` as both the ssh and the scp binary (a `/bin/sh` script). */
function tools(body: string) {
	const fixture = wrapperFixture("pyproject.toml");
	fixtures.push(fixture);
	fixture.script(body, "/bin/sh");
	const mock = createMockPi();
	registerSshTools(mock.pi, { knownHosts: () => new Set(["home"]), sshBin: fixture.bin, scpBin: fixture.bin });
	return { mock, root: fixture.root };
}

describe("ssh_exec preflight and remote shell failures", () => {
	it("refuses a NUL byte or an oversized script before starting ssh", async () => {
		const { mock, root } = tools('echo started > "$0.ran"; exit 0');
		const nul = await mock.call("ssh_exec", { host: "home", command: "echo a\0b" }, root);
		expect(nul.isError).toBe(true);
		expect(mock.text(nul)).toBe("command must not contain NUL");
		const huge = await mock.call("ssh_exec", { host: "home", command: "x".repeat(1 << 20) }, root);
		expect(huge.isError).toBe(true);
		expect(mock.text(huge)).toBe("command is too large (1 MiB max)");
		expect(() => readFileSync(join(root, "tool.ran"))).toThrow();
	});

	it("names a remote shell without mktemp as ssh-failed, not a command exit 98", async () => {
		const { mock, root } = tools(`cat >/dev/null; printf '\\n__PI_NO_MKTEMP\\n__PI_RC=98'`);
		const r = await mock.call("ssh_exec", { host: "home", command: "true" }, root);
		expect(r.isError).toBe(true);
		expect(r.structuredContent).toMatchObject({ remoteExit: 98, sshExit: 0, state: "ssh-failed" });
		expect(mock.text(r)).toMatch(/^home: the remote shell has no mktemp; the command did not run/);
	});
});

describe("ssh_pull and ssh_push failures", () => {
	it("rejects an unknown host before touching the local path", async () => {
		const { mock, root } = tools("exit 0");
		const r = await mock.call("ssh_pull", { host: "elsewhere", remote_path: "/x", local_path: "x" }, root);
		expect(r.isError).toBe(true);
		expect(mock.text(r)).toBe("host 'elsewhere' is not a Host entry in ~/.ssh/config; known: home");
	});

	it("refuses to pull onto an absolute directory path", async () => {
		const { mock, root } = tools("exit 0");
		const dir = join(root, "into");
		mkdirSync(dir);
		const r = await mock.call("ssh_pull", { host: "home", remote_path: "/x", local_path: dir }, "/");
		expect(r.isError).toBe(true);
		expect(mock.text(r)).toBe(`${dir} is a directory; name the destination file`);
	});

	it.each([
		["Permission denied", "permission denied"],
		["ssh: Could not resolve hostname home", "connection failed"],
		["ssh: connect to host home port 22: Connection refused", "connection failed"],
		["Operation timed out", "connection failed"],
		["something else broke", "scp exit 3"],
	])("classifies scp stderr %j as %s", async (stderr, state) => {
		const { mock, root } = tools(`echo '${stderr}' >&2; exit 3`);
		const r = await mock.call("ssh_pull", { host: "home", remote_path: "/x", local_path: "out" }, root);
		expect(r.isError).toBe(true);
		expect(mock.text(r)).toBe(`pull home:/x: ${state}\n${stderr}`);
	});

	it("reports a failed push copy after an overwrite skips the remote probe", async () => {
		const { mock, root } = tools("echo 'scp: /x: Permission denied' >&2; exit 1");
		writeFileSync(join(root, "local.txt"), "l\n");
		const r = await mock.call(
			"ssh_push",
			{ host: "home", local_path: "local.txt", remote_path: "/x", overwrite: true },
			root,
		);
		expect(r.isError).toBe(true);
		expect(mock.text(r)).toBe("push home:/x: permission denied\nscp: /x: Permission denied");
	});

	it("reports a hung scp as a timeout, not an exit code", async () => {
		const { mock, root } = tools("exec sleep 30");
		const r = await mock.call("ssh_pull", { host: "home", remote_path: "/x", local_path: "out", timeout: 1 }, root);
		expect(r.isError).toBe(true);
		expect(mock.text(r)).toMatch(/^pull home:\/x: timed out after \d+\.\ds$/);
	});
});
