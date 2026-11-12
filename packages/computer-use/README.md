# pi-computer-use

`@nredd/pi-computer-use` lets Pi agents observe and control desktop apps and CDP browser pages.
This workspace tracks upstream `injaneity/pi-computer-use` with the carried patches and exact sync
procedure recorded in [UPSTREAM.md](./UPSTREAM.md).

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
guard is removed without changing this boundary; the call-path proof is in the harness
[coverage policy](../../docs/computer-use-coverage.md#missing-target-call-path-proof-755).

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
- [macOS targeting and carried behavior](./docs/macos-root-targeting.md)
- [Development](https://github.com/nredd/pi-harness/blob/main/packages/computer-use/docs/content/docs/how-to-guides/develop-and-validate.mdx)
- [Contributing](https://github.com/nredd/pi-harness/blob/main/packages/computer-use/CONTRIBUTING.md)

The upstream documentation site source is retained in `docs/`; it is not a root npm workspace and
its build dependencies are not installed by the harness. `npm run docs:generate` refreshes the
source-bound references, and `npm run docs:check` validates them without building the site.

## Checks and release

[Native request framing tests](docs/native-request-framing.md) cover real Swift protocol paths without desktop access.

`npm run check` runs the owned deterministic package checks. Vitest reports native and live suites off
their platform or opt-in as skipped; this package remains outside the coverage gate. Never run
`test:macos-live` on an occupied desktop: it manipulates fixture windows, apps, and the clipboard. It
starts, restarts and stops its own helper instance on the test home's socket, never the shared daemon.
Owner-only smoke commands and rollback are recorded in `UPSTREAM.md`.

`npm run coverage:swift` links all shipped Swift sources with the headless assertions.
`native/macos/ref_look_tests.swift` checks real `AXRefStore` ownership and snapshots plus
`LookNode.payload()` keys, flags, rectangles and recursive child order. It only constructs
self-process/managed-child AX handles and synthetic nodes, never queries AX attributes.
The child is reaped before assertions; a source-level guard forbids AX queries/actions.
The sync-revert controls mutate window equality, destination ownership, optional flags and child order. Unexecuted live code
stays in the denominator; this slice does not claim whole-file coverage or change runtime behavior.
`node scripts/check-sync-reverts.mjs --validate-only` checks the real revert-case inventory
against the ledger without running mutations; the normal command still runs every applicable
mutation. Local measurements and the unequal-window fixture lifecycle are recorded
[here](./docs/swift-ref-look-coverage.md).

`npm run test:linux` uses disposable protocol children, not a native desktop helper. Its closed-stdin
fixture initializes stdout before closing fd `0` (lazy pipe initialization aborts Node 26.12 on Darwin),
acknowledges verified closure while alive, and requires real `EPIPE` rejection plus child cleanup.

The harness root `publish.yml` owns releases; nested upstream workflows are dormant reference source.
Local helper builds and local signing remain unchanged. Source preparation is not activation.

Linux source-build cleanup gives its detached compiler group a bounded TERM/KILL budget. A successful
KILL syscall alone is not treated as success: setup fails if the group cannot be confirmed empty, and
keeps a fresh-probe-guarded exit-time KILL backstop while ownership remains signalable. Only ESRCH
proves quiescence; permission or unexpected syscall errors surface uncertainty and revoke signalling.

## License

MIT, retaining upstream's copyright in `LICENSE`.
