import assert from "node:assert/strict";
import { shutdownComputerUseSession } from "../src/bridge.ts";
import { cdpTabForWindow } from "../src/cdp.ts";
import { test } from "vitest";
import { startFakeCdp } from "./fixtures/fake-cdp.mjs";

test("session shutdown closes CDP while leaving an external browser running", async () => {
	const CDP_CLOSE_TIMEOUT_MS = 1500;

	let fake;
	try {
		fake = await startFakeCdp({ id: "test-tab", title: "Test Tab" });
		const port = fake.port;
		process.env.PI_COMPUTER_USE_CDP_PORT = String(port);

		const tab = await cdpTabForWindow("Test Tab");
		assert(tab?.isOpen, "test CDP tab did not connect");
		const websocket = fake.upgraded.at(-1);
		assert(websocket, "test server did not retain the CDP socket");

		// Subscribe before shutdown can close the socket; the timer is only a failure backstop.
		const websocketClosed = new Promise(
			/** @returns {void} Observes socket closure before shutdown begins. @throws {never} Expiry rejects this promise. */
			(resolve, reject) => {
				const timer = setTimeout(
					/** @returns {void} Rejects missing socket closure. @throws {never} No synchronous errors. */
					() =>
						reject(new Error("CDP socket remained open after session shutdown")),
					CDP_CLOSE_TIMEOUT_MS,
				);
				websocket.once("close", () => {
					clearTimeout(timer);
					resolve();
				});
			},
		);
		await Promise.all([shutdownComputerUseSession(), websocketClosed]);

		const response = await fetch(`http://127.0.0.1:${port}/json/list`);
		assert.equal(
			response.status,
			200,
			"session shutdown stopped the external browser endpoint",
		);
		assert.equal(
			process.env.PI_COMPUTER_USE_CDP_PORT,
			String(port),
			"session shutdown changed the external CDP configuration",
		);
		console.log(
			"PASS session shutdown closes CDP while leaving an external browser running",
		);
	} finally {
		delete process.env.PI_COMPUTER_USE_CDP_PORT;
		await fake?.close();
	}
});
