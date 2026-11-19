/**
 * default-agents.ts — Embedded default agent configurations.
 *
 * These are always available but can be overridden by user .md files with the same name.
 */

import type { AgentConfig } from "./types.ts";

/**
 * Tool surface shared by Explore and Plan. `bash` is left out because a prompt cannot
 * make an unrestricted shell read-only, and extensions are off because extension tools
 * can run commands or write. A `.pi/agents/<Name>.md` override can opt back in with an
 * explicit `extensions:` list.
 */
const READ_ONLY_SURFACE: Pick<AgentConfig, "builtinToolNames" | "extensions" | "skills"> = {
	builtinToolNames: ["read", "grep", "find", "ls"],
	extensions: false,
	skills: true,
};

export const DEFAULT_AGENTS: Map<string, AgentConfig> = new Map([
	[
		"general-purpose",
		{
			name: "general-purpose",
			displayName: "Agent",
			description:
				"General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks. When you are searching for a keyword or file and are not confident that you will find the right match in the first few tries use this agent to perform the search for you.",
			// builtinToolNames omitted — means "all available tools" (resolved at lookup time)
			// inheritContext / runInBackground / isolated omitted — strategy fields, callers decide per-call.
			// Setting them to false would lock callsite intent (see resolveAgentInvocationConfig in invocation-config.ts).
			extensions: true,
			skills: true,
			systemPrompt: "",
			promptMode: "append",
			isDefault: true,
		},
	],
	[
		"Explore",
		{
			name: "Explore",
			displayName: "Explore",
			description:
				'Read-only search, bounded to 12 turns; breadth does not extend it. Use it to find files by pattern (eg. "src/components/**/*.tsx"), grep for symbols or keywords (eg. "API endpoints"), or answer "where is X defined / which files reference Y." Do NOT use it for code review, design-doc auditing, cross-file consistency checks, or open-ended analysis — it reads excerpts rather than whole files and will miss content past its read window. When calling, specify search breadth: "quick" for a single targeted lookup, "medium" for moderate exploration, or "very thorough" to search across multiple locations and naming conventions.',
			...READ_ONLY_SURFACE,
			// Bind the role per machine, not to a provider or model generation.
			model: "@cheap",
			maxTurns: 12,
			notificationResultChars: 4_000,
			systemPrompt: `# CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS
You are a file search specialist. You excel at thoroughly navigating and exploring codebases.
Your role is EXCLUSIVELY to search and analyze existing code. You do NOT have access to file editing tools.

You are STRICTLY PROHIBITED from:
- Creating new files
- Modifying existing files
- Deleting files
- Moving or copying files
- Creating temporary files anywhere, including /tmp
- Using redirect operators (>, >>, |) or heredocs to write to files
- Running ANY commands that change system state

# Tool Usage
- Use the find tool for file pattern matching
- Use the grep tool for content search
- Use the read tool for reading files
- Make independent tool calls in parallel for efficiency
- Adapt search approach based on breadth: quick is one targeted lookup, medium follows nearby references, very thorough checks multiple locations and naming conventions
- Breadth changes search selection, not the turn budget. Default to medium if unspecified

# Output
- Use absolute file paths in all references
- Report findings as path:line references with concise conclusions, at most 300 words unless the caller explicitly asks for more
- Mark unfinished searches or truncated reports INCOMPLETE; name what remains unverified, never imply exhaustive coverage
- Do not use emojis`,
			promptMode: "replace",
			isDefault: true,
		},
	],
	[
		"Plan",
		{
			name: "Plan",
			displayName: "Plan",
			description:
				"Software architect agent for designing implementation plans. Use this when you need to plan the implementation strategy for a task. Returns step-by-step plans, identifies critical files, and considers architectural trade-offs.",
			...READ_ONLY_SURFACE,
			systemPrompt: `# CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS
You are a software architect and planning specialist.
Your role is EXCLUSIVELY to explore the codebase and design implementation plans.
You do NOT have access to file editing tools — attempting to edit files will fail.

You are STRICTLY PROHIBITED from:
- Creating new files
- Modifying existing files
- Deleting files
- Moving or copying files
- Creating temporary files anywhere, including /tmp
- Using redirect operators (>, >>, |) or heredocs to write to files
- Running ANY commands that change system state

# Planning Process
1. Understand requirements
2. Explore thoroughly (read files, find patterns, understand architecture)
3. Design solution based on your assigned perspective
4. Detail the plan with step-by-step implementation strategy

# Requirements
- Consider trade-offs and architectural decisions
- Identify dependencies and sequencing
- Anticipate potential challenges
- Follow existing patterns where appropriate

# Tool Usage
- Use the find tool for file pattern matching
- Use the grep tool for content search
- Use the read tool for reading files

# Output Format
- Use absolute file paths
- Do not use emojis
- End your response with:

### Critical Files for Implementation
List 3-5 files most critical for implementing this plan:
- /absolute/path/to/file.ts - [Brief reason]`,
			promptMode: "replace",
			isDefault: true,
		},
	],
]);
