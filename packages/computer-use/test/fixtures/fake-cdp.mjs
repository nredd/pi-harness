// Smallest CDP endpoint the bridge reads: `/json/version`, one `/json/list` page, and `{}` as the
// result of every WebSocket command. Shared by the in-process lifecycle test and `fake-browser.mjs`.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/**
 * Encode a small unmasked server frame.
 * @param {string|Buffer} value Frame payload.
 * @param {number} [opcode=1] WebSocket opcode.
 * @returns {Buffer} Complete frame bytes.
 * @throws {import('node:assert').AssertionError} If the payload exceeds the small-frame limit.
 */
function websocketFrame(value, opcode = 1) {
	const payload = Buffer.from(value);
	assert(payload.length < 126, "fake CDP frame unexpectedly large");
	return Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload]);
}

/**
 * Answer every CDP command on an upgraded socket with an empty result, and echo a close frame.
 * @param {import('node:net').Socket} socket Owned upgraded connection.
 * @returns {void}
 * @throws {Error} Malformed frames/JSON throw from the registered data callback.
 */
function serveWebsocket(socket) {
	let buffer = Buffer.alloc(0);
	socket.on("error", () => {});
	socket.on("data", (chunk) => {
		buffer = Buffer.concat([buffer, chunk]);
		while (buffer.length >= 2) {
			const opcode = buffer[0] & 0x0f;
			const masked = (buffer[1] & 0x80) !== 0;
			let length = buffer[1] & 0x7f;
			let offset = 2;
			if (length === 126) {
				if (buffer.length < 4) return;
				length = buffer.readUInt16BE(2);
				offset = 4;
			}
			const maskLength = masked ? 4 : 0;
			if (buffer.length < offset + maskLength + length) return;
			const mask = masked ? buffer.subarray(offset, offset + 4) : undefined;
			offset += maskLength;
			const payload = Buffer.from(buffer.subarray(offset, offset + length));
			buffer = buffer.subarray(offset + length);
			if (mask) for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
			if (opcode === 8) {
				socket.end(websocketFrame(payload, 8));
				continue;
			}
			if (opcode !== 1) continue;
			const request = JSON.parse(payload.toString("utf8"));
			socket.write(websocketFrame(JSON.stringify({ id: request.id, result: {} })));
		}
	});
}

/**
 * @typedef {object} FakeCdp
 * @property {number} port Bound loopback port.
 * @property {import('node:net').Socket[]} upgraded WebSocket connections, oldest first.
 * @property {() => Promise<void>} close Destroy every connection and stop listening.
 */

/**
 * Start a fake CDP endpoint on loopback.
 * @param {{ port?: number, id?: string, title?: string }} [options] Port (0 picks one) and the single page's id and title.
 * @returns {Promise<FakeCdp>} The listening endpoint.
 * @throws {Error} If the port cannot be bound.
 */
export async function startFakeCdp({ port = 0, id = "fake", title = "Fake" } = {}) {
	const sockets = new Set();
	const upgraded = [];
	let boundPort = port;
	const server = http.createServer((request, response) => {
		response.setHeader("content-type", "application/json");
		if (request.url === "/json/version") return response.end("{}");
		if (request.url === "/json/list") {
			return response.end(JSON.stringify([{ id, type: "page", title, url: "about:blank", webSocketDebuggerUrl: `ws://127.0.0.1:${boundPort}/devtools/page/${id}` }]));
		}
		response.statusCode = 404;
		response.end();
	});
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	server.on("upgrade", (request, socket) => {
		upgraded.push(socket);
		const accept = createHash("sha1").update(`${request.headers["sec-websocket-key"]}${WEBSOCKET_GUID}`).digest("base64");
		socket.write(["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Accept: ${accept}`, "", ""].join("\r\n"));
		serveWebsocket(socket);
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", resolve);
	});
	boundPort = server.address().port;
	return {
		port: boundPort,
		upgraded,
		close: async () => {
			for (const socket of sockets) socket.destroy();
			await new Promise((resolve) => server.close(resolve));
		},
	};
}
