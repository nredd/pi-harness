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
- Protection: list rulesets with `gh api repos/{owner}/{repo}/rulesets`, then read every applicable enforced ruleset detail and classic branch protection for the target base. Establish the effective required checks, merge method, strictness, enforcement and whether the merging caller can bypass each applicable protection. A list of names or readable required-status listing alone does not prove protection. A 403, plan-gated, unreadable or uncertain bypass response is UNKNOWN, never "protected"
- Whole-PR review receipts: record the original full merge-base and current full HEAD for each candidate. Standards + Spec `code-reviewer` reports must cover that immutable `<base>...<head>` range; the dedicated critic receipt preserves its original invocation's full SHA (or a recorded short-ref -> full-SHA resolution) and tool-routing metadata
- Functional dependencies and overlapping paths: `gh pr view`, commit ancestry, and diffs
- Live CI: record concrete run IDs and states

Disable any armed auto-merge before a PR's HEAD changes, then renew every review from the preserved original merge-base through the new full HEAD; corrective-delta reviews are supplemental only.
Parent only: use native session-kit monitors (`monitor_start`, discover via `search_tools` if deferred) for passive waiting, including bounded-interval
pollers. Pass `todo: <id>` (or a list) when a todo tracks the wait: only a linked monitor arms that in_progress todo. A worker returns the proposed monitor command instead. Keep model turns and subagents for substantive work, not repeated status polling.

Detect a missing monitor from the tool list and `search_tools`, never from error wording.
If native monitors remain unavailable, the PARENT alone uses bounded foreground waits:
`timeout 1500 gh run watch <run-id> --interval 60 --exit-status` for each
exact-HEAD run, then bounded `gh pr view <N> --json state,mergedAt,mergeCommit` polls until
merged, closed or failed. Re-issue after each timeout; a timeout (exit 124) is not a terminal
state. Use the platform's equivalent bounded timeout if `timeout` is absent.
Never use `gh pr checks --watch` or a watcher agent. On HTTP 403/429 rate limiting, wait until
the recorded reset rather than retry-spinning. Report that no continuation monitor exists,
the next owner and the exact command to resume. Workers still return handles, never poll.

## 2. Order candidates

- Merge a real functional dependency before its dependants
- Put conflicting changes adjacent and resolve the conflict once
- Otherwise preserve independently green, reviewed PRs; do not cancel or rerun valid work merely because another PR merged
- Do not require a latest-main rebase solely because the base advanced. Update only for a dependency or actual conflict

## 3. Admit one candidate

For the next unblocked PR in the order:

- When a worker or permitted critic receipt is present, confirm it names `critic`, its identity/model, original SHA-bound invocation, and tool-routing metadata; accept only its native `No findings.` or structured finding output. Never synthesize `Checked:` evidence for the critic. A worker's `Parent critic: PENDING` is not a critic receipt
- Confirm its exact current HEAD has separate Standards + Spec reviews without model overrides; both axes name the preserved original full merge-base, current full HEAD, and whole-PR range
- Confirm the Standards and Spec axes have `Checked:` evidence and every reviewer has a named identity/model
- Confirm neither axis nor any present critic receipt has an unresolved blocking finding
- Confirm normal required checks are green or pending-and-healthy on that exact HEAD. Use the repository's documented flake policy for any rerun: preserve attempts and rerun the whole permitted job, never a selected failed-test subset or an until-green loop
- Gate: run the parent's own final critic on the exact HEAD and resolve its blocking findings. It is mandatory even when a worker critic receipt is present. Auto-merge stays off until it is consumed

## 4. Merge and advance (parent)

- Verify effective protection FIRST. Arming auto-merge merges IMMEDIATELY when the base branch has no effective required checks. Protection is proven only when readable applicable rulesets and classic branch protection establish effective required checks for this base *and* that the merging caller cannot bypass them. A 403, plan-gated error, unknown, or uncertain bypass eligibility is NOT protected. Never change protections or upgrade the account to find out
- Backend not proven protected: keep auto-merge OFF. Wait with a native monitor for every applicable exact-HEAD CI run to COMPLETE successfully and for all reviews and the parent's critic, then merge explicitly with `gh pr merge <N> --<method> --match-head-commit <full-sha>`. Never use `--admin` or any bypass
- Backend proven protected: arm protected auto-merge with the repository's configured method and head pinning: `gh pr merge <N> --auto --<method> --match-head-commit <full-sha>`. Never merge past failing or missing required checks, and never bypass protection
- Start `monitor_start` (discover via `search_tools` if deferred) to watch complete exact-HEAD workflow runs around `gh run watch <run-id> --interval 60 --exit-status`. Early check rollups may contain only classification jobs and are not terminal workflow evidence. Use a native bounded-interval poller around `gh pr view <N> --json state,mergedAt,mergeCommit` until the PR is `MERGED`, closed, or has a failed required check; one status query is not a watcher
- On `MERGED`: record the merge commit, apply the "Before stopping" cleanup below, then return to step 3 for the next unblocked PR. A PR that depended on it is now unblocked; update it only if there is a real conflict (disable auto-merge before any HEAD change and renew all reviews)
- On failure: diagnose the real cause. Fix through a delegated worker or inline, renew reviews on the new HEAD, and continue. Rerun only per the repository's flake policy
- Keep a heartbeat monitor linked to the tracked todos (`todo: [<id>, ...]`) while any PR remains so the loop continues unprompted. Without native monitors, continue the bounded foreground waits from step 1
- Before stopping, apply the "Guarded merged-worktree sweep" below, then consider claimed scratch separately:
  - Consider only dirty candidates left by the MERGED PR sweep. Apply its linked-worktree, ownership, and borrowed-object checks before touching any scratch.
  - Remove only regular files and symlinks claimed in the handback and listed as `??` in THAT worktree's `git status --porcelain --untracked-files=all`, on an exact type and hash match. Use the same method as the worker in `ship-issue`: SHA-256 of a regular file's bytes or a symlink's raw `readlink` bytes (no added newline). Require the real path of a regular file, or the real path of a symlink's parent directory joined with the link name, to be inside the worktree. Never resolve the link itself; unlink only the link and leave its target untouched.
  - Never remove modified tracked files, ignored files or unclaimed paths as scratch. Keep and report directories; never recursively delete contents as scratch.
  - After scratch removal, rerun the full guarded sweep on that same worktree before any worktree removal. Report each retained worktree's path, reason, and actual `git status --porcelain --ignored --untracked-files=all` output (or the scan error)
- Stop only when every requested PR is merged, or the remaining ones have a genuine external blocker (e.g. required human approval, an outage) with a named owner and a continuation monitor armed and linked to its todo (without native monitors: the exact resume command). Ordinary docs, test, or conflict work is not a blocker

A release or deployment is different: run the repository's frozen combined gate immediately before
publish/deploy. Do not impose that gate on ordinary PR merges.

### Guarded merged-worktree sweep

Parent only. Consider only worktrees of MERGED PRs, except when `ship-issue` explicitly calls for
no-PR cleanup. Check each candidate before removal:

- Require a linked worktree on a branch, never the user's checkout or a detached HEAD. Verify the
  branch with `git -C <worktree> symbolic-ref --quiet HEAD`. Keep worktrees with a live process cwd
  inside them, a recorded live owner, or objects borrowed by another checkout
- For a merged PR, run `gh pr view <N> --repo <base-owner>/<base-repo> --json headRefName,headRepository,headRepositoryOwner,headRefOid,state`.
  Require `MERGED`, `headRefName` equal to the candidate's local branch name, and `headRepository.name`
  and `headRepositoryOwner.login` equal to the candidate's verified source repository name and owner
  (from the branch's push destination, not assumed from the PR's base). Keep on missing or mismatched
  identity. Require the full `headRefOid` to match `git -C <worktree> rev-parse HEAD` exactly. This
  proves the checked-out commit was pushed even if the upstream branch was deleted. A different HEAD,
  including local commits or a rewritten branch, is ineligible even if pushed. Do not fall back to
  upstream proof for a mismatched merged PR
- Only for the explicit no-PR mode in `ship-issue`, fetch the configured upstream remote and verify
  the upstream branch still exists there and the local upstream ref is current. Require a successful,
  empty `git -C <worktree> rev-list '@{u}..HEAD'` against that ref. Keep the worktree if the upstream
  is missing or unverifiable
- Run `git -C <worktree> status --porcelain --ignored --untracked-files=all`. Require a successful,
  empty scan with no warnings about incomplete results. Keep worktrees with `!!` entries or known
  retained claimed directories, even empty ones that Git status cannot see. An empty status does not
  require a handback or claims. If no worker was delegated, there are no worker claims. Any `??`
  entry blocks worktree removal; only a matching claim can authorize the separate scratch removal
- Run `git -C <worktree> ls-files -v` and require success with no entries tagged lowercase or `S`.
  Also keep sparse-checkout worktrees and worktrees with effective `core.ignoreStat` enabled.
  Assume-unchanged and skip-worktree flags can hide edits from status. Non-forced worktree removal
  can still delete those edits, ignored files and empty directories
- In both modes, run the shared ref, reflog and filter checks below. Keep if the worktree has local
  `refs/worktree/*`, `refs/bisect/*` or `refs/rewritten/*`, or if any commit in its `HEAD` reflog is
  missing from `git rev-list --all`. A matching PR head or empty upstream range says nothing about
  a detached commit left behind after switching back to the branch. Preserve those commits on
  shared refs and let the operator resolve worktree-local refs before retrying
- Keep when any tracked path has a `filter` attribute unless the operator explicitly confirms, for
  this exact worktree and the reported paths, that the raw file contents are disposable or backed up.
  A clean filter can map different on-disk bytes to the same index blob, so empty status is not proof.
  Report only paths and attributes, not file contents. Confirmation resolves only the filter hold;
  rerun this scan and all other guards before removal, and keep on any new ambiguity
- If a check fails or cannot be completed, keep and report the worktree. Recheck immediately before
  removal. Use a configured sweep only if its documented interface accepts an explicit scope to that
  exact worktree path (e.g. `--worktree <path>`). A dry-run match is not proof of scope. Without
  path scoping, the merged sweep fallback is `git worktree remove <path>` from outside the eligible
  worktree. Leave branches alone in the fallback. Never use `--force` or `git branch -D`. There is
  no manual no-PR fallback
- Report each retained path, the reason, and actual status output (or the scan error), including each
  `!!` path and any flagged `git ls-files -v` lines, not file contents. Tell the operator to:
  - Confirm which files and directories are disposable or backed up, then move or clear those paths
    themselves. Do not assume `node_modules/`, `.venv/` or `dist/` is disposable
  - Review edits on flagged files themselves, then clear the applicable flags on confirmed paths
    with `git -C <worktree> update-index --no-skip-worktree -- <path>` and/or
    `git -C <worktree> update-index --no-assume-unchanged -- <path>`. Keep sparse-checkout or
    `core.ignoreStat` worktrees until the operator deliberately makes the full status visible
  - Verify branch and PR identity and preserve extra commits on a separate ref before addressing a
    HEAD mismatch. For no-PR work, restore or verify the upstream. Resolve any live ownership or
    borrowed-object hold without discarding data. Rerun the full guard; confirmation never overrides a failed check

#### Shared ref, reflog and filter checks

Set `worktree` to the candidate's exact path. The scan is read-only. An empty, successful result
passes **only** these checks. A nonzero result or diagnostic means keep and report it, subject only
to the explicit filter confirmation rule above. Use NUL-delimited paths throughout the attribute
scan; splitting `git ls-files` on whitespace can miss tracked files.

```sh
python3 - "$worktree" <<'PY'
import subprocess
import sys


def git(*args: str, data: bytes = b"") -> bytes:
    """Read Git output, treating failed or warned scans as unknown."""
    result = subprocess.run(
        ["git", "-C", sys.argv[1], *args], input=data, capture_output=True, check=False
    )
    if result.returncode or result.stderr:
        sys.exit(f"keep: git {args[0]} (exit {result.returncode}): {result.stderr!r}")
    return result.stdout


local_refs = git("for-each-ref", "--format=%(refname)", "refs/worktree", "refs/bisect", "refs/rewritten")
if local_refs:
    sys.exit(f"keep: worktree-local refs: {local_refs!r}")

git("reflog", "exists", "HEAD")
reflog = set(git("reflog", "show", "--format=%H", "HEAD").splitlines())
if not reflog:
    sys.exit("keep: empty HEAD reflog")
missing = sorted(reflog.difference(git("rev-list", "--all").splitlines()))
if missing:
    sys.exit(f"keep: HEAD reflog commits outside refs: {missing!r}")

paths = git("ls-files", "-z")
attrs = git("check-attr", "-z", "--stdin", "-a", data=paths)
if attrs:
    fields = attrs.split(b"\0")
    if fields[-1] or (len(fields) - 1) % 3:
        sys.exit("keep: malformed attribute scan")
    filters = [
        (fields[i], fields[i + 2])
        for i in range(0, len(fields) - 1, 3)
        if fields[i + 1] == b"filter"
    ]
    if filters:
        sys.exit(f"keep: filter attributes on tracked paths: {filters!r}")
PY
```

## 5. Report

- Order and the real dependency/conflict reason
- Per PR: exact HEAD, review receipts, CI IDs, terminal outcome and merge commit
- Anything still open: the blocker, its owner, and the armed continuation
