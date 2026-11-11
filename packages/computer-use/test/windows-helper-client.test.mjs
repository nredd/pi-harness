// Drives `WindowsHelperClient` against `support/fake-helper.mjs` stdio children: no Windows helper runs.
import assert from "node:assert/strict";
import { afterEach, describe, test, vi } from "vitest";
import { createFakeChild, createFakeSpawn, createHelperEngine, drop, ok, silent } from "./support/fake-helper.mjs";

afterEach(() => {
	vi.doUnmock("node:child_process");
	vi.resetModules();
});

async function clientFor(handlers) {
	const engine = createHelperEngine({ profile: "envelope", protocolVersion: 4, handlers, platform: "Windows" });
	const spawn = createFakeSpawn({ "*": () => createFakeChild({ engine }) });
	vi.resetModules();
	vi.doMock("node:child_process", async (original) => ({ ...(await original()), spawn }));
	const { WindowsHelperClient } = await import("../src/platform/windows/helper.ts");
	const client = new WindowsHelperClient();
	vi.spyOn(client, "ensureInstalled").mockResolvedValue(undefined);
	return { client, spawn };
}

describe("Windows helper client disconnects (#725)", () => {
	test("a helper that exits mid-command rejects at once with helper_disconnected", async () => {
		const { client } = await clientFor({ crash: drop() });
		const timeoutMs = 30_000;
		const started = Date.now();
		await assert.rejects(client.command("crash", {}, { timeoutMs }), (error) => {
			assert.equal(error.code, "helper_disconnected");
			assert.doesNotMatch(error.message, /timed out/);
			return true;
		});
		assert.ok(Date.now() - started < timeoutMs / 2, "the exit must not wait out the command timeout");
		assert.equal(client.pending.size, 0);
	});

	test("replies still resolve, and a later exit leaves nothing pending", async () => {
		const { client, spawn } = await clientFor({ look: ok({ roots: [] }), hang: silent() });
		assert.deepEqual(await client.command("look"), { roots: [] });
		const pending = client.command("hang", {}, { timeoutMs: 30_000 });
		await vi.waitFor(() => assert.equal(client.pending.size, 1));
		client.child.emit("close", 1, null);
		await assert.rejects(pending, (error) => error.code === "helper_disconnected");
		assert.equal(spawn.calls.length, 1);
	});
});
