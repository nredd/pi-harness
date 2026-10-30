---
name: get-it-merged
description: Prepare open PRs for a dependency-aware merge sequence without inventing base freshness, retry, review, or monitoring evidence. Use when multiple PRs are open in one repo and the user wants them merged.
argument-hint: "[pr-numbers-or-repo] [extra instructions]"
---

# get-it-merged

Prepare a serialized merge sequence. The repository's `CLAUDE.md` / `AGENTS.md` overrides this
procedure. The continuing parent owns the final critic, native CI monitor, protected merge, and
terminal report.

## 1. Survey

One pass, before touching anything:

- Open PRs: `gh pr list --json number,title,headRefName,baseRefName,autoMergeRequest,mergeStateStatus,mergeable`
- Ruleset: `gh api repos/{owner}/{repo}/rulesets` -- record required checks, merge method, and whether strictness is enabled; do not assume either
- Exact-HEAD review receipts: Standards + Spec `code-reviewer` reports and the dedicated critic for each candidate
- Functional dependencies and overlapping paths: `gh pr view`, commit ancestry, and diffs
- Live CI: record concrete run IDs and states. The parent starts a native session-kit monitor when it needs to wait

Disable any armed auto-merge before a PR's HEAD changes. Never use a watcher agent or polling loop
as a substitute for the parent's monitor.

## 2. Order candidates

- Merge a real functional dependency before its dependants
- Put conflicting changes adjacent and resolve the conflict once
- Otherwise preserve independently green, reviewed PRs; do not cancel valid work merely because another PR merged
- Do not require a latest-main rebase solely because the base advanced. Update only for a dependency or actual conflict

## 3. Admit one candidate

For the selected PR:

- Confirm its exact current HEAD has separate Standards + Spec reviews without model overrides and a dedicated critic
- Confirm the Standards and Spec axes have `Checked:` evidence, every reviewer has a named identity/model, and neither the axes nor critic has an unresolved blocking finding
- Confirm normal required checks are green on that exact HEAD. Do not rerun only failed jobs; use the repository's documented flake policy
- Keep auto-merge off until the parent has consumed its independent final critic
- Hand the parent the PR URL, head SHA, review handles, CI run IDs, and native-monitor command. The parent observes the outcome and performs any protected merge

A release or deployment is different: run the repository's frozen combined gate immediately before
publish/deploy. Do not impose that gate on ordinary PR merges.

## 4. Report

- Proposed order and the real dependency/conflict reason
- Exact HEAD, review receipts, CI IDs, and any auto-merge state changed
- Explicit parent handoff for final critic, native monitoring, and protected merge outcome
