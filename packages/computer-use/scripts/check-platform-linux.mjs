#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const INVARIANTS = ["state-scoped-observations", "bounded-observation-history", "multi-root-forest", "progressive-disclosure", "atomic-physical-input", "concurrent-requests", "transactional-batching"];
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-computer-use-linux-platform-"));
const fakeHelper = path.join(tempDir, "linux-bridge");
await fs.writeFile(fakeHelper, `#!/usr/bin/env node
const readline = require("node:readline");
const invariants = ["state-scoped-observations","bounded-observation-history","multi-root-forest","progressive-disclosure","atomic-physical-input","concurrent-requests","transactional-batching"];
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line); let result;
  if (request.cmd === "diagnostics") result = { protocolVersion: 4, architectureVersion: 1, invariants, pid: process.pid, accessibility: true };
  else if (request.cmd === "listRoots") result = { roots: [{ kind: "window", rootRef: "root:1", pid: 42, appName: "google-chrome-stable", title: "Linux fixture", framePoints: { x: 10, y: 20, w: 800, h: 600 }, isFocused: true }] };
  else if (request.cmd === "atspiReadText") result = { text: "fixture", offset: 0, limit: 7, totalChars: 7, hasMore: false };
  else if (request.cmd === "atspiWaitFor") result = { found: true };
  else if (request.cmd === "act") result = { outcome: "worked", performed: { delivery: "ax" } };
  else if (request.cmd === "actBatch") result = { outcome: "worked", performed: { transaction: true, actionCount: request.args.actions.length } };
  else if (request.cmd === "openBrowserLocation") result = { opened: true };
  else result = { focused: true };
  process.stdout.write(JSON.stringify({ protocolVersion: 4, id: request.id, ok: true, result }) + "\\n");
});
`);
await fs.chmod(fakeHelper, 0o755);
process.env.PI_COMPUTER_USE_LINUX_HELPER_PATH = fakeHelper;

try {
	const [{ platformBackendForRuntime }, { LinuxHelperClient, linuxHelper }] = await Promise.all([
		import("../src/platform/index.ts"), import("../src/platform/linux/helper.ts"),
	]);
	linuxHelper.installChecked = true;
	const linux = platformBackendForRuntime("linux");
	assert.equal(linux.name, "linux");
	for (const method of ["ensureReady", "listApps", "listRoots", "getFrontmost", "focusWindow", "observe", "act", "actBatch", "readText", "waitFor", "openBrowserLocation"]) assert.equal(typeof linux[method], "function", method);
	assert.equal(linux.isBrowserApp("firefox-esr"), true);
	assert.equal(linux.isChromeFamilyApp("google-chrome-stable.desktop"), true);
	assert.equal(linux.isBrowserApp("gnome-text-editor"), false);

	const ready = await linux.ensureReady({}, { lastPermissionCheckAt: 0 });
	assert.equal(ready.helperDiagnostics?.protocolVersion, 4);
	assert.equal((await linux.listApps())[0]?.appName, "google-chrome-stable");
	assert.equal((await linux.listRoots({ title: "fixture" }))[0]?.rootRef, "root:1");
	assert.equal((await linux.getFrontmost()).pid, 42);
	assert.equal((await linux.readText({ lookId: "look:1", elementRef: "e:1", offset: 0, limit: 7 })).text, "fixture");
	assert.equal((await linux.waitFor({ gone: false, timeoutMs: 100, text: "fixture" })).found, true);
	assert.equal((await linux.act({ lookId: "look:1", target: { ref: "e:1" }, action: "press", params: {}, policy: "background" })).outcome, "worked");
	assert.equal((await linux.actBatch([])).performed?.transaction, true);
	assert.equal(await linux.openBrowserLocation({ appName: "firefox" }, "https://example.com"), true);
	await linux.shutdown?.();

	const concurrentHelper = path.join(tempDir, "concurrent-linux-bridge");
	const installer = path.join(tempDir, "install-concurrent-helper.cjs");
	const installCount = path.join(tempDir, "install-count.txt");
	const startCount = path.join(tempDir, "start-count.txt");
	await fs.writeFile(concurrentHelper, `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
fs.appendFileSync(process.env.PI_TEST_LINUX_START_COUNT, "start\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  const result = request.cmd === "diagnostics" ? { protocolVersion: 4, architectureVersion: 1, invariants: ${JSON.stringify(INVARIANTS)} } : request.args;
  process.stdout.write(JSON.stringify({ protocolVersion: 4, id: request.id, ok: true, result }) + "\\n");
});
`);
	await fs.chmod(concurrentHelper, 0o644);
	await fs.writeFile(installer, `
const fs = require("node:fs");
fs.appendFileSync(process.env.PI_TEST_LINUX_INSTALL_COUNT, "install\\n");
setTimeout(() => fs.chmodSync(process.env.PI_COMPUTER_USE_LINUX_HELPER_PATH, 0o755), 100);
`);
	process.env.PI_TEST_LINUX_INSTALL_COUNT = installCount;
	process.env.PI_TEST_LINUX_START_COUNT = startCount;
	const concurrentClient = new LinuxHelperClient({ helperPath: concurrentHelper, setupHelperScript: installer });
	const results = await Promise.all(Array.from({ length: 24 }, (_, index) => concurrentClient.command("echo", { index })));
	assert.deepEqual(results.map((result) => result.index), Array.from({ length: 24 }, (_, index) => index));
	assert.equal((await fs.readFile(installCount, "utf8")).trim().split("\n").length, 1, "concurrent commands share one helper installation");
	assert.equal((await fs.readFile(startCount, "utf8")).trim().split("\n").length, 1, "concurrent commands share one helper process");
	concurrentClient.dispose();

	// ---- Helper acceptance, probing and replacement ----
	const lines = async (file) => (await fs.readFile(file, "utf8").catch(() => "")).split("\n").filter(Boolean);
	let caseIndex = 0;
	/** A fake helper; `startFile` records each start, `protocol`/`architecture` model a stale build. */
	const helperScript = ({ protocol = 4, architecture = 1, startFile, diagnosticsDelayMs = 0 }) => `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
fs.appendFileSync(${JSON.stringify(startFile)}, process.pid + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  const result = request.cmd === "diagnostics" ? { protocolVersion: ${protocol}, architectureVersion: ${architecture}, invariants: ${JSON.stringify(INVARIANTS)} } : request.args;
  const reply = () => process.stdout.write(JSON.stringify({ protocolVersion: ${protocol}, id: request.id, ok: true, result }) + "\\n");
  if (request.cmd === "diagnostics" && ${diagnosticsDelayMs} > 0) setTimeout(reply, ${diagnosticsDelayMs}); else reply();
});
`;
	/** Fresh case dir: helper path, counters and a setup script that installs `goodHelper` (or fails). */
	const makeCase = async ({ installs = true } = {}) => {
		const dir = path.join(tempDir, `case-${caseIndex++}`);
		await fs.mkdir(dir);
		const c = { dir, helper: path.join(dir, "linux-bridge"), starts: path.join(dir, "starts"), good: path.join(dir, "good-helper"), setupCount: path.join(dir, "setups"), envFile: path.join(dir, "env"), setup: path.join(dir, "setup.cjs") };
		await fs.writeFile(c.good, helperScript({ startFile: c.starts }));
		await fs.writeFile(c.setup, `
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(c.setupCount)}, "setup\\n");
fs.writeFileSync(${JSON.stringify(c.envFile)}, process.env.PI_COMPUTER_USE_LINUX_HELPER_PATH + " " + process.argv.slice(2).join(" "));
${installs ? `const tmp = process.env.PI_COMPUTER_USE_LINUX_HELPER_PATH + ".tmp"; fs.copyFileSync(${JSON.stringify(c.good)}, tmp); fs.chmodSync(tmp, 0o755); fs.renameSync(tmp, process.env.PI_COMPUTER_USE_LINUX_HELPER_PATH);` : `console.error("no prebuilt and PI_COMPUTER_USE_ALLOW_BUILD not set"); process.exit(1);`}
`);
		c.client = () => new LinuxHelperClient({ helperPath: c.helper, setupHelperScript: c.setup });
		return c;
	};

	{ // A compatible cached helper is accepted with NO setup, shared by concurrent commands, started once.
		const c = await makeCase({ installs: false });
		await fs.copyFile(c.good, c.helper); await fs.chmod(c.helper, 0o755);
		const client = c.client();
		const results = await Promise.all(Array.from({ length: 12 }, (_, index) => client.command("echo", { index })));
		assert.deepEqual(results.map((r) => r.index), Array.from({ length: 12 }, (_, index) => index));
		assert.equal((await lines(c.setupCount)).length, 0, "compatible cached helper must not run setup");
		assert.equal((await lines(c.starts)).length, 1, "the probed helper is the live helper");
		client.dispose();
	}

	for (const [label, writeStale] of [
		["protocol 3", (c) => fs.writeFile(c.helper, helperScript({ protocol: 3, startFile: `${c.starts}.stale` }))],
		["architecture version 2", (c) => fs.writeFile(c.helper, helperScript({ architecture: 2, startFile: `${c.starts}.stale` }))],
		["non-executable-format file (ENOEXEC)", (c) => fs.writeFile(c.helper, "\u0000\u0001not an executable\n")],
		["no file", async () => {}],
	]) { // Stale/broken/missing -> exactly one setup shared by all callers, then one re-probe and normal use.
		const c = await makeCase();
		await writeStale(c);
		if (label !== "no file") await fs.chmod(c.helper, 0o755);
		const client = c.client();
		const results = await Promise.all(Array.from({ length: 8 }, (_, index) => client.command("echo", { index })));
		assert.deepEqual(results.map((r) => r.index), Array.from({ length: 8 }, (_, index) => index), label);
		assert.equal((await lines(c.setupCount)).length, 1, `${label}: one shared setup`);
		assert.match(await fs.readFile(c.envFile, "utf8"), new RegExp(`^${c.helper.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} --platform linux --runtime$`), `${label}: setup targets the custom helper path`);
		assert.equal((await lines(c.starts)).length, 1, `${label}: only the replacement good helper started`);
		client.dispose();
	}

	{ // Stale helper and setup unavailable: actionable error naming both causes; fixing it later recovers (retry).
		const c = await makeCase({ installs: false });
		await fs.writeFile(c.helper, helperScript({ protocol: 3, startFile: c.starts })); await fs.chmod(c.helper, 0o755);
		const client = c.client();
		await assert.rejects(client.command("echo", {}), (error) => {
			assert.match(error.message, /no prebuilt and PI_COMPUTER_USE_ALLOW_BUILD not set/);
			assert.match(error.message, /Installed Linux helper .* was rejected: Linux helper protocol mismatch: expected 4, got 3\./);
			return true;
		});
		await fs.writeFile(c.setup, `require("node:fs").appendFileSync(${JSON.stringify(c.setupCount)}, "setup\\n");
const fs = require("node:fs"); fs.copyFileSync(${JSON.stringify(c.good)}, process.env.PI_COMPUTER_USE_LINUX_HELPER_PATH); fs.chmodSync(process.env.PI_COMPUTER_USE_LINUX_HELPER_PATH, 0o755);`);
		assert.equal((await client.command("echo", { ok: 1 })).ok, 1, "retry after a failed install re-probes and recovers");
		assert.equal((await lines(c.setupCount)).length, 2);
		client.dispose();
	}

	{ // Setup that "succeeds" but leaves an incompatible helper fails validation instead of looping.
		const c = await makeCase();
		await fs.writeFile(c.good, helperScript({ protocol: 3, startFile: c.starts }));
		const client = c.client();
		await assert.rejects(client.command("echo", {}), /installed at .* failed validation: Linux helper protocol mismatch: expected 4, got 3\./);
		assert.equal((await lines(c.setupCount)).length, 1, "no recursive or repeated setup within one attempt");
		client.dispose();
	}
	const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
	const settled = async (pid, timeoutMs = 2000) => {
		for (const deadline = Date.now() + timeoutMs; alive(pid) && Date.now() < deadline;) await new Promise((r) => setTimeout(r, 20));
		return !alive(pid);
	};

	{ // Replacing the helper kills the old child (no leak, no interleaved stdout) before the new one starts.
		const c = await makeCase();
		await fs.copyFile(c.good, c.helper); await fs.chmod(c.helper, 0o755);
		const client = c.client();
		await client.command("echo", {});
		const [oldPid] = (await lines(c.starts)).map(Number);
		await fs.rm(c.helper);
		assert.equal((await client.command("echo", { again: 1 })).again, 1);
		assert.equal((await lines(c.setupCount)).length, 1, "missing helper runs setup");
		assert.equal((await lines(c.starts)).length, 2, "old child plus its replacement");
		assert.equal(await settled(oldPid), true, `replaced helper ${oldPid} leaked`);
		client.dispose();
	}

	{ // A stale helper's rejection says nothing about restarting Pi: setup is about to replace it.
		const c = await makeCase({ installs: false });
		await fs.writeFile(c.helper, helperScript({ protocol: 3, startFile: c.starts })); await fs.chmod(c.helper, 0o755);
		await assert.rejects(c.client().command("echo", {}), (error) => {
			assert.doesNotMatch(error.message, /Restart Pi/);
			assert.match(error.message, /was rejected: Linux helper protocol mismatch: expected 4, got 3\./);
			return true;
		});
	}

	{ // dispose() mid-probe aborts the install: helper not classified as broken, no setup, no second start.
		const c = await makeCase();
		await fs.writeFile(c.helper, helperScript({ startFile: c.starts, diagnosticsDelayMs: 5000 })); await fs.chmod(c.helper, 0o755);
		const client = c.client();
		const command = client.command("echo", {});
		const outcome = command.then(() => "resolved", (error) => error.message);
		for (const deadline = Date.now() + 5000; (await lines(c.starts)).length === 0 && Date.now() < deadline;) await new Promise((r) => setTimeout(r, 20));
		assert.equal((await lines(c.starts)).length, 1, "probe started the helper");
		const [pid] = (await lines(c.starts)).map(Number);
		client.dispose();
		assert.match(await outcome, /closed because the Pi session ended/);
		await new Promise((r) => setTimeout(r, 300));
		assert.equal((await lines(c.setupCount)).length, 0, "dispose must not trigger setup");
		assert.equal((await lines(c.starts)).length, 1, "dispose must not start a second helper");
		assert.equal(client.child, undefined, "no child assigned after dispose");
		assert.equal(await settled(pid), true, "probe child killed by dispose");
	}
	{ // dispose() is terminal: even with a cached good install nothing spawns or assigns a child afterwards.
		const c = await makeCase({ installs: false });
		await fs.copyFile(c.good, c.helper); await fs.chmod(c.helper, 0o755);
		const client = c.client();
		await client.command("echo", {});
		const [pid] = (await lines(c.starts)).map(Number);
		client.dispose();
		assert.equal(await settled(pid), true);
		await assert.rejects(client.command("echo", {}), /closed because the Pi session ended/);
		await assert.rejects(client.ensureInstalled(), /closed because the Pi session ended/);
		await assert.rejects(client.install(), /closed because the Pi session ended/);
		await assert.rejects(client.probe(), /closed because the Pi session ended/);
		await assert.rejects(client.startProcess(), /closed because the Pi session ended/);
		assert.equal((await lines(c.starts)).length, 1, "no helper started after dispose");
		assert.equal(client.child, undefined, "no child assigned after dispose");
	}

	{ // dispose() drops the shared install promise so nothing can join an old-generation install.
		const c = await makeCase();
		await fs.writeFile(c.setup, "setInterval(() => {}, 1000);\n"); // setup hangs
		const client = c.client();
		const waiter = client.command("echo", {}).then(() => "resolved", (error) => error.message);
		for (const deadline = Date.now() + 5000; !client.installPromise && Date.now() < deadline;) await new Promise((r) => setTimeout(r, 10));
		assert.ok(client.installPromise, "install in flight");
		client.dispose();
		assert.equal(client.installPromise, undefined, "dispose must drop the shared install promise");
		assert.match(await waiter, /closed because the Pi session ended|aborted/);
	}

	{ // Session shutdown replaces the shared client so the next session gets a live one.
		const { linuxHelper: before, resetLinuxHelper } = await import("../src/platform/linux/helper.ts");
		resetLinuxHelper();
		const { linuxHelper: after } = await import("../src/platform/linux/helper.ts");
		assert.notEqual(after, before);
		await assert.rejects(before.ensureInstalled(), /closed because the Pi session ended/);
	}
	delete process.env.PI_TEST_LINUX_INSTALL_COUNT;
	delete process.env.PI_TEST_LINUX_START_COUNT;
	console.log("Linux platform checks passed");
} finally {
	await fs.rm(tempDir, { recursive: true, force: true });
}
