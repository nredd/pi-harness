/**
 * The pi host SDK names the reload bundle imports. `/reload` reloads the
 * extension, never the host, and the scenario never calls into it: booting the
 * real SDK in a cold child only spent the test's wall-clock budget.
 *
 * Consequence: the tool factories return `[]`, so the bundled
 * `BUILTIN_TOOL_NAMES` (`src/agent-types.ts`) is empty. Its readers live in the
 * real runner, `index.ts` and `custom-agents.ts`, none of which are bundled; the
 * test asserts the bundle keeps no reader. They cannot throw instead, because
 * `agent-types.ts` calls them at module load.
 *
 * `getAgentDir` throws so a scenario that starts depending on the host fails
 * loudly instead of reading the real agent directory. A new named import from
 * the SDK fails the bundle with `MISSING_EXPORT`.
 */
export function getAgentDir() {
  throw new Error("budget reload fixture: the scenario must not read the host agent directory");
}
export const createCodingTools = () => [];
export const createReadOnlyTools = () => [];
