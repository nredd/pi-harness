/** Test-only registry observation; production factories still register every capability. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function extensionInventory(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "harness_extension_inventory",
		label: "Extension inventory",
		description: "Inspect the real loaded extension registry for the stack gate.",
		parameters: Type.Object({}),
		exposure: "direct",
		async execute() {
			return {
				details: {},
				content: [
					{
						type: "text",
						text: JSON.stringify({
							tools: pi.getAllTools().map((t) => t.name),
							commands: pi.getCommands().map((c) => c.name),
						}),
					},
				],
			};
		},
	});
}
