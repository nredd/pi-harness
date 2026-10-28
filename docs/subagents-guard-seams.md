# Subagents guard seams

For maintainers extending behavioral fault-injection coverage. Supersedes the open
counter dispositions in `subagents-residual-closure.md`, not its historical receipts.
A retained guard without a reachable fixture is a testbench gap, not an exemption.

## Stack and wiring

Branch `redd/guard-seams-subagents` starts at #210 (`2fed3c14`), plain-merges
#196 (`3a047c75`, including the shutdown-timer fix), then plain-merges #193
(`b54c3e58`). #193's newer viewer/menu/meta tests were absent from #210; they are
inherited here, not duplicated or attributed to this change. No rebase, force push,
merge to main, release, coverage/config/provider change, or exclusion.

The only production change adds an optional, internal final `FleetList` constructor
option, `sessionFor(record)`. The default still reads `record.session` at the same
point. The lookup result is captured once and passed to the viewer. No tool,
setting, RPC, package entry point, or default behavior changes. Tests never invoke
private closures directly or poison records to reach a guard.

## Per-guard fixture and outcome

| Guard | Seam / behavioral test | Observable outcome |
| --- | --- | --- |
| Group member-format catch | Spy on the existing `usage.getSessionContextPercent` export during real turn-group delivery; throw for one child's session only. `skips only the unformattable group member and delivers its healthy sibling` | One notice contains only the healthy sibling; the failed member's result remains retrievable. |
| `startScheduler` outer catch | `ScheduleStore.prototype.list` throws once during the real bound startup. `contains a store failure during scheduler startup and keeps the Agent tool usable` | Exact startup warning, ordinary readiness, no scheduler-ready claim, subsequent real child succeeds. |
| Background post-resume guards (helper and tool caller) | `AgentManager.prototype.resume` returns undefined through the registered Agent tool. `reports a collaborator's refused resume (background=true)` | Exact failure response, prior result preserved, no second provider call or created event. |
| Foreground post-resume guard | Same real exported collaborator seam, foreground parameterized case. | Same failure contract; cleanup completes without inventing a result. |
| Scheduling already-enabled branch | Two real SettingsList dialogs built before either toggles the row, coordinated by a promise barrier. `preserves state when overlapping dialogs both disable schedulingEnabled` | Second dialog reports already disabled; only one settings-changed event and persisted false. |
| Workflows already-enabled branch | Same overlapping-dialog ordering, `workflowsEnabled` case. | Second dialog reports already disabled without repersisting or rebroadcasting. |
| Rejected detached wait | `AgentManager.prototype.waitForAll` rejects once after a real child survives reload. `consumes a rejected detached wait without disposing a still-running survivor` | No unhandled rejection, no premature disposal, detached row survives and child completes. Explicit fixture teardown follows. |
| Manager stale grant | Spy on `enqueueBudget`: register with the real budget but return a faulty no-op cancellation. Stop via public `abort`; the real budget pump later delivers its stale grant. `returns a late budget grant after a faulty cancellation without starting the stopped child` | Stopped child never runs; late lease returned; budget active/pending both zero. The test does not call the grant closure. |
| Manager resume session guard | `tryAcquireBudget` synchronously calls public `clearCompleted` before returning a real lease, modeling reentrant collaborator eviction. `releases admission when a reentrant budget collaborator evicts the resume session` | No runner call without a session, lease returned, subsequent child starts normally. |
| Fleet session guard | Internal `sessionFor` returns undefined after the real roster admits the row. `reports a session lost by its lookup collaborator without opening or acknowledging a viewer` | Exact info notice, no overlay or consumption, navigation still works. Separate healthy lookup control opens normally. |

Additional whole-package counters:

- Spy on `usage.getLifetimeCost` only during real live-continuation steering. Assert
  the formatted priced usage is present in the returned state summary; Faux's
  native usage intentionally has zero cost, so this is a pricing-collaborator
  fixture, not a claim that Faux itself bills tokens.
- Spy on the existing `Script.prototype.runInContext` method to return null, a
  primitive, or an array. `extractMeta` rejects with its object-literal diagnostic;
  restoring the collaborator parses the same valid source normally.
- The real ScrollView collaborator invalidates its content before rendering.
  Assert live text updates remain visible and old text disappears. This reaches
  the retained empty content invalidator through `ScrollView.invalidate`, never
  by calling the private closure.

## Mutation receipts

Every mutation below exited 1 under the one-worker Node runner, with the named
behavioral test selected using `-t`; all source edits were restored afterwards.

| Mutation | Red outcome |
| --- | --- |
| Rethrow the group member formatting failure | Turn-end delivery rejects instead of delivering its healthy member. |
| Rethrow scheduler startup failure | Bound session startup rejects instead of warning and remaining usable. |
| Replace background helper undefined return with throw | Background refusal test rejects. |
| Replace background tool failure response with throw (helper restored) | Background refusal test rejects. |
| Replace foreground tool failure response with throw | Foreground refusal test rejects. |
| Force each settings equality guard false | Both overlapping-dialog cases lose the exact already-disabled outcome and single-event contract. |
| Remove the detached wait rejection callback | Vitest reports the unhandled rejected wait. |
| Disable stale-grant guard | Stopped record runs again; runner call count/state assertion fails. |
| Disable sessionless-resume guard | The runner is called without a session; no-run assertion fails. |
| Disable fleet session guard | Overlay creation is attempted without a session rather than showing the info notice. |
| Suppress the steering cost append | Priced state-summary assertion fails. |
| Disable metadata object-shape guard | All three fault cases lose the object-literal diagnostic. |
| Make the empty content invalidator throw | Real scrolling collaborator invalidation fails instead of preserving renderable text. |

Removing the content invalidator property alone is an equivalent mutation: Pi's
Container invalidates children with optional chaining, so that experiment stayed
green. It is not claimed as a killed mutant. Its throwing mutation exercises the
observable no-crash contract. This is an extra callback counter, not one of the
listed defensive guards.

## Verification

Existing Istanbul configuration, all 75 `src` files, no file/provider/config changes.
Root Vitest 5.0.3 resolves an ignored tooling symlink to Istanbul 5.0.3; the committed
package-local 4.1.x dependency and lockfile are unchanged. Bun is the committed
1.3.14 pin, supplied on PATH from an external tooling install.

```sh
cd packages/subagents
npm run lint
npm run typecheck
node ../../scripts/run-vitest.ts node --maxWorkers=1 --coverage \
  --coverage.reporter=json --coverage.reporter=json-summary
node ../../scripts/run-vitest.ts bun --maxWorkers=1
npm run test:bun
```

Final full-package receipts after the last test edit:

- Lint: 268 files checked, no fixes, exit 0. Typecheck: exit 0.
- Node/Istanbul: 174 files passed; 3691 tests passed, 8 skipped; exit 0,
  192.48 seconds, one worker. All 75 sources: **7163/7163 lines (100%)**,
  **1421/1421 functions (100%)**. Statements 8309/8413 (98.76%);
  branches 6383/6834 (93.40%), report-only.
- Bun 1.3.14 full Vitest: 173 files passed, 1 failed; 3691 tests passed,
  1 failed, 7 skipped; exit 1, 141.01 seconds, one worker. The sole failure
  remains `workflow-runtime.test.ts`, authored stack location: expected
  `workflow.js:3:`, received `workflow.js:4:23`. #204 is still open; its fix
  was not merged or duplicated here. This is the owner's permitted exception,
  not a green full Bun claim.
- Pinned native Bun: 31 tests passed across four files, plus 10 resource-loader
  tests passed; exit 0. No other failure accepted.

No root-wide `make check`, live-provider/desktop gate, activation, merge to main
or release is claimed.
