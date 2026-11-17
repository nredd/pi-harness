# Changelog

## [Unreleased]

- Make the preset the shared source of generic agents and workflow skills. `architect` gains the `pi-web-access` research tools (`web_search`, `fetch_content`, `get_search_content`, `source_check`); `general-purpose` may delegate only to `code-reviewer` (was any agent). Shipping skills gain merged-worktree cleanup, claimed-scratch removal and a monitor-free fallback. ([#1011](https://github.com/nredd/pi-harness/issues/1011), [#1024](https://github.com/nredd/pi-harness/issues/1024))
- Move the footer entry to `src/index.ts` and its helpers to `src/`.
- Move tests to `tests/` and non-test fixtures to `tests/fixtures/`.

Release history before this layout change is recorded in the root `docs/releases.md`.
