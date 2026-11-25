import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertPlatformArchitecture } from "../architecture.ts";
import type { PlatformDiagnostics } from "../types.ts";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SETUP_HELPER_SCRIPT = path.join(PACKAGE_ROOT, "scripts", "setup-helper.mjs");
/** The package prebuilt that setup installs ahead of any source build, so a stale one is reinstalled. */
const LINUX_PREBUILT_PATH = path.join(PACKAGE_ROOT, "prebuilt", "linux", process.arch, "linux-bridge");
const HELPER_SETUP_TIMEOUT_MS = 60_000;
const COMMAND_TIMEOUT_MS = 15_000;
const HELPER_PROBE_TIMEOUT_MS = 5_000;
const SETUP_KILL_GRACE_MS = 2_000;
/**
 * SIGTERM-to-SIGKILL grace for a discarded helper. On SIGTERM (or stdin EOF) the helper stops admitting
 * physical input before its next unit, posts the releases it owes and exits; SIGKILL only backstops a
 * helper that is hung, and skips that cleanup.
 */
export const HELPER_TERMINATE_GRACE_MS = 750;
/**
 * Helper exit status when key or button releases stay unconfirmed at exit. The helper keeps that debt in
 * memory only, so a respawned helper would not know about it: the client refuses physical input instead.
 */
export const HELPER_EXIT_RELEASE_DEBT = 3;
/** Stderr bytes kept per helper, newest last: enough for the exit report, bounded against a chatty helper. */
export const HELPER_STDERR_LIMIT_BYTES = 8_192;
/**
 * How long a physical command or `dispose()` waits for a discarded helper's exit status: past the SIGKILL
 * backstop, so only a helper that cannot be reaped runs it out.
 */
export const DISCARDED_EXIT_WAIT_MS = HELPER_TERMINATE_GRACE_MS + 1_000;
const MANUAL_SETUP_HINT = `Run \`PI_COMPUTER_USE_ALLOW_BUILD=1 node ${SETUP_HELPER_SCRIPT} --platform linux\` once outside Pi (a cold cargo build can exceed the ${HELPER_SETUP_TIMEOUT_MS / 1000}s in-session setup limit), then restart Pi.`;

export const LINUX_HELPER_PROTOCOL_VERSION = 11;
/**
 * Helper features the client requires beyond the protocol version, from `diagnostics.features`. Reject and
 * replace even a protocol-11 helper if it lacks `snapshot-deadline`. This marker ships with protocol 11,
 * the AT-SPI snapshot deadline (#1349, #1352) and the interpreter `blockAliases` (#1333).
 */
export const LINUX_REQUIRED_HELPER_FEATURES = ["snapshot-deadline"] as const;
/**
 * How far ahead of the client's own timeout the helper's request deadline sits: past it the helper starts no press,
 * motion, activation or semantic mutation for the request (one already in flight completes). It also covers the time
 * the line spends in the pipe and the gap between the helper's last check and its post.
 */
export const LINUX_REQUEST_DEADLINE_MARGIN_MS = 250;
/** The longest helper command timeout: Node's timers cannot wait longer. */
export const LINUX_MAX_TIMEOUT_MS = 2 ** 31 - 1;
export const LINUX_HELPER_PATH =
	process.env.PI_COMPUTER_USE_LINUX_HELPER_PATH ||
	path.join(os.homedir(), ".pi", "agent", "helpers", "pi-computer-use", "linux-bridge");

interface Pending<T> {
	resolve(value: T): void;
	reject(error: Error): void;
	timer: NodeJS.Timeout;
	child: ChildProcessWithoutNullStreams;
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error("Operation aborted.");
}

async function isExecutable(filePath: string): Promise<boolean> {
	try {
		await access(filePath, fsConstants.X_OK);
		return true;
	} catch {
		return false;
	}
}

async function runProcess(
	command: string,
	args: string[],
	timeoutMs: number,
	signal?: AbortSignal,
	env?: NodeJS.ProcessEnv,
): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env });
		let stdout = "";
		let stderr = "";
		let settled = false;
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			if (error) reject(error);
			else resolve();
		};
		const terminate = () => {
			child.kill("SIGTERM");
			// The setup script reaps its compiler on SIGTERM; SIGKILL only backstops a hung script.
			setTimeout(() => {
				if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			}, SETUP_KILL_GRACE_MS).unref();
		};
		const timer = setTimeout(() => {
			terminate();
			finish(new Error(`Command timed out after ${timeoutMs}ms: ${command} ${args.join(" ")}`));
		}, timeoutMs);
		const onAbort = () => {
			terminate();
			finish(new Error("Operation aborted."));
		};
		child.stdout.on("data", (chunk) => {
			stdout += String(chunk);
		});
		child.stderr.on("data", (chunk) => {
			stderr += String(chunk);
		});
		child.on("error", (error) => finish(error));
		child.on("close", (code) => {
			if (code === 0) return finish();
			const output = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
			finish(new Error(`Command failed (${code}): ${command} ${args.join(" ")}\n${output}`.trim()));
		});
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

const RESTART_HINT = "Restart Pi to use the installed helper.";
const SESSION_CLOSED_MESSAGE = "Linux helper closed because the Pi session ended.";

/**
 * A request already written whose reply will never be read: timed out, aborted or orphaned by a helper exit.
 * The helper may have executed it, or part of it, so callers must treat its effect as unknown, never replay it.
 */
function replyLost(error: unknown): Error & { code: string } {
	const message = error instanceof Error ? error.message : String(error);
	return Object.assign(new Error(message, { cause: error }), { code: "reply_lost" });
}

/** The `cause.code` of a reply lost to the client's own deadline, as opposed to an abort or a helper exit. */
const DEADLINE_EXCEEDED = "deadline_exceeded";

/** Whether `error` is a reply lost because the client's deadline expired with no reply. */
export function isHelperDeadline(error: unknown): boolean {
	const lost = error as { code?: unknown; cause?: { code?: unknown } } | undefined;
	return lost?.code === "reply_lost" && lost.cause?.code === DEADLINE_EXCEEDED;
}

/** Commands that can post XTEST input or move focus: everything but `act`/`actBatch` steps limited to `ax_only`. */
function isPhysicalCommand(cmd: string, args: Record<string, unknown>): boolean {
	const semantic = (action: unknown) => (action as { policy?: unknown } | undefined)?.policy === "ax_only";
	if (cmd === "focusWindow") return true;
	if (cmd === "act") return !semantic(args);
	if (cmd === "actBatch") return !Array.isArray(args.actions) || !args.actions.every(semantic);
	return false;
}

/** The owed inputs a helper's exit report names, if its stderr tail still holds the report. */
function owedInputs(stderr: string): string | undefined {
	return /exiting with the release of (.+?) unconfirmed/.exec(stderr)?.[1];
}

/** The sticky refusal after a helper exited owing releases. */
function owedInputMessage(owed = "unknown keys or buttons"): string {
	return `Refusing physical input: the Linux helper exited with the release of ${owed} unconfirmed; it may still be held. Release it by hand, then restart Pi.`;
}

/** The sticky refusal after a helper died by a signal, e.g. the SIGKILL backstop, once physical input was sent. */
const KILLED_AFTER_INPUT_MESSAGE =
	"Refusing physical input: the Linux helper was killed after physical input; held keys/buttons unknown. Release any held input by hand, then restart Pi.";

const UNSETTLED_EXIT_MESSAGE = `Refusing physical input: a discarded Linux helper did not exit within ${DISCARDED_EXIT_WAIT_MS}ms, so whether it released its keys and buttons is unknown. Release any held input by hand, then restart Pi.`;

function reason(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).replace(/\.$/, "");
}

/** `reason` for a probe failure: the restart hint is wrong while setup is about to replace the helper. */
function probeReason(error: unknown): string {
	return reason(error).replace(new RegExp(`\\.? ${RESTART_HINT.replace(/\.$/, "")}$`), "");
}

/**
 * Require every `LINUX_REQUIRED_HELPER_FEATURES` entry in `diagnostics.features`. A missing or malformed list
 * lacks them all: a helper that does not report a feature is treated as not having it. Setup copies a package
 * prebuilt before it would build from source, so the message also names the prebuilt that a rebuild would
 * otherwise reinstall.
 */
export function assertLinuxHelperFeatures(diagnostics: PlatformDiagnostics): void {
	const list = diagnostics.features as unknown;
	const reported = new Set<string>(
		Array.isArray(list) && list.every((feature) => typeof feature === "string") ? (list as string[]) : [],
	);
	const missing = LINUX_REQUIRED_HELPER_FEATURES.filter((feature) => !reported.has(feature));
	if (missing.length > 0) {
		throw new Error(
			`Linux helper lacks required features: ${missing.join(", ")}. Rebuild it with \`PI_COMPUTER_USE_ALLOW_BUILD=1 node ${SETUP_HELPER_SCRIPT} --platform linux\`. Setup installs a prebuilt before building from source: if \`${LINUX_PREBUILT_PATH}\` exists, remove it or rebuild it with \`npm run build:linux\`, or setup reinstalls the same stale helper.`,
		);
	}
}

async function waitForShared<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return await promise;
	if (signal.aborted) throw new Error("Operation aborted.");
	return await new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(new Error("Operation aborted."));
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

export interface LinuxHelperClientOptions {
	helperPath?: string;
	setupHelperScript?: string;
	/**
	 * The disposal of the client this one replaces, resolving to its refusal: physical commands and this
	 * client's own `dispose()` wait for it and inherit the refusal, since the input it may have left held is
	 * still held in this process's desktop.
	 */
	predecessor?: Promise<string | undefined>;
}

export class LinuxHelperClient {
	private installChecked = false;
	private installPromise?: Promise<void>;
	private child?: ChildProcessWithoutNullStreams;
	private processPromise?: Promise<ChildProcessWithoutNullStreams>;
	/** Set by `dispose()`, which is terminal: nothing may probe, set up, spawn or assign `child` afterwards. */
	private disposed = false;
	private setupAbort?: AbortController;
	private pending = new Map<string, Pending<unknown>>();
	/** Set for good once a helper exits owing releases: every later physical command is refused. */
	private inputUnsafe?: string;
	/**
	 * Helpers a physical command was ever written to. Only such a helper can leave input held when a signal skips
	 * its cleanup; one that only observed cannot, whatever an earlier helper of this client did.
	 */
	private physicalChildren = new WeakSet<ChildProcessWithoutNullStreams>();
	/** Discarded helpers whose exit status is still unknown: any of them may yet exit owing releases. */
	private unsettledExits = new Set<Promise<void>>();
	/** Settles once the predecessor's refusal, if any, is latched here. */
	private readonly predecessor?: Promise<void>;
	private readonly helperPath: string;
	private readonly setupHelperScript: string;

	constructor(options: LinuxHelperClientOptions = {}) {
		this.helperPath = options.helperPath ?? LINUX_HELPER_PATH;
		this.setupHelperScript = options.setupHelperScript ?? SETUP_HELPER_SCRIPT;
		this.predecessor = options.predecessor?.then((refusal) => {
			if (refusal !== undefined) this.refusePhysicalInput(refusal);
		});
	}

	/**
	 * Terminal: in-flight work is aborted and every later `command()`/`ensureInstalled()` fails fast. Resolves to
	 * the physical-input refusal once this client's helper exit status is known, or its `DISCARDED_EXIT_WAIT_MS`
	 * wait runs out, and its predecessor's disposal, if any, has settled too: a helper that exits owing releases
	 * leaves keys or buttons possibly held, and the caller must say so.
	 */
	async dispose(): Promise<string | undefined> {
		this.disposed = true;
		this.installPromise = undefined;
		this.setupAbort?.abort();
		this.discardChild(new Error(SESSION_CLOSED_MESSAGE));
		// This client's bounded exit wait starts now, not once the predecessor settles, so concurrent resets overlap
		// their deadlines instead of stacking them. The deadline bounds only this wait: disposal resolves once both it
		// and the predecessor's disposal have settled.
		const exits = this.awaitDiscardedExits();
		// A chain of resets: what any predecessor left held is carried down to the newest client.
		await this.predecessor;
		await exits;
		return this.inputUnsafe;
	}

	/** Refuse physical input from now on with `message`. */
	private refusePhysicalInput(message: string): void {
		this.inputUnsafe ??= message;
	}

	private refuseUnsafe(physical: boolean): void {
		if (physical && this.inputUnsafe !== undefined)
			throw Object.assign(new Error(this.inputUnsafe), { code: "input_unsafe" });
	}

	/** Latch the refusal for a helper that exited owing releases, keeping a named report over an unnamed one. */
	private latchOwedInput(stderr: string): void {
		const owed = owedInputs(stderr);
		if (owed !== undefined || this.inputUnsafe === undefined) this.inputUnsafe = owedInputMessage(owed);
	}

	/** Wait, bounded, until every discarded helper's exit status is known; one that never exits is refused. */
	private async awaitDiscardedExits(signal?: AbortSignal): Promise<void> {
		if (this.unsettledExits.size === 0) return;
		let timer: NodeJS.Timeout | undefined;
		const timedOut = new Promise<boolean>((resolve) => {
			timer = setTimeout(() => resolve(true), DISCARDED_EXIT_WAIT_MS);
		});
		try {
			const settled = Promise.all(this.unsettledExits).then(() => false);
			if (await waitForShared(Promise.race([settled, timedOut]), signal))
				this.refusePhysicalInput(UNSETTLED_EXIT_MESSAGE);
		} finally {
			clearTimeout(timer);
		}
	}

	/** Reject in-flight commands and kill the current child, if any, so a replaced helper cannot leak. */
	private discardChild(error: Error): void {
		this.rejectPending(error);
		const child = this.child;
		this.child = undefined;
		if (!child) return;
		child.stdin.destroy();
		child.stdout.destroy();
		// Keep reading stderr for the exit report, without holding the event loop open for it.
		(child.stderr as { unref?: () => void }).unref?.();
		child.kill("SIGTERM");
		const backstop = setTimeout(() => {
			if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL");
		}, HELPER_TERMINATE_GRACE_MS);
		backstop.unref();
		// Its exit status may still say it owes releases: physical commands wait for it (`awaitDiscardedExits`).
		const exited = new Promise<void>((resolve) =>
			child.once("exit", () => {
				clearTimeout(backstop);
				this.unsettledExits.delete(exited);
				resolve();
			}),
		);
		this.unsettledExits.add(exited);
		child.unref();
	}

	/** Reject in-flight commands as lost replies: all of them, or only those sent to `child` when it is given. */
	private rejectPending(error: Error, child?: ChildProcessWithoutNullStreams): void {
		for (const [id, pending] of this.pending) {
			if (child && pending.child !== child) continue;
			this.pending.delete(id);
			clearTimeout(pending.timer);
			pending.reject(replyLost(error));
		}
	}

	/**
	 * Make sure a compatible helper is installed. An existing executable is probed (protocol and
	 * architecture contract) and accepted without setup; a stale or broken one is replaced via the
	 * setup script (prebuilt, or a source build when `PI_COMPUTER_USE_ALLOW_BUILD=1`) and re-probed.
	 * Concurrent callers share one probe/setup.
	 */
	async ensureInstalled(signal?: AbortSignal): Promise<void> {
		if (this.disposed) throw new Error(SESSION_CLOSED_MESSAGE);
		if (this.installChecked && (await isExecutable(this.helperPath))) {
			if (this.disposed) throw new Error(SESSION_CLOSED_MESSAGE);
			return;
		}
		if (this.disposed) throw new Error(SESSION_CLOSED_MESSAGE);
		if (!this.installPromise) {
			const installPromise = this.install();
			this.installPromise = installPromise;
			const clear = () => {
				if (this.installPromise === installPromise) this.installPromise = undefined;
			};
			installPromise.then(clear, clear);
		}
		await waitForShared(this.installPromise, signal);
	}

	private async install(): Promise<void> {
		// A dispose() before or during any await below aborts the install: no classification, no setup, no new child.
		const abortIfDisposed = () => {
			if (this.disposed) throw new Error(SESSION_CLOSED_MESSAGE);
		};
		abortIfDisposed();
		this.installChecked = false;
		this.discardChild(new Error("Linux helper replaced during install."));
		let rejected: string | undefined;
		const present = await isExecutable(this.helperPath);
		abortIfDisposed();
		if (present) {
			try {
				await this.probe();
				abortIfDisposed();
				this.installChecked = true;
				return;
			} catch (error) {
				abortIfDisposed();
				rejected = `Installed Linux helper ${this.helperPath} was rejected: ${probeReason(error)}.`;
				this.discardChild(new Error("Linux helper rejected."));
			}
		}
		const setupAbort = new AbortController();
		this.setupAbort = setupAbort;
		try {
			await runProcess(
				process.execPath,
				[this.setupHelperScript, "--platform", "linux", "--runtime"],
				HELPER_SETUP_TIMEOUT_MS,
				setupAbort.signal,
				{
					...process.env,
					ELECTRON_RUN_AS_NODE: "1",
					BUN_BE_BUN: "1",
					PI_COMPUTER_USE_LINUX_HELPER_PATH: this.helperPath,
				},
			);
		} catch (error) {
			abortIfDisposed();
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(
				[message, rejected, message.includes("timed out") ? MANUAL_SETUP_HINT : undefined].filter(Boolean).join("\n"),
			);
		} finally {
			// `install()` is single-flight (`installPromise`) and `dispose()` is terminal, so no other install can own `setupAbort` here.
			this.setupAbort = undefined;
		}
		abortIfDisposed();
		const installed = await isExecutable(this.helperPath);
		abortIfDisposed();
		if (!installed) throw new Error(`Failed to install Linux helper at ${this.helperPath}.`);
		try {
			await this.probe();
		} catch (error) {
			abortIfDisposed();
			this.discardChild(new Error("Linux helper rejected."));
			throw new Error(
				`Linux helper installed at ${this.helperPath} failed validation: ${probeReason(error)}. Re-run setup or delete it.`,
			);
		}
		abortIfDisposed();
		this.installChecked = true;
	}

	/**
	 * Start the helper and require the shared protocol/architecture contract from `diagnostics`.
	 * The validated child stays as the live process, so a good helper starts exactly once. Bypasses
	 * `process()` on purpose: that calls `ensureInstalled`, which is already running this probe.
	 */
	private async probe(): Promise<void> {
		const child = await this.startProcess();
		const diagnostics = await this.send<PlatformDiagnostics>(child, "diagnostics", {}, HELPER_PROBE_TIMEOUT_MS);
		if (diagnostics?.protocolVersion !== LINUX_HELPER_PROTOCOL_VERSION) {
			throw new Error(
				`protocol mismatch: expected ${LINUX_HELPER_PROTOCOL_VERSION}, got ${diagnostics?.protocolVersion ?? "unknown"}`,
			);
		}
		assertPlatformArchitecture("Linux", diagnostics);
		assertLinuxHelperFeatures(diagnostics);
	}

	private async process(signal?: AbortSignal): Promise<ChildProcessWithoutNullStreams> {
		await this.ensureInstalled(signal);
		if (this.processPromise) return await waitForShared(this.processPromise, signal);
		if (this.child && this.child.exitCode === null && !this.child.killed) return this.child;
		const processPromise = this.startProcess();
		this.processPromise = processPromise;
		// Single-flight: the guard above means no other start can replace `processPromise` before this one settles.
		const clear = () => {
			this.processPromise = undefined;
		};
		processPromise.then(clear, clear);
		return await waitForShared(processPromise, signal);
	}

	private async startProcess(): Promise<ChildProcessWithoutNullStreams> {
		if (this.disposed) throw new Error(SESSION_CLOSED_MESSAGE);
		const child = spawn(this.helperPath, [], { stdio: ["pipe", "pipe", "pipe"] });
		child.stdout.setEncoding("utf8");
		// Drained so a chatty helper never blocks on a full pipe; only the last bytes are kept, copied so a large
		// chunk is not retained through a view.
		let stderr = Buffer.alloc(0);
		child.stderr.on("data", (chunk: Buffer) => {
			const joined = Buffer.concat([stderr, chunk]);
			stderr = Buffer.from(joined.subarray(Math.max(0, joined.length - HELPER_STDERR_LIMIT_BYTES)));
		});
		child.stdin.setDefaultEncoding("utf8");
		// A failed write invokes its callback and also emits an error on the stream.
		child.stdin.on("error", (error) => {
			if (this.child === child) this.discardChild(error);
		});
		// Each child frames its own lines, so a dead child's partial output cannot corrupt its successor's replies.
		let buffer = "";
		child.stdout.on("data", (chunk: string) => {
			buffer = this.onStdout(buffer, chunk);
		});
		// `exit` can fire while stdout still holds a complete reply: only forget the child here so the next
		// command respawns, and fail what is still pending once `close` says stdout is drained. Owed releases
		// are latched on `exit` already, so no physical command can reach a respawned helper in between.
		child.on("exit", (code, signalName) => {
			if (code === HELPER_EXIT_RELEASE_DEBT) this.latchOwedInput(stderr.toString("utf8"));
			// Killed by a signal, e.g. the SIGKILL backstop of a stalled helper: it skipped its cleanup and exit
			// report, so after physical input to this helper nothing says what it left held.
			else if (signalName && this.physicalChildren.has(child)) this.refusePhysicalInput(KILLED_AFTER_INPUT_MESSAGE);
			if (this.child === child) this.child = undefined;
		});
		child.on("close", (code, signalName) => {
			// Stderr is complete now: name the owed inputs if the report arrived after `exit`.
			if (code === HELPER_EXIT_RELEASE_DEBT) this.latchOwedInput(stderr.toString("utf8"));
			this.rejectPending(
				new Error(`Linux helper exited${signalName ? ` on ${signalName}` : ` with code ${code ?? "unknown"}`}.`),
				child,
			);
		});
		child.on("error", (error) => {
			if (this.child !== child) return;
			this.child = undefined;
			this.rejectPending(error);
		});
		this.child = child;
		return await new Promise<ChildProcessWithoutNullStreams>((resolve, reject) => {
			child.once("spawn", () => resolve(child));
			child.once("error", reject);
		});
	}

	/** Settle the requests answered by the complete lines in `buffer + chunk`; returns the unfinished tail. */
	private onStdout(previous: string, chunk: string): string {
		let buffer = previous + chunk;
		for (;;) {
			const newline = buffer.indexOf("\n");
			if (newline < 0) return buffer;
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			if (!line) continue;
			let parsed: any;
			try {
				parsed = JSON.parse(line);
			} catch {
				continue;
			}
			const pending = this.pending.get(parsed.id);
			if (!pending) continue;
			this.pending.delete(parsed.id);
			clearTimeout(pending.timer);
			if (parsed.protocolVersion !== LINUX_HELPER_PROTOCOL_VERSION) {
				pending.reject(
					new Error(
						`Linux helper protocol mismatch: expected ${LINUX_HELPER_PROTOCOL_VERSION}, got ${parsed.protocolVersion ?? "unknown"}. ${RESTART_HINT}`,
					),
				);
			} else if (parsed.ok === true) {
				pending.resolve(parsed.result);
			} else {
				const error = new Error(parsed.error?.message ?? "Linux helper command failed.") as Error & { code?: string };
				error.code = parsed.error?.code;
				pending.reject(error);
			}
		}
	}

	async command<T>(
		cmd: string,
		args: Record<string, unknown> = {},
		options?: { timeoutMs?: number; signal?: AbortSignal },
	): Promise<T> {
		const signal = options?.signal;
		// A signal that is already aborted never fires again: refuse before installing, spawning or sending.
		throwIfAborted(signal);
		// A respawned helper has no record of what an earlier one left held: only non-physical commands go on.
		const physical = isPhysicalCommand(cmd, args);
		// A predecessor still being disposed may yet report input left held: learn that before any physical write.
		if (physical && this.predecessor) await waitForShared(this.predecessor, signal);
		for (;;) {
			this.refuseUnsafe(physical);
			const child = await this.process(signal);
			// ...and so does one aborted while the install check or helper start was in flight.
			throwIfAborted(signal);
			// A discarded helper may still exit owing releases: learn its status before sending physical input.
			if (physical && this.unsettledExits.size > 0) {
				await this.awaitDiscardedExits(signal);
				continue;
			}
			// Rechecked right before writing: a helper may have exited owing releases during the awaits above.
			this.refuseUnsafe(physical);
			return await this.send<T>(child, cmd, args, options?.timeoutMs, signal, physical);
		}
	}

	private async send<T>(
		child: ChildProcessWithoutNullStreams,
		cmd: string,
		args: Record<string, unknown>,
		timeoutMs = COMMAND_TIMEOUT_MS,
		signal?: AbortSignal,
		physical = false,
	): Promise<T> {
		// A timeout Node's timer cannot wait (it fires at once past `2 ** 31 - 1`) would disagree with the deadline the
		// helper is sent: refused before anything is registered or written.
		if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > LINUX_MAX_TIMEOUT_MS) {
			throw new RangeError(`Helper command '${cmd}' timeout ${timeoutMs}ms is outside 0 to ${LINUX_MAX_TIMEOUT_MS}ms.`);
		}
		const id = randomUUID();
		// The helper's deadline as an absolute wall-clock time, as the budget left now and, on Linux, on
		// `CLOCK_MONOTONIC` (what `process.hrtime` reads there, as the helper does): it takes the earliest. The monotonic
		// one moves with neither a wall-clock step nor time in the pipe; without it, a wall clock stepped back while the
		// line waits in the pipe makes the deadline late by the smaller of the two.
		const budgetMs = Math.max(0, Math.floor(timeoutMs - LINUX_REQUEST_DEADLINE_MARGIN_MS));
		const deadlineMs = Date.now() + budgetMs;
		const deadlineMonoMs =
			process.platform === "linux" ? Number(process.hrtime.bigint() / 1_000_000n) + budgetMs : undefined;
		// Serialized before anything is registered or written: a request that cannot be encoded never reaches the helper.
		const line = `${JSON.stringify({ protocolVersion: LINUX_HELPER_PROTOCOL_VERSION, id, cmd, args, deadlineMs, budgetMs, deadlineMonoMs })}\n`;
		return await new Promise<T>((resolve, reject) => {
			// The helper protocol has no cancel message: an abort or timeout only stops waiting for the reply.
			const onAbort = () => {
				this.pending.delete(id);
				clearTimeout(timer);
				reject(replyLost(new Error("Operation aborted.")));
			};
			const timer = setTimeout(() => {
				signal?.removeEventListener("abort", onAbort);
				this.pending.delete(id);
				const deadline = new Error(`Helper command '${cmd}' timed out after ${timeoutMs}ms.`);
				reject(replyLost(Object.assign(deadline, { code: DEADLINE_EXCEEDED })));
			}, timeoutMs);
			this.pending.set(id, {
				child,
				resolve: (value) => {
					signal?.removeEventListener("abort", onAbort);
					resolve(value as T);
				},
				reject: (error) => {
					signal?.removeEventListener("abort", onAbort);
					reject(error);
				},
				timer,
			});
			signal?.addEventListener("abort", onAbort, { once: true });
			// Marked when the write is attempted, not when it is acknowledged: from here its delivery is uncertain, so a
			// signal death of this helper may have left input held even before any reply.
			if (physical) this.physicalChildren.add(child);
			child.stdin.write(line, (error) => {
				if (!error) return;
				signal?.removeEventListener("abort", onAbort);
				this.pending.delete(id);
				clearTimeout(timer);
				reject(error);
			});
		});
	}
}

export let linuxHelper = new LinuxHelperClient();

/**
 * Session shutdown: dispose the old client (terminal) and install a fresh one for the next session that
 * holds every physical write until that disposal settles, then wait, bounded, for the old helper's exit
 * status. Resolves to the refusal when it may have left input held: the caller must surface it, and the
 * fresh client inherits it before its first physical write, since the input is still held in this process's
 * desktop. Concurrent resets chain: each client's bounded exit wait starts when its disposal begins, so the waits
 * overlap; the deadline bounds only that client's own wait, and its disposal resolves once both that wait and its
 * predecessor's disposal have settled.
 */
export async function resetLinuxHelper(): Promise<string | undefined> {
	const disposal = linuxHelper.dispose();
	linuxHelper = new LinuxHelperClient({ predecessor: disposal });
	return await disposal;
}
