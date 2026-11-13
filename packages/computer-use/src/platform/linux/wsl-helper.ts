import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, open, realpath, rmdir } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { WINDOWS_HELPER_PROTOCOL_VERSION } from "../windows/helper.ts";
import type { WindowsHelperTransport } from "../windows/backend.ts";
import { isWsl, wslProbe } from "./wsl.ts";

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_PENDING = 32;

/** Owner-provisioned executable identity and one shared host-volume lease for all participating WSL sessions. */
export interface WslHostHelperConfig {
	path: string;
	sha256: string;
	lock: string;
}

function hostPath(value: string | undefined): value is string {
	return !!value && /^\/mnt\/[a-z]\/[^\r\n\0]+$/i.test(value) && !value.split("/").slice(1).some((part) => part === ".." || part === "." || part === "");
}

/** Explicit host opt-in. Never installs a helper, searches PATH, invokes a shell or enables interop. */
export function wslHostHelperConfig(): WslHostHelperConfig | undefined {
	const env = wslProbe.env();
	if (env.PI_COMPUTER_USE_WSL_HOST !== "1") return undefined;
	if (env.CI || !isWsl()) throw new Error("WSL host control requires an interactive WSL guest, never a CI runner.");
	const helper = env.PI_COMPUTER_USE_WSL_HOST_HELPER;
	const sha256 = env.PI_COMPUTER_USE_WSL_HOST_SHA256;
	const lock = env.PI_COMPUTER_USE_WSL_HOST_LOCK;
	if (!hostPath(helper) || !/\.exe$/i.test(helper)) throw new Error("PI_COMPUTER_USE_WSL_HOST_HELPER must name an absolute /mnt/<drive>/...exe on the Windows host.");
	if (!sha256 || !/^[a-f0-9]{64}$/i.test(sha256)) throw new Error("PI_COMPUTER_USE_WSL_HOST_SHA256 must pin the provisioned helper's SHA-256.");
	if (!hostPath(lock) || lock === helper) throw new Error("PI_COMPUTER_USE_WSL_HOST_LOCK must name a shared host-volume lease directory, not the helper.");
	return { path: helper, sha256: sha256.toLowerCase(), lock };
}

interface Reply {
	id: string;
	resolve(value: unknown): void;
	reject(error: Error, acknowledged?: boolean): void;
}

/**
 * Opt-in WSL stdio transport to the existing Windows executable, protocol v4.
 * Every request takes the configured host-volume lease, including reads that can hang UIA.
 * Uncertain delivery retains the lease: killing a WSL interop proxy is NOT proof that host work stopped.
 * The owner must stop the host helper before manually removing a retained lease directory.
 */
export class WslHelperClient implements WindowsHelperTransport {
	private child?: ChildProcessWithoutNullStreams;
	private reply?: Reply;
	private readonly lifetime = new AbortController();
	private queued = 0;

	constructor(private readonly config: WslHostHelperConfig) {}

	/** Validate the explicit file and digest; never provision or repair the Windows host. */
	async ensureInstalled(signal?: AbortSignal): Promise<void> {
		this.check(signal);
		if (await realpath(this.config.path) !== this.config.path) throw new Error("WSL host helper must be a canonical file, without symlinks.");
		await access(this.config.path, constants.X_OK);
		const file = await open(this.config.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			const stat = await file.stat();
			if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw new Error("WSL host helper must be a regular file of at most 64MiB.");
			const hash = createHash("sha256");
			const buffer = Buffer.alloc(64 * 1024);
			let total = 0;
			for (;;) {
				this.check(signal);
				const { bytesRead } = await file.read(buffer);
				if (!bytesRead) break;
				total += bytesRead;
				if (total > 64 * 1024 * 1024) throw new Error("WSL host helper exceeded 64MiB while reading.");
				hash.update(buffer.subarray(0, bytesRead));
			}
			if (hash.digest("hex") !== this.config.sha256) throw new Error("WSL host helper SHA-256 mismatch; verify the provisioned executable.");
		} finally {
			await file.close();
		}
		this.check(signal);
	}

	private check(signal?: AbortSignal): void {
		if (this.lifetime.signal.aborted) throw new Error("WSL host helper transport is closed. Restart Pi; check any retained input lease first.");
		if (signal?.aborted) throw new Error("Operation aborted.");
	}

	/** Terminal after timeout/abort: no late response can authorize another request. */
	dispose(): void {
		this.lifetime.abort();
		this.reply?.reject(new Error("WSL host helper transport closed."));
		this.reply = undefined;
		const child = this.child;
		this.child = undefined;
		if (!child) return;
		child.stdin.destroy();
		child.stdout.destroy();
		child.stderr.destroy();
		child.kill("SIGTERM");
		setTimeout(() => {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		}, 250).unref();
		child.unref();
	}

	private process(): ChildProcessWithoutNullStreams {
		if (this.child) return this.child;
		const child = spawn(this.config.path, [], { stdio: ["pipe", "pipe", "pipe"], shell: false });
		this.child = child;
		let buffer = Buffer.alloc(0);
		const fail = (error: Error) => {
			this.reply?.reject(error);
			this.dispose();
		};
		child.stdin.on("error", fail);
		child.stdout.on("error", fail);
		child.stderr.on("error", fail);
		child.on("error", fail);
		child.stderr.on("data", () => { /* Drain without retaining host diagnostics or private app data. */ });
		child.stdout.on("data", (chunk: Buffer) => {
			if (buffer.length + chunk.length > MAX_FRAME_BYTES) return fail(new Error("WSL host helper response exceeded the frame limit."));
			buffer = Buffer.concat([buffer, chunk]);
			const newline = buffer.indexOf(10);
			if (newline < 0) return;
			const line = buffer.subarray(0, newline).toString("utf8");
			buffer = buffer.subarray(newline + 1);
			try {
				const response = JSON.parse(line);
				if (buffer.length || !this.reply || response?.id !== this.reply.id || response.protocolVersion !== WINDOWS_HELPER_PROTOCOL_VERSION || typeof response.ok !== "boolean") throw new Error("WSL host helper returned an unexpected protocol frame.");
				const pending = this.reply;
				this.reply = undefined;
				if (response.ok) pending.resolve(response.result);
				else {
					const error = new Error("WSL host helper command failed.") as Error & { code?: string };
					error.code = typeof response.error?.code === "string" ? response.error.code : undefined;
					pending.reject(error, true);
				}
			} catch {
				fail(new Error("WSL host helper returned an invalid protocol frame."));
			}
		});
		child.on("close", () => {
			if (this.reply) fail(new Error("WSL host helper disconnected before replying; input lease retained."));
			else if (this.child === child) this.child = undefined;
		});
		return child;
	}

	/** Bound queueing, lock acquisition and response wait by one deadline; preserve Windows pixel coordinates. */
	async command<T>(cmd: string, args: Record<string, unknown> = {}, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<T> {
		this.check(options?.signal);
		const timeoutMs = options?.timeoutMs ?? 15_000;
		if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error("WSL command timeout must be between 1 and 30000ms.");
		if (this.queued >= MAX_PENDING) throw new Error("WSL host helper queue is full.");
		const id = randomUUID();
		const frame = `${JSON.stringify({ protocolVersion: WINDOWS_HELPER_PROTOCOL_VERSION, id, cmd, args })}\n`;
		if (Buffer.byteLength(frame) > MAX_REQUEST_BYTES) throw new Error("WSL host helper request exceeded the frame limit.");
		const deadline = AbortSignal.timeout(timeoutMs);
		const signal = AbortSignal.any([deadline, this.lifetime.signal, ...(options?.signal ? [options.signal] : [])]);
		let acquired = false;
		let sent = false;
		let answered = false;
		this.queued++;
		try {
			await this.ensureInstalled(signal);
			while (!acquired) {
				this.check(signal);
				try { await mkdir(this.config.lock, { mode: 0o700 }); acquired = true; }
				catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
					await delay(25, undefined, { signal });
				}
			}
			this.check(signal);
			const child = this.process();
			return await new Promise<T>((resolve, reject) => {
				const cleanup = () => signal.removeEventListener("abort", abort);
				const abort = () => { cleanup(); reject(new Error(deadline.aborted ? `WSL host command '${cmd}' timed out; input lease retained.` : "Operation aborted; input lease retained.")); this.dispose(); };
				this.reply = {
					id,
					resolve: (value) => { answered = true; cleanup(); resolve(value as T); },
					reject: (error, acknowledged = false) => { answered = acknowledged; cleanup(); reject(error); },
				};
				signal.addEventListener("abort", abort, { once: true });
				sent = true;
				child.stdin.write(frame, (error) => { if (error) { this.reply?.reject(error); this.dispose(); } });
			});
		} catch (error) {
			if (sent && !answered) this.dispose();
			throw error;
		} finally {
			this.queued--;
			// Timeout/disconnect/abort after send leaves host execution uncertain. NEVER steal or age out a lease.
			if (acquired && (!sent || answered)) await rmdir(this.config.lock);
		}
	}
}
