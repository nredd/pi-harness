/**
 * stale-ctx.ts -- recognising pi's "extension ctx is stale" failure.
 *
 * pi invalidates an extension runner on reload and on session replacement
 * (/new, /fork, /resume). Anything that still reaches the old runner or its
 * `pi` throws this message (#145).
 */

/** Matched on the stable prefix of core's message. */
export const STALE_CTX_RE = /extension ctx is stale after session replacement or reload/i;

/** Whether `error` (an `Error` or a message string) is the stale-ctx failure. */
export function isStaleCtxError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return STALE_CTX_RE.test(message);
}
