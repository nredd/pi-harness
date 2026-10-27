# Upstream sync

Base: `injaneity/pi-computer-use` main `67e9e2f77643f84605b738a3198048a88e92190e`
(2026-10-27). Previous upstream base: `4b8dbd7`. Imported fork tip: `3fd2fe3`;
harness import: `41382ad` / `988eb2f`. Prepared package version: `0.6.0`; not released or activated.

Owner decisions (2026-10-27): keep every tool and clipboard action, keep Linux and its locked
source-build path, sync before release, keep computer-use outside the coverage gate. Usage counts
are representative, not permission to delete unused tools. Upstream filing and Rust-coverage work
are independent; this change neither edits their branches nor pushes to upstream.

## Carried patches

Rows group the overlapping original commits by behavior, not by commit boundary. Each row is one
purpose. Replace each `upstreamed in <PR>` placeholder when the separate filing agent supplies it;
none is a claim of acceptance. Remove a row only after its check passes without the patch.

| Patch | Original commits | Purpose / upstream status | Drop check |
| --- | --- | --- | --- |
| Helper replacement | `1eabebd` | Stop an old daemon before replacing either bundle form; upstreamed in <PR> | `test:signing` replacement wiring assertions |
| Daemon age | `1eabebd`, `50cbfe2` | Compare process start against binary ctime, not preserved mtime; upstreamed in <PR> | `test:macos-target` age predicate cases |
| Whole desktop | `b009179` | Keep display capture, cursor inclusion, global mapping and physical input; upstreamed in <PR> | `test:desktop` native dispatch + mocked capture/wire results |
| Cursor/drag | `e33ab31` | Read back top-left global cursor position and interpolate drags; upstreamed in <PR> | `test:desktop` native wiring; `test:macos-native` interpolation cases |
| Policy | `c6a27ca` | Gate desktop tools on macOS, desktop_control and non-headless mode; upstreamed in <PR> | `test:desktop`, packed contract's 13/11-tool split |
| Physical transaction lease | `c6a27ca`, `50cbfe2`, `400f784`, `3fd2fe3` | Lock lazily on first physical step and release after the entire act transaction; upstreamed in <PR> | `test:unpaired` background independence and no interleaving |
| Ref lifecycle | `400f784`, `50cbfe2`, `3fd2fe3` | Epoch refs, bounded unowned refs, look-owned eviction and incremental transfer; upstreamed in <PR> | `test:macos-native` real Swift store/transfer/epoch cases |
| Root result identity | `50cbfe2`, `4d596ca` | Map deltas once to canonical @r refs, require live same-process replacement roots and coded stale errors; upstreamed in <PR> | `test:unpaired`, `test:act-outcomes` |
| App activation | `400f784`, `3fd2fe3` | Rank bundle/name/executable, reject ambiguity, launch with killable open and verify frontmost; upstreamed in <PR> | `test:desktop` native wiring and mocked output/errors |
| Clipboard | `400f784`, `3fd2fe3` | Retain plain-text clipboard actions and fence untrusted reads; upstreamed in <PR> | `test:desktop` native wiring, validation, fencing and truncation |
| Harness Linux | `c59eb11` | Probe existing helper; opt-in locked build into writable cache and reap compiler groups; upstreamed in <PR> | `test:linux`, `test:linux-scripts`, `test:linux-native` on Linux |
| Host-independent docs | harness sync | Generate from all declared tool definitions, not the host's 13/11 registered subset; harness-only | `docs:check` runs `check-docs-platform.mjs` under both platform fixtures |
| Harness package | `988eb2f`, `a4fc068`, `6207189`, subsequent contract hardening | Preserve @nredd metadata, source-only Linux, macOS payloads/cursor sources, platform-aware contracts, non-macOS NOT RUN and house-style commits; harness-only | `test:package-assets`, `test:linux-scripts`, `test:commits`, package-contract tests and stock contract |

`2c3dd8b` root targeting is absorbed by upstream PR #95 (`2aebb01`): no duplicate implementation
is carried. The existing range-checked window-id helpers and tests remain; upstream's salvaged port
has equivalent positive-id/ref targeting but not the out-of-range guard. `cd72165`'s validation
history remains in `docs/macos-root-targeting.md`, rather than restoring removed upstream doc pages.
The note is historical evidence, not validation of this sync.

## Conflict resolutions

- Keep upstream's compact observation rendering, `detail: outline`, find validation, activity glow,
  headless synthesized-input rejection and Linux/Windows native fixes. Glow tracks the same 11
  upstream state-scoped tools, not the two carried desktop tools: do not expand its overlay into
  whole-display capture as an incidental sync change. A whole-display `desktop_screenshot` can
  nevertheless include a glow already activated by a state-scoped tool or another session; only
  single-window `observe_ui` captures exclude that overlay.
- Merge `desktop_control` alongside `activity_glow` in config and public registration. This avoids
  the six activity-glow TypeScript errors from the trial rebase.
- Keep one Swift PURE block, not duplicate modal/capture definitions from upstream's #95 salvage.
  Keep ref eviction and drag helpers inside that block and use range-checked window ids.
- Keep canonical delta mapping and precise stale/replacement outcomes, plus upstream compact-view
  tests. Update unpaired tests to exercise the new compact default rather than requiring AX labels.
- Adopt upstream's docs site layout and generators. Generate the tool reference from exported
  definition inventories, not runtime platform registration: initial Linux CI exposed the 11-vs-13
  host-dependent output. A subprocess fixture reproduced that exact failure on the Mac before the
  fix, then passed for both `linux` and `darwin`; the docs gate now always runs it.
- Pack only docs content, not site dependencies or build output. Preserve Linux source-build
  documentation in its moved page.
- Preserve the local build/signing path. Add `activity_glow.swift` to both source lists and the exact
  packed contract. Rebuild both loose payloads; do not import upstream's stale July binaries.

## Signing decision and rollback

KEEP local builds and local signing for now. Upstream builds a CI self-signed bundle, not a
notarized Developer ID bundle. Switching to its signer would change the designated requirement and
force TCC re-grants. That remains an owner decision, not part of this sync.

Committed macOS payloads retain ad-hoc signing and identifier `com.injaneity.pi-computer-use`.
Setup still constructs the app at the same resolved path and signs using the existing local
keychain identity. No setup, permission flow, helper launch, helper restart or live desktop call is
performed during this sync. Never change the installed signer/path while validating a source sync.

Rollback after a future release: revert the promoted package pin to
`npm:@nredd/pi-computer-use@0.5.2` through the normal promotion path, then reinstall. Its replacement
restart guard stops the new helper and reinstalls the old bundle. Retain the same local signer;
permission preservation is expected, not a guarantee. No promotion is performed by this PR.

## Mechanical re-sync

Only use fresh worktrees. The fork checkout is a read-only source of objects; never rebase its
shared branch or push upstream from this procedure. Substitute the next SHA after fetching.

```sh
cd ~/code/pi-harness
git fetch
git worktree add ~/code/cu-sync -b redd/computer-use-upstream-sync origin/main
cd ~/code/pi-computer-use
git fetch upstream
git worktree add --detach ~/code/cu-sync-src upstream/main
git -C ~/code/cu-sync-src rev-parse HEAD
cd ~/code/cu-sync
git fetch ~/code/cu-sync-src <new-upstream-sha>
git -C ~/code/cu-sync-src diff --binary \
  67e9e2f77643f84605b738a3198048a88e92190e <new-upstream-sha> \
  -- . ':!package-lock.json' ':!prebuilt' \
  | git apply --3way --directory=packages/computer-use
```

Resolve conflicts semantically using the table, never wholesale ours/theirs. A conflict exit is
normal and must be resolved before staging. The first sync used `4b8dbd7` as the diff base and also
excluded deletion of `docs/troubleshooting.md`, then explicitly removed that modified legacy file
after adopting its replacement. Future syncs use the recorded current base above. Root workspace
lock ownership and local prebuilt ownership are permanent exclusions; do not reintroduce a nested
package lock or upstream-signed app.

```sh
cd ~/code/cu-sync/packages/computer-use
npm run docs:generate
npm run check
npm run test:commits
npm run test:windows-scripts
npm run test:sync-reverts
npm run build:native -- --arch all
cd ../..
make check-computer-use-package-contract
make check
```

Before native builds, inspect resources and compare the current payload signature mode/identifier.
Build architectures serially. Stop if the signing identity/path changes. Never run postinstall or
live checks as an incidental part of dependency installation (`npm ci --ignore-scripts`).
Run Linux checks on Linux in CI; local macOS cargo tests do not prove the Linux installation path.
Review the final diff against the new upstream SHA using the declared patch-file ledger in
`sync-patches.json` (`npm run test:upstream-sync -- ~/code/cu-sync-src`). Update that ledger only
for an intentional carried patch; do not silently allow unrelated drift. Update the base SHA and
this table, refresh generated docs and packed contract, obtain both reviews, push a harness PR.
Do not merge or release as part of syncing. Remove the scratch source worktree afterwards:

```sh
git -C ~/code/pi-computer-use worktree remove ~/code/cu-sync-src
```

## Verification boundaries

`test:sync-reverts` disables one carried behavior at a time in a disposable package copy and requires
its named existing check to fail for the expected reason. Cases separately remove headless and
`desktop_control` gates, ref transfer/epoch/FIFO/eviction, canonical deltas/stale outcomes/replacement
filtering, and Linux cache-target/escalation behavior. This is a negative-control/drop proof,
not replay of the original overlapping commit diffs. Native dispatch/ranking/cursor checks are
source-wiring checks; mocked tools and compiled PURE Swift checks do not validate live AX/HID/TCC.
Darwin-only controls print explicit NOT RUN on other hosts; the required macOS CI job exercises
those cases. A Linux exit 0 is not proof of those skipped controls. Additional packaging and
platform-policy negative cases live in `scripts/tests/test_package_contracts.py`.

Recorded on the implementation Mac (2026-10-27):
- `npm run check`: passed, including Swift typecheck and compiled native PURE checks. Live tests print
  NOT RUN. `test:commits` is adapted to the harness's capitalized imperative subjects rather than
  applying upstream's incompatible conventional-commit policy to monorepo commits.
- `npm run test:sync-reverts`: 21 expected failures demonstrated, one behavior disabled at a time.
- `npm run test:windows-scripts`: 23 assertions, 0 failures, using isolated helper/build paths.
  Native Windows Rust compilation and an actual Windows desktop remain NOT RUN.
- `make check-computer-use-package-contract`: passed against exact stock Pi 1.3.0; all 13 macOS tools,
  both Mach-O architectures, four Swift build sources and the exact 90-file payload are present.
  Postinstall and native desktop behavior are explicitly NOT RUN.
- `make check-scripts`: Ruff format/lint, ty, 692 Python tests, import-audit Biome/types and 8 Node
  tests passed. The computer-use `check` is the scoped `make check-ts` portion; unrelated workspaces,
  integration/benchmark and full assembled-stack gates are not claimed here.
- Biome passed for the two new sync-verification scripts and the patch ledger. There is no existing
  computer-use Biome configuration; upstream source formatting is retained rather than reformatting
  the imported tree. Root import-audit Biome passed as part of `check-scripts`.
- `CARGO_BUILD_JOBS=2 cargo test --locked --manifest-path native/linux/bridge-rs/Cargo.toml` with an
  external target directory: 33 passed, 1 ignored (requires a live session AT-SPI bus) on macOS.
  Docker is installed but has no running daemon/context endpoint. Linux-native packed-source build,
  diagnostics and actual Linux host acceptance remain CI responsibilities, NOT local passes.
- `test:upstream-sync` compared the clean pinned upstream source and accepted exactly 45 declared
  differing files. An omitted ledger entry failed first, confirming undeclared drift is rejected.
- Rebuilt x64 and arm64 payloads serially. Both retain ad-hoc signatures and identifier
  `com.injaneity.pi-computer-use`; the installed local signer/path were inspected read-only and not
  changed. No package postinstall, live GUI tools, desktop smoke, release, promotion or merge ran.
- Remove upstream's extra EOF blank line in `docs/src/components/brand.tsx` so `git diff --check`
  passes; this is the only site-source formatting delta, declared in the patch ledger.
- The upstream Next.js documentation site itself was not built; content generators and doc-link
  checks passed. Site dependencies remain in its separate, upstream-owned nested lockfile.

Round-two review evidence (no live validation): the documentation guard rejected the old universal
claim that the glow never appears in agent observations, before the source-owned prose was fixed.
The configuration reference is regenerated from `src/config.ts`; `docs:check` now verifies all
source references, including configuration, under both Linux and macOS subprocess platform fixtures.
Actual Linux CI runs that same checked-in-output comparison; a local platform fixture is not an
OS runtime acceptance claim.

Hosted evidence at `96c2397`: run `40556877655`, Ubuntu `owned` job `122375808415`, passed Rust tests,
packed-source x86_64 build/helper diagnostics and aarch64 compile-only checks. The job then failed
in `test:commits` because its shallow checkout has no `HEAD~1` for the default `HEAD~1..HEAD` range.
This is a diagnosed gate/history failure, not a Linux helper failure; it was not blindly retried.
New-head CI and all owner live/TCC acceptance remain separate evidence.

Commit-gate follow-up: run `40560439112` reproduced the same failure on both owned OS cells.
Before the sync, `origin/main`'s package `check` ran only `npm test && npm run test:package-assets`;
the sync first wired `test:commits` into it. The owned checkout was already depth one. The script
incorrectly expected `GITHUB_BASE_SHA`, so PR CI fell back to the missing `HEAD~1`. It now reads the
actual PR base/head or push before/after from `GITHUB_EVENT_PATH`, and owned CI fetches full history.
Shallow histories fail closed even when both endpoints exist, preventing hidden intermediate commits
from escaping validation. See `docs/ci.md` for local/explicit-range behavior and unsupported bases.
The original script failed with the exact ambiguous-range error in a disposable `clone --depth 1`;
fetching complete history with the new script passes valid PR/push ranges and rejects a hidden bad
subject. Seven CLI/workflow tests cover those paths; the original script fails the PR/push selection
controls. Fresh full `npm run check`, scoped Biome, `make check-scripts` (692 Python and 8 Node tests)
and the explicit 116 CI-path/merge-check/WSL-workflow tests passed after this fix. No `node_modules`
repair was needed after the workspace move. The new test is declared in `sync-patches.json`;
previous 45-file upstream-comparison evidence above predates this added harness-only file.

## Owner-only live acceptance (NOT RUN)

This checklist covers every tool with nonzero calls in spec section 2.2, not just the desktop pair.
Run it only after installing the reviewed upgrade, with a free desktop, other agents paused and
empty/disposable Fusion 360 and Bambu Studio documents. Do not alter existing designs, mesh objects
or settings; do not save, import, export, slice or print. Only open and dismiss menus. Do not type
commands into Fusion's console. If a safe target is unavailable, record that case as blocked rather
than substitute a mutating action. Fill placeholders from current results, never reuse historical
pids, root refs, state ids or element refs.

Before upgrade, record the helper's existing path and entries/toggle states in System Settings ->
Privacy & Security -> Accessibility and Screen Recording (Screen & System Audio Recording on newer
macOS). After upgrade, verify the same helper entries/path and grants remain unchanged, with no
new or duplicate entry. Do not toggle grants, reset TCC or approve a new request to make this test
pass. On the first `desktop_screenshot`, observation and input after upgrade, verify **no new TCC
prompt** appears. A re-prompt or changed grant is a failed acceptance case: stop and report it.

Required tool smoke (agent tool-call syntax; counts from the owner's recorded sessions):

1. `desktop_screenshot({display: 0})` (708 calls): capture the display containing Fusion/Bambu;
   verify the real cursor and global image-to-point mapping. Compare again after activation/input.
   An already-active optional glow may be visible in this display capture, unlike a single-window
   `observe_ui` capture; that is not evidence of an unexpected window exclusion.
2. `desktop_input` (1,591 calls): use `{action: "activateApp", app: "<verified Fusion name or bundle id>"}`
   and the corresponding verified Bambu identity. Confirm each is frontmost before sending any key.
   Use `{action: "moveMouse", x: <safe global x>, y: <safe global y>}` over empty chrome, not a model or
   control; verify placement with `desktop_screenshot`. After the menu-only action in step 7, send
   `{action: "keypress", keys: ["escape"]}` only while the tested app/menu is frontmost, then confirm
   dismissal and unchanged document state. Do not click/type into model-editing controls.
3. `find_roots({text: "Fusion"})` and `find_roots({text: "Bambu"})` (46 calls): identify the actual
   app identities, main-window refs and Fusion's BROWSER sidebar/secondary root. Do not hard-code
   names from earlier sessions or treat an unrelated app's root as a match.
4. `observe_ui({root: "<fresh @r>", mode: "semantic"})` (95 calls): repeat for both main windows
   and Fusion's BROWSER secondary root when present. Confirm the exact requested root remains the
   target and an explicitly nonmodal sidebar is not reported as modal. Also try `detail: "outline"`
   and compare it with the compact default; retain each returned `stateId`. Record the secondary-root
   case as NOT RUN if absent; do not fabricate an unpaired root. Unpaired/stale/replaced-root live
   acceptance remains separate unless a safe example naturally exists.
5. `search_ui({stateId: "<current state>", text: "<visible menu label>"})` (17 calls): search cached
   Fusion and Bambu states for a visible top-level menu (e.g. File, only if actually exposed).
   Confirm the matched ref/label belongs to that exact observed app/root, without another capture.
6. `inspect_ui({stateId: "<same state>", ref: "<returned @e>"})` (8 calls): inspect each candidate's
   identity, role and capabilities. Proceed only if it is a verified menu-opening control, not a
   save/export/print command or model operation. Record a blocked case if neither app exposes one.
7. `act_ui({stateId: "<fresh state>", actions: [{action: "press", ref: "<inspected menu @e>"}]})`
   (88 calls): repeat the verified menu-only press in Fusion and Bambu. Confirm the expected menu
   opens, the successor stays associated with the intended root (no sidebar/modal retargeting), and
   no model/document setting changes. Dismiss with the guarded Escape in step 2; re-observe before
   the next action. Do not use coordinates or a different command as an unverified fallback.
8. `launch_browser({})` (2 calls): expect a separate Pi-managed temporary-profile browser at
   `about:blank`, a browser-page root and observed state. Do not attach to a personal browser/profile,
   log in, navigate to private pages or change settings. Close only that disposable test window.

Helper-upgrade/restart check, owner only: with all other desktop work paused, run
`PI_COMPUTER_USE_LIVE=1 npm run test:macos-live` from the source package after the reviewed upgrade.
It restarts the shared helper and drives disposable fixture windows, activation and a restorable
plain-text clipboard round trip. It must reject pre-restart refs rather than aliasing them; confirm
fresh discovery works afterwards. Recheck both System Settings privacy entries and absence of new
TCC prompts after the restart. Do not run it against active/valuable work or bypass its safeguards.

All live checks above are **NOT RUN** by the implementation agent. Record tool/scenario outcomes,
observed helper identity/path and TCC result without private document contents. Acceptance requires
all eight tool smoke cases on the stated real-app/disposable-browser scenarios plus the upgrade/TCC
checks; historical Fusion/Bambu notes and deterministic mocks do not satisfy it.
