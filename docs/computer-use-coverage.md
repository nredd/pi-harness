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

Istanbul text summary: statements 82.84%, branches 74.67%, functions 79.98%, lines 85.24%. The policy
reads the lcov rollup, which gives **572 uncovered lines, 871 uncovered branches, 203 uncovered
functions** on macOS. `src/platform/types.ts` is excluded as type-only and stays so (no executable
output).

The signal is **enforced** since #645 T0, with caps equal to the measured per-OS uncovered counts:

| OS | Lines | Functions | Branches | Source |
| --- | --- | --- | --- | --- |
| darwin | 572 | 203 | 871 | local `npm test` at `6d913af1` |
| linux (max of Ubuntu and WSL2) | 695 | 238 | 1124 | hosted `coverage-ubuntu-24.04-computer-use` 692/236/1124 and `coverage-wsl2-subagents-computer-use` 695/238/1124, CI run `43024823914` at `df95d355` (before #723) |

The Linux numbers predate #723 (`bridge.ts` setup, targets and look), so they are an upper bound; the
next hosted run on a commit at or after `6d913af1` should tighten them (never raise them). Statement
accounting does not exist yet (#700), so statements carry no cap.

Files at 0/0/0 on all three OSes in the hosted artifacts (`outline.ts`, `outline-store.ts`,
`setup-helper.mjs`, `build-native.mjs`, both docs generators, `rust-coverage.mjs`, `macos/helper.ts`,
`macos/helper-path.mjs`; `contract.ts` has one line and no functions or branches, so it is not pinned) are additionally locked per file by `coverage.thresholds` in
`packages/computer-use/vitest.config.ts`, so a regression there fails `npm test` itself. `cdp.ts` joins
that list when #726 merges.

| File | Lines missed/total | Branches missed/total | Functions missed/total | Uncovered lines |
| --- | --- | --- | --- | --- |
| `extensions/computer-use.ts` | 20/51 | 29/30 | 8/10 | 175-176,184,187,234-235,240-243,247-250,254-256,260-262 |
| `scripts/build-native.mjs` | 0/154 | 0/120 | 0/23 | none |
| `scripts/docs-generators/generate-source-references.mjs` | 0/85 | 0/55 | 0/22 | none |
| `scripts/docs-generators/generate-tool-reference.mjs` | 0/65 | 0/68 | 0/15 | none |
| `scripts/rust-coverage.mjs` | 0/62 | 0/56 | 0/6 | none |
| `scripts/setup-helper.mjs` | 0/433 | 0/284 | 0/102 | none |
| `src/actions.ts` | 8/58 | 20/102 | 3/18 | 38,42-43,103,105-108 |
| `src/bridge.ts` | 164/1063 | 312/1199 | 25/242 | 1103,1123-1129,1155-1160,1173-1174,1285-1290,1294-1295,1299-1306,1308,1327-1331,1335-1339,1351-1354,1357,1361-1371,1377-1381,1387-1388,1397,... |
| `src/cdp.ts` | 144/272 | 138/178 | 54/85 | 91-92,104-105,109,140-141,143-144,146,148,153,157,161-163,165,169,173-177,182,186-190,194-197,200,206-209,214-216,223-224,232-233,239-241,... |
| `src/config.ts` | 3/82 | 25/86 | 1/21 | 84,143,189 |
| `src/contract.ts` | 0/1 | 0/0 | 0/0 | none |
| `src/desktop.ts` | 0/67 | 6/88 | 0/21 | none |
| `src/find-params.ts` | 0/7 | 0/12 | 0/2 | none |
| `src/note.ts` | 8/74 | 31/85 | 0/18 | 118,149,162-163,165,192-194 |
| `src/outline-store.ts` | 0/42 | 0/14 | 0/7 | none |
| `src/outline.ts` | 0/317 | 0/302 | 0/92 | none |
| `src/output.ts` | 7/79 | 16/52 | 0/11 | 51-56,66 |
| `src/permissions.ts` | 26/26 | 18/18 | 11/11 | 52,56,60,64,73-74,76,80,82-83,85-89,91-92,94-95,97,100-103,105,110 |
| `src/platform/architecture.ts` | 0/8 | 2/8 | 0/2 | none |
| `src/platform/coerce.ts` | 0/7 | 0/15 | 0/3 | none |
| `src/platform/index.ts` | 16/21 | 3/9 | 14/15 | 32-33,37,40-51,58 |
| `src/platform/linux/backend.ts` | 5/47 | 18/79 | 2/26 | 109,116,120,155,158 |
| `src/platform/linux/helper.ts` | 26/202 | 40/102 | 13/49 | 48,50,53-54,83-87,89-90,93-94,238,252,271-272,275-277,306-308,327-329 |
| `src/platform/linux/wsl.ts` | 5/12 | 1/10 | 3/5 | 18-19,21-22,24 |
| `src/platform/macos/backend.ts` | 26/39 | 45/55 | 11/20 | 8-9,11,13-16,23,27-28,37-38,40-43,83,92,95,99,106-109,111,146 |
| `src/platform/macos/browser.ts` | 22/30 | 17/24 | 5/8 | 57,61,65-66,68-70,82,85-88,90-91,93,101-106,108 |
| `src/platform/macos/helper-path.mjs` | 0/16 | 0/17 | 0/2 | none |
| `src/platform/macos/helper.ts` | 0/219 | 0/81 | 0/62 | none |
| `src/platform/macos/permissions.ts` | 33/36 | 41/41 | 12/12 | 23,27-28,33,37,51,55-57,86,94-96,98-99,101-102,104,107-108,111-112,114,117,120,125,127,131-132,134,136,142,145 |
| `src/platform/windows/backend.ts` | 48/49 | 71/71 | 25/25 | 8,12,15,18,21,23,25,28,30,35-36,45,49-52,77-81,86-87,91-94,96-97,102,105,108-110,113-116,119,122,125,128,131,134,136-137,139-140 |
| `src/platform/windows/helper.ts` | 7/88 | 12/42 | 8/21 | 42-43,58-59,132-134 |
| `src/root-selection.ts` | 0/13 | 0/29 | 0/2 | none |
| `src/runtime.ts` | 2/49 | 3/11 | 5/25 | 48,66 |
| `src/state.ts` | 0/16 | 4/20 | 0/6 | none |
| `src/view.ts` | 2/87 | 19/76 | 3/25 | 78,142 |
| **Total** | **572/3877** | **871/3439** | **203/1014** | |

Fully covered (0/0/0) modules: `src/contract.ts`, `src/outline.ts`, `src/outline-store.ts`,
`src/platform/macos/helper.ts`, `src/platform/macos/helper-path.mjs`, `scripts/setup-helper.mjs`,
`scripts/build-native.mjs`, both docs generators and `scripts/rust-coverage.mjs` (#704, #705, #717, #718,
#724). At 0 lines/functions but with branches missing: `src/desktop.ts` 6, `src/platform/architecture.ts` 2,
`src/state.ts` 4.

Largest remaining gaps, in order of size:

- `src/bridge.ts` holds 164 lines / 312 branches / 25 functions, mostly the act paths and the tail of the
  file (#710 to #712).
- `src/cdp.ts` (144 lines, 138 branches, 54 functions) has `test/fixtures/fake-cdp.mjs` but the WebSocket
  client paths (errors, closes, timeouts, frames) are unreached until #726.
- Backends and permissions: `src/permissions.ts`, `src/platform/macos/permissions.ts`,
  `src/platform/macos/backend.ts`, `src/platform/macos/browser.ts`, `src/platform/windows/backend.ts`,
  `src/platform/index.ts`; no test drives permission prompting (#707).
- `src/platform/linux/helper.ts` 26 and `windows/helper.ts` 7 uncovered lines (#713); both are plain TS and
  only need a fake child, not a Windows or Linux host.
- `extensions/computer-use.ts` 20 lines (#703).

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
