import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Shape of a build identity: package version, `+`, SHA-256 of the production Swift sources. */
export const MACOS_HELPER_BUILD_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\+[0-9a-f]{64}$/;

/**
 * The production Swift compiler inputs, relative to the package root: `build:native` compiles exactly these and
 * `scripts/package_contracts.py` parses this declaration from the packed module to require each one packed, so
 * keep it a plain literal list plus `.map`. Any other Swift file in a checkout is neither compiled nor hashed.
 */
export const macosHelperSourcePaths = [
	"activity_glow.swift",
	"agent_cursor.swift",
	"agent_cursor_motion.swift",
	"bridge.swift",
	"helper_entry.swift",
].map((file) => path.join("native", "macos", file));

/**
 * Identity of the compiled production Swift sources, independent of architecture and checkout path.
 * @param {string} root Package root containing the manifest and `macosHelperSourcePaths`.
 * @returns {string} Package version and source hash.
 */
export function macosHelperBuild(root) {
	const { version } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
	const hash = createHash("sha256");
	for (const source of macosHelperSourcePaths) {
		const contents = Buffer.from(readFileSync(path.join(root, source), "utf8").replaceAll("\r\n", "\n"));
		hash.update(`${path.basename(source)}:${contents.length}:`).update(contents);
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
