# Index callback coverage and safety boundaries

For maintainers of `packages/subagents/src/index.ts`: public-path coverage and
caller/data-flow reasons to retain the remaining safety guards.

`packages/subagents/test/index-coverage-final-lifecycle.test.ts` exercises 22 cases
through registered tools, menus and lifecycle hooks, with real managers, child
sessions, workflow workers, viewers and private files. It reuses the existing
hermetic-home, host, clock, provider and promise-barrier helpers; clears the manager
registry between activations; and explicitly resets effective setting defaults.
The event-bus admission auto-ack doubles only the advisory quota service. Child
resource loading uses the injected private home. The failed-worktree case executes
an absolute Git binary with private configuration, an allowlisted environment and
`GIT_CEILING_DIRECTORIES` bounded to the resolved fixture home, and requires the
real "fatal: not a git repository" cause before testing sessionless resume refusal.

Behavior covered:

- Wait for a pool-queued background resume and return only its new result.
  Unlike fresh spawns, background resume queueing does not populate `startGate`;
  the `get_subagent_result` timeout executor is a live public path.
- Report a hard turn-cap abort when the mandatory final-report turn requests tools.
- Disclose an alias's resolved provider in the type picker; handle removed types
  and consumed records while menu choices remain open; reject a queued child's
  viewer without borrowing a sibling's session.
- Restore branch disclosure on `session_tree`; reject malformed frontmatter during
  canonical strict bind; refuse resume after real worktree startup failure.
- Reject stopped scheduling and actual persistence failures without claiming
  success; cancel a persisted job through its menu; preserve fallback tool
  contracts for empty or unreadable custom descriptions.
- Withdraw a colliding workflow tool and diagnose headless/CLI refusal or invalid
  metadata; run the real worker/child despite blocked script persistence; open its
  conversation through the fleet inspector's current-context and record callbacks.
  This tests index wiring, not isolated inspector/viewer/meta components.
- Preserve a child's transcript after held-notice spool failure; restore exactly
  the grouped member identities once; steer a retained survivor to and consume its
  second provider answer without a stop toast; verify stop and disposal separately.

Historical measurement, not a fresh claim: the recorded full Node run at the
previously reviewed HEAD measured **1428/1437 lines, 250/251 functions**, leaving
**9 lines and 1 function**. Its matching-main test inventory measured 1085/1437
lines and 218/251 functions against identical production source, configuration,
helpers and lockfile. Independent component coverage is not included or added
arithmetically. Exact commands, stdout, 25 named red mutations and restoration
proof are durable [here](https://github.com/nredd/pi-harness/pull/203#issuecomment-6475183038),
with the corresponding review receipt [here](https://github.com/nredd/pi-harness/pull/203#issuecomment-6475187537).
Those full gates were NOT green: the measured dependency tree retained the
`ModuleKind` baseline failures and Bun's workflow stack-location failure. These
are scoped historical results, not universal installation or current-gate claims.

Remaining caller/data-flow proof in `src/index.ts`:

- **`GroupJoinManager` member-format catch:** `registerTurnGroup`/retroactive
  completion, `onAgentComplete` and shutdown's `flushPending` supply real registry
  records. Normal records initialize usage/description/status; session-stat errors
  are caught by `getSessionContextPercent`. Stale, corrupt or future record shapes
  can still throw. No supported public case was found without replacing records
  or getters; retain the catch.
- **`startScheduler` outer catch:** `session_start` guards enabled/not-active state.
  Session id/path construction precedes `ScheduleStore`; loading catches I/O/parse
  errors and `scheduleJob` catches arming errors. Public tests cover actual writes
  and stopped-scheduler refusal. Host accessors, clocks or future stores can still
  throw at startup; retain exception safety rather than synthesize a counter hit.
- **Canonical bind plain rethrow:** `session_start` computes `strictLoad` and calls
  `reloadCustomAgents(strictLoad)`. Strict mode requires the host StartupError
  export before binding; tested strict-load errors take the wrapped StartupError
  branch. Non-strict file errors are skipped/warned by the loader. Unexpected
  failures still need the plain rethrow.
- **Two post-resume undefined guards:** the Agent tool checks the record, session
  and terminal status. Background `startBackgroundResume` sets up synchronously
  before `manager.resume`; foreground calls the same manager after UI setup.
  `AgentManager.resume` exits undefined only for initial missing-session or
  running/queued checks before its first await. Later budget waiting returns the
  captured record even if stopped. Normal callers cannot reach these results
  after tool validation without reentrant host changes or record manipulation;
  retain both guards for context changes.
- **`showAgentDetail` missing-config warning:** its only index caller,
  `showAllAgentsList`, checks `selected && getAgentConfig(selected)` immediately
  before calling. The callee reads config before its first await, preventing
  ordinary asynchronous removal between checks. Picker-open removal is covered
  through the caller guard; retain the callee's additional context-safety check.
- **Settings already-enabled branches:** `applyValue` is called only by the real
  SettingsList on-change callback and numeric input. These two IDs are not numeric;
  SettingsList supplies the next value while the captured boolean is unchanged.
  Normal toggles mutate it. Do not fake unchanged selections with private callbacks.
- **No-op rejected-wait callback:** detached `session_shutdown` registers it only
  after `manager.detach()` reports survivors. `waitForAll` drains the budget,
  collects startup/run/queue-left promises and uses `Promise.allSettled`, so ordinary
  child failures cannot reject it. Synchronous budget pumping can still surface
  invariant/host failures. This handler consumes rejection; deleting its
  registration can create an unhandled rejection on the ignored chained promise.
  The fulfilled disposal callback has separate mutation proof.

No production guards are deleted, no coverage exclusions are added, and no 100%,
provider-inconsistency or universal-unreachability claim follows from this audit.
