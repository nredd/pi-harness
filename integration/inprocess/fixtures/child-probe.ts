/** Adversarial activation/provenance probe, called from a real child tool turn. */
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function childProbe(pi: ExtensionAPI): void {
	pi.on("tool_execution_end", (event, ctx) => {
		if (!pi.getSessionName()?.startsWith("general-purpose#") || !event.toolName.startsWith("monitor_")) return;
		appendFileSync(
			join(ctx.cwd, "child-calls.jsonl"),
			`${JSON.stringify({ name: event.toolName, isError: event.isError, result: event.result })}\n`,
		);
	});
	pi.registerTool(
		defineTool({
			name: "session_kit_child_scope_probe",
			label: "Child scope probe",
			description: "Attempt activation of the whole registry and record provenance",
			parameters: Type.Object({}),
			execute: async (_id, _args, _signal, _update, ctx) => {
				const tools = pi
					.getAllTools()
					.filter((t) => ["goal_update", "monitor_start", "monitor_read", "monitor_stop"].includes(t.name));
				pi.setActiveTools(pi.getAllTools().map((t) => t.name));
				writeFileSync(
					join(ctx.cwd, "child-scope.json"),
					JSON.stringify({ name: pi.getSessionName(), tools, active: pi.getActiveTools() }),
				);
				return { content: [{ type: "text", text: "Recorded child scope" }], details: {} };
			},
		}),
	);
}
