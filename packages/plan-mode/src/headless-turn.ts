import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

/** How long a sent Plan-mode message may take to start its run before the command gives up waiting. */
export const HEADLESS_TURN_START_TIMEOUT_MS = 5_000;

export interface HeadlessTurn {
  /** Wait until the turn sent during the command has run, if one was sent. */
  settle(): Promise<void>;
}

/**
 * Makes `/plan` commands that send a model turn finish only after that turn, in print and JSON
 * mode.
 *
 * `pi.sendUserMessage` is fire-and-forget: the run starts several awaits later, so
 * `ctx.waitForIdle()` right after sending still sees an idle session. Print mode treats a
 * returned command as done and moves on (or exits), leaving the turn persisted but unanswered,
 * and the next prompt fails with "Agent is already processing a prompt". So the command arms a
 * turn before it runs, `agent_start` marks the run as started, and `settle()` waits for that
 * start, then for idle. A send that never starts a run (rejected input, an extension handled
 * it) stops waiting after `startTimeoutMs`. Interactive and RPC modes keep returning at once:
 * there the user keeps the editor while the turn runs.
 */
export function createHeadlessTurns(startTimeoutMs = HEADLESS_TURN_START_TIMEOUT_MS) {
  let armed: { sent: boolean; started: boolean; onStart?: () => void } | undefined;

  return {
    /** Call from `agent_start`. */
    runStarted() {
      if (!armed) return;
      armed.started = true;
      armed.onStart?.();
    },
    /** Call whenever a Plan-mode message was handed to `pi.sendUserMessage`. */
    messageSent() {
      if (armed) armed.sent = true;
    },
    /** Arm before running a command; `undefined` outside print/JSON mode. */
    arm(ctx: Pick<ExtensionCommandContext, "mode" | "waitForIdle">): HeadlessTurn | undefined {
      if (ctx.mode !== "print" && ctx.mode !== "json") return undefined;
      const turn: { sent: boolean; started: boolean; onStart?: () => void } = { sent: false, started: false };
      armed = turn;
      return {
        async settle() {
          try {
            if (!turn.sent) return;
            if (!turn.started) {
              let timer: ReturnType<typeof setTimeout> | undefined;
              const started = await new Promise<boolean>((resolve) => {
                turn.onStart = () => resolve(true);
                timer = setTimeout(() => resolve(false), startTimeoutMs);
                timer.unref?.();
              });
              clearTimeout(timer);
              if (!started) return;
            }
            await ctx.waitForIdle();
          } finally {
            if (armed === turn) armed = undefined;
          }
        },
      };
    },
  };
}
