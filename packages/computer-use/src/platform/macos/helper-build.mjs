import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Identity of the shipped production Swift sources, independent of architecture and checkout path.
 * @param {string} root Package root containing the manifest and shipped Swift sources.
 * @returns {string} Package version and source hash.
 */
export function macosHelperBuild(root) {
	const { version } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
	const directory = path.join(root, "native", "macos");
	const hash = createHash("sha256");
	const sources = readdirSync(directory).filter((name) => name.endsWith(".swift") && !name.endsWith("_tests.swift"));
	for (const name of sources.sort()) {
		const contents = Buffer.from(readFileSync(path.join(directory, name), "utf8").replaceAll("\r\n", "\n"));
		hash.update(`${name}:${contents.length}:`).update(contents);
	}
	return `${version}+${hash.digest("hex")}`;
}

/**
 * Compile the identity into the running binary, not a replaceable file beside it.
 * @param {string} root Package root.
 * @param {string} directory Scratch directory for the generated Swift file.
 */
export function writeMacosBuildStamp(root, directory) {
	const stamp = path.join(directory, "HelperBuildStamp.swift");
	writeFileSync(stamp, `let helperBuildIdentity = ${JSON.stringify(macosHelperBuild(root))}\n`);
	return stamp;
}

/**
 * Keep the upgrade note outside the signed bundle and scoped to the intended build.
 * @param {string} appPath Installed application bundle path.
 */
export function macosSigningRefusalPath(appPath) {
	return `${appPath}.signing-refusal`;
}

export const macosSigningRecovery =
	"Setup refused to replace the retained helper because no usable Developer ID or managed local signing identity was available. Use a pre-signed helper app or make one of those identities available, then re-run setup. For local development only, explicitly opt in with PI_COMPUTER_USE_ALLOW_ADHOC_UPDATE=1 (macOS may reset permissions).";

/**
 * Report an earlier signing refusal only for the build setup attempted to install.
 * @param {string} appPath Installed application bundle path.
 * @param {string} expectedBuild Build the client requires.
 */
export function macosSigningRefusal(appPath, expectedBuild) {
	try {
		return readFileSync(macosSigningRefusalPath(appPath), "utf8").trim() === expectedBuild
			? ` ${macosSigningRecovery}`
			: "";
	} catch {
		return "";
	}
}

/**
 * Run `callback` while holding a `mkdir` lock shared by every process of this user. A holder that died is
 * presumed after `staleMs`; a live holder makes the caller wait up to `waitMs`.
 * @template T
 * @param {string} lockPath Lock directory to create; its parent must exist.
 * @param {() => Promise<T>} callback Work done under the lock.
 * @param {{waitMs?: number, staleMs?: number, retryMs?: number, label?: string}} [options] Timing and the lock's name in errors.
 * @returns {Promise<T>} What `callback` resolves to.
 * @throws {Error} On timeout, on a creation failure other than `EEXIST`, or what `callback` throws.
 */
export async function withDirectoryLock(
	lockPath,
	callback,
	{ waitMs = 15_000, staleMs = 300_000, retryMs = 50, label = "local signing identity" } = {},
) {
	const deadline = Date.now() + waitMs;
	while (true) {
		try {
			await fs.mkdir(lockPath);
			break;
		} catch (error) {
			if (/** @type {NodeJS.ErrnoException} */ (error)?.code !== "EEXIST") throw error;
			const stat = await fs.stat(lockPath).catch(() => undefined);
			if (stat && Date.now() - stat.mtimeMs > staleMs) {
				await fs.rm(lockPath, { force: true, recursive: true }).catch(() => undefined);
				continue;
			}
			if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label} lock at ${lockPath}.`);
			await new Promise((resolve) => setTimeout(resolve, retryMs));
		}
	}
	try {
		return await callback();
	} finally {
		await fs.rm(lockPath, { force: true, recursive: true }).catch(() => undefined);
	}
}
