import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { registerSshTools } from "../../src/ssh/index.ts";
import { createMockPi } from "../support.ts";

const FIXTURES = join(import.meta.dirname, "..", "fixtures", "ssh");
const mock = createMockPi();
let work: string;

beforeAll(() => {
	work = mkdtempSync(join(tmpdir(), "pi-dev-tools-ssh-"));
	registerSshTools(mock.pi, {
		knownHosts: () => new Set(["home", "down"]),
		sshBin: join(FIXTURES, "fake-ssh"),
		scpBin: join(FIXTURES, "fake-scp"),
	});
});

describe("ssh_exec", () => {
	it("is annotated read-only; pull is too; push is not", () => {
		expect(mock.tools.get("ssh_exec")?.annotations?.readOnlyHint).toBe(true);
		expect(mock.tools.get("ssh_pull")?.annotations?.readOnlyHint).toBe(true);
		expect(mock.tools.get("ssh_push")?.annotations?.readOnlyHint).toBe(false);
	});

	it("runs the command, separates stdout and stderr, and reports the remote exit", async () => {
		const r = await mock.call("ssh_exec", { host: "home", command: "echo out; echo err >&2; exit 0" }, work);
		expect(r.isError).toBe(false);
		expect(mock.text(r)).toMatch(/^home: exit 0 in \d+\.\ds\nout\nstderr:\n/);
		expect(r.structuredContent).toMatchObject({ host: "home", remoteExit: 0, sshExit: 0, state: "ok" });
	});

	it("reports a failing command as command-failed with its code, even 255, without flagging an error", async () => {
		const r = await mock.call("ssh_exec", { host: "home", command: "exit 255" }, work);
		expect(r.isError).toBe(false);
		expect(r.structuredContent).toMatchObject({ remoteExit: 255, sshExit: 0, state: "command-failed" });
		expect(mock.text(r)).toMatch(/^home: command exited 255/);
		const grep = await mock.call("ssh_exec", { host: "home", command: "echo x | grep -c y" }, work);
		expect(grep.structuredContent).toMatchObject({ remoteExit: 1, state: "command-failed" });
	});

	it("does not let the command read the wrapper off stdin", async () => {
		const r = await mock.call("ssh_exec", { host: "home", command: "cat; echo done" }, work);
		expect(r.structuredContent).toMatchObject({ state: "ok", remoteExit: 0 });
		expect(mock.text(r)).toContain("done");
		expect(mock.text(r)).not.toContain("__pi_rc");
	});

	it("does not let the command spoof the markers", async () => {
		const r = await mock.call("ssh_exec", { host: "home", command: "printf '\\n__PI_CWD_MISSING'" }, work);
		expect(r.structuredContent).toMatchObject({ state: "ok", remoteExit: 0 });
		expect(r.isError).toBe(false);
	});

	it("does not confuse a command exiting 97 with a missing cwd", async () => {
		const r = await mock.call("ssh_exec", { host: "home", command: "exit 97", cwd: work }, work);
		expect(r.structuredContent).toMatchObject({ remoteExit: 97, state: "command-failed" });
	});

	it("contains unbalanced parentheses and quotes inside the command", async () => {
		const paren = await mock.call("ssh_exec", { host: "home", command: "echo hi ); echo escaped" }, work);
		expect(paren.structuredContent).toMatchObject({ state: "command-failed", remoteExit: 2 });
		// Nothing after the stray `)` ran: stdout is empty, the only mention is sh's own error line.
		expect(mock.text(paren)).toMatch(/^home: command exited 2 in [\d.]+s\nstderr:\n/);
		expect(mock.text(paren)).not.toContain("may not have run");
		// dash (Linux /bin/sh) says "Syntax error", bash "syntax error".
		expect(mock.text(paren)).toMatch(/syntax error/i);
		const quote = await mock.call("ssh_exec", { host: "home", command: "echo 'unterminated" }, work);
		expect(quote.structuredContent).toMatchObject({ state: "command-failed", remoteExit: 2 });
		const spoof = await mock.call("ssh_exec", { host: "home", command: "printf '\\n__PI_RC=0'; exit 9" }, work);
		expect(spoof.structuredContent).toMatchObject({ remoteExit: 9, state: "command-failed" });
	});

	it("tells ssh failure apart from the command", async () => {
		const r = await mock.call("ssh_exec", { host: "down", command: "true" }, work);
		expect(r.structuredContent).toMatchObject({ remoteExit: null, sshExit: 255, state: "ssh-failed" });
		expect(mock.text(r)).toContain("may not have run");
		expect(mock.text(r)).toContain("Operation timed out");
		expect(r.isError).toBe(true);
	});

	it("honours cwd and names a missing cwd", async () => {
		const ok = await mock.call("ssh_exec", { host: "home", command: "pwd", cwd: work }, work);
		expect(mock.text(ok)).toContain(work.replace(/^\/private/, ""));
		const bad = await mock.call("ssh_exec", { host: "home", command: "pwd", cwd: "/definitely/missing" }, work);
		expect(bad.structuredContent).toMatchObject({ state: "cwd-missing", remoteExit: 97 });
		expect(bad.isError).toBe(true);
		expect(mock.text(bad)).toContain("did not run");
	});

	it("runs multi-line scripts and handles quotes without any remote argv", async () => {
		const r = await mock.call(
			"ssh_exec",
			{ host: "home", command: "x=\"it's\"\nprintf '%s\\n' \"$x\"\necho 'a;b|c'" },
			work,
		);
		expect(mock.text(r)).toContain("it's\na;b|c");
	});

	it("rejects unknown or option-shaped hosts and empty commands before running anything", async () => {
		for (const host of ["evil", "-oProxyCommand=id", "root@home"]) {
			const r = await mock.call("ssh_exec", { host, command: "id" }, work);
			expect(r.isError, host).toBe(true);
			expect(mock.text(r)).toMatch(/not a Host entry|not a plain host alias/);
		}
		expect((await mock.call("ssh_exec", { host: "home", command: "  " }, work)).isError).toBe(true);
	});

	it("kills a hung command on timeout and says the remote may still run", async () => {
		const r = await mock.call("ssh_exec", { host: "home", command: "sleep 30", timeout: 1 }, work);
		// With the local fake the whole tree gets SIGTERM and the wrapper may still print a sentinel
		// (143); real ssh leaves the remote untouched and no sentinel arrives. Either way: timeout.
		expect(r.structuredContent).toMatchObject({ state: "timeout" });
		expect(r.isError).toBe(true);
		expect(mock.text(r)).toMatch(/timed out after/);
		expect(mock.text(r)).toContain("may still be running");
	});

	it("reports an abort", async () => {
		const ac = new AbortController();
		const tool = mock.tools.get("ssh_exec");
		const p = tool?.execute("id", { host: "home", command: "sleep 30" }, ac.signal, undefined, {
			cwd: work,
		}) as Promise<{ structuredContent: unknown }>;
		setTimeout(() => ac.abort(), 100);
		expect((await p).structuredContent).toMatchObject({ state: "aborted" });
	});

	it("redacts the spill file too", async () => {
		const r = await mock.call("ssh_exec", { host: "home", command: "seq 1 50000; echo Bearer abcdefghijklmnop" }, work);
		const path = (r.details as { fullOutputPath: string }).fullOutputPath;
		expect(readFileSync(path, "utf8")).not.toContain("abcdefghijklmnop");
	});

	it("redacts credentials in output", async () => {
		const r = await mock.call(
			"ssh_exec",
			{ host: "home", command: "echo Bearer abcdefghijklmnopqrstuvwxyz0123; echo HA_TOKEN=supersecretvalue1234 >&2" },
			work,
		);
		expect(mock.text(r)).not.toContain("abcdefghijklmnopqrstuvwxyz0123");
		expect(mock.text(r)).not.toContain("supersecretvalue1234");
		expect(mock.text(r)).toContain("<redacted>");
	});

	it("bounds huge output and names the spill file", async () => {
		const r = await mock.call("ssh_exec", { host: "home", command: "seq 1 100000" }, work);
		expect(r.structuredContent).toMatchObject({ state: "ok", truncated: true });
		expect(mock.text(r)).toContain("100000");
		expect(mock.text(r)).toMatch(/rest in .*ssh-exec-\d+\.txt/);
	});
});

describe("ssh_pull and ssh_push", () => {
	it("pulls a file, refuses to overwrite without the flag, then overwrites", async () => {
		const remote = join(work, "remote.txt");
		writeFileSync(remote, "r1\n");
		const first = await mock.call("ssh_pull", { host: "home", remote_path: remote, local_path: "pulled.txt" }, work);
		expect(first.isError, mock.text(first)).toBe(false);
		expect(readFileSync(join(work, "pulled.txt"), "utf8")).toBe("r1\n");
		writeFileSync(remote, "r2\n");
		const refused = await mock.call("ssh_pull", { host: "home", remote_path: remote, local_path: "pulled.txt" }, work);
		expect(refused.isError).toBe(true);
		expect(mock.text(refused)).toContain("overwrite: true");
		const again = await mock.call(
			"ssh_pull",
			{ host: "home", remote_path: remote, local_path: "pulled.txt", overwrite: true },
			work,
		);
		expect(again.isError).toBe(false);
		expect(readFileSync(join(work, "pulled.txt"), "utf8")).toBe("r2\n");
	});

	it("pushes a file, refuses to overwrite a remote file without the flag", async () => {
		writeFileSync(join(work, "local.txt"), "l1\n");
		const target = join(work, "pushed.txt");
		const first = await mock.call("ssh_push", { host: "home", local_path: "local.txt", remote_path: target }, work);
		expect(first.isError, mock.text(first)).toBe(false);
		expect(readFileSync(target, "utf8")).toBe("l1\n");
		const refused = await mock.call("ssh_push", { host: "home", local_path: "local.txt", remote_path: target }, work);
		expect(refused.isError).toBe(true);
		expect(mock.text(refused)).toContain("exists");
		const missing = await mock.call("ssh_push", { host: "home", local_path: "nope.txt", remote_path: target }, work);
		expect(mock.text(missing)).toContain("is not a regular file");
		const down = await mock.call("ssh_push", { host: "down", local_path: "local.txt", remote_path: target }, work);
		expect(mock.text(down)).toContain("could not check the remote path");
	});

	it("names scp failures", async () => {
		const r = await mock.call("ssh_pull", { host: "home", remote_path: "/nope/missing", local_path: "x.txt" }, work);
		expect(r.isError).toBe(true);
		expect(mock.text(r)).toMatch(/^pull home:\/nope\/missing: missing/);
	});

	it("rejects remote paths the remote shell would interpret", async () => {
		for (const remote_path of ["/etc/hostname;touch /tmp/pwn", "$(id)", "a b", "~/x"]) {
			const pull = await mock.call("ssh_pull", { host: "home", remote_path, local_path: "y.txt" }, work);
			expect(pull.isError, remote_path).toBe(true);
			expect(mock.text(pull)).toContain("remote_path may only contain");
			const push = await mock.call("ssh_push", { host: "home", local_path: "local.txt", remote_path }, work);
			expect(push.isError, remote_path).toBe(true);
		}
	});

	it("push overwrites when asked and refuses a dangling symlink source", async () => {
		const target = join(work, "pushed.txt");
		writeFileSync(join(work, "local.txt"), "l2\n");
		const r = await mock.call(
			"ssh_push",
			{ host: "home", local_path: "local.txt", remote_path: target, overwrite: true },
			work,
		);
		expect(r.isError, mock.text(r)).toBe(false);
		expect(readFileSync(target, "utf8")).toBe("l2\n");
		symlinkSync(join(work, "gone.txt"), join(work, "dangling.txt"));
		const bad = await mock.call(
			"ssh_push",
			{ host: "home", local_path: "dangling.txt", remote_path: target, overwrite: true },
			work,
		);
		expect(mock.text(bad)).toContain("not a regular file");
	});
});
