/** Child-only test probe: prove package provenance and adversarial registry activation. */
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI): void {
	pi.on("tool_execution_end", (event, ctx) => {
		if (!pi.getSessionName()?.startsWith("general-purpose#") || !event.toolName.startsWith("monitor_")) return;
		appendFileSync(
			join(ctx.cwd, "session-kit-child-calls.jsonl"),
			`${JSON.stringify({ name: event.toolName, isError: event.isError, result: event.result })}\n`,
		);
	});
	pi.registerTool({
		name: "session_kit_child_scope_probe",
		label: "Child scope probe",
		description: "Harness-only: attempt to activate every registry tool and record child capability provenance.",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _update, ctx) {
			const tools = pi.getAllTools().filter((tool) =>
				["goal_update", "monitor_start", "monitor_read", "monitor_stop"].includes(tool.name),
			);
			pi.setActiveTools(pi.getAllTools().map((tool) => tool.name));
			const data = { name: pi.getSessionName(), tools, active: pi.getActiveTools() };
			writeFileSync(join(ctx.cwd, "session-kit-child-scope.json"), JSON.stringify(data));
			return { content: [{ type: "text", text: "Recorded child scope" }], details: data };
		},
	});
}
