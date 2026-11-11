// Scriptable, protocol-faithful fake Chrome DevTools Protocol endpoint on loopback.
//
// Default behavior (unchanged): `/json/version`, one `/json/list` page, and `{}` as the result of
// every WebSocket command. Shared by the in-process lifecycle test and `fake-browser.mjs`.
//
// Scripting surface, for `cdp.ts` today and the bridge act-transaction / managed-browser suites later:
// - HTTP discovery: `/json/version`, `/json/list`; `setTargets` swaps the list,
//   `discoveryBody` breaks it, `rejectUpgrade`/`hangUpgrade` break the handshake.
// - WebSocket: RFC 6455 framing both ways (7/16/64-bit lengths, masking, fragmentation, ping/pong,
//   close handshake). Page endpoints live at `/devtools/page/<id>`, the browser endpoint at
//   `/devtools/browser/<id>` and both speak flat-session CDP (`Target.getTargets`,
//   `Target.attachToTarget`, `Target.detachFromTarget`, `sessionId` routing).
// - Commands: `handle(method, fn)`; `fn(params, ctx)` returns a result (or a promise of one), a
//   `cdpError(...)`, or `NO_REPLY` / `DISCONNECT` / `CLOSE` / `MALFORMED`. Unhandled methods answer `{}`.
// - Events: `connection.emit(method, params)` and `fake.broadcast(method, params)`.
// - Faults: `connection.close(code)`, `connection.destroy()`, `connection.sendRaw(text)`,
//   `connection.sendFrame(opcode, payload)`.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const OPCODE = { continuation: 0, text: 1, binary: 2, close: 8, ping: 9, pong: 10 };

/** Handler return value: send nothing (the client's timeout fires). */
export const NO_REPLY = Symbol("fake-cdp:no-reply");
/** Handler return value: destroy the TCP socket without a close frame. */
export const DISCONNECT = Symbol("fake-cdp:disconnect");
/** Handler return value: start a clean close handshake (code 1001). */
export const CLOSE = Symbol("fake-cdp:close");
/** Handler return value: reply with a text frame that is not JSON. */
export const MALFORMED = Symbol("fake-cdp:malformed");

/** A protocol `error` reply, `{ id, error: { code, message } }`. */
class CdpErrorReply {
	/**
	 * @param {string} message CDP error message.
	 * @param {number} code CDP error code.
	 */
	constructor(message, code) {
		this.message = message;
		this.code = code;
	}
}

/**
 * Build a protocol error reply for a handler to return.
 * @param {string} message CDP error message.
 * @param {number} [code=-32000] CDP error code.
 * @returns {CdpErrorReply} Marker the server turns into an `error` response.
 * @throws {never} Pure constructor.
 */
export function cdpError(message, code = -32000) {
	return new CdpErrorReply(message, code);
}

/**
 * Encode one unmasked server frame with the correct length form.
 * @param {string|Buffer} value Frame payload.
 * @param {number} [opcode=1] WebSocket opcode.
 * @param {boolean} [fin=true] Whether this is the final fragment.
 * @returns {Buffer} Complete frame bytes.
 * @throws {never} Any payload size is encodable.
 */
export function websocketFrame(value, opcode = OPCODE.text, fin = true) {
	const payload = Buffer.from(value);
	const first = (fin ? 0x80 : 0) | opcode;
	if (payload.length < 126) return Buffer.concat([Buffer.from([first, payload.length]), payload]);
	if (payload.length < 65536) {
		const header = Buffer.from([first, 126, 0, 0]);
		header.writeUInt16BE(payload.length, 2);
		return Buffer.concat([header, payload]);
	}
	const header = Buffer.alloc(10);
	header[0] = first;
	header[1] = 127;
	header.writeBigUInt64BE(BigInt(payload.length), 2);
	return Buffer.concat([header, payload]);
}

/**
 * Parse as many complete client frames as `buffer` holds.
 * @param {Buffer} buffer Unconsumed bytes.
 * @returns {{ frames: { fin: boolean, opcode: number, payload: Buffer }[], rest: Buffer }} Decoded frames and the incomplete tail.
 * @throws {never} Incomplete input is returned as `rest`.
 */
export function parseFrames(buffer) {
	const frames = [];
	let rest = buffer;
	while (rest.length >= 2) {
		const fin = (rest[0] & 0x80) !== 0;
		const opcode = rest[0] & 0x0f;
		const masked = (rest[1] & 0x80) !== 0;
		let length = rest[1] & 0x7f;
		let offset = 2;
		if (length === 126) {
			if (rest.length < 4) break;
			length = rest.readUInt16BE(2);
			offset = 4;
		} else if (length === 127) {
			if (rest.length < 10) break;
			length = Number(rest.readBigUInt64BE(2));
			offset = 10;
		}
		const maskLength = masked ? 4 : 0;
		if (rest.length < offset + maskLength + length) break;
		const mask = masked ? rest.subarray(offset, offset + 4) : undefined;
		offset += maskLength;
		const payload = Buffer.from(rest.subarray(offset, offset + length));
		rest = rest.subarray(offset + length);
		if (mask) for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
		frames.push({ fin, opcode, payload });
	}
	return { frames, rest };
}

/** One upgraded WebSocket as the server sees it. */
class FakeConnection {
	/**
	 * @param {import('node:net').Socket} socket Upgraded socket.
	 * @param {{ kind: "page"|"browser", targetId: string }} endpoint Path the client connected to.
	 */
	constructor(socket, endpoint) {
		this.socket = socket;
		this.kind = endpoint.kind;
		this.targetId = endpoint.targetId;
		/** Requests received on this connection, oldest first. */
		this.requests = [];
		/** Frames of any opcode received, e.g. to assert pong/close echoes. */
		this.received = [];
		/** Attached flat-session ids on this connection. */
		this.sessions = new Map();
		this.closed = false;
		socket.on("close", () => {
			this.closed = true;
		});
	}

	/**
	 * Write one raw frame.
	 * @param {number} opcode WebSocket opcode.
	 * @param {string|Buffer} [payload] Payload.
	 * @param {boolean} [fin=true] Final-fragment bit.
	 * @returns {void}
	 * @throws {never} Writes to a dead socket are ignored.
	 */
	sendFrame(opcode, payload = "", fin = true) {
		if (!this.socket.destroyed) this.socket.write(websocketFrame(payload, opcode, fin));
	}

	/**
	 * Send a text frame with arbitrary content (e.g. malformed JSON).
	 * @param {string} text Frame text.
	 * @returns {void}
	 * @throws {never} Writes to a dead socket are ignored.
	 */
	sendRaw(text) {
		this.sendFrame(OPCODE.text, text);
	}

	/**
	 * Send a JSON message.
	 * @param {object} message Message object.
	 * @returns {void}
	 * @throws {never} Writes to a dead socket are ignored.
	 */
	send(message) {
		this.sendRaw(JSON.stringify(message));
	}

	/**
	 * Push a protocol event.
	 * @param {string} method Event method, e.g. `Page.loadEventFired`.
	 * @param {object} [params] Event params.
	 * @param {string} [sessionId] Flat session the event belongs to.
	 * @returns {void}
	 * @throws {never} Writes to a dead socket are ignored.
	 */
	emit(method, params = {}, sessionId) {
		this.send(sessionId ? { method, params, sessionId } : { method, params });
	}

	/**
	 * Start a clean close handshake from the server.
	 * @param {number} [code=1001] Close status code.
	 * @returns {void}
	 * @throws {never} Writes to a dead socket are ignored.
	 */
	close(code = 1001) {
		const payload = Buffer.alloc(2);
		payload.writeUInt16BE(code);
		this.sendFrame(OPCODE.close, payload);
		this.socket.end();
	}

	/**
	 * Drop the TCP connection with no close frame.
	 * @returns {void}
	 * @throws {never} Destroying a dead socket is a no-op.
	 */
	destroy() {
		this.socket.destroy();
	}

	/**
	 * Resolve with the next request for `method` (already received counts).
	 * @param {string} method CDP method.
	 * @param {number} [timeoutMs=2000] Failure backstop.
	 * @returns {Promise<{ id: number, method: string, params: object, sessionId?: string }>} The request.
	 * @throws {Error} If no such request arrives in time.
	 */
	async waitForRequest(method, timeoutMs = 2000) {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const found = this.requests.find((request) => request.method === method);
			if (found) return found;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		throw new Error(`fake CDP never saw ${method}`);
	}
}

/**
 * @typedef {object} FakeTarget
 * @property {string} id Target id.
 * @property {string} [type] Target type, default `page`.
 * @property {string} [title] Title.
 * @property {string} [url] Page URL.
 * @property {string|null} [webSocketDebuggerUrl] Override; `null` omits the field, default is the local page endpoint.
 */

/**
 * @typedef {object} FakeCdp
 * @property {number} port Bound loopback port.
 * @property {import('node:net').Socket[]} upgraded WebSocket sockets, oldest first.
 * @property {FakeConnection[]} connections Upgraded connections, oldest first.
 * @property {{ connection: FakeConnection, method: string, params: object, sessionId?: string }[]} commands Every command, oldest first.
 * @property {number} listRequests Number of `/json/list` fetches.
 * @property {(targets: FakeTarget[]) => void} setTargets Replace the discovery list.
 * @property {(method: string, handler: Function) => void} handle Script one method; `handler(params, ctx)`.
 * @property {(method: string, params?: object) => void} broadcast Emit an event on every open connection.
 * @property {(status: number|undefined) => void} rejectUpgrade Answer the next WebSocket upgrades with this HTTP status (`undefined` stops).
 * @property {(hang: boolean) => void} hangUpgrade Never answer upgrades, so the client times out connecting.
 * @property {(body: string|undefined) => void} discoveryBody Serve this raw body (not JSON) from `/json/list`; `undefined` stops.
 * @property {(url: string) => string} url Browser/page WebSocket URL helper: `url("page/<id>")`.
 * @property {() => Promise<void>} close Destroy every connection and stop listening.
 */

/**
 * Start a fake CDP endpoint on loopback.
 * @param {{ port?: number, id?: string, title?: string, url?: string, targets?: FakeTarget[] }} [options] Port (0 picks one), the single default page, or an explicit target list.
 * @returns {Promise<FakeCdp>} The listening endpoint.
 * @throws {Error} If the port cannot be bound.
 */
export async function startFakeCdp({ port = 0, id = "fake", title = "Fake", url = "about:blank", targets } = {}) {
	const sockets = new Set();
	const upgraded = [];
	const connections = [];
	const commands = [];
	const handlers = new Map();
	let targetList = targets ?? [{ id, type: "page", title, url }];
	let boundPort = port;
	let upgradeStatus;
	let upgradeHangs = false;
	let rawDiscovery;
	let listRequests = 0;
	let nextSession = 1;

	// `path` is `page/<id>` or `browser/<id>`.
	const wsUrl = (path) => `ws://127.0.0.1:${boundPort}/devtools/${path}`;
	// Discovery entry for one target; `webSocketDebuggerUrl: null` omits the field.
	const describe = (target) => {
		const info = { id: target.id, type: target.type ?? "page", title: target.title ?? "", url: target.url ?? "about:blank" };
		if (target.webSocketDebuggerUrl !== null) info.webSocketDebuggerUrl = target.webSocketDebuggerUrl ?? wsUrl(`page/${target.id}`);
		return info;
	};

	const server = http.createServer((request, response) => {
		response.setHeader("content-type", "application/json");
		if (request.url === "/json/version") return response.end("{}");
		if (request.url === "/json/list") {
			listRequests += 1;
			if (rawDiscovery !== undefined) return response.end(rawDiscovery);
			return response.end(JSON.stringify(targetList.map(describe)));
		}
		response.statusCode = 404;
		response.end();
	});
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});

	/** Built-in flat-session `Target` domain; user handlers take precedence. */
	const builtins = {
		"Target.getTargets": () => ({ targetInfos: targetList.map((target) => ({ targetId: target.id, type: target.type ?? "page", title: target.title ?? "", url: target.url ?? "about:blank", attached: false })) }),
		"Target.attachToTarget": (params, ctx) => {
			if (!targetList.some((target) => target.id === params.targetId)) return cdpError("No target with given id found", -32602);
			const sessionId = `session-${nextSession++}`;
			ctx.connection.sessions.set(sessionId, params.targetId);
			ctx.connection.emit("Target.attachedToTarget", { sessionId, targetInfo: { targetId: params.targetId, type: "page", attached: true }, waitingForDebugger: false });
			return { sessionId };
		},
		"Target.detachFromTarget": (params, ctx) => {
			if (!ctx.connection.sessions.delete(params.sessionId)) return cdpError("No session with given id", -32602);
			ctx.connection.emit("Target.detachedFromTarget", { sessionId: params.sessionId });
			return {};
		},
	};

	/**
	 * Answer one decoded client request.
	 * @param {FakeConnection} connection Source connection.
	 * @param {{ id: number, method: string, params?: object, sessionId?: string }} request Decoded request.
	 * @returns {Promise<void>} Settles once the reply (if any) is written.
	 * @throws {never} Handler failures become protocol errors.
	 */
	const dispatch = async (connection, request) => {
		const params = request.params ?? {};
		connection.requests.push(request);
		commands.push({ connection, method: request.method, params, sessionId: request.sessionId });
		const tag = request.sessionId ? { sessionId: request.sessionId } : {};
		if (request.sessionId && !connection.sessions.has(request.sessionId)) {
			connection.send({ id: request.id, error: { code: -32001, message: "Session with given id not found." }, ...tag });
			return;
		}
		const handler = handlers.get(request.method) ?? builtins[request.method];
		let outcome = {};
		try {
			if (handler) outcome = await handler(params, { connection, request, sessionId: request.sessionId, targetId: connection.targetId });
		} catch (error) {
			outcome = cdpError(error instanceof Error ? error.message : String(error));
		}
		if (outcome === undefined) outcome = {};
		if (outcome === NO_REPLY) return;
		if (outcome === DISCONNECT) return connection.destroy();
		if (outcome === CLOSE) return connection.close();
		if (outcome === MALFORMED) return connection.sendRaw("{not json");
		if (outcome instanceof CdpErrorReply) return connection.send({ id: request.id, error: { code: outcome.code, message: outcome.message }, ...tag });
		connection.send({ id: request.id, result: outcome, ...tag });
	};

	/**
	 * Run the RFC 6455 server read loop for one connection.
	 * @param {FakeConnection} connection Upgraded connection.
	 * @returns {void}
	 * @throws {never} Socket errors are swallowed; bad client JSON is dropped like Chrome does.
	 */
	const serveWebsocket = (connection) => {
		const { socket } = connection;
		let buffer = Buffer.alloc(0);
		let fragments = [];
		socket.on("error", () => {});
		socket.on("data", (chunk) => {
			const parsed = parseFrames(Buffer.concat([buffer, chunk]));
			buffer = parsed.rest;
			for (const frame of parsed.frames) {
				connection.received.push(frame);
				if (frame.opcode === OPCODE.close) {
					socket.end(websocketFrame(frame.payload, OPCODE.close));
					continue;
				}
				if (frame.opcode === OPCODE.text || frame.opcode === OPCODE.continuation) fragments.push(frame.payload);
				else continue;
				if (!frame.fin) continue;
				const text = Buffer.concat(fragments).toString("utf8");
				fragments = [];
				try {
					void dispatch(connection, JSON.parse(text));
				} catch {
					// Chrome drops undecodable client messages; so does the fake.
				}
			}
		});
	};

	server.on("upgrade", (request, socket) => {
		socket.on("error", () => {});
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		if (upgradeHangs) return;
		if (upgradeStatus !== undefined) {
			socket.end(`HTTP/1.1 ${upgradeStatus} Rejected\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
			return;
		}
		const match = /^\/devtools\/(page|browser)\/(.+)$/.exec(request.url ?? "");
		if (!match) {
			socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
			return;
		}
		upgraded.push(socket);
		const accept = createHash("sha1").update(`${request.headers["sec-websocket-key"]}${WEBSOCKET_GUID}`).digest("base64");
		socket.write(["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Accept: ${accept}`, "", ""].join("\r\n"));
		const connection = new FakeConnection(socket, { kind: match[1], targetId: match[2] });
		connections.push(connection);
		serveWebsocket(connection);
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", resolve);
	});
	boundPort = server.address().port;
	assert(boundPort > 0, "fake CDP failed to bind");
	return {
		port: boundPort,
		upgraded,
		connections,
		commands,
		get listRequests() {
			return listRequests;
		},
		setTargets: (next) => {
			targetList = next;
		},
		handle: (method, handler) => {
			handlers.set(method, handler);
		},
		broadcast: (method, params) => {
			for (const connection of connections) if (!connection.closed) connection.emit(method, params);
		},
		rejectUpgrade: (status) => {
			upgradeStatus = status;
		},
		hangUpgrade: (hang) => {
			upgradeHangs = hang;
		},
		discoveryBody: (body) => {
			rawDiscovery = body;
		},
		url: wsUrl,
		close: async () => {
			for (const socket of sockets) socket.destroy();
			await new Promise((resolve) => server.close(resolve));
		},
	};
}
