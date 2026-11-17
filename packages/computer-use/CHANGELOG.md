# Changelog

All notable changes to `@nredd/pi-computer-use` are documented here.

## [Unreleased]

- Move the entry to `src/index.ts`, retire the inherited website/media/workflows, preserve prose, and build native payloads instead of committing them (#870).

### Removed

- `UPSTREAM.md` is no longer shipped or maintained. `docs/macos-root-targeting.md` moved into the README.

### Added

- Gate actual AppKit cursor overlay lifecycle behind exact `PI_COMPUTER_USE_LIVE=1`; default invariants retain motion, compiler and fake gate-refusal assertions and report the live check as `NOT RUN`. Source mutation controls never execute the unsafe fixture (nredd/pi-harness#819).
- Deterministic finite-input tests close the five remaining cursor-motion LLVM regions and ten pure-key/selection policy regions in `bridge.swift`. Numerical safeguards stay intact; no live desktop input, capture or TCC runs (nredd/pi-harness#810, #645).
- Native Windows x64 compiler/test/LLVM CI producer with raw reports, source-hash metadata and deterministic input-policy/null-capture refusal controls. ARM64 and live desktop acceptance remain separate; absent native branch/statement counters remain unmeasured (nredd/pi-harness#696).

- Real-source Swift ref ownership and look payload assertions cover transfer guards, exact lookup, FIFO snapshot eviction, optional fields and recursive child order without AX queries. Window equality, destination ownership, optional flags and child order have executable mutation controls. Distinct handles use an owned non-GUI child PID, reaped before assertions; a source-level guard rejects AX queries/actions. Runtime behavior is unchanged (nredd/pi-harness#769).

- `test:async` measures the complete verification-only `scripts/check-async.mjs` at zero uncovered lines/functions/branches/statements with deterministic safety-path tests and retained real child-process checks, independently of runtime caps. Missing selected-host reports fail accounting; the other verification scripts remain unmeasured (nredd/pi-harness#759).
- `coverage:swift` links complete production Swift sources into a headless test binary and preserves per-file LLVM/profile evidence in hosted macOS CI. The new native signal is report-only, not a 100% claim; thin live adapters remain documented exceptions and all unexecuted source stays visible (nredd/pi-harness#757).

- `blocked_apps` config (and `PI_COMPUTER_USE_BLOCKED_APPS`): `observe_ui`, `act_ui` and `desktop_input` fail closed with `app_blocked` for apps on a bundle-id list that defaults to password managers, Keychain Access and terminals. System authentication agents (`com.apple.SecurityAgent`, `com.apple.loginwindow`, `com.apple.coreservices.uiagent`, `com.apple.ScreenSaver.Engine`) are always blocked. `desktop_input` refuses `activateApp` of a blocked app, keys while one is frontmost and pointer input that lands on one, checked by the helper immediately before delivery. `find_roots` marks blocked roots `blocked`. Opt out with `"blocked_apps": []` in the user-global file only; project config and the environment variable only add ids. Keys are also refused while the focused (not just frontmost) app is blocked, and coordinate `act_ui` checks the target point like `desktop_input`. The helper also refuses UI commands with `screen_locked` while the macOS session is locked (nredd/pi-harness#646).
- `act_ui` `secondaryAction` (runs a named AX action such as `AXShowMenu` that the element advertises, validated against `inspect_ui`), `selectText` (sets `AXSelectedTextRange`, UTF-16 `start`/`length`, read back) and `paste` (inserts through the pasteboard and `cmd+v`, then restores the previous clipboard unless something else wrote to it; the item is marked transient, auto-generated and concealed for clipboard history managers and written (and the clipboard restored) current-host-only so Universal Clipboard never syncs a pasted or host-only item, `cmd+v` presses the layout's Command-map key for `v` (key 9 on Russian, Greek and "Dvorak - QWERTY Command") or fails with `layout_unsupported` when the layout is unreadable, a helper killed mid-paste leaves the pasted text on the clipboard, and a paste that observes no change is `unknown` and never retried). `paste` is refused under strict headless mode and, under HID delivery, refuses a blocked focused app before touching the clipboard and again right before `cmd+v`, like `typeText`; `secondaryAction` and `selectText` are AX-only. macOS only: Linux and Windows fail them with `unsupported_command`. Not yet verified on a live Mac (nredd/pi-harness#647).

### Changed

- Port deterministic `make-signing-cert.sh` setup to measured `scripts/make-signing-cert.mjs` with injected commands and disposable-file tests. Preserve the documented shell command and existing Bash/OpenSSL dependencies; the launcher and silent-password shell fragment remain unmeasured (nredd/pi-harness#803).
- Delete the unreachable `currentTargetOrThrow` missing-window guard after tracing all public callers; absent observations still fail at the capture boundary and browser states stay on CDP. Ratchet TypeScript aggregate and per-file `bridge.ts` L/F/B/S thresholds to zero (nredd/pi-harness#755).
- `StateStore`, `ResourceScheduler`, the output store and `stabilizeRefs` drop dead arms (the empty-key eviction guard, never-rejecting `tail` catches, a fresh-ref collision loop); an empty restored `stateId` no longer disables `StateStore` eviction (it used to stop the loop and let the store grow unbounded); otherwise behavior is unchanged. `extensions/computer-use.ts`, `desktop.ts` and the pure modules are covered on every OS through the `process.platform` seam (nredd/pi-harness#703, #645).
- `sync-patches.json` patches, `files`, `UPSTREAM.md` rows and `check-sync-reverts.mjs` cases are sorted (enforced by `test/sync-ledger.test.mjs`), each patch names its `UPSTREAM.md` `rows`, and `npm run check` runs `check-upstream-sync.mjs` against the pinned upstream commit when `PI_CU_UPSTREAM_SYNC=1` (CI on Linux); 14 previously undeclared drifted paths are now declared (nredd/pi-harness#720).
- `LinuxHelperClient` drops unreachable guards (an already-aborted check in `runProcess`, whose only caller passes a fresh signal, a redundant re-check in `process()` and identity checks on single-flight promises) and shares one settle handler per promise; behavior is unchanged (nredd/pi-harness#713, #645).
- `scripts/setup-helper.mjs` exports `main(argv, deps)` (host seams injected, `import.meta` entry guard only at top level) so it is measured in process. CLI behavior is unchanged; two unreachable arms (a non-darwin check in the local signing path, a duplicate bundle-name check in archive search) are gone (nredd/pi-harness#704, #645).

### Fixed

- Hash nested Rust fixture sources recursively instead of reading `tests/fixtures` as a file in native coverage; retain all locked/source inputs without changing coverage selection (#983).

- Reject malformed native Windows text, button, key and scroll params before mutation; prove caller-resolved path isolation through the real helper with a valid owned drag (#983).

- Rebuild native Windows input without caller `resolved*` fields, admit every drag vertex against current ownership, and forbid implicit action restore/foreground. Preserve UIA focus uncertainty and propagate all hit/ancestor identity failures (#983).

- Preserve native Windows uncertainty after post-delivery observation or value-read-back mismatch, and let active physical input clean up before bounded terminal exit. Exercise actual helper NDJSON in the disposable GUI fixture; require explicit browser `appName` and document `preserveFocus` foreground refusal (#983).
- Retain available native Windows failed-build diagnostics without masking the original error (#983).

- Refuse Windows ref-coordinate input when current UIA identity, bounds, hit testing or desktop/session permissions cannot be verified. Never substitute cached coordinates or reused AutomationIds. Add scoped discovery, bounded fresh selected-window capture, idempotent restore and a cross-process physical-input mutex; advertise guarded-helper capability without changing protocol `4`. Add disposable native Windows fixture/build artifacts, with real WSL and multi-monitor acceptance still outstanding (#983, refs #673).

- Settle the fake-helper socket self-test when a connection closes before reply, so restart polling can retry rather than wait on an unresolved request (nredd/pi-harness#835).

- Windows helper commands now reject promptly with `Operation aborted.` for post-write cancellation, clear the pending request, timer and listener on every completion/write-error path, and ignore late replies. This cancels the local wait, not native work already sent (nredd/pi-harness#750).
- Browser `act_ui` rejects ref-only `moveMouse` with `invalid_args` instead of sending absent coordinates to CDP; use explicit `x`/`y`. Empty browser `keypress` rejection now carries `invalid_args`. Both fail before any batch delivery or epoch change; desktop behavior is unchanged (nredd/pi-harness#748).
- Linux and Windows helper `command()` and macOS `daemonCommand()` now reject at once with `Operation aborted.` when the `AbortSignal` is already aborted, instead of sending the request to the helper and waiting out the command timeout (an abort event never re-fires for a signal that is already aborted). Linux and Windows also re-check after the install check and helper start, so a signal aborted during startup sends nothing (nredd/pi-harness#735).
- Browser `act_ui` rejects a `keypress` with no `keys` (missing, empty or not an array) with "keypress.keys must contain at least one key." before the write epoch advances, like desktop states; it used to report success without sending a key (nredd/pi-harness#748, keypress half).
- A macOS helper that drops the socket mid-command (crash, restart) now rejects the command at once with a `HelperTransportError` coded `helper_disconnected`, instead of stalling for the full command timeout (15 s by default, longer for `axWaitFor`) and reporting a timeout. A late `close` after a reply, timeout, abort or error cannot settle the command twice. The Windows helper had the same gap (an exited helper left requests pending until their timeout) and now rejects them with the same code when its process closes; Linux rejected pending requests on process `exit`, which can fire while stdout still holds a complete reply (a command that succeeded was reported as failed); it now fails them on `close`, after stdout is drained, and still forgets the child on `exit` so the next command respawns. Linux and Windows also frame each helper process's stdout with its own line buffer, so a dead helper's partial line can no longer be glued onto its successor's first reply (nredd/pi-harness#725).
- `search_ui` and `expand_ui` on a browser state no longer escalate to desktop OCR or a scoped look, which failed with "No current controlled window"; they return the cached outline result. Desktop `wait_for` with an empty or whitespace `stateId` returns the coded "No observation state is available" error instead of a raw `TypeError` (nredd/pi-harness#722).
- `observe_ui` folded summaries pluralize unnamed-role children correctly: `1 nodes` / `2 nodess` -> `1 node` / `2 nodes` (nredd/pi-harness#702).
- Linux under WSL2 (detected from `WSL_DISTRO_NAME`, `WSL_INTEROP` or `/proc/version`): `find_roots` with no (or no matching) roots and `observe_ui`/`act_ui`/`search_ui` with no frontmost window now say that Windows host windows are not reachable from the WSL2 guest and name nredd/pi-harness#668, instead of the bare "No roots"/"No frontmost window" text. Native Linux messages are unchanged. No Windows bridge is added (nredd/pi-harness#672).
- macOS wheel scrolling (`desktop_input` and the `act_ui` wheel fallback) now scrolls right for positive `scrollX`, matching the AX scroll-bar path and `scrollY`; it scrolled left before. The wheel mapping is the pure `scrollWheelCounts`, revert-proved; it clamps deltas to the `Int32` range so an extreme `scrollX`/`scrollY` no longer traps the helper. Linux and Windows were already correct. Upstream injaneity/pi-computer-use has the same bug (nredd/pi-harness#650).
- `act_ui` validates every action before the write epoch advances, so a rejected request (e.g. `keypress` without `ref`, or `typeText`/`keypress` under strict headless on macOS) no longer stales the `stateId`, and a batch that fails this validation at a later step delivers nothing (upstream injaneity/pi-computer-use#112, nredd/pi-harness#637).
- macOS `typeText` types punctuation and letters correctly on non-US keyboard layouts and input methods: a physical US key code is used only when the active layout produces that exact character (upstream #113).
- macOS `act_ui` `scroll` moves SwiftUI/AppKit scroll areas by writing their `AXScrollBar` value instead of reporting success with no movement. The bar is written only for the target's own scroll area (or one an AX hit test resolves to), so inner wheel-scrollable regions still use the wheel (the hit test queries the target's own app, so covered windows work), and with both `scrollX` and `scrollY` an unwritten axis is carried on rather than reported as handled. A write the app accepts but has not yet applied is never doubled by the wheel and reports `unknown`; if the wheel leg for the remaining axis then fails, the act reports `unknown` with the bar evidence and the error instead of throwing, so a retry cannot scroll the written axis twice (upstream #114).
- Linux `launch_browser` starts the managed browser headless when no `DISPLAY` or `WAYLAND_DISPLAY` is set, instead of timing out waiting for CDP; `PI_COMPUTER_USE_MANAGED_BROWSER_HEADLESS=0|1` overrides, and `--no-sandbox` is added only for root (upstream #104).

### Changed

- Removed the `PI_COMPUTER_USE_DELIVERY_POLICY` / `PI_COMPUTER_USE_EVENT_DELIVERY` reader and its docs: no `act_ui` path consulted it (`helperAct` always passes its own policy), so it never changed delivery. `observe_ui` no longer resolves a numeric window id or a text query as `root`: `RootSelector` is a string and only an exact `@rN` ref was ever reachable through the schema. Direct callers that pass a non-string `root` now get the exact-`@rN` error instead of a window-id lookup (nredd/pi-harness#709, Refs #645).
- `observe_ui`, `act_ui`, `wait_for`, `navigate_browser`, `evaluate_browser` and `launch_browser` no longer put the full serialized outline in `details.outline`, so it stops landing in every Pi session file. Measured on a synthetic 2801-node tree: `observe_ui` details 1,305,024 -> 4,422 bytes per result. Desktop outlines move to `<agent dir>/cache/pi-computer-use/outlines/` keyed by `stateId` (owner-only files, newest 512 kept); session restore reads them back, still restores sessions written with the inline outline, and skips a state whose entry was evicted so its `stateId` reports the unavailable-or-evicted error (upstream injaneity/pi-computer-use#115, nredd/pi-harness#648).
- A `launch_browser` aborted while waiting its turn no longer starts a browser. Tool-path launches enter the managed-browser lifecycle before session shutdown drains readiness, without holding the readiness queue for the rest of the tool call (nredd/pi-harness#543).
- Linux: helper stdin errors reject in-flight requests and stop the failed helper instead of causing an uncaught stream exception (nredd/pi-harness#561).
- `launch_browser` gives the managed browser a private `fs.mkdtemp` profile dir (`pi-<browser>-cdp-XXXXXX`), removed when the browser exits, instead of the fixed `os.tmpdir()/pi-<browser>-cdp-<port>`. On a host with several accounts sharing `/tmp`, another account could own that name, so the launch failed waiting for CDP, or pre-seed it with a planted profile. Session shutdown now waits up to 5s for the managed browser to exit (then SIGKILLs it) and removes the profile before returning, and an `exit` hook kills the browser and removes the profile on a hard exit, so quitting Pi no longer leaves the profile and its cookies behind. Removal failures log under `NODE_DEBUG=pi-computer-use` (nredd/pi-harness#508).
- `launch_browser` now stops the previous managed browser on relaunch, and its own browser when the CDP wait fails or is aborted, the same way session shutdown does (SIGTERM, then SIGKILL after 5s) and removes the profile dir before returning, so a browser that ignores SIGTERM no longer keeps running with its profile until Pi exits. The profile dir is created only after the previous browser is stopped, and a failed `spawn` attempts to remove the new profile dir before rethrowing. Launches and session shutdown now take turns on the managed browser: a concurrent `launch_browser` stops the browser the earlier one started, and shutdown waits for a launch in flight and then stops the browser it started, so neither leaves a browser running with its profile until Pi exits (nredd/pi-harness#523).
- macOS: `scripts/build-native.mjs`, `scripts/setup-helper.mjs` and the INV-8/INV-17 `swiftc` invariants give `swiftc` a private `fs.mkdtemp` module cache, removed after use, instead of a fixed `os.tmpdir()` name. On a host with several accounts sharing `/tmp`, the first account owned the fixed dir and every other build failed with `Permission denied`. Each helper build now starts with a cold module cache (nredd/pi-harness#506).
- Tests: the `node:test` files and the non-live `check-*.mjs` assertion suites now run under Vitest from `test/` (`npm test`, through the repository launcher and home guard), with a report-only Istanbul coverage signal. Repository gates (`check-commit-messages`, `check-sync-reverts`, `check-upstream-sync`, `check-package-assets`, `check-docs*`) stay CLIs, and the `test:*` scripts keep their names. `npm test` no longer runs `typecheck`, `docs:check`, `test:linux-native` or `test:macos-live`; they still run under `npm run check` (nredd/pi-harness#347).
- Tests: `check-linux-native`, `check-macos-helper-live` and `check-windows-build-scripts` are now `test/linux-native.test.mjs`, `test/macos-helper-live.test.mjs` and `test/windows-build-scripts.test.mjs`, with the same platform and opt-in gates, and `npm test` collects them (`windows-build-scripts` stays opt-in behind `PI_CU_WINDOWS_SCRIPTS=1`, set by `test:windows-scripts`) (so `npm run check` no longer chains `test:linux-native` or `test:macos-live`). The live Linux scenario moved to `test/linux-live.test.mjs`; `check-linux-live.mjs` now only starts the D-Bus session and runs it there. `test:macos-live` drives its own helper instance on the test home's socket instead of restarting the shared daemon (nredd/pi-harness#347).
- Prepare `0.6.0` from upstream main `67e9e2f77643f84605b738a3198048a88e92190e`, retaining all desktop tools and Linux support. `observe_ui` now defaults to compact controls (`detail: "outline"` restores structure); opt-in macOS activity glow and upstream Linux/Windows fixes are included. See `UPSTREAM.md` for carried patches, checks, signing decisions, and rollback.
- Linux: the package now ships the locked `native/linux/bridge-rs` crate source for the opt-in `PI_COMPUTER_USE_ALLOW_BUILD=1` build (`cargo build --locked` into `${XDG_CACHE_HOME:-~/.cache}/pi-computer-use/linux-bridge-target`). An existing helper is probed (protocol 4, architecture invariants) and accepted without setup; a stale or broken one is replaced and re-probed. Fixes a setup failure on every Pi load (nredd/pi-harness#140).


## [0.1.7]


<!-- Preserved release notes -->

# v0.1.7 — The Stealth Frontier Update

## User-facing value proposition

People of Pi: `pi-computer-use` remains ahead of Codex computer use. v0.1.7 adds Pi-only wins:
- AX-first `scroll`, `keypress`, and `drag`
- Safari/Chrome URL entry without raw Enter
- `/computer-use` browser + stealth config
- frontier AX benchmarks

## Changelog

### AX-first execution improvements

- Collapsed more Accessibility behavior into the existing tools, so agents keep using normal actions instead of choosing between AX-specific and coordinate/vision-specific tools.
- `scroll` now tries AX scrolling by ref or hit-tested point before falling back to pointer scrolling.
- `keypress` now tries semantic AX actions before raw keyboard input:
  - Enter/Return: AX confirm or press
  - Escape/Esc: AX cancel
  - Space/Spacebar: AX press
- `keypress` can now map Enter/Escape to likely default/cancel buttons in the current window when the focused element does not expose a semantic action.
- `drag` can now adjust AX controls that expose increment/decrement actions, while preserving pointer drag fallback in default mode.
- AX target hints now include additional capabilities such as `scroll` and `adjust`.

### Browser stealth improvements

- Browser address-field workflows now have an AX-first fast path using the normal tool sequence:
  - `keypress({ keys: ["Command+L"] })`
  - `type_text({ text })`
  - `keypress({ keys: ["Enter"] })`
- For Safari and Chromium-family browsers, the pending address is opened without raw Enter fallback when possible.
- Browser address SOTA benchmark cases now pass as stealth-compatible for Safari and Google Chrome in the local validation run.

### User-visible safety config

- Added simple user/project config files:
  - `~/.pi/agent/extensions/pi-computer-use.json`
  - `.pi/computer-use.json`
- Added `browser_use` config to allow or block browser control.
- Added `stealth_mode` config to require background-safe AX execution.
- Added `/computer-use` command to show effective config and config sources.
- Added environment overrides:
  - `PI_COMPUTER_USE_BROWSER_USE=0|1`
  - `PI_COMPUTER_USE_STEALTH_MODE=0|1`
  - `PI_COMPUTER_USE_STEALTH=1`
  - `PI_COMPUTER_USE_STRICT_AX=1`

### Robustness and diagnostics

- Added stale AX-ref recovery for `click(ref)`, `set_text(ref)`, and `scroll(ref)` using refreshed role/label/capability/position matching.
- Added structured image fallback reasons in tool result details, including fallback recovery, sparse AX coverage, unlabeled targets, duplicated labels, and browser wait verification.
- Shortened post-action settle delays for AX-only operations to make stealth mode more responsive.
- Tightened browser address pending-state handling so pending address text is scoped to the originating browser pid/window.

### Benchmark and QA

- Promoted `benchmarks/qa.ts` into a SOTA/Pareto-frontier benchmark rather than only a regression smoke test.
- Added frontier capability probes for:
  - AX scroll refs
  - AX adjustable refs
  - browser address AX workflows
- Split core regression gates from frontier capability metrics:
  - `coreAxOnlyRatio`
  - `coreVisionFallbackRatio`
  - `capabilityTotal`
  - `capabilityExecuted`
  - `capabilityPassRatio`
  - `capabilityStealthRatio`
- Strict browser bootstrap refusal is now treated as an expected skip, not a benchmark failure.
- Removed the legacy manual QA script so the benchmark is the single QA authority.

### Cleanup

- Removed stale native AX helper paths that were no longer called.
- Removed legacy manual QA script and README references to manual QA snapshots.

## Validation snapshot

Default benchmark:

```json
{
  "executed": 22,
  "passed": 22,
  "failed": 0,
  "coreAxOnlyRatio": 0.85,
  "coreVisionFallbackRatio": 0.15,
  "stealthCompatibleRatio": 0.682,
  "capabilityTotal": 12,
  "capabilityExecuted": 2,
  "capabilityPassRatio": 1,
  "capabilityStealthRatio": 1
}
```

Strict/stealth benchmark:

```json
{
  "executed": 10,
  "passed": 10,
  "failed": 0,
  "axOnlyRatio": 1,
  "coreAxOnlyRatio": 1,
  "visionFallbackRatio": 0,
  "coreVisionFallbackRatio": 0,
  "stealthCompatibleRatio": 1
}
```

Notable frontier cases:

```text
Safari-sota-address-ax         PASS  variant=stealth stealthCompatible=true
Google Chrome-sota-address-ax  PASS  variant=stealth stealthCompatible=true
```

## Known benchmark fixture gaps

- AX scroll and AX adjustment are implemented, but the current local app matrix did not expose suitable scroll/adjust refs during validation.
- A future native benchmark fixture should add deterministic scrollable, adjustable, and popup/menu controls.



## [0.2.0]


<!-- Preserved release notes -->

# v0.2.0 — The Confidence Release

v0.2.0 focuses on reliability, release safety, and function-schema compatibility.

## Highlights

- Fixes the `drag` function schema error reported by function-call validators:
  - `Invalid schema for function 'drag': [{'type': 'number'}, {'type': 'number'}] is not of type 'object', 'boolean'`
- Removes tuple-style `drag.path` points from the public tool schemas so generated JSON Schema no longer emits array-form `items`.
- Adds strict TypeScript checking via `npm run typecheck`.
- Adds a schema compatibility regression check via `npm run test:schema`.
- Adds `npm test` as the combined local verification command.
- Adds GitHub Actions CI to run checks on pushes and pull requests.

## Tool schema change

`drag.path` should now be provided as object points:

```json
{
  "path": [
    { "x": 10, "y": 20 },
    { "x": 100, "y": 200 }
  ]
}
```

Tuple-style points such as `[10, 20]` are no longer advertised in the tool schema because they can produce JSON Schema that some function-call providers reject.

## Validation

Validated locally with:

```bash
npm test
```

which runs:

```bash
npm run typecheck
npm run test:schema
```



## [0.2.1]


<!-- Preserved release notes -->

# v0.2.1 — the window update

## Changelog

### App and window discovery

- Added `list_apps()` so agents can inspect running apps before choosing a target.
- Added `list_windows({ app | bundleId | pid })` so agents can inspect controllable windows, titles, ids, geometry, and focus/visibility flags.
- `list_windows` now returns model-facing window refs such as `@w1`.
- Window discovery results include enough context for the model to choose the intended target without guessing from partial titles.

### Explicit window targeting

- `screenshot` now accepts explicit window targets:
  - `screenshot({ window: "@w1" })`
  - `screenshot({ window: 12345 })`
- Action tools now accept the same optional `window` selector, for example:
  - `click({ window: "@w1", ref: "@e1" })`
  - `keypress({ window: "@w1", keys: ["Enter"] })`
- Batched actions can be scoped to a top-level `window`, and per-action window mismatches are rejected with clear guidance.
- Tool results now include `target.windowRef` where available.

### State safety and stale-target guidance

- Replaced the public `captureId` field with `stateId`.
- Action tools that depend on the latest inspected state now accept `stateId` for stale-state validation.
- Tool result details now expose `capture.stateId` instead of `capture.captureId`.
- Stale state errors now point the model toward refreshing the correct window, e.g. `screenshot({ window: "@w1" })`.
- Stale AX-ref errors now explain that refs are scoped to the latest state and should be refreshed with `screenshot`.

### Window layout and visual control

- Added `arrange_window` for deterministic layouts before interaction.
- `arrange_window` supports presets:
  - `center_large`
  - `left_half`
  - `right_half`
  - `top_half`
  - `bottom_half`
- `arrange_window` also supports explicit frames with `x`, `y`, `width`, and `height` in screen points.
- Added native helper support for setting a target window frame through Accessibility.
- Added screenshot attachment control through `image: "auto" | "always" | "never"`.

### Multi-agent and multi-window safety groundwork

- Added per-window write queues so writes targeting the same window are serialized internally.
- This reduces the chance of conflicting writes when multiple flows target the same `@w` ref.
- Current Pi execution still keeps a global runtime lock around helper readiness/shared state, so this is groundwork rather than full parallel multi-window execution.

### Scroll diagnostics and recovery

- Scroll failures now preserve the best available AX failure reason.
- Strict AX scroll failures include the AX reason when one is available.
- Coordinate fallback errors now provide clearer recovery guidance when an AX scroll path is unavailable.

### Docs, benchmark, and cleanup

- Updated README, usage docs, troubleshooting docs, and the computer-use skill for the new discovery/window/state workflow.
- Updated the benchmark harness to use `stateId` instead of the removed `captureId` field.
- Removed stale public `captureId` schemas and examples.
- Bumped package version to `0.2.1`.

## Validation snapshot

Default benchmark:

```json
{
  "executed": 9,
  "passed": 9,
  "failed": 0,
  "coreAxOnlyRatio": 1,
  "coreVisionFallbackRatio": 0,
  "axExecutionRatio": 1,
  "stealthCompatibleRatio": 1,
  "avgLatencyMs": 442,
  "avgNavigationLatencyMs": 519,
  "avgTargetingLatencyMs": 288,
  "batchPassRatio": 1
}
```

Configured benchmark gates passed:

```text
coreAxOnlyRatio       1 >= 0.8
avgLatencyMs          442ms <= 7500ms
avgTargetingLatencyMs 288ms <= 4000ms
```

Notable cases:

```text
Finder-targeting            PASS  variant=stealth stealthCompatible=true
Reminders-targeting         PASS  variant=stealth stealthCompatible=true
Helium-targeting            PASS  variant=stealth stealthCompatible=true
Helium-sota-address-ax      PASS  variant=stealth stealthCompatible=true
```

## Known follow-ups

- Per-window write queues are in place, but Pi tool execution still uses a global runtime lock around helper readiness and shared state. A future release can split read-only discovery/screenshot paths from write paths to unlock more true parallel multi-window execution.
- `image` mode is currently stored in runtime state during a tool call. This is safe with current sequential execution, but should become strictly per-call state before relaxing the global runtime lock.
- AX scroll and AX adjustment are implemented, but the current local benchmark app matrix did not expose suitable scroll/adjust refs during validation.



## [0.2.2]


<!-- Preserved release notes -->

Direct browser navigation and more reliable browser/window automation.

## Features

- Added `navigate_browser` to open a URL or search string directly in a targeted browser window.

## Changelog

- Added `navigate_browser` tool registration, docs, skill guidance, and bridge execution in `0e0111d`.
- Fixed browser window targeting by using native window refs across AX, mouse, scroll, drag, arrange, and capture paths in `0e0111d`.
- Fixed browser navigation stability with direct AppleScript-backed location opening in `0e0111d`.
- Fixed browser Apple Events JavaScript failures by surfacing a model-readable “Allow JavaScript from Apple Events” hint in `c53ba0b`.
- Fixed README Pi install/remove tag syntax from `#v0.2.1` to `@v0.2.1` in `41df92d`.
- Chore release notes by removing the old v0.2.1 proposition section in `485ac98`.

> “Don’t Panic.”



## [0.2.3]


<!-- Preserved release notes -->

Stronger AX-only semantic targeting and smoother macOS setup recovery.

## Features

- Added richer AX extraction diagnostics for inspecting semantic target coverage against the underlying AX tree.
- Added SSH-aware setup handling to guide remote sessions toward the GUI helper path when macOS permissions cannot apply to SSH-spawned helpers.

## Resolved issues

- Resolved [#10](https://github.com/injaneity/pi-computer-use/issues/10), where SSH-launched helpers could not satisfy macOS Accessibility/Screen Recording checks despite manual grants, by detecting SSH sessions and routing setup through the GUI helper path.
- Resolved [#9](https://github.com/injaneity/pi-computer-use/issues/9) with clearer setup and recovery guidance for Screen Recording and Accessibility permission grants.

## Changelog

- Added model benchmark matrix artifacts and reporting in `273aedf`.
- Added improved permission-granting setup UX in `dae7a24`.
- Added SSH connection detection that launches the GUI helper instead of relying on the SSH helper in `17c1eb7`.
- Fixed sparse AX target fallback so strong semantic text targets can remain image-free in `e38e6c8`.
- Fixed Firefox and other browser address-bar targeting by treating `AXComboBox` as a browser text field in `e38e6c8`.
- Refactored native AX target diagnostics, scoring, and text-input classification in `e38e6c8`.
- Chore improved setup onboarding copy in `5c01578`.

> “Time is an illusion. Lunchtime doubly so.”



## [0.2.4]


<!-- Preserved release notes -->

Pi namespace migration release.

## Changelog

- Bumped `pi-computer-use` to `0.2.4`.
- Updated Pi SDK peer dependencies and imports from `@mariozechner/*` to `@earendil-works/*`.
- Updated README install examples and Pi package links for the new release.

> “Mostly harmless.”



## [0.2.5]


<!-- Preserved release notes -->

macOS 12 compatibility release for the native helper.

## Changelog

- Added separate native helper variants: a macOS 14+ modern helper with ScreenCaptureKit and a macOS 12+ legacy helper using CGWindow/screencapture capture paths.
- Updated helper setup to select the appropriate helper variant automatically by macOS version, with `PI_COMPUTER_USE_HELPER_VARIANT=modern|legacy|auto` for troubleshooting.
- Rebuilt and packaged variant-specific arm64 and x64 helper prebuilts.
- Removed the bundled `computer-use` skill so model behavior is driven by tool descriptions, schemas, and helper feedback rather than packaged skill instructions.
- Updated helper build and development docs for variant builds.

> “The knack lies in learning how to throw yourself at the ground and miss.”



## [0.3.0]


<!-- Preserved release notes -->

Optional CDP acceleration and codebase cleanup release.

## Features

- Optional Chrome DevTools Protocol backend for Chromium-family browsers: set `PI_COMPUTER_USE_CDP_PORT` to a browser's `--remote-debugging-port` to get event-driven `navigate_browser` and browser console output piggybacked on tool results, with no change to the tool surface.

## Changelog

- Added the opt-in CDP backend with window-aware tab matching and console/exception capture.
- Hardened native bridge safeguards and tightened CDP and input guard cleanup.
- Removed the orphaned isolated-browser-window bootstrap path and dead activation plumbing from the bridge, and collapsed duplicated tool executor layers (~500 lines removed with no behavior change).
- Fixed the published package image path, which still pointed at `assets/img.jpg` after the file moved to `assets/reference/`.
- Untracked a committed local session transcript and cleaned up stale `.gitignore` entries.
- Aligned docs and tool prompt guidelines with the removed browser bootstrap behavior.

> "He felt that his whole life was some kind of dream and he sometimes wondered whose it was and whether they were enjoying it."



## [0.3.2]


<!-- Preserved release notes -->

Context-aware browser and desktop control release with leaner snapshots and stronger recovery tools.

## Features

- Context-first browser/desktop snapshots with explicit `browser_page` and `desktop_window` contexts, managed CDP browser launch, browser JavaScript evaluation, and browser-backed click/set_text/scroll/navigation.
- Source-classified macOS AX targets distinguish desktop AX, browser chrome AX, and web-content AX so chrome-only browser trees trigger recovery instead of looking like useful document content.
- Scoped desktop AX snapshots, paginated `read_text`, `wait_for`, action `responseMode: "confirmation"`, and reduced fallback screenshots improve token efficiency and recovery loops.

## Changelog

- added context discovery, CDP snapshots/actions, and managed browser contexts in `0811299`.
- added browser/web-content AX source classification and browser-chrome-only diagnostics in `9d4b54d`.
- added scoped AX tree snapshots and stronger model guidance for focused inspection in `0811299`.
- added paginated/cached text extraction for desktop AX and browser contexts in `b446664`.
- added compact AX text previews to prevent long target values from bloating tool results in `c8fa6f3`.
- added `wait_for` for desktop AX and browser-context condition polling in `97a764f`.
- added reduced automatic screenshot payloads with preserved coordinate scaling in `1435dd9`.
- fixed ScreenCaptureKit helper builds so the deprecated `CGWindowListCreateImage` fallback is not compiled into the modern helper in `644b473`.
- chore updated CI audit to omit auto-installed peer dependencies so release checks focus on this package's production dependency surface in `11b1f50`.

> "Time is an illusion. Lunchtime doubly so."



## [0.4.0]


<!-- Preserved release notes -->

Stable helper permissions and rebuilt observe/act architecture release.

## Features

- Reworked the computer-use flow around atomic `observe` snapshots, searchable folded outlines, scoped inspection, and helper-owned `act` transactions.
- Moved macOS permission attribution to the canonical `/Applications/pi-computer-use.app` helper identity so Accessibility and Screen Recording grants attach to the right app.
- Improved input delivery, grounding, helper-side preflight, execution feedback, and permission recovery guidance.
- Added signed helper release packaging so installs can preserve macOS TCC grants across helper updates.

## Changelog

- added the rewritten computer-use look and act architecture in `c3b1da6`.
- refactored helper app permissioning around the canonical signed app identity in `ed1098e`.
- added improved input delivery and grounding in `d4f4fac`.
- consolidated architecture documentation in `c44a6a6`.
- simplified the computer-use introduction in `d45aabf`.
- hardened CI checks and split the npm audit workflow in `25d85ff`.
- added release staging for the signed helper before npm publication in `f1b22be`.
- moved release publishing through npm trusted publishing in `d6ebbf0`.
- chore prepared the v0.4.0 release in `606a621`.

> "Don't Panic."



## [0.4.1]


<!-- Preserved release notes -->

Root-forest desktop control architecture release.

## Features

- Reworked the public desktop flow around root refs, atomic observe snapshots, searchable folded outlines, scoped inspection, and typed helper-owned act transactions.
- Added root delta reporting and adaptive settling so helpers can report appeared, closed, and focused roots without extra bridge-side sleeps.
- Hardened macOS root handling for sheets, dialogs, menus, focused windows, transient root identity, and snapshot-authoritative delta settling.
- Preserved stable macOS helper permissions across rebuilds and releases by avoiding unnecessary helper app replacement.

## Changelog

- fixed release workflow commit validation, changelog generation, and dependency metadata in `9b4e2ee` and `ee81b3d`.
- split the platform backend seam and made observe/act result contracts explicit in `6d4d393`, `f42d47b`, `b497ab8`, `4e342fd`, and `fd76ef4`.
- added the cubench Pi client for behavioral benchmarking in `42a9cb9`.
- moved macOS permission handling behind the platform seam and restored permission constraints in `5ae0945` and `26376f3`.
- removed the ignored `set_text` method parameter in `03822a7`.
- refactored the desktop targeting model from windows to roots in `b1ae46e`.
- completed the root-forest platform seam and macOS helper behavior in `deb29fc`.
- preserved helper TCC grants when the signing identity is unchanged in `2c42013`.
- fixed macOS transient root identity and sheet discovery in `212b74c` and `4c8da3a`.
- added AXObserver-driven root deltas with snapshot fallback in `f179eea`.
- optimized settle behavior when helpers report their own delta source in `d3ae90f`.
- fixed macOS root deltas to use snapshot-authoritative CG-poll early exit in `022a280`.
- chore prepared the v0.4.1 release.

> "The ships hung in the sky in much the same way that bricks don't."



## [0.4.2]


<!-- Preserved release notes -->

Windows root-forest bridge and release-pipeline support.

## Features

- Added first-class Windows support: a Rust UIA bridge, TypeScript Windows backend/helper integration, root-forest observation, screenshot capture, UIA grounding, act dispatch, and scoped root deltas.
- Added Windows native build and install flow, including `build-native.mjs --platform windows`, postinstall prebuilt installation, optional source-build fallback, and release-pipeline injection of `prebuilt/windows/windows-bridge.exe`.
- Kept the platform seam neutral while aligning macOS and Windows around `find_roots`, `observe_ui`, and `act_ui` root-forest contracts.
- Expanded Windows documentation, troubleshooting, development notes, and README coverage.

## Changelog

- refactored platform contracts and call sites for a platform-neutral root-forest seam across `src/platform/*`, `src/bridge.ts`, `src/contract.ts`, and `extensions/computer-use.ts` in `ec6395c`.
- fixed CI invariants for the simplified seam and bounded macOS semantic-tree walking in `ebfc888` and `4cf8b41`.
- renamed public tools from `find`, `observe`, and `act` to `find_roots`, `observe_ui`, and `act_ui` across extension schemas, docs, and bridge code in `41b6f5b`.
- added the Windows Rust bridge crate, protocol/state/ref tests, UIA traversal, capture, input dispatch, and window helpers under `native/windows/bridge-rs` in `8f429f3`, `c903522`, and `c04bb4f`.
- wired Windows backend selection, helper spawning, setup/install behavior, build scripts, and static platform checks in `96664eb`, `0c9ec73`, `84743d5`, and `2f3f47b`.
- fixed Windows UIA occlusion, ancestor comparison, delta scoping, ref lookup performance, seam annotations, and grounding metadata in `d8d7b41`, `174ad69`, and `495b4be`.
- documented Windows root-forest acceptance, live UIA acceptance, configuration, troubleshooting, and README support in `b34f987`, `8e8ed9b`, and `3984f04`.
- updated release validation and packaging so docs/perf commits are accepted, Rust build artifacts stay out of npm, and the release pipeline publishes `windows-bridge.exe` alongside macOS helper assets in `c563352`, `8877f00`, and `2f3f47b`.

> "Don't Panic."



## [0.4.3]


<!-- Preserved release notes -->

Simpler diff-first computer use with parallel tasks, a ghost cursor, and more reliable batched actions.

## Features

- Added a configurable native ghost cursor so agents can show pointer movement without taking over the user's physical cursor.
- Added diff-first resulting views with stable references, explicit full-view fallbacks, and immutable resource-keyed state.
- Added parallel native transports and resource-keyed scheduling so independent roots can progress concurrently.
- Consolidated action preparation, execution, verification, and batching behind one agent-facing contract.

## Changelog

- added the macOS ghost cursor overlay with headless-safe configuration and native cursor ownership.
- refactored observation state into focused action, state, and view modules while removing superseded compatibility paths.
- added diff-first resulting views and authoritative post-action reconciliation for exact text entry.
- improved web and coordinate action reliability by foregrounding only when pointer focus is required.
- aligned strict headless behavior across macOS and Windows with accessibility-only initial actions.
- added runtime, architecture-invariant, platform, packaging, and Cubench regression coverage.

> "Time is an illusion. Lunchtime doubly so."



## [0.5.0]


<!-- Preserved release notes -->

Linux computer use, safer native actions, and tighter state and output boundaries.

## Features

- Added Linux desktop support through AT-SPI2, with X11 window discovery, capture, focus, and guarded XTEST input.
- Added native Linux x64 and arm64 helpers to npm and GitHub release artifacts.
- Added Linux-aware managed browser discovery with explicit Chrome and Helium executable overrides.
- Added pull-request CI for Linux x64 tests, linting, formatting, and builds, plus native arm64 builds.

## Changelog

- added background-first semantic Linux observation, action, text reading, waiting, and progressive disclosure.
- added X11 window correlation, background capture, coordinate grounding, and foreground-only physical input fallback.
- documented the semantic-only native Wayland boundary and read-only portal capability diagnostics.
- improved post-action handling when an action closes its source root before a successor observation can be captured.
- hardened root identity resolution, bounded tool output, JSON-safe wait details, serialized native boundaries, and macOS helper installation.
- tightened the macOS ghost cursor lifecycle so it remains background-only and does not linger while idle.
- updated build dependencies and GitHub Actions while removing unused bridge symbols.

> "The future is already here — it's just not evenly distributed."



## [0.5.1]


<!-- Preserved release notes -->

Windows helper packaging verification and release reliability.

## Features

- Added npm package verification for macOS, Windows, and Linux native helpers before publication.

## Changelog

- prevented releases from publishing when the Windows helper is absent from the npm tarball.
- updated the development lockfile for the latest Pi dependency version.

> "A release should verify the files it ships."
