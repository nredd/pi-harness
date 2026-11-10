// WSL2 guests cannot see Windows host windows; empty-window failures must say so (#672).
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";

const WSL_TEXT = /Windows host windows are not reachable from the WSL2 guest.*nredd\/pi-harness#668/;

test("WSL detection reads the environment and kernel string", async () => {
	const { isWsl, wslNoWindowsHint } = await import("../src/platform/linux/wsl.ts");
	const probe = (env, version = "", interop = false) => ({ env: () => env, procVersion: () => version, hasInteropEntry: () => interop });
	assert.equal(isWsl(probe({ WSL_DISTRO_NAME: "Ubuntu" })), true);
	assert.equal(isWsl(probe({ WSL_INTEROP: "/run/WSL/1_interop" })), true);
	assert.equal(isWsl(probe({}, "Linux version 5.15.0-microsoft-standard-WSL2 (gcc)")), true);
	assert.equal(isWsl(probe({}, "Linux version 6.5.0-generic (buildd@lcy02)")), false);
	assert.equal(isWsl(probe({}, "", true)), true);
	assert.equal(isWsl(probe({}, "")), false);
	assert.match(wslNoWindowsHint(probe({ WSL_DISTRO_NAME: "Ubuntu" })) ?? "", WSL_TEXT);
	assert.equal(wslNoWindowsHint(probe({})), undefined);
});

test("Linux backend and find_roots explain empty windows under WSL2", async () => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-computer-use-wsl2-"));
	const fakeHelper = path.join(tempDir, "linux-bridge");
	await fs.writeFile(
		fakeHelper,
		`#!/usr/bin/env node
const readline = require("node:readline");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  const rootsFile = process.env.PI_TEST_WSL_ROOTS_FILE;
  const roots = rootsFile && require("node:fs").existsSync(rootsFile) ? JSON.parse(require("node:fs").readFileSync(rootsFile, "utf8")) : [];
  const result = request.cmd === "listRoots" ? { roots } : {};
  process.stdout.write(JSON.stringify({ protocolVersion: 4, id: request.id, ok: true, result }) + "\\n");
});
`,
	);
	await fs.chmod(fakeHelper, 0o755);
	process.env.PI_COMPUTER_USE_LINUX_HELPER_PATH = fakeHelper;
	const rootsFile = path.join(tempDir, "roots.json");
	process.env.PI_TEST_WSL_ROOTS_FILE = rootsFile;
	const { platformBackendForRuntime, currentPlatformBackend } = await import("../src/platform/index.ts");
	const { linuxHelper } = await import("../src/platform/linux/helper.ts");
	const { wslProbe } = await import("../src/platform/linux/wsl.ts");
	const { executeFind } = await import("../src/bridge.ts");
	const realProbe = { ...wslProbe };
	try {
		linuxHelper.installChecked = true;
		const linux = platformBackendForRuntime("linux");

		Object.assign(wslProbe, { env: () => ({ WSL_DISTRO_NAME: "Ubuntu" }), procVersion: () => "", hasInteropEntry: () => false });
		await assert.rejects(() => linux.getFrontmost(), WSL_TEXT);
		assert.match(linux.emptyRootsHint?.() ?? "", WSL_TEXT);

		// WSLg: Linux roots exist but none reports a pid. That is not a host-reachability problem.
		await fs.writeFile(rootsFile, JSON.stringify([{ title: "gedit" }]));
		await assert.rejects(
			() => linux.getFrontmost(),
			(error) => error.message === "No frontmost window was available.",
		);
		await fs.rm(rootsFile);

		// Native Linux keeps the original wording and no hint.
		Object.assign(wslProbe, { env: () => ({}), procVersion: () => "Linux version 6.5.0-generic", hasInteropEntry: () => false });
		await assert.rejects(
			() => linux.getFrontmost(),
			(error) => error.message === "No frontmost window was available.",
		);
		assert.equal(linux.emptyRootsHint?.(), undefined);

		// The shared find_roots path appends the backend hint to its empty-result text.
		const ctx = { cwd: process.cwd(), hasUI: false, ui: { notify() {} }, sessionManager: { getBranch: () => [] } };
		const find = async (params = {}) => {
			const result = await executeFind("t", params, undefined, undefined, ctx);
			return result.content.map((block) => block.text).join("\n");
		};
		Object.assign(currentPlatformBackend, {
			ensureReady: async () => ({ permissionStatus: { accessibility: true, screenRecording: true }, lastPermissionCheckAt: Date.now() }),
			listApps: async () => [],
			listRoots: async () => [],
			emptyRootsHint: () => "HINT-FROM-BACKEND",
		});
		assert.match(await find(), /No roots are currently visible to pi-computer-use\..*HINT-FROM-BACKEND/s);
		assert.match(await find({ app: "Teams" }), /No roots matched the supplied filters\..*HINT-FROM-BACKEND/s);
		currentPlatformBackend.emptyRootsHint = () => undefined;
		assert.equal(await find({ app: "Teams" }), "No roots matched the supplied filters.");
		assert.equal(await find(), "No roots are currently visible to pi-computer-use.");
		await linux.shutdown?.();
	} finally {
		delete process.env.PI_TEST_WSL_ROOTS_FILE;
		Object.assign(wslProbe, realProbe);
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});
