# Subagents lifecycle coverage

Baseline `b51e1774` (main, including #182). This branch deliberately leaves
`src/index.ts` and #193's inspector/viewer/metadata surfaces and tests untouched.
Only dedicated `test/lifecycle-coverage*.test.ts` files are added. No policy,
config, dependency, exclusion, HOME mutation or production change.

Istanbul measurement uses the same 75 explicit owned sources as #162's read-only
phase0 config. The exact expanded executed command is retained in
`subagents-lifecycle-command.txt`; before/remaining inventories report exact
uncovered line locations and function labels, pinned to this source revision.
The root Vitest 5.0.3 uses the ignored Istanbul 5.0.3 tooling link (the existing
package provider dependency is nested at 4.x). No manifests or lockfiles change.

| Checkpoint | Lines covered | Functions covered |
| --- | ---: | ---: |
| Current main | 6658/7164 | 1351/1423 |
| Initial UI theme measurement | 6672/7164 | 1352/1423 |
| Wave 3 (before final protocol/transcript cases) | 6761/7164 | 1375/1423 |

Initial UI theme per-file missing lines/functions:
- `src/ui/agent-widget.ts`: 15/0 -> 2/0.
- `src/ui/agent-row.ts`: 2/2 -> 2/1.
- `src/ui/fleet-state.ts`: 1/0 -> 0/0.

Additional UI assertions after that measurement cover clearing a stale active
status, queued wording, expanded output capped at 50 lines with a full-output
hint, and static call invalidation. The next full measurement includes them.

UI completion adds failed-overlay non-acknowledgement, viewer disposal, missing
workflow inspection, manager stop/steer routing, theme invalidation, queued rows,
bounded expanded results and multi-model notices. A mutated fleet rejection path
that acknowledges failure makes the failed-record assertion fail. UI widget,
row, journal, notification, card and dialog functions now have full lines/functions;
the fleet's filtered-out no-session wording is retained.

The public widget factory renders terminal verdicts, retained turn stats and
session duration. Replacement disposal cannot unregister the new component.
The alert journal uses 129 real alert transitions to exercise an unread overflow
attempt changing kind, then restores and acknowledges it, independently checking
all four exact persisted counters. Tool-row ticking uses an injected FakeClock.

Manager/workflow theme: real control promises drive detached resume telemetry,
parent abort, throwing startup/completion observers, output-cleanup failures,
queued detach and 502 evictions with exact newest/oldest assertions. Real workers
exercise queued skip/cancel, spawn/load failures, hostile diagnostic getters and
an unknown RPC envelope injected at Node's public worker event boundary. Host
resume after actual manager eviction fails honestly; explicit nested script files
load from private roots. Mutation batches change compaction count, eviction bound
and detached verdict (three failures), and queued skip/host error/worker error
(four failures). The protocol fatal-bit mutation also fails its envelope assertion.

Mutation batch: replace every non-success finished wording, wrong turn count,
incorrect repeated-search plural, invert replacement-dispose identity guard,
and fail to decrement the previous overflow kind. Dedicated UI suite exits 1
before source restoration. No production edit remains.

Private persistence theme: real permission/lock failures, malformed settings and
private manifests, invalid YAML, schema serialization/getter/pattern errors,
historical tier provenance, and disappearing files at exists/stat/realpath
boundaries. Race fixtures remove actual private files; only the triggering FS
boundary is wrapped. A real git child removes its disposable repository between
validation and toplevel lookup. Mutating exclusive lock creation to overwrite
and accepting invalid manifests produces five failures. Wrong toplevel wording
fails the real-git race assertion. No owned source is deleted or weakened.

Gate at the first theme: full single-worker Istanbul suite, pinned Bun 1.3.14
native session/compatibility suites, lint and typecheck pass. Additional UI cases
pass focused tests, lint and typecheck. Full final evidence follows with later
coherent module closures. The genuine full Bun compatibility run is NOT green:
its remaining #174 source-location failure is recorded in `subagents-budget-mock.md`. No root-wide suite duplicated; resource snapshots
precede full runs and tests are serialized alongside other active coverage agents.
