import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openCodexSession } from "../src/codex-session.js";
import { token } from "./fixtures/codex.js";

const fixture = fileURLToPath(new URL("./fixtures/codex-app-server.mjs", import.meta.url));
const options = (mode = "normal") => ({
	getToken: async () => token(),
	command: [process.execPath, fixture, mode],
	timeoutMs: 5000,
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("real credential-free app-server stdio boundary", () => {
	it("initializes, opts into external auth, isolates homes/environment, and closes idempotently", async () => {
		vi.stubEnv("PI_CODEX_SECRET_SENTINEL", "must-not-inherit");
		const session = await openCodexSession({ ...options(), timeoutMs: undefined });
		try {
			expect(await session.request("account/rateLimits/read", {})).toMatchObject({
				rateLimitResetCredits: { availableCount: 1 },
			});
			await session.checkIdentity();
		} finally {
			await session.close();
			await session.close();
		}
		await expect(session.request("account/read", {})).rejects.toThrow("disconnected");
	});
	it.each([
		"version-error",
		"version-mismatch",
		"bad-json",
		"oversize",
		"exit",
		"bad-init",
		"bad-login",
		"bad-account",
	])("fails closed for %s without guessed commands", async (mode) => {
		await expect(openCodexSession(options(mode))).rejects.toThrow();
	});
	it("does not launch without current Pi identity or a real client command", async () => {
		await expect(openCodexSession({ ...options(), getToken: async () => undefined })).rejects.toThrow("OAuth identity");
		await expect(openCodexSession({ ...options(), command: [] })).rejects.toThrow("command is unavailable");
		await expect(openCodexSession({ ...options(), command: ["/nonexistent-synthetic-codex"] })).rejects.toThrow(
			"client unavailable",
		);
	});
	it.each(["unsupported", "server-error", "account-change"])("sanitizes %s capability/auth failures", async (mode) => {
		const session = await openCodexSession(options(mode));
		try {
			await expect(session.request("account/rateLimits/read", {})).rejects.not.toThrow("PRIVATE-RAW-ERROR");
		} finally {
			await session.close();
		}
	});
	it("bounds a hung request and detaches cancelled requests before and after dispatch", async () => {
		const config = options("read-hang");
		const session = await openCodexSession(config);
		config.timeoutMs = 20;
		try {
			await expect(session.request("account/rateLimits/read", {})).rejects.toThrow("timed out");
			const cancelled = new AbortController();
			cancelled.abort();
			await expect(session.request("account/read", {}, cancelled.signal)).rejects.toThrow("cancelled");
			const controller = new AbortController();
			const dispatched = vi.fn(() => controller.abort());
			await expect(session.request("account/rateLimits/read", {}, controller.signal, dispatched)).rejects.toThrow(
				"cancelled",
			);
			expect(dispatched).toHaveBeenCalledOnce();
		} finally {
			await session.close();
		}
	});
	it("handles local process/input errors and a synchronous write failure without leaking diagnostics", async () => {
		for (const source of ["process", "input", "write"]) {
			const session = await openCodexSession(options("read-hang"));
			const child = Reflect.get(session, "child") as ChildProcessWithoutNullStreams;
			try {
				if (source === "write")
					vi.spyOn(child.stdin, "write").mockImplementationOnce(() => {
						throw new Error("PRIVATE-LOCAL-ERROR");
					});
				const request = session.request("account/rateLimits/read", {});
				if (source === "process") child.emit("error", new Error("PRIVATE-LOCAL-ERROR"));
				if (source === "input") child.stdin.emit("error", new Error("PRIVATE-LOCAL-ERROR"));
				await expect(request).rejects.not.toThrow("PRIVATE-LOCAL-ERROR");
			} finally {
				await session.close();
			}
		}
	});
	it("escalates cleanup for a client that ignores termination", async () => {
		const session = await openCodexSession(options("ignore-term"));
		await session.close();
	});
	it("bounds cleanup and retains private state when OS exit confirmation is lost", async () => {
		const session = await openCodexSession(options("ignore-term"));
		const child = Reflect.get(session, "child") as ChildProcessWithoutNullStreams;
		const home = Reflect.get(session, "home") as string;
		const kill = child.kill.bind(child);
		vi.spyOn(child, "kill").mockReturnValue(false);
		Reflect.set(session, "exited", new Promise<void>(() => {}));
		vi.useFakeTimers();
		try {
			const closed = session.close();
			const assertion = expect(closed).rejects.toThrow("private temporary state is retained");
			await vi.advanceTimersByTimeAsync(3000);
			await assertion;
		} finally {
			vi.useRealTimers();
			const exited = once(child, "close");
			kill("SIGKILL");
			await exited;
			await rm(home, { recursive: true, force: true });
		}
	});
	it("rejects unknown server requests and ignores unsolicited response IDs", async () => {
		const session = await openCodexSession(options("unknown-request"));
		await session.close();
	});
	it("refreshes external tokens only for the same principal/workspace", async () => {
		let current = token();
		const session = await openCodexSession({ ...options("refresh"), getToken: async () => current });
		try {
			await expect(session.request("account/rateLimits/read", {})).resolves.toMatchObject({
				rateLimitResetCredits: { availableCount: 1 },
			});
			current = token("other-workspace");
			await expect(session.checkIdentity()).rejects.toThrow("changed");
			await expect(session.request("account/rateLimits/read", {})).rejects.toThrow(
				"refresh failed or changed identity",
			);
		} finally {
			await session.close();
		}
	});
});
