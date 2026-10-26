# Development

Follow `docs/migration-plan.md`. Keep implementation and behavioral documentation in the same PR.
Do not claim a prerequisite, platform, gate, or live check passed without recorded execution evidence.

- Import audited source snapshots, never private Git histories or workstation state.
- Preserve benchmark history, source attribution, and invalid-run annotations.
- Keep owned TypeScript in npm workspaces and Python environments under uv.
- Preserve fork histories, native build systems, and lockfiles. Publish fork commits before referencing them.
- Never change a dirty fork checkout during bootstrap. Parent worktrees do not isolate submodule edits automatically.
- Run format checks, lint, type checks, tests, and relevant real-input/failure-path checks before review.
- Do not regenerate baselines or relax thresholds to make a failing gate pass.
- Keep credentials out of public PR code and the benchmark runner, with one exception: installer
  CI provisions a temporary `gh` login using a read-only job token (`contents: read`, `attestations: read`)
  for main pushes/dispatches and same-repo PRs; fork PRs and non-main dispatches stay anonymous.
  Hosted runner IPs share GitHub's anonymous 60 requests/hour limit. A gh-only shim uses that login;
  `make`/pytest receive only its nonsecret directory path (`INSTALLER_GH_CONFIG_DIR`), not a token.
  The shim alone sets `GH_CONFIG_DIR`; `uvx`, Git and package builds receive neither variable nor token.
  TRUST assumption: same-repo branches are owner-reviewed code, not fork-sandboxed. Their authors can
  edit the PR workflow to request write permissions or reference secrets; the read-only permissions
  constrain the submitted workflow only, not arbitrary same-repo PR code.
- Do not activate the distribution, alter the live Pi install, or archive old repositories as part of staging.

# Mandatory PR review

Every PR needs separate read-only Standards and Spec `code-reviewer` subagents, including bootstrap,
documentation, fork, dotfiles, and promotion PRs. Spawn them without a model override: the owner's
`agentModels` routes `code-reviewer` through `router/review`. Record the model each transcript ran.

Review the exact base-to-HEAD diff against the scoped requirements and migration plan. Record the
HEAD SHA, reviewer identities/models, both reports, gate evidence, and finding dispositions in the PR.
Fix blocking findings and re-review. Document the rationale for unimplemented judgement findings.
Every HEAD change invalidates previous review evidence. Do not merge, tag, or promote unreviewed code.
Reviews are not a CI gate: the receipt is a PR comment, and branch protection requires only the CI
jobs listed in `docs/ci.md`. A receipt committed by PR code is not a review. Additional critic
reviews do not replace either required axis.
