/**
 * The pi host SDK names the reload bundle imports. `/reload` reloads the
 * extension, never the host, and the scenario never calls into it: booting the
 * real SDK in a cold child only spent the test's wall-clock budget.
 * `getAgentDir` throws so a scenario that starts depending on the host fails
 * loudly instead of reading the real agent directory.
 */
export function getAgentDir() {
  throw new Error("budget reload fixture: the scenario must not read the host agent directory");
}
export const createCodingTools = () => [];
export const createReadOnlyTools = () => [];
