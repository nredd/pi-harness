/** Publish the child session's own registry, not the parent's registry or inferred tool owners. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function ledgerChild(pi: ExtensionAPI): void {
	pi.on("before_agent_start", (_event, ctx) => {
		const owners = Object.fromEntries(pi.getAllTools().map(({ name, sourceInfo }) => [name, sourceInfo.source]));
		writeFileSync(join(ctx.cwd, "ledger-child-owners.json"), JSON.stringify(owners));
	});
}
