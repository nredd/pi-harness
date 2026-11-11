// Scriptable fake of the native computer-use helper's NDJSON protocol, for client tests with no real helper.
//
// One protocol engine, two transports:
//   - `startFakeHelper`: a unix-socket server (macOS daemon, `PI_CU_SOCKET_PATH`).
//   - `createFakeChild`: a ChildProcess-like with `stdin`/`stdout`/`stderr` streams (Windows and Linux
//     helpers speak the same lines over stdio) plus `createFakeSpawn` to route `spawn(command, args)`.
//
// Wire profiles (`profile`):
//   - "flat" (macOS): request `{id, cmd, ...args}`, reply `{id, ok, result}` or `{id, ok:false, error:{message, code}}`.
//   - "envelope" (Windows/Linux): request `{protocolVersion, id, cmd, args}`, every reply also carries `protocolVersion`.
// A new command needs no change here: register `handlers[cmd]`. Unscripted commands get `fail("unknown command")`.
//
// A handler is an action, a function `(request, context) => action | Promise<action>`, or an array of
// those consumed one per call (the last entry sticks). Actions come from the constructors below.
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

/** Success reply carrying `result`. */
export const ok = (result = {}) => ({ kind: "reply", body: { ok: true, result } });
/** Error reply with `message` and optional `code` (e.g. `"permission_denied"`). */
export const fail = (message, code) => ({ kind: "reply", body: { ok: false, error: code === undefined ? { message } : { message, code } } });
/** Reply with an arbitrary extra body, e.g. a missing `ok` or a bare `{ ok: false }`. */
export const body = (value) => ({ kind: "reply", body: value });
/** Write `text` verbatim (add your own newline). */
export const raw = (text) => ({ kind: "raw", text });
/** A line that is not JSON. */
export const malformed = () => raw("{not json\n");
/** Deliver `action` in `parts` TCP/stream chunks, `gapMs` apart: split frames. */
export const split = (action, parts = 2, gapMs = 5) => ({ kind: "split", action, parts, gapMs });
/** Delay `action` by `ms`. */
export const slow = (ms, action = ok()) => ({ kind: "slow", ms, action });
/** Close the connection without replying: disconnect mid-request. */
export const drop = () => ({ kind: "drop" });
/** Never reply. */
export const silent = () => ({ kind: "silent" });
/** Envelope profile only: reply with a different `protocolVersion` than the server's. */
export const withProtocol = (protocolVersion, action = ok()) => ({ kind: "protocol", protocolVersion, action });
/** Run `fn` (e.g. flip a flag, stop the server), then deliver `action`. */
export const effect = (fn, action = ok()) => ({ kind: "effect", fn, action });

/** Default `diagnostics` result for `protocolVersion`; override any field via `diagnostics`. */
export function defaultDiagnostics(protocolVersion, overrides = {}) {
	return {
		protocolVersion,
		architectureVersion: 1,
		invariants: ["fake"],
		pid: process.pid,
		accessibility: true,
		screenRecording: true,
		...overrides,
	};
}

/**
 * Protocol engine, transport-free. `handleLine(line, io)` parses one request line and plays the scripted
 * action through `io = { write(text), end(), sleep(ms) }`. `requests` records every parsed request.
 */
export function createHelperEngine({ profile = "flat", protocolVersion = 7, handlers = {}, diagnostics = {} } = {}) {
	const queues = new Map();
	const engine = {
		profile,
		protocolVersion,
		diagnostics: { ...diagnostics },
		requests: [],
		handlers: { ...handlers },
		/** Replace (or add) the script for `cmd`. */
		script(cmd, handler) {
			engine.handlers[cmd] = handler;
			queues.delete(cmd);
		},
		async handleLine(line, io) {
			let request;
			try {
				request = JSON.parse(line);
			} catch {
				await play(fail("invalid json"), io, undefined);
				return;
			}
			const args = profile === "envelope" ? (request.args ?? {}) : omit(request, ["id", "cmd"]);
			const parsed = { id: request.id, cmd: request.cmd, args, raw: request };
			engine.requests.push(parsed);
			await play(await resolve(parsed), io, parsed.id);
		},
	};

	async function resolve(request) {
		let handler = engine.handlers[request.cmd];
		if (handler === undefined) {
			if (request.cmd === "diagnostics") return ok(defaultDiagnostics(protocolVersion, engine.diagnostics));
			if (request.cmd === "shutdown") return ok({});
			return fail(`unknown command: ${request.cmd}`, "unknown_command");
		}
		if (Array.isArray(handler)) {
			const index = queues.get(request.cmd) ?? 0;
			queues.set(request.cmd, index + 1);
			handler = handler[Math.min(index, handler.length - 1)];
		}
		return typeof handler === "function" ? await handler(request, engine) : handler;
	}

	function encode(action, id, version) {
		const base = { id, ...action.body };
		return `${JSON.stringify(profile === "envelope" ? { protocolVersion: version, ...base } : base)}\n`;
	}

	async function play(action, io, id, version = protocolVersion) {
		switch (action.kind) {
			case "reply":
				io.write(encode(action, id, version));
				return;
			case "raw":
				io.write(action.text);
				return;
			case "split": {
				const inner = action.action.kind === "reply" ? encode(action.action, id, version) : action.action.text;
				const size = Math.ceil(inner.length / action.parts);
				for (let offset = 0; offset < inner.length; offset += size) {
					io.write(inner.slice(offset, offset + size));
					if (offset + size < inner.length) await io.sleep(action.gapMs);
				}
				return;
			}
			case "slow":
				await io.sleep(action.ms);
				await play(action.action, io, id, version);
				return;
			case "drop":
				io.end();
				return;
			case "silent":
				return;
			case "protocol":
				await play(action.action, io, id, action.protocolVersion);
				return;
			case "effect":
				await action.fn(engine);
				await play(action.action, io, id, version);
				return;
			default:
				throw new Error(`fake-helper: unknown action kind ${action.kind}`);
		}
	}

	return engine;
}

function omit(value, keys) {
	return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Attach the engine to a duplex-ish `{on("data"), write, end}` byte stream, framing by newline. */
function serveStream(engine, input, io) {
	let buffer = "";
	input.setEncoding?.("utf8");
	input.on("data", (chunk) => {
		buffer += chunk;
		for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			if (line) void engine.handleLine(line, { ...io, sleep: delay });
		}
	});
}

/**
 * Short, unique unix socket path (macOS `sun_path` is 104 bytes). Returns `{ socketPath, dispose }`;
 * `dispose` removes the directory.
 */
export function shortSocketPath(name = "h.sock") {
	const dir = mkdtempSync(path.join(os.tmpdir(), "fh-"));
	return { socketPath: path.join(dir, name), dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Unix-socket fake. `stop()` closes the listener and every connection (daemon down); `start()` brings
 * it back up on the same path (daemon relaunched). Options are those of `createHelperEngine`.
 */
export async function startFakeHelper({ socketPath, ...engineOptions }) {
	const engine = createHelperEngine(engineOptions);
	const sockets = new Set();
	let server;
	let connections = 0;

	const fake = {
		engine,
		socketPath,
		get connections() {
			return connections;
		},
		get requests() {
			return engine.requests;
		},
		script: engine.script,
		get diagnostics() {
			return engine.diagnostics;
		},
		/** Destroy open connections but keep listening: the helper crashed and a client reconnects. */
		disconnectAll() {
			for (const socket of sockets) socket.destroy();
		},
		async start() {
			server = net.createServer((socket) => {
				connections += 1;
				sockets.add(socket);
				socket.on("close", () => sockets.delete(socket));
				socket.on("error", () => socket.destroy());
				serveStream(engine, socket, {
					write: (text) => {
						if (!socket.destroyed) socket.write(text);
					},
					end: () => socket.destroy(),
				});
			});
			await new Promise((resolve, reject) => {
				server.once("error", reject);
				server.listen(socketPath, resolve);
			});
		},
		async stop() {
			fake.disconnectAll();
			const closing = server;
			server = undefined;
			if (closing) await new Promise((resolve) => closing.close(resolve));
		},
	};
	await fake.start();
	return fake;
}

/**
 * ChildProcess-like for `spawn` doubles. `stdout`/`stderr` emit what you push; `stdin` is a sink that
 * the optional `engine` answers on `stdout` (the Windows/Linux stdio helpers). Emits `spawn` on the next
 * tick. Control: `child.exit(code)`, `child.fail(error)`, `child.killed`/`child.signals`.
 */
export function createFakeChild({ engine, stdout = "", stderr = "", exitCode, spawnError, hang = false } = {}) {
	const child = new EventEmitter();
	child.stdin = new PassThrough();
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	child.signals = [];
	child.killed = false;
	child.exit = (code = 0) => {
		child.stdout.end();
		child.stderr.end();
		child.emit("close", code, null);
	};
	child.fail = (error) => child.emit("error", error);
	child.kill = (signal = "SIGTERM") => {
		child.killed = true;
		child.signals.push(signal);
		return true;
	};
	if (engine) {
		serveStream(engine, child.stdin, {
			write: (text) => child.stdout.write(text),
			end: () => child.exit(1),
		});
	}
	queueMicrotask(() => {
		if (spawnError) {
			child.fail(spawnError);
			return;
		}
		child.emit("spawn");
		if (stdout) child.stdout.write(stdout);
		if (stderr) child.stderr.write(stderr);
		if (!hang && exitCode !== undefined) setImmediate(() => child.exit(exitCode));
	});
	return child;
}

/**
 * `spawn` double. `routes` maps a command basename (or `"*"`) to a child options object or a function
 * `(command, args, options) => child options | ChildProcess-like`. Records calls in `spawn.calls`.
 */
export function createFakeSpawn(routes = {}) {
	const calls = [];
	const spawn = (command, args = [], options = {}) => {
		calls.push({ command, args, options });
		const route = routes[path.basename(command)] ?? routes["*"];
		if (route === undefined) throw new Error(`fake-helper: unrouted spawn ${command}`);
		const made = typeof route === "function" ? route(command, args, options) : route;
		return typeof made?.on === "function" ? made : createFakeChild(made);
	};
	spawn.calls = calls;
	return spawn;
}
