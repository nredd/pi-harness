# Subagents lifecycle coverage

For contributors measuring lifecycle tests, not runtime configuration.
Baseline `b51e1774` includes #182. This PR adds `lifecycle-coverage*.test.ts`,
its `.mjs` extension fixture, and the fixture-local compiler spy correction in
`process-budget.test.ts`. No production/config/dependency/policy/exclusion change.
The merged `166e801a` todo changes and existing source guards are retained.
`src/index.ts` and #193's inspector/viewer/metadata files remain separately owned,
not excluded from measurement.

| Checkpoint | Covered lines | Covered functions |
| --- | ---: | ---: |
| Main `b51e1774` | 6658/7164 | 1351/1423 |
| Final lifecycle tests | 6766/7164 | 1375/1423 |

Close 108 lines and 24 functions; 27 previously gapped modules close completely.
Of 71 lifecycle-owned sources, 67 have full lines/functions. Target is NOT 100%.
All 75 measured sources, per-file denominators and before/final gaps are in
`subagents-lifecycle-files.md`; stable remaining anchors are in
`subagents-lifecycle-remaining.txt`. `subagents-lifecycle-before.txt` records the
baseline gap counts. The expanded command is `subagents-lifecycle-command.txt`.
Istanbul 5.0.3 matches the root Vitest 5.0.3 runner through an ignored tooling link;
no manifest/lock changes. Branches remain report-only.

The older #193 report at `6d7b13cb` has 7161 LF, not 7164. Comparing its actual
complete LCOV with the lifecycle LCOV yields `model-selection.ts 67 -> 68` and
`process-budget.ts 94 -> 96`; the other 73 LF and every FNF are unchanged.
The measured additions correspond to `cheapCompatibility` initialization and
the expanded active-lease loop. All 75 current source files match `b51e1774`
byte-for-byte. No three-line attribution was guessed from a physical diff.

Tests use actual private files, git children, worker threads, faux-backed SDK
sessions, injected owned clocks and explicit promise controls. Non-injectable
Croner/nested timer boundaries use virtual timers. The manager tests set the
public typed record's `outputCleanup`, matching extension wiring; this is boundary
state setup, not a claim that every fixture avoids record mutation. The callback
runs the real `streamToOutputFile` final flush and then throws; assertions read
the JSONL answer, check unsubscribe, and verify the manager clears the callback
without losing the run's verdict. Eviction uses the public `markConsumed` helper,
checks its consumed timestamp, and asserts the oldest two IDs disappear while
the third/newest remain. No private field or arbitrary no-op callback is poked
to manufacture execution.

The failed workflow inspector uses one stable failed record. After its actual
rejection and removal from the runtime source, the unread row must still render.
The failed agent overlay independently must leave `resultConsumed` unset.
Separate exact acknowledgement mutants fail those semantic assertions, not an
unrelated keyboard-consumption assertion. Mutation commands, red outcomes and
byte-exact restoration are recorded in `subagents-lifecycle-mutations.txt`.

Remaining lifecycle-owned gaps:

| Symbol/anchor | Missing L/F | Trace |
| --- | ---: | --- |
| `AgentManager.enqueueStart` grant guard; `startResume` session guard; `cancel: () => {}` | 6/1 | `dequeue` withdraws budget waiters; resume requires a session and sweeps skip queued records; initial cancel is overwritten before use. |
| `observeRun`, `let unsubscribe = () => {}` | 0/1 | Session subscription replaces the initial closure before publication. |
| `FleetList.openSelected`, "no session available" | 2/0 | The openable roster requires a session for non-failure rows; no await separates selection from the guard. |
| Workflow boundary `walk`, final non-object check | 1/0 | Earlier `typeof` branches exhaust non-object values. |

These nine lines/two functions remain intact. Reachability conclusions concern
the current call graph, not permission to remove guards or lower denominators.

Reconciliation with #204 preserves its bounded diagnostic serialization: an unreadable
thrown-value message getter settles with `Workflow threw an unreadable error.` and no
fabricated stack, rather than replacing the original failure with the getter's exception.
The lifecycle regression still uses a real worker and asserts no child was spawned.
The counts and gate receipts below describe the pre-reconciliation measurement.

Fresh gate evidence is in `subagents-lifecycle-gates.txt`. Full Node/Istanbul,
lint/types and pinned Bun native `31 + 10` pass. Full Bun compatibility remains
NOT green: the unchanged #174 authored-stack-location assertion fails. Its
production fix is separately owned; this PR neither duplicates it nor weakens
that test. The historical process-budget mock failure's original cause remains
unproven; the controlled real-compiler namespace reproduction is documented in
`subagents-budget-mock.md`. No root-wide/inprocess gate, live activation, release
or merge is claimed.
