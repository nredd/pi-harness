/** Read-only source/provenance evidence; request byte accounting stays in Python. */
import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function requestLedgerProbe(pi: ExtensionAPI): void {
	let provenance: Record<string, string> = {};
	pi.on("context", (event) => {
		provenance = {};
		for (const message of event.messages) {
			if (message.role !== "custom" && message.role !== "user" && message.role !== "assistant") continue;
			const category =
				message.role === "custom"
					? ["subagent-notification", "subagent-reaped"].includes(message.customType)
						? "subagent_notices"
						: `extension:${message.customType}`
					: message.role === "assistant"
						? "assistant_text"
						: "user";
			const texts =
				typeof message.content === "string"
					? [message.content]
					: message.content.flatMap((block) => (block.type === "text" ? [block.text] : []));
			for (const text of texts) {
				const previous = provenance[text];
				provenance[text] = previous && previous !== category ? "shared" : category;
			}
		}
	});
	pi.on("before_provider_request", () => {
		const destination = process.env.HARNESS_LEDGER_REGISTRY;
		if (!destination) throw new Error("Missing HARNESS_LEDGER_REGISTRY");
		appendFileSync(
			destination,
			`${JSON.stringify({ tools: pi.getAllTools().map(({ name, sourceInfo }) => ({ name, sourceInfo })), provenance })}\n`,
		);
	});
}
