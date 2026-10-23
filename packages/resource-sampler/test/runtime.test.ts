// Real-host privacy and CPU checks. Runs under Vitest (Node) and `bun test` (Bun): both runtimes ship it.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { basename } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { createResourceSampler } from "../src/index.js";

const runtime = typeof process.versions.bun === "string" ? `bun ${process.versions.bun}` : `node ${process.version}`;

/** A child whose argv[0], argv, environment, process title and (Linux) comm all carry the secret. */
async function hostileChild(secret: string): Promise<ChildProcess> {
	const script = [
		"const secret = process.env.SAMPLER_SENTINEL;",
		"process.title = `npm exec ${secret} mcp`;",
		'if (process.platform === "linux") require("node:fs").writeFileSync("/proc/self/comm", secret);',
		'process.stdout.write("ready\\n");',
		"setInterval(() => {}, 1000);",
	].join("\n");
	const child = spawn(process.execPath, ["-e", script, secret], {
		argv0: `npm exec ${secret} mcp`,
		env: { PATH: "/usr/bin:/bin", SAMPLER_SENTINEL: secret },
		stdio: ["ignore", "pipe", "ignore"],
	});
	let output = "";
	child.stdout?.on("data", (data: Buffer) => {
		output += data.toString("utf8");
	});
	const deadline = Date.now() + 5000;
	while (!output.includes("ready\n")) {
		if (Date.now() > deadline || child.exitCode !== null) throw new Error("hostile child did not start");
		await delay(10);
	}
	return child;
}

/** The pre-0.1.1 name sources must really carry the secret, or this test proves nothing. */
function legacySourceLeaks(pid: number, secret: string): boolean {
	if (process.platform === "linux") return readFileSync(`/proc/${pid}/comm`, "utf8").trim() === secret.slice(0, 15);
	return execFileSync("/bin/ps", ["-c", "-o", "comm=", "-p", String(pid)], { encoding: "utf8" }).includes(secret);
}

describe(`actual sampler on ${runtime}`, () => {
	it("never reports argv, environment, process title or writable comm, even for a hostile process", async () => {
		const secret = randomBytes(16).toString("hex");
		const child = await hostileChild(secret);
		const sampler = createResourceSampler({ maxDurationMs: 2000 });
		try {
			const pid = child.pid as number;
			expect(legacySourceLeaks(pid, secret)).toBe(true);
			const snapshot = await sampler.sample();
			const serialized = JSON.stringify(snapshot);
			// 12 hex characters: any comm-length (15 byte) or p_comm (16 byte) fragment of the secret.
			for (let i = 0; i + 12 <= secret.length; i++) expect(serialized).not.toContain(secret.slice(i, i + 12));
			const own = snapshot.processes.find((entry) => entry.pid === pid);
			const names = [process.execPath, realpathSync(process.execPath)].map((path) =>
				process.platform === "darwin" ? basename(path).slice(0, 16) : basename(path),
			);
			expect(names).toContain(own?.name);
			for (const reason of snapshot.coverage.reasons) expect(reason).toMatch(/^[a-z-]+$/);
			console.info(JSON.stringify({ runtime, childName: own?.name, coverage: snapshot.coverage }));
		} finally {
			child.kill("SIGKILL");
			await sampler.dispose();
		}
	});
	it("measures host CPU from the second sample on, without stale runtime counters", async () => {
		const sampler = createResourceSampler({ maxDurationMs: 2000 });
		try {
			const states = [];
			for (let i = 0; i < 3; i++) {
				if (i > 0) await delay(250);
				states.push((await sampler.sample()).cpu);
			}
			expect(states[0]?.state).toBe("warming");
			for (const cpu of states.slice(1)) {
				expect(cpu?.state).toBe("available");
				if (cpu?.state === "available") expect(cpu.value).toBeGreaterThanOrEqual(0);
				if (cpu?.state === "available") expect(cpu.value).toBeLessThanOrEqual(100);
			}
			console.info(JSON.stringify({ runtime, cpu: states }));
		} finally {
			await sampler.dispose();
		}
	});
});
