# Changelog

All notable changes to `@nredd/pi-computer-use` are documented here.

## [Unreleased]

### Changed

- First CI-attested release; no code change.
- Linux: the package now ships the locked `native/linux/bridge-rs` crate source for the opt-in `PI_COMPUTER_USE_ALLOW_BUILD=1` build (`cargo build --locked` into `${XDG_CACHE_HOME:-~/.cache}/pi-computer-use/linux-bridge-target`). An existing helper is probed (protocol 4, architecture invariants) and accepted without setup; a stale or broken one is replaced and re-probed. Fixes a setup failure on every Pi load (nredd/pi-harness#140).
