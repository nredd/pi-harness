/** Script only the LLM boundary; admission, settle and wakeups stay in real managers. */
export const runs = new Map();
export function runAgent(_ctx, _type, _prompt, options) {
  const session = { dispose() {}, async steer() {} };
  options.onSessionCreated?.(session);
  return new Promise(resolve => {
    const finish = () => resolve({ responseText: "done", session, aborted: false, steered: false });
    runs.set(options.agentId, finish);
    options.signal?.addEventListener("abort", finish, { once: true });
  });
}
export const resumeAgent = runAgent;
