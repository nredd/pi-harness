// Pins that `LinuxHelperClient` fails in-flight commands as soon as the helper exits (#725 audit).
import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { createFakeChild, createFakeSpawn, createHelperEngine, effect, silent } from "./support/fake-helper.mjs";

afterEach(() => {
	vi.doUnmock("node:child_process");
	vi.resetModules();
});

test("a Linux helper that exits mid-command rejects at once, not at the command timeout", async () => {
	let child;
	const engine = createHelperEngine({ profile: "envelope", protocolVersion: 4, handlers: { crash: effect(() => child.emit("exit", 1, null), silent()) }, platform: "Linux" });
	const spawn = createFakeSpawn({ "*": () => (child = createFakeChild({ engine })) });
	vi.resetModules();
	vi.doMock("node:child_process", async (original) => ({ ...(await original()), spawn }));
	const { LinuxHelperClient } = await import("../src/platform/linux/helper.ts");
	const client = new LinuxHelperClient({ helperPath: "/nonexistent/linux-bridge" });
	vi.spyOn(client, "ensureInstalled").mockResolvedValue(undefined);
	const timeoutMs = 30_000;
	const started = Date.now();
	await assert.rejects(client.command("crash", {}, { timeoutMs }), /Linux helper exited with code 1/);
	assert.ok(Date.now() - started < timeoutMs / 2, "the exit must not wait out the command timeout");
});
