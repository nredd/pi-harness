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

Initial UI theme per-file missing lines/functions:
- `src/ui/agent-widget.ts`: 15/0 -> 2/0.
- `src/ui/agent-row.ts`: 2/2 -> 2/1.
- `src/ui/fleet-state.ts`: 1/0 -> 0/0.

Additional UI assertions after that measurement cover clearing a stale active
status, queued wording, expanded output capped at 50 lines with a full-output
hint, and static call invalidation. The next full measurement includes them.

The public widget factory renders terminal verdicts, retained turn stats and
session duration. Replacement disposal cannot unregister the new component.
The alert journal uses 129 real alert transitions to exercise an unread overflow
attempt changing kind, then restores and acknowledges it, independently checking
all four exact persisted counters. Tool-row ticking uses an injected FakeClock.

Mutation batch: replace every non-success finished wording, wrong turn count,
incorrect repeated-search plural, invert replacement-dispose identity guard,
and fail to decrement the previous overflow kind. Dedicated UI suite exits 1
before source restoration. No production edit remains.

Gate at the first theme: full single-worker Istanbul suite, pinned Bun 1.3.14
native session/compatibility suites, lint and typecheck pass. Additional UI cases
pass focused tests, lint and typecheck. Full final evidence follows with later
coherent module closures. No root-wide suite duplicated; resource snapshots
precede full runs and tests are serialized alongside other active coverage agents.
