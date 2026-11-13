# Computer-use coverage to 0 uncovered

Spec for #425's "every coverage signal at 0 uncovered branches" applied to `packages/computer-use`,
TypeScript and Swift. Today the package is owner-excluded (`goal: "excluded"` for `computer-use`
and `computer-use-vitest` in `coverage/policy.json`, see [coverage.md](coverage.md)); this doc is the
plan for reversing that exclusion. Nothing here changes policy by itself. Rust (`native/*/bridge-rs`)
is out of scope for the first pass, current numbers are under [Rust](#rust-out-of-scope-numbers-only).

Target, same as every other package: **0 uncovered lines, 0 uncovered functions, 0 uncovered branches**
per measured signal on each OS the signal runs on. No source exclusions, no `/* istanbul ignore */`,
no `// coverage:ignore`, no widened globs, no waived files. Unreachable code is deleted or made
unreachable by types, as in the dev-tools precedent (the unused no-op mutex initializer).
Every closed gap needs a test that fails without the behavior, not an executed line.

## Missing-target call-path proof (#755)

The remaining `src/bridge.ts` missing-target guard is dead, not a missing public error path.
`executeTool` creates an isolated `OperationState` for each request via `SavedStates.hydrate`:
no state yields `{}`, desktop records always restore both target and capture, browser records
restore a CDP context without a desktop target. Session reconstruction also saves desktop records
only after constructing both target and capture. No public input can mutate this operation state.

The two former `currentTargetOrThrow` consumers are:

- `performReadText`: output refs return first, browser states return through CDP, and desktop
  reads require `currentCaptureOrThrow` before accessing the paired target.
- `resolveCurrentTarget`: `resolveTargetByWindowSelector` calls it only after checking the current
  target; `resolveTargetForObserve` does the same or selects the frontmost target. All selection
  paths set the target before returning. `ensureTargetWindowId` is reached only with a selected
  target or a hydrated desktop target. `captureCurrentTarget` receives the selected target from
  observe, or runs after desktop capture validation. `performWaitFor` and `performDesktopTransaction`
  require a capture first; `performSearchUi` and `performExpandUi` require an outline (which requires
  a capture) and exclude browser contexts from native recapture.

`clearDesktopOperationState` clears the capture and target together only on terminal transaction
outcomes, which return without further resolution. Async-local operations cannot clear each other's
targets. The guard and unused error constant are deleted, not ignored or pinned to success.

`test/bridge-observe-query.test.mjs` verifies all six desktop state consumers reject missing,
empty and whitespace states at the public executor boundary without reaching native capture/wait.
Existing suites cover selected/frontmost roots, hydrated desktop reads/waits/acts, browser queries
and reconstructed observations. A separate, explicitly structural removal control fails when the
obsolete guard returns; it is not a claim of native behavior. Coverage pins and caps are changed
only after measurements, never to hide a reachable failure.

At source HEAD `3a1623815c57f814c67ec655692c6430c27e7ca5`, CI run `43184600748`
measured macOS (job `131068948733`, 966 tests, 15 skipped), Ubuntu (job `131068948709`,
958 tests, 23 skipped) and WSL2 (job `131068948676`, 958 tests, 23 skipped). Each reports
L/F/B/S uncovered **0/0/0/0**, totals 3902/1022/3429/4676; all 35 files, including
`src/bridge.ts`, are fully covered.
The initial public-executor suite failed 1 removal assertion before deletion, then all
19 tests passed. `check-sync-reverts.mjs` actually restores the guard and proves the
removal assertion fails; all existing controls also pass after updating their deleted-error
anchors/expectations. This is structural dead-code protection, not live native coverage.

The aggregate L/F/B/S caps are now zero on both policy platforms, and all 35 files from that
measurement, including `src/bridge.ts`, have per-file L/F/B/S zero thresholds. #742 supplies
statement accounting and `json-summary`. The later Swift coverage producer adds another owned
script; the earlier 35-file measurement does not establish its coverage. The overall
`computer-use` inventory remains excluded: this result covers the TypeScript/Vitest slice,
not all native Swift, Rust or documentation code.

## Signing-certificate Node port (#803)

The original `scripts/make-signing-cert.sh` was inventoried but unmeasured shell, not a
zero-coverage Node baseline. Its deterministic setup now lives in
`packages/computer-use/scripts/make-signing-cert.mjs`, measured by the existing Istanbul
producer with a per-file zero L/F/B/S pin. Both inventory slices include it; no uncovered
caps or exclusions change. The launcher and embedded Bash silent-password reader remain
explicitly **unmeasured shell**. #695 stays open for remaining work.

Scoped local Node and Bun suites exercise disposable files and injected command results,
including EOF, command refusal, missing/nonexecutable tools, interrupts and filesystem
failures. No real certificate, signing identity, Keychain, trust or credential prompt runs.
The Node implementation measures L/F/B/S **31/4/23/35**, all covered, on both runtimes.
These scoped reports do not establish whole-package or native coverage. The independent
command-refusal mutation must fail before the patch is admitted. PR CI runs the full
package/accounting gates, including missing-report refusal.

## Baseline

Measured 2026-11-11 on macOS (Apple Silicon, Node 26.13.0) at `6d913af1` (main after #717, #718, #719,
#721, #723 and #724). Commands:

```sh
cd packages/computer-use
npm test                       # Vitest 5 + Istanbul, forks, 1 worker; writes coverage/primary/lcov.info
# Swift, instrumented rebuild of the shipped sources, see "Swift measurement"
```

`npm test`: 38 files passed / 4 skipped, 478 tests passed / 15 skipped, 179s. Skips are platform/live
gated (`linux-*`, `windows-*`, `macos-helper-live`).

### TypeScript (`computer-use-vitest`, 35 modules, Istanbul)

Hosted run `43173083073` on PR HEAD `e1df877e` measured the enforced signal:

| Host | Lines | Functions | Branches | Statements | Job |
| --- | --- | --- | --- | --- | --- |
| macOS | 1 | 0 | 1 | 1 | `131037037506` |
| Ubuntu | 1 | 0 | 1 | 1 | `131037793558` |
| WSL2 | 1 | 0 | 1 | 1 | `131041874646` |

The `darwin` caps equal macOS; `linux` caps take the per-counter maximum of Ubuntu and WSL2.
Each cap is lower than or equal to the previous 168/25/313/236 baseline. The 34 files
at 0/0/0/0 on all three hosts are pinned in `packages/computer-use/vitest.config.ts`; the exact
list is tested in `scripts/coverage-configs.test.ts`. The helpers from #749 were already pinned.

macOS per-file uncovered counts (lines / functions / branches / statements):

| File | Lines | Functions | Branches | Statements |
| --- | --- | --- | --- | --- |
| `extensions/computer-use.ts` | 0/51 | 0/10 | 0/30 | 0/63 |
| `scripts/build-native.mjs` | 0/154 | 0/23 | 0/120 | 0/167 |
| `scripts/docs-generators/generate-source-references.mjs` | 0/85 | 0/22 | 0/55 | 0/106 |
| `scripts/docs-generators/generate-tool-reference.mjs` | 0/65 | 0/15 | 0/68 | 0/79 |
| `scripts/rust-coverage.mjs` | 0/62 | 0/6 | 0/56 | 0/67 |
| `scripts/setup-helper.mjs` | 0/433 | 0/102 | 0/284 | 0/508 |
| `src/actions.ts` | 0/87 | 0/23 | 0/149 | 0/108 |
| `src/bridge.ts` | 1/1052 | 0/242 | 1/1162 | 1/1236 |
| `src/cdp.ts` | 0/270 | 0/85 | 0/174 | 0/326 |
| `src/config.ts` | 0/82 | 0/21 | 0/86 | 0/115 |
| `src/contract.ts` | 0/1 | 0/0 | 0/0 | 0/1 |
| `src/desktop.ts` | 0/67 | 0/21 | 0/88 | 0/85 |
| `src/find-params.ts` | 0/7 | 0/2 | 0/12 | 0/8 |
| `src/note.ts` | 0/74 | 0/18 | 0/85 | 0/88 |
| `src/outline-store.ts` | 0/42 | 0/7 | 0/14 | 0/47 |
| `src/outline.ts` | 0/317 | 0/92 | 0/302 | 0/400 |
| `src/output.ts` | 0/77 | 0/11 | 0/50 | 0/95 |
| `src/permissions.ts` | 0/26 | 0/11 | 0/18 | 0/35 |
| `src/platform/architecture.ts` | 0/8 | 0/2 | 0/8 | 0/9 |
| `src/platform/coerce.ts` | 0/7 | 0/3 | 0/15 | 0/9 |
| `src/platform/index.ts` | 0/21 | 0/15 | 0/7 | 0/24 |
| `src/platform/linux/backend.ts` | 0/47 | 0/26 | 0/79 | 0/54 |
| `src/platform/linux/helper.ts` | 0/200 | 0/49 | 0/96 | 0/246 |
| `src/platform/linux/wsl.ts` | 0/12 | 0/5 | 0/10 | 0/14 |
| `src/platform/macos/backend.ts` | 0/39 | 0/20 | 0/55 | 0/44 |
| `src/platform/macos/browser.ts` | 0/30 | 0/8 | 0/24 | 0/32 |
| `src/platform/macos/helper-path.mjs` | 0/16 | 0/2 | 0/17 | 0/17 |
| `src/platform/macos/helper.ts` | 0/233 | 0/68 | 0/83 | 0/271 |
| `src/platform/macos/permissions.ts` | 0/34 | 0/10 | 0/33 | 0/34 |
| `src/platform/windows/backend.ts` | 0/49 | 0/25 | 0/71 | 0/55 |
| `src/platform/windows/helper.ts` | 0/98 | 0/24 | 0/46 | 0/135 |
| `src/root-selection.ts` | 0/13 | 0/2 | 0/29 | 0/22 |
| `src/runtime.ts` | 0/47 | 0/22 | 0/9 | 0/56 |
| `src/state.ts` | 0/16 | 0/6 | 0/20 | 0/19 |
| `src/view.ts` | 0/85 | 0/25 | 0/76 | 0/106 |

At the earlier baseline only `src/bridge.ts` remained uncovered on all three hosts; #755 removes that dead path as documented above.

### Swift (`native/macos`, llvm-cov)

The maintained `computer-use-swift/primary` producer (#757) links the real production files,
including the unexecuted helper entry, into one headless binary. No regex extraction or copied
production implementation is measured. The previous sliced-source numbers are retired as a
current baseline.

Local initial reference on macOS arm64, Apple Swift 6.4.2. Hosted CI run `43183937349`, artifact `13929575830`, at prior HEAD `1a737e20` measured the same per-file counters with Apple Swift 6.4. The surrounding job failed later in the sync-ledger gate; a final-HEAD hosted receipt is still required:

| File | Lines missed/total | Functions missed/total | LLVM regions missed/total |
| --- | --- | --- | --- |
| `bridge.swift` | 4810/5149 | 705/786 | 2250/2464 |
| `agent_cursor.swift` | 162/162 | 19/19 | 38/38 |
| `agent_cursor_motion.swift` | 11/212 | 1/25 | 19/92 |
| `activity_glow.swift` | 152/152 | 27/27 | 39/39 |
| `helper_entry.swift` | 5/5 | 1/1 | 3/3 |
| Total | 5140/5680 | 753/858 | 2349/2636 |

These are LLVM source-view executable counters, not physical source lengths or Istanbul statements.
LLVM's own LCOV export has different DA/FNDA denominators (line gaps and function instantiations).
It even prints source-view LF/FNF summaries that disagree with those rows. The producer validates
those summaries against LLVM JSON, then recomputes LCOV summaries from its actual records so
shared accounting can validate them rather than accepting inconsistent totals:

| File | LCOV lines missed/rows | LCOV functions missed/rows |
| --- | --- | --- |
| `bridge.swift` | 3824/4111 | 716/797 |
| `agent_cursor.swift` | 131/131 | 19/19 |
| `agent_cursor_motion.swift` | 11/200 | 1/25 |
| `activity_glow.swift` | 142/142 | 28/28 |
| `helper_entry.swift` | 5/5 | 1/1 |
| Total | 4113/4589 | 765/870 |

Both units are retained in `summary.json`; the unmodified native export is
`llvm-lcov.info.txt`. Policy's advisory line/function references use the LCOV-record units.
No LLVM JSON lines, functions or regions are deleted to make those counters agree.
Swift emits no branch outcomes here. Regions remain a distinct unit in raw `llvm.json` and
`summary.json`; they are NEVER renamed to `BRDA`, branches or statements. LCOV accounts
lines/functions only, with a null branch reference. No all-native 100% claim is made.
Existing INV-17 window-lifecycle assertions remain separate behavior evidence, not coverage
evidence for this headless producer.

The following approximate area map is historical design context, not a current denominator:

Where `Bridge` touches the system directly today (call sites in `bridge.swift`): `AXUIElement*` 143,
`CGEvent*` 35, `NSWorkspace` 17, `CGWindowList*` 9, ScreenCaptureKit `SC*` 8, `FileHandle`/`FileManager`
12, `TIS*` 5, `NSPasteboard` 3, `DispatchQueue` 2. None of them go through an injectable seam.
Approximate area map (method counts from the source):

| Lines | Area | Methods |
| --- | --- | --- |
| 593-900 | stdin/socket server, request parsing, arg helpers | `run`, `runServer`, `processClient`, `handleLine`, `send`, `handleRequest`, `stringArg`... |
| 900-1200 | diagnostics, permission check/register/open, apps, frontmost | `diagnostics`, `checkPermissions`, `registerPermissions`, `listApps`, `getFrontmost` |
| 1200-1500 | input suppression, window focus/frame, root scoring/kind/modal, root listing | `beginInputSuppression`, `focusWindow`, `scoreWindow`, `rootKind`, `listRoots` |
| 1500-2400 | `look`: outline build, OCR, root observers, change waits | `look`, `buildLookOutline`, `recognizeText`, `ensureRootObserver`, `waitForRootChange` |
| 2400-3000 | `actBatch`, root delta, `axWaitFor`, scroll (AX actions, scroll bar), hit test, descendant walk | `actBatch`, `rootDelta`, `axWaitFor`, `setScrollBarValueOrAncestor`, `collectDescendants` |
| 3000-3300 | `axReadText`, `captureDisplay`, `desktopInput`, activation, clipboard, AX attribute readers | `desktopInput`, `activateApp`, `copyAttribute` |
| 3300-3600 | CG window list/pairing, AX element decoding | `cgWindowCandidates`, `pidForWindowId`, `frameForWindow` |
| 3600-4120 | window capture (SCK + fallbacks), event delivery, mouse/scroll/key/unicode posting, key maps | `captureWindow`, `postEvent`, `postKeyPress`, `physicalKeyStroke` |

## Seams

TypeScript, reuse what exists, add what is missing:

- Already injectable: `platformBackendForRuntime(platform)`, `currentPlatformBackend` property mocks,
  `PI_CU_SOCKET_PATH`, `nativeCalls`-style hosts elsewhere in the repo, `test/fixtures/fake-browser.mjs`,
  `fake-cdp.mjs`.
- `test/support/fake-helper.mjs`: Node server speaking the helper's NDJSON protocol (protocol 7 macOS,
  4 Windows/Linux) over a unix socket and over a fake child's stdio. Scriptable per command, including
  malformed lines, split frames, disconnects, `protocol` mismatch, slow replies. Drives
  `MacosHelperClient`, `WindowsHelperClient`, `src/platform/linux/helper.ts` and the activity-glow
  connection with no real process.
- `runProcess`, `spawn`, `fs`, `os`, `net`, `fetch`, `process.platform`, `process.env`, `Date.now` as
  a `deps` argument with `process`/`node:*` defaults, on `helper.ts`, `browser.ts`, `permissions.ts`,
  `setup-helper.mjs`, `build-native.mjs`. Same shape as resource-sampler's `nativeCalls(host)` (#375).
- `main(argv, deps)` exported from `setup-helper.mjs`, `build-native.mjs` and
  `docs-generators/*.mjs`, with the `import.meta` entry guard as the only top-level statement. Tests call
  `main` in-process. The existing subprocess tests stay as the real-run check; they no longer carry coverage.
- `fake-cdp.mjs` extended to a scriptable WebSocket target (close, error, malformed frames, delayed
  responses, protocol errors) for `src/cdp.ts`.
- Per-OS signals: `process.platform`-dependent branches take the platform as a parameter or `deps.platform`
  so both `darwin` and `linux` runs cover Windows/Linux/macOS arms. No test may require a Windows host.

Swift, introduce one injectable `World` and keep the shipped shape (single `bridge.swift`, `swiftc`
build, same four-file payload plus one entry file):

- `protocol AXClient`: `copyAttribute`, `setAttribute`, `performAction`, `actionNames`, `children`,
  `pid(of:)`, `frame(of:)`, `isSettable`, `elementAtPosition`, observer add/remove. `LiveAX` is the thin
  `AXUIElement*` wrapper. `FakeAX` is an in-memory element tree (roles, subroles, frames, values, actions,
  settable flags, cycles, errors per call) built from a JSON fixture.
- `protocol EventSink`: `post(CGEvent, tap)`, `postToPid`, plus a constructor seam for mouse/key/scroll/
  unicode events. `FakeSink` records `(type, flags, location, keycode, unicode)` and returns scripted results.
- `protocol WindowServer`: `CGWindowListCopyWindowInfo` and `SCShareableContent` window/display lists, and
  `protocol Screenshotter`: `SCScreenshotManager` and CG fallbacks (`CGWindowListCreateImage`, `screencapture`).
  Fakes return fixed `CGImage`s or scripted failures (permission denied, window gone, empty list).
- `protocol Workspace`: running apps, frontmost, activate, `open` launch, `NSPasteboard` read/write.
- `protocol InputSources`: `currentKeyboardInputSource()` and layout data, so the #113 gate is table-driven
  without relying on installed layouts.
- `protocol Clock`/`Sleeper` for settle waits and timeouts (several `usleep` and `DispatchQueue` sleeps
  are 100-1500 ms today); `FakeClock` advances instantly.
- `protocol Permissions` (`AXIsProcessTrusted*`, `CGPreflightScreenCaptureAccess`, TCC pane open).
- `struct World` holds them; `Bridge.init(world: World)`. The shipped `entry.swift` (the 5-line
  `@main struct PiComputerUseHelper`, moved out of `bridge.swift`) calls `World.live`. Test builds link
  `world_fake.swift` and a `tests/` entry instead, so there is no `#if` in shipped source and no fake code in
  the product binary. `build-native.mjs`, `package.json` `files` and the packed 90-file contract get
  `entry.swift` and `world_live.swift` (this also settles upstream #118's `native/macos/*.swift` glob).

Cost of the split: `bridge.swift` stays one file so upstream syncs still diff cleanly, but the
protocol/`world.` call-site rewrite touches most of its 143 `AXUIElement*` and 35 `CGEvent*` call sites.
Do it mechanically in two commits (introduce `World` with `Live*` and no behavior change, then fakes), and
land it before the next upstream sync or carry it as a recorded patch in `sync-patches.json` with a drop check.

## Swift measurement

Run `npm run coverage:swift --workspace @nredd/pi-computer-use` on macOS; other hosts print
`NOT RUN` without writing a fake empty report. The macOS `test:macos-native` suite runs the same
producer once as part of the hosted package gate. It replaces two sliced-source compiles with
one complete-source compile. `headless_tests.swift` retains pure/ref/keyboard assertions and
cursor-motion assertions and constructs injected `Bridge` instances for request-framing tests without
creating AppKit windows, starting the live daemon, posting input, capturing screens or reading/writing
the clipboard. AX handles and installed keyboard layout
data are used without querying live application trees. Live INV-17 is not this producer.

`helper_entry.swift` contains the unchanged shipped startup function. The test define suppresses
ONLY its `@main` attribute; all executable startup code remains compiled, mapped and uncovered.
Both production builders and the packed-source contract include the new entry source.

The fresh `coverage/swift/` directory contains the binary, profraw, merged profdata, raw LLVM
JSON, profile function dump, validated package-relative LCOV and SHA256/toolchain/argv/per-file
metadata. CI preserves that directory as `computer-use-swift-macos-14` and passes LCOV through the
ordinary shard fan-in. Exact artifact naming follows the matrix OS. New/missing production
sources, foreign paths, duplicate/empty profiles, malformed counters and failed tools refuse
collection. Mach-O profiles do not supply binary IDs, so each compile uses a unique Swift module
identity; every recorded profile function must belong to that binary's coverage map. Another
build of the same source cannot masquerade as its profile. No user-supplied old profile is merged.

The separate native signal stays report-only/excluded while #645 closes deterministic policy
gaps. Missing selected-host output fails accounting even though uncovered-count references are
advisory. Linux and WSL2 skip by declared host policy. Raw regions remain reviewable even though
the shared accounting schema currently supports only lines/functions/branches (and Istanbul
statements where available), not a native region cap.

## Live adapters decision (owner)

The owner decision in [#645 comment 6772202242](https://github.com/nredd/pi-harness/issues/645#issuecomment-6772202242)
allows narrow thin live AX/CGEvent/ScreenCaptureKit adapter exceptions until a dedicated
TCC-granted runner exists. This supersedes the older rejected-exemption text. An exception is
NOT coverage, and this producer does not remove those lines from its raw denominator.

No whole `Bridge`, AppKit state, errors, timing, fallback or business policy is exempt. Until
live calls are isolated behind deterministic seams, those misses remain visible and unfinished.
Subsequent S1-S5 work must cover the policy using real-source tests; a future dedicated runner
can measure the thin physical adapters. This PR neither grants TCC nor exercises the desktop.

## Phases

Each phase is one or more PRs, ends with a lowered cap in `coverage/policy.json` for the signals it touched
(caps only go down, per the base ratchet), and keeps `npm run check` and the macOS/Linux owned shards green.
Counts are the uncovered numbers above; phases do not need to land in this order except T0 first and S0 before S1+.

TypeScript:

- T0, accounting (done, #645): `computer-use-vitest` branch caps at the measured per-OS values, enforced
  (still `goal: excluded`; the validator allows enforced signals there). Files at 0/0/0 are pinned per file.
  Each later phase lowers the caps and adds its files to the pins.
- T1, pure modules (~240 lines): `actions.ts`, `config.ts`, `note.ts`, `output.ts`, `outline.ts`,
  `view.ts`, `state.ts`, `runtime.ts`, `find-params.ts`, `root-selection.ts`, `desktop.ts`, `platform/coerce.ts`,
  `platform/architecture.ts`, `extensions/computer-use.ts`. Table-driven unit tests, no seams needed.
- T2, scripts in-process (~600 lines, 127 functions): `main(argv, deps)` for `setup-helper.mjs`,
  `build-native.mjs`, both docs generators and the last 10 lines of `rust-coverage.mjs`. Fake `spawn`/`fs`/`fetch`.
- T3, helper clients (~300 lines): `fake-helper.mjs`; `macos/helper.ts`, `windows/helper.ts`, `linux/helper.ts`,
  glow connection. Includes protocol mismatch, partial lines, reconnect, timeout, restart-on-stale-binary.
- T4, backends and permissions (~175 lines): `macos/backend.ts`, `windows/backend.ts`, `macos/permissions.ts`,
  `permissions.ts`, `macos/browser.ts`, `platform/index.ts` (14 uncovered functions: the facade
  delegations, test with `platformBackendForRuntime` for all three platforms).
- T5, `cdp.ts` (144 lines, 138 branches): extend `fake-cdp.mjs`.
- T6, `bridge.ts` (164 lines, 312 branches after #723): by tool, one PR per group: find/roots, observe/search/inspect,
  act (all action kinds, outcomes, expect, stale/replacement roots), wait, browser tools, `launch_browser`
  lifecycle, desktop tools. Delete branches proven unreachable instead of testing them.
- T7, flip: `computer-use-vitest` `goal: "100-percent"`, caps 0/0/0 on darwin and linux. Needs #425 merged
  and the owner's explicit reversal of the computer-use exclusion; amend the `goal_reason` text in
  `docs/coverage.md` in the same commit.

Swift (darwin):

- S0, harness: `scripts/swift-coverage.mjs`, `computer-use-swift` signal (report-only), `entry.swift` split,
  `World`/`Live*` introduced with no behavior change; drop checks added to `sync-patches.json` if carried.
  Replaces the `BEGIN PURE`/`END PURE` regex extraction in `test/macos-native-pure.test.mjs` (kept regions are
  compiled from the real files instead of a string slice).
- S1, pure/geometry/ref store/keyboard/scroll math already in `PURE`, plus the 6 missed lines there, and
  `agent_cursor*.swift` (85 lines left), `activity_glow.swift` (152 lines, add a headless-safe test of its
  state machine with the AppKit pieces behind a `GlowSurface` protocol).
- S2, AX tree: `FakeAX` + fixture JSON; cover `look`/outline/OCR (`Screenshotter` fake returns a rendered
  `CGImage` fixture), descendant walks, scoring, modal classification, root listing, observers, `axReadText`, `axWaitFor`.
- S3, act: `actBatch` and every action (press/click/type/key/scroll incl. AX action, scroll bar and wheel
  fallback/drag/set value), delivery policy (pid vs HID), foreground retry, input suppression, `FakeSink` assertions
  on exact event streams.
- S4, desktop and system: `captureDisplay`, `desktopInput`, `activateApp` ranking/ambiguity, clipboard, permissions,
  diagnostics, window frame/focus, CG pairing, `InputSources` table (US/Danish/AZERTY/Pinyin without installed layouts).
- S5, server: black-box protocol tests of the instrumented helper (stdin and `serve` modes, malformed JSON,
  duplicate ids, client disconnect, lock contention, shutdown).
- S6, live adapters per the decision above; then flip `computer-use-swift` `goal: "100-percent"` at 0/0/0.

Documentation site (the Next.js sources under `packages/computer-use/docs`) and the Rust crates stay in the `computer-use`
inventory entry. T7/S6 must either give them producers or an owner-approved reclassification; this doc does not
decide that.

## Rust (native Ubuntu producer, runtime closure pending)

Re-measured 2026-11-09 with `CARGO_BUILD_JOBS=2 node scripts/rust-coverage.mjs --crate linux`
(26.9s, 33 passed / 1 ignored), identical to [rust-coverage.md](../packages/computer-use/docs/rust-coverage.md):
Linux crate **1163/2609 lines (44.58%), 125/295 functions (42.37%), 1681/4315 regions (38.96%)**.
This historical macOS-hosted receipt is not a native Ubuntu baseline. LLVM regions are regions,
NOT branches; absent Rust branch/statement records remain unmeasured. #758 adds maintained Ubuntu
collection and source-complete report-only `computer-use-linux-native/primary` accounting, including
separately named `cfg(test)` modules under `src`. Native absolute paths normalize to the package
inventory; missing executable maps fail. A map-free module/re-export-only source is conservatively
validated, not given fabricated executable counters. Inline/source test hits can inflate runtime
coverage, so this is not runtime 100%. See [rust-coverage.md](../packages/computer-use/docs/rust-coverage.md)
for pinned tools, artifacts, runtime and hosted per-file references.

Windows-native crate coverage remains UNMEASURED under #696. WSL/ARM64 cells do not produce this
Ubuntu-only signal. Headless Rust tests do not prove AT-SPI/X11/Wayland sessions or physical input.
#696 retains runtime seams for `atspi.rs`, `x11.rs`, `wayland.rs` and Windows UIA/capture policy.

## Constraints and risks

- Memory: the instrumented four-file Swift build took 14.6s here; run one `swiftc` at a time on a constrained host.
- The Swift `World` rewrite is the single largest diff and the main sync-drift risk with upstream; see above.
- Hosted macOS cannot cover live adapters (decision above). Linux/Windows TS arms are covered by faking the
  platform, which proves the branches, not the platform behavior (UPSTREAM.md's live-acceptance list stays manual).
- Gate time: `npm test` is 3.5 minutes of Vitest on one worker; T1-T6 will add a few minutes. Keep the
  `maxWorkers: 1` rule (real process groups, `swiftc`, cargo) and add budgets per `docs/test-worker-budgets.md`.
- Mutation discipline as in dev-tools: each phase PR records at least one mutation that its new tests fail.
