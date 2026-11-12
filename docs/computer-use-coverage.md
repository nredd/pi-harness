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

Hosted run `43151253223` on PR HEAD `8c7f6487` measured the enforced signal:

| Host | Lines | Functions | Branches | Statements | Job |
| --- | --- | --- | --- | --- | --- |
| macOS | 168 | 25 | 313 | 236 | `130970325724` |
| Ubuntu | 168 | 25 | 313 | 236 | `130968037667` |
| WSL2 | 168 | 25 | 312 | 235 | `130971881797` |

The `darwin` caps equal macOS; `linux` caps take the per-counter maximum of Ubuntu and WSL2.
Each cap is lower than the previous 215/43/464/329 and 234/48/488/354 baseline. The 34 files
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
| `src/bridge.ts` | 168/1069 | 25/243 | 313/1206 | 236/1261 |
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

Only `src/bridge.ts` remains uncovered on macOS. The WSL2 branch and statement counts are each one lower.

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
3. Leave `computer-use-swift` at a nonzero live-adapter cap. Rejected: the Swift signal is not enforced at a nonzero cap; only `computer-use-vitest` is, as the T0 ratchet.

Until option 1 is available, phases S0-S4 get everything behind the seam to 0 and leave only the adapter
files uncovered; the Swift signal stays report-only and the goal stays `excluded` for that file set.

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
