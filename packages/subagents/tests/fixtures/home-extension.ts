/** Bind real extension activation to a disposable home, never a runtime HOME mutation. */
import { makeTestTempDir } from "@nredd/pi-test-lib/temp-dir";
import { afterAll } from "vitest";
import { createSubagentsExtension as createAtHome, type SubagentsExtensionOptions } from "../../src/index.ts";

export {
	type Clock,
	FOREIGN_WORKFLOW_TOOL_NAMES,
	formatToolsSuffix,
	type SubagentsExtensionOptions,
	type TimerHandle,
	WORKFLOW_ENTRY_TYPE,
	WORKFLOW_FILE_FLAG,
	type WorkflowEntryData,
	workflowEntryData,
} from "../../src/index.ts";

const fallbackHome = makeTestTempDir("subagents-extension-home-", afterAll);

export function createSubagentsExtension(options: SubagentsExtensionOptions = {}) {
	return createAtHome({ homeDir: process.env.PI_CODING_AGENT_DIR || fallbackHome, ...options });
}

export default (pi: Parameters<ReturnType<typeof createAtHome>>[0]) => createSubagentsExtension()(pi);
