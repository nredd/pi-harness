import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import requestLedgerProbe from "./request-ledger.ts";

test("records source and exact custom-type provenance without replacing the request", () => {
	const root = mkdtempSync(join(tmpdir(), "ledger-probe-"));
	const old = process.env.HARNESS_LEDGER_REGISTRY;
	const handlers = new Map<string, (event: unknown) => void>();
	const tools = [{ name: "read", sourceInfo: { source: "builtin", path: "builtin:read" } }];
	try {
		requestLedgerProbe({
			on: (name: string, callback: (event: unknown) => void) => handlers.set(name, callback),
			getAllTools: () => tools,
		} as unknown as ExtensionAPI);
		const context = handlers.get("context");
		const request = handlers.get("before_provider_request");
		assert.ok(context);
		assert.ok(request);
		delete process.env.HARNESS_LEDGER_REGISTRY;
		assert.throws(() => request(undefined), /Missing HARNESS_LEDGER_REGISTRY/);
		process.env.HARNESS_LEDGER_REGISTRY = join(root, "registry.jsonl");
		const event = {
			messages: [
				{ role: "user", content: "ordinary" },
				{ role: "assistant", content: [{ type: "text", text: "reply" }] },
				{ role: "toolResult", content: [{ type: "text", text: "ignored" }] },
				{ role: "custom", customType: "first", content: "collision" },
				{ role: "custom", customType: "second", content: "collision" },
				{ role: "user", content: "ordinary" },
				{ role: "custom", customType: "fixture", content: "custom" },
				{
					role: "custom",
					customType: "subagent-notification",
					content: [
						{ type: "text", text: "notice" },
						{ type: "image", data: "ignored" },
					],
				},
			],
		};
		const before = structuredClone(event);
		assert.equal(context(event), undefined);
		assert.equal(request(undefined), undefined);
		assert.deepEqual(event, before);
		assert.deepEqual(JSON.parse(readFileSync(join(root, "registry.jsonl"), "utf8")), {
			tools,
			provenance: {
				ordinary: "user",
				reply: "assistant_text",
				collision: "shared",
				custom: "extension:fixture",
				notice: "subagent_notices",
			},
		});
		context({ messages: [] });
		request(undefined);
		assert.deepEqual(JSON.parse(readFileSync(join(root, "registry.jsonl"), "utf8").trim().split("\n")[1] ?? ""), {
			tools,
			provenance: {},
		});
	} finally {
		if (old === undefined) delete process.env.HARNESS_LEDGER_REGISTRY;
		else process.env.HARNESS_LEDGER_REGISTRY = old;
		rmSync(root, { recursive: true });
	}
});
