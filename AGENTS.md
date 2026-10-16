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
- Never expose credentials to public PR code or the benchmark runner.
- Do not activate the distribution, alter the live Pi install, or archive old repositories as part of staging.

# Mandatory PR review

Every PR needs separate read-only Standards and Spec `code-reviewer` subagents using
`openai-codex/gpt-6.1-sol`, including bootstrap, documentation, fork, dotfiles, and promotion PRs.
Wait if the configured reviewers are unavailable; do not silently substitute models.

Review the exact base-to-HEAD diff against the scoped requirements and migration plan. Record the
HEAD SHA, reviewer identities/models, both reports, gate evidence, and finding dispositions in the PR.
Fix blocking findings and re-review. Document the rationale for unimplemented judgement findings.
Every HEAD change invalidates previous review evidence. Do not merge, tag, or promote unreviewed code.
A receipt committed by PR code is not a trusted review status. Additional critic reviews do not
replace either required axis.
