# Upstream sync

Base: `injaneity/pi-computer-use` main `67e9e2f77643f84605b738a3198048a88e92190e`
(2026-10-27). Previous upstream base: `4b8dbd7`. Imported fork tip: `3fd2fe3`;
harness import: `41382ad` / `988eb2f`. Prepared package version: `0.6.0`; not released or activated.

Owner decisions (2026-10-27): keep every tool and clipboard action, keep Linux and its locked
source-build path, sync before release, keep computer-use outside the coverage gate. Usage counts
are representative, not permission to delete unused tools. Upstream filing remains independent: this package carries the proposed Rust coverage tooling
before any upstream PR. This change never pushes to upstream or edits the drafts file.

## Carried patches

Rows group overlapping commits by behavior, not commit boundary. `sync-patches.json` is the
machine-checkable ledger: each carried patch has a purpose, files, check, executable drop controls
and an `upstream` object with required `status` and `reference` fields, plus optional explanatory
`detail`. Text-only dispositions and missing/blank/malformed statuses or references are rejected.
Allowed local statuses are `drafted`, `harness-only`, `local-only`, `candidate` and
`proposed-after-issue-first`; their reference must name an existing package-relative file (no
absolute/traversal paths), or the explicit `~/code/review-notes/upstream-issues-drafts.md` path.
That workstation-only draft is recorded, never read or required to exist in hosted CI.
`merged-upstream` requires an HTTPS `https://github.com/injaneity/pi-computer-use/pull/<number>`
reference; `release-requested` requires the corresponding `/issues/<number>` URL. The same rules
validate absorbed #95 and release request #116, not just carried patches. URL shape is validated;
this offline check does not claim network verification or upstream acceptance.
`check-sync-reverts.mjs` validates the ledger before running the controls;
`test/sync-ledger.test.mjs` removes every patch's status/reference/drop controls and requires
rejection. A separate drop control disables carried disposition validation and must fail those tests.
Remove a row only after its check passes without the patch.

Ledger order is deterministic so concurrent PRs append at distinct positions: `sync-patches.json` `files`, patches
(by `id`), each patch's `files` and `dropControls`, the table rows below (by name) and the `check-sync-reverts.mjs` cases
(by `name`) are sorted in code-unit order, enforced by `test/sync-ledger.test.mjs`. Every patch lists the `rows` it owns
and every row must be owned by a patch. Any path that differs from upstream must be in `files`: `npm run check` ends with `check-upstream-sync.mjs --fetch-if-enabled`: CI sets `PI_CU_UPSTREAM_SYNC=1` on Linux, so the
required Ubuntu `computer-use` shard shallow-fetches the pinned upstream commit and fails on undeclared drift (or an
absorbed patch); elsewhere it prints NOT RUN. Locally run `--fetch`, or pass a clean detached upstream worktree.

Status source: `~/code/review-notes/upstream-issues-drafts.md` is a local draft file,
not a public upstream issue. Draft A covers desktop,
policy, scoped lock and activation; B covers helper replacement/age; C covers ref lifecycle.
These three issues are `issue-first drafted (~/code/review-notes/upstream-issues-drafts.md), not yet
filed`. Clipboard is retained locally, explicitly excluded from draft A. Canonical root deltas and
stale/replacement outcomes remain the later separate U3 candidate, not a drafted/filed issue.
The root-targeting fix is `merged upstream as #95` ([link](https://github.com/injaneity/pi-computer-use/pull/95));
the release is `requested release: injaneity/pi-computer-use#116`
([link](https://github.com/injaneity/pi-computer-use/issues/116)). No other issue or PR is filed.

| Patch | Original commits | Purpose / upstream status | Drop check |
| --- | --- | --- | --- |
| Act preflight | upstream PR #112 (`be73574`) | Validate every action before the write lock advances the epoch; rejected batches neither stale the `stateId` nor deliver a prefix; open upstream PR, status `candidate`. Deviation: the preflight also mirrors native macOS strict-headless `foreground_required` for `typeText`/`keypress` (`strictHeadlessRejection` in `src/actions.ts`), which upstream leaves to the native layer mid-batch. Only keyboard actions are mirrored: native strict headless also rejects coordinate fallback and web `setText` at runtime, and any runtime failure after delivery starts can still leave an executed prefix | `test:sync-reverts` preflight and strict-headless controls in `test/unpaired-act.test.mjs`, plus the two `strict-headless-drift` controls (`INV-strict-headless` in `test/invariants.test.mjs`) |
| App activation | `400f784`, `3fd2fe3` | Rank bundle/name/executable, reject ambiguity, launch with killable open and verify frontmost; draft A, not filed | `test:desktop` native wiring and mocked output/errors |
| Async helper safety coverage | nredd/pi-harness#759 | Measure the complete `scripts/check-async.mjs` verification helper independently of runtime source; deterministic syscall/stream/timer boundaries plus retained real child-process checks. New helper tests remain harness-only, not filed upstream; generated preload execution is behavior-tested, not separate source coverage | `test:async` and `test:sync-reverts` EPERM/quiescence mutation in `test/async-safety.test.mjs` |
| Blocked apps and locked sessions | nredd/pi-harness#646 | `blocked_apps` (default password managers, Keychain, terminals; system auth agents always; only the user-global file replaces it, project config and env can only add) fails `observe_ui`/`act_ui`/`desktop_input` with `app_blocked`, `find_roots` marks `blocked`, `desktop_screenshot` excludes blocked apps from the capture, the helper refuses UI commands with `screen_locked` while locked. Same shape as unmerged upstream proposal injaneity/pi-computer-use#115 part 2, reimplemented from its description (no upstream code); harness-only, not filed. Deviation from a TypeScript-only gate: `desktop_input` checks the frontmost/pointer app in the helper immediately before delivery (a key sequence that itself switches apps is not re-checked); keys (including HID `act_ui` typing) also check the system-wide focused app, drag checks every path vertex against one window-list snapshot (AX hit test at the endpoints only), and HID coordinate `act_ui` runs the window and accessibility hit checks after focus and preflight, right before posting (pid delivery skips them, the target root is checked in TypeScript); HID `act_ui` typing waits up to 200 ms for the target to become frontmost and AX focused, else `focus_not_acquired` | `test:sync-reverts` call-order and wiring controls in `test/app-policy.test.mjs` plus the lock-parsing, overlay-scan, focused-app, pid-skip, endpoint-hit-test and focus-wait controls in `test:macos-native` |
| Bridge browser act dead-arm removal | nredd/pi-harness#712 | Coverage-driven deletion of `bridge.ts`/`actions.ts` arms that cannot run: the never-prepared `wait` action and its `PreparedAction` member, the browser transaction/navigate/evaluate guards and epoch/resource-key fallbacks a hydrated browser state always satisfies, the ref-owner re-check (the target comes from the same state), the CDP port allocation failure (a listening TCP server always has a port), the `noteBefore` fallback the capture overwrites, the `rootDelta` fallback after the closed-root probe has set it and the `actionCount` fallback both dispatch paths set; the browser transaction now resolves refs through the hydrated state, so a padded `stateId` works like it does for every other tool; `testing` also exposes `managedBrowserExecutableCandidates`; browser `keypress` with no `keys` is rejected before the epoch advances like desktop (nredd/pi-harness#748, keypress half); harness-only, not filed | `test:sync-reverts` hydrated-state ref control in `test/bridge-browser-act.test.mjs` |
| Bridge dead-arm removal | nredd/pi-harness#709 | Coverage-driven deletion of `bridge.ts` arms with no public caller: numeric/text `root` selector (`observe_ui` rejects a non-string `root`), the delivery-policy env reader `currentDeliveryPolicy` (inert since the #178 resync; `PI_COMPUTER_USE_DELIVERY_POLICY` docs removed), `validateStateId` stale/window arms (`executeTool` hydrates the state), and unreachable guards/fallbacks; harness-only, not filed | `test:sync-reverts` non-string root control in `test/bridge-setup-look.test.mjs` |
| Bridge missing-target dead-arm removal | nredd/pi-harness#755 | Delete `currentTargetOrThrow` after tracing every caller: selection establishes a target, desktop hydration pairs captures with targets, browser queries stay on CDP and absent states fail at the capture boundary. No behavior change; full proof in harness `docs/computer-use-coverage.md`. Harness-only, not filed | `test:sync-reverts` restores the dead error string; source-removal assertion plus public no-observation checks in `test/bridge-observe-query.test.mjs` (not live verification) |
| Bridge read_text dead-arm removal | nredd/pi-harness#710 | Delete the browser snapshot and live resource identity guards in `read_text`: `executeTool` hydrates the browser snapshot with its context and supplies resource identity for desktop states; `readAt` still checks the resource epoch. Harness-only, not filed | `test:sync-reverts` desktop read paging control in `test/bridge-act-list-read.test.mjs` |
| Browser query without desktop escalation | nredd/pi-harness#722 | `search_ui` and `expand_ui` on a browser state skip OCR escalation and scoped looks (a browser state has no controlled desktop window), and desktop `wait_for` with a blank `stateId` returns the coded "No observation state is available" error instead of a raw `TypeError`; harness-only, not filed | `test:sync-reverts` search, expand and blank `wait_for` controls in `test/bridge-observe-query.test.mjs` |
| CDP dead-guard removal | nredd/pi-harness#708 | Coverage-driven deletion of `cdp.ts` guards that cannot run: the `try/catch` around `WebSocket.close()` (a no-argument close never throws), the non-`Error` wrapping of `send` failures (`JSON.stringify` and `ws.send` only throw `Error`s) and the `?? target.ref` snapshot fallback (`buildOutline` maps every wire ref); harness-only, not filed. Drop check: if upstream deletes or changes these arms, re-run `check-upstream-sync` and drop the carried diff | `test:sync-reverts` snapshot ref control in `test/cdp-client.test.mjs` |
| Clipboard | `400f784`, `3fd2fe3` | Retain plain-text clipboard actions and fence untrusted reads; carried locally, not proposed/filed | `test:desktop` native wiring, validation, fencing and truncation |
| Coverage test harness | nredd/pi-harness#645, #724, #721 | The scriptable fake helper and fake browser (`test/support/fake-*.mjs`, `test/fake-helper.test.mjs`) and one dead guard deleted from `src/platform/macos/helper.ts` (`await this.tail`, which never rejects, replaces a `.catch`); harness-only, not filed | `test:sync-reverts` fake helper reply control in `test/fake-helper.test.mjs` (the `helper.ts` guard has no control) |
| Cursor/drag | `e33ab31` | Read back top-left global cursor position and interpolate drags; draft A, not filed | `test:desktop` native wiring; `test:macos-native` interpolation cases |
| Daemon age | `1eabebd`, `50cbfe2` | Compare process start against binary ctime, not preserved mtime; draft B, not filed | `test:macos-target` age predicate cases |
| Harness Linux | `c59eb11` | Probe existing helper; opt-in locked build into writable cache and reap compiler groups; harness-only, not filed | `test:linux`, `test:linux-scripts`, `test:linux-native` on Linux |
| Harness package | `988eb2f`, `a4fc068`, `6207189`, subsequent contract hardening | Preserve @nredd metadata, source-only Linux, macOS payloads/cursor sources, platform-aware contracts, non-macOS NOT RUN and house-style commits; harness-only | `test:package-assets`, `test:linux-scripts`, `test:commits`, package-contract tests and stock contract |
| Headless managed browser | upstream PR #104 (`6bcd831`) | Headless `launch_browser` without `DISPLAY`/`WAYLAND_DISPLAY`, override env var; `--no-sandbox` only as root, unlike upstream; open upstream PR | `test/managed-browser-headless.test.mjs` via `test:sync-reverts` |
| Helper already-aborted signal | nredd/pi-harness#735 | Linux and Windows `command()` and macOS `daemonCommand()` rejected nothing for an `AbortSignal` that was already aborted (its abort event never fires again), so the request was sent and waited out the command timeout; they now throw `Operation aborted.` before installing, spawning or sending (Linux and Windows also re-check after the install check and helper start); harness-only, not filed | `test:sync-reverts` already-aborted controls in `test/stdio-helper-clients.test.mjs` and `test/macos-helper-client.test.mjs` |
| Helper disconnect failure | nredd/pi-harness#725 | Fail a command at once with coded `helper_disconnected` when the macOS helper drops the socket before replying, reject pending Windows helper commands when the process closes, and fail pending Linux commands only once stdout is drained (`close`, not `exit`); each helper process frames its output in its own line buffer; harness-only, not filed | `test:sync-reverts` helper disconnect controls in `test/macos-helper-client.test.mjs`, `test/linux-helper-client.test.mjs` and `test/windows-helper-client.test.mjs` |
| Helper post-write cancellation | nredd/pi-harness#750 | Windows `command()` rejects `Operation aborted.` after send, clears pending/timer/listener on every completion and write error, and drops late replies; only the local wait is cancelled, not native work. Distinct from #749's pre-abort guards; harness-only, not filed | `test:sync-reverts` post-write listener mutation in `test/windows-helper-client.test.mjs`; scripted stdio clients, no Windows UI/native coverage claim |
| Helper replacement | `1eabebd` | Stop an old daemon before replacing either bundle form; draft B, not filed | `test:signing` replacement wiring assertions |
| Host-independent docs | harness sync | Generate from all declared tool definitions, not the host's 13/11 registered subset; harness-only | `docs:check` runs `check-docs-platform.mjs` under both platform fixtures |
| Keyboard-layout typing | upstream PR #113 (`5bd2894`) | Post physical US key codes only when `UCKeyTranslate` on the active layout yields that character; else Unicode events; open upstream PR | `test:sync-reverts` layout gate control in `test:macos-native` |
| Linux helper dead-arm removal | nredd/pi-harness#713 | Coverage-driven deletion of unreachable `LinuxHelperClient` guards: the already-aborted check in `runProcess` (sole caller passes a fresh signal), the redundant `processPromise` re-check and the identity checks on single-flight `setupAbort`/`processPromise`; harness-only, not filed | `test:sync-reverts` setup SIGKILL grace control in `test/stdio-helper-clients.test.mjs` |
| Managed browser private profile | nredd/pi-harness#519, #528, #558 | Each managed browser gets a private owner-only `mkdtemp` profile dir (removed on browser exit, shutdown or Pi quit) instead of the fixed `pi-<browser>-cdp-<port>` name that another account sharing the temp dir could own or pre-seed; a relaunch or failed launch escalates to SIGKILL for a browser that ignores SIGTERM; launches are ordered before shutdown; harness-only, not filed. Security fix | `test:sync-reverts` owner-only profile dir control (mode 0o700) in `test/managed-browser-profile.test.mjs` (the SIGKILL and ordering changes have no separate control) |
| Outline dead-arm removal | nredd/pi-harness#702, #717 | Coverage-driven cleanup of `outline.ts` and `outline-store.ts`: drop the unreachable `0 children` fallback in folded summaries and the optional `preserveWireRef` default; unnamed roles fold as `node`, not upstream's `nodes`; the store sorts its directory listing once (newest first) and logs `String(error)`; harness-only, not filed. Drop check: if upstream deletes or changes these arms, re-run `check-upstream-sync` and drop the carried diff | `test:sync-reverts` unnamed role control in `test/outline.test.mjs` (the store changes have no control) |
| Outline store | nredd/pi-harness#648 | Keep `details.outline` out of tool results: persist desktop outlines in `<agent dir>/cache/pi-computer-use/outlines/` keyed by `stateId` (newest 512), restore from it, still restore legacy inline outlines, and skip evicted states; upstream injaneity/pi-computer-use#115 reports the same session bloat; status `candidate`, not filed as a PR | `test:sync-reverts` outline store write control in `test/outline-store.test.mjs` |
| Owned install/release docs | harness follow-up | Install `@nredd/pi-computer-use`, use root `publish.yml` and opt into Linux repair builds; upstream: harness-only, not filed | `docs:check` and three `test:sync-reverts` controls reject the upstream-only instructions |
| Physical transaction lease | `c6a27ca`, `50cbfe2`, `400f784`, `3fd2fe3` | Lock lazily on first physical step and release after the entire act transaction; draft A, not filed | `test:unpaired` background independence and no interleaving |
| Platform dead-arm removal | nredd/pi-harness#707 | Coverage-driven deletion of the unreachable `win32` label arm in `UnsupportedPlatformBackend` (`platformBackendForRuntime` returns `darwin`/`win32`/`linux` first) and the redundant `permissionSignal ?? signal` fallbacks in `ensureMacosReady` (`ensurePermissions` always forwards its own signal); harness-only, not filed | `test:sync-reverts` openPermissionPane signal control in `test/permissions-browser.test.mjs` |
| Policy | `c6a27ca` | Gate desktop tools on macOS, desktop_control and non-headless mode; draft A, not filed | `test:desktop`, packed contract's 13/11-tool split |
| Pure-module dead-arm removal | nredd/pi-harness#703 | Coverage-driven deletion of dead arms in `runtime.ts` (the empty-key guard in `StateStore.set`, which also fixes an empty restored `stateId` disabling eviction so the store grew unbounded; never-rejecting `tail` catches in `ResourceScheduler`), `output.ts` (missing-entry guard in the eviction loop) and `view.ts` (fresh-ref collision loop in `stabilizeRefs`); harness-only, not filed | `test:sync-reverts` empty-stateId eviction and output eviction controls in `test/runtime-state-output.test.mjs` |
| Query handler dead-arm removal | nredd/pi-harness#711 | Coverage-driven deletion in `bridge.ts` query handlers: browser `wait_for` guards for a missing resource identity, base snapshot or final observation, the `windowRef` conditional in the observe summary, the once-per-look `lastSearchOcrEscalatedLookId` search guard (and its `state.ts` field; an escalated look already carries `readText.executed`) and unreachable identity checks; harness-only, not filed. Drop check: if upstream changes these arms, re-run `check-upstream-sync` and drop the carried diff | `test:sync-reverts` browser `wait_for` found control in `test/bridge-wait-for.test.mjs` pins the rewritten `finish`; the deleted arms are unreachable, so they have no behavioral control |
| Ref lifecycle | `400f784`, `50cbfe2`, `3fd2fe3` | Epoch refs, bounded unowned refs, look-owned eviction and incremental transfer; draft C, not filed | `test:macos-native` real Swift store/transfer/epoch cases |
| Request framing headless | nredd/pi-harness#770 | Exercise actual `Bridge` NDJSON, completion ordering/eviction, short-write loop and argument coercion using injected dispatch/session/transport only; default production behavior unchanged; harness-only, not filed. Tests never invoke live command implementations or shutdown | `test:macos-native`; `test:sync-reverts` completion eviction and short-write offset controls |
| Root result identity | `50cbfe2`, `4d596ca` | Map deltas once to canonical @r refs, require live same-process replacement roots and coded stale errors; U3 later candidate, not filed | `test:unpaired`, `test:act-outcomes` |
| Rust coverage | harness follow-up | Report-only LCOV and per-file text/JSON from the native crates; upstream: proposed after issue-first (draft (c) in the drafts file), currently labeled draft D there, not filed | `test:rust-coverage` arguments/paths/missing tool and `test:sync-reverts` missing-tool control |
| Scroll-bar fallback | upstream PR #114 (`5e8378f`) | Write a settable `AXScrollBar` value for SwiftUI/AppKit scroll areas before the wheel fallback; open upstream PR. Deviations: the bar is written only when the target is the scroll area or its direct child, or an AX hit test at the scroll point, run against the target's own app so a covered window is not hit through the app on top, resolves to that area (upstream walks up to 10 parents, so an inner wheel-only scroller made the outer area scroll); with `scrollX` and `scrollY` both set, an axis whose bar was not written is carried to ancestors then the wheel (`unknown` under strict headless) instead of reporting `worked`; an axis whose set call succeeded but whose immediate read-back is unchanged (async apps) counts as delivered, is never also sent to the wheel, and reports `unknown`. The pure predicates are revert-proved; the AX hit test, partial-write wheel carry, its `unknown` result with `evidence.error` when the wheel leg throws after a bar axis was delivered (e.g. `occluded_target`, `input_failed`), and strict-headless `unknown` outcome need a live macOS AX session and have no deterministic control | `test:sync-reverts` range guard, write scope and per-axis controls in `test:macos-native` |
| Setup helper in-process | nredd/pi-harness#704 | `scripts/setup-helper.mjs` exports `main(argv, deps)`, `defaultDeps`, `isEntrypoint` and `dispatch` with paths, flags and host seams bound in `createSetup`, so it is measured in process; CLI behavior is unchanged; a non-darwin check in `ensureLocalSigningIdentity`, a duplicate bundle-name arm in `findExtractedHelperApp` and a redundant keychain re-lookup are deleted; harness-only, not filed | `test:sync-reverts` checksum verification control in `test/setup-helper-inprocess.test.mjs` |
| Site working directory | harness follow-up | Run imported website commands from `packages/computer-use`, not the harness root; upstream: harness-only, not filed | `docs:check` and `test:sync-reverts` reject the old root-relative instructions |
| Swift real-source coverage | nredd/pi-harness#757 | Link complete shipped Swift sources into a deterministic headless test binary; keep unexecuted entry/UI code in the denominator, validate profile identity and preserve LLVM region evidence; harness-only, not filed | `test:macos-native`, `test/swift-coverage.test.mjs`, wrong-binary revert control |
| Swift ref/look coverage | nredd/pi-harness#769 | Test real `AXRefStore` ownership, FIFO snapshots and `LookNode.payload()` using synthetic nodes and self-process/managed-child AX handles with no attribute queries; child reaped before assertions, direct AX call guard; runtime source unchanged; harness-only, not filed | `test:macos-native`, `test/ref-look-safety.test.mjs`; `test:sync-reverts` window-equality, destination-ownership, optional-flag and child-order mutations |
| Upstream disposition validation | harness follow-up | Require structured status plus valid local/URL reference, including #95/#116; upstream: harness-only, not filed | `test:sync-reverts` disables carried disposition validation and requires `test/sync-ledger.test.mjs` to fail |
| WSL2 diagnostics | nredd/pi-harness#672 | Explain unreachable Windows host windows when Linux finds no roots/frontmost window under WSL2; harness-only, not filed | `test/wsl2-diagnostics.test.mjs` via `test:sync-reverts` |
| Wheel horizontal sign | harness issue #650 | macOS `postScrollWheel` posts `wheel2` through the pure `scrollWheelCounts` as `-scrollX`, so positive `scrollX` scrolls right like the AX scroll-bar path and `scrollY`; upstream `main` still posts `wheel2: Int32(deltaX)` (scrolls left), same bug; upstream: not filed. Linux (XTEST buttons 6/7) and Windows (`MOUSEEVENTF_HWHEEL`) were checked and already scroll right for positive `scrollX` | `test:sync-reverts` control in `test:macos-native` |
| Whole desktop | `b009179` | Keep display capture, cursor inclusion, global mapping and physical input; draft A, not filed | `test:desktop` native dispatch + mocked capture/wire results |
| `act_ui` secondary action, text selection, paste | nredd/pi-harness#647 | `secondaryAction` (`ref`, `name`; the name must be one of the element's advertised actions, re-checked live by the helper), `selectText` (`ref`, `start`, `length`; `AXSelectedTextRange` in UTF-16 units, read back) and `paste` (`text`; pasteboard plus `cmd+v`, then the previous clipboard items are restored unless something else wrote to it, `performed.clipboardRestored`). `paste` posts a key chord, so it keeps the `typeText` guards: strict headless `foreground_required`, HID focus wait and blocked-app refusal before the clipboard is touched and again right before the key (the clipboard is restored on that refusal). It presses the layout's Command-map key for `v` (key 9 fallback, `layout_unsupported` only when the layout is unreadable; looked up after the focus checks), marks its item `org.nspasteboard.TransientType`/`AutoGeneratedType`/`ConcealedType`, writes it and restores the original current-host-only (no Universal Clipboard), leaves the pasted text on the clipboard if the helper is killed mid-paste, reports `unknown` when no value change is observed and is never retried in the foreground; a target slower than the restore deadline can still paste the old clipboard. macOS only; the bridge fails them with `unsupported_command` on Linux and Windows. Same shape as unmerged upstream proposal injaneity/pi-computer-use#115 part 3, reimplemented from its description (no upstream code); harness-only, not filed. Live macOS verification is pending | `test:sync-reverts` controls in `test/act-outcomes.test.mjs`, `test/app-policy.test.mjs` and `test:macos-native` |

See `sync-patches.json` for each row's exact file paths and `upstream` status, including harness-only
patches. [Rust coverage](docs/rust-coverage.md) records pinned tools, real per-file numbers,
execution and platform limits. Linux-crate coverage on macOS measured 1163/2609 lines (44.58%),
125/295 functions (42.37%), 1681/4315 regions (38.96%); 33 tests passed, 1 ignored, 32.007s
including build and reports. Windows remains NOT RUN. Coverage collection is not in `check`.

The follow-up ledger also declares the five test/lifecycle files changed on main by #165/#177;
these are deliberate harness drift, not new upstream imports. Full package checks after the
merge use `COMMIT_RANGE=origin/main..HEAD`, matching PR CI's base/head selection. Local
`HEAD~1..HEAD` after a merge includes already-merged main subjects over 72 characters, so its
commit-message subcheck correctly rejects those; no history is rewritten or policy relaxed.
The old hosted macOS `owned` failure was `leader-exits-first: wrapper returned after 0ms`,
fixed by the main-branch event-driven compiler lifecycle checks retained in the merge.

`2c3dd8b` root targeting is absorbed by upstream PR #95 (`2aebb01`): no duplicate implementation
is carried. The existing range-checked window-id helpers and tests remain; upstream's salvaged port
has equivalent positive-id/ref targeting but not the out-of-range guard. `cd72165`'s validation
history remains in `docs/macos-root-targeting.md`, rather than restoring removed upstream doc pages.
The note is historical evidence, not validation of this sync.

Unmerged upstream PRs carried (2026-11-09, upstream main still `67e9e2f`): #112, #113, #114, #104,
all MIT, authors `glvent` (#112-#114) and `ceslami` (#104), applied from their heads onto this
tree (see nredd/pi-harness#637). Skipped: #118 (this package already ships every helper source,
checked by `test:package-assets`), #108/#110/#120 (Windows, NOT RUN here), dependabot bumps.
Committed `prebuilt/macos` payloads were not rebuilt for the Swift changes; the release pipeline
compiles them from tagged source. `test:upstream-sync` already reports drift on files declared by
earlier main PRs (`scripts/build-native.mjs`, `test/fixtures/fake-*.mjs`); not changed here.

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

Main-branch merge follow-up (2026-10-28): retain main's #165 event-driven race fix and
#177 compiler-lifecycle checks alongside the sync's compact `button` rendering, screenshot mock
and moved Linux documentation. `npm run check`, `make check-scripts`, the packed computer-use
contract and scoped Biome passed locally after resolution. The prior macOS contracts/local-stack
jobs were never acquired by a runner (capacity annotations), not package failures; no blind rerun.

Main integration follow-up (2026-10-29): plain-merge main `4d578352`, retaining Bun 1.4.4,
WSL's shared twelve-check matrix and strict protection. Adopt #191's merged collector and #194's
shared `harness.credentials` policy; port #178's raw-byte/timeout metadata without restoring its
collector-local scanner. Preserve #178's npm/short GitHub/sk/pk/Slack/private-key signatures in the
shared policy alongside main's short JSON/Bearer and URL/proxy handling. Retain the complete
clean/contaminated artifact matrix and add main's short credential cases across that matrix.
Coverage policy only inventories newly imported source and exact non-shipped verification helpers:
computer-use remains owner-excluded with no signals or percentage gate. `coverage:rust` remains
optional report-only tooling, never collected by `check` or CI; its mocked argument/path/error
tests remain part of `check`. No live helper, signing, pin or
installed path changes are part of this integration.

## Signing decision and rollback

KEEP the existing local bundle path, setup and local signing. The harness release pipeline now
compiles loose arm64/x64 payloads from tagged Swift source in CI with `--no-sign`, then packs and
attests the actual compiler output. It does not build upstream's self-signed app or supply a new
installed signer. Apple linking may add an ad-hoc signature, not an installed signing identity.
Setup still re-signs the payload using the existing local identity. Switching that identity would
change the designated requirement and force TCC re-grants; it remains an explicit owner decision.
No installed helper, registration, TCC grants or private signing keys are changed by CI compilation.
See the harness [release path](../../docs/releases.md).

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

Review follow-up: corrected `docs/README.md` to enter `packages/computer-use` before the site
commands; `docs:check` plus a drop control reject the old harness-root instructions. A second
review corrected the owned tutorial package name, the root release workflow/local-signing
boundary and the missing Linux repair build opt-in/Cargo prerequisite. Three additional drop
controls require those old instructions to fail. The site's Next.js build remains NOT RUN,
not implied by validating command paths.

Unchanged upstream judgement finding: `session_shutdown` calls inactive glow even when never used;
its connection path may start the helper. Retained deliberately in this source sync rather than
silently changing upstream glow lifecycle semantics. Backend shutdown closes that connection, but
this is not proof that it avoids launch. Follow-up needs a disabled/unused-shutdown regression;
no installed helper/setup/live session was invoked by this PR's verification.

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
It starts and restarts its own helper instance on an isolated socket in the test home, never the
shared helper daemon, and drives disposable fixture windows, activation and a restorable plain-text
clipboard round trip. It must reject pre-restart refs rather than aliasing them; confirm fresh
discovery works afterwards. Recheck both System Settings privacy entries and absence of new
TCC prompts after the restart. Do not run it against active/valuable work or bypass its safeguards.

All live checks above are **NOT RUN** by the implementation agent. Record tool/scenario outcomes,
observed helper identity/path and TCC result without private document contents. Acceptance requires
all eight tool smoke cases on the stated real-app/disposable-browser scenarios plus the upgrade/TCC
checks; historical Fusion/Bambu notes and deterministic mocks do not satisfy it.
