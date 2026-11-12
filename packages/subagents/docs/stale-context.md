# Stale extension contexts

For contributors diagnosing a child that fails before output or between tools.

A stale-context diagnostic is not proof that the user requested `/reload`. Core
also invalidates contexts on session replacement and disposal. The original
invalidation event in #779 remains unknown; the retained report contains no trace
that identifies it.

The deterministic reproduction in `test/stale-ctx-captured.test.ts` uses the real
released core, a faux physical provider, the assembled `Agent` tool and manager,
and a virtual route that captures another session's extension context. Disposing
that owner invokes core's `AgentSession.dispose()` -> `ExtensionRunner.invalidate()`
-> runtime invalidation. Reading the captured context then hits core's active-context
guard and produces the original diagnostic. The route's supplied requesting-child
context is still valid. This distinguishes an extension closure retaining its owner
from core handing the route an already-invalid requesting context.

The child inherits the parent registry's shared model runtime in `runAgent`.
Creating another child does not recreate the virtual route's closure. Both the
before-first-response case and the held-tool case therefore fail again on a second
fresh `Agent` call while the parent remains usable. The test checks the saved core
session and output transcript after each terminal result; the held tool is retained
in history, never replayed. Existing persistence/output opt-outs still apply.

Previously `retryStaleCtx` appended continuation prompts to that same session after
1s, 3s and 9s. Nothing in that path acquired a successor context or rebuilt the
route. Removing those prompts is the terminal-outcome contract: preserve the
original error/history, report an unknown invalidation trigger and do not attempt
structured-output or turn-limit follow-ups on the invalid runtime. The public
extension API offers no way to rewrite another extension's captured closure, so
this change does not claim transparent recovery or automatic success.

The requesting-context path already fixed by #581 remains covered in
`test/stale-ctx-recovery.test.ts`: a child survives the parent's real reload gap,
and stale parent-bound usage observers cannot fail its turn. This change does not
alter core, router policy, model selection, release pins or the live installation.

Run from `packages/subagents`:

```sh
node ../../scripts/run-vitest.ts node test/stale-ctx-captured.test.ts test/stale-ctx-recovery.test.ts test/stale-ctx-followups.test.ts --coverage.enabled=false --maxWorkers=1
node ../../scripts/run-vitest.ts bun test/stale-ctx-captured.test.ts test/stale-ctx-recovery.test.ts test/stale-ctx-followups.test.ts --coverage.enabled=false --maxWorkers=1
```

On the original runner, both captured-context cases fail with
`stale context must settle without backoff or a doomed prompt: expected false to be true`.
The fixture aborts unfinished children during cleanup, including on a failing assertion.
These synthetic transcripts contain no operator prompts, credentials or live providers.
