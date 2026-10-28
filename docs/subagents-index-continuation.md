# Index callback continuation

PR #201 continuation from `a04a6cd1`, after the correction worker committed in
this worktree. The continuation changes only
`test/index-coverage-final-lifecycle.test.ts` and this new note. Both older
coverage documents are owned by #198's documentation fixer and were not edited.
`c49b6429` is already included in #198. Never push this work to #198's branch.

No production, dependency, provider configuration, policy, shared fixture or
coverage configuration changes. No exclusions, counter hooks, private closure
calls or guard deletions. Source `index.ts` SHA-256:
`f5f3768af97cf1d1269fc4ba72563493f1580cbf65917f05c168ff33dcbde431`.

Measurements:

| Checkpoint | Index lines | Index functions | Missing lines/functions |
| --- | ---: | ---: | ---: |
| Latest main `166e801a` inventory, re-measured | 1085/1437 | 218/251 | 352/33 |
| Historical #198 `afd32e60` | 1399/1437 | 243/251 | 38/8 |
| Historical c49 three-case theme | 1402/1437 | 246/251 | 35/5 |
| This continuation, full Node suite | 1428/1437 | 250/251 | 9/1 |

The latest-main measurement runs all 156 test files tracked by `166e801a` from
this worktree, after verifying its production source, exact Vitest config,
shared helpers, home setup and dependency lock match main. It is a main-test
inventory run against identical code, not a second checkout or a combined PR
coverage estimate. Exact argv/inventory: `/tmp/subagents-index-main-command.json`.
The final run uses ordinary full-suite discovery. Both use the existing
Istanbul configuration, all `src/**/*.ts`, unchanged denominators and one worker.
Independent #193 coverage is not included and must be measured after integration,
not added arithmetically.

Boundary and isolation:

- Reuse `hermeticDir`, `makePi`, `ctx`, `startSession`, `FakeClock`, provider
  answers and promise barriers. Clear the public manager registry symbol before
  each case and after cleanup, rather than inheriting another activation.
- Inject the private fixture home explicitly; actual child resource loading must
  not discover the workstation's global skills/extensions.
- Script provider answers and UI selections/keystrokes. The fixture event bus
  automatically acknowledges `router:rpc:admit`; that advisory-service double
  bypasses quota routing only. The manager, runner, real child sessions, filesystem,
  SettingsList, workflow worker, inspector and viewer remain real.
- Return registered tools from the fixture host's tool registry. A competing
  workflow registration exercises actual collision withdrawal and CLI refusal.
- The failed-worktree case executes actual `git` processes in a non-repository
  fixture through the host's `exec` boundary. No runner/manager stub manufactures
  a sessionless record.

Cases now total 22 in this file, not three. The historical receipt is specifically
98 original #198 cases + c49's three = 101. This continuation adds 19 cases and
strengthens those original three. Do not label later suites with the historical
101 count. All 22 pass under Node and Bun.

Behavior added:

- Wait on a pool-queued background resume, then return only its new result.
  Background resume queueing does NOT populate `startGate`, unlike fresh spawns.
  The timeout executor in `get_subagent_result` is a live public path, not dead
  legacy code. No callback was removed.
- Report a real hard turn-cap abort when a provider still requests tools during
  the mandatory final-report turn.
- Render the resolved provider for a trusted model alias in the actual type
  picker; handle removal of the last type or a consumed/completed record while
  its parent menu choice remains open; reject viewing a queued child's absent
  session instead of borrowing its sibling's.
- Restore branch disclosure through `session_tree`, verified by subsequent
  journaled toggles. Reject malformed project frontmatter during canonical strict
  bind. Refuse resume of a genuinely queued worktree startup failure with no
  session.
- Reject inactive scheduling after `session_before_switch`; report real write
  failures without claiming success; cancel the selected persisted job through
  the registered menu. Preserve fallback tool contracts for empty/unreadable
  custom descriptions.
- Withdraw the default workflow tool for a competing orchestrator, report it in
  headless mode and refuse its CLI flag. Report invalid CLI metadata. Run the
  real worker/child despite an unwritable script persistence path.
- Open a live workflow child's conversation from the actual fleet inspector,
  exercising index's current-context and record callbacks. This is index wiring,
  not a duplicate of #193's isolated inspector/viewer/meta component tests.
- Preserve the child's real output transcript when a held notice cannot spool
  during reload. Restore the exact grouped identity set, with no extra member.
  Steer the original survivor to the second actual provider answer, consume that
  response and assert no stop toast; verify stop and disposal separately.

Verified mutation receipt:

Before and after the following independent runs, the restored focused suite is
`1 passed` file, `22 passed` tests. Every run uses:

```sh
../../node_modules/.bin/vitest run test/index-coverage-final-lifecycle.test.ts --maxWorkers=1
```

| Logical mutation | Concrete break | Red outcome |
| --- | --- | --- |
| Queued resume waiter | Do not resolve the queued polling timeout | 1 failed / 21 passed |
| Hard turn-cap notification | Label aborted as Done | 1 / 21 |
| Alias model disclosure | Return only the requested label | 1 / 21 |
| Removed type-list race | Claim agents exist on empty type list | 1 / 21 |
| Consumed running-list race | Claim agents exist on empty running list | 1 / 21 |
| Queued viewer identity | Label queued as expired | 1 / 21 |
| Branch disclosure reload | Skip `restoreFleetDisclosure` on `session_tree` | 1 / 21 |
| Canonical strict startup | Throw plain Error instead of StartupError | 1 / 21 |
| Resume missing session | Claim a sessionless record resumed | 1 / 21 |
| Empty custom description | Suppress empty-file warning | 1 / 21 |
| Unreadable custom description | Suppress read-error warning | 1 / 21 |
| Inactive scheduler refusal | Claim scheduling succeeded | 1 / 21 |
| Schedule persistence failure | Claim success after write exception | 1 / 21 |
| Scheduler menu routing | Skip `showSchedulesMenu` | 1 / 21 |
| Collision tool withdrawal | Keep our tool active | 1 / 21 |
| Headless CLI diagnostic | Suppress CLI report | 1 / 21 |
| Workflow inspector record | Look up a wrong child id | 1 / 21 |
| CLI metadata diagnostic | Claim startup rather than metadata warning | 1 / 21 |
| Workflow persistence diagnostic | Suppress script persistence warning | 1 / 21 |
| Held-notice spool warning | Suppress failed transfer warning | 1 / 21 |
| Exact grouped identity | Duplicate the first member in `others` | 1 / 21 |
| Retained grouped delivery | Skip draining restored notices | 1 / 21 |
| Retained survivor stop | Abort an unknown survivor id | 1 / 21 |
| Retained survivor steer | Steer an unknown survivor id | 1 / 21 |
| Retained survivor disposal | Do not dispose the settled detached manager | 2 / 20 |

All 25 exit 1; source restored after each. Raw verified output:
`/tmp/index-continuation-verified-mutations.log`. Earlier exploratory mutation
runs are NOT this receipt: a title-sensitive menu fixture was corrected, then
all 25 were rerun from a passing 22-case baseline. c49's historical four-mutation
receipt is independently preserved in PR #201 comment `6473939959`.

Exact gate receipts:

```text
Latest-main inventory: 156 files
Test Files  1 failed | 155 passed (156)
Tests       2 failed | 3447 passed | 8 skipped (3457)

Full Node 26.12.0 / Vitest 5.0.3 / Istanbul:
Test Files  1 failed | 159 passed (160)
Tests       2 failed | 3567 passed | 8 skipped (3577)

Full Bun 1.3.14 / Vitest 5.0.3:
Test Files  2 failed | 158 passed (160)
Tests       3 failed | 3567 passed | 7 skipped (3577)

Pinned Bun native scenarios: 31 pass, 0 fail
Pinned Bun home-loader compatibility: 10 pass
Package lint: 254 files clean
Package typecheck: tsc --noEmit, exit 0
```

Node and Bun both retain the two baseline `process-budget.test.ts` missing
`ModuleKind` failures. Bun also retains #174's workflow stack-location assertion.
The lifecycle author's `5e8a741b` fix is not included; this branch never edits
that test. Different runtime skip counts are reported as executed, not normalized.
Package typecheck is the existing production-source typecheck, not a claim that
its tsconfig includes all test stubs. No root-wide gate or live install was run.

Final commands, from `packages/subagents`:

```sh
../../node_modules/.bin/vitest run --maxWorkers=1 --coverage \
  --coverage.provider=istanbul --coverage.reporter=lcov --coverage.reporter=text \
  --coverage.reportOnFailure --coverage.reportsDirectory=/tmp/subagents-index-continuation-final
npm exec --yes --package=bun@1.3.14 -- node ../../scripts/run-vitest.ts bun --maxWorkers=1
npm exec --yes --package=bun@1.3.14 -- npm run test:bun
npm run lint
npm run typecheck
```

Logs: `/tmp/subagents-index-continuation-final-{node,bun,native,lint,types}.log`;
LCOV: `/tmp/subagents-index-continuation-final/lcov.info`. Baseline log/LCOV:
`/tmp/subagents-index-main-166e801{.log,/lcov.info}`. Resource snapshots preceded
full runs. Independent lifecycle, policy, Bun, audit and documentation work was
active. Full runs and mutations were serialized locally, each with one worker.

Remaining measurement offsets, tied to unchanged source:

```text
Lines (9): 525,921,948,2334,2376,3550,3551,4288,4300
Function (1): FN:1351,(anonymous_88)
```

Caller/data-flow audit, with no speculative cleanup:

- `GroupJoinManager`'s member-format catch: the callback is reached from
  `registerTurnGroup`/retroactive completion, `onAgentComplete` and shutdown's
  `flushPending`. Its records originate in the real manager registry. Normal
  records initialize usage/description/status; session-stat failures are already
  caught by `getSessionContextPercent`. The catch protects stale/corrupt/future
  record shapes. No supported case was found that makes formatting throw without
  replacing a record or its getters. Retain the safety path.
- `startScheduler`'s outer catch: its index caller is `session_start`, guarded by
  enabled/not-active checks. Session id/path construction precede `ScheduleStore`
  construction; store loading catches I/O/parse failures, and `scheduleJob` catches
  arming failures. Real add/write errors and stopped-scheduler refusal are covered
  through the public tool. A host accessor, injected clock or future store can
  still throw at startup. This is retained exception safety, not proven removable
  code; no synthetic host throw was added merely to touch its counter.
- Canonical bind's plain rethrow: `session_start` computes `strictLoad` and calls
  `reloadCustomAgents(strictLoad)`. Strict mode requires the host StartupError
  export before binding, and the tested strict-load failure takes the wrapped
  StartupError branch. Ordinary non-strict file errors are skipped/warned by the
  loader. The other throw preserves unexpected failures. Retain it.
- Both post-resume undefined guards: the Agent tool first checks the real record,
  its session and terminal status. Background `startBackgroundResume` performs
  synchronous setup before `manager.resume`; foreground invokes that same manager
  after UI setup. `AgentManager.resume`'s undefined exits are its initial missing
  session or running/queued checks, before its first await. Later budget waiting
  returns the captured record even when stopped. Normal callers cannot produce
  those undefined results after the tool's checks without reentrant host changes
  or record manipulation. Do not remove guards intended for such context changes.
- `showAgentDetail` missing-config warning: its only index caller is
  `showAllAgentsList`, whose `selected && getAgentConfig(selected)` check immediately
  invokes the async function. Its body reads config before its first await; no
  normal asynchronous removal can interleave. Actual removals while the picker is
  open are handled by the caller guard, covered without private calls. Keep the
  additional context-safety check.
- Settings' already-enabled branches: the only `applyValue` callers are the real
  SettingsList on-change callback and the numeric-input branch. These two IDs are
  not numeric. SettingsList supplies the next value; the closure's boolean has not
  otherwise changed before that callback. Normal toggles always take the mutation
  branch. No direct callback invocation was used to fake an unchanged selection.
- Empty rejected-wait callback: its only registration is detached
  `session_shutdown` after `manager.detach()` reports survivors. `waitForAll`
  drains the budget, collects startup/run/queue-left promises and awaits
  `Promise.allSettled`, so ordinary child failures cannot reject it. Its synchronous
  budget pumping can still surface an invariant/host failure. The empty handler
  CONSUMES that rejection; removing the handler can turn it into an unhandled
  rejection on the ignored chained promise. Its empty body is not proof that its
  registration is behaviorless. The fulfilled disposal callback is separately
  mutation-tested. No cleanup is proposed on this branch.

Status: 9 lines/1 function remain. Full gates retain known failures. No 100%,
provider-inconsistency or universal-unreachability claim. The guards remain
intact because current-public-path evidence does not justify deleting runtime
context safety to satisfy a coverage denominator.
