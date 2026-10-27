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
| Harness package | `988eb2f`, `a4fc068`, `6207189`, subsequent contract hardening | Preserve @nredd metadata, source-only Linux, macOS payloads/cursor sources, platform-aware contracts, non-macOS NOT RUN and house-style commits; harness-only | `test:package-assets`, `test:linux-scripts`, `test:commits`, package-contract tests and stock contract |

`2c3dd8b` root targeting is absorbed by upstream PR #95 (`2aebb01`): no duplicate implementation
is carried. The existing range-checked window-id helpers and tests remain; upstream's salvaged port
has equivalent positive-id/ref targeting but not the out-of-range guard. `cd72165`'s validation
history remains in `docs/macos-root-targeting.md`, rather than restoring removed upstream doc pages.
The note is historical evidence, not validation of this sync.

## Conflict resolutions

- Keep upstream's compact observation rendering, `detail: outline`, find validation, activity glow,
  headless synthesized-input rejection and Linux/Windows native fixes.
- Merge `desktop_control` alongside `activity_glow` in config and public registration. This avoids
  the six activity-glow TypeScript errors from the trial rebase.
- Keep one Swift PURE block, not duplicate modal/capture definitions from upstream's #95 salvage.
  Keep ref eviction and drag helpers inside that block and use range-checked window ids.
- Keep canonical delta mapping and precise stale/replacement outcomes, plus upstream compact-view
  tests. Update unpaired tests to exercise the new compact default rather than requiring AX labels.
- Adopt upstream's docs site layout and generators. Pack only docs content, not site dependencies or
  build output. Preserve Linux source-build documentation in its moved page.
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
its named existing check to fail for the expected reason. This is a negative-control/drop proof,
not replay of the original overlapping commit diffs. Native dispatch/ranking/cursor checks are
source-wiring checks; mocked tools and compiled PURE Swift checks do not validate live AX/HID/TCC.
Additional packaging and platform-policy negative cases live in `scripts/tests/test_package_contracts.py`.

Recorded on the implementation Mac (2026-10-27):
- `npm run check`: passed, including Swift typecheck and compiled native PURE checks. Live tests print
  NOT RUN. `test:commits` is adapted to the harness's capitalized imperative subjects rather than
  applying upstream's incompatible conventional-commit policy to monorepo commits.
- `npm run test:sync-reverts`: 13 expected failures demonstrated, one behavior disabled at a time.
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
- `test:upstream-sync` compared the clean pinned upstream source and accepted exactly 41 declared
  differing files. An omitted ledger entry failed first, confirming undeclared drift is rejected.
- Rebuilt x64 and arm64 payloads serially. Both retain ad-hoc signatures and identifier
  `com.injaneity.pi-computer-use`; the installed local signer/path were inspected read-only and not
  changed. No package postinstall, live GUI tools, desktop smoke, release, promotion or merge ran.
- Remove upstream's extra EOF blank line in `docs/src/components/brand.tsx` so `git diff --check`
  passes; this is the only site-source formatting delta, declared in the patch ledger.
- The upstream Next.js documentation site itself was not built; content generators and doc-link
  checks passed. Site dependencies remain in its separate, upstream-owned nested lockfile.

Owner-only validation, with a free desktop and a scratch TextEdit document (agent tool-call syntax):

1. `desktop_screenshot({display: 0})`: verify cursor inclusion and displayed global mapping.
2. `desktop_input({action: "moveMouse", x: 100, y: 100})`: verify the pointer and screenshot agree.
3. `find_roots({app: "TextEdit"})`, then `observe_ui({root: "<returned @r>", mode: "semantic"})`:
   verify that exact root, including a nonmodal secondary root, is retained.
4. `desktop_input({action: "activateApp", app: "com.apple.TextEdit"})`: verify TextEdit is frontmost.
5. After the owner installs the reviewed upgrade, `PI_COMPUTER_USE_LIVE=1 npm run test:macos-live`:
   validates helper restart/ref epoch and fixtures; it DOES manipulate the shared desktop and clipboard.

These five checks are NOT RUN by the implementation agent. Existing Fusion/Bambu targeting and
physical input still need owner validation; do not treat old live notes as current acceptance.
