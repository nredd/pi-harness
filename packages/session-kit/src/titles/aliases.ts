/** Reads machine-local model aliases from `<agent dir>/enterprise.local.json`; nothing else is read. */

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { type ModelAliases, parseModelAliases } from "./logic.ts";

const MANIFEST_NAME = "enterprise.local.json";

/** Aliases from the manifest in `agentDir`; empty when missing, unreadable, or invalid. Never logs. */
export function loadModelAliases(
	agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(homedir(), ".pi", "agent"),
): ModelAliases {
	try {
		const file = path.join(agentDir, MANIFEST_NAME);
		return parseModelAliases(readFileSync(file, "utf8"), statSync(file).mode & 0o777);
	} catch {
		return {};
	}
}
