# Rebase onto released 2.13.9

Base: rpiv-mono `54df50eea935fc9753edc300d5f23c5e28d906d7`, subtree split
`7903c76b85a3b64e6685b084548589a4c50b5c0b`. Replay all seven patches from
`09e102b70869d59156411f6e9940ac08ea7d0622..v2.12.0-nredd.6`, not the local
branch, which lacked the seventh patch. No unreleased main source is included.

## Conflict resolutions

- Patch 2, `index.ts`, `state/state.ts`, `todo-overlay.ts`, `tool/response-envelope.ts`:
  retain Plan registration, `PlanRef`, headings and progress imports with upstream `.ts` specifiers.
- Patch 2, `state/replay.ts`: retain Plan metadata and, after the queue, combine validated
  replay with upstream custom-entry precedence and explicit legacy migration below.
- Patch 2, `state/state-reducer.test.ts`: retain policy tests and upstream `changesState` tests.
- Patch 2, `todo.ts`: retain mutation-time persistence plus Plan deferral notification.
- Patch 3, `state/i18n-bridge.ts`, `todo-overlay.ts`: retain fork counts/scroll imports as `.ts`.
- Patch 3, `state/state-reducer.ts`: retain batch input types plus upstream persistence helper.
- Patch 3, `todo.ts`: persist the final atomic call result, not a single operation's result.
- Patch 6, `index.ts`: retain `collapseOnResume` configuration with `.ts` imports.
- Patch 7, `docs/tool-schema.md`: document both validated historical replay and custom persistence.
- Patch 7, `state/replay.ts`: keep snapshot validation and historical Plan metadata, then
  reconcile precedence explicitly rather than choosing either side wholesale.
- Patch 7, `state/state-reducer.test.ts`: retain both immutable batch outcome and persistence tests.
- Patch 7, `todo.ts`: retain historical render snapshots and net deferral notification alongside persistence.
- Remove the silently duplicated `STATE_ENTRY_TYPE`; move all fork changelog entries to `[Unreleased]`.

## Persistence decisions and tests

- Persist every state-changing call, including atomic `ops` batches, once at its final state.
  `changesState` recurses over committed batch outcomes. Failed batches have no committed
  outcomes; reads and no-op batches do not persist. `todo.persistence.test.ts` checks all
  of these, Plan metadata, evidence, deferral reasons, history immutability, clear and id reuse.
- Mark new custom snapshots, including Plan approvals, with `persistenceVersion: 1`.
  Legacy fork snapshots have `plan` but no marker and were followed by tool-result-only
  mutations. Replay them chronologically until the first authoritative custom entry.
  `state/replay.test.ts` contains the audit `replay-probe.mjs` completion regression,
  mixed legacy/new migration, new Plan approval and nested metadata isolation cases.
- Preserve upstream authority for unmarked custom snapshots without `plan`, and for all
  snapshots after the new marker. Stale outer/read results cannot override a newer nested
  mutation. Keep upstream's state-entry precedence tests unchanged.
- Clone replayed nested metadata and preserve `plan`/`PlanRef`; retain validation and
  historical completions without evidence. Require evidence on every new completion.
- Keep upstream's real AgentSession/codemode/persist/reopen test, supplying completion
  evidence and checking its displayed value in `todo.codemode-replay.test.ts`.
- Convert fork-only imports to `.ts`. Replace private mouse/settlement compatibility
  shims with Pi 1.1.0 public `TuiMouseEvent`, `AgentBeforeSettleEvent`,
  `AgentBeforeSettleEventResult` and `SessionBoundaryDraft` types.

## Package gate

Apply the patch queue into a full monorepo clone at the release commit with
`git format-patch --stdout upstream/2.13.9..HEAD | git am --directory=packages/rpiv-todo`.
Run only the package gate:

```sh
npm ci --ignore-scripts
npx biome check --error-on-warnings packages/rpiv-todo
npx tsc --noEmit -p tsconfig.base.json
npx vitest run packages/rpiv-todo
```

The untouched release dependency graph fails importing Pi: coding-agent 1.1.0 resolves
agent-core, codemode, mcp and chord 1.3.0; codemode no longer exports
`MCP_TYPESCRIPT_PREAMBLE`. Reproduced on stock release `state/replay.test.ts`, not just
our candidate. For gate-only compatibility, override those four siblings to `1.1.0`
in the scratch monorepo, refresh its lockfile with `npm install --ignore-scripts`, then
rerun `npm ci --ignore-scripts` and the exact gate above. These scratch root/lock changes
are not in the split fork and do not adopt unreleased main. Keep the vanilla-gate
failure distinct from the compatible-host result.

Logs: `~/code/pi-harness-builds/rebase-rpiv-todo/`. The matching candidate Gitlink is
also checked in pi-harness `integration/inprocess` on its released, pinned host.
No tag, release or install/pin promotion is part of this rebase.
