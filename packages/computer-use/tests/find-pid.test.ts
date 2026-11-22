import assert from "node:assert/strict";
import { onTestFinished, test, vi } from "vitest";
import { currentPlatformBackend } from "../src/platform/index.ts";
import { macosBackend } from "../src/platform/macos/backend.ts";
import { macosHelper } from "../src/platform/macos/helper.ts";
import { installFakeDesktop } from "../test/support/fake-desktop.mjs";

test("macOS find_roots rejects PID overflow before discovery", async () => {
	const fake = await installFakeDesktop(onTestFinished, { platform: "macos" });
	const discoverApps = vi.spyOn(currentPlatformBackend, "listApps").mockResolvedValue([]);
	onTestFinished(() => discoverApps.mockRestore());
	for (const pid of [2147483648, Number.MAX_SAFE_INTEGER]) {
		await assert.rejects(fake.call(fake.bridge.executeFind, { pid }), /find_roots\.pid.*2147483647/);
	}
	assert.equal(discoverApps.mock.calls.length, 0);
	await fake.call(fake.bridge.executeFind, { pid: 2147483647 });
	assert.equal(discoverApps.mock.calls.length, 1);
});

test.each(["windows", "linux"])("%s find_roots does not apply the macOS PID limit", async (platform) => {
	const fake = await installFakeDesktop(onTestFinished, { platform });
	const discoverApps = vi.spyOn(currentPlatformBackend, "listApps").mockResolvedValue([]);
	onTestFinished(() => discoverApps.mockRestore());
	await fake.call(fake.bridge.executeFind, { pid: 2147483648 });
	assert.equal(discoverApps.mock.calls.length, 1);
});

test("macOS root discovery rejects overflow before serializing the helper request", async () => {
	const command = vi.spyOn(macosHelper, "command").mockResolvedValue([]);
	onTestFinished(() => command.mockRestore());
	await assert.rejects(macosBackend.listRoots({ pid: 2147483648 }), /pid.*2147483647/);
	assert.equal(command.mock.calls.length, 0);
	await macosBackend.listRoots({ pid: 2147483647 });
	assert.deepEqual(command.mock.calls[0]?.slice(0, 2), ["listRoots", { pid: 2147483647 }]);
});

test("macOS root discovery rejects invalid finite PIDs without calling the helper", async () => {
	const command = vi.spyOn(macosHelper, "command").mockResolvedValue([]);
	onTestFinished(() => command.mockRestore());
	for (const pid of [1234.5, 2147483647.5, 0, -1]) {
		await assert.rejects(macosBackend.listRoots({ pid }), /pid must be a positive integer/);
		assert.equal(command.mock.calls.length, 0);
	}
	// Non-finite and nonnumeric filters keep the documented unfiltered discovery.
	for (const pid of [NaN, Infinity, "1234" as unknown as number, undefined]) {
		command.mockClear();
		await macosBackend.listRoots({ pid });
		assert.deepEqual(command.mock.calls[0]?.slice(0, 2), ["listRoots", {}]);
	}
});
