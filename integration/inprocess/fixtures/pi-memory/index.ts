/** Inert declarations make exclude_extensions observable without memory or network state. */
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function memoryDeclarations(pi: ExtensionAPI): void {
	for (const name of ["memory_write", "scratchpad"])
		pi.registerTool(
			defineTool({
				name,
				label: name,
				description: "Inert memory declaration for scope testing",
				parameters: Type.Object({}),
				execute: async () => {
					throw new Error("Scope test must not execute memory tools");
				},
			}),
		);
}
