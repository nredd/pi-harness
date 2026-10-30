---
name: ship-issue
description: Address a GitHub issue in a dedicated git worktree -- implement, gate, obtain exact-HEAD reviews, open a PR, and hand protected merge ownership to the parent. Use when the user names an issue URL or number and wants it shipped.
argument-hint: <issue-url-or-number> [extra instructions]
---

# ship-issue

Take a GitHub issue from "here is the URL" to a reviewed PR in an isolated worktree. The parent
owns the final critic, native CI monitoring, and protected merge outcome; a delegated
worker hands those back with concrete handles.

The repo's own `CLAUDE.md` / `AGENTS.md` OVERRIDES everything below. Read it first (step 3) and
let it win on gate commands, coverage bars, layout, and style. This file is the procedure, not
the house rules.

Anything you emit -- commit messages, PR bodies, review comments, the final report -- follows
the user's configured writing style (their global agent instructions, when they have any). The
default style, absent other instructions: bare colon-terminated lead-ins plus `-` bullets, NO
markdown headers, no checkbox lists, `--` never em-dashes, backtick every identifier and path.
The headers in *this* file are instructions to you, not a template.

## 1. Resolve the issue

Accept a full URL, `#128`, or a bare `128`. From a URL, pull owner/repo too -- it may not be the
cwd repo.

- `gh issue view <N> --json number,title,body,labels,state,comments`
- Read the comments, not just the body. Prior design context and scope cuts usually live there
- STOP and report if: the issue is closed, or `gh pr list --search "<N>"` shows an open PR
  already addressing it. Do not double-ship
- If two readings of the issue produce materially different work, ask before implementing. If
  it is merely underspecified, make the call a careful colleague would make and say which
  assumption you took

## 2. Worktree

Never work in the user's checkout. One issue, one worktree.

- `git -C <repo> fetch origin` then `git -C <repo> worktree prune` (stale `prunable` entries
  accumulate)
- Branch: `<prefix>/issue-<N>`. `<prefix>` is the repo's documented branch-prefix convention
  (check `AGENTS.md` / `CONTRIBUTING.md` and recent branches), else the operator's GitHub login
  (`gh api user --jq .login`). Append a short kebab slug from the title when the bare number is
  ambiguous or the repo has several open issues in the same area -- e.g.
  `<prefix>/issue-103-flaky-port-race`
- Path: a SIBLING of the repo root, `<parent-of-repo>/issue-<N>`. For
  `/work/plugins/example-repo` that is `/work/plugins/issue-<N>`
- `git -C <repo> worktree add -b <branch> <path> origin/<default-branch>`
- Do NOT use the `EnterWorktree` tool. It does not honor this layout
- Every subsequent command runs with `<path>` as cwd. Pass it explicitly (`git -C`, `make -C`,
  absolute paths) rather than relying on shell state

## 3. Read the repo's rules

- Root `CLAUDE.md` / `AGENTS.md`, plus any directory-scoped ones near the files you will touch
- `Makefile` targets -- that is where the real gate is defined
- `CONTRIBUTING.md`, `CHANGELOG.md` (does the repo keep one? Keep a Changelog format?)

Note the hard rules explicitly before writing code. They are the ones the reviewers will check
against, and the ones that make a PR bounce. Typical shapes: no inline waivers (`noqa`,
`type: ignore`), a coverage floor, modules that must stay import-light, version strings that
live in more than one file, a required changelog entry.

## 4. Implement

Ordinary work, scoped to the issue. Tests by default -- the repo's existing test layout tells
you where they go and what style they are in.

- Match the surrounding code's idiom, naming, comment density, and docstring form
- Update the changelog if the repo keeps one
- Update docs if the change is user-facing and the repo has a docs tree
- Do not widen scope. If you find an adjacent bug, note it for the report; fix it only if the
  change is unshippable without it, and say so in the PR body

## 5. Gate -- before review, not after

Run the repo's real gate and capture the ACTUAL output. It becomes the `Verification:` bullets.

- `make all` when the `Makefile` defines it. Otherwise the closest equivalent: format, lint,
  type check, tests
- `uv run prek run --all-files` (or `pre-commit run --all-files`) when the repo has a
  `.pre-commit-config.yaml`. Local hooks gate commits; a manual run catches what you would
  otherwise discover at push time
- Lockfile check and build if the repo has them (`uv lock --check`, `uv build`)

Red gate means do not proceed. Fix it, or stop and report why it cannot be made green. Never
ship on a gate you did not actually run -- "the imports resolved" is not evidence.

## 6. Commit and push

- Subject: capitalized imperative, no trailing period, no conventional-commit prefix (no
  `feat:` / `fix:` / `chore:`)
- Body only when the subject cannot carry it. Then `Changes:` plus `-` bullets, one concrete
  change each, phrased "Verb the `thing`"
- Keep the `Co-Authored-By: Claude ...` footer. Attribution is a footer, not a writing style --
  the body above it reads like the user
- `git push -u origin <branch>`
- Never `git push --force` to the default branch. Force-push only your own issue branch, and
  only with `--force-with-lease`

## 7. Review round -- exact final HEAD

After the gate, run one dedicated `critic` and use `/skill:code-review` for the separate Standards
and Spec axes. The shared skill selects parent background versus delegated blocking calls, supplies
both full SHAs and the original whole-PR range, and renews it after a HEAD change. Pass the issue/spec
and repo rules; do not use the ambiguous `/code-review` workflow command.

The critic is supplementary, never a substitute for either axis. It is read-only and already
carries the refute-before-report rule, so name the final diff and issue only. Its receipt preserves
the original invocation's full SHA (or a recorded short-ref -> full-SHA resolution), identity/model,
and tool-routing metadata. Accept only the critic's native `No findings.` or structured finding
output -- never manufacture `Checked:` evidence. A delegated worker's critic does not replace
the parent-owned final critic. A parent driver consumes its own final-HEAD critic; it does not
hand that responsibility to itself or repeat an unchanged review merely to change its label.

- Fix every real blocking finding, rerun the affected gate, and push the follow-up
- Every change to HEAD invalidates the critic and both review axes. Re-run all three on the final SHA
- Record reviewer identities/models, reviewed SHA, and `Checked:`/`Findings:` reports for the two axes; record the critic's original SHA-bound invocation, tool-routing metadata, native output, and each finding disposition
- Document a concrete rationale for any retained judgement finding

## 8. Open the PR

`gh pr create --title "<commit subject>" --body-file <tmpfile>`. Write the body to a file in the
scratchpad; do not fight shell quoting.

Body, in order:

- `Closes #<N>.` (or `Fixes #<N>.`)
- `Changes:` plus bullets -- one concrete change each, backtick every identifier, path, and
  dotted module path
- `Verification:` plus prose bullets carrying REAL command output. Fence it when long. Test
  counts, coverage numbers, and actual failure transcripts, not "tests pass"
- Exact-HEAD Standards and Spec receipts with `Checked:`/`Findings:`, plus the critic's original SHA-bound invocation, tool-routing metadata, native output, and finding dispositions
- The continuation record: PR URL, final SHA, concrete CI run IDs or commands, and its owner. A delegated worker names the parent; a parent driver keeps ownership
- The `🤖 Generated with [Claude Code](https://claude.com/claude-code)` footer

Never: `## Summary`, `## Test plan`, `## Root cause`, checkbox lists, or an invented body for a
change whose title already says everything. A title-only PR is a fine default for something
genuinely routine -- but a shipped issue almost always earns a body.

Mark it draft (`--draft`) only when the branch genuinely depends on unmerged work, and say what
it is waiting on.

## 9. Handoff and cleanup

Which role are you? A PARENT driver is the agent the user asked directly; a DELEGATED worker was
spawned by a parent for this issue. Never hand off to yourself.

- Before changing the PR HEAD, disable any armed auto-merge with `gh pr merge --disable-auto <N>` and verify it is off. Renew the critic and both axes after any HEAD change
- Do not require a rebase merely because the base advanced. Update only for a functional dependency or actual conflict; release/deploy work separately requires the frozen combined gate
- Never delegate passive watching or waiting to a watcher agent
- Parent driver: for admission, protection, merge and terminal monitoring, follow `/skill:get-it-merged` steps 3-4 as a one-PR train. That shared procedure requires effective non-bypassable protection before auto-merge; otherwise it keeps auto-merge off, completes exact-HEAD CI and merges explicitly. Do not duplicate or weaken it here
- Parent completion: continue until this PR is `MERGED`, or a genuine external blocker has a named owner and an armed continuation monitor. Queued CI, ordinary setup, tests and review fixes are unfinished work, not successful completion
- Delegated worker: keep auto-merge off, do not merge or arm it. Once the substantive work is done, return the PR URL, final SHA, exact review handles, and concrete CI run IDs or monitor command to the parent, once. Never declare the overall task done
- Do NOT remove the worktree before the PR lands. The follow-up is `git worktree remove <path> && git -C <repo> worktree prune` once it merges

## 10. Report

Short. Issue -> branch -> PR URL -> gate result -> review outcome -> the worktree cleanup
follow-up. No closing summary paragraph, no restating the plan back.

## Guardrails

- Gate cannot be made green: stop and report. Do not ship it
- Never force-push the default branch; `--force-with-lease` on your own branch only
- Never merge past failing checks by hand or bypass protection
- The repo's `CLAUDE.md` outranks this file on every conflict
