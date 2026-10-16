/** Drive real installed Pi through multiple prompts and assert physical dispatches. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const [root, scenario] = process.argv.slice(2);
const expected = {
	"balanced-route": [["spike-c"]],
	"balanced-switch": [["spike-a"], ["spike-a"], ["spike-b"]],
	"balanced-sticky": [["spike-c", "spike-c"]],
	"balanced-blocked": [["spike-c", "spike-a"]],
	"balanced-fallback": [["spike-b"]],
	"balanced-unmeasured": [["spike-b", "spike-a"]],
}[scenario];
assert.ok(expected, `unknown scenario ${scenario}`);
const child = spawn(
	"pi",
	[
		"--no-extensions",
		"--no-session",
		"-e",
		`${root}/e2e/faux-balanced.ext.ts`,
		"-e",
		`${root}/src/index.ts`,
		"--model",
		"router/spike",
		"--mode",
		"rpc",
	],
	{
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, SPIKE_BALANCED: scenario },
	},
);
let stderr = "";
child.stderr.on("data", (data) => {
	stderr += data;
});
let turn = 0;
let seen = [];
let passed = false;
const timeout = setTimeout(() => {
	console.error(`FAIL ${scenario}: timeout\n${stderr}`);
	child.kill("SIGKILL");
	process.exitCode = 1;
}, 30_000);
const lines = createInterface({ input: child.stdout });
const prompt = () => child.stdin.write(`${JSON.stringify({ type: "prompt", message: "exercise routing" })}\n`);
lines.on("line", (line) => {
	try {
		const event = JSON.parse(line);
		if (event.type === "message_end" && event.message.role === "assistant") {
			assert.notEqual(event.message.stopReason, "error", event.message.errorMessage);
			seen.push(event.message.provider);
		}
		if (event.type !== "agent_end") return;
		assert.deepEqual(seen, expected[turn], `turn ${turn + 1}`);
		console.log(`${scenario} prompt ${turn + 1}: ${seen.join(" -> ")}`);
		seen = [];
		turn++;
		if (turn < expected.length) prompt();
		else {
			passed = true;
			child.stdin.end();
			child.kill("SIGTERM");
		}
	} catch (error) {
		console.error(`FAIL ${scenario}: ${error}\n${stderr}`);
		process.exitCode = 1;
		child.kill("SIGKILL");
	}
});
child.on("error", (error) => {
	console.error(error);
	process.exitCode = 1;
});
child.on("close", () => {
	clearTimeout(timeout);
	lines.close();
	if (passed) console.log(`PASS ${scenario}`);
	else {
		console.error(`FAIL ${scenario}: Pi exited early\n${stderr}`);
		process.exitCode = 1;
	}
});
prompt();
