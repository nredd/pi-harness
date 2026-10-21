# Fork ownership

`forks/` contains upstream-derived repositories. Most remain Gitlinks; imported packages retain their
source Gitlink during the staged migration. Inspect them with `git submodule status`; do not maintain a
second list of release pins here.

| Submodule | Upstream | Build ownership |
|---|---|---|
| `forks/pi` | `earendil-works/pi` | Core npm workspace, standalone Bun build, native helpers |
| `forks/pi-subagents` | `tintinweb/pi-subagents` | Source Gitlink retained while `packages/subagents` is the imported `@nredd/pi-subagents` workspace |
| `forks/pi-plan-mode` | `narumiruna/pi-extensions`, `packages/pi-plan-mode` | Standalone vendored build/test harness |
| `forks/rpiv-todo` | `juicesharp/rpiv-mono`, `packages/rpiv-todo` | Subtree-split package; standalone npm/Bun gate since `v2.13.9-nredd.2`. Imported as `packages/todo` (subtree `ff7bb03` from fork `9a4e2e8`); the Gitlink remains the native-gate source until the shipped-selection PR |
| `forks/pi-computer-use` | `injaneity/pi-computer-use` | Fork tests and native-helper build |

The initial Gitlinks select published fork tags already used by the existing installation. Adding
those Gitlinks does not establish Bun compatibility or rerun the fork gates. Native lockfiles,
licenses, source histories, and build procedures remain owned by their respective repositories. The
`packages/subagents` subtree imports `nredd/pi-subagents` commit
`526fa2df76ba85df31bd14a843fae370e8efe78a` (`v0.22.0-nredd.5`) with its history; its Gitlink and
`forks.yml` job remain until the shipped-selection PR changes the stack to npm.
The selected `forks/pi-subagents` commit is additionally exercised with the real packed preset and
dev-tools by `make check-fork-package-contracts` ([details](package-contracts.md)); it refuses a missing,
dirty or Gitlink-mismatched fork and never bootstraps or installs into it.
`packages/plan-mode` imports `nredd/pi-plan-mode` commit
`4c2bfc3459b07b294efab62e9a8a01849f67a831` (`v0.59.3-nredd.1`) with its history; its Gitlink and
`forks.yml` job remain until the shipped-selection PR changes the stack to npm. Its packed-tarball stock
contract is `make check-plan-mode-package-contract` ([details](package-contracts.md)).
A normal clone has the fork as `origin`; add the upstream remote explicitly when maintaining a patch
queue. Follow each fork's contributor instructions before making changes.

Fork changes:

1. Use a dedicated checkout/worktree in the fork repository; do not modify installed package output.
2. Run the native gate and the applicable candidate integration tests.
3. Open a fork PR and obtain both mandatory reviewer-subagent reports on its final HEAD.
4. Publish the reviewed fork commit before opening the parent Gitlink update PR.
5. Gate and review the parent PR independently, then record the [release manifest](releases.md). No tag or pin promotion from unreviewed commits.

Parent Git worktrees isolate owned files, but do **not** automatically isolate submodule work. Do not
assume a clean parent checkout proves every fork is clean. Initialization/update must preflight all
initialized submodules and refuse dirty tracked, staged, or untracked state before changing any fork.
Do not use `--force`, discard changes, or clean a fork to make bootstrap succeed.

The top-level owned-code check is not a substitute for these fork gates or the full assembled-stack
verification. Authenticated-provider and physical-desktop checks are separate manual evidence.

Upstream candidates in the core patch queue:

- `@earendil-works/pi-coding-agent/testing` (nredd/pi#4): exports the suite harness (`createHarness`, a real
  `AgentSession` around a scripted faux provider) so extension packages test in-process instead of launching
  pi. Only `dist/testing/` is added to the package; `dist/bundle` is byte-identical to `v1.3.0-nredd.3`
- In-process TUI testing (nredd/pi#5): `@earendil-works/pi-tui/testing` (`VirtualTerminal`), `TUI.flushRender()`,
  `@earendil-works/pi-coding-agent/testing/interactive` (`createInteractiveHarness` on the real `InteractiveMode`).
  Optional `InteractiveMode` seams change `dist/bundle`; pi-tui gains an `exports` map (Breaking Changes).
  nredd/pi#6 (`v1.3.0-nredd.6`) fixes what #5 broke in the full fork suite: harness auth identity, faux
  re-registration on reload, a `settle()` that awaits submitted editor work (`onEditorSubmit`), the pi-tui runner

pi-subagents patch queue:

- Base: tintinweb master `ca93a5247e72e7053fcd10bea7125d6c4205f949`, five unreleased commits after
  `v0.22.0`; release branch `nredd/v0.22.0-ca93a52`, selected tag `v0.22.0-nredd.5` (nredd/pi-subagents#5/#6/#7).
  The upstream audit confirms nicobailon/pi-subagents is an independent project, not our upstream
- Retain explicit/model-map/enterprise alias precedence and newest-enabled fuzzy resolution, router admission,
  quota parking/re-admission/refusal, session-scoped detached delivery, bounded tool-free final reports,
  child nesting/workflow refusals, read/unread TTL/tombstones, queued steering, canonical project trust and
  strict startup, named-cwd worktrees, package-directory extension matching, one-line/live model rows,
  fleet reload survival and viewer input. Reconcile upstream resume budgets/stops and steering/usage events
  without weakening the fork contracts; see the fork's `docs/rebase-ca93a52.md`
- `createSubagentsExtension({ clock })` now also drives manager retention, admission, model activity and
  row/fleet/viewer timers, alongside scheduling/outbox. Defaults keep native time; render probes do not start
  tickers. Sixteen B rows plus absent-router admission are native in
  `test/{worktree-isolation-e2e,session-scenarios,fleet-session,viewer-session}.test.ts`, under Vitest and Bun
- `skills:` preload follows symlinks in the three user roots like Pi core (installers and dotfiles link vendored
  skills there), with a canonical-path cycle guard; project roots still refuse links at every layer, now including
  a linked `.pi/` or `.agents/` dir (nredd/pi-subagents#7). Upstream rejects links everywhere; keep the split

pi-plan-mode patch queue:

- Base: `@narumitw/pi-plan-mode@0.59.3` from `narumiruna/pi-extensions`, split `fb74f34b`;
  release branch `nredd/v0.59.3`, selected tag `v0.59.3-nredd.1` (nredd/pi-plan-mode#1/#2)
- Drop the redundant custom-start ready-plan source patch now owned upstream. Retain compact ready/review
  presentation, Escape preserving ready plans, explicit canonical reproposal confirmation and `/plan finalize`,
  headless turn waiting, annotated read-only/typed SSH admission, per-segment trusted-root Bash policy,
  one-line Plan tool/proposed-plan rows and `pi-plan-mode:plan-approved` delivery. Keep the standalone
  vendored harness and rebuilt `dist/` for git installs
- Seven B rows are native in `test/{confirmation,decline,policy,transcript}-session.test.ts`, under Vitest
  and Bun. Both forks' native test dependencies still pin core `v1.3.0-nredd.6` tarballs until their next
  releases, not stock npm host copies; `pi-harness`'s in-process host (`integration/inprocess`) uses `v1.3.0-nredd.7`
  `coding-agent`/`tui` tarballs plus the unchanged `v1.3.0-nredd.6` `ai`/`agent-core` tarballs. Full suites passed the parent [CI probe #37](https://github.com/nredd/pi-harness/pull/37)

rpiv-todo patch queue:

- Base: `@juicesharp/rpiv-todo@2.13.9` from `juicesharp/rpiv-mono` (release `54df50ee`), split `7903c76b`;
  release branch `nredd/v2.13.9`, selected tag `v2.13.9-nredd.2` (nredd/rpiv-todo#1/#2)
- Adopt upstream's per-call `rpiv-todo-state` persistence and `.ts` import specifiers. Legacy fork sessions
  (a Plan snapshot followed by tool-result-only updates) replay chronologically until the first authoritative
  persistence marker, so a completed task never rolls back to its approved snapshot; regression covers the
  audit's replay probe. Retain clickable heading, Plan seeding/evidence/reminders, wheel/atomic batches/counts,
  resume collapse/config and the historical-result/replanning fix
- nredd/rpiv-todo#2 adds standalone scripts, dev dependencies/lockfile, Vitest config
  and upstream mock helpers vendored from release `54df50ee`. No upstream assertions change: all 253 stock
  tests (21 files) run; the selected fork's baseline is 377 tests (26 files), rising to 382 (28 files) with
  rendering regressions. Biome/strict TypeScript and two native Bun 1.3.14 interactive regressions share
  `npm run check`; the host pins core `v1.3.0-nredd.6` tarballs like the other forks until the next fork release
- Invalidate core's cached settled call rows on foreground store changes when they still use the live
  fallback (legacy/error results without a valid snapshot). Weak subscriptions cover mutations, replay,
  eviction and foreground switches without polling or probe side effects. Valid historical snapshots stay
  immutable. Both update/delete regressions use the real interactive harness and VirtualTerminal and fail
  before the fix on the stale subject
- `forks.yml` runs the fork gate at its Gitlink, not a scratch monorepo or the parent stack suite. The four
  hosted single-fork rows (`integration/inprocess/todo-{history,widget,host}-*.test.ts`) and the
  Plan/todo pair in `plan-todos.test.ts` remain separate stack coverage

Core dependency audit (2026-10-17, `npm audit --omit=dev` on `nredd/pi` `v1.3.0-nredd.3`): the only
findings are `node-forge` <= 1.4.0 (GHSA-86w9-cpqp-85rv, no patched version published) reached
through `@earendil-works/gondolin` 0.12.0, which is a dependency of the private example workspace
`packages/coding-agent/examples/extensions/gondolin` only. Checked on the released artifacts:

- `tar tzf earendil-works-pi-coding-agent-1.3.0.tgz | grep 'node-forge\|gondolin'` (`753efe6f…`): only
  `package/examples/extensions/gondolin/{package.json,package-lock.json,index.ts}`, the example's
  sources; no `node_modules` entry. Same grep on `earendil-works-pi-tui-1.3.0.tgz` (`ccd8f2d2…`): nothing
- `grep -rl 'node-forge\|gondolin' packages/coding-agent/dist/bundle`: no file
- Installed dependency closure: `npm ls --all | grep -c 'node-forge\|gondolin'` in the Homebrew
  install's `libexec/lib/node_modules/@earendil-works/pi-coding-agent` prints 0, and
  `find /opt/homebrew/Cellar/pi-coding-agent/1.3.0-nredd.3 -path '*node_modules/node-forge*' -o -path '*node_modules/@earendil-works/gondolin*'`
  finds nothing
- `strings fatal-startup-out8/darwin-arm64/pi | grep -c 'node-forge/lib\|@earendil-works/gondolin'`: 0
  (the Bun standalone, `370dc52c…`)

The example ships as docs only. Nothing to patch in the fork; re-check when upstream bumps
`gondolin` or `node-forge` publishes a fix.
