import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import { cdpError, startFakeCdp, websocketFrame, parseFrames } from "./fixtures/fake-cdp.mjs";

const fakes = [];
const sockets = [];

afterEach(async () => {
	for (const socket of sockets.splice(0)) socket.close();
	await Promise.all(fakes.splice(0).map((fake) => fake.close()));
});

/**
 * Open a client WebSocket and collect its JSON messages.
 * @param {string} url `ws://` URL.
 * @returns {Promise<{ socket: WebSocket, next: () => Promise<any> }>} Open socket and an ordered message reader.
 * @throws {Error} If the upgrade fails.
 */
async function client(url) {
	const socket = new WebSocket(url);
	sockets.push(socket);
	const queue = [];
	const waiters = [];
	socket.onmessage = (event) => {
		const message = JSON.parse(String(event.data));
		const waiter = waiters.shift();
		if (waiter) waiter(message);
		else queue.push(message);
	};
	await new Promise((resolve, reject) => {
		socket.onopen = resolve;
		socket.onerror = () => reject(new Error("upgrade failed"));
	});
	return { socket, next: () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve) => waiters.push(resolve))) };
}

describe("fake CDP framing", () => {
	test.each([[5, 2], [200, 4], [70_000, 10]])("a %i byte payload uses a %i byte header and round-trips", (size, header) => {
		const frame = websocketFrame("x".repeat(size));
		assert.equal(frame.length, size + header);
		const { frames, rest } = parseFrames(frame);
		assert.equal(rest.length, 0);
		assert.equal(frames[0].payload.length, size);
	});

	test("an incomplete frame is held back until the rest arrives", () => {
		const frame = websocketFrame("x".repeat(200));
		for (const cut of [1, 3, 100]) assert.equal(parseFrames(frame.subarray(0, cut)).frames.length, 0);
		assert.equal(parseFrames(websocketFrame("y".repeat(70_000)).subarray(0, 9)).frames.length, 0);
	});

	test("large replies and fragmented requests survive the wire", async () => {
		const fake = await startFakeCdp();
		fakes.push(fake);
		fake.handle("Big.thing", () => ({ blob: "z".repeat(70_000) }));
		const { socket, next } = await client(fake.url("page/fake"));
		socket.send(JSON.stringify({ id: 1, method: "Big.thing" }));
		assert.equal((await next()).result.blob.length, 70_000);
		// Fragment one request over a text frame plus a continuation frame, via the raw upgraded socket path.
		const request = JSON.stringify({ id: 2, method: "Echo", params: { v: 1 } });
		fake.handle("Echo", (params) => params);
		const connection = fake.connections[0];
		connection.socket.emit("data", Buffer.concat([Buffer.from([0x01, 5]), Buffer.from(request.slice(0, 5)), Buffer.from([0x80, request.length - 5]), Buffer.from(request.slice(5))]));
		assert.deepEqual((await next()).result, { v: 1 });
	});
});

describe("fake CDP sessions", () => {
	test("the browser endpoint attaches and detaches flat sessions", async () => {
		const fake = await startFakeCdp({ id: "t1" });
		fakes.push(fake);
		fake.handle("Runtime.evaluate", (_params, ctx) => ({ result: { value: ctx.sessionId } }));
		const { socket, next } = await client(fake.url("browser/main"));
		socket.send(JSON.stringify({ id: 1, method: "Target.getTargets" }));
		assert.equal((await next()).result.targetInfos[0].targetId, "t1");
		socket.send(JSON.stringify({ id: 2, method: "Target.attachToTarget", params: { targetId: "t1", flatten: true } }));
		const attached = await next();
		assert.equal(attached.method, "Target.attachedToTarget");
		const { sessionId } = (await next()).result;
		assert.equal(sessionId, attached.params.sessionId);
		socket.send(JSON.stringify({ id: 3, method: "Runtime.evaluate", sessionId }));
		assert.deepEqual(await next(), { id: 3, result: { result: { value: sessionId } }, sessionId });
		socket.send(JSON.stringify({ id: 4, method: "Target.detachFromTarget", params: { sessionId } }));
		assert.equal((await next()).method, "Target.detachedFromTarget");
		assert.deepEqual((await next()).result, {});
		socket.send(JSON.stringify({ id: 5, method: "Runtime.evaluate", sessionId }));
		assert.equal((await next()).error.code, -32001);
		socket.send(JSON.stringify({ id: 6, method: "Target.detachFromTarget", params: { sessionId } }));
		assert.equal((await next()).error.code, -32602);
		socket.send(JSON.stringify({ id: 7, method: "Target.attachToTarget", params: { targetId: "missing" } }));
		assert.equal((await next()).error.code, -32602);
	});

	test("events carry their session id and handlers see the endpoint's target", async () => {
		const fake = await startFakeCdp({ id: "t9" });
		fakes.push(fake);
		fake.handle("Who.am.i", (_params, ctx) => ({ target: ctx.targetId, kind: ctx.connection.kind }));
		fake.handle("Fail.now", () => cdpError("nope", -1));
		const { socket, next } = await client(fake.url("page/t9"));
		fake.connections[0].emit("Page.frameNavigated", { a: 1 }, "s");
		assert.deepEqual(await next(), { method: "Page.frameNavigated", params: { a: 1 }, sessionId: "s" });
		socket.send(JSON.stringify({ id: 1, method: "Who.am.i" }));
		assert.deepEqual((await next()).result, { target: "t9", kind: "page" });
		socket.send(JSON.stringify({ id: 2, method: "Fail.now" }));
		assert.deepEqual((await next()).error, { code: -1, message: "nope" });
	});
});
