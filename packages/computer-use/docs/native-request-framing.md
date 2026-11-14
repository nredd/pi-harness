# Native request framing tests

`request_framing_tests.swift` exercises actual `Bridge` buffering, NDJSON responses, completion
bookkeeping and argument coercion. Dispatch, session reads and output syscalls are injected;
all test instances also pass `activityGlow: nil` to avoid eagerly constructing the glow controller's
`NSScreen`/`NSWindow` objects. Production defaults still create the real glow controller and use
the real command router, CG session and transport. Tests cover
split UTF-8 frames, invalid input, exact error envelopes, response-before-completion ordering,
32-ID recency/eviction, short writes and silent write failures. A disposable socket pair also
exercises the default `Darwin.send` writer without connecting to the daemon.

Stdio does not record completions. Socket requests record processing completion even if writing
their response fails. Missing or non-string IDs retain the `invalid` fallback. Malformed JSON
retains `internal_error`; a parsed non-object gets `invalid_request`. Numeric parsers retain
Foundation coercion, including booleans as numbers and truncated fractional integers; this is
not stricter wire validation.

Only missing/unknown commands and locked-session refusal enter the real command router in these
tests. No successful platform command, shutdown, TCC read, desktop input or capture is exercised.
The complete production inventory remains in LLVM coverage, including unexecuted live handlers.
Swift reports lines/functions/regions, not Istanbul branches/statements. The unreachable string
UTF-8 conversion failure and redundant numeric-cast fallbacks remain unclaimed guards, not exclusions.

Run `npm test -- test/macos-native-pure.test.mjs --coverage.enabled=false`. The producer compiles with `-j 1`, warnings as errors and source
coverage enabled. `scripts/check-sync-reverts.mjs` independently breaks completion eviction and the short-write
pointer offset and requires these assertions to fail. Non-macOS runs explicitly skip native tests.
