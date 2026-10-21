# Widget service v2 upgrade, e2e harness, one-line rows

## Summary
- **Order:** verification first, then changes. A new `widget-e2e` repo gates every release.
- **Core:** rebase onto `v2.0.0` and collapse every row to one line.

Not adopted:
- Widget Durable (library)
- `turbo-cache`: proxies traffic and auth headers

## Key findings
- **Drift:** deployed `v1.7` vs pinned `v1.9`
- **UI:** call and result render stacked

## 0. Harness verification: `widget-e2e` (built first)
- **Why a dedicated repo:** the system spans the core and 3 plugins.
- **Integration scenarios** (headless runs with fake providers):
  - plugins load with no warnings
  - the allow/block table
- **TUI scenarios:**
  - one-line invariant for every collapsed row
  - viewer wheel scrolling
  - Esc on a ready plan stays in Plan mode
- **Bench scenarios** (stored baselines; fail on >20% regression, median of 5):
  - cold startup to first frame
- **Phase 1 (day one):**
  - static checks
  - fake providers
- **Phase 2:** the remaining scenarios, alongside each fix below, test-first.

## 1. Core: `release/v2.0.0` -> `v2.0.0-fork.1`
- **New commit "Collapse every settled row to one line":** call first line, then result first line.
- **Upstream (draft PRs, no reviewers):**
  1. the `Container` mouse alignment
  2. the pressed-button fix
- **Gate and release:** `make check`, tag, release.

## 2. `widget-plugin` -> `v0.4.0-fork.2`
- **Esc:** Esc in the ready chooser keeps the plan.
- **Tests:** the allow/block table and the one-line renders.

## Verification (definition of done)
- `make verify` passes on this machine.
- `make verify-live` passes once.
- All repo gates are green; tags and branches are on origin.

## Assumptions/defaults
- Bench regression threshold: 20%, median of 5.
