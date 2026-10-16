import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../../src/config.ts";
import { register } from "../../src/diff/index.ts";

// biome-ignore lint/suspicious/noExplicitAny: fake pi/ctx surface
type Any = any;

let dir: string;
const git = (...a: string[]) =>
	execFileSync("git", a, {
		cwd: dir,
		encoding: "utf8",
		env: {
			...process.env,
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_AUTHOR_NAME: "t",
			GIT_AUTHOR_EMAIL: "t@e",
			GIT_COMMITTER_NAME: "t",
			GIT_COMMITTER_EMAIL: "t@e",
		},
	});

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "psk-diffcmd-"));
	git("init", "-q", "-b", "main");
	writeFileSync(join(dir, "a.txt"), "1\n");
	git("add", "-A");
	git("commit", "-q", "-m", "c");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function setup(mode: string) {
	let handler: Any;
	const sendMessage = vi.fn();
	register({ registerCommand: (_n: string, c: Any) => (handler = c.handler), sendMessage } as Any, defaultConfig());
	const custom = vi.fn(async (factory: Any) => {
		const view = factory(
			{ terminal: { rows: 20 }, requestRender() {} },
			{ fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s },
			{},
			() => {},
		);
		return view.render(80);
	});
	const ctx = { mode, cwd: dir, ui: { notify: vi.fn(), setStatus: vi.fn(), custom } };
	return { run: (args: string) => handler(args, ctx), ctx, custom, sendMessage };
}

describe("/diff command", () => {
	it("notifies instead of opening an overlay when nothing changed", async () => {
		const { run, ctx, custom } = setup("tui");
		await run("");
		expect(custom).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith("/diff: no changes vs HEAD", "info");
	});

	it("opens a full-width overlay when there are changes, and clears the loading status", async () => {
		writeFileSync(join(dir, "a.txt"), "2\n");
		const { run, ctx, custom } = setup("tui");
		await run("");
		expect(custom).toHaveBeenCalledTimes(1);
		expect((custom.mock.calls[0] as unknown[] | undefined)?.[1]).toMatchObject({
			overlay: true,
			overlayOptions: { width: "100%" },
		});
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("session-kit:diff", undefined);
	});

	it("turns a bad ref into a notify, not a crash", async () => {
		const { run, ctx, custom } = setup("tui");
		await run("nope");
		expect(custom).not.toHaveBeenCalled();
		expect(ctx.ui.notify.mock.calls[0]?.[0]).toMatch(/^\/diff: bad ref "nope"/);
		expect(ctx.ui.notify.mock.calls[0]?.[1]).toBe("error");
	});

	it("rejects extra arguments", async () => {
		const { run, ctx } = setup("tui");
		await run("a b");
		expect(ctx.ui.notify).toHaveBeenCalledWith("usage: /diff [ref]", "warning");
	});

	it("reports a non-repo", async () => {
		const plain = mkdtempSync(join(tmpdir(), "psk-nogit-"));
		try {
			const { ctx, custom } = setup("tui");
			ctx.cwd = plain;
			let handler: Any;
			const sendMessage = vi.fn();
			register({ registerCommand: (_n: string, c: Any) => (handler = c.handler), sendMessage } as Any, defaultConfig());
			await handler("", ctx);
			expect(custom).not.toHaveBeenCalled();
			expect(ctx.ui.notify.mock.calls[0]?.[0]).toMatch(/not a git repository/);
		} finally {
			rmSync(plain, { recursive: true, force: true });
		}
	});

	describe("outside the TUI", () => {
		beforeEach(() => {
			writeFileSync(join(dir, "a.txt"), "2\n");
			writeFileSync(join(dir, "new.txt"), "n\n");
		});
		afterEach(() => vi.restoreAllMocks());

		it("print mode writes the --stat to stdout (notify is a no-op there)", async () => {
			const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
			const { run, ctx, custom } = setup("print");
			await run("");
			expect(custom).not.toHaveBeenCalled();
			expect(ctx.ui.notify).not.toHaveBeenCalled();
			const text = String(out.mock.calls[0]?.[0]);
			expect(text).toContain("a.txt");
			expect(text).toContain("?? new.txt");
		});

		it("print mode writes errors to stderr", async () => {
			const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
			const { run } = setup("print");
			await run("no-such-ref");
			expect(String(err.mock.calls[0]?.[0])).toMatch(/^\/diff: /);
		});

		it("json mode adds one display message instead of corrupting the event stream", async () => {
			const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
			const { run, sendMessage } = setup("json");
			await run("");
			expect(out).not.toHaveBeenCalled();
			const [message, options] = sendMessage.mock.calls[0] as [Any, Any];
			expect(message.customType).toBe("session-kit:diff");
			expect(message.display).toBe(true);
			expect(message.content).toContain("?? new.txt");
			expect(options).toEqual({ triggerTurn: false });
		});

		it("rpc mode notifies", async () => {
			const { run, ctx } = setup("rpc");
			await run("");
			const [text, level] = ctx.ui.notify.mock.calls[0] as [string, string];
			expect(level).toBe("info");
			expect(text).toContain("a.txt");
		});
	});
});
