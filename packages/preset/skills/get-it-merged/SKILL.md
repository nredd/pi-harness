---
name: get-it-merged
description: "Land a requested set of open PRs as a dependency-aware merge train: the parent reviews, arms protected auto-merge, watches each terminal outcome with a native monitor, and advances until the list is merged or genuinely blocked. Use when multiple PRs are open in one repo and the user wants them merged."
argument-hint: "[pr-numbers-or-repo] [extra instructions]"
---

# get-it-merged

Land a requested set of PRs as a serialized merge train. The repository's `CLAUDE.md` /
`AGENTS.md` overrides this procedure.

Two roles, never confused:

- PARENT driver: the agent the user asked, running this skill itself. It owns the FULL requested list, the dependency/conflict order, exact-HEAD review and gate checks, arming protected auto-merge, the native monitors, and the terminal report. It never hands the merge to "the parent": it IS the parent
- DELEGATED worker: an agent spawned to implement or fix one PR. It has no merge authority. After substantive work it returns concrete handles (PR URL, full HEAD SHA, review handles, CI run IDs, monitor command) once, and never claims the overall task is complete. It does not run this loop

A worker that was handed this skill reads only the Survey and returns handles. Everything below
the Survey is the parent's.

## 1. Survey

One pass, before touching anything. Scope is the full requested set, not the first PR:

- Open PRs: `gh pr list --json number,title,headRefName,baseRefName,autoMergeRequest,mergeStateStatus,mergeable`
- Ruleset: `gh api repos/{owner}/{repo}/rulesets` -- record required checks, merge method, and whether strictness is enabled; do not assume either. A 403, plan-gated, or otherwise unreadable response is UNKNOWN, never "protected"
- Exact-HEAD review receipts: Standards + Spec `code-reviewer` reports and the dedicated critic for each candidate. A critic receipt preserves its original invocation's full SHA (or a recorded short-ref -> full-SHA resolution) and tool-routing metadata
- Functional dependencies and overlapping paths: `gh pr view`, commit ancestry, and diffs
- Live CI: record concrete run IDs and states

Disable any armed auto-merge before a PR's HEAD changes, then renew every review on the new HEAD.
Never use a watcher agent or polling loop to wait; passive watching is a native session-kit
monitor (`monitor_start`).

## 2. Order candidates

- Merge a real functional dependency before its dependants
- Put conflicting changes adjacent and resolve the conflict once
- Otherwise preserve independently green, reviewed PRs; do not cancel or rerun valid work merely because another PR merged
- Do not require a latest-main rebase solely because the base advanced. Update only for a dependency or actual conflict

## 3. Admit one candidate

For the next unblocked PR in the order:

- Confirm its exact current HEAD has separate Standards + Spec reviews without model overrides and a dedicated critic
- Confirm the Standards and Spec axes have `Checked:` evidence and every reviewer has a named identity/model
- Confirm the critic receipt names `critic`, its identity/model, original SHA-bound invocation, and tool-routing metadata; accept only its native `No findings.` or structured finding output. Never synthesize `Checked:` evidence for the critic
- Confirm neither axis nor the critic has an unresolved blocking finding
- Confirm normal required checks are green or pending-and-healthy on that exact HEAD. Do not rerun only failed jobs; use the repository's documented flake policy
- Run the parent's own final critic on the exact HEAD. Auto-merge stays off until it is consumed

## 4. Merge and advance (parent)

- Verify effective protection FIRST. Arming auto-merge merges IMMEDIATELY when the base branch has no effective required checks. Protection is proven only by a readable ruleset or branch protection that lists the required checks for this base. A 403, plan-gated error, or unknown is NOT protected. Never change protections or upgrade the account to find out
- Backend not proven protected: keep auto-merge OFF. Wait with a native monitor for every applicable exact-HEAD CI run to COMPLETE successfully and for all reviews and the parent's critic, then merge explicitly with `gh pr merge <N> --<method> --match-head-commit <full-sha>`. Never use `--admin` or any bypass
- Backend proven protected: arm protected auto-merge with the repository's configured method and head pinning: `gh pr merge <N> --auto --<method> --match-head-commit <full-sha>`. Never merge past failing or missing required checks, and never bypass protection
- Start a native `monitor_start` on the PR (`gh pr view <N> --json state,mergedAt,mergeCommit`) and the exact-HEAD CI run IDs. Wait for the terminal outcome: `MERGED`, a failed required check, or a closed PR
- On `MERGED`: record the merge commit, then return to step 3 for the next unblocked PR. A PR that depended on it is now unblocked; update it only if there is a real conflict (disable auto-merge before any HEAD change and renew all reviews)
- On failure: diagnose the real cause. Fix through a delegated worker or inline, renew reviews on the new HEAD, and continue. Rerun only per the repository's flake policy
- Keep a heartbeat monitor while any PR remains so the loop continues unprompted
- Stop only when every requested PR is merged, or the remaining ones have a genuine external blocker (e.g. required human approval, an outage) with a named owner and a continuation monitor armed. Ordinary docs, test, or conflict work is not a blocker

A release or deployment is different: run the repository's frozen combined gate immediately before
publish/deploy. Do not impose that gate on ordinary PR merges.

## 5. Report

- Order and the real dependency/conflict reason
- Per PR: exact HEAD, review receipts, CI IDs, terminal outcome and merge commit
- Anything still open: the blocker, its owner, and the armed continuation
