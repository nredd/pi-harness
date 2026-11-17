import assert from "node:assert/strict";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import extensionInventory from "./extension_inventory.ts";

test("the inventory tool reports the registry's tools and commands as it runs", async () => {
	const tools: ToolDefinition[] = [];
	let registered = [{ name: "read" }];
	const api = {
		registerTool: (tool: ToolDefinition) => tools.push(tool),
		getAllTools: () => registered,
		getCommands: () => [{ name: "plan" }, { name: "todos" }],
	} as unknown as ExtensionAPI;
	extensionInventory(api);
	const [tool] = tools;
	assert.ok(tool);
	assert.equal(tool.name, "harness_extension_inventory");
	assert.equal(tool.exposure, "direct");
	// Read at execute time, not registration: a tool registered later still shows up.
	registered = [{ name: "read" }, { name: "harness_extension_inventory" }];
	const result = await tool.execute("call-1", {}, undefined, undefined, {} as never);
	assert.deepEqual(result, {
		details: {},
		content: [
			{
				type: "text",
				text: JSON.stringify({ tools: ["read", "harness_extension_inventory"], commands: ["plan", "todos"] }),
			},
		],
	});
});
