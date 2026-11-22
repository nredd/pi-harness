import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
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
		const contents = readFileSync(path.join(directory, name));
		hash.update(`${name}:${contents.length}:`).update(contents);
	}
	return `${version}+${hash.digest("hex")}`;
}
