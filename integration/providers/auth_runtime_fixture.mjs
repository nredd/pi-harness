// Tiny compiled-host fixture, NOT a Pi/SDK stand-in or an assembled-stack receipt.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { verifyTransport } from "./auth_transport.mjs";

if (process.argv.includes("--stale-nonce")) process.env.HARNESS_AUTH_NONCE = "wrong-nonce";
if (process.argv.includes("--lost-egress")) {
	// Never use a real network call for the broken-guard negative control.
	Object.defineProperty(globalThis, "fetch", { value: async () => new Response("{}"), configurable: true });
}
if (process.argv.includes("--wrong-echo")) globalThis.fetch = async () => Response.json({ nonce: "wrong" });
await verifyTransport();
// Simulate Pi's later fetch replacement. The accessor must remain in front of it.
if (globalThis.Bun) globalThis.fetch = Bun.fetch;
await verifyTransport();
for (const name of ["claude", "security"]) {
	const command = `/harness-never-exists/${name}`;
	assert.throws(() => spawnSync(command), /harness blocked/);
	if (globalThis.Bun) {
		assert.throws(() => Bun.spawn([command]), /harness blocked/);
		assert.throws(() => Bun.spawnSync({ cmd: [command] }), /harness blocked/);
	}
}
const response = await fetch(
	new Request("https://api.anthropic.com/v1/messages?fixture=1", {
		method: "POST",
		headers: { authorization: "Bearer fixture-only", "content-type": "application/json" },
		body: JSON.stringify({ model: "fixture", messages: [{ role: "user", content: "hi" }] }),
	}),
);
assert.equal(response.status, 200);
console.log("AUTH_RUNTIME_FIXTURE_OK");
