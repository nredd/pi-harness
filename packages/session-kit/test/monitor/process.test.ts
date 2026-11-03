import { describe, expect, it } from "vitest";
import { spawnMonitor } from "../../src/monitor/process.ts";
import { STAY } from "./stay.ts";

describe("spawnMonitor", () => {
	it("rejects an empty command before spawning", async () => {
		await expect(spawnMonitor([], { cwd: process.cwd(), onStdout: () => {}, onStderr: () => {} })).rejects.toThrow(
			"argv[0] must be non-empty",
		);
	});

	it("captures both output streams and settles after a natural exit", async () => {
		const stdout: string[] = [];
		const stderr: string[] = [];
		const monitor = await spawnMonitor(
			[process.execPath, "-e", 'process.stdout.write("out"); process.stderr.write("err")'],
			{
				cwd: process.cwd(),
				onStdout: (chunk) => {
					stdout.push(chunk.toString("utf8"));
				},
				onStderr: (chunk) => {
					stderr.push(chunk.toString("utf8"));
				},
			},
		);
		await expect(monitor.exited).resolves.toEqual({ exitCode: 0, signal: null });
		expect(stdout.join("")).toBe("out");
		expect(stderr.join("")).toBe("err");
	});

	it("kills a running process group immediately", async () => {
		const monitor = await spawnMonitor([process.execPath, "-e", STAY], {
			cwd: process.cwd(),
			onStdout: () => {},
			onStderr: () => {},
		});
		monitor.killNow();
		await expect(monitor.exited).resolves.toMatchObject({ signal: "SIGKILL" });
	});
});
