# Changelog

## [Unreleased]

## [0.5.0] - 2026-11-18

### Changed

- Make the preset the shared source of generic agents and workflow skills. `architect` gains the `pi-web-access` research tools (`web_search`, `fetch_content`, `get_search_content`, `source_check`); `general-purpose` may delegate only to `code-reviewer` (was any agent). Shipping skills gain parent-only merged-worktree cleanup, creation-hash/status/real-path-validated scratch removal and a monitor-free fallback. ([#1011](https://github.com/nredd/pi-harness/issues/1011))
- Show the routed physical model and attributed thinking level without changing the selected virtual profile. ([#760](https://github.com/nredd/pi-harness/issues/760))
- Preserve unknown spend in footer totals instead of treating unpriced usage as free. ([#999](https://github.com/nredd/pi-harness/issues/999))
- Move the footer entry to `src/index.ts` and its helpers to `src/`.
- Move tests to `tests/` and non-test fixtures to `tests/fixtures/`.

Release history before this layout change is recorded in the root `docs/releases.md`.
