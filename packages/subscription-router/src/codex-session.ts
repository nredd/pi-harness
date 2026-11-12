/** Dedicated first-party stdio app-server; credentials never appear in argv, inherited auth homes or errors. */
import { type ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_VERSION, type CodexIdentity, CodexResetError, readIdentity, record } from "./codex-contract.js";

/** Injectable only for credential-free fixtures; production always invokes the documented Codex surface. */
export interface CodexSessionOptions {
	getToken(): Promise<string | undefined>;
	command?: readonly string[];
	timeoutMs?: number;
}
export interface CodexSession {
	readonly identity: CodexIdentity;
	request(method: string, params: unknown, signal?: AbortSignal, dispatched?: () => void): Promise<unknown>;
	checkIdentity(): Promise<void>;
	close(): Promise<void>;
}

/** Minimal inherited environment: never forward unrelated tokens or the user's Codex configuration. */
function environment(home: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { HOME: home, CODEX_HOME: home };
	for (const key of [
		"PATH",
		"TMPDIR",
		"SYSTEMROOT",
		"HTTP_PROXY",
		"HTTPS_PROXY",
		"NO_PROXY",
		"SSL_CERT_FILE",
		"SSL_CERT_DIR",
	]) {
		if (process.env[key]) env[key] = process.env[key];
	}
	return env;
}

/** Check exactly the researched client, rather than guessing newer CLI/schema compatibility. */
async function checkVersion(command: readonly string[], env: NodeJS.ProcessEnv): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		execFile(
			command[0] as string,
			[...command.slice(1), "--version"],
			{ env, cwd: env.CODEX_HOME, timeout: 3000, maxBuffer: 1024 },
			(error, stdout) => {
				if (error)
					reject(
						new CodexResetError(
							"unavailable",
							`Codex client unavailable; install the verified ${CODEX_VERSION} client. No fallback attempted.`,
						),
					);
				else if (stdout.trim() !== `codex-cli ${CODEX_VERSION}`)
					reject(
						new CodexResetError(
							"unsupported",
							`Codex client version mismatch; only ${CODEX_VERSION} is verified. No guessed command or fallback attempted.`,
						),
					);
				else resolve();
			},
		);
	});
}

/** JSONL transport with bounded frames, one deadline per caller, and sanitized errors only. */
class StdioSession implements CodexSession {
	private nextId = 0;
	private buffer = "";
	private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
	private stopped = false;
	private closing?: Promise<void>;
	private readonly exited: Promise<void>;
	private authenticated = false;

	constructor(
		readonly identity: CodexIdentity,
		private readonly child: ChildProcessWithoutNullStreams,
		private readonly home: string,
		private readonly options: CodexSessionOptions,
	) {
		this.exited = new Promise((resolve) => child.once("close", resolve));
		child.stderr.resume(); // Drain without retaining or exposing credential-bearing diagnostics.
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => this.receive(chunk));
		child.on("error", () => this.fail("Codex app-server could not start."));
		child.on("exit", () => this.fail("Codex app-server disconnected; a dispatched reset may have an unknown outcome."));
		child.stdin.on("error", () => this.fail("Codex app-server input closed."));
	}

	/** Bind every refreshed token to the original Pi principal/workspace, never a separate CLI login. */
	async checkIdentity(): Promise<void> {
		if ((await readIdentity(this.options.getToken)).fingerprint !== this.identity.fingerprint)
			throw new CodexResetError("authentication", "Pi Codex account/workspace changed; reset operation stopped.");
	}

	/** Authentication is supplied in memory using the documented external-token contract. */
	async initialize(signal?: AbortSignal): Promise<void> {
		record(
			await this.request(
				"initialize",
				{ clientInfo: { name: "pi_subscription_router", version: "0.6.0" }, capabilities: { experimentalApi: true } },
				signal,
			),
		);
		this.write({ method: "initialized" });
		const login = record(
			await this.request(
				"account/login/start",
				{ type: "chatgptAuthTokens", accessToken: this.identity.token, chatgptAccountId: this.identity.account },
				signal,
			),
		);
		if (login.type !== "chatgptAuthTokens")
			throw new CodexResetError("unsupported", "Codex external-token account binding is unsupported by this client.");
		const account = record(await this.request("account/read", { refreshToken: false }, signal));
		if (record(account.account).type !== "chatgpt")
			throw new CodexResetError("authentication", "Codex did not bind the current Pi ChatGPT account.");
		this.authenticated = true;
	}

	request(method: string, params: unknown, signal?: AbortSignal, dispatched?: () => void): Promise<unknown> {
		if (signal?.aborted)
			return Promise.reject(
				new CodexResetError("cancelled", "Codex operation cancelled; dispatched resets require reconciliation."),
			);
		if (this.stopped) return Promise.reject(new CodexResetError("transport", "Codex app-server is disconnected."));
		return new Promise((resolve, reject) => {
			const id = ++this.nextId;
			const finish = (error?: Error, value?: unknown) => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
				this.pending.delete(id);
				if (error) reject(error);
				else resolve(value);
			};
			const abort = () =>
				finish(
					new CodexResetError("cancelled", "Codex operation cancelled; dispatched resets require reconciliation."),
				);
			const timer = setTimeout(
				() =>
					finish(
						new CodexResetError("transport", "Codex app-server timed out; dispatched resets require reconciliation."),
					),
				this.options.timeoutMs ?? 25_000,
			);
			this.pending.set(id, { resolve: (value) => finish(undefined, value), reject: (error) => finish(error) });
			signal?.addEventListener("abort", abort, { once: true });
			try {
				dispatched?.();
				this.write({ id, method, params });
			} catch {
				finish(new CodexResetError("transport", "Codex request could not be sent; its outcome may be unknown."));
			}
		});
	}

	/** Never echo raw JSON-RPC errors, stderr, server notifications or unknown method payloads. */
	private receive(chunk: string): void {
		this.buffer += chunk;
		if (this.buffer.length > 262_144) {
			this.fail("Codex app-server exceeded the response bound.");
			return;
		}
		let newline = this.buffer.indexOf("\n");
		while (newline >= 0) {
			const line = this.buffer.slice(0, newline);
			this.buffer = this.buffer.slice(newline + 1);
			try {
				const message = record(JSON.parse(line));
				if (typeof message.method === "string") {
					if (message.method === "account/chatgptAuthTokens/refresh" && message.id !== undefined)
						void this.refreshToken(message.id);
					else if (message.id !== undefined)
						this.write({ id: message.id, error: { code: -32601, message: "Unsupported server request" } });
					else if (
						this.authenticated &&
						message.method === "account/updated" &&
						record(message.params).authMode !== "chatgptAuthTokens"
					)
						this.fail("Codex account binding changed.");
				} else if (typeof message.id === "number") {
					const caller = this.pending.get(message.id);
					if (message.error !== undefined)
						caller?.reject(
							new CodexResetError(
								record(message.error).code === -32601 ? "unsupported" : "transport",
								"Codex rejected the supported request; no fallback attempted.",
							),
						);
					else caller?.resolve(message.result);
				}
			} catch {
				this.fail("Codex app-server returned invalid protocol data.");
				return;
			}
			newline = this.buffer.indexOf("\n");
		}
	}

	private async refreshToken(id: unknown): Promise<void> {
		try {
			const identity = await readIdentity(this.options.getToken);
			if (identity.fingerprint !== this.identity.fingerprint) throw new Error();
			this.write({ id, result: { accessToken: identity.token, chatgptAccountId: identity.account } });
		} catch {
			this.fail("Pi Codex account refresh failed or changed identity.");
		}
	}

	private write(message: unknown): void {
		this.child.stdin.write(`${JSON.stringify(message)}\n`);
	}
	private fail(message: string): void {
		this.stopped = true;
		for (const caller of this.pending.values()) caller.reject(new CodexResetError("transport", message));
	}

	/** Close the dedicated process before removing its private ephemeral credential/config home. */
	close(): Promise<void> {
		this.closing ??= (async () => {
			this.fail("Codex session closed.");
			this.child.stdin.end();
			const kill = setTimeout(() => this.child.kill("SIGKILL"), 1000);
			let deadline: ReturnType<typeof setTimeout> | undefined;
			try {
				this.child.kill("SIGTERM");
				await Promise.race([
					this.exited,
					new Promise<never>((_resolve, reject) => {
						deadline = setTimeout(
							() =>
								reject(
									new CodexResetError(
										"cleanup",
										"Codex process exit could not be confirmed; private temporary state is retained rather than deleted under a live process.",
									),
								),
							3000,
						);
					}),
				]);
				await rm(this.home, { recursive: true, force: true });
			} finally {
				clearTimeout(kill);
				clearTimeout(deadline);
			}
		})();
		return this.closing;
	}
}

/** No account discovery from disk: Pi's credential owner supplies and refreshes the existing account. */
export async function openCodexSession(options: CodexSessionOptions, signal?: AbortSignal): Promise<CodexSession> {
	const identity = await readIdentity(options.getToken, signal);
	const command = options.command ?? ["codex"];
	if (!command[0]) throw new CodexResetError("unavailable", "Codex client command is unavailable.");
	const home = await mkdtemp(join(tmpdir(), "pi-codex-resets-"));
	let session: StdioSession | undefined;
	try {
		await checkVersion(command, environment(home));
		const child = spawn(command[0], [...command.slice(1), "app-server", "--listen", "stdio://"], {
			env: environment(home),
			cwd: home,
			stdio: "pipe",
		});
		session = new StdioSession(identity, child, home, options);
		await session.initialize(signal);
		return session;
	} catch (error) {
		if (session) await session.close();
		else await rm(home, { recursive: true, force: true });
		throw error;
	}
}
