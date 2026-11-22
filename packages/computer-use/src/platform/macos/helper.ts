import { spawn } from "node:child_process";
import { constants as fsConstants, realpathSync, statSync } from "node:fs";
import { access, lstat, mkdir, realpath, stat } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toBoolean, toFiniteNumber, toOptionalString } from "../coerce.ts";
import type { PlatformDiagnostics } from "../types.ts";
import { macosHelperBuild, macosSigningRefusal, withDirectoryLock } from "./helper-build.mjs";
import { resolveMacosHelperAppPath } from "./helper-path.mjs";

const COMMAND_TIMEOUT_MS = 15_000;
const NO_LISTENER_CODES = new Set<string | undefined>(["ENOENT", "ECONNREFUSED"]);
const HELPER_PROTOCOL_VERSION = 7;
const HELPER_SETUP_TIMEOUT_MS = 60_000;
/** Deadline of one read-only diagnostics probe. A resident that answers within it is used as is. */
const DIAGNOSTICS_PROBE_TIMEOUT_MS = 4_000;
/**
 * Total time read-only probes keep retrying a resident that has not answered yet. Slow is not absent: the
 * client never launches or installs because diagnostics timed out, it fails closed when this runs out.
 */
const READ_ONLY_PROBE_BUDGET_MS = 8_000;
/** Polls, `LAUNCH_POLL_MS` apart, for a launched daemon to start listening. */
const LAUNCH_POLLS = 30;
const LAUNCH_POLL_MS = 100;
/** Bound on waiting for another client's launch or setup; above `HELPER_SETUP_TIMEOUT_MS`. */
const LIFECYCLE_LOCK_WAIT_MS = 75_000;
/** A lifecycle lock older than this belongs to a client that died mid-launch or mid-setup. */
const LIFECYCLE_LOCK_STALE_MS = 120_000;

export const HELPER_BUNDLE_ID = "com.injaneity.pi-computer-use";
export const HELPER_APP_PATH = resolveMacosHelperAppPath();
export const HELPER_APP_EXECUTABLE_PATH = path.join(HELPER_APP_PATH, "Contents", "MacOS", "bridge");
const DEFAULT_HELPER_SOCKET_PATH = path.join(os.homedir(), "Library", "Caches", "pi-computer-use", "bridge.sock");
const configuredSocketPath = path.resolve(process.env.PI_CU_SOCKET_PATH ?? DEFAULT_HELPER_SOCKET_PATH);
const usingExternalHelperSocket = !isManagedSocket(configuredSocketPath);
export const HELPER_SOCKET_PATH = usingExternalHelperSocket ? configuredSocketPath : DEFAULT_HELPER_SOCKET_PATH;

function canonicalPath(filePath: string): string {
	try {
		return realpathSync.native(filePath);
	} catch {
		return filePath;
	}
}

function isManagedSocket(socketPath: string): boolean {
	if (socketPath === DEFAULT_HELPER_SOCKET_PATH) return true;
	const resolved = canonicalPath(socketPath);
	// Reserve case variants of the managed socket name in its directory even
	// before the socket exists, when there is no inode to compare.
	return (
		path.basename(resolved).toLowerCase() === path.basename(DEFAULT_HELPER_SOCKET_PATH) &&
		canonicalPath(path.dirname(resolved)) === canonicalPath(path.dirname(DEFAULT_HELPER_SOCKET_PATH))
	);
}

function statIfPresent(filePath: string): ReturnType<typeof statSync> | undefined {
	try {
		return statSync(filePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

/**
 * Whether this connection reaches the managed socket. The import-time classification only decides who may
 * launch or install; it cannot see an alias that resolves later, a hard link, or a default pathname that links
 * to the override. Recheck the name rule and compare both endpoints' inodes now. Anything that cannot be
 * inspected counts as managed, so the build check applies.
 */
function connectionIsManaged(): boolean {
	if (!usingExternalHelperSocket) return true;
	try {
		if (isManagedSocket(configuredSocketPath)) return true;
		const configured = statIfPresent(configuredSocketPath);
		const managed = statIfPresent(DEFAULT_HELPER_SOCKET_PATH);
		return (
			configured !== undefined &&
			managed !== undefined &&
			configured.dev === managed.dev &&
			configured.ino === managed.ino
		);
	} catch {
		return true;
	}
}

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SETUP_HELPER_SCRIPT = path.join(PACKAGE_ROOT, "scripts", "setup-helper.mjs");
let expectedBuild: string | undefined;

/**
 * Serialize launch and runtime setup across every client of the managed socket. Beside the daemon's own
 * `<socket>.lock`, which the daemon holds for its lifetime, so the two never contend.
 */
async function withLifecycleLock<T>(callback: () => Promise<T>): Promise<T> {
	await mkdir(path.dirname(HELPER_SOCKET_PATH), { recursive: true });
	return await withDirectoryLock(`${HELPER_SOCKET_PATH}.lifecycle.lock`, callback, {
		waitMs: LIFECYCLE_LOCK_WAIT_MS,
		staleMs: LIFECYCLE_LOCK_STALE_MS,
		label: "pi-computer-use helper lifecycle",
	});
}

export class HelperTransportError extends Error {
	readonly code?: string;

	constructor(message: string, code?: string) {
		super(message);
		this.name = "HelperTransportError";
		this.code = code;
	}
}

export class HelperCommandError extends Error {
	readonly code?: string;
	readonly evidence?: Record<string, unknown>;

	constructor(message: string, code?: string, evidence?: Record<string, unknown>) {
		super(message);
		this.name = "HelperCommandError";
		this.code = code;
		this.evidence = evidence;
	}
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error("Operation aborted.");
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	throwIfAborted(signal);
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error("Operation aborted."));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	}).finally(() => signal?.throwIfAborted?.());
}

/**
 * Whether automatic setup may install the helper executable: only when nothing at all is at its path.
 * @returns `ready`, `missing` (`ENOENT`), or why an existing entry is unusable: not a regular file, not
 * executable, or not inspectable (e.g. `EACCES`, `ENOTDIR`, a dangling symlink).
 */
async function helperExecutableState(): Promise<"ready" | "missing" | { unusable: string }> {
	try {
		await lstat(HELPER_APP_EXECUTABLE_PATH);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code === "ENOENT" ? "missing" : { unusable: String(code) };
	}
	try {
		if (!(await stat(HELPER_APP_EXECUTABLE_PATH)).isFile()) return { unusable: "not a regular file" };
		await access(HELPER_APP_EXECUTABLE_PATH, fsConstants.X_OK);
		return "ready";
	} catch (error) {
		return { unusable: String((error as NodeJS.ErrnoException).code) };
	}
}

async function isResolvedHelperExecutable(filePath?: string): Promise<boolean> {
	if (!filePath) return true;
	const [actualPath, expectedPath] = await Promise.all([
		realpath(filePath).catch(() => path.resolve(filePath)),
		realpath(HELPER_APP_EXECUTABLE_PATH).catch(() => path.resolve(HELPER_APP_EXECUTABLE_PATH)),
	]);
	return actualPath === expectedPath;
}

/** True when the daemon process started before the installed binary was last written (it runs old code). */
export function helperPredatesBinary(processStartMs: number, binaryChangeMs: number): boolean {
	return Number.isFinite(processStartMs) && Number.isFinite(binaryChangeMs) && processStartMs + 1_000 < binaryChangeMs;
}

async function daemonRunsOldBinary(pid: number): Promise<boolean> {
	if (!Number.isFinite(pid) || pid <= 0) return false;
	try {
		const elapsed = await new Promise<string>((resolve, reject) => {
			const child = spawn("ps", ["-o", "etime=", "-p", String(pid)], { stdio: ["ignore", "pipe", "ignore"] });
			let out = "";
			child.stdout.on("data", (chunk) => {
				out += chunk;
			});
			child.on("error", reject);
			child.on("close", () => resolve(out.trim()));
		});
		// etime is [[dd-]hh:]mm:ss
		const [days, clock] = elapsed.includes("-") ? elapsed.split("-") : ["0", elapsed];
		const parts = clock.split(":").map(Number);
		const seconds = parts.reduce((total, part) => total * 60 + part, 0) + Number(days) * 86_400;
		if (!Number.isFinite(seconds)) return false;
		// ctime, not mtime: ditto preserves mtime, but any install changes ctime.
		const { ctimeMs } = await stat(HELPER_APP_EXECUTABLE_PATH);
		return helperPredatesBinary(Date.now() - seconds * 1_000, ctimeMs);
	} catch {
		return false;
	}
}

export async function runProcess(
	command: string,
	args: string[],
	timeoutMs: number,
	signal?: AbortSignal,
	env?: NodeJS.ProcessEnv,
): Promise<void> {
	throwIfAborted(signal);

	await new Promise<void>((resolve, reject) => {
		const child = spawn(command, args, {
			stdio: ["ignore", "pipe", "pipe"],
			env,
		});

		let stderr = "";
		let stdout = "";

		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			cleanup();
			reject(new Error(`Command timed out after ${timeoutMs}ms: ${command} ${args.join(" ")}`));
		}, timeoutMs);

		const onAbort = () => {
			child.kill("SIGTERM");
			cleanup();
			reject(new Error("Operation aborted."));
		};

		const cleanup = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		};

		child.stdout.on("data", (chunk) => {
			stdout += String(chunk);
		});

		child.stderr.on("data", (chunk) => {
			stderr += String(chunk);
		});

		child.on("error", (error) => {
			cleanup();
			reject(error);
		});

		child.on("close", (code) => {
			cleanup();
			if (code === 0) {
				resolve();
				return;
			}
			const output = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
			reject(new Error(`Command failed (${code}): ${command} ${args.join(" ")}\n${output}`.trim()));
		});

		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export class MacosHelperClient {
	private daemonAvailable = false;
	private requestSequence = 0;
	private diagnosticsCache?: PlatformDiagnostics;
	helperBuild?: string;
	staleBuildMessage?: string;

	/**
	 * Check one connection's diagnostics before anything else is sent on it. A managed helper must report
	 * exactly this package's build; an external one only the expected protocol (its build, path and age are
	 * its operator's business).
	 */
	verifyBuild(
		result: { buildIdentity?: unknown; executablePath?: unknown; protocolVersion?: unknown } | undefined,
		managed = connectionIsManaged(),
	): void {
		this.staleBuildMessage = undefined;
		this.helperBuild = toOptionalString(result?.buildIdentity) ?? "unknown";
		if (!managed) {
			const protocol = Math.trunc(toFiniteNumber(result?.protocolVersion, 0));
			if (protocol === HELPER_PROTOCOL_VERSION) return;
			throw new HelperCommandError(
				`External helper at ${HELPER_SOCKET_PATH} reports protocol ${protocol}; expected ${HELPER_PROTOCOL_VERSION}. Its operator must update and restart it.`,
				"helper_protocol",
			);
		}
		expectedBuild ??= macosHelperBuild(PACKAGE_ROOT);
		if (this.helperBuild !== expectedBuild) {
			const builds = `helper build ${this.helperBuild}, expected ${expectedBuild}`;
			const repair = `: from the package root, run \`node scripts/setup-helper.mjs --runtime\`, then \`node scripts/setup-helper.mjs --stop-stale-daemon\` if a stale daemon is still running (setup reports the app already current). For a source checkout, rebuild first with \`npm run build:native\`. See https://github.com/nredd/pi-harness/tree/main/packages/computer-use#repair-a-missing-macos-helper${macosSigningRefusal(HELPER_APP_PATH, expectedBuild)}`;
			// Status shows the build IDs and the repair; the daemon-reported executable path stays in the error.
			this.staleBuildMessage = `${builds}${repair}`;
			const executable = toOptionalString(result?.executablePath) ?? HELPER_APP_EXECUTABLE_PATH;
			throw new HelperCommandError(
				`pi-computer-use helper at ${executable} is stale (${builds})${repair}`,
				"stale_helper",
			);
		}
	}

	get diagnostics(): PlatformDiagnostics | undefined {
		return this.diagnosticsCache;
	}

	async ensureInstalled(signal?: AbortSignal): Promise<void> {
		if (usingExternalHelperSocket) return;
		// Installation is a deployment/repair operation, not part of every new
		// agent process's hot path. Protocol compatibility is checked against the
		// live daemon immediately afterwards.
		const state = await helperExecutableState();
		if (state === "ready") return;
		if (state !== "missing") {
			// Setup would replace whatever is there; only an operator may decide that.
			throw new Error(
				`pi-computer-use helper executable at ${HELPER_APP_EXECUTABLE_PATH} exists but is unusable (${state.unusable}); setup was not run. Inspect it, then repair it explicitly with \`node scripts/setup-helper.mjs --runtime\` from the package root.`,
			);
		}

		// Setup can replace the app, so it runs only on positive absence, rechecked under the lifecycle lock
		// so a daemon another client started meanwhile is used, not replaced. `--automatic` makes setup
		// refuse, never stop, any helper it still finds running.
		if (await this.probeResident(signal)) return;
		const installed = await withLifecycleLock(async () => {
			if (await this.probeResident(signal)) return true;
			// Re-enter Electron and Bun standalone hosts as their JavaScript runtimes.
			await runProcess(
				process.execPath,
				[SETUP_HELPER_SCRIPT, "--runtime", "--automatic"],
				HELPER_SETUP_TIMEOUT_MS,
				signal,
				{ ...process.env, ELECTRON_RUN_AS_NODE: "1", BUN_BE_BUN: "1" },
			);
			return false;
		});
		if (installed) return;

		if ((await helperExecutableState()) !== "ready") {
			throw new Error(`Failed to install pi-computer-use helper app at ${HELPER_APP_PATH}.`);
		}
	}

	async launchDaemon(signal?: AbortSignal): Promise<void> {
		if (usingExternalHelperSocket)
			throw new HelperTransportError(`External helper socket is unavailable at ${HELPER_SOCKET_PATH}.`);
		await mkdir(path.dirname(HELPER_SOCKET_PATH), { recursive: true });
		// Open the resolved bundle directly so a legacy system-wide copy with the
		// same bundle id cannot win LaunchServices resolution.
		await runProcess(
			"open",
			["-n", "-g", HELPER_APP_PATH, "--args", "serve", "--socket", HELPER_SOCKET_PATH],
			COMMAND_TIMEOUT_MS,
			signal,
		);
	}

	async daemonCommand<T>(
		cmd: string,
		args: Record<string, unknown>,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<T> {
		// An already-aborted signal never fires again, so the request would be sent and wait out its timeout.
		throwIfAborted(signal);
		return await new Promise<T>((resolve, reject) => {
			const id = `req_${++this.requestSequence}`;
			const probeId = `build_${id}`;
			const socket = net.createConnection(HELPER_SOCKET_PATH);
			let buffer = "";
			// Every effect connection is checked first: a replacement daemon gets no command before its own check.
			let checkingBuild = cmd !== "diagnostics";
			let managed = true;
			let settled = false;
			let connected = false;
			// First outcome wins: the `close` that follows a reply, timeout, abort or error must not settle again.
			// Socket listeners die with the socket; the timer and the abort listener are released here.
			const settle = (finish: () => void) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				finish();
			};
			const timer = setTimeout(
				() =>
					settle(() => {
						socket.destroy();
						reject(
							new HelperTransportError(`Daemon command '${cmd}' timed out after ${timeoutMs}ms.`, "helper_timeout"),
						);
					}),
				timeoutMs,
			);
			const onAbort = () =>
				settle(() => {
					socket.destroy();
					reject(new Error("Operation aborted."));
				});
			// Give the helper a chance to report its posted prefix before the socket timer wins.
			const keyboardDeadlineMs =
				cmd === "desktopInput" || cmd === "act" || cmd === "actBatch" ? Date.now() + timeoutMs - 250 : undefined;
			const sendCommand = () => socket.write(`${JSON.stringify({ id, cmd, ...args, keyboardDeadlineMs })}\n`);
			const onConnect = () => {
				connected = true;
				managed = connectionIsManaged();
				if (checkingBuild) socket.write(`${JSON.stringify({ id: probeId, cmd: "diagnostics" })}\n`);
				else sendCommand();
			};
			const onData = (chunk: string) => {
				buffer += chunk;
				const newline = buffer.indexOf("\n");
				if (newline < 0) return;
				if (checkingBuild) {
					try {
						const probe = JSON.parse(buffer.slice(0, newline));
						if (probe.id !== probeId || probe.ok !== true) {
							throw new HelperTransportError("Invalid helper build probe reply.");
						}
						this.verifyBuild(probe.result, managed);
						checkingBuild = false;
						buffer = "";
						sendCommand();
					} catch (error) {
						settle(() => {
							socket.destroy();
							reject(error);
						});
					}
					return;
				}
				settle(() => {
					socket.end();
					try {
						const parsed = JSON.parse(buffer.slice(0, newline));
						if (cmd === "diagnostics" && parsed.id !== id) {
							throw new HelperTransportError("Invalid helper diagnostics reply ID.");
						}
						if (parsed.ok === true) {
							if (cmd === "diagnostics") this.verifyBuild(parsed.result, managed);
							resolve(parsed.result as T);
						} else
							reject(
								new HelperCommandError(
									parsed?.error?.message ?? `Daemon command '${cmd}' failed.`,
									parsed?.error?.code,
									parsed?.error?.evidence,
								),
							);
					} catch (error) {
						reject(error);
					}
				});
			};
			const onError = (error: NodeJS.ErrnoException) =>
				settle(() => {
					const absent = !connected && NO_LISTENER_CODES.has(error.code);
					reject(new HelperTransportError(error.message, absent ? "helper_not_listening" : undefined));
				});
			// The helper crashed or dropped the socket before a full reply line: fail now, not at the timeout.
			const onDisconnect = () =>
				settle(() => {
					socket.destroy();
					reject(new HelperTransportError(`Helper disconnected before replying to '${cmd}'.`, "helper_disconnected"));
				});
			signal?.addEventListener("abort", onAbort, { once: true });
			socket.setEncoding("utf8");
			socket.on("connect", onConnect);
			socket.on("data", onData);
			socket.on("error", onError);
			socket.on("end", onDisconnect);
			socket.on("close", onDisconnect);
		});
	}

	/**
	 * Read-only diagnostics probe of the resident helper.
	 * @returns true when a resident answered, false only on positive absence: `ENOENT` or `ECONNREFUSED`
	 * before any connection. A resident that is slow to answer is retried within `READ_ONLY_PROBE_BUDGET_MS`.
	 * @throws The helper's own refusal (`stale_helper`, an error reply), an abort, or a `helper_inconclusive`
	 * transport error for anything else: a timeout past the budget, a malformed reply, a disconnect or a
	 * connect error such as `EACCES`. Callers must not launch or install after a throw.
	 */
	private async probeResident(signal?: AbortSignal): Promise<boolean> {
		const deadline = Date.now() + READ_ONLY_PROBE_BUDGET_MS;
		while (true) {
			try {
				const remaining = Math.max(deadline - Date.now(), 1);
				await this.daemonCommand("diagnostics", {}, Math.min(DIAGNOSTICS_PROBE_TIMEOUT_MS, remaining), signal);
				return true;
			} catch (error) {
				if (!(error instanceof HelperTransportError || error instanceof SyntaxError)) throw error;
				if (error instanceof HelperTransportError && error.code === "helper_not_listening") return false;
				if (error instanceof HelperTransportError && error.code === "helper_timeout" && Date.now() < deadline) continue;
				throw new HelperTransportError(
					`Cannot verify the pi-computer-use helper at ${HELPER_SOCKET_PATH}; it was not launched and setup was not run: ${String(error)}`,
					"helper_inconclusive",
				);
			}
		}
	}

	async ensureDaemon(signal?: AbortSignal): Promise<boolean> {
		if (this.daemonAvailable) return true;
		if (!(await this.probeResident(signal))) {
			if (usingExternalHelperSocket) return await this.awaitListener(signal);
			// Launch only on positive absence, rechecked under the lifecycle lock, and hold the lock until the
			// daemon listens so a concurrent client neither launches a second one nor runs setup under it.
			return await withLifecycleLock(async () => {
				if (await this.probeResident(signal)) return this.markAvailable();
				await this.launchDaemon(signal).catch(() => undefined);
				return await this.awaitListener(signal);
			});
		}
		return this.markAvailable();
	}

	private markAvailable(): true {
		this.daemonAvailable = true;
		return true;
	}

	/** Poll for a listener; absence keeps waiting, every inconclusive or refused probe throws. */
	private async awaitListener(signal?: AbortSignal): Promise<boolean> {
		for (let index = 0; index < LAUNCH_POLLS; index += 1) {
			if (await this.probeResident(signal)) return this.markAvailable();
			await sleep(LAUNCH_POLL_MS, signal);
		}
		return false;
	}

	async command<T>(
		cmd: string,
		args: Record<string, unknown> = {},
		options?: { timeoutMs?: number; signal?: AbortSignal },
	): Promise<T> {
		const timeoutMs = options?.timeoutMs ?? COMMAND_TIMEOUT_MS;
		if (!(await this.ensureDaemon(options?.signal))) {
			throw new HelperTransportError(`pi-computer-use helper app daemon is unavailable at ${HELPER_APP_PATH}.`);
		}
		try {
			return await this.daemonCommand<T>(cmd, args, timeoutMs, options?.signal);
		} catch (error) {
			this.daemonAvailable = false;
			throw error instanceof Error ? error : new Error(String(error));
		}
	}

	async restart(signal?: AbortSignal): Promise<void> {
		if (usingExternalHelperSocket) {
			throw new HelperTransportError(`External helper at ${HELPER_SOCKET_PATH} must be restarted by its operator.`);
		}
		// A failed shutdown is not fatal; the probe below still refuses a stale or unverifiable resident.
		await this.command("shutdown", {}, { signal, timeoutMs: 2_000 }).catch(() => undefined);
		this.daemonAvailable = false;
		await sleep(400, signal);
		if (!(await this.ensureDaemon(signal))) {
			throw new Error(`pi-computer-use helper did not come back after restart. Helper app: ${HELPER_APP_PATH}`);
		}
	}

	async diagnosticsCommand(signal?: AbortSignal): Promise<PlatformDiagnostics> {
		const result = await this.command<any>("diagnostics", {}, { signal });
		const diagnostics = {
			protocolVersion: Math.trunc(toFiniteNumber(result?.protocolVersion, 0)),
			architectureVersion: Math.trunc(toFiniteNumber(result?.architectureVersion, 0)),
			invariants: Array.isArray(result?.invariants)
				? result.invariants.filter((value: unknown): value is string => typeof value === "string")
				: [],
			pid: Math.trunc(toFiniteNumber(result?.pid, 0)),
			parentPid: Math.trunc(toFiniteNumber(result?.parentPid, 0)) || undefined,
			parentAppName: toOptionalString(result?.parentAppName),
			parentBundleId: toOptionalString(result?.parentBundleId),
			parentPath: toOptionalString(result?.parentPath),
			executablePath: toOptionalString(result?.executablePath),
			os: toOptionalString(result?.macOS),
			arch: toOptionalString(result?.arch),
			accessibility: toBoolean(result?.accessibility),
			screenRecording: toBoolean(result?.screenRecording),
		};
		this.diagnosticsCache = diagnostics;
		return diagnostics;
	}

	async ensureProtocol(signal?: AbortSignal): Promise<PlatformDiagnostics> {
		// `verifyBuild` already refused a wrong build (managed) or protocol (external) on this connection.
		let diagnostics = await this.diagnosticsCommand(signal);
		if (usingExternalHelperSocket) return diagnostics;
		const executableMatches = await isResolvedHelperExecutable(diagnostics.executablePath);
		if (
			diagnostics.protocolVersion === HELPER_PROTOCOL_VERSION &&
			executableMatches &&
			!(await daemonRunsOldBinary(diagnostics.pid))
		)
			return diagnostics;

		// The helper daemon outlives Pi, so restarting/reloading Pi alone does not
		// replace a stale daemon or one launched from the legacy system location.
		// Stop it through the backwards-compatible command channel and relaunch
		// the exact app bundle that ensureInstalled() resolved.
		await this.restart(signal);
		diagnostics = await this.diagnosticsCommand(signal);
		const relaunchedExecutableMatches = await isResolvedHelperExecutable(diagnostics.executablePath);
		if (diagnostics.protocolVersion !== HELPER_PROTOCOL_VERSION || !relaunchedExecutableMatches) {
			this.daemonAvailable = false;
			throw new Error(
				`pi-computer-use helper mismatch after relaunch: expected protocol ${HELPER_PROTOCOL_VERSION} and executable ${HELPER_APP_EXECUTABLE_PATH}; got protocol ${diagnostics.protocolVersion} and executable ${diagnostics.executablePath ?? "unknown"}. Reinstall or rebuild the helper app at ${HELPER_APP_PATH}.`,
			);
		}
		return diagnostics;
	}
}

export const macosHelper = new MacosHelperClient();

class MacosActivityGlowConnection {
	private socket?: net.Socket;
	private connecting?: Promise<net.Socket>;
	private tail: Promise<void> = Promise.resolve();
	private requestSequence = 0;

	async setActive(active: boolean): Promise<void> {
		const operation = this.tail.then(async () => {
			const socket = await this.ensureConnection();
			await this.send(socket, "setActivityGlow", { active });
		});
		this.tail = operation.catch(() => undefined);
		await operation;
	}

	async close(): Promise<void> {
		// `tail` is `operation.catch(...)` in `setActive`, so it never rejects.
		await this.tail;
		const socket = this.socket;
		this.socket = undefined;
		this.connecting = undefined;
		if (!socket) return;
		if (socket.writable) socket.end();
		else socket.destroy();
	}

	private async ensureConnection(): Promise<net.Socket> {
		if (this.socket && !this.socket.destroyed) return this.socket;
		if (this.connecting) return await this.connecting;

		this.connecting = (async () => {
			if (!(await macosHelper.ensureDaemon())) {
				throw new HelperTransportError(`pi-computer-use helper app daemon is unavailable at ${HELPER_APP_PATH}.`);
			}
			return await new Promise<net.Socket>((resolve, reject) => {
				const socket = net.createConnection(HELPER_SOCKET_PATH);
				const onError = (error: Error) => {
					socket.destroy();
					reject(new HelperTransportError(error.message));
				};
				socket.once("error", onError);
				socket.once("connect", () => {
					socket.off("error", onError);
					socket.on("error", () => socket.destroy());
					socket.on("close", () => {
						if (this.socket === socket) this.socket = undefined;
					});
					const verify = async () => {
						macosHelper.verifyBuild(await this.send(socket, "diagnostics"));
						this.socket = socket;
						resolve(socket);
					};
					void verify().catch((error) => {
						socket.destroy();
						reject(error);
					});
				});
			});
		})();

		try {
			return await this.connecting;
		} finally {
			this.connecting = undefined;
		}
	}

	private async send(socket: net.Socket, cmd: string, args = {}): Promise<Record<string, unknown> | undefined> {
		return await new Promise((resolve, reject) => {
			const id = `activity_${++this.requestSequence}`;
			let buffer = "";
			const timer = setTimeout(() => {
				cleanup();
				socket.destroy();
				reject(new HelperTransportError("Activity glow command timed out."));
			}, 2_000);
			const cleanup = () => {
				clearTimeout(timer);
				socket.off("data", onData);
				socket.off("close", onClose);
			};
			const onClose = () => {
				cleanup();
				reject(new HelperTransportError("Activity glow connection closed."));
			};
			const onData = (chunk: Buffer | string) => {
				buffer += String(chunk);
				const newline = buffer.indexOf("\n");
				if (newline < 0) return;
				cleanup();
				try {
					const response = JSON.parse(buffer.slice(0, newline));
					if (response.id === id && response.ok === true) resolve(response.result);
					else
						reject(
							new HelperCommandError(
								response?.error?.message ?? "Activity glow command failed.",
								response?.error?.code,
							),
						);
				} catch (error) {
					reject(error);
				}
			};
			socket.on("data", onData);
			socket.once("close", onClose);
			socket.write(`${JSON.stringify({ id, cmd, ...args })}\n`);
		});
	}
}

export const macosActivityGlow = new MacosActivityGlowConnection();
