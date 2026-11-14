// MIT-derived signing script port: all external commands are injected fakes, never real signing.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test, vi } from "vitest";
import {
	CERT_CONFIG,
	commandStatus,
	defaultDeps,
	dispatch,
	isEntrypoint,
	main,
	PASSWORD_READER,
} from "../scripts/make-signing-cert.mjs";

const scratch = [];
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(scratch.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

/** Disposable real files, no OpenSSL or credential prompts; every argv is recorded. */
async function fixture(failureAt = -1, failure = { status: 9 }) {
	const base = await fs.mkdtemp(path.join(os.tmpdir(), "cu-cert-"));
	scratch.push(base);
	const out = path.join(base, "dir with spaces");
	const calls = [];
	const messages = [];
	const errors = [];
	const deps = {
		fs,
		output: { write: (text) => messages.push(text) },
		error: { write: (text) => errors.push(text) },
		spawnSync(command, args, options) {
			calls.push({ command, args, options });
			if (calls.length === failureAt) return failure;
			if (command === "bash") return { status: 0, stdout: 'fake \\ password $ ; "' };
			assert.equal(command, "openssl");
			assert.equal(options.cwd, out);
			assert.equal(options.stdio, "inherit");
			for (const file of args[0] === "req" ? ["key.pem", "cert.pem"] : ["id.p12"]) {
				writeFileSync(path.join(out, file), `fake ${file}`);
			}
			return { status: 0 };
		},
	};
	return { base, out, calls, deps, messages, errors };
}

test("preserves signing configuration, command order, legacy flags and backup message", async () => {
	const host = await fixture();
	const config = [];
	host.deps.spawnSync = ((fake) => (command, args, options) => {
		if (command === "openssl") config.push(readFileSync(path.join(host.out, "cert.conf"), "utf8"));
		return fake(command, args, options);
	})(host.deps.spawnSync);
	assert.equal(await dispatch([host.out, "ignored"], host.deps), 0);
	assert.deepEqual(config, [CERT_CONFIG, CERT_CONFIG]);
	assert.match(CERT_CONFIG, /CN = pi-computer-use Self Signed\n/);
	assert.match(
		CERT_CONFIG,
		/keyUsage = critical, digitalSignature\nextendedKeyUsage = critical, codeSigning\nbasicConstraints = critical, CA:false/,
	);
	assert.deepEqual(host.calls[0], {
		command: "bash",
		args: ["-c", PASSWORD_READER],
		options: { cwd: host.out, stdio: ["inherit", "pipe", "inherit"], encoding: "utf8" },
	});
	assert.equal(
		PASSWORD_READER,
		'set -e; read -r -s -p "Password for the exported .p12: " P12_PASS; printf "%s" "$P12_PASS"',
	);
	assert.deepEqual(host.calls[1].args, [
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
	]);
	assert.deepEqual(host.calls[2].args, [
		"pkcs12",
		"-export",
		"-out",
		"id.p12",
		"-inkey",
		"key.pem",
		"-in",
		"cert.pem",
		"-passout",
		'pass:fake \\ password $ ; "',
		"-name",
		"pi-computer-use Self Signed",
		"-legacy",
		"-certpbe",
		"PBE-SHA1-3DES",
		"-keypbe",
		"PBE-SHA1-3DES",
		"-macalg",
		"sha1",
	]);
	await assert.rejects(fs.stat(path.join(host.out, "cert.conf")), { code: "ENOENT" });
	assert.equal(
		host.messages.join(""),
		`\n\nWrote ${host.out}/{key.pem,cert.pem,id.p12}. Back these up permanently.\nSIGN_IDENTITY secret value: pi-computer-use Self Signed\n`,
	);
	assert.deepEqual(host.errors, []);
	for (const file of ["key.pem", "cert.pem", "id.p12"]) {
		assert.equal(await fs.readFile(path.join(host.out, file), "utf8"), `fake ${file}`);
	}
});

test("compatibility launcher forwards quoted arguments and the Node exit code through a fake executable", async () => {
	const host = await fixture();
	const fakeNode = path.join(host.base, "node");
	await fs.writeFile(fakeNode, '#!/bin/sh\nprintf "%s\\n" "$@"\nexit 23\n', { mode: 0o700 });
	const launcher = fileURLToPath(new URL("../scripts/make-signing-cert.sh", import.meta.url));
	const result = spawnSync("bash", [launcher, host.out, "extra argument"], {
		encoding: "utf8",
		env: { ...process.env, PATH: `${host.base}${path.delimiter}${process.env.PATH}` },
	});
	assert.ifError(result.error);
	assert.equal(result.status, 23);
	assert.equal(result.stdout, `${path.dirname(launcher)}/make-signing-cert.mjs\n${host.out}\nextra argument\n`);
	assert.equal(result.stderr, "");
});

for (const [label, failure, expected] of [
	["EOF", { status: 1 }, 1],
	["missing executable", { error: { code: "ENOENT" } }, 127],
	["nonexecutable", { error: { code: "EACCES" } }, 126],
	["interrupt", { signal: "SIGINT" }, 130],
	["termination", { signal: "SIGTERM" }, 143],
	["command refusal", { status: 17 }, 17],
]) {
	for (const step of [1, 2, 3]) {
		test(`${label} at step ${step} stops subsequent commands and retains diagnostic config`, async () => {
			const host = await fixture(step, failure);
			assert.equal(await dispatch([host.out], host.deps), expected);
			assert.equal(host.calls.length, step);
			if (step === 1) await assert.rejects(fs.stat(path.join(host.out, "cert.conf")), { code: "ENOENT" });
			else assert.equal(await fs.readFile(path.join(host.out, "cert.conf"), "utf8"), CERT_CONFIG);
			assert.ok(!host.messages.join("").includes("Wrote"));
			assert.ok(!host.errors.join("").includes("password"));
		});
	}
}

test("an output path occupied by a regular file fails before any command or prompt", async () => {
	const host = await fixture();
	await fs.writeFile(host.out, "occupied");
	assert.equal(await dispatch([host.out], host.deps), 1);
	assert.equal(host.calls.length, 0);
	assert.equal(await fs.readFile(host.out, "utf8"), "occupied");
	assert.match(host.errors.join(""), /EEXIST/);
});

test("filesystem refusals fail closed before later commands or success output", async () => {
	for (const operation of ["mkdir", "writeFile", "rm"]) {
		const host = await fixture();
		host.deps.fs = {
			...fs,
			[operation]: async () => {
				throw new Error(`refused ${operation}`);
			},
		};
		assert.equal(await dispatch([host.out], host.deps), 1);
		assert.equal(host.calls.length, { mkdir: 0, writeFile: 1, rm: 3 }[operation]);
		assert.deepEqual(host.errors, [`refused ${operation}\n`]);
		assert.ok(!host.messages.join("").includes("Wrote"));
	}
});

test("default output directory and empty argument preserve the shell default", async () => {
	for (const args of [[], [""]]) {
		const host = await fixture(1, { status: 1 });
		const dirs = [];
		host.deps.fs = { ...fs, mkdir: async (...values) => dirs.push(values) };
		assert.equal(await main(args, host.deps), 1);
		assert.deepEqual(dirs, [["./signing", { recursive: true }]]);
	}
});

test("entrypoint and default host seams are real and safe to import", async () => {
	const script = fileURLToPath(new URL("../scripts/make-signing-cert.mjs", import.meta.url));
	assert.equal(isEntrypoint([]), false);
	assert.equal(isEntrypoint(["node", script]), true);
	assert.equal(isEntrypoint(["node", fileURLToPath(import.meta.url)]), false);
	const host = await fixture();
	const link = path.join(host.base, "linked-cert.mjs");
	await fs.symlink(script, link);
	assert.equal(isEntrypoint(["node", link]), true);
	assert.equal(isEntrypoint(), false);
	assert.equal(defaultDeps.fs, fs);
	assert.equal(defaultDeps.spawnSync, spawnSync);
	assert.equal(defaultDeps.output, process.stdout);
	assert.equal(defaultDeps.error, process.stderr);
	assert.equal(commandStatus({ status: 0 }, defaultDeps), 0);
	assert.equal(commandStatus({ status: null }, defaultDeps), 1);
	const mkdir = vi.spyOn(fs, "mkdir").mockRejectedValue(new Error("fixture refusal"));
	const error = vi.spyOn(process.stderr, "write").mockReturnValue(true);
	assert.equal(await main([]).catch((failure) => failure.message), "fixture refusal");
	assert.equal(await dispatch([]), 1);
	const argv = process.argv;
	const exitCode = process.exitCode;
	try {
		process.argv = ["node", script];
		vi.resetModules();
		await import("../scripts/make-signing-cert.mjs");
		assert.equal(process.exitCode, 1);
		assert.equal(mkdir.mock.calls.length, 3);
		assert.equal(error.mock.calls.length, 2);
		mkdir.mockRejectedValueOnce("non-Error refusal");
		assert.equal(await dispatch([]), 1);
		assert.equal(error.mock.calls.at(-1)[0], "non-Error refusal\n");
	} finally {
		process.argv = argv;
		process.exitCode = exitCode;
	}
});
