// `LinuxHelperClient` disconnect handling (#725): fail in-flight commands once stdout is drained (`close`),
// never on `exit` alone, and frame each child's output separately.
import assert from "node:assert/strict";
import { afterEach, describe, test, vi } from "vitest";
import { createFakeChild, createFakeSpawn, createHelperEngine, effect, ok, silent } from "./support/fake-helper.mjs";

afterEach(() => {
	vi.doUnmock("node:child_process");
	vi.resetModules();
});

/** `script(child, engine)` returns the handlers; every spawn yields a fresh fake child, collected in `children`. */
async function clientFor(script) {
	const children = [];
	const engine = createHelperEngine({ profile: "envelope", protocolVersion: 4, platform: "Linux" });
	Object.assign(engine.handlers, script(children));
	const spawn = createFakeSpawn({ "*": () => {
		const child = createFakeChild({ engine });
		children.push(child);
		return child;
	} });
	vi.resetModules();
	vi.doMock("node:child_process", async (original) => ({ ...(await original()), spawn }));
	const { LinuxHelperClient } = await import("../src/platform/linux/helper.ts");
	const client = new LinuxHelperClient({ helperPath: "/nonexistent/linux-bridge" });
	vi.spyOn(client, "ensureInstalled").mockResolvedValue(undefined);
	return { client, children, spawn };
}

describe("Linux helper client disconnects (#725)", () => {
	test("a helper that exits mid-command rejects at once, not at the command timeout", async () => {
		const { client } = await clientFor((children) => ({
			crash: effect(() => {
				const child = children.at(-1);
				child.emit("exit", 1, null);
				setImmediate(() => child.emit("close", 1, null));
			}, silent()),
		}));
		const timeoutMs = 30_000;
		const started = Date.now();
		await assert.rejects(client.command("crash", {}, { timeoutMs }), /Linux helper exited with code 1/);
		assert.ok(Date.now() - started < timeoutMs / 2, "the exit must not wait out the command timeout");
		assert.equal(client.pending.size, 0);
	});

	test("a complete reply still in stdout when the helper exits resolves the command", async () => {
		const { client } = await clientFor((children) => ({
			last: effect(() => {
				const child = children.at(-1);
				child.emit("exit", 0, null);
				setTimeout(() => child.emit("close", 0, null), 20);
			}, ok({ done: true })),
		}));
		assert.deepEqual(await client.command("last", {}, { timeoutMs: 30_000 }), { done: true });
		assert.equal(client.child, undefined, "exit forgets the child so the next command respawns");
	});

	test("a late close from a dead child does not fail requests sent to its successor", async () => {
		const { client, children, spawn } = await clientFor((all) => ({
			first: effect(() => all.at(-1).emit("exit", 1, null), silent()),
			second: ok({ fine: true }),
		}));
		const first = client.command("first", {}, { timeoutMs: 30_000 });
		await vi.waitFor(() => assert.ok(children.length === 1 && client.child === undefined));
		assert.deepEqual(await client.command("second"), { fine: true });
		assert.equal(spawn.calls.length, 2);
		children[0].emit("close", 1, null);
		await assert.rejects(first, /Linux helper exited with code 1/);
		assert.deepEqual(await client.command("second"), { fine: true });
	});

	test("a dead child's partial line is not glued onto its successor's first reply", async () => {
		const { client, children } = await clientFor((all) => ({
			first: effect(() => {
				const child = all.at(-1);
				child.stdout.write('{"id":"x"');
				child.emit("exit", 1, null);
			}, silent()),
			second: ok({ fine: true }),
		}));
		const first = client.command("first", {}, { timeoutMs: 30_000 });
		await vi.waitFor(() => assert.ok(children.length === 1 && client.child === undefined));
		assert.deepEqual(await client.command("second"), { fine: true });
		children[0].emit("close", 1, null);
		await assert.rejects(first, /Linux helper exited/);
	});
});
