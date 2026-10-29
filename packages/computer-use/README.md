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
Windows helpers and crate sources are not packed.

## Tools

All platforms retain `find_roots`, `observe_ui`, `search_ui`, `expand_ui`, `inspect_ui`, `act_ui`,
`read_text`, `wait_for`, `launch_browser`, `navigate_browser`, and `evaluate_browser`.
macOS additionally registers `desktop_screenshot` and `desktop_input` (including app activation and
plain-text clipboard access). Desktop tools require `desktop_control: true` and `headless: false`.
They share a scoped physical-input lock with `act_ui`; background semantic work stays independent.

The normal loop is find a root, observe it, then query or act from the returned immutable `stateId`.
`observe_ui` now defaults to compact controls; `detail: "outline"` returns the structural view.
Upstream's opt-in `activity_glow` is retained and defaults to false.

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

`npm run check` runs the owned deterministic package checks. Native and live platform skips print
`NOT RUN`; this package remains outside the coverage gate. Never run `test:macos-live` on an occupied
desktop: it restarts the shared helper and manipulates fixture windows, apps, and the clipboard.
Owner-only smoke commands and rollback are recorded in `UPSTREAM.md`.

The harness root `publish.yml` owns releases; nested upstream workflows are dormant reference source.
Local helper builds and local signing remain unchanged. Source preparation is not activation.

## License

MIT, retaining upstream's copyright in `LICENSE`.
