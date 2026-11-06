/**
 * error-message.ts — the text a caught value reports.
 *
 * `catch` binds `unknown`: an `Error` gives its message, and anything else a
 * caller threw (a string, a rejected non-Error) is stringified as-is.
 */

/** The message of `error` when it is an `Error`, else `String(error)`. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
