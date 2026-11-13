import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { truncateSync } from "node:fs";
import { chmod, mkdtemp, rm, symlink, writeFile, mkdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, vi } from "vitest";
import { WslHelperClient, wslHostHelperConfig } from "../src/platform/linux/wsl-helper.ts";
import { wslProbe } from "../src/platform/linux/wsl.ts";
import { platformBackendForRuntime } from "../src/platform/index.ts";
import { createWindowsBackend } from "../src/platform/windows/backend.ts";

// Re-enter Node for the synthetic fixture on every OS. Verify the production argv before substituting it.
vi.mock("node:child_process", async (original) => {
 const actual = await original();
 return { ...actual, spawn(command, args, options) {
  assert.deepEqual(args, []);
  assert.equal(options.shell, false);
  return actual.spawn(process.execPath, [command], options);
 } };
});

// Real synthetic subprocess, never a PE executable, WSL interop or a native desktop adapter.
const fixture = `#!${process.execPath}
const readline = require('node:readline');
const fs = require('node:fs');
readline.createInterface({ input: process.stdin }).on('line', async (line) => {
 const r = JSON.parse(line);
 if (r.cmd === 'hang') return;
 if (r.cmd === 'stderr') process.stderr.write('synthetic diagnostic');
 if (r.cmd === 'keepalive') setInterval(() => {}, 1000);
 if (r.cmd === 'exit') return process.exit(0);
 if (r.cmd === 'invalid') return process.stdout.write('not-json\\n');
 if (r.cmd === 'overflow') return process.stdout.write('x'.repeat(8 * 1024 * 1024 + 1));
 if (r.cmd === 'delay') await new Promise(resolve => setTimeout(resolve, 80));
 const reply = { protocolVersion: 4, id: r.id, ok: true, result: { pid: process.pid, cmd: r.cmd, args: r.args } };
 if (r.cmd === 'wrongId') reply.id = 'foreign';
 if (r.cmd === 'wrongVersion') reply.protocolVersion = 3;
 if (r.cmd === 'error') { reply.ok = false; reply.error = { code: 'fixture_refusal', message: 'private app title' }; }
 if (r.cmd === 'errorNoCode') reply.ok = false;
 const wire = JSON.stringify(reply) + '\\n';
 if (r.cmd === 'split') { process.stdout.write(wire.slice(0, 12)); setTimeout(() => process.stdout.write(wire.slice(12)), 5); }
 else if (r.cmd === 'extra') process.stdout.write(wire + wire);
 else if (r.cmd === 'replyExit') process.stdout.write(wire, () => process.exit(0));
 else process.stdout.write(wire);
});
`;

async function withClient(work) {
 const root = await mkdtemp(path.join(os.tmpdir(), "wsl-host-fixture-"));
 const helper = path.join(root, "fixture.exe");
 await writeFile(helper, fixture, { mode: 0o700 });
 const config = { path: helper, sha256: createHash("sha256").update(fixture).digest("hex"), lock: path.join(root, "input-lock") };
 const client = new WslHelperClient(config);
 try { await work(client, config); }
 finally { client.dispose(); await rm(root, { recursive: true, force: true }); }
}

test("WSL host opt-in validates explicit identity and refuses CI without enabling interop", () => {
 const saved = { ...wslProbe };
 let env = {};
 Object.assign(wslProbe, { env: () => env, hasInteropEntry: () => false, procVersion: () => "Linux" });
 try {
  assert.equal(wslHostHelperConfig(), undefined);
  assert.equal(platformBackendForRuntime("linux").name, "linux");
  env = { PI_COMPUTER_USE_WSL_HOST: "1" };
  assert.throws(() => wslHostHelperConfig(), /interactive WSL/);
  env.WSL_DISTRO_NAME = "Synthetic";
  assert.throws(() => wslHostHelperConfig(), /HOST_HELPER/);
  for (const bad of ["bridge.exe", "/tmp/bridge.exe", "/mnt/c/../bridge.exe", "/mnt/c/./bridge.exe", "/mnt/c//bridge.exe", "/mnt/c/bridge.exe\n", "/mnt/c/bridge.ps1"]) {
   env.PI_COMPUTER_USE_WSL_HOST_HELPER = bad;
   assert.throws(() => wslHostHelperConfig(), /HOST_HELPER/);
  }
  env.PI_COMPUTER_USE_WSL_HOST_HELPER = "/mnt/c/Fixture/bridge.exe";
  assert.throws(() => wslHostHelperConfig(), /SHA256/);
  env.PI_COMPUTER_USE_WSL_HOST_SHA256 = "A".repeat(64);
  assert.throws(() => wslHostHelperConfig(), /HOST_LOCK/);
  env.PI_COMPUTER_USE_WSL_HOST_LOCK = "/mnt/c/Fixture/input-lock";
  assert.equal(wslHostHelperConfig().sha256, "a".repeat(64));
  assert.equal(platformBackendForRuntime("linux").name, "windows");
  env.CI = "1";
  assert.throws(() => platformBackendForRuntime("linux"), /never a CI runner/);
 } finally { Object.assign(wslProbe, saved); }
});

test("WSL transport reuses one process, frames split replies and preserves Windows DPI coordinates", async () => {
 await withClient(async (client, config) => {
  const first = await client.command("split", { x: -1920, y: -100, scaleFactor: 1.5 });
  const second = await client.command("stderr");
  assert.equal(first.pid, second.pid);
  assert.deepEqual(first.args, { x: -1920, y: -100, scaleFactor: 1.5 });
  await assert.rejects(stat(config.lock), { code: "ENOENT" });
  await assert.rejects(client.command("error"), (e) => e.code === "fixture_refusal" && !e.message.includes("private app title"));
  assert.equal((await client.command("echo")).pid, first.pid);
  await assert.rejects(client.command("errorNoCode"), (e) => e.code === undefined);
 });
});

test("two WSL sessions queue on one lease, including complete actBatch requests", async () => {
 await withClient(async (first, config) => {
  const second = new WslHelperClient(config);
  try {
   const order = [];
   const start = first.command("delay").then(() => order.push("first"));
   await vi.waitFor(async () => assert.ok((await stat(config.lock)).isDirectory()));
   await Promise.all([
    start,
    second.command("actBatch", { actions: [{ action: "click" }, { action: "typeText" }] }).then((r) => { order.push("second"); assert.equal(r.args.actions.length, 2); }),
   ]);
   assert.deepEqual(order, ["first", "second"]);
  } finally { second.dispose(); }
 });
});

test("WSL provenance refuses changed, linked and nonexecutable helpers before spawning", async () => {
 await withClient(async (client, config) => {
  const abort = AbortSignal.abort();
  await assert.rejects(client.ensureInstalled(abort), /aborted/);
  await writeFile(config.path, `${fixture}\n// changed`);
  await assert.rejects(client.command("echo"), /SHA-256 mismatch/);
  await writeFile(config.path, fixture);
  if (process.platform !== "win32") {
   await chmod(config.path, 0o600);
   await assert.rejects(client.command("echo"), /EACCES/);
   await chmod(config.path, 0o700);
   const link = `${config.path}.link`;
   await symlink(config.path, link);
   const linked = new WslHelperClient({ ...config, path: link });
   try { await assert.rejects(linked.ensureInstalled(), /without symlinks/); }
   finally { linked.dispose(); }
  }
  const directory = `${config.path}.dir`;
  await mkdir(directory);
  const invalid = new WslHelperClient({ ...config, path: directory });
  try { await assert.rejects(invalid.ensureInstalled(), /regular file/); }
  finally { invalid.dispose(); }
 });
});

test("WSL bounds requests and deadlines before execution", async () => {
 await withClient(async (client, config) => {
  for (const timeoutMs of [0, -1, NaN, Infinity, 30001]) await assert.rejects(client.command("echo", {}, { timeoutMs }), /between 1 and 30000/);
  await assert.rejects(client.command("echo", { text: "x".repeat(1024 * 1024) }), /request exceeded/);
  await assert.rejects(client.command("echo", {}, { signal: AbortSignal.abort() }), /aborted/);
  await mkdir(config.lock);
  await assert.rejects(client.command("echo", {}, { timeoutMs: 50 }), /abort/i);
  assert.ok((await stat(config.lock)).isDirectory());
  await rm(config.lock, { recursive: true });
  assert.equal((await client.command("echo")).cmd, "echo");
 });
});

for (const command of ["hang", "exit", "invalid", "wrongId", "wrongVersion", "extra", "overflow"]) {
 test(`WSL retains the lease and closes permanently after uncertain ${command}`, async () => {
  await withClient(async (client, config) => {
   await assert.rejects(client.command(command, {}, { timeoutMs: command === "hang" ? 150 : 3000 }));
   assert.ok((await stat(config.lock)).isDirectory());
   await assert.rejects(client.command("echo"), /closed/);
  });
 });
}

test("WSL abort after send retains the lease; queue overflow cannot deliver work", async () => {
 await withClient(async (client, config) => {
  // An acknowledged echo proves the process is running before the abort case.
  await client.command("echo");
  const controller = new AbortController();
  const pending = client.command("hang", {}, { signal: controller.signal });
  // Wait for acquisition, not an assumed host startup delay.
  for (let attempt = 0; attempt < 100; attempt++) {
   if (await stat(config.lock).then(() => true, () => false)) break;
   await new Promise(resolve => setTimeout(resolve, 5));
  }
  // The client has acquired the lock, then resumed into its send microtask.
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, /retained/);
  assert.ok((await stat(config.lock)).isDirectory());
 });
 await withClient(async (client, config) => {
  await mkdir(config.lock);
  const controller = new AbortController();
  const queued = Array.from({ length: 32 }, () => client.command("echo", {}, { signal: controller.signal }).catch(e => e));
  await assert.rejects(client.command("echo"), /queue is full/);
  controller.abort();
  assert.equal((await Promise.all(queued)).length, 32);
 });
});

test("WSL closes clean idle children, escalates unreaped children and retains failed-write leases", async () => {
 await withClient(async (client) => {
  await client.command("replyExit");
  await vi.waitFor(() => assert.equal(client.child, undefined));
  assert.equal((await client.command("echo")).cmd, "echo");
  await client.command("keepalive");
  const child = client.child;
  const realKill = child.kill.bind(child);
  const kill = vi.spyOn(child, "kill").mockImplementation(signal => signal === "SIGTERM" ? true : realKill(signal));
  const closed = new Promise(resolve => child.once("close", resolve));
  client.dispose();
  await closed;
  assert.deepEqual(kill.mock.calls.map(([signal]) => signal), ["SIGTERM", "SIGKILL"]);
 });
 await withClient(async (client, config) => {
  await client.command("echo");
  vi.spyOn(client.child.stdin, "write").mockImplementation((_frame, callback) => { callback(new Error("synthetic write refusal")); return false; });
  await assert.rejects(client.command("echo"), /synthetic write refusal/);
  assert.ok((await stat(config.lock)).isDirectory());
 });
});

test("WSL caps changing executable reads and surfaces lease filesystem failures", async () => {
 await withClient(async (client, config) => {
  const check = client.check.bind(client);
  let checking = 0;
  const seam = vi.spyOn(client, "check").mockImplementation(signal => {
   check(signal);
   if (++checking === 2) truncateSync(config.path, 65 * 1024 * 1024);
  });
  await assert.rejects(client.ensureInstalled(), /exceeded 64MiB/);
  seam.mockRestore();
  await assert.rejects(client.ensureInstalled(), /at most 64MiB/);
  await writeFile(config.path, fixture);
  const invalid = new WslHelperClient({ ...config, lock: path.join(config.path, "missing", "lease") });
  try { await assert.rejects(invalid.command("echo"), /ENOTDIR|ENOENT/); }
  finally { invalid.dispose(); }
 });
});

test("Windows backend factory delegates bounded UIA and physical batches without Linux coordinate conversion", async () => {
 const calls = [];
 const backend = createWindowsBackend({
  ensureInstalled: async () => {}, dispose() {},
  command: async (cmd, args, options) => { calls.push({ cmd, args, options }); return { roots: [] }; },
 });
 await backend.listRoots({});
 await backend.actBatch([{ action: "click", target: { pid: 7 }, params: { x: -900, y: 200 } }], { timeoutMs: 100 });
 await backend.readText({ ref: "@e1", stateId: "synthetic" }, { timeoutMs: 200 });
 await backend.waitFor({ text: "fixture", stateId: "synthetic" }, { timeoutMs: 300 });
 assert.equal(calls[0].cmd, "listRoots");
 assert.equal(calls[1].cmd, "actBatch");
 assert.deepEqual(calls[1].args.actions[0].params, { x: -900, y: 200 });
 assert.equal(calls[2].cmd, "uiaReadText");
 assert.equal(calls[3].options.timeoutMs, 300);
});
