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
	const engine = createHelperEngine({ profile: "envelope", protocolVersion: 5, platform: "Linux" });
	Object.assign(engine.handlers, script(children));
	const spawn = createFakeSpawn({
		"*": () => {
			const child = createFakeChild({ engine });
			children.push(child);
			return child;
		},
	});
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
			last: effect(
				() => {
					const child = children.at(-1);
					child.emit("exit", 0, null);
					setTimeout(() => child.emit("close", 0, null), 20);
				},
				ok({ done: true }),
			),
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

describe("Linux helper exit owing releases (#1183)", () => {
	const report =
		"linux-bridge: exiting with the release of keycode 50, button 1 (delivery unknown, never resent) unconfirmed; it may still be held. Release it by hand, then restart Pi.\n";

	/** Exit the newest child with `code` after writing `stderr`, once the data has been read. */
	async function exitWith(children, code, stderr) {
		const child = children.at(-1);
		child.stderr.write(stderr);
		await new Promise((resolve) => setImmediate(resolve));
		child.exit(code);
	}

	test("exit status 3 refuses every later physical command, naming the held input; others respawn", async () => {
		const { client, children, spawn } = await clientFor(() => ({
			listRoots: ok([]),
			act: ok({ outcome: "worked" }),
			actBatch: ok({ outcome: "worked" }),
		}));
		await client.command("listRoots");
		await exitWith(children, 3, report);
		for (const [cmd, args] of [
			["act", { policy: "default" }],
			["act", {}],
			["actBatch", { actions: [{ policy: "ax_only" }, { policy: "foreground" }] }],
			["actBatch", {}],
			["focusWindow", {}],
		]) {
			await assert.rejects(client.command(cmd, args), (error) => {
				assert.equal(error.code, "input_unsafe");
				assert.match(error.message, /keycode 50, button 1 \(delivery unknown, never resent\)/);
				assert.match(error.message, /Release it by hand, then restart Pi\./);
				return true;
			});
		}
		assert.equal(spawn.calls.length, 1, "a refused physical command spawns nothing");
		// Semantic and observation commands still run on a respawned helper, and the refusal stays.
		assert.deepEqual(await client.command("listRoots"), []);
		assert.deepEqual(await client.command("act", { policy: "ax_only" }), { outcome: "worked" });
		assert.deepEqual(await client.command("actBatch", { actions: [{ policy: "ax_only" }] }), { outcome: "worked" });
		assert.equal(spawn.calls.length, 2);
		await assert.rejects(client.command("act", {}), /Refusing physical input/);
	});

	test("a helper discarded with SIGTERM still reports owed releases on its way out", async () => {
		const { client, children } = await clientFor(() => ({ listRoots: ok([]) }));
		await client.command("listRoots");
		const child = children.at(-1);
		client.discardChild(new Error("replaced"));
		assert.deepEqual(child.signals, ["SIGTERM"]);
		await exitWith(children, 3, report);
		await assert.rejects(client.command("focusWindow", {}), /keycode 50/);
	});

	test("other exits leave physical input alone", async () => {
		const { client, children } = await clientFor(() => ({ listRoots: ok([]), act: ok({ outcome: "worked" }) }));
		await client.command("listRoots");
		await exitWith(children, 1, report);
		assert.deepEqual(await client.command("act", {}), { outcome: "worked" });
	});

	test("stderr is drained but bounded: a report pushed out by later output names no input", async () => {
		const { client, children } = await clientFor(() => ({ listRoots: ok([]) }));
		await client.command("listRoots");
		// The report survives any amount of earlier output.
		await exitWith(children, 3, `${"x".repeat(1_000_000)}\n${report}`);
		await assert.rejects(client.command("act", {}), /keycode 50/);

		const second = await clientFor(() => ({ listRoots: ok([]) }));
		await second.client.command("listRoots");
		await exitWith(second.children, 3, `${report}${"x".repeat(9_000)}`);
		await assert.rejects(second.client.command("act", {}), (error) => {
			assert.equal(error.code, "input_unsafe");
			assert.match(error.message, /release of unknown keys or buttons unconfirmed/);
			return true;
		});
	});
});
