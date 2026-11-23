# Changelog

## [Unreleased]

### Added

- Render any provider's router quota views in the footer, including Gemini usage counts and inferred blocks, without changing legacy Anthropic or Codex rows. (#1178)
- Qualify inferred and assumed quota spans, keep count reset times, label stale counts and pools, keep rows for failed views, rank blocked providers ahead of the footer's provider cap and fit fallback rows to the width without cutting a block's evidence. (#1178)
- Rank blocked providers by lowest remaining quota under the footer's provider cap, bound quota labels, fit the `+N more` pointer to any width while keeping the hidden blocked count, report failed views unless a cached value is visible, budget legacy-selection rows that carry a block and reuse the effective quota state between renders. (#1178)
- Show confirmed model blocks on legacy rows (v1 `blocks` and read marks; the pre-view footer ignored blocks), search every block for one that fits a narrow row and count dropped blocks as ` +K!`, report a failed view after each layout drops its cached value, tag colliding provider labels with a stable id hash, and keep the day on compact cross-day blocks. (#1178)

### Changed

- Use one read-only worktree sweep guard in `ship-issue` and `get-it-merged`. Authorize no deletion of worktrees, branches or claimed scratch. This keep-only rollout supersedes the earlier scratch-removal policy. Keep the legacy command available during rollout. Report upstream as unchecked when no PR exists; never run the checkout's configured transport. Require Git 2.36+ to disable fsmonitor safely and restrict child environments to an allowlist. (#1175)
- Compare the index with `HEAD` in the sweep guard as defense in depth. The shipped CLI is keep-only and reaches no `eligible` verdict; only the test-only closed-scope path previously returned `eligible` with a dirty index. Staged edits, deletions, intent-to-add, unmerged and gitlink entries now keep with `staged changes: index differs from HEAD` instead of `status not collected`, and an unreadable `HEAD` keeps. The cached `git diff-index` compares object IDs only and reads no worktree files. ([#1175](https://github.com/nredd/pi-harness/issues/1175))
- Restore the `architect` routing hint, cost-ranked survey cards, `shortcut:` decisions, large-repo scoping, grill format and survey length limit. Keep the preset's intentional `codebase-design` preload (the local definition had `skills: false`). ([#1025](https://github.com/nredd/pi-harness/issues/1025))
- Document that `general-purpose` no longer runs critics; the parent owns the final critic review. ([#1025](https://github.com/nredd/pi-harness/issues/1025))

### Fixed

- Keep worktrees when `gh` returns a PR URL that does not verify the push remote host, when probing an in-progress operation marker fails with anything other than `ENOENT`, or when a prune dry run emits any output, including whitespace only. ([#1126](https://github.com/nredd/pi-harness/issues/1126))
- Keep worktrees with local refs, reflog-only commits, an in-progress `am`, rebase, merge, cherry-pick, revert or bisect, or unconfirmed clean filters. Verify the PR source branch, repository host and head before removal. Refuse `git worktree prune` while Git reports a prunable worktree, an admin `gitdir` is empty or missing, a `.git` file names another admin dir, or `git worktree prune --dry-run --verbose` prints anything. Fetch with `--no-auto-maintenance`. ([#1057](https://github.com/nredd/pi-harness/issues/1057))
- Share the same worktree safety checks before creating an issue worktree, after merge, and before no-PR removal. Use the recorded merged PR head when the upstream is gone. Report retained ignored paths and preserve files hidden by index flags. ([#1050](https://github.com/nredd/pi-harness/issues/1050))
- Keep worktrees with ignored files. ([#1024](https://github.com/nredd/pi-harness/issues/1024))

## [0.5.0] - 2026-11-18

### Changed

- Make the preset the shared source of generic agents and workflow skills. `architect` gains the `pi-web-access` research tools (`web_search`, `fetch_content`, `get_search_content`, `source_check`); `general-purpose` may delegate only to `code-reviewer` (was any agent). Shipping skills gain parent-only merged-worktree cleanup, creation-hash/status/real-path-validated scratch removal and a monitor-free fallback. ([#1011](https://github.com/nredd/pi-harness/issues/1011))
- Show the routed physical model and attributed thinking level without changing the selected virtual profile. ([#760](https://github.com/nredd/pi-harness/issues/760))
- Preserve unknown spend in footer totals instead of treating unpriced usage as free. ([#999](https://github.com/nredd/pi-harness/issues/999))
- Move the footer entry to `src/index.ts` and its helpers to `src/`.
- Move tests to `tests/` and non-test fixtures to `tests/fixtures/`.

Release history before this layout change is recorded in the root `docs/releases.md`.
