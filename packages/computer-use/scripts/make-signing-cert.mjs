#!/usr/bin/env node
// Ported from injaneity/pi-computer-use's MIT-licensed make-signing-cert.sh.
// Keep the self-signed development identity stable; this does not promise persistent TCC grants.
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import fs from "node:fs/promises";
import { constants } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CN = "pi-computer-use Self Signed";
export const CERT_CONFIG = `[req]
distinguished_name = dn
x509_extensions = v3
prompt = no
[dn]
CN = pi-computer-use Self Signed
[v3]
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
basicConstraints = critical, CA:false
`;

// Preserve bash's silent terminal read, IFS trimming, EOF and interrupt behavior rather than
// reimplementing terminal editing. This tiny shell fragment, like the launcher, is NOT Node coverage.
export const PASSWORD_READER =
	'set -e; read -r -s -p "Password for the exported .p12: " P12_PASS; printf "%s" "$P12_PASS"';

/** Host seams follow setup-helper.mjs: tests use real disposable files and fake commands. */
export const defaultDeps = { fs, spawnSync, output: process.stdout, error: process.stderr };

/** Shell-compatible command failure mapping; never print argv containing a password.
 * @param {Omit<import('node:child_process').SpawnSyncReturns<string | Buffer>, 'error'> & {error?: NodeJS.ErrnoException}} result Completed child.
 * @param {Pick<typeof defaultDeps, 'error'>} deps Diagnostic stream.
 * @returns {number} Exit status, failing closed when no outcome was reported.
 */
export function commandStatus(result, deps) {
	if (result.error) {
		deps.error.write(`command: ${result.error.code}\n`);
		return result.error.code === "ENOENT" ? 127 : 126;
	}
	if (result.signal) return 128 + constants.signals[result.signal];
	return result.status ?? 1;
}

/** Generate the same files and OpenSSL arguments as the original shell command; stop on the first failure.
 * @param {string[]} argv CLI arguments (only the first is consumed, as before).
 * @param {typeof defaultDeps} deps Injectable host seams, never test-only environment switches.
 * @returns {Promise<number>} Shell-compatible exit status.
 */
export async function main(argv, deps = defaultDeps) {
	const outDir = argv[0] || "./signing";
	await deps.fs.mkdir(outDir, { recursive: true });
	const read = deps.spawnSync("bash", ["-c", PASSWORD_READER], {
		cwd: outDir,
		stdio: ["inherit", "pipe", "inherit"],
		encoding: "utf8",
	});
	const readStatus = commandStatus(read, deps);
	if (readStatus !== 0) return readStatus;
	const password = read.stdout;
	deps.output.write("\n");
	await deps.fs.writeFile(path.join(outDir, "cert.conf"), CERT_CONFIG);
	const commands = [
		[
			"req",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-keyout",
			"key.pem",
			"-out",
			"cert.pem",
			"-days",
			"3650",
			"-nodes",
			"-config",
			"cert.conf",
		],
		// Keychain cannot read OpenSSL 3's default PKCS12 MAC: retain legacy PBE and SHA1.
		[
			"pkcs12",
			"-export",
			"-out",
			"id.p12",
			"-inkey",
			"key.pem",
			"-in",
			"cert.pem",
			"-passout",
			`pass:${password}`,
			"-name",
			CN,
			"-legacy",
			"-certpbe",
			"PBE-SHA1-3DES",
			"-keypbe",
			"PBE-SHA1-3DES",
			"-macalg",
			"sha1",
		],
	];
	for (const args of commands) {
		const result = deps.spawnSync("openssl", args, { cwd: outDir, stdio: "inherit" });
		const status = commandStatus(result, deps);
		if (status !== 0) return status;
	}
	await deps.fs.rm(path.join(outDir, "cert.conf"), { force: true });
	deps.output.write(
		`\nWrote ${outDir}/{key.pem,cert.pem,id.p12}. Back these up permanently.\nSIGN_IDENTITY secret value: ${CN}\n`,
	);
	return 0;
}

/** Convert filesystem/input failures to a failing CLI status without printing password-bearing argv.
 * @param {string[]} argv CLI arguments.
 * @param {typeof defaultDeps} deps Injectable host seams.
 * @returns {Promise<number>} Exit status.
 */
export async function dispatch(argv, deps = defaultDeps) {
	try {
		return await main(argv, deps);
	} catch (error) {
		deps.error.write(`${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
}

/** Import safely under coverage; only the directly invoked module runs the CLI. */
export function isEntrypoint(argv = process.argv) {
	return Boolean(argv[1]) && realpathSync(argv[1]) === fileURLToPath(import.meta.url);
}

if (isEntrypoint()) process.exitCode = await dispatch(process.argv.slice(2));
