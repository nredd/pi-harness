/** Child tool adapter for root-scoped discovery; keeps the manager storage SDK-independent. */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type AgentRoster, LIST_AGENTS, rosterJson } from "./agent-roster.ts";
import { buildAgentRegistry, getAvailableTypesIn, resolveTypeIn } from "./agent-types.ts";
import { loadCustomAgents } from "./custom-agents.ts";
import type { AgentConfig } from "./types.ts";

/** Optional for older/headless hosts: absence must produce an explicit unavailable result. */
export interface RosterRuntime {
	parentAgentId: string;
	manager: { roster?: AgentRoster };
}

/** Opt-in is the agent's explicit `tools: list_agents` plus an effective `allowed_subagents` list. */
export function createRosterTools(options: {
	config: AgentConfig | undefined;
	isolated: boolean | undefined;
	runtime: RosterRuntime | undefined;
	homeDir: string | undefined;
	configCwd: string;
	projectTrusted: boolean;
}) {
	const { config, isolated, runtime } = options;
	if (
		isolated ||
		!config?.builtinToolNames?.includes(LIST_AGENTS) ||
		!config.allowedSubagents ||
		config.disallowedTools?.includes(LIST_AGENTS)
	)
		return [];
	const grants = config.allowedSubagents;
	return [
		defineTool({
			name: LIST_AGENTS,
			label: "List Agents",
			description: "Read authorized same-root agent metadata (untrusted text); no results or messaging.",
			parameters: Type.Object({}),
			execute: async () => {
				if (!runtime?.manager.roster)
					return {
						content: [{ type: "text" as const, text: "Agent roster unavailable: host has no root-scoped roster API." }],
						isError: true,
						details: {},
					};
				const registry = buildAgentRegistry(
					loadCustomAgents(options.configCwd, false, {
						homeDir: options.homeDir,
						projectTrusted: options.projectTrusted,
					}),
				);
				const granted =
					grants === "all" ? undefined : new Set(grants.map((name) => resolveTypeIn(registry, name) ?? name));
				const allowed = new Set(getAvailableTypesIn(registry).filter((name) => !granted || granted.has(name)));
				try {
					const result = runtime.manager.roster.child(runtime.parentAgentId, allowed);
					return { content: [{ type: "text" as const, text: rosterJson(result) }], details: {} };
				} catch (error) {
					return { content: [{ type: "text" as const, text: String(error) }], isError: true, details: {} };
				}
			},
		}),
	];
}
