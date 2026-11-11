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

## Baseline

Measured 2026-11-09 on macOS (Apple Silicon, Node 26.13.0) at `ce6e6a7` (main `83973649` plus the
#637 carried fixes). Commands:

```sh
cd packages/computer-use
npm test                       # Vitest 5 + Istanbul, forks, 1 worker; writes coverage/primary/lcov.info
# Swift, instrumented rebuild of the shipped sources, see "Swift measurement"
```

`npm test`: 24 files passed / 4 skipped, 121 tests passed / 15 skipped, 206.6s (`npm run check`
total 4m02s). Skips are platform/live gated (`linux-*`, `windows-*`, `macos-helper-live`).

### TypeScript (`computer-use-vitest`, 33 modules, Istanbul)

Istanbul text summary: statements 46.20% (2123/4595), branches 38.87% (1339/3444), functions
47.61% (469/985), lines 48.64% (1861/3826). The policy reads the lcov rollup, which gives
**1960 uncovered lines, 2099 uncovered branches, 516 uncovered functions** (current caps:
macOS 1975 / 517 lines/functions, no branch cap; `goal: excluded` so branches carry no cap at all).
`src/platform/types.ts` is excluded as type-only and stays so (no executable output).

The totals above and the other rows are the pre-#705 baseline (T7 refreshes them). The four `scripts/` rows below were re-measured in #705 from `npm run check` in `packages/computer-use` (`coverage/primary/lcov.info`, darwin), so the totals still count their old 298 uncovered lines.

| File | Lines missed/total | Branches missed/total | Functions missed/total | Uncovered lines |
| --- | --- | --- | --- | --- |
| `extensions/computer-use.ts` | 19/50 | 27/28 | 7/9 | 175-176,185,232-233,238-241,245-248,252-254,258-260 |
| `scripts/build-native.mjs` | 0/154 | 0/120 | 0/23 | none |
| `scripts/docs-generators/generate-source-references.mjs` | 0/85 | 0/55 | 0/22 | none |
| `scripts/docs-generators/generate-tool-reference.mjs` | 0/65 | 0/68 | 0/15 | none |
| `scripts/rust-coverage.mjs` | 0/62 | 0/56 | 0/6 | none |
| `scripts/setup-helper.mjs` | 308/428 | 197/287 | 71/99 | 40-42,53-54,58,62,68-70,72,76,80-82,84,89-90,94-99,103-108,110-112,114,116,120-126,128,319,323-324,332-333,336-337,342-345,368-370,385-386,... |
| `src/actions.ts` | 16/55 | 29/94 | 5/17 | 38,42-43,47-52,76-77,103,105-108 |
| `src/bridge.ts` | 486/1118 | 828/1312 | 90/246 | 341,371-373,399,401,403,463,467-468,470,476,480,486,492-494,501-502,510-511,517-518,520,535-536,538-539,541,547,575,605-607,630,635,648-649,... |
| `src/cdp.ts` | 144/272 | 141/178 | 53/85 | 91-92,104-105,109,140-141,143-144,146,148,153,157,161-163,165,169,173-177,182,186-190,194-197,200,206-209,214-216,223-224,232-233,239-241,... |
| `src/config.ts` | 22/58 | 37/56 | 2/9 | 47,51-66,71-73,75,117 |
| `src/desktop.ts` | 0/66 | 9/88 | 0/21 | - |
| `src/find-params.ts` | 0/7 | 1/12 | 0/2 | - |
| `src/note.ts` | 17/74 | 46/85 | 3/18 | 76-78,86-88,112,118,149,162-163,165,176-177,192-194 |
| `src/outline.ts` | 141/317 | 128/305 | 35/92 | 150-151,172,174-177,183,302-311,314-315,324-325,329-331,333-336,382-385,393-394,405-406,461-466,527-532,536-541,543,552-554,567-568,590-591,... |
| `src/output.ts` | 7/79 | 16/52 | 0/11 | 51-56,66 |
| `src/permissions.ts` | 26/26 | 18/18 | 11/11 | 52,56,60,64,73-74,76,80,82-83,85-89,91-92,94-95,97,100-103,105,110 |
| `src/platform/architecture.ts` | 0/8 | 2/8 | 0/2 | - |
| `src/platform/coerce.ts` | 2/7 | 3/15 | 0/3 | 8-9 |
| `src/platform/index.ts` | 16/21 | 3/9 | 14/15 | 32-33,37,40-51,58 |
| `src/platform/linux/backend.ts` | 5/46 | 30/77 | 2/25 | 108,115,119,152,155 |
| `src/platform/linux/helper.ts` | 26/202 | 40/102 | 13/49 | 48,50,53-54,83-87,89-90,93-94,238,252,271-272,275-277,306-308,327-329 |
| `src/platform/macos/backend.ts` | 30/38 | 46/55 | 15/20 | 8-9,11,13-16,23,27-28,37-38,40-43,82-83,92,95,99,106-109,111,136,140-141,145 |
| `src/platform/macos/browser.ts` | 23/30 | 20/24 | 6/8 | 57,61,65-66,68-70,74,82,85-88,90-91,93,101-106,108 |
| `src/platform/macos/helper-path.mjs` | 4/16 | 0/17 | 1/2 | 22-24,26 |
| `src/platform/macos/helper.ts` | 196/219 | 75/81 | 61/63 | 28-29,37-39,44,48-53,55-56,60-62,64,69-72,74,83-90,93-96,98-99,101,112,114-115,120-121,123-126,129-132,135-137,140-141,144-145,148-150,... |
| `src/platform/macos/permissions.ts` | 33/36 | 41/41 | 12/12 | 23,27-28,33,37,51,55-57,86,94-96,98-99,101-102,104,107-108,111-112,114,117,120,125,127,131-132,134,136,142,145 |
| `src/platform/windows/backend.ts` | 48/49 | 71/71 | 25/25 | 8,12,15,18,21,23,25,28,30,35-36,45,49-52,77-81,86-87,91-94,96-97,102,105,108-110,113-116,119,122,125,128,131,134,136-137,139-140 |
| `src/platform/windows/helper.ts` | 78/88 | 40/42 | 21/21 | 24,28-43,45,56-59,61-62,64-71,75,77-79,83-94,98-104,106-114,116-118,124-134 |
| `src/root-selection.ts` | 0/13 | 6/29 | 0/2 | - |
| `src/runtime.ts` | 5/49 | 4/11 | 6/25 | 48,66,70-71,81 |
| `src/state.ts` | 2/16 | 7/20 | 0/6 | 90-91 |
| `src/view.ts` | 8/87 | 30/76 | 7/25 | 78,133,138-142,145 |
| **Total** | **1960/3826** | **2099/3444** | **516/985** | |

Fully covered modules: `src/contract.ts`, `src/desktop.ts` (lines), `src/find-params.ts` (lines),
`src/root-selection.ts` (lines), `src/platform/architecture.ts` (lines). Branches in those still
miss: `desktop.ts` 9, `root-selection.ts` 6, `find-params.ts` 1, `architecture.ts` 2.

Why so low, in order of size:

- `src/bridge.ts` holds 486 lines / 828 branches / 90 functions: the tool executors, `launch_browser`,
  wait/expect handling and the CDP routing. Existing suites drive it through a mocked
  `currentPlatformBackend` but only on the happy path of find/observe/act.
- Subprocess-only checks do not count. `scripts/build-native.mjs`, both docs generators and
  `scripts/rust-coverage.mjs` used to be exercised only by tests that spawn `node` or `tsx` (or
  missed their error arms); they now export `main(argv, deps)` and are at 0 uncovered via
  `test/build-native.test.mjs`, `test/docs-generators.test.mjs` and
  `test/rust-coverage-errors.test.mjs` (#705). Most of `scripts/setup-helper.mjs` still needs the
  same in-process `main(argv, deps)`.
- Platform helpers talk to real sockets/children. `src/platform/macos/helper.ts` 196, `windows/helper.ts`
  78, `linux/helper.ts` 26 uncovered lines. The Windows and Linux halves are plain TS and only need a fake
  child, not a Windows or Linux host.
- `src/cdp.ts` (144 lines, 141 branches) has `test/fixtures/fake-cdp.mjs` but the WebSocket client
  paths (errors, closes, timeouts, frames) are mostly unreached.
- `src/permissions.ts` and `src/platform/macos/permissions.ts` are at 0: no test drives permission
  prompting.

### Swift (`native/macos`, llvm-cov)

Swift has no maintained producer. Real measurement with an instrumented rebuild of all four shipped
sources plus a run of the helper (`shutdown` only, to get a valid denominator), and the two existing
compiled-test regions instrumented the same way:

```sh
S=packages/computer-use/native/macos
swiftc -Onone -profile-generate -profile-coverage-mapping -target arm64-apple-macosx14.0 \
  -framework ApplicationServices -framework AppKit -framework ScreenCaptureKit -framework Foundation -framework SwiftUI \
  $S/activity_glow.swift $S/agent_cursor.swift $S/agent_cursor_motion.swift $S/bridge.swift -o full
echo '{"id":"1","cmd":"shutdown"}' | LLVM_PROFILE_FILE=full.profraw ./full
xcrun llvm-profdata merge -sparse full.profraw -o full.profdata   # use `$(xcrun -f llvm-profdata)`
xcrun llvm-cov report -instr-profile=full.profdata ./full
```

| File | Executable lines | Regions | Functions | Covered by suites today |
| --- | --- | --- | --- | --- |
| `bridge.swift` | 4586 | 2136 | 694 | 163 lines (3.6%): `PURE` region 134/139 + `KEYBOARD LAYOUT` region 29/30, compiled by `test/macos-native-pure.test.mjs` |
| `agent_cursor.swift` | 162 | 38 | 19 | 88 lines (54.3%), INV-17 |
| `agent_cursor_motion.swift` | 212 | 92 | 25 | 201 lines (94.8%), INV-17 |
| `activity_glow.swift` | 152 | 39 | 27 | none; the 79 lines hit by a bare `shutdown` run are startup only |

Test harness note: INV-17 (`test/invariants.test.mjs`) compiles `agent_cursor*.swift` plus
`agent_cursor_tests.swift` and reports 81.62% lines (506 incl. the test file) / 74.14% regions;
the `PURE` and `KEYBOARD LAYOUT` regions of `bridge.swift` are cut out by regex at test time. Nothing
else in the 3550-line `final class Bridge` (163 methods) is compiled by any test, only by
`build-native` and the live test, which does not collect coverage.

Branch units: Swift emits no branch records (`llvm-cov export` returns an empty `branches` array,
confirmed above), so **regions are the Swift branch signal**. Every `if`/`guard` arm, `switch` case,
`??`, ternary arm and `&&`/`||` operand is a region. The converter below writes each missed region
as a `BRDA` row so `check-coverage` treats it like any other signal (a 0-region report with executable
lines fails "Branch producer missing" the same as for Istanbul).

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

- `scripts/swift-coverage.mjs`, modeled on `scripts/rust-coverage.mjs`: build instrumented test binary
  (`-profile-generate -profile-coverage-mapping`, all production sources minus `entry.swift`, plus `world_fake.swift`
  and `tests/*.swift`), run with `LLVM_PROFILE_FILE=<dir>/%p.profraw`, merge, `llvm-cov export` JSON, emit
  `coverage/swift/lcov.info` with `DA`, `FN`/`FNDA` and one `BRDA` per region (hit count, `-` for unreachable line).
  `world_fake.swift` and `tests/` are non-shipped verification code, classified individually under the policy's `verification_helpers` (never llvm-cov filters); no shipped source is excluded.
- Two producers merged into one profdata: (a) in-process unit tests with `FakeWorld`; (b) black-box protocol
  tests, a TS Vitest suite spawning the instrumented helper (stdin NDJSON mode, then `serve --socket` mode) with
  a fixture world selected by `PI_CU_WORLD_FIXTURE`, which only `world_fake.swift` reads. (b) covers `run`,
  `runServer`, `processClient`, `handleLine`, `send`, signal/exit paths (`exit(0)`, `exit(1)`, lock contention)
  that cannot run in-process; `exit` flushes profraw through the profile runtime's atexit hook.
- Policy: new package-level signal `computer-use-swift`, `darwin` only (like `python-benchmarks`), `goal`
  `100-percent`, per-OS reference from a hosted `macos-14` run, `max_uncovered.darwin` lines/functions/branches
  starting at the measured values and ratcheting down per phase.

## Live adapters decision (owner)

`LiveAX`, `LiveSink`, `LiveWindowServer`, `LiveScreenshotter`, `LiveWorkspace`, `LiveInputSources`,
`LivePermissions` wrap real system calls. Kept to one expression per method (no branching, no policy), they
still have to execute for 0 uncovered lines. Hosted `macos-14` cannot grant Accessibility or Screen
Recording to a freshly built helper, so these can only be covered on a TCC-granted host. Options:

1. Run `test:macos-live` (disposable fixture app windows from `scripts/fixtures/alert-app.swift` and
   `event-probe.swift`, plus a restorable clipboard round trip) against the instrumented helper on the
   self-hosted macOS runner (`docs/self-hosted-runners.md`) with TCC pre-granted, and merge its profraw
   into the `computer-use-swift` producer. Recommended. Needs a runner decision and a pre-granted TCC
   database for the instrumented binary's identifier.
2. Move the live adapters into a `verification_helpers`-style exclusion. Rejected: shipped runtime code is
   never a verification helper (coverage.md), and policy forbids widening exclusions to pass.
3. Leave `computer-use-swift` at a nonzero live-adapter cap. Rejected: there is no mode with a nonzero floor.

Until option 1 is available, phases S0-S4 get everything behind the seam to 0 and leave only the adapter
files uncovered; the signal stays report-only and the goal stays `excluded` for that file set.

## Phases

Each phase is one or more PRs, ends with a lowered cap in `coverage/policy.json` for the signals it touched
(caps only go down, per the base ratchet), and keeps `npm run check` and the macOS/Linux owned shards green.
Counts are the uncovered numbers above; phases do not need to land in this order except T0 first and S0 before S1+.

TypeScript:

- T0, accounting: add `computer-use-vitest` branch caps at the measured per-OS values (macOS 2099, Linux
  measured by CI), enforce them (flip `enforcement` to `enforced`; still `goal: excluded`). Add the fail-closed
  checks the other signals have. Prerequisite for ratcheting.
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
- T5, `cdp.ts` (144 lines, 141 branches): extend `fake-cdp.mjs`.
- T6, `bridge.ts` (486 lines, 828 branches): by tool, one PR per group: find/roots, observe/search/inspect,
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

## Rust (out of scope, numbers only)

Re-measured 2026-11-09 with `CARGO_BUILD_JOBS=2 node scripts/rust-coverage.mjs --crate linux`
(26.9s, 33 passed / 1 ignored), identical to [rust-coverage.md](../packages/computer-use/docs/rust-coverage.md):
Linux crate **1163/2609 lines (44.58%), 125/295 functions (42.37%), 1681/4315 regions (38.96%)**.
LLVM emits no Rust branch records either, so regions are again the branch signal. Windows crate: NOT RUN on macOS/Linux.
A follow-up should reuse the `World`/seam approach for `atspi.rs`, `x11.rs`, `wayland.rs` and the Windows UIA/capture code.

## Constraints and risks

- Memory: the instrumented four-file Swift build took 14.6s here; run one `swiftc` at a time on a constrained host.
- The Swift `World` rewrite is the single largest diff and the main sync-drift risk with upstream; see above.
- Hosted macOS cannot cover live adapters (decision above). Linux/Windows TS arms are covered by faking the
  platform, which proves the branches, not the platform behavior (UPSTREAM.md's live-acceptance list stays manual).
- Gate time: `npm test` is 3.5 minutes of Vitest on one worker; T1-T6 will add a few minutes. Keep the
  `maxWorkers: 1` rule (real process groups, `swiftc`, cargo) and add budgets per `docs/test-worker-budgets.md`.
- Mutation discipline as in dev-tools: each phase PR records at least one mutation that its new tests fail.
