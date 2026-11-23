// `LinuxHelperClient` disconnect handling (#725): fail in-flight commands once stdout is drained (`close`),
// never on `exit` alone, and frame each child's output separately.
import assert from "node:assert/strict";
import { afterEach, describe, test, vi } from "vitest";
import { linuxHelperClient as clientFor } from "../tests/fixtures/linux-helper.mjs";
import { effect, ok, silent } from "./support/fake-helper.mjs";

afterEach(() => {
	vi.doUnmock("node:child_process");
	vi.resetModules();
});

describe("Linux helper fixture (#1352)", () => {
	test("the shared fixture's `diagnostics` reports every required feature", async () => {
		const { client, helper } = await clientFor(() => ({}));
		const diagnostics = await client.command("diagnostics");
		assert.deepEqual(diagnostics.features, [...helper.LINUX_REQUIRED_HELPER_FEATURES]);
		assert.doesNotThrow(() => helper.assertLinuxHelperFeatures(diagnostics));
	});
});

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

		// The cap is in bytes, not UTF-16 code units: 3,000 three-byte characters (9,000 bytes) push it out too.
		const third = await clientFor(() => ({ listRoots: ok([]) }));
		await third.client.command("listRoots");
		await exitWith(third.children, 3, `${report}${"\u20ac".repeat(3_000)}`);
		await assert.rejects(third.client.command("act", {}), /release of unknown keys or buttons unconfirmed/);
	});

	/** Emit `exit` with `code` alone, as Node does before stdout and stderr are drained. */
	function exitOnly(child, code) {
		child.exitCode = code;
		child.emit("exit", code, null);
	}

	test("status 3 is latched on exit, before close: a physical command in between spawns and sends nothing", async () => {
		let acted = 0;
		const { client, children, spawn } = await clientFor(() => ({
			listRoots: ok([]),
			act: effect(
				() => {
					acted += 1;
				},
				ok({ outcome: "worked" }),
			),
		}));
		await client.command("listRoots");
		const child = children.at(-1);
		exitOnly(child, 3);
		await assert.rejects(client.command("act", {}), (error) => {
			assert.equal(error.code, "input_unsafe");
			assert.match(error.message, /release of unknown keys or buttons unconfirmed/);
			return true;
		});
		assert.equal(spawn.calls.length, 1, "nothing respawned between exit and close");
		// The report read before `close` names the inputs.
		await exitWith(children, 3, report);
		await assert.rejects(client.command("act", {}), /keycode 50, button 1/);
		assert.equal(acted, 0);

		// A named report is kept when the tail at `close` lost it.
		const named = await clientFor(() => ({ listRoots: ok([]) }));
		await named.client.command("listRoots");
		named.children.at(-1).stderr.write(report);
		await new Promise((resolve) => setImmediate(resolve));
		exitOnly(named.children.at(-1), 3);
		await exitWith(named.children, 3, "x".repeat(9_000));
		await assert.rejects(named.client.command("focusWindow", {}), /keycode 50, button 1/);
	});

	test("a latch set while a physical command awaited the helper start stops it before the write", async () => {
		let acted = 0;
		const { client, children } = await clientFor(() => ({
			listRoots: ok([]),
			act: effect(
				() => {
					acted += 1;
				},
				ok({ outcome: "worked" }),
			),
		}));
		await client.command("listRoots");
		let open;
		client.ensureInstalled.mockImplementationOnce(() => new Promise((resolve) => (open = resolve)));
		const pending = client.command("act", {});
		await vi.waitFor(() => assert.ok(open));
		// The live helper exits owing releases while the command is still waiting.
		await exitWith(children, 3, report);
		open();
		await assert.rejects(pending, (error) => {
			assert.equal(error.code, "input_unsafe");
			assert.match(error.message, /keycode 50/);
			return true;
		});
		assert.equal(acted, 0, "never written to the respawned helper");
	});

	test("physical input waits for a discarded helper's exit status; others do not", async () => {
		let acted = 0;
		const handlers = () => ({
			listRoots: ok([]),
			act: effect(
				() => {
					acted += 1;
				},
				ok({ outcome: "worked" }),
			),
		});
		const { client, children } = await clientFor(handlers);
		await client.command("listRoots");
		const discarded = children.at(-1);
		client.discardChild(new Error("replaced"));
		const pending = client.command("act", {});
		// Observation commands go on meanwhile.
		assert.deepEqual(await client.command("listRoots"), []);
		assert.equal(acted, 0, "held back while the exit status is unknown");
		exitOnly(discarded, 3);
		await assert.rejects(pending, /Refusing physical input/);
		assert.equal(acted, 0);

		// A clean exit lets it through.
		const clean = await clientFor(handlers);
		await clean.client.command("listRoots");
		const old = clean.children.at(-1);
		clean.client.discardChild(new Error("replaced"));
		const next = clean.client.command("act", {});
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(acted, 0);
		exitOnly(old, 0);
		assert.deepEqual(await next, { outcome: "worked" });
		assert.equal(acted, 1);
	});

	test("a discarded helper that never exits refuses physical input once the bounded wait ends", async () => {
		const { client, helper } = await clientFor(() => ({ listRoots: ok([]), act: ok({ outcome: "worked" }) }));
		await client.command("listRoots");
		client.discardChild(new Error("replaced"));
		const started = Date.now();
		await assert.rejects(client.command("act", {}), (error) => {
			assert.equal(error.code, "input_unsafe");
			assert.match(error.message, /did not exit within/);
			return true;
		});
		assert.ok(Date.now() - started >= helper.DISCARDED_EXIT_WAIT_MS - 50);
	});

	test("session reset surfaces a status 3 that arrives after disposal, and the fresh client keeps refusing", async () => {
		const { children, helper } = await clientFor(() => ({ listRoots: ok([]) }));
		const old = helper.linuxHelper;
		vi.spyOn(old, "ensureInstalled").mockResolvedValue(undefined);
		await old.command("listRoots");
		const reset = helper.resetLinuxHelper();
		const fresh = helper.linuxHelper;
		assert.notEqual(fresh, old, "the replacement is installed before disposal");
		const child = children.at(-1);
		assert.deepEqual(child.signals, ["SIGTERM"]);
		child.stderr.write(report);
		await new Promise((resolve) => setImmediate(resolve));
		exitOnly(child, 3);
		assert.match(await reset, /keycode 50, button 1 .* Release it by hand, then restart Pi\./);
		vi.spyOn(fresh, "ensureInstalled").mockResolvedValue(undefined);
		await assert.rejects(fresh.command("act", {}), /keycode 50/);

		// A clean exit has nothing to surface.
		const quiet = await clientFor(() => ({ listRoots: ok([]) }));
		vi.spyOn(quiet.helper.linuxHelper, "ensureInstalled").mockResolvedValue(undefined);
		await quiet.helper.linuxHelper.command("listRoots");
		const cleanReset = quiet.helper.resetLinuxHelper();
		exitOnly(quiet.children.at(-1), 0);
		assert.equal(await cleanReset, undefined);
	});

	test("a helper killed by a signal after physical input refuses physical input; before any, it does not", async () => {
		const handlers = () => ({ listRoots: ok([]), act: ok({ outcome: "worked" }) });
		const { client, children } = await clientFor(handlers);
		assert.deepEqual(await client.command("act", {}), { outcome: "worked" });
		const child = children.at(-1);
		client.discardChild(new Error("replaced"));
		// The helper ignores SIGTERM, e.g. its runtime is stalled: the backstop kills it.
		await vi.waitFor(() => assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]), { timeout: 2_000 });
		child.emit("exit", null, "SIGKILL");
		await assert.rejects(client.command("act", {}), (error) => {
			assert.equal(error.code, "input_unsafe");
			assert.match(error.message, /killed after physical input; held keys\/buttons unknown/);
			return true;
		});
		assert.deepEqual(await client.command("listRoots"), [], "observation still respawns");

		// Only observation so far: a signal death leaves physical input alone.
		const quiet = await clientFor(handlers);
		await quiet.client.command("listRoots");
		quiet.children.at(-1).emit("exit", null, "SIGKILL");
		assert.deepEqual(await quiet.client.command("act", {}), { outcome: "worked" });

		// A non-signal exit after physical input ran the helper's own exit path: its status is trusted.
		const clean = await clientFor(handlers);
		await clean.client.command("act", {});
		exitOnly(clean.children.at(-1), 0);
		assert.deepEqual(await clean.client.command("act", {}), { outcome: "worked" });
	});

	test("physical input on the fresh client waits for the predecessor's disposal; resets chain", async () => {
		let acted = 0;
		const { children, spawn, helper } = await clientFor(() => ({
			listRoots: ok([]),
			act: effect(
				() => {
					acted += 1;
				},
				ok({ outcome: "worked" }),
			),
		}));
		vi.spyOn(helper.linuxHelper, "ensureInstalled").mockResolvedValue(undefined);
		await helper.linuxHelper.command("listRoots");
		const old = children.at(-1);
		const first = helper.resetLinuxHelper();
		const fresh = helper.linuxHelper;
		vi.spyOn(fresh, "ensureInstalled").mockResolvedValue(undefined);
		const pending = fresh.command("act", {});
		// Non-physical commands go on; a second reset meanwhile chains onto the first.
		assert.deepEqual(await fresh.command("listRoots"), []);
		const second = helper.resetLinuxHelper();
		const newest = helper.linuxHelper;
		vi.spyOn(newest, "ensureInstalled").mockResolvedValue(undefined);
		const later = newest.command("focusWindow", {});
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(acted, 0, "no physical write before the predecessor's status is known");
		for (const child of children.slice(1)) exitOnly(child, 0);
		old.stderr.write(report);
		await new Promise((resolve) => setImmediate(resolve));
		exitOnly(old, 3);
		assert.match(await first, /keycode 50/);
		assert.match(await second, /keycode 50/, "the second reset inherits the first one's refusal");
		for (const command of [pending, later])
			await assert.rejects(command, (error) => {
				assert.equal(error.code, "input_unsafe");
				assert.match(error.message, /keycode 50/);
				return true;
			});
		assert.equal(acted, 0);
		assert.equal(spawn.calls.length, 2, "only the listRoots helper was spawned for the fresh client");

		// A clean predecessor lets physical input through once its exit is known.
		const clean = await clientFor(() => ({ listRoots: ok([]), act: ok({ outcome: "worked" }) }));
		vi.spyOn(clean.helper.linuxHelper, "ensureInstalled").mockResolvedValue(undefined);
		await clean.helper.linuxHelper.command("listRoots");
		const reset = clean.helper.resetLinuxHelper();
		vi.spyOn(clean.helper.linuxHelper, "ensureInstalled").mockResolvedValue(undefined);
		const through = clean.helper.linuxHelper.command("act", {});
		exitOnly(clean.children.at(-1), 0);
		assert.equal(await reset, undefined);
		assert.deepEqual(await through, { outcome: "worked" });
	});
});
