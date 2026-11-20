# Development

Gate with `make check` after `make install-owned`; layout and targets are in `README.md`.
Do not claim a prerequisite, platform, gate, or live check passed without recorded execution evidence.

- Documentation lives in the root and package `README.md` files, updated in the same PR as the
  behavior. Do not add plan, coverage, closure or investigation Markdown; the commit body carries the why.
  `docs/` holds only the references listed in `README.md`.
- Keep owned TypeScript in npm workspaces and Python environments under uv.
- `forks/pi` is the only Gitlink. Publish core commits before referencing them. Parent worktrees do
  not isolate submodule edits; never change a dirty core checkout.
- Preserve retained integration baselines, source attribution, and invalid-run annotations.
- Run format checks, lint, type checks, tests, and relevant real-input/failure-path checks before review.
- Do not regenerate baselines or relax thresholds to make a failing gate pass.
- Keep credentials out of public PR code and test harnesses, with one exception: installer
  CI provisions a temporary `gh` login using a read-only job token (`contents: read`, `attestations: read`)
  for main pushes/dispatches and same-repo PRs; fork PRs and non-main dispatches stay anonymous.
  Hosted runner IPs share GitHub's anonymous 60 requests/hour limit. A PATH-prepended gh shim selects it;
  `make`/pytest receive only its nonsecret directory path (`INSTALLER_GH_CONFIG_DIR`), not a token.
  The shim alone sets `GH_CONFIG_DIR`; `uvx`, Git and package builds receive neither variable nor token.
  TRUST assumption: same-repo branches are owner-reviewed code, not fork-sandboxed. Their authors can
  edit the PR workflow to request write permissions or reference secrets; the read-only permissions
  constrain the submitted workflow only, not arbitrary same-repo PR code.
  KNOWN RESIDUAL: same-UID package code inherits the gh shim through PATH (including uvx, installer,
  pi/npm scripts and Git subprocesses that preserve PATH). It can invoke gh or read the shim's config
  path and plaintext hosts.yml. Environment scrubbing is NOT credential-capability isolation. This
  remains within the same-repo TRUST assumption and the submitted workflow's read-only token scope.
- Second credential exception: the hosted CI `classify` job (owner-approved 2026-11-18) and the hosted
  native-helper `route` job (owner-approved 2026-11-19; GET-only, hosted `ubuntu-24.04`, same-repo
  non-fork events only, skipped on `PI_POOLS_DISABLED`; native-helper routing also skips all PRs) get job-level `actions: read` (`contents` stays read-only) and `GH_TOKEN`
  for the shared pool census, which only issues GET
  reads (argv-tested; a description plus a test, not a technical restriction). The token goes to pushes
  and `workflow_dispatch` on ANY branch and to same-repo PRs; fork PRs get an empty token and
  `--no-pools` for CI; the native-helper route job is skipped altogether on PRs. Fork PRs leave
  every cell hosted. The token is a plain env var visible to every child process of
  repo scripts, and `actions: read` is job-wide, so those processes can read every run and job in the
  repo. Read scope only: no write scope. It rests on the same-repo TRUST assumption above.
- Do not alter the live Pi install, bump pins or run `chezmoi` from this repository.

# Merge and release policy

PRs need their own exact final-HEAD green checks and independent reviews, not another run solely
because `main` advanced. Resolve actual conflicts and re-review every HEAD change. Preserve the
four app-bound Ubuntu checks and non-strict ruleset policy; never re-enable strictness, disable
protection or bypass checks. Before publishing, promoting or deploying, require the exact frozen
combined candidate's full executed CI and artifact evidence, not ordinary main runs or old PR
checks. Follow "Frozen release verification" in `README.md`; unrelated later main advances do not stale that
candidate, but changed selected inputs do.

# macOS CI

- PR CI has four required Ubuntu names: `owned`, `contracts` and both `stack` cells. It has no macOS placeholders or WSL2 jobs. See `macOS PR skip` in the CI job summary.
- Full macOS CI runs on `main` pushes and `workflow_dispatch`, including frozen release verification.
- To test a PR head before merge, run `make check` on macOS. Dispatch `CI` for the full matrix on `main` or an eligible frozen release candidate, not an arbitrary PR ref.
- Each owned fan-in waits for its own OS shards; only the Ubuntu fan-in also checks the native Windows producer.
- Fix macOS failures on `main` forward. No auto-revert; do not block other PRs on red macOS `main`.

# Mandatory PR review

Every PR needs separate read-only Standards and Spec `code-reviewer` subagents, including
documentation, fork, dotfiles, and promotion PRs. Spawn them without a model override: the owner's
`agentModels` routes `code-reviewer` through `router/review`. Record the model each transcript ran.

Review the exact base-to-HEAD diff against the linked issue and scoped requirements. Record the
HEAD SHA, reviewer identities/models, both reports, gate evidence, and finding dispositions in the PR.
Fix blocking findings and re-review. Document the rationale for unimplemented judgement findings.
Every HEAD change invalidates previous review evidence. Do not merge, tag, or promote unreviewed code.
Reviews are not a CI gate: the receipt is a PR comment, and branch protection requires only the CI
jobs listed in `README.md` under "Required checks". A receipt committed by PR code is not a review. Additional critic
reviews do not replace either required axis.
