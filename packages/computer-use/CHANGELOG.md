# Changelog

All notable changes to `@nredd/pi-computer-use` are documented here.

## [Unreleased]

### Changed

- Prepare `0.6.0` from upstream main `67e9e2f77643f84605b738a3198048a88e92190e`, retaining all desktop tools and Linux support. `observe_ui` now defaults to compact controls (`detail: "outline"` restores structure); opt-in macOS activity glow and upstream Linux/Windows fixes are included. See `UPSTREAM.md` for carried patches, checks, signing decisions, and rollback.
- Linux: the package now ships the locked `native/linux/bridge-rs` crate source for the opt-in `PI_COMPUTER_USE_ALLOW_BUILD=1` build (`cargo build --locked` into `${XDG_CACHE_HOME:-~/.cache}/pi-computer-use/linux-bridge-target`). An existing helper is probed (protocol 4, architecture invariants) and accepted without setup; a stale or broken one is replaced and re-probed. Fixes a setup failure on every Pi load (nredd/pi-harness#140).
