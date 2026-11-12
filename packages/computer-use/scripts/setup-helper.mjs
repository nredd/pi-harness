#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn, execFile as execFileCallback, execFileSync } from "node:child_process";
import { constants as fsConstants, createWriteStream, realpathSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveMacosHelperAppPath } from "../src/platform/macos/helper-path.mjs";

const execFile = promisify(execFileCallback);
const helperBundleId = "com.injaneity.pi-computer-use";
const releaseRepo = "injaneity/pi-computer-use";
const localCodeSignCommonName = "pi-computer-use Local Signing (com.injaneity.pi-computer-use)";

const archTriples = {
	arm64: "arm64-apple-macosx",
	x64: "x86_64-apple-macosx",
};
const deploymentTarget = "14.0";
const frameworks = ["ApplicationServices", "AppKit", "ScreenCaptureKit", "Foundation", "SwiftUI"];
const defaultCodeSignIdentifier = "com.injaneity.pi-computer-use";

const releaseAssetName = "pi-computer-use.app.zip";
const DOWNLOAD_TIMEOUT_MS = 120_000;

export const GROUP_TERM_GRACE_MS = 800;
export const GROUP_KILL_WAIT_MS = 500;
/** Bound on one `ps` listing; a timeout or kill throws and reads as inconclusive. */
export const PS_TIMEOUT_MS = 250;

/**
 * List the `ps` state of every member of `pgid`, zombies included.
 * @param {number} pgid Process-group ID to inspect.
 * @returns {string[]} One `ps` STAT string per member; empty when `ps` sees no member.
 * @throws {Error} When `ps` cannot run, is killed, or exceeds `PS_TIMEOUT_MS`.
 */
export function listGroupStates(pgid) {
	const table = execFileSync("/bin/ps", ["-axo", "pgid=,stat="], { encoding: "utf8", timeout: PS_TIMEOUT_MS, killSignal: "SIGKILL" });
	return table.split("\n").flatMap((line) => {
		const [group, state] = line.trim().split(/\s+/);
		return Number(group) === pgid ? [state] : [];
	});
}

/**
 * Whether `pid` can name a process group we own. Pgid 1 would make `kill(-1, ...)` a broadcast to every
 * process we may signal, and 0 or a negative ID names our own or a foreign group.
 * @param {unknown} pid Child pid, used as its detached group's ID.
 * @returns {boolean} True for an integer above 1.
 * @throws {never} Pure.
 */
export function isOwnableGroup(pid) {
	return Number.isInteger(pid) && pid > 1;
}

/**
 * Cleanup state for one owned group. `seen` is whether the listing at the start of cleanup showed a member
 * (never refreshed, never set by a syscall result); `pending` is the first `EPERM` no listing has explained.
 * @typedef {{seen: boolean, pending?: Error}} OwnedGroup
 */

/**
 * Whether a `ps` listing shows a group holding only zombies: at least one member, every STAT `Z`-prefixed.
 * `ps` appends flags to the state letter (`ZN` for a niced zombie), so only the first letter is the state.
 * @param {string[]} states One `ps` STAT string per member, as from `listGroupStates`.
 * @returns {boolean} True when the listing is non-empty and every member is a zombie.
 * @throws {never} Pure.
 */
export function zombieOnlyListing(states) {
	return states.length > 0 && states.every((state) => state.startsWith("Z"));
}

/**
 * Classify an `EPERM` from signalling `pgid`. Darwin refuses to signal a group whose every member is a
 * zombie awaiting its parent's `wait`, so `EPERM` alone cannot tell that apart from a real credential
 * boundary; the `ps` listing does. A listing with at least one member, all of them zombies, proves nothing
 * live can be signalled or is left to signal. A group whose listing at the start of cleanup showed members
 * (`seen`; never refreshed, and never set by a syscall result) and now lists none was reaped between the
 * syscall and `ps`. Both are `draining`, which is never proof of absence: only ESRCH is. A live member or a
 * never-seen empty group is `denied`. A `ps` that fails or times out decides nothing: `unknown`.
 * @param {number} pgid Owned process-group ID.
 * @param {(pgid: number) => string[]} listStates Member-state seam.
 * @param {boolean} seen Whether the listing taken at the start of cleanup showed a member of this group.
 * @returns {"draining" | "denied" | "unknown"} What the listing says about the `EPERM`.
 * @throws {never} `ps` failures classify as `unknown`.
 */
function classifyPermission(pgid, listStates, seen) {
	let states;
	try {
		states = listStates(pgid);
	} catch {
		return "unknown";
	}
	if (states.length === 0) return seen ? "draining" : "denied";
	return zombieOnlyListing(states) ? "draining" : "denied";
}

/**
 * Explain an `EPERM` with a fresh listing, tracking an unexplained one in `owned.pending`. `draining` clears
 * it; `unknown` keeps the first unexplained error pending, so the caller probes and re-lists without
 * signalling; `denied` throws that first error at once.
 * @param {number} pgid Owned process-group ID.
 * @param {(pgid: number) => string[]} listStates Member-state seam.
 * @param {OwnedGroup} owned Cleanup state for this group.
 * @param {Error} error The `EPERM` being explained.
 * @returns {void}
 * @throws {Error} The first unexplained `EPERM` when the listing shows a live member or a never-seen empty group.
 */
function explainPermission(pgid, listStates, owned, error) {
	const verdict = classifyPermission(pgid, listStates, owned.seen);
	if (verdict === "denied") throw owned.pending ?? error;
	owned.pending = verdict === "unknown" ? (owned.pending ?? error) : undefined;
}

/**
 * True while the group we spawned may still have members. Only ESRCH proves it is empty. An `EPERM` that a
 * listing shows is a draining group, or that no listing has explained yet, still counts as present: the caller
 * keeps probing to ESRCH and sends no signal while `owned.pending` is set. A positive probe never explains a
 * pending `EPERM`, so it re-lists. Other probe failures are inconclusive and preserve the error rather than
 * risking a signal to a group whose ownership we cannot establish.
 * @param {number} pgid Owned process-group ID.
 * @param {(pid: number, signal: number|string) => boolean} kill Syscall seam.
 * @param {(pgid: number) => string[]} listStates Member-state seam.
 * @param {OwnedGroup} owned Cleanup state for this group.
 * @returns {boolean} False only on ESRCH.
 * @throws {Error} Any non-`EPERM` probe failure, or an `EPERM` a listing shows is a real permission failure.
 */
function processGroupAlive(pgid, kill, listStates, owned) {
	try {
		kill(-pgid, 0);
	} catch (error) {
		if (error?.code === "ESRCH") return false;
		if (error?.code !== "EPERM") throw error;
		explainPermission(pgid, listStates, owned, error);
		return true;
	}
	if (owned.pending) explainPermission(pgid, listStates, owned, owned.pending);
	return true;
}

/**
 * Drive the process group `pgid` (owned: it is the pid of the child we spawned detached) to empty:
 * SIGTERM, a bounded grace, then SIGKILL. Resolve only on ESRCH; a positive final probe rejects.
 * A positive probe that persists past the budget rejects, including a zombie-only group: it is never
 * reported as reaped. Darwin answers `EPERM` for such a group, which the `ps` listing tells apart from a
 * real permission failure: a live member or never-seen empty group rejects at once. A listing that fails
 * leaves the `EPERM` unexplained: no signal is sent, probing and re-listing continue, and if no listing has
 * explained it when the budget ends, that first `EPERM` rejects.
 * While any member lives the pgid cannot be reused, so ownership is held until quiescence. The budget is
 * 1.3s from the start of cleanup, and each stage's deadline is capped at it, so a stage ends at its first
 * probe past the budget; the 20ms pause between probes never extends it. Only a synchronous `ps` can overrun
 * it, by at most three `PS_TIMEOUT_MS`: the TERM stage's last probe, the SIGKILL and the KILL stage's first
 * probe. A group whose `EPERM` no listing explained rejects there, at the budget, not at the caller's 2s
 * SIGKILL backstop on this script's pid; it reaches that backstop only if all three of those `ps` runs hit
 * their bound.
 *
 * Residual risk, inherent to POSIX: once the last member dies the id may be reused, so a signal sent in
 * the instant between our liveness probe and `kill` could in theory hit a foreign group that got the same
 * id. The probe-then-signal gap is microseconds and a reuse needs a full pid wraparound inside it; no
 * signal is ever sent after the probe reports the group empty or cannot establish permission.
 */
export async function reapProcessGroup(pgid, kill = process.kill.bind(process), listStates = listGroupStates) {
	if (!isOwnableGroup(pgid)) throw new Error("Cleanup requires an owned positive process-group ID above 1.");
	const budgetEnd = Date.now() + GROUP_TERM_GRACE_MS + GROUP_KILL_WAIT_MS;
	/** @type {OwnedGroup} */
	const owned = { seen: false };
	try { owned.seen = listStates(pgid).length > 0; } catch { /* unknown membership stays strict */ }
	const signalGroup = (signal) => {
		// An unexplained EPERM revokes signalling until a listing explains it; the probes keep watching.
		if (owned.pending) return true;
		try { kill(-pgid, signal); return true; }
		catch (error) {
			if (error?.code === "ESRCH") return false;
			if (error?.code !== "EPERM") throw error;
			// Nothing signalable is left in a draining group; the probes below wait for it to drain.
			explainPermission(pgid, listStates, owned, error);
			return true;
		}
	};
	const quiesce = async (timeoutMs) => {
		// Cap every stage at the overall budget so slow listings cannot compound across stages.
		const deadline = Math.min(Date.now() + timeoutMs, budgetEnd);
		for (;;) {
			// Stop at the first ESRCH: a later positive probe might observe a recycled group.
			if (!processGroupAlive(pgid, kill, listStates, owned)) return true;
			if (Date.now() >= deadline) return false;
			await delay(20);
		}
	};
	if (!processGroupAlive(pgid, kill, listStates, owned)) return;
	if (!signalGroup("SIGTERM")) return;
	if (await quiesce(GROUP_TERM_GRACE_MS)) return;
	if (!signalGroup("SIGKILL")) return;
	if (await quiesce(GROUP_KILL_WAIT_MS)) return;
	if (owned.pending) throw owned.pending;
	throw new Error(`Process group ${pgid} remained non-empty after SIGKILL cleanup.`);
}

/**
 * Run a build tool in its own process group and reap the whole group, escalating to SIGKILL for
 * descendants that ignore SIGTERM, before returning or exiting: on success or failure of the tool, and
 * when this script is terminated (the Pi session's setup deadline sends SIGTERM). Inconclusive cleanup
 * rejects rather than claiming no compiler survived; credential boundaries revoke further signalling.
 */
export async function runCancellable(command, commandArgs, { kill = process.kill.bind(process), listStates = listGroupStates, spawnChild = spawn } = {}) {
	await new Promise((resolve, reject) => {
		const child = spawnChild(command, commandArgs, { stdio: "inherit", detached: true });
		let reaping;
		let reaped = false;
		let maySignal = isOwnableGroup(child.pid);
		const ownedKill = (pid, signal) => {
			try { return kill(pid, signal); }
			catch (error) {
				// ESRCH releases the ID; every other syscall failure makes ownership inconclusive.
				// Neither permits an exit-time retry against a possibly foreign/recycled group.
				maySignal = false;
				throw error;
			}
		};
		const reap = () => (reaping ??= reapProcessGroup(child.pid, ownedKill, listStates).then(() => { reaped = true; }));
		const signals = ["SIGTERM", "SIGINT", "SIGHUP"];
		// Last resort if we are exiting some other way: never leave the group running.
		// Once reaped the group is empty and its id may be reused, so it must never be signalled again.
		const onExit = () => {
			if (reaped || !maySignal) return;
			try {
				// Only a listing-explained or signalable group gets the exit KILL; an unexplained EPERM gets none.
				/** @type {OwnedGroup} */
				const owned = { seen: false };
				if (processGroupAlive(child.pid, ownedKill, listStates, owned) && !owned.pending) ownedKill(-child.pid, "SIGKILL");
			} catch { /* already reported by bounded cleanup, or exit-time ownership is inconclusive */ }
		};
		const onTerminate = (signal) => {
			// Repeated signals while reaping must not fall through to the default action.
			const exit = () => process.exit(128 + (os.constants.signals[signal] ?? 15));
			void reap().then(exit, (error) => {
				console.error(`Process-group cleanup failed: ${error.message}`);
				exit();
			});
		};
		for (const signal of signals) process.on(signal, onTerminate);
		process.on("exit", onExit);
		const cleanup = ({ preserveExitFallback = false } = {}) => {
			for (const signal of signals) process.off(signal, onTerminate);
			if (!preserveExitFallback) process.off("exit", onExit);
		};
		child.on("error", (error) => {
			cleanup();
			reject(error.code === "ENOENT"
				? new Error(`'${command}' was not found on PATH. Install the Rust toolchain (https://rustup.rs) and a C linker (e.g. build-essential).`)
				: error);
		});
		child.on("close", (code, signal) => {
			// A failed spawn has no group and its error handler already rejected; `reapProcessGroup` refuses any
			// ID that is not ownable before a listing or syscall, so this reap only settles the rejection.
			const commandError = code === 0
				? undefined
				: new Error(`Command failed (${code ?? signal}): ${command} ${commandArgs.join(" ")}`);
			reap().then(
				() => {
					cleanup();
					if (commandError) reject(commandError);
					else resolve();
				},
				(cleanupError) => {
					// Retain the backstop only while probes remain positive and permission is known.
					cleanup({ preserveExitFallback: maySignal });
					reject(commandError
						? new AggregateError([commandError, cleanupError], `${commandError.message}; process-group cleanup also failed.`)
						: cleanupError);
				},
			);
		});
	});
}

export function parseCodeSigningIdentities(output, commonName = localCodeSignCommonName) {
	return output.split("\n")
		.map((line) => line.match(/^\s*\d+\)\s+([0-9A-F]{40})\s+"([^"]+)"/i))
		.filter((match) => match?.[2] === commonName)
		.map((match) => match[1].toUpperCase());
}

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withDirectoryLock(lockPath, callback, { waitMs = 15_000, staleMs = 300_000, retryMs = 50 } = {}) {
	const deadline = Date.now() + waitMs;
	while (true) {
		try {
			await fs.mkdir(lockPath);
			break;
		} catch (error) {
			if (error?.code !== "EEXIST") throw error;
			const stat = await fs.stat(lockPath).catch(() => undefined);
			if (stat && Date.now() - stat.mtimeMs > staleMs) {
				await fs.rm(lockPath, { force: true, recursive: true }).catch(() => undefined);
				continue;
			}
			if (Date.now() >= deadline) throw new Error(`Timed out waiting for local signing identity lock at ${lockPath}.`);
			await delay(retryMs);
		}
	}
	try {
		return await callback();
	} finally {
		await fs.rm(lockPath, { force: true, recursive: true }).catch(() => undefined);
	}
}

export async function ensureIdentityOnce(findIdentity, createIdentity, withLock) {
	return (await findIdentity()) ?? await withLock(async () => (await findIdentity()) ?? await createIdentity());
}


/**
 * Everything `main` reads from the host. Production wiring is `defaultDeps`; tests inject fakes.
 * @typedef {object} SetupDeps
 * @property {string} platform `process.platform`.
 * @property {string} hostArch `process.arch`.
 * @property {Record<string, string | undefined>} env `process.env`.
 * @property {number} pid `process.pid`.
 * @property {string | undefined} uid `process.getuid()`, or `undefined` where it does not exist.
 * @property {string} rootDir Package root holding `native/`, `prebuilt/` and `package.json`.
 * @property {typeof import("node:fs/promises")} fs Filesystem seam.
 * @property {typeof import("node:os")} os `homedir`, `tmpdir` and signal numbers.
 * @property {typeof spawn} spawn Streaming child-process seam, used by `run`.
 * @property {(command: string, args: string[], options?: object) => Promise<{stdout: string, stderr: string}>} execFile Buffered child-process seam.
 * @property {typeof runCancellable} runCancellable Cancellable child-process seam for the Linux cargo build.
 * @property {typeof fetch} fetch Network seam.
 * @property {typeof createWriteStream} createWriteStream Download sink.
 * @property {typeof pipeline} pipeline Stream copier.
 * @property {() => number} now Clock.
 * @property {(ms: number) => Promise<void>} sleep Pause seam.
 * @property {Pick<Console, "log" | "warn" | "error">} console Output seam.
 * @property {(code: number) => never} exit Process exit seam.
 */

/**
 * Bind the helper installer to `deps` and its argv.
 * @param {string[]} argv CLI arguments after the script name.
 * @param {SetupDeps} deps Host seams.
 * @returns {{setup: () => Promise<void>, isPostinstall: boolean}} The install entry point and whether `--postinstall` was passed.
 * @throws {Error} When `resolveMacosHelperAppPath` cannot probe the filesystem.
 */
function createSetup(argv, deps) {
	const { platform, hostArch, env, pid, uid, rootDir, fs, os, spawn, execFile, runCancellable, fetch, createWriteStream, pipeline, now, sleep, console } = deps;
	const helperAppPath = resolveMacosHelperAppPath({ env, homeDir: os.homedir() });
	const helperAppExecutablePath = path.join(helperAppPath, "Contents", "MacOS", "bridge");
	const helperSourceHashPath = path.join(helperAppPath, "Contents", "Resources", "source.sha256");
	const windowsCrateDir = path.join(rootDir, "native", "windows", "bridge-rs");
	const windowsHelperDestPath = env.PI_COMPUTER_USE_WINDOWS_HELPER_PATH || path.join(os.homedir(), ".pi", "agent", "helpers", "pi-computer-use", "windows-bridge.exe");
	const linuxCrateDir = path.join(rootDir, "native", "linux", "bridge-rs");
	const linuxHelperDestPath = env.PI_COMPUTER_USE_LINUX_HELPER_PATH || path.join(os.homedir(), ".pi", "agent", "helpers", "pi-computer-use", "linux-bridge");
	// The packed crate lives in the (often root-owned, read-only) npm install, so cargo builds into the user's cache.
	const linuxBuildTargetDir = path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "pi-computer-use", "linux-bridge-target");
	const helperSourcePaths = ["activity_glow.swift", "agent_cursor.swift", "agent_cursor_motion.swift", "bridge.swift", "helper_entry.swift"]
		.map((file) => path.join(rootDir, "native", "macos", file));
	const packageJsonPath = path.join(rootDir, "package.json");
	const localSigningLockPath = path.join(os.tmpdir(), `pi-computer-use-local-signing-${uid ?? "user"}.lock`);

	const args = new Set(argv);
	const isPostinstall = args.has("--postinstall");
	const allowBuildFallback = args.has("--allow-build") || args.has("--runtime") || env.PI_COMPUTER_USE_ALLOW_BUILD === "1";
	const allowLinuxBuildFallback = args.has("--allow-build") || env.PI_COMPUTER_USE_ALLOW_BUILD === "1";
	const allowAdhocUpdate = args.has("--allow-adhoc-update") || env.PI_COMPUTER_USE_ALLOW_ADHOC_UPDATE === "1";

	function getArg(name) {
		const index = argv.indexOf(name);
		if (index >= 0 && index + 1 < argv.length) return argv[index + 1];
		return undefined;
	}

	function normalizeArch(arch) {
		if (arch === "arm64" || arch === "x64") return arch;
		throw new Error(`Unsupported architecture '${arch}'. Supported: arm64, x64.`);
	}

	function prebuiltPathForArch(arch) {
		return path.join(rootDir, "prebuilt", "macos", arch, "bridge");
	}

	function prebuiltAppPathForArch(arch) {
		return path.join(rootDir, "prebuilt", "macos", arch, "pi-computer-use.app");
	}

	async function packageVersion() {
		const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));
		if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
			throw new Error(`Could not read package version from ${packageJsonPath}.`);
		}
		return packageJson.version;
	}

	function githubReleaseUrl(tag, assetName) {
		return `https://github.com/${releaseRepo}/releases/download/${tag}/${assetName}`;
	}

	async function exists(filePath) {
		try {
			await fs.access(filePath, fsConstants.F_OK);
			return true;
		} catch {
			return false;
		}
	}

	async function hashFile(filePath) {
		const data = await fs.readFile(filePath);
		return createHash("sha256").update(data).digest("hex");
	}

	async function copyIfChanged(sourcePath, destinationPath) {
		const destinationExists = await exists(destinationPath);
		if (destinationExists) {
			const [sourceHash, destinationHash] = await Promise.all([hashFile(sourcePath), hashFile(destinationPath)]);
			if (sourceHash === destinationHash) {
				await fs.chmod(destinationPath, 0o755);
				return { changed: false };
			}
		}

		await fs.mkdir(path.dirname(destinationPath), { recursive: true });
		const tempPath = `${destinationPath}.tmp-${pid}-${now()}`;
		await fs.copyFile(sourcePath, tempPath);
		await fs.chmod(tempPath, 0o755);
		try {
			await fs.rename(tempPath, destinationPath);
		} catch (err) {
			await fs.rm(tempPath, { force: true }).catch(() => {});
			if (err.code === "EPERM") {
				throw new Error(`Cannot update helper at ${destinationPath} — the existing helper process is still running. Close the helper process and re-run this script.`);
			}
			throw err;
		}
		return { changed: true };
	}

	async function run(command, commandArgs) {
		await new Promise((resolve, reject) => {
			const child = spawn(command, commandArgs, { stdio: "inherit" });
			child.on("error", reject);
			child.on("close", (code) => {
				if (code === 0) {
					resolve();
					return;
				}
				reject(new Error(`Command failed (${code}): ${command} ${commandArgs.join(" ")}`));
			});
		});
	}

	async function commandOutput(command, commandArgs) {
		const { stdout } = await execFile(command, commandArgs, { encoding: "utf8" });
		return stdout;
	}

	async function downloadFile(url, outputPath) {
		const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
		if (!response.ok) {
			throw new Error(`HTTP ${response.status} ${response.statusText}`);
		}
		if (!response.body) {
			throw new Error("empty response body");
		}
		await pipeline(response.body, createWriteStream(outputPath));
	}

	async function releaseChecksums(tag) {
		const response = await fetch(githubReleaseUrl(tag, "SHA256SUMS"), { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
		if (!response.ok) return new Map();
		const text = await response.text();
		const checksums = new Map();
		for (const line of text.split("\n")) {
			const match = line.trim().match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
			if (match) checksums.set(path.basename(match[2]), match[1].toLowerCase());
		}
		return checksums;
	}

	async function verifySha256(filePath, expected) {
		const file = await fs.readFile(filePath);
		const actual = createHash("sha256").update(file).digest("hex");
		if (actual !== expected.toLowerCase()) {
			throw new Error(`SHA256 mismatch for ${path.basename(filePath)}: expected ${expected}, got ${actual}`);
		}
	}

	async function findExtractedHelperApp(extractDir) {
		const direct = path.join(extractDir, "pi-computer-use.app");
		if (await exists(direct)) return direct;
		const entries = await fs.readdir(extractDir, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const entryPath = path.join(extractDir, entry.name);
			const nested = await findExtractedHelperApp(entryPath);
			if (nested) return nested;
		}
		return undefined;
	}

	async function downloadReleaseHelperApp() {
		const version = await packageVersion();
		const tag = `v${version}`;
		const checksums = await releaseChecksums(tag).catch(() => new Map());
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-computer-use-release-helper-"));
		try {
			const zipPath = path.join(tempDir, releaseAssetName);
			await downloadFile(githubReleaseUrl(tag, releaseAssetName), zipPath);
			const expectedSha = checksums.get(releaseAssetName);
			if (expectedSha) await verifySha256(zipPath, expectedSha);
			const extractDir = path.join(tempDir, "extract");
			await fs.mkdir(extractDir, { recursive: true });
			await run("/usr/bin/ditto", ["-x", "-k", zipPath, extractDir]);
			const appPath = await findExtractedHelperApp(extractDir);
			if (!appPath) throw new Error(`missing pi-computer-use.app in ${releaseAssetName}`);
			return { appPath, tempDir, assetName: releaseAssetName, tag };
		} catch (error) {
			await fs.rm(tempDir, { force: true, recursive: true }).catch(() => {});
			throw new Error(`No signed helper release asset found for ${tag}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async function findDeveloperIdIdentity() {
		const output = await commandOutput("security", ["find-identity", "-p", "codesigning", "-v"]).catch(() => "");
		const line = output.split("\n").find((item) => item.includes("Developer ID Application"));
		return line?.trim().split(/\s+/)[1];
	}

	async function findLocalSigningIdentity() {
		// Self-signed local identities appear as CSSMERR_TP_NOT_TRUSTED and are
		// omitted by `-v`, but remain valid inputs to codesign. Match the identity
		// list directly and return its fingerprint rather than its display name.
		const output = await commandOutput("security", ["find-identity", "-p", "codesigning"]).catch(() => "");
		return parseCodeSigningIdentities(output)[0];
	}

	async function loginKeychainPath() {
		for (const candidate of [
			path.join(os.homedir(), "Library", "Keychains", "login.keychain-db"),
			path.join(os.homedir(), "Library", "Keychains", "login.keychain"),
		]) {
			if (await exists(candidate)) return candidate;
		}
		return undefined;
	}

	async function ensureLocalSigningIdentity() {
		if (!(await commandOutput("which", ["codesign"]).catch(() => ""))) return undefined;
		const existingIdentity = await findLocalSigningIdentity();
		if (existingIdentity) return existingIdentity;
		if (!(await commandOutput("which", ["openssl"]).catch(() => ""))) return undefined;
		const keychain = await loginKeychainPath();
		if (!keychain) return undefined;

		return await ensureIdentityOnce(findLocalSigningIdentity, createLocalSigningIdentity, (callback) => withDirectoryLock(localSigningLockPath, callback));
	}

	async function createLocalSigningIdentity() {
		// Re-resolve under the lock: another installer may have removed the keychain since the first lookup.
		const keychain = await loginKeychainPath();
		if (!keychain) return undefined;
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-computer-use-signing-"));
		const password = `pi-computer-use-local-${pid}-${now()}`;
		try {
			const configPath = path.join(tempDir, "req.cnf");
			await fs.writeFile(configPath, [
				"[req]",
				"distinguished_name=dn",
				"x509_extensions=ext",
				"prompt=no",
				"[dn]",
				`CN=${localCodeSignCommonName}`,
				"[ext]",
				"basicConstraints=critical,CA:FALSE",
				"keyUsage=critical,digitalSignature",
				"extendedKeyUsage=critical,codeSigning",
				"",
			].join("\n"));
			const keyPath = path.join(tempDir, "key.pem");
			const certPath = path.join(tempDir, "cert.pem");
			const p12Path = path.join(tempDir, "id.p12");
			await execFile("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-keyout", keyPath, "-out", certPath, "-days", "3650", "-nodes", "-config", configPath]);
			await execFile("openssl", ["pkcs12", "-export", "-legacy", "-inkey", keyPath, "-in", certPath, "-out", p12Path, "-passout", `pass:${password}`, "-name", localCodeSignCommonName])
				.catch(async () => {
					await execFile("openssl", ["pkcs12", "-export", "-inkey", keyPath, "-in", certPath, "-out", p12Path, "-passout", `pass:${password}`, "-name", localCodeSignCommonName]);
				});
			await execFile("security", ["import", p12Path, "-k", keychain, "-P", password, "-A", "-T", "/usr/bin/codesign"]);
			const identity = await findLocalSigningIdentity();
			if (!identity) throw new Error("Imported local signing certificate is not a valid code-signing identity.");
			return identity;
		} catch (error) {
			console.warn(`[pi-computer-use] could not create a valid local signing identity: ${error instanceof Error ? error.message : String(error)}`);
			return undefined;
		} finally {
			await fs.rm(tempDir, { force: true, recursive: true }).catch(() => {});
		}
	}

	async function resolveCodeSignIdentity() {
		if (env.PI_COMPUTER_USE_CODESIGN_IDENTITY) return env.PI_COMPUTER_USE_CODESIGN_IDENTITY;
		return (await findDeveloperIdIdentity()) ?? (await ensureLocalSigningIdentity()) ?? "-";
	}

	async function signHelper(outputPath, identifier = defaultCodeSignIdentifier) {
		if (env.PI_COMPUTER_USE_NO_SIGN === "1") {
			return "unsigned";
		}

		const identity = await resolveCodeSignIdentity();
		const commandArgs = ["--force", "--deep", "-i", identifier, "--timestamp=none", "--sign", identity, outputPath];
		await run("codesign", commandArgs);
		if (identity === "-") {
			console.warn("[pi-computer-use] warning: signed helper ad-hoc; macOS may require permission review after native helper changes. Release installs should use a Developer ID-signed helper app.");
		} else if (identity === await findLocalSigningIdentity()) {
			console.log(`[pi-computer-use] signed ${outputPath} with local identity '${localCodeSignCommonName}'. macOS may still require permission review after local rebuilds.`);
		}
		return identity;
	}

	async function helperHasAdhocSignature() {
		const output = await execFile("codesign", ["-dv", "--verbose=4", helperAppPath], { encoding: "utf8" }).then(
			(result) => `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
			(error) => `${error.stdout ?? ""}\n${error.stderr ?? ""}`,
		);
		return /Signature=adhoc/i.test(output);
	}

	async function registerHelperApp() {
		const lsregister = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
		if (!(await exists(lsregister))) return;
		await run(lsregister, ["-f", helperAppPath]).catch(() => {});
	}

	async function ensureHelperParentDirectory() {
		const parentPath = path.dirname(helperAppPath);
		await fs.mkdir(parentPath, { recursive: true });
		await fs.access(parentPath, fsConstants.W_OK);
	}

	/** A running helper keeps its old code after the bundle is replaced; stop it so the next command relaunches the new one. */
	async function stopRunningHelper() {
		// -f takes an extended regex: escape the path so `.`, `+`, `(` and spaces match literally.
		const pattern = `${helperAppExecutablePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} serve`;
		await execFile("pkill", ["-f", pattern]).catch(() => {});
		for (let attempt = 0; attempt < 20; attempt += 1) {
			const alive = await execFile("pgrep", ["-f", pattern]).then(() => true, () => false);
			if (!alive) return;
			await sleep(100);
		}
	}

	async function installPrebuiltHelperApp(sourceAppPath) {
		await ensureHelperParentDirectory();
		const sourceExecutablePath = path.join(sourceAppPath, "Contents", "MacOS", "bridge");
		const sourceInfoPath = path.join(sourceAppPath, "Contents", "Info.plist");
		const existingExecutable = await fs.readFile(helperAppExecutablePath).catch(() => undefined);
		const sourceExecutable = await fs.readFile(sourceExecutablePath);
		const existingInfo = await fs.readFile(path.join(helperAppPath, "Contents", "Info.plist"), "utf8").catch(() => undefined);
		const sourceInfo = await fs.readFile(sourceInfoPath, "utf8");
		if (existingExecutable?.equals(sourceExecutable) && existingInfo === sourceInfo) {
			await registerHelperApp();
			return false;
		}
		// The sealed bundle must arrive intact — a broken signature would burn
		// the user's TCC grants on an identity that can never validate.
		await run("codesign", ["--verify", "--strict", sourceAppPath]);
		await stopRunningHelper();
		await fs.rm(helperAppPath, { force: true, recursive: true });
		// ditto preserves the bundle byte-for-byte (signature + stapled
		// notarization ticket). The sealed app is NEVER re-signed here: its
		// Developer ID designated requirement (identifier + team) is exactly
		// what gives release builds their best chance of retaining TCC grants.
		await run("/usr/bin/ditto", [sourceAppPath, helperAppPath]);
		await registerHelperApp();
		return true;
	}

	async function installHelperApp(sourcePath) {
		await ensureHelperParentDirectory();
		const version = await packageVersion();
		const infoPlistPath = path.join(helperAppPath, "Contents", "Info.plist");
		const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${helperBundleId}</string>
<key>CFBundleName</key><string>pi-computer-use</string>
<key>CFBundleDisplayName</key><string>pi-computer-use</string>
<key>CFBundleExecutable</key><string>bridge</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleVersion</key><string>${version}</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>LSUIElement</key><true/>
</dict></plist>\n`;

		const sourceExecutable = await fs.readFile(sourcePath);
		const sourceHash = createHash("sha256").update(sourceExecutable).digest("hex");
		const existingSourceHash = await fs.readFile(helperSourceHashPath, "utf8").catch(() => undefined);
		const existingInfoPlist = await fs.readFile(infoPlistPath, "utf8").catch(() => undefined);
		if (existingSourceHash?.trim() === sourceHash && existingInfoPlist === infoPlist) {
			// If a real signing identity is available, upgrade older ad-hoc installs
			// in place so local builds have a consistent identity. macOS may still
			// require permission review after native code changes.
			const signingIdentity = env.PI_COMPUTER_USE_NO_SIGN === "1" ? "-" : await resolveCodeSignIdentity();
			if (signingIdentity !== "-" && await helperHasAdhocSignature()) {
				await signHelper(helperAppPath, helperBundleId);
				await registerHelperApp();
				return true;
			}
			await registerHelperApp();
			return false;
		}

		const signingIdentity = env.PI_COMPUTER_USE_NO_SIGN === "1" ? "-" : await resolveCodeSignIdentity();
		if (signingIdentity === "-" && existingSourceHash !== undefined && !allowAdhocUpdate) {
			throw new Error("Refusing to replace an installed helper with an ad-hoc signed rebuild because macOS may reset Accessibility/Screen Recording grants. Use a pre-signed helper app, install a Developer ID identity, or set PI_COMPUTER_USE_ALLOW_ADHOC_UPDATE=1 for local development.");
		}

		await fs.mkdir(path.dirname(helperAppExecutablePath), { recursive: true });
		await fs.mkdir(path.dirname(helperSourceHashPath), { recursive: true });
		await stopRunningHelper();
		await fs.copyFile(sourcePath, helperAppExecutablePath);
		await fs.chmod(helperAppExecutablePath, 0o755);
		await fs.writeFile(infoPlistPath, infoPlist);
		await fs.writeFile(helperSourceHashPath, `${sourceHash}\n`);
		await signHelper(helperAppPath, helperBundleId);
		await registerHelperApp();
		return true;
	}

	async function buildHelper(arch, outputPath) {
		for (const sourcePath of helperSourcePaths) {
			if (!(await exists(sourcePath))) throw new Error(`Native helper source not found at ${sourcePath}`);
		}

		await fs.mkdir(path.dirname(outputPath), { recursive: true });
		// A private, owned module cache: a fixed name in a shared `os.tmpdir()` (`/tmp` for several
		// accounts on one host) is owned by whoever built first and denies everyone else.
		const moduleCachePath = await fs.mkdtemp(path.join(os.tmpdir(), "pi-computer-use-swift-module-cache-"));
		const swiftArgs = [
			"swiftc",
			"-target",
			`${archTriples[arch]}${deploymentTarget}`,
			"-module-cache-path",
			moduleCachePath,
			"-O",
		];
		for (const framework of frameworks) swiftArgs.push("-framework", framework);
		swiftArgs.push(...helperSourcePaths, "-o", outputPath);

		try {
			await run("xcrun", swiftArgs);
		} finally {
			await fs.rm(moduleCachePath, { recursive: true, force: true });
		}
		await fs.chmod(outputPath, 0o755);
		await signHelper(outputPath);
	}

	function windowsBinaryPath() {
		const releaseDir = path.join(windowsCrateDir, "target", "release");
		return {
			exePath: path.join(releaseDir, "windows-bridge.exe"),
			binPath: path.join(releaseDir, "windows-bridge"),
		};
	}

	async function setupWindowsHelper() {
		const prebuiltPath = path.join(rootDir, "prebuilt", "windows", "windows-bridge.exe");
		if (await exists(prebuiltPath)) {
			const { changed } = await copyIfChanged(prebuiltPath, windowsHelperDestPath);
			console.log(changed
				? `[pi-computer-use] installed Windows helper from prebuilt to ${windowsHelperDestPath}`
				: `[pi-computer-use] Windows helper already up to date at ${windowsHelperDestPath}`);
			return;
		}

		if (allowBuildFallback) {
			console.log("[pi-computer-use] Windows prebuilt helper missing; attempting source build with cargo...");
			await run("cargo", ["build", "--release", "--manifest-path", path.join(windowsCrateDir, "Cargo.toml")]);
			const { exePath, binPath } = windowsBinaryPath();
			const cargoOutput = (await exists(exePath)) ? exePath : (await exists(binPath)) ? binPath : exePath;
			const { changed } = await copyIfChanged(cargoOutput, windowsHelperDestPath);
			console.log(changed
				? `[pi-computer-use] built and installed Windows helper at ${windowsHelperDestPath}`
				: `[pi-computer-use] Windows helper already up to date at ${windowsHelperDestPath}`);
			return;
		}

		throw new Error(
			`No Windows prebuilt helper found at ${prebuiltPath}. ` +
				"Run 'node scripts/build-native.mjs --platform windows' to build, or set PI_COMPUTER_USE_ALLOW_BUILD=1 to build at install time.",
		);
	}

	async function setupLinuxHelper() {
		const arch = normalizeArch(hostArch);
		const prebuiltPath = path.join(rootDir, "prebuilt", "linux", arch, "linux-bridge");
		if (await exists(prebuiltPath)) {
			const { changed } = await copyIfChanged(prebuiltPath, linuxHelperDestPath);
			console.log(changed ? `[pi-computer-use] installed Linux helper (${arch}) from prebuilt to ${linuxHelperDestPath}` : `[pi-computer-use] Linux helper already up to date at ${linuxHelperDestPath}`);
			return;
		}
		if (allowLinuxBuildFallback) {
			if (platform !== "linux") throw new Error("The Linux helper source fallback must be built on Linux.");
			if (!(await exists(path.join(linuxCrateDir, "Cargo.toml")))) throw new Error(`Linux helper source not found at ${linuxCrateDir}; reinstall @nredd/pi-computer-use.`);
			console.log(`[pi-computer-use] Linux prebuilt helper missing; building from source with cargo (target dir ${linuxBuildTargetDir})...`);
			await runCancellable("cargo", ["build", "--locked", "--release", "--manifest-path", path.join(linuxCrateDir, "Cargo.toml"), "--target-dir", linuxBuildTargetDir]);
			const cargoOutput = path.join(linuxBuildTargetDir, "release", "linux-bridge");
			const { changed } = await copyIfChanged(cargoOutput, linuxHelperDestPath);
			console.log(changed ? `[pi-computer-use] built and installed Linux helper at ${linuxHelperDestPath}` : `[pi-computer-use] Linux helper already up to date at ${linuxHelperDestPath}`);
			return;
		}
		throw new Error(`No Linux prebuilt helper found for ${arch} at ${prebuiltPath}. Run node scripts/build-native.mjs --platform linux to build, or set PI_COMPUTER_USE_ALLOW_BUILD=1 to build at install time.`);
	}

	async function setup() {
		const explicitPlatform = getArg("--platform");
		if (explicitPlatform === "windows" || (!explicitPlatform && platform === "win32")) {
			await setupWindowsHelper();
			return;
		}
		if (explicitPlatform === "linux" || (!explicitPlatform && platform === "linux")) {
			await setupLinuxHelper();
			return;
		}

		if (platform !== "darwin") {
			if (isPostinstall) {
				console.warn("[pi-computer-use] skipping helper setup: platform is not macOS.");
				return;
			}
			throw new Error("pi-computer-use helper is supported on macOS, Windows, and Linux. Use the matching --platform option.");
		}

		const arch = normalizeArch(hostArch);
		// Prefer the release-signed universal bundle (one artifact for both
		// arches, produced by .github/workflows/release.yml) over
		// per-arch bundles, over loose binaries (dev fallback).
		const universalAppPath = prebuiltAppPathForArch("universal");
		const prebuiltAppPath = (await exists(universalAppPath))
			? universalAppPath
			: prebuiltAppPathForArch(arch);
		const prebuiltPath = prebuiltPathForArch(arch);
		const prebuiltAppExists = await exists(prebuiltAppPath);
		const prebuiltExists = await exists(prebuiltPath);

		if (prebuiltAppExists) {
			const installed = await installPrebuiltHelperApp(prebuiltAppPath);
			console.log(
				installed
					? `[pi-computer-use] installed pre-signed helper app (${arch}) at ${helperAppPath}`
					: `[pi-computer-use] pre-signed helper app (${arch}) already current at ${helperAppPath}`,
			);
			return;
		}

		if (prebuiltExists) {
			const installed = await installHelperApp(prebuiltPath);
			console.log(
				installed
					? `[pi-computer-use] installed helper app (${arch}) at ${helperAppPath}`
					: `[pi-computer-use] helper app (${arch}) already current at ${helperAppPath}`,
			);
			return;
		}

		try {
			const releaseHelper = await downloadReleaseHelperApp();
			try {
				const installed = await installPrebuiltHelperApp(releaseHelper.appPath);
				console.log(
					installed
						? `[pi-computer-use] installed signed helper app from GitHub Release ${releaseHelper.tag} (${releaseHelper.assetName}) at ${helperAppPath}`
						: `[pi-computer-use] signed helper app from GitHub Release ${releaseHelper.tag} (${releaseHelper.assetName}) already current at ${helperAppPath}`,
				);
			} finally {
				await fs.rm(releaseHelper.tempDir, { force: true, recursive: true }).catch(() => {});
			}
			return;
		} catch (error) {
			console.warn(`[pi-computer-use] signed helper release download unavailable: ${error instanceof Error ? error.message : String(error)}`);
		}

		if (allowBuildFallback) {
			const tempPath = path.join(os.tmpdir(), `pi-computer-use-bridge-${pid}-${now()}`);
			try {
				console.log("[pi-computer-use] prebuilt helper missing; attempting source build with xcrun swiftc...");
				await buildHelper(arch, tempPath);
				const installed = await installHelperApp(tempPath);
				console.log(
					installed
						? `[pi-computer-use] built helper app at ${helperAppPath}`
						: `[pi-computer-use] built helper app; installed app already current at ${helperAppPath}`,
				);
			} finally {
				await fs.rm(tempPath, { force: true }).catch(() => {});
			}
			return;
		}

		throw new Error(
			`No prebuilt helper found for ${arch} at ${prebuiltPath}. Run 'npm run build:native' to build locally.`,
		);
	}

	return { setup, isPostinstall };
}

/**
 * Production host wiring.
 * @returns {SetupDeps} Real `process`, `fs`, `os`, `fetch` and child-process seams.
 * @throws {never} Pure wiring.
 */
export function defaultDeps() {
	return {
		platform: process.platform,
		hostArch: process.arch,
		env: process.env,
		pid: process.pid,
		uid: typeof process.getuid === "function" ? String(process.getuid()) : undefined,
		rootDir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
		fs,
		os,
		spawn,
		execFile,
		runCancellable,
		fetch,
		createWriteStream,
		pipeline,
		now: Date.now,
		sleep: delay,
		console,
		exit: process.exit.bind(process),
	};
}

/**
 * Install the native helper for this host, as `npm postinstall` or by hand. A failure exits 0 with a warning
 * under `--postinstall` (an install must not break on a missing helper) and 1 otherwise.
 * @param {string[]} argv CLI arguments after the script name.
 * @param {SetupDeps} deps Host seams, `defaultDeps()` in production.
 * @returns {Promise<void>} Resolves after a successful install, or after `deps.exit` is called.
 * @throws {never} Failures are reported through `deps.exit`.
 */
export async function main(argv, deps) {
	const { setup, isPostinstall } = createSetup(argv, deps);
	try {
		await setup();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (isPostinstall) {
			deps.console.warn(`[pi-computer-use] postinstall helper setup skipped: ${message}`);
			deps.exit(0);
		} else {
			deps.console.error(message);
			deps.exit(1);
		}
	}
}

/**
 * Whether this module is the process entry script, symlinks resolved.
 * @param {string | undefined} entryPath `process.argv[1]`.
 * @param {string} moduleUrl `import.meta.url`.
 * @param {(target: string) => string} [realpath] Symlink resolver.
 * @returns {boolean} True when `entryPath` names this file.
 * @throws {Error} When either path cannot be resolved.
 */
export function isEntrypoint(entryPath, moduleUrl, realpath = realpathSync) {
	return Boolean(entryPath) && realpath(path.resolve(entryPath)) === realpath(fileURLToPath(moduleUrl));
}

/**
 * Run `main` only for the entry script.
 * @param {boolean} isMain Result of `isEntrypoint`.
 * @param {string[]} argv CLI arguments after the script name.
 * @param {SetupDeps} deps Host seams, `defaultDeps()` in production.
 * @returns {Promise<void>} Settles when `main` does; resolves at once when not the entry script.
 * @throws {never} `main` reports failures through `deps.exit`.
 */
export function dispatch(isMain, argv, deps) {
	return isMain ? main(argv, deps) : Promise.resolve();
}

void dispatch(isEntrypoint(process.argv[1], import.meta.url), process.argv.slice(2), defaultDeps());
