import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "vitest";
import { prepareSwiftSdk, runPreparedSwift } from "./support/swift-sdk.mjs";

// POSIX orchestration fixtures require executable shebangs, UID ownership and process groups.
// Keep macOS/Linux coverage; native Windows reports NOT RUN, never a fixture pass.
const testPosixOnly = test.skipIf(process.platform === "win32");
const dirs = [];
afterEach(async () => {
	await Promise.all(
		dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
	);
});

/** Build an executable compiler fixture; this tests orchestration, not Swift semantics. */
async function fixture(mode = "success") {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "swift-sdk-control-"));
	dirs.push(dir);
	const sdk = path.join(dir, "sdk");
	await fs.mkdir(sdk);
	await fs.writeFile(
		path.join(sdk, "SDKSettings.json"),
		'{"Version":"fixture"}',
	);
	const compiler = path.join(dir, "swiftc");
	await fs.writeFile(
		compiler,
		`#!${process.execPath}
import fs from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("fixture Swift 1"); }
else {
 fs.appendFileSync(${JSON.stringify(path.join(dir, "calls.jsonl"))}, JSON.stringify(args) + "\\n");
 if (${JSON.stringify(mode)} === "fail") { console.error("fixture SDK compile failed"); process.exit(23); }
 if (${JSON.stringify(mode)} === "hang") { console.log("fixture-ready " + process.pid); setInterval(() => {}, 1000); }
}
`,
		{ mode: 0o700 },
	);
	const xcrun = path.join(dir, "xcrun");
	await fs.writeFile(
		xcrun,
		`#!${process.execPath}
console.log(process.argv.includes("--find") ? ${JSON.stringify(compiler)} : ${JSON.stringify(sdk)});
`,
		{ mode: 0o700 },
	);
	return { dir, sdk, compiler, xcrun };
}

testPosixOnly(
	"preparation binds compiler, SDK, target and imports to one private cache",
	async () => {
		const f = await fixture();
		const messages = [];
		const prepared = await prepareSwiftSdk({
			scratch: f.dir,
			target: "fixture-target",
			xcrun: f.xcrun,
			report: (message) => messages.push(message),
		});
		assert.equal(prepared.identity.target, "fixture-target");
		assert.equal(prepared.identity.compiler, f.compiler);
		assert.equal(prepared.identity.sdk, f.sdk);
		assert.equal(prepared.identity.version, "fixture Swift 1");
		assert.match(prepared.key, /^[a-f0-9]{64}$/);
		assert.equal((await fs.stat(prepared.moduleCache)).mode & 0o777, 0o700);
		assert.equal((await fs.stat(prepared.moduleCache)).uid, process.getuid?.());
		assert(
			messages.some(
				(message) =>
					message.includes("SDK prepare start") &&
					message.includes(prepared.key),
			),
		);
		assert(messages.some((message) => message.includes("SDK prepare ready")));
		await runPreparedSwift(prepared, ["-typecheck", "valid.swift"], {
			label: "fixture source",
			timeoutMs: 5000,
		});
		const calls = (await fs.readFile(path.join(f.dir, "calls.jsonl"), "utf8"))
			.trim()
			.split("\n")
			.map(JSON.parse);
		assert.equal(calls.length, 2);
		assert.deepEqual(
			calls[0].slice(0, prepared.args.length),
			calls[1].slice(0, prepared.args.length),
		);
		assert(calls[0].includes(path.join(f.dir, "sdk-imports.swift")));
		await fs.writeFile(path.join(f.dir, "sdk-ready.json"), "{}");
		await assert.rejects(
			runPreparedSwift(prepared, ["-typecheck", "valid.swift"], {
				label: "wrong identity",
				timeoutMs: 5000,
			}),
			/SDK preparation identity mismatch/,
		);
		assert.equal(
			(await fs.readFile(path.join(f.dir, "calls.jsonl"), "utf8"))
				.trim()
				.split("\n").length,
			2,
		);
	},
);

testPosixOnly(
	"SDK/compiler identity changes reject reuse before source validation",
	async () => {
		for (const changed of ["sdk", "compiler"]) {
			const f = await fixture();
			const prepared = await prepareSwiftSdk({
				scratch: f.dir,
				target: "fixture-target",
				xcrun: f.xcrun,
				report: () => {},
			});
			await fs.appendFile(
				changed === "sdk" ? path.join(f.sdk, "SDKSettings.json") : f.compiler,
				"\n",
			);
			await assert.rejects(
				runPreparedSwift(prepared, ["-typecheck", "valid.swift"], {
					label: "changed identity",
					timeoutMs: 5000,
				}),
				/SDK preparation identity mismatch/,
			);
		}
	},
);

testPosixOnly(
	"concurrent callers prepare independent caches without a shared path or lock",
	async () => {
		const f = await fixture();
		const scratches = await Promise.all(
			["a", "b"].map(async (name) => {
				const dir = path.join(f.dir, name);
				await fs.mkdir(dir, { mode: 0o700 });
				return dir;
			}),
		);
		const prepared = await Promise.all(
			scratches.map((scratch) =>
				prepareSwiftSdk({
					scratch,
					target: "same-target",
					xcrun: f.xcrun,
					report: () => {},
				}),
			),
		);
		assert.notEqual(prepared[0].moduleCache, prepared[1].moduleCache);
		assert.equal(prepared[0].key, prepared[1].key);
		await Promise.all(
			prepared.map((sdk) =>
				runPreparedSwift(sdk, ["-typecheck", "valid.swift"], {
					label: "concurrent source",
					timeoutMs: 5000,
				}),
			),
		);
		const calls = (await fs.readFile(path.join(f.dir, "calls.jsonl"), "utf8"))
			.trim()
			.split("\n")
			.map(JSON.parse);
		for (const sdk of prepared)
			assert.equal(
				calls.filter((args) => args.includes(sdk.moduleCache)).length,
				2,
			);
		await fs.copyFile(prepared[0].receipt, prepared[1].receipt);
		await assert.rejects(
			runPreparedSwift(prepared[1], ["-typecheck", "valid.swift"], {
				label: "cross-run receipt",
				timeoutMs: 5000,
			}),
			/SDK preparation identity mismatch/,
		);
	},
);

testPosixOnly(
	"failed preparation reports compiler stderr and never publishes ready identity",
	async () => {
		const f = await fixture("fail");
		const messages = [];
		await assert.rejects(
			prepareSwiftSdk({
				scratch: f.dir,
				target: "fixture",
				xcrun: f.xcrun,
				report: (message) => messages.push(message),
			}),
			/fixture SDK compile failed/,
		);
		await assert.rejects(fs.stat(path.join(f.dir, "sdk-ready.json")), {
			code: "ENOENT",
		});
		assert(messages.some((message) => message.includes("SDK prepare failed")));
	},
);

testPosixOnly(
	"cold preparation has a real child deadline and reaps its owned group",
	async () => {
		const f = await fixture("hang");
		let failure;
		try {
			await prepareSwiftSdk({
				scratch: f.dir,
				target: "fixture",
				xcrun: f.xcrun,
				prepareTimeoutMs: 1000,
				report: () => {},
			});
		} catch (error) {
			failure = error;
		}
		assert(failure, "hanging preparation must reject");
		assert.match(
			failure.message,
			/Timed out waiting for Swift SDK preparation/,
		);
		// Startup may itself exceed the intentional deadline on a busy runner. The runner's
		// owned PID, not a race to emit stdout, is the cleanup authority in either case.
		const pid = failure.cause.pid;
		assert(
			Number.isInteger(pid),
			"deadline failure must retain the owned child PID",
		);
		assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
		if (process.platform !== "win32")
			assert.throws(() => process.kill(-pid, 0), { code: "ESRCH" });
		await assert.rejects(fs.stat(path.join(f.dir, "sdk-ready.json")), {
			code: "ENOENT",
		});
	},
);
