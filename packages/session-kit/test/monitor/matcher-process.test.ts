import { type ChildProcess, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "@nredd/pi-test-lib/clock";
import { expect, it, vi } from "vitest";
import { BoundedMatcher } from "../../src/monitor/matcher.ts";

const children = vi.hoisted(() => [] as ChildProcess[]);
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		spawn: (...args: Parameters<typeof actual.spawn>) => {
			const child = actual.spawn(...args);
			children.push(child);
			return child;
		},
	};
});

it("exits on parent IPC loss even when the isolated regex is spinning", async () => {
	const matcher = new BoundedMatcher("^(a+)+$", new FakeClock());
	try {
		const ready: boolean[] = [];
		matcher.test("a", (value) => ready.push(value));
		await matcher.drain();
		expect(ready).toEqual([true]);
		const child = children.at(-1);
		if (!child) throw new Error("Expected a real matcher child");
		const exit = new Promise<void>((resolve) => child.once("exit", () => resolve()));
		const matched: boolean[] = [];
		matcher.test(`${"a".repeat(4096)}!`, (value) => matched.push(value));
		await new Promise((resolve) => setTimeout(resolve, 60));
		const start = Date.now();
		child.disconnect();
		await exit;
		expect(Date.now() - start).toBeLessThan(500);
		expect(child.signalCode).toBe("SIGKILL");
		expect(matched).toEqual([true]);
	} finally {
		await matcher.close();
	}
});

it("runs matching from a real compiled Bun host without re-entering its bundled entrypoint", () => {
	const dir = mkdtempSync(join(tmpdir(), "kit-matcher-compiled-"));
	try {
		const fixture = join(dir, "main.ts");
		const executable = join(dir, "matcher-host");
		const source = new URL("../../src/monitor/matcher.ts", import.meta.url).pathname;
		writeFileSync(
			fixture,
			`import { BoundedMatcher } from ${JSON.stringify(source)};
const matcher = new BoundedMatcher('^READY$');
const results = [];
for (const text of ['no', 'READY']) matcher.test(text, value => results.push(value));
await matcher.drain();
await matcher.close();
console.log(JSON.stringify(results));`,
		);
		const build = spawnSync("bun", ["build", "--compile", fixture, "--outfile", executable], {
			encoding: "utf8",
			timeout: 10_000,
		});
		expect(build.status, build.stderr).toBe(0);
		const run = spawnSync(executable, [], { encoding: "utf8", timeout: 5_000 });
		expect(run.status, run.stderr).toBe(0);
		expect(run.stdout.trim()).toBe("[false,true]");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
