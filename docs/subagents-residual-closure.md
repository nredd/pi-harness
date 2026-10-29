# Subagents residual closure

For maintainers auditing the last index and lifecycle coverage counters. This is
partial closure, not a 100% claim. No coverage/config/provider/policy changes,
exclusions, private-closure calls, merges to main, or releases.

## Starting point and measurement

Created `redd/cov-subagents-residual` from #203's `6319bf72`, then plain-merged
`origin/redd/cov-subagents-lifecycle` (#196, `f143d053`). No rebase or force push.
Both test sets are present; the inherited lifecycle merge also contains already
reviewed todo changes. Those are not newly authored residual work. Then plain-merged
#203 at `557a4df8`, including #198's canonical-temp-root fix (`6de369e4`).
The separately owned #196 stale-context timer fix had not yet been pushed at
this measurement; no independent patch to those tests is included.

The fresh baseline uses the existing Istanbul configuration and all package tests:

```sh
cd packages/subagents
node ../../scripts/run-vitest.ts node --maxWorkers=1 --coverage \
  --coverage.reporter=json --coverage.reporter=json-summary
```

The lockfile installs root Vitest 5.0.3 and package-local Vitest 4.1.12. As in
#196/#203, the root runner uses an ignored tooling symlink to Istanbul 5.0.3.
No manifest, lockfile, provider, coverage configuration or threshold is changed.
The JSON reporters only expose the existing instrumentation counters.

Baseline: 170 files; 3645 passed, 8 skipped; 7111/7164 lines, 1408/1423 functions.
The fresh index baseline is 1426/1437 lines, 250/251 functions, not the historical
1428/1437. The extra two misses are `steer_subagent`'s optional cost-formatting
lines. They are reported separately rather than attributed to the requested nine.

## Closed counters and exhaustive dead-code proofs

- **Canonical-bind plain rethrow: tested, retained.** A project agent containing
  valid YAML `tools: {toString: not-callable}` parses successfully. On canonical
  trusted bind, `loadCustomAgents` -> `loadFromDir` -> `loadOneFile` ->
  `parseToolsField` -> `csvList` -> `parseCsvField` calls `String(val)` outside
  `readAgentFile`'s catch. The non-callable `toString` causes a real TypeError.
  `session_start` must reject, without `subagents:ready` or child calls. Removing
  the file and retrying the same registered lifecycle handler succeeds. This is
  malformed on-disk input, not a mocked loader or a private callback.
- **Detail-menu warning: remove the redundant lookup, preserve the stale-picker
  guard.** `showAgentDetail` has exactly one caller, `showAllAgentsList`. That
  caller awaits the real picker, resolves the selected string with
  `getAgentConfig`, and rejects a missing config. Previously the callee immediately
  repeated that lookup before its first await. `getAgentConfig` ->
  `getAgentConfigIn` -> `resolveKeyIn` uses only the module-owned Map and the
  primitive selected string; there are no host calls, callbacks, getters on
  configs, or awaits between lookups. `registerAgents` is the sole map writer;
  nothing in this synchronous interval invokes it. Pass the already-validated
  config instead. The caller's guard remains. A public test removes the selected
  file while the real SettingsList is open, reloads through the registered Agent
  tool, presses Enter, and asserts that no detail menu opens or child runs.
- **Manager initial `cancel` no-op: remove dead initializer.** `enqueueStart` is
  the only QueueEntry constructor. It creates `left` (its Promise executor only
  assigns `markLeft`), constructs the entry, calls `enqueueBudget`, then publishes
  it with `queue.push`. `enqueueBudget` only appends its waiter and returns the
  actual cancellation closure; it never calls `ready`, `grant`, or `pumpBudget`.
  Previously the placeholder was overwritten before publication. The sole
  `entry.cancel()` caller is `dequeue`, which can only iterate published entries.
  All dequeue callers (`abort`, `abortAll`, `detach`, `dispose`) therefore see the
  real cancellation function, never the placeholder. Initialize `cancel` from
  `enqueueBudget` directly. Its `grant` captures `entry`, but cannot run before
  construction/publication completes. The grant's stale-record guard remains.
- **Runner initial `unsubscribe` no-op: remove dead initializer.** `observeRun`
  is called only by `runAgent` and `resumeAgent`. It builds a local live state
  object, subscribes the session observer, and returns it; no callback accesses
  `run.unsubscribe`, and the object never escapes before return. Both callers
  call `unsubscribe` only from their prompt `finally` blocks, after `observeRun`
  has returned. If subscription throws, neither caller receives a run object.
  Keep the same captured live object and attach the actual subscription cleanup
  with `Object.assign`. No placeholder, wrapper, optional cleanup, copied flags,
  or weakened subscription contract remains.
- **Workflow `walk`: tested, retained.** The historical lifecycle audit names the
  final non-object check, but the fresh Istanbul zero-hit line is the nested
  `undefined` throw. Public `runWorkflow` tests reject `{private: undefined}` and
  `[undefined]` with the exact offending path, before spawning; a control with
  omitted top-level args still completes. Do not remove the validation guard.

Mutation proofs, each restored byte-for-byte and followed by green controls:

- Remove canonical-bind `throw err`: the test resolves `"bound"` instead of
  rejecting with TypeError, exit 1.
- Remove `cfg` from the retained picker guard: the removed-type test enters the
  detail menu with no config and fails, exit 1.
- Replace the nested-undefined throw with `return`: both path assertions resolve
  instead of rejecting, exit 1.

## Retained, open safety counters

These are not proven unreachable across supported host/boundary behavior. No
synthetic record poisoning or private-closure invocation is used to hit them.

| Counter | Caller/await/dataflow trace and reason to retain |
| --- | --- |
| Group member-format catch | `registerTurnGroup` passes real records for retroactive completion; normal completion uses `groupJoin.onAgentComplete`; shutdown uses `flushPending`. Formatting reads result/description/error, lifetime usage and session context. Normal manager records initialize these, and session-stat failures are handled inside `getSessionContextPercent`. The public registry and manager callbacks expose live records to other extensions, so an exhaustive invariant over external consumers is unavailable. Keep the per-member failure containment, rather than assuming every future/foreign record is pristine. |
| `startScheduler` outer catch | Called only by `session_start` when enabled and inactive. Session id access and `resolveStorePath` precede `ScheduleStore`; loading handles read/parse errors, and `scheduleJob` catches timer-arming errors. No natural filesystem input found that escapes those catches. Host accessor and event-bus failures are not ruled out. Keep the outer exception boundary; no manufactured throwing accessor test is counted. |
| Background post-resume undefined guard | Agent tool validates existence/session/terminal status. `startBackgroundResume` then constructs transcript paths, reads host session id, writes transcript metadata, and builds activity before calling `manager.resume`. The manager can return undefined only at its initial missing-session/running/queued checks, before its first await; once admitted, it returns its captured record even when stopped while waiting. The transcript/host setup interval prevents a universal no-reentrancy proof. Retain. |
| Foreground post-resume undefined guard | Same initial tool validation; activity registration, widget/fleet timers and `fleet.update` precede `manager.resume`. UI callbacks run in that interval. Manager's undefined exits are still pre-await; later budget waiting returns a record. Host reentrancy cannot be excluded. Retain. |
| Scheduling already-enabled branch | `applyValue` is called by the real SettingsList callback or numeric input; this id is not in `NUMERIC_IDS`. The row cycles `on/off`, updates its own currentValue and invokes the callback synchronously. Ordinary toggles necessarily differ. No exhaustive proof for reentrant/overlapping host dialogs, or a supported same-value public selection, was established. Retain. |
| Workflows already-enabled branch | Same list/numeric trace, plus `resolveWorkflowCollisions` can change the effective workflows boolean at canonical bind. Ordinary post-bind toggles differ, but a universal lifecycle/dialog ordering proof is missing. Retain. |
| Rejected-wait callback | Registered only when shutdown `detach()` reports survivors. `waitForAll` first pumps budget, gathers startup/run/queue-left promises, then awaits `Promise.allSettled` in a loop. Ordinary child rejection cannot reject it, but synchronous budget invariants/host failures may. The rejection callback deliberately consumes rejection on an ignored chained promise. Keep it: deleting it can introduce unhandled rejection. |
| Manager `grant` stale-record guard, 3L | `spawn` and background/foreground `resume` enqueue. Grant removes the entry before validating map identity and queued status. `abort`, `abortAll`, `detach` and `dispose` normally cancel through `dequeue` before grant; sweeps/clear skip queued records. Public record access and foreign manager callbacks mean the stronger global identity/status invariant is not established. Retain lease return and queue release. |
| Manager `startResume` session guard, 3L | Only background `resume` calls it, immediately or via the budget queue. Initial resume requires a session and sets queued status before publication. `cleanup`/`clearCompleted` skip queued records; record removal is the only internal clearing assignment to session. Still, session references are exposed across the host boundary and queued time permits external changes. Keep the lease-release/drain guard. |
| Fleet sessionless non-failure guard, 2L | `handleKey(Enter)` -> `openSelected` rebuilds its roster synchronously. Ordinary non-failure rows require a session; outstanding failures without one take the preceding error/acknowledgement path. Source callbacks, clock and journal ingress participate in roster construction; external records remain mutable. A universal no-reentrancy/immutable-record proof is absent. Keep the guard rather than opening an invalid viewer. |

Other gaps in conversation-viewer, workflow-menu and workflow-meta remain outside
this residual scope. This document supersedes only the counter identification and
specific closed dispositions above, not the earlier audits' other evidence.

## Final measurement and gate evidence

| Scope | Before L | After L | Before F | After F |
| --- | ---: | ---: | ---: | ---: |
| All 75 sources | 7111/7164 | 7111/7160 | 1408/1423 | 1408/1421 |
| Index | 1426/1437 | 1426/1434 | 250/251 | 250/251 |
| Manager | 590/596 | 589/595 | 114/115 | 114/114 |
| Runner | 447/447 | 447/447 | 83/84 | 83/83 |
| Fleet list | 388/390 | 388/390 | 105/105 | 105/105 |
| Workflow runtime | 318/319 | 319/319 | 44/44 | 44/44 |

Missing counts decrease from 53L/15F to **49L/13F**. The originally requested
index residuals are now **6L/1F**, plus the fresh baseline's two optional steering
cost lines (**8L/1F measured index**). Requested non-index residuals are **8L/0F**:
manager 6L, fleet 2L; runner and runtime close fully. The other 33L/12F remain in
separately owned viewer/menu/meta files. Branches remain report-only:
6321/6829 (92.56%). Removed dead initializers change denominators, not provider
behavior or exclusions. The runner's added real-cleanup assignment is executable;
there is no claim that every removed physical line lowers Istanbul's denominator.

- Full final Node/Istanbul: **171 files passed, 3650 tests passed, 8 skipped**,
  exit 0, one worker. The extra file/test is the plain-merged #198 path regression.
- `npm run lint`, `npm run typecheck`, `npm run build`: exit 0.
- Full final Bun Vitest with pinned 1.3.14: **170 files passed, 1 failed; 3650 tests
  passed, 1 failed, 7 skipped**, exit 1, one worker. The sole
  failure is unchanged `workflow-runtime.test.ts`, authored stack location:
  expected `workflow.js:3:`, received a different authored line. This is the
  already documented, separately owned #174 failure. No production runtime,
  worker-source, or stack-location assertion is changed here.
- Pinned `npm run test:bun`: **31 native tests + 10 resource-loader tests passed**,
  exit 0. Ambient Bun 1.4.4 was also attempted: full Vitest had the same stack
  failure, and the resource-loader suite correctly rejected its version against
  the committed `.bun-version` (1.3.14). No pin/config change was made to hide it.
- Root-wide `make check`, live-provider/desktop tests, activation, merge and release
  were not run. Full Bun compatibility is **not green**; this PR is not a claim
  of completed global coverage or release readiness.
