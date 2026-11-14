# pi-computer-use

`@nredd/pi-computer-use` lets Pi agents observe and control desktop apps and CDP browser pages.
This workspace is a fork of `injaneity/pi-computer-use`; see [Upstream](#upstream).

## Install

```bash
pi install npm:@nredd/pi-computer-use
```

macOS 14+ ships per-architecture helpers. Setup installs at `~/Applications/pi-computer-use.app`
(or preserves an existing writable `/Applications/pi-computer-use.app`) and signs locally with the
existing stable keychain identity. Grant Accessibility and Screen Recording to that app. We do not
switch to upstream's CI self-signed bundle: changing signer would require a TCC re-grant.

Linux ships its locked Rust crate source, not a binary. Run inside the graphical user's AT-SPI2
session. Source builds are opt-in with `PI_COMPUTER_USE_ALLOW_BUILD=1`, use the user's cache rather
than the npm install directory, and need Cargo plus a C linker. See the
[Linux guide](./docs/content/docs/how-to-guides/linux.mdx). Windows source remains in the repository;
Windows helpers and crate sources are not packed. If the Linux helper's input stream fails, in-flight
requests are rejected and the helper is stopped; a later request starts a fresh helper.
Windows helper commands reject with `Operation aborted.` when their signal aborts after sending,
without waiting for the command deadline. Cancellation clears the local pending request, timer and
listener; late replies are ignored. It does not stop native work already sent or kill the helper.
Deterministic client tests use scripted stdio helpers, not Windows UI or native coverage.

## Tools

State-consuming desktop tools require an observation; missing or blank `stateId` fails with
`No observation state is available. Call observe_ui first.` The obsolete internal missing-window
guard is removed without changing this boundary (#755).

All platforms retain `find_roots`, `observe_ui`, `search_ui`, `expand_ui`, `inspect_ui`, `act_ui`,
`read_text`, `wait_for`, `launch_browser`, `navigate_browser`, and `evaluate_browser`.
macOS additionally registers `desktop_screenshot` and `desktop_input` (including app activation and
plain-text clipboard access). Desktop tools require `desktop_control: true` and `headless: false`.
Password managers, Keychain Access, terminals and system authentication agents are blocked by default (`app_blocked`, config `blocked_apps`), and the macOS helper refuses UI commands while the session is locked (`screen_locked`); see the [configuration reference](./docs/content/docs/reference/configuration.mdx).
They share a scoped physical-input lock with `act_ui`; background semantic work stays independent.

The normal loop is find a root, observe it, then query or act from the returned immutable `stateId`.
`observe_ui` now defaults to compact controls; `detail: "outline"` returns the structural view.
Upstream's opt-in `activity_glow` is retained and defaults to false.

On CDP browser states, `act_ui` `moveMouse` requires explicit `x`/`y` coordinates; a `ref`
target fails with `invalid_args` rather than sending absent coordinates. Browser `keypress` requires
a non-empty `keys` array (`invalid_args`). Both checks run before any batch step is delivered or
the observation epoch advances. Desktop ref movement is unchanged.

## Documentation

- [Getting started](./docs/content/docs/tutorials/getting-started.mdx)
- [Architecture](./docs/content/docs/explanation/architecture.mdx)
- [Configuration](./docs/content/docs/reference/configuration.mdx)
- [Agent contract](./docs/content/docs/reference/agent/contract.mdx)
- [Tool reference](./docs/content/docs/reference/agent/tools.mdx)
- [Troubleshooting](./docs/content/docs/how-to-guides/troubleshooting.mdx)
- [macOS targeting and carried behavior](#macos-root-targeting)
- [Development](https://github.com/nredd/pi-harness/blob/main/packages/computer-use/docs/content/docs/how-to-guides/develop-and-validate.mdx)
- [Contributing](https://github.com/nredd/pi-harness/blob/main/packages/computer-use/CONTRIBUTING.md)

The upstream documentation site source is retained in `docs/`; it is not a root npm workspace and
its build dependencies are not installed by the harness. `npm run docs:generate` refreshes the
source-bound references, and `npm run docs:check` validates them without building the site.

## Checks and release

`npm run check` runs the owned deterministic package checks. Vitest reports native and live suites off
their platform or opt-in as skipped; this package remains outside the coverage gate. Never run
`test:macos-live` on an occupied desktop: it manipulates fixture windows, apps, and the clipboard. It
starts, restarts and stops its own helper instance on the test home's socket, never the shared daemon.
`npm run test:macos-live` and the TCC-granted smoke are owner-only and NOT RUN in CI.

`npm run coverage:rust` needs Rust `1.97.1` with `llvm-tools-preview` and `cargo-llvm-cov` `0.9.1`, with
that rustup toolchain first on `PATH` (never a Homebrew `rustc` sysroot):

```sh
rustup toolchain install 1.97.1 --profile minimal --component llvm-tools-preview
cargo +1.97.1 install cargo-llvm-cov --version 0.9.1 --locked
export PATH="$(dirname "$(rustup which --toolchain 1.97.1 cargo)"):$PATH"
```

`npm run coverage:swift` runs real-source headless motion and native assertions with one Swift
compiler worker. It covers analytic geometry, clock/lifecycle checks and the clamp mutation control.
This does not run the live overlay suite or prove physical pointer behavior.

`npm run coverage:swift` links all shipped Swift sources with the headless assertions.
`native/macos/ref_look_tests.swift` checks real `AXRefStore` ownership and snapshots plus
`LookNode.payload()` keys, flags, rectangles and recursive child order. It only constructs
self-process/managed-child AX handles and synthetic nodes, never queries AX attributes.
The child is reaped before assertions; a source-level guard forbids AX queries/actions.
The sync-revert controls mutate window equality, destination ownership, optional flags and child order. Unexecuted live code
stays in the denominator; this slice does not claim whole-file coverage or change runtime behavior.
`node scripts/check-sync-reverts.mjs --validate-only` checks the real revert-case inventory
against the ledger without running mutations; the normal command still runs every applicable
mutation.

`npm run test:linux` uses disposable protocol children, not a native desktop helper. Its closed-stdin
fixture initializes stdout before closing fd `0` (lazy pipe initialization aborts Node 26.12 on Darwin),
acknowledges verified closure while alive, and requires real `EPIPE` rejection plus child cleanup.
The next request carries a 64 KiB payload so Bun also reaches an OS write failure instead of accepting
a small write into its buffer. A successful write callback is not proof of delivery; runtime command
deadlines and error propagation are unchanged. Build-script tests assert the active runtime's executable,
use numeric exit-code sentinels on Node/Bun, and require actual invalid CLI/symlink entries to exit `1`.

The harness root `publish.yml` owns releases; nested upstream workflows are dormant reference source.
Local helper builds and local signing remain unchanged. Source preparation is not activation.

Linux source-build cleanup gives its detached compiler group a bounded TERM/KILL budget. A successful
KILL syscall alone is not treated as success: setup fails if the group cannot be confirmed empty, and
keeps a fresh-probe-guarded exit-time KILL backstop while ownership remains signalable. Only ESRCH
proves quiescence; permission or unexpected syscall errors surface uncertainty and revoke signalling.

## Upstream

- Fork of `injaneity/pi-computer-use`. The pinned base commit is `upstream` in `sync-patches.json`
- `sync-patches.json` is the whole ledger: every carried patch has a purpose, files, a check, executable drop controls and an upstream disposition. `files` is the exact set that differs from the base
- `npm run test:sync-reverts` reverts each patch in a scratch copy and requires its check to fail. `PI_CU_UPSTREAM_SYNC=1 npm run test:upstream-sync -- --fetch` (CI, Linux) fails on undeclared drift from the base
- We do not track upstream continuously. To re-sync, apply `git diff <old-base> <new-base>` (minus `package-lock.json` and `prebuilt/`) with `git apply --3way --directory=packages/computer-use`, resolve against the ledger, update `upstream` and `files`, then run `npm run docs:generate`, `npm run check` and `make check-computer-use-package-contract`
- Keep the local bundle path and signing identity across a sync: changing either forces TCC re-grants

## Signing certificate setup

From this package directory, `./scripts/make-signing-cert.sh [output-dir]` still creates
`key.pem`, `cert.pem` and `id.p12` (default `./signing`) for the upstream self-signed release
workflow. Keep those files permanently; this does not guarantee persistent TCC grants.
The existing Node minimum, Bash and OpenSSL requirements are unchanged. The harness release
workflow does not invoke this command or import a signing identity.

`scripts/make-signing-cert.mjs` owns directory/config creation, OpenSSL arguments, failure
propagation and successful cleanup. Tests inject every external command and use disposable
files, never a real identity, Keychain, trust operation or credential prompt. Istanbul measures
only that Node code with L/F/B/S zero thresholds. The three-line shell compatibility launcher
and Bash `read -r -s` password fragment are explicitly **unmeasured shell**, not covered Node
logic. The latter preserves Bash's terminal editing, whitespace, EOF and interrupt semantics
without a new password-input dependency. Remaining shell work belongs to #695.

## macOS root targeting

Carried behavior notes for `@nredd/pi-computer-use`. Root targeting is now based on upstream PR #95; `sync-patches.json` records the current base and remaining patches.

### Target contract

- A root target is `{ pid, windowId?, rootRef?, windowRef? }`. `windowId` is present only when
  positive. An unpaired root (no matching CG window) has no `windowId`, never `0`.
- `rootRef` and `windowRef` are the same native ref. Every macOS helper call (`look`,
  `focusWindow`, `axWaitFor`) goes through `normalizeTarget()` in `src/platform/macos/backend.ts`,
  which sends only `windowRef`.
- The helper treats `windowId <= 0` as absent. A request with a `windowRef` and no usable `windowId` that no longer resolves fails; it
  never falls back to the app's first window. With a positive `windowId` it still pairs by id.
- Looks remember their `windowRef`, so `act` resolves the root by ref for unpaired roots.

### Capture

- Paired root: semantic and visual observation work.
- Unpaired root: semantic works. Visual `observe_ui` fails with `root_not_capturable`; use `mode: semantic`. The `act_ui` successor capture downgrades to semantic automatically.
  No other window is ever captured in its place.

### Modality

`isModal` is true for: a sheet child, role `AXSheet`, or `AXModal == true`. When the app does not
report `AXModal` at all, a dialog-like role/subrole still counts. An explicit `AXModal == false`
wins: Fusion's BROWSER sidebar (subrole `AXDialog`, `AXModal=0`) is nonmodal.

`act_ui` acts on, and captures the successor of, the root its state belongs to; it does not retarget to
a foreground modal. If a confirmed modal is in front afterwards, the result ends with a `Note:` line
naming it. Other tools (`observe_ui` without a root, `wait_for`, `read_text`) may still prefer a
confirmed foreground modal, so they can disagree with `act_ui` about which root is current.

### Post-action outcomes

Terminal `act_ui` results always say the action was delivered, and:

- `target_closed`, `cause: replaced`, `successors: [...]`: source root gone and new window, dialog or sheet
  roots of the same pid appeared and are still live (menus and popovers do not count). Observe a successor via `find_roots`.
- `target_closed`, `cause: closed`: source root gone, nothing replaced it.
- `post_action_observation_failed` with code `root_stale`: the root is still listed but the helper answers
  `root_not_found` for its ref (matched on the error code, not the message). A failed probe stays generic. Rediscover with `find_roots`.

### Ref lifecycle

Measured, not assumed:
- The helper stores native refs (`w<epoch>-<n>` roots, `e<epoch>-<n>` elements) without TTL or idle exit.
  Look records are capped at 8; element refs are evicted with their owning look, as described below.
  Window refs persist until their AX element dies or the helper restarts. The daemon does not exit when idle.
- Refs carry a per-process epoch, so a ref from before a helper restart never resolves; it used to be possible
  for `w3` from an old helper to name a different window in a new one.
- Helper restarts happen on reinstall, protocol/binary mismatch, permission relaunch. The extension's `@rN`
  records survive them, so `@rN` can outlive its native ref: expect `root_not_found` / "stale", then rediscover
  with `find_roots`. Refs from earlier sessions, pids and state ids are stale.
- Root deltas in `act_ui` results carry helper-native refs until `normalizeRootDeltaRefs()` maps them, once per
  transaction, to the extension's `@rN` for the same root (registered from `listRoots`, keyed by `windowId`, the
  same identity `find_roots` uses). An earlier mapper registered a placeholder record under a different identity, so
  a dialog got `@r2` in the action result and `@r3` from `find_roots`; `test/unpaired-act.test.mjs` guards this and fails
  on the old code. Verified live on Bambu's Open panel (delta `@r2` == `find_roots` `@r2`). A delta whose root is
  gone (`closed`) reuses the existing record, or shows no ref.
- Element refs live as long as their look: the helper keeps 8 look records and drops a look's element refs when it
  ages out (or when the look fails before being recorded). Unowned element refs (one-off element queries) sit in a
  FIFO capped at 1024. Window refs are deduped per window and not evicted (bounded by the number of windows).
  An incremental look (`expand_ui` graft, `baseLookId`) inherits its base look's refs, since the grafted outline
  still uses them. Acting with a current look on a ref whose look aged out fails with `stale_ref`; acting with an
  aged-out look id fails with `stale_look`. Both live-checked in `test/macos-helper-live.test.mjs`, which also fails
  when the base-look transfer is disabled (checked).

### Helper lifecycle

The helper daemon outlives pi, so a reinstall alone leaves old code running. Two guards:
- `scripts/setup-helper.mjs` stops the running helper (`pkill -f '<bridge> serve'`) whenever it replaces the bundle
- `ensureProtocol()` restarts a daemon whose process started before the installed binary was written (`helperPredatesBinary`)

### Whole-desktop control

Both tools exist on macOS only, serialize behind one lock, and refuse when `headless` is true or
`desktop_control` is false (`PI_COMPUTER_USE_DESKTOP_CONTROL=0`). They are on by default.

`desktop_screenshot` captures a full display (cursor included, `display` 0 is main) and states the
image-to-point mapping. `desktop_input` posts physical HID input in global points: `moveMouse`,
`click`, `scroll`, `drag`, `typeText`, `keypress`. It moves the real cursor and types into whatever has
focus, so verify with a screenshot. Input goes to the *frontmost app*: raising a window
inside a background app is not enough (`focusWindow` can report `focused` while another app is frontmost),
so call `activateApp` first.

Non-pointer actions on the same tool:
- `activateApp { app }`: bundle id, then display name, then executable name (`ambiguous_app` when two running apps
  share the winning name; paths are rejected). Launches the app when not running and fails with
  `activation_failed` unless it is frontmost within 5s; `app_not_found` when neither running nor installed. It runs
  `/usr/bin/open <bundle>` as a killable subprocess: AX `AXFrontmost` and `NSRunningApplication.activate` were
  refused from the background helper live (macOS 14+ cooperative activation), and an in-process
  `NSWorkspace.openApplication` hung in `_sandbox_extension_issue` and wedged the daemon. Unbundled executables
  get AX + `activate()` only.
- `readClipboard`: plain text only, capped at 100k characters (`truncated`); non-text gives `clipboard_empty`. The
  result is fenced in `<clipboard>` and labelled as data, since it can hold anything (including secrets) and is
  gated only by `desktop_control`.
- `writeClipboard { text }`: replaces the clipboard with plain text.

`scroll` follows macOS natural scrolling: `scrollY: -5` arrives as a positive delta. Prefer `act_ui` for controls reachable by ref. Helper commands:
`captureDisplay`, `desktopInput` (wire actions `type`/`key`). Needs Screen Recording and Accessibility.

### Tests

`npm run test:macos-target`, `test:macos-native` (compiles the `PURE` region of `bridge.swift`),
`test:act-outcomes`, `test:desktop`, `test:unpaired` (stubbed backend: unpaired successor, delta refs, lock
scope). `PI_COMPUTER_USE_LIVE=1 npm run test:macos-live` drives the real helper against an `NSAlert` fixture
(`windowElement`, `look`, `act`, `axWaitFor`, `desktopInput` parsing, `activateApp`, clipboard round trip with
restore, ref epoch across a restart, look-scoped ref eviction). It restarts only its own helper instance, launched
from the installed bundle on the isolated test home's socket.

### Real GUI validation

Run 2026-10-07 against existing Fusion (pid 32012) and Bambu Studio (pid 65354), fork `v0.5.1-nredd.1`
(`2c3dd8b`). Gotcha: the helper process started before the rebuilt binary was installed kept running
the old code; the sidebar still showed `modal` until the helper was killed and respawned.

Worked:
- Fusion BROWSER sidebar (`AXDialog`, `AXModal=0`, pairing low/10): `modal` on 0.5.1, nonmodal on the fork.
  Semantic observe of it works.
- `act_ui` press on the main window while the sidebar was up: delivered to the main window and the
  returned state was the main window (`@r2`), not the sidebar. Used the already selected Py radio, no
  design change.
- Bambu Cmd+O raised an "unsaved changes" prompt (`dialog`, modal, exact pairing). Escape cancelled it.
  `act_ui` reported the source root closed with no successor (`cause: closed`) and no fabricated state.
- Stale and bogus refs (`@r16` after the dialog closed, `@r99`) fail with a clear "stale" / "not available
  in this session, call find_roots" error.

Observed, not fixed:
- observe on a root ref can return a different `@r` (`@r16` -> `@r17`). Root cause found later: action results
  printed helper-native refs; fixed by `normalizeRootDeltaRefs()` (see Ref lifecycle).

Not validated:
- An unpaired dialog (no `windowId`): none was available, every dialog seen paired. The `windowRef`
  forwarding and `root_not_capturable` paths are covered by unit tests only.
- `root_stale` and `cause: replaced` on a live app; ref expiry after long gaps (no TTL measured).
- Fusion batch (Py via SPACE, click console, type, RETURN) was not re-run.
- Bambu Cmd+I/Cmd+N dialogs.

#### Whole-desktop tools (live, 2026-10-07, two displays, unreleased build)

Worked:
- `captureDisplay` on both displays (main 2560x1080 at 0,0; second 1920x1080 at 341,-1080, i.e. negative y); bad display index -> `display_not_found`
- `desktopInput` `moveMouse` lands exactly, including negative y on the second display; the returned `mouse` is read back in the same top-left global space
- In a scratch TextEdit document: click, unicode typing, `return`, `cmd+a`, `delete`, triple-click, drag-select (selected text confirmed via AX), scroll
- Invalid actions and arguments fail with `invalid_args`

Bugs found by the live run and fixed:
- Returned `mouse` came from `NSEvent.mouseLocation` (bottom-left origin) and was read before the move settled; now `CGEvent(source: nil).location` after a short settle
- Drags posted one event per waypoint; they now interpolate (<=12pt steps) with click state set



#### Later live results (2026-10-07, final helper)

- Second display (global origin 341,-1080), via a probe window that logs the events it receives (`scripts/fixtures/event-probe.swift`): left,
  right and middle clicks, double click, unicode typing, `cmd+k` (command flag set) and scroll all arrive at the exact global
  coordinates sent, including negative y.
- Multi-waypoint drag selects text in TextEdit; a rejected drag leaves no button held.
- Real modal `NSAlert` (`scripts/fixtures/alert-app.swift`): ref-only observe works, visual gives `root_not_capturable`,
  `act` press by ref dismisses it; the `act_ui` dismissal reports `target_closed`. Opt-in script: `PI_COMPUTER_USE_LIVE=1 npm run test:macos-live`.
  It fails when `windowElement` is mutated to always fall back to the first window (checked).
- Fusion with the sidebar up: Py radio via SPACE, then click console field + `print(1)` + RETURN in one batch; the console shows `1`.
- Bambu Cmd+I: `act_ui` reports `New root: dialog "Open" (modal)` and a `Note:` that a foreground modal is in front. Background-delivered Escape
  returned outcome `unknown` and did not dismiss the panel; physical Escape via `desktop_input` did, once Bambu was frontmost.
- `activateApp` TextEdit, cmd+n, `writeClipboard`, cmd+v: the scratch doc's AX value is the clipboard text (incl. `é`);
  closed without saving, clipboard restored. Driven by the helper only, no AppleScript (`osascript` from a terminal
  triggers an Automation prompt per target app).
- `activateApp` launched Calculator (not running) and switched Finder <-> TextEdit; unknown names -> `app_not_found`.
- `desktop_input` moves running concurrently with a background `act_ui` click on Fusion: both completed, no errors.
- No natural unpaired dialog was found (the alert and Open panel pair with `low`/`exact`). The unpaired path is covered by the ref-only live
  runs above and by `test/unpaired-act.test.mjs` (stubbed backend).

Notes: desktop tools and `act_ui` share one lock. An `act_ui` transaction takes it lazily at its first foreground
(physical HID) step (the `needsForeground`/current-focus case, the side-effect-free foreground retry, the
`foreground_required` fallback) and keeps it until the transaction ends, so a later step relying on focus set by an
earlier one is never interleaved with `desktop_input`. Transactions that stay background/pid/AX never take it. Lock order is window write lock, then
desktop lock; the desktop tools take only the desktop lock. A queued call that is aborted never runs. A restart is triggered when the
helper process started before the installed binary's `ctime`, so anything that touches the binary's metadata
costs one helper restart (and invalidates native refs) at the next session start.

## License

MIT, retaining upstream's copyright in `LICENSE`.
