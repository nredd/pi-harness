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
- For a merged PR, run the `#### PR identity check` block below. It keeps the worktree unless the PR is
  `MERGED`, came from this branch and source repository, and its full `headRefOid` equals
  `git -C <worktree> rev-parse HEAD`. This proves the checked-out commit was pushed even if the
  upstream branch was deleted. A different HEAD, including local commits or a rewritten branch, is
  ineligible even if pushed. Do not fall back to upstream proof for a mismatched merged PR
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
- In both modes, run the `#### Ref, reflog and filter scan` block below and keep on any output. A
  matching PR head or empty upstream range says nothing about commits that exist only in the
  worktree's reflog or local refs
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
    borrowed-object hold without discarding data. Then rerun the per-worktree blocks (the scan and
    the PR identity check); the parent reruns the prune guard separately before any prune. A failed
    check is never overridden, except that the operator may waive a hold caused only by the scan's
    `filter` output through the manual flow in that scan's section

#### PR identity check

Set `pr`, `base_repo` (`<owner>/<repo>`, or `<host>/<owner>/<repo>` off github.com), `worktree` and
`remote` (the branch's push remote). Empty output and exit 0 pass this check only. Missing or
mismatched fields keep the worktree. The push remote must match both the expected host and the host
in the PR URL returned by `gh`.

```sh
python3 - "$pr" "$base_repo" "$worktree" "$remote" <<'PY'
import json
import os
import re
import subprocess
import sys
from urllib.parse import urlsplit

pr, base_repo, worktree, remote = sys.argv[1:]
SOURCE = re.compile(r"^(?:[a-z+]+://)?(?:[^@/]+@)?([^/:]+)(?::\d+)?[:/]([^/]+)/([^/]+?)(?:\.git)?/?$")


def out(*cmd: str, data: bytes = b"") -> bytes:
    """Run a command; any failure or diagnostic means keep."""
    done = subprocess.run(cmd, input=data, capture_output=True, check=False)
    if done.returncode or done.stderr:
        sys.exit(f"keep: {cmd[0]} failed (exit {done.returncode}): {done.stderr!r}")
    return done.stdout


fields = "headRefName,headRepository,headRepositoryOwner,headRefOid,state,url"
info = json.loads(out("gh", "pr", "view", pr, "--repo", base_repo, "--json", fields))
branch = out("git", "-C", worktree, "symbolic-ref", "--short", "HEAD").decode().strip()
head = out("git", "-C", worktree, "rev-parse", "HEAD").decode().strip()
url = out("git", "-C", worktree, "remote", "get-url", "--push", remote).decode().strip()
source = SOURCE.match(url)
parts = base_repo.split("/")
host = parts[0] if len(parts) == 3 else os.environ.get("GH_HOST", "github.com")
repo = info.get("headRepository") or {}
owner = info.get("headRepositoryOwner") or {}
want = ("MERGED", branch, owner.get("login"), repo.get("name"), head, host)
got = (
    info.get("state"),
    info.get("headRefName"),
    source and source[2],
    source and source[3],
    info.get("headRefOid"),
    source and source[1],
)
if None in want or not source or want != got:
    sys.exit(f"keep: PR identity mismatch: PR {want!r} != local {got!r}")
pr_url = info.get("url")
if not isinstance(pr_url, str):
    sys.exit("keep: missing or invalid PR URL")
try:
    parsed = urlsplit(pr_url)
    pr_host = parsed.hostname
except ValueError:
    sys.exit("keep: invalid PR URL")
if parsed.scheme not in ("https", "http") or pr_host != source[1].lower():
    sys.exit(f"keep: PR URL host mismatch: PR {pr_host!r} != push remote {source[1]!r}")
PY
```

#### Prune guard

Only the parent runs this, before any `git worktree prune`; workers never prune. Set `repo`. Empty
output and exit 0 allow the prune. Anything else means only `git worktree prune --dry-run` is
allowed. Run `git -C <repo> fetch --no-auto-maintenance origin` instead of a plain fetch, or
`git worktree lock` worktrees on removable volumes: auto-gc runs the same prune on its own, and
locked worktrees are never pruned. This advice is prose, not automated. Prune deletes a worktree's admin dir, with its `HEAD` reflog and worktree-local refs, when
its directory or `.git` file is gone (unmounted volume, recreated empty directory) and also when
the admin `gitdir` file is empty or missing, which `git worktree list` hides. So the guard checks
the list, every admin dir, and the dry run. Any dry-run output keeps, even whitespace only.

```sh
python3 - "$repo" <<'PY'
import os
import subprocess
import sys

repo = sys.argv[1]


def out(*cmd: str, data: bytes = b"") -> bytes:
    """Run a command; any failure or diagnostic means keep."""
    done = subprocess.run(cmd, input=data, capture_output=True, check=False)
    if done.returncode or done.stderr:
        sys.exit(f"keep: {cmd[0]} failed (exit {done.returncode}): {done.stderr!r}")
    return done.stdout


def git(*args: str, data: bytes = b"") -> bytes:
    """Run Git against the path passed by the shell block."""
    return out("git", "-C", sys.argv[1], *args, data=data)


def read(path: bytes) -> bytes:
    """Return a file's stripped bytes, or empty when unreadable."""
    try:
        with open(path, "rb") as handle:
            return handle.read().strip()
    except OSError:
        return b""


for record in git("worktree", "list", "--porcelain", "-z").split(b"\0\0"):
    fields = [field for field in record.split(b"\0") if field]
    if any(field.startswith(b"prunable") for field in fields):
        sys.exit(f"keep: Git reports {fields[0]!r} prunable")

common = os.fsencode(os.path.join(repo, git("rev-parse", "--git-common-dir").decode().strip()))
admin_root = os.path.join(common, b"worktrees")
for name in sorted(os.listdir(admin_root)) if os.path.isdir(admin_root) else []:
    admin = os.path.join(admin_root, name)
    gitdir = read(os.path.join(admin, b"gitdir"))
    dotgit = os.path.join(admin, gitdir)
    target = read(dotgit)
    if target.startswith(b"gitdir:"):
        target = target[len(b"gitdir:"):]
    target = target.strip()
    if not gitdir or os.path.realpath(
        os.path.join(os.path.dirname(dotgit), target)
    ) != os.path.realpath(admin):
        sys.exit(f"keep: admin dir {admin!r} has no matching `.git` file")

dry = git("worktree", "prune", "--dry-run", "--verbose")
if dry:
    sys.exit(f"keep: `git worktree prune` reported: {dry!r}")
PY
```

#### Ref, reflog and filter scan

Set `worktree` to the candidate's exact path. The scan is read-only and is the only list of these
rules: worktree-local refs, `HEAD` reflog commits outside `git rev-list --all`, an in-progress
`am`, rebase, merge, cherry-pick, revert or bisect in its admin dir, and tracked `filter`
attributes. Only `ENOENT` counts as a missing operation marker; other stat errors keep the
worktree. Empty output and exit 0 pass **only** these checks. Any `keep:` output means keep and
report it. Paths stay NUL-delimited.

Operator notes, never automated:

- A normal rebase, amend or force-push leaves pre-rewrite commits in the `HEAD` reflog, so the scan
  keeps. The operator checks them by hand or anchors them (`git branch saved <sha>`), then reruns
- A clean filter can map different on-disk bytes to the index blob, so empty status is not proof.
  The scan keeps printing `keep` while a `filter` attribute exists, so an agent can never proceed on
  it. The operator reads the printed paths, confirms those raw files are disposable or backed up,
  and removes that exact worktree by hand from outside it with
  `git -C <repo> worktree remove <worktree>` (no `--force`)

```sh
python3 - "$worktree" <<'PY'
import errno
import os
import subprocess
import sys


def out(*cmd: str, data: bytes = b"") -> bytes:
    """Run a command; any failure or diagnostic means keep."""
    done = subprocess.run(cmd, input=data, capture_output=True, check=False)
    if done.returncode or done.stderr:
        sys.exit(f"keep: {cmd[0]} failed (exit {done.returncode}): {done.stderr!r}")
    return done.stdout


def git(*args: str, data: bytes = b"") -> bytes:
    """Run Git against the path passed by the shell block."""
    return out("git", "-C", sys.argv[1], *args, data=data)


local_refs = git("for-each-ref", "--format=%(refname)", "refs/worktree", "refs/bisect", "refs/rewritten")
if local_refs:
    sys.exit(f"keep: worktree-local refs: {local_refs!r}")

git_dir = git("rev-parse", "--absolute-git-dir").strip()
operations = ("rebase-apply", "rebase-merge", "sequencer", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG")
for name in operations:
    marker = os.path.join(git_dir, os.fsencode(name))
    try:
        os.stat(marker, follow_symlinks=False)
    except OSError as exc:
        if exc.errno == errno.ENOENT:
            continue
        sys.exit(f"keep: cannot stat in-progress operation marker {marker!r}: {exc}")
    sys.exit(f"keep: in-progress operation `{name}` in {git_dir!r}")

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
