/**
 * events.ts -- the top-level lifecycle channels this extension emits and listens on `pi.events`.
 * `pi-todo` redeclares them (either package installs without the other);
 * `tests/inprocess/channel-contracts.test.ts` pins the two sets together.
 */

export const SUBAGENT_CREATED_EVENT = "subagents:created";
export const SUBAGENT_STARTED_EVENT = "subagents:started";
export const SUBAGENT_COMPLETED_EVENT = "subagents:completed";
export const SUBAGENT_FAILED_EVENT = "subagents:failed";
/** Asks this extension to re-announce every running background agent that survived a session switch. */
export const SUBAGENT_ANNOUNCE_SURVIVORS_EVENT = "subagents:announce_survivors";
/** A background agent still running for a different session than the one that asked. */
export const SUBAGENT_OTHER_SESSION_SURVIVOR_EVENT = "subagents:other_session_survivor";
