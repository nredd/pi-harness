/** Inert declarations: the stack tests scope, never network implementations. */
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function webDeclarations(pi: ExtensionAPI): void {
	for (const name of ["web_search", "fetch_content", "source_check", "get_search_content"])
		pi.registerTool(
			defineTool({
				name,
				label: name,
				description: "Inert web declaration for scope testing",
				parameters: Type.Object({}),
				execute: async () => {
					throw new Error("Scope test must not execute web tools");
				},
			}),
		);
}
