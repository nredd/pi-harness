import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Shape of a build identity: package version, `+`, SHA-256 of the production Swift sources. */
export const MACOS_HELPER_BUILD_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\+[0-9a-f]{64}$/;

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
