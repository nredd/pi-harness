import { spawn } from "node:child_process";
import { constants as fsConstants, realpathSync, statSync } from "node:fs";
import { access, lstat, mkdir, realpath, stat } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toBoolean, toFiniteNumber, toOptionalString } from "../coerce.ts";
import type { PlatformDiagnostics } from "../types.ts";
import { MACOS_HELPER_BUILD_PATTERN, macosHelperBuild } from "./helper-build.mjs";
import { resolveMacosHelperAppPath } from "./helper-path.mjs";

const COMMAND_TIMEOUT_MS = 15_000;
const NO_LISTENER_CODES = new Set<string | undefined>(["ENOENT", "ECONNREFUSED"]);
const HELPER_PROTOCOL_VERSION = 8;
/** Commands that may post keys and so carry `keyboardDeadlineUptimeMs`. */
const KEYBOARD_COMMANDS = new Set(["desktopInput", "act", "actBatch"]);
/** Keyboard delivery stops this long before the socket timer, so the helper can still report its posted prefix. */
const KEYBOARD_DEADLINE_MARGIN_MS = 250;
const HELPER_SETUP_TIMEOUT_MS = 60_000;
/** Deadline of one read-only diagnostics probe. A resident that answers within it is used as is. */
const DIAGNOSTICS_PROBE_TIMEOUT_MS = 4_000;
/**
 * Total time read-only probes keep retrying a resident that has not answered yet. Slow is not absent: the
 * client never launches or installs because diagnostics timed out, it fails closed when this runs out.
 */
const READ_ONLY_PROBE_BUDGET_MS = 8_000;

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
 * Whether the configured socket reaches the managed one right now. The import-time classification only decides
 * who may launch or install; it cannot see an alias that resolves later, a hard link, or a default pathname that
 * links to the override. Recheck the name rule and compare both endpoints' inodes. An override that cannot be
 * inspected, or has vanished although a connection was just made through it, counts as managed, so the build
 * check applies. An absent default alone keeps a distinct override external.
 */
function connectionIsManaged(): boolean {
	if (!usingExternalHelperSocket) return true;
	try {
		if (isManagedSocket(configuredSocketPath)) return true;
		const configured = statIfPresent(configuredSocketPath);
		if (configured === undefined) return true;
		const managed = statIfPresent(DEFAULT_HELPER_SOCKET_PATH);
		return managed !== undefined && configured.dev === managed.dev && configured.ino === managed.ino;
	} catch {
		return true;
	}
}

/**
 * Open a helper connection and classify its endpoint before and at connect. The external exemption holds only
 * when both agree, and the result is fixed at connect: a path retargeted while a reply is pending changes nothing.
 * Every request socket and the activity glow connect through here.
 * @param onConnect Called once connected, with whether the build check applies.
 */
function connectHelper(onConnect: (managed: boolean) => void): net.Socket {
	const managedBefore = connectionIsManaged();
	const socket = net.createConnection(HELPER_SOCKET_PATH);
	socket.once("connect", () => onConnect(managedBefore || connectionIsManaged()));
	return socket;
}

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SETUP_HELPER_SCRIPT = path.join(PACKAGE_ROOT, "scripts", "setup-helper.mjs");
let expectedBuild: string | undefined;

/** A reported build safe to display: a well-formed build ID, `none` when absent, otherwise `unrecognized`. */
function displayBuild(value: unknown): string {
	if (value === undefined || value === null) return "none";
	return typeof value === "string" && MACOS_HELPER_BUILD_PATTERN.test(value) ? value : "unrecognized";
}

interface HelperReply {
	id?: unknown;
	ok?: unknown;
	/** Unvalidated; read only through optional chaining. */
	result?: Record<string, unknown>;
	error?: { message?: string; code?: string; evidence?: Record<string, unknown> };
}

/** Parse one reply line; anything but a JSON object is a malformed reply, never a `TypeError` later. */
function parseReply(line: string): HelperReply {
	let reply: unknown;
	try {
		reply = JSON.parse(line);
	} catch {
		throw new HelperTransportError("Malformed helper reply.", "helper_malformed");
	}
	if (typeof reply !== "object" || reply === null || Array.isArray(reply)) {
		throw new HelperTransportError("Malformed helper reply.", "helper_malformed");
	}
	return reply as HelperReply;
}

/** The operator's repair for a stale managed helper. The client never replaces, restarts or stops one. */
export const STALE_HELPER_REPAIR =
	"from the package root, run `node scripts/setup-helper.mjs --runtime`. For a source checkout, rebuild first with `npm run build:native`. See https://github.com/nredd/pi-harness/tree/main/packages/computer-use#repair-a-missing-macos-helper";

/** The operator's repair for a matching-build daemon that is not the installed helper. */
export const RESIDENT_MISMATCH_REPAIR =
	"Quit that helper process, then retry: the next command launches the installed app. If the refusal persists, repair the install: from the package root, run `node scripts/setup-helper.mjs --runtime`.";

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

/**
 * The keyboard deadline in the helper's boot-relative clock, which its `diagnostics` reports as `uptimeMs`. Only
 * monotonic time is involved, so a wall-clock step on either side cannot extend delivery past the client's timeout.
 * @param uptimeMs The helper's clock when it built the probe reply; it reads at least this by `nowMs`.
 * @param deadlineMs The client's own deadline in `performance.now()` time.
 * @param nowMs `performance.now()` when the probe reply arrived. Charging the reply's transit time against the
 * budget can only make the deadline earlier.
 * @throws {HelperCommandError} `helper_protocol` when the helper reports no usable clock.
 */
function helperKeyboardDeadline(uptimeMs: unknown, deadlineMs: number, nowMs: number): number {
	if (typeof uptimeMs !== "number" || !Number.isFinite(uptimeMs) || uptimeMs < 0) {
		throw new HelperCommandError(
			`Helper at ${HELPER_SOCKET_PATH} reported no usable uptimeMs clock for the keyboard deadline; the command was not sent. Update and restart it.`,
			"helper_protocol",
		);
	}
	return uptimeMs + (deadlineMs - nowMs);
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

async function isResolvedHelperExecutable(filePath: string): Promise<boolean> {
	const [actualPath, expectedPath] = await Promise.all([
		realpath(filePath).catch(() => path.resolve(filePath)),
		realpath(HELPER_APP_EXECUTABLE_PATH).catch(() => path.resolve(HELPER_APP_EXECUTABLE_PATH)),
	]);
	return actualPath === expectedPath;
}

/**
 * Why a managed daemon whose build already matched is still not the installed helper, or `undefined` when it is.
 * Missing evidence is a mismatch, never a match. Its start time is not compared with the installed binary: the
 * build check already refuses stale code.
 */
async function residentMismatch(diagnostics: PlatformDiagnostics): Promise<string | undefined> {
	if (diagnostics.protocolVersion !== HELPER_PROTOCOL_VERSION) {
		return `reports protocol ${diagnostics.protocolVersion} (expected ${HELPER_PROTOCOL_VERSION})`;
	}
	if (!diagnostics.executablePath) return `reports no executable path (expected ${HELPER_APP_EXECUTABLE_PATH})`;
	if (!(await isResolvedHelperExecutable(diagnostics.executablePath))) {
		return `runs ${diagnostics.executablePath} (expected ${HELPER_APP_EXECUTABLE_PATH})`;
	}
	return undefined;
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

/** Out-parameter for one connection's classification; starts as managed, so the stricter checks apply by default. */
interface ConnectionClass {
	managed: boolean;
}

/** One daemon start shared by concurrent `ensureDaemon` callers. */
interface PendingStart {
	promise: Promise<boolean>;
	/** Aborts the start once every waiter has abandoned it. */
	controller: AbortController;
	waiters: number;
}

/** Wait for `promise` unless `signal` aborts first; the promise itself keeps running. */
async function untilAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return await promise;
	return await new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(new Error("Operation aborted."));
		signal.addEventListener("abort", onAbort, { once: true });
		void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}

export class MacosHelperClient {
	private daemonAvailable = false;
	private pendingStart?: PendingStart;
	private requestSequence = 0;
	private diagnosticsCache?: PlatformDiagnostics;
	/** Last reported build, safe to display (see `displayBuild`). */
	helperBuild?: string;
	/** Reported and expected build of the last refused managed helper. */
	staleBuild?: { reported: string; expected: string };

	/**
	 * Check one connection's diagnostics before anything else is sent on it. A managed helper must report
	 * exactly this package's build; an external one only the expected protocol (its build, path and age are
	 * its operator's business).
	 * @param managed This connection's classification, fixed when it connected (see `connectHelper`).
	 */
	verifyBuild(
		result: { buildIdentity?: unknown; executablePath?: unknown; protocolVersion?: unknown } | undefined,
		managed: boolean,
	): void {
		this.staleBuild = undefined;
		this.helperBuild = displayBuild(result?.buildIdentity);
		if (!managed) {
			const protocol = Math.trunc(toFiniteNumber(result?.protocolVersion, 0));
			if (protocol === HELPER_PROTOCOL_VERSION) return;
			throw new HelperCommandError(
				`External helper at ${HELPER_SOCKET_PATH} reports protocol ${protocol}; expected ${HELPER_PROTOCOL_VERSION}. Its operator must update and restart it.`,
				"helper_protocol",
			);
		}
		expectedBuild ??= macosHelperBuild(PACKAGE_ROOT);
		if (result?.buildIdentity !== expectedBuild) {
			this.staleBuild = { reported: this.helperBuild, expected: expectedBuild };
			const executable = toOptionalString(result?.executablePath) ?? HELPER_APP_EXECUTABLE_PATH;
			throw new HelperCommandError(
				`pi-computer-use helper at ${executable} is stale (helper build ${this.helperBuild}, expected ${expectedBuild}): ${STALE_HELPER_REPAIR}`,
				"stale_helper",
			);
		}
	}

	/** Whether the configured socket is an external helper, run and restarted by its own operator. */
	isExternal(): boolean {
		return usingExternalHelperSocket;
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

		// Setup can replace the app and stop a running helper, so it runs only on positive absence: a resident
		// that answers is used as is, and an inconclusive probe throws.
		if (await this.probeResident(signal)) return;
		// Re-enter Electron and Bun standalone hosts as their JavaScript runtimes.
		await runProcess(process.execPath, [SETUP_HELPER_SCRIPT, "--runtime"], HELPER_SETUP_TIMEOUT_MS, signal, {
			...process.env,
			ELECTRON_RUN_AS_NODE: "1",
			BUN_BE_BUN: "1",
		});

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

	/**
	 * Send one command on a fresh connection, after that connection's own build check.
	 * @param connection Receives the connection's classification, fixed at connect (see `connectHelper`), for a
	 * caller whose later checks depend on it.
	 */
	async daemonCommand<T>(
		cmd: string,
		args: Record<string, unknown>,
		timeoutMs: number,
		signal?: AbortSignal,
		connection?: ConnectionClass,
	): Promise<T> {
		// An already-aborted signal never fires again, so the request would be sent and wait out its timeout.
		throwIfAborted(signal);
		const deadlineMs = performance.now() + timeoutMs - KEYBOARD_DEADLINE_MARGIN_MS;
		return await new Promise<T>((resolve, reject) => {
			const id = `req_${++this.requestSequence}`;
			const probeId = `build_${id}`;
			// `onConnect` is declared below; `connectHelper` calls it only after this executor has returned.
			const socket = connectHelper((managedAtConnect) => onConnect(managedAtConnect));
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
			// Set from this connection's own build probe, which every keyboard command waits for.
			let keyboardDeadlineUptimeMs: number | undefined;
			const sendCommand = () => socket.write(`${JSON.stringify({ id, cmd, ...args, keyboardDeadlineUptimeMs })}\n`);
			const onConnect = (managedAtConnect: boolean) => {
				connected = true;
				managed = managedAtConnect;
				if (connection) connection.managed = managedAtConnect;
				if (checkingBuild) socket.write(`${JSON.stringify({ id: probeId, cmd: "diagnostics" })}\n`);
				else sendCommand();
			};
			const onData = (chunk: string) => {
				buffer += chunk;
				const newline = buffer.indexOf("\n");
				if (newline < 0) return;
				if (checkingBuild) {
					try {
						const probe = parseReply(buffer.slice(0, newline));
						if (probe.id !== probeId || probe.ok !== true) {
							throw new HelperTransportError("Invalid helper build probe reply.");
						}
						this.verifyBuild(probe.result, managed);
						if (KEYBOARD_COMMANDS.has(cmd))
							keyboardDeadlineUptimeMs = helperKeyboardDeadline(probe.result?.uptimeMs, deadlineMs, performance.now());
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
						const parsed = parseReply(buffer.slice(0, newline));
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
			socket.on("data", onData);
			socket.on("error", onError);
			socket.on("end", onDisconnect);
			socket.on("close", onDisconnect);
		});
	}

	/**
	 * Read-only diagnostics probe of the resident helper.
	 * @returns true when a resident answered, false only on positive absence: `ENOENT` or `ECONNREFUSED`
	 * before any connection. A resident that is slow to answer is retried within `READ_ONLY_PROBE_BUDGET_MS`;
	 * once one attempt timed out, only a verified reply clears that evidence, never a later absence.
	 * @throws The helper's own refusal (`stale_helper`, an error reply), an abort, or a `helper_inconclusive`
	 * transport error for anything else: a timeout past the budget, a malformed reply, a disconnect or a
	 * connect error such as `EACCES`. Callers must not launch or install after a throw.
	 */
	private async probeResident(signal?: AbortSignal): Promise<boolean> {
		const deadline = Date.now() + READ_ONLY_PROBE_BUDGET_MS;
		let timedOut = false;
		while (true) {
			try {
				const remaining = Math.max(deadline - Date.now(), 1);
				await this.daemonCommand("diagnostics", {}, Math.min(DIAGNOSTICS_PROBE_TIMEOUT_MS, remaining), signal);
				return true;
			} catch (error) {
				if (!(error instanceof HelperTransportError)) throw error;
				if (error.code === "helper_not_listening" && !timedOut) return false;
				timedOut ||= error.code === "helper_timeout";
				if (error.code === "helper_timeout" && Date.now() < deadline) continue;
				throw new HelperTransportError(
					`Cannot verify the pi-computer-use helper at ${HELPER_SOCKET_PATH}; it was not launched and setup was not run: ${String(error)}`,
					"helper_inconclusive",
				);
			}
		}
	}

	/**
	 * Make sure a verified daemon answers, launching the installed app on positive absence.
	 * Concurrent callers in this process share one start, so they launch at most one helper between them (`open -n`
	 * starts a new instance every time). Each caller's signal abandons only its own wait; the shared start is
	 * aborted once every waiter has, and a later caller starts afresh.
	 * @returns false when no daemon answered within the probe loop.
	 */
	async ensureDaemon(signal?: AbortSignal): Promise<boolean> {
		if (this.daemonAvailable) return true;
		throwIfAborted(signal);
		const start = this.joinStart();
		start.waiters += 1;
		try {
			return await untilAborted(start.promise, signal);
		} finally {
			start.waiters -= 1;
			if (start.waiters === 0 && signal?.aborted) start.controller.abort();
		}
	}

	/**
	 * The in-flight start, or a new one. An abandoned start is never joined: it is already rejecting with the
	 * abort, which every step it awaits honours at once.
	 */
	private joinStart(): PendingStart {
		const current = this.pendingStart;
		if (current && !current.controller.signal.aborted) return current;
		const controller = new AbortController();
		const start: PendingStart = {
			controller,
			waiters: 0,
			promise: this.startDaemon(controller.signal).finally(() => {
				// An abandoned start settles after its replacement was created; it must not clear that one.
				if (this.pendingStart === start) this.pendingStart = undefined;
			}),
		};
		this.pendingStart = start;
		return start;
	}

	private async startDaemon(signal: AbortSignal): Promise<boolean> {
		// Launch only on positive absence: `probeResident` throws on anything inconclusive, and `launchDaemon`
		// refuses an external socket.
		if (!(await this.probeResident(signal))) {
			await this.launchDaemon(signal).catch(() => undefined);
			for (let index = 1; !(await this.probeResident(signal)); index += 1) {
				if (index >= 30) return false;
				await sleep(100, signal);
			}
		}
		this.daemonAvailable = true;
		return true;
	}

	async command<T>(
		cmd: string,
		args: Record<string, unknown> = {},
		options?: { timeoutMs?: number; signal?: AbortSignal; connection?: ConnectionClass },
	): Promise<T> {
		const timeoutMs = options?.timeoutMs ?? COMMAND_TIMEOUT_MS;
		if (!(await this.ensureDaemon(options?.signal))) {
			throw new HelperTransportError(`pi-computer-use helper app daemon is unavailable at ${HELPER_APP_PATH}.`);
		}
		try {
			return await this.daemonCommand<T>(cmd, args, timeoutMs, options?.signal, options?.connection);
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

	/** @param connection Receives the classification of the connection that answered (see `daemonCommand`). */
	async diagnosticsCommand(signal?: AbortSignal, connection?: ConnectionClass): Promise<PlatformDiagnostics> {
		const result = await this.command<any>("diagnostics", {}, { signal, connection });
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

	/**
	 * Check that a managed daemon whose build matched is the installed helper: expected protocol and executable path.
	 * A mismatch, or a missing path, is refused with `helper_mismatch`; the daemon is never shut down, relaunched or
	 * stopped here.
	 */
	async ensureProtocol(signal?: AbortSignal): Promise<PlatformDiagnostics> {
		// `verifyBuild` already refused a wrong build (managed) or protocol (external) on this connection. The
		// exemption follows that connection's classification, not the import-time one: an override that aliases the
		// managed socket is managed.
		const connection: ConnectionClass = { managed: true };
		const diagnostics = await this.diagnosticsCommand(signal, connection);
		if (!connection.managed) return diagnostics;
		const mismatch = await residentMismatch(diagnostics);
		if (mismatch === undefined) return diagnostics;
		this.daemonAvailable = false;
		throw new HelperCommandError(
			`pi-computer-use helper at ${HELPER_SOCKET_PATH} has this package's build but ${mismatch}; it was not restarted or stopped. ${RESIDENT_MISMATCH_REPAIR}`,
			"helper_mismatch",
		);
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
				const onError = (error: Error) => {
					socket.destroy();
					reject(new HelperTransportError(error.message));
				};
				const socket = connectHelper((managed) => {
					socket.off("error", onError);
					socket.on("error", () => socket.destroy());
					socket.on("close", () => {
						if (this.socket === socket) this.socket = undefined;
					});
					const verify = async () => {
						macosHelper.verifyBuild(await this.send(socket, "diagnostics"), managed);
						this.socket = socket;
						resolve(socket);
					};
					void verify().catch((error) => {
						socket.destroy();
						reject(error);
					});
				});
				socket.once("error", onError);
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
					const response = parseReply(buffer.slice(0, newline));
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
