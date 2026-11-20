"""Run the shipped worktree sweep blocks (scan, identity check, prune guard) in disposable repos.

References:
    https://git-scm.com/docs/git-worktree
    https://git-scm.com/docs/git-check-attr
"""

from __future__ import annotations

import ast
import errno
import fnmatch
import json
import os
import shlex
import shutil
import subprocess
from pathlib import Path
from textwrap import dedent
from typing import NamedTuple

import pytest

SKILL = Path(__file__).resolve().parents[2] / "packages/preset/skills/get-it-merged/SKILL.md"
HEADINGS = ("PR identity check", "Prune guard", "Ref, reflog and filter scan")


class LinkedWorktree(NamedTuple):
    """Paths to a disposable repository and its linked worktree."""

    repo: Path
    worktree: Path


class Mutation(NamedTuple):
    """An exact source substitution in a shipped script under test."""

    original: str
    replacement: str


def git_env() -> dict[str, str]:
    """Prevent ambient Git routing and global config from affecting fixtures."""
    keys = os.environ.keys() - fnmatch.filter(os.environ, "GIT_*")
    return {key: os.environ[key] for key in keys} | {
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": os.devnull,
    }


def git(repo: Path, *args: str) -> str:
    """Run real Git in the named disposable repository."""
    return subprocess.check_output(["git", "-C", str(repo), *args], env=git_env(), text=True, timeout=30)


@pytest.fixture
def linked(tmp_path: Path) -> LinkedWorktree:
    """Create a branch already at its upstream tip, isolated from ambient Git config."""
    repo = tmp_path / "repo"
    repo.mkdir()
    git(repo, "init", "--template=", "-b", "main")
    git(repo, "config", "user.name", "Fixture")
    git(repo, "config", "user.email", "fixture@example.invalid")
    git(repo, "commit", "--allow-empty", "-m", "Base")
    worktree = tmp_path / "linked worktree"
    git(repo, "worktree", "add", "-b", "merged", str(worktree))
    git(worktree, "branch", "--set-upstream-to=main")
    return LinkedWorktree(repo, worktree)


def block_source(heading: str) -> str:
    """Extract the shell block shipped under `heading`."""
    text = SKILL.read_text(encoding="utf-8")
    marker = f"#### {heading}\n"
    assert marker in text, f"`{marker.strip()}` heading missing from {SKILL}; update the test with the skill"
    fence = text.split(marker, 1)[1].split("```sh\n", 1)
    assert len(fence) == 2, f"no `sh` block under `{heading}`"
    assert "\n```" in fence[1], f"unterminated `sh` block under `{heading}`"
    return fence[1].split("\n```", 1)[0]


def block(
    heading: str, path: str | None = None, mutate: Mutation | None = None, **variables: str
) -> subprocess.CompletedProcess[str]:
    """Run the shipped shell block with its documented variables set."""
    script = block_source(heading)
    if mutate:
        assert mutate.original in script, f"`{mutate.original}` not in the `{heading}` block"
        script = script.replace(mutate.original, mutate.replacement)
    env = git_env()
    env.pop("GH_HOST", None)
    return subprocess.run(
        ["/bin/sh", "-c", script],
        env=env | ({"PATH": path} if path else {}) | variables,
        text=True,
        capture_output=True,
        check=False,
        timeout=30,
    )


def scan(worktree: Path, mutate: Mutation | None = None, **env: str) -> subprocess.CompletedProcess[str]:
    """Execute the shipped ref, reflog and filter scan, without any removal step."""
    return block("Ref, reflog and filter scan", mutate=mutate, worktree=str(worktree), **env)


def dry_prune(repo: Path) -> str:
    """Return what `git worktree prune --dry-run --verbose` reports (Git writes it to stderr)."""
    done = subprocess.run(
        ["git", "-C", str(repo), "worktree", "prune", "--dry-run", "--verbose"],
        env=git_env(),
        text=True,
        capture_output=True,
        check=True,
    )
    return done.stdout + done.stderr


def assert_looks_clean(worktree: Path) -> None:
    """Establish that the old HEAD, status and index checks would not detect the loss."""
    assert git(worktree, "rev-parse", "HEAD") == git(worktree, "rev-parse", "@{u}")
    assert git(worktree, "status", "--porcelain", "--ignored", "--untracked-files=all") == ""
    assert all(line.startswith("H ") for line in git(worktree, "ls-files", "-v").splitlines())


@pytest.mark.parametrize("preserve", [False, True], ids=["reflog-only", "shared-ref"])
def test_detached_commit_in_head_reflog(linked: LinkedWorktree, preserve: bool) -> None:
    """Retain an unanchored detached commit; allow an operator to anchor it and retry."""
    repo, worktree = linked
    git(worktree, "switch", "--detach")
    git(worktree, "commit", "--allow-empty", "-m", "Detached work")
    detached = git(worktree, "rev-parse", "HEAD").strip()
    git(worktree, "switch", "merged")
    assert_looks_clean(worktree)
    assert detached in git(worktree, "reflog", "show", "--format=%H", "HEAD").splitlines()
    assert detached not in git(worktree, "rev-list", "--all").splitlines()

    if preserve:
        git(repo, "branch", "saved", detached)
    result = scan(worktree)
    if preserve:
        assert (result.returncode, result.stdout, result.stderr) == (0, "", "")
    else:
        assert result.returncode != 0
        assert f"keep: HEAD reflog commits outside refs: [b'{detached}']" in result.stderr
    assert worktree.is_dir()

    # Reproduce the old fallback on purpose, only inside the disposable repository.
    git(repo, "worktree", "remove", str(worktree))
    assert not worktree.exists()
    assert (detached in git(repo, "rev-list", "--all", "--reflog").splitlines()) == preserve


@pytest.mark.parametrize("namespace", ["worktree", "bisect", "rewritten"])
def test_local_ref_blocks_even_when_its_commit_is_already_shared(
    linked: LinkedWorktree, namespace: str
) -> None:
    """Keep the local ref name even when there is no reflog-only commit to protect."""
    repo, worktree = linked
    ref = f"refs/{namespace}/sweep-fixture"
    git(worktree, "update-ref", ref, "HEAD")
    assert git(repo, "for-each-ref", ref) == ""
    assert_looks_clean(worktree)

    result = scan(worktree)
    assert result.returncode != 0
    assert "keep: worktree-local refs:" in result.stderr
    assert ref in result.stderr
    assert git(worktree, "rev-parse", ref) == git(worktree, "rev-parse", "HEAD")


def test_clean_filter_hides_raw_bytes_on_unusual_path(linked: LinkedWorktree) -> None:
    """Keep bytes that a real clean filter strips, even on a path with whitespace."""
    repo, worktree = linked
    git(repo, "config", "filter.strip.clean", "sed 's/^scratch$/tracked/'")
    git(repo, "config", "filter.strip.smudge", "cat")
    git(repo, "config", "filter.strip.required", "true")
    name = "-note with\nspace.txt"
    (worktree / ".gitattributes").write_text("*.txt filter=strip\n", encoding="utf-8")
    path = worktree / name
    path.write_bytes(b"tracked\n")
    git(worktree, "add", "--", ".gitattributes", name)
    git(worktree, "commit", "-m", "Track filtered file")
    git(repo, "merge", "--ff-only", "merged")
    raw = b"scratch\n"
    path.write_bytes(raw)
    assert git(worktree, "show", f":{name}") == "tracked\n"
    assert git(worktree, "-c", "filter.strip.clean=cat", "status", "--porcelain").startswith(" M ")
    assert_looks_clean(worktree)

    result = scan(worktree)
    assert result.returncode != 0
    assert "keep: filter attributes on tracked paths:" in result.stderr
    assert repr(os.fsencode(name)) in result.stderr
    assert "scratch" not in result.stderr
    assert path.read_bytes() == raw

    # The old fallback deletes the raw bytes despite status being empty.
    git(repo, "worktree", "remove", str(worktree))
    assert not path.exists()


def prune_guard(repo: Path) -> subprocess.CompletedProcess[str]:
    """Run the shipped prune guard against `repo`."""
    return block("Prune guard", repo=str(repo))


def test_prune_dry_run_with_stderr_keeps(tmp_path: Path, linked: LinkedWorktree) -> None:
    """An otherwise clean prune guard must also reject stderr from the dry run."""
    real_git = shutil.which("git")
    assert real_git is not None
    stub = tmp_path / "git"
    stub.write_text(
        dedent(f"""\
            #!/bin/sh
            if [ "$#" -eq 6 ] && [ "$3 $4 $5 $6" = 'worktree prune --dry-run --verbose' ]; then
                printf '\\n' >&2
            fi
            exec {shlex.quote(real_git)} "$@"
            """),
        encoding="utf-8",
    )
    stub.chmod(0o755)
    result = block("Prune guard", path=f"{tmp_path}{os.pathsep}{os.environ['PATH']}", repo=str(linked.repo))
    assert result.returncode != 0
    assert "keep: git failed (exit 0): b'\\n'" in result.stderr


def registered(repo: Path) -> bool:
    """Whether Git still has admin data for the linked worktree."""
    return any((repo / ".git/worktrees").glob("*/HEAD"))


def test_unmounted_worktree_is_kept_and_unguarded_prune_loses_it(linked: LinkedWorktree) -> None:
    """Refuse to prune when a registered worktree directory vanished, as with an unmounted volume."""
    repo, worktree = linked
    assert prune_guard(repo).returncode == 0
    git(worktree, "update-ref", "refs/worktree/saved", "HEAD")
    worktree.rename(repo.parent / "unmounted")

    listing = git(repo, "worktree", "list", "--porcelain", "-z").split("\0")
    assert any(field.startswith("worktree ") and field.endswith("linked worktree") for field in listing)
    assert "prunable gitdir file points to non-existent location" in listing
    guard = prune_guard(repo)
    assert guard.returncode != 0
    assert "keep: Git reports" in guard.stderr
    dry = dry_prune(repo)
    assert "Removing worktrees/linked-worktree: gitdir file points to non-existent location" in dry
    assert registered(repo)

    # The loss the guard prevents: an unguarded prune deletes the admin dir with its local refs and reflog.
    git(repo, "worktree", "prune")
    assert not registered(repo)
    assert git(repo, "for-each-ref", "refs/worktree") == ""


def test_directory_without_dot_git_passes_test_d_but_not_the_guard(linked: LinkedWorktree) -> None:
    """Reproduce a surviving directory with no `.git` file, which `test -d` cannot see."""
    repo, worktree = linked
    (worktree / ".git").unlink()
    assert subprocess.run(["/bin/sh", "-c", 'test -d "$1"', "sh", str(worktree)], check=False).returncode == 0
    listing = git(repo, "worktree", "list", "--porcelain", "-z")
    assert "prunable gitdir file points to non-existent location" in listing

    guard = prune_guard(repo)
    assert guard.returncode != 0
    assert "keep: Git reports" in guard.stderr
    assert registered(repo)


def test_guard_rejects_unreadable_dot_git_without_a_prunable_record(linked: LinkedWorktree) -> None:
    """Keep when `.git` is absent even if Git has no prunable record for it (e.g. a locked worktree)."""
    repo, worktree = linked
    git(repo, "worktree", "lock", str(worktree))
    (worktree / ".git").unlink()
    guard = prune_guard(repo)
    assert guard.returncode != 0
    assert "keep:" in guard.stderr


FIELDS = "headRefName,headRepository,headRepositoryOwner,headRefOid,state,url"
PR_FIELDS = FIELDS.split(",")


def stub_gh(tmp_path: Path, script: str) -> str:
    """Install a `gh` running `script` and return a PATH that finds it first."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    stub = bin_dir / "gh"
    stub.write_text(f"#!/bin/sh\n{script}\n")
    stub.chmod(0o755)
    return f"{bin_dir}{os.pathsep}{os.environ['PATH']}"


def strict_gh(payload: dict[str, object], base_repo: str, *, warn: bool = False) -> str:
    """A `gh` that emits `payload` (and optionally a warning) only with the expected repo and fields."""
    diagnostic = "echo 'incomplete metadata' >&2" if warn else ""
    return f"""repo= fields= prev=
for arg; do
  [ "$prev" = --repo ] && repo=$arg
  [ "$prev" = --json ] && fields=$arg
  prev=$arg
done
[ "$repo" = {base_repo} ] || {{ echo "bad --repo: $repo" >&2; exit 2; }}
for need in {" ".join(PR_FIELDS)}; do
  case ",$fields," in *",$need,"*) ;; *) echo "missing --json field $need" >&2; exit 2 ;; esac
done
cat <<'JSON'
{json.dumps(payload)}
JSON
{diagnostic}"""


def identity(
    tmp_path: Path,
    linked: LinkedWorktree,
    *,
    url: str = "https://github.com/acme/widgets.git",
    mutate: Mutation | None = None,
    script: str | None = None,
    warn: bool = False,
    overrides: dict[str, object] | None = None,
    base_repo: str = "acme/widgets",
    env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    """Run the shipped identity block for a worktree whose branch is `merged` from `acme/widgets`."""
    repo, worktree = linked
    git(repo, "remote", "add", "origin", url)
    parts = base_repo.split("/")
    host = parts[0] if len(parts) == 3 else (env or {}).get("GH_HOST", "github.com")
    payload: dict[str, object] = {
        "state": "MERGED",
        "url": f"https://{host}/acme/widgets/pull/7",
        "headRefName": "merged",
        "headRefOid": git(worktree, "rev-parse", "HEAD").strip(),
        "headRepository": {"name": "widgets"},
        "headRepositoryOwner": {"login": "acme"},
    } | (overrides or {})
    payload = {key: value for key, value in payload.items() if value is not None}
    return block(
        "PR identity check",
        path=stub_gh(tmp_path, script or strict_gh(payload, base_repo, warn=warn)),
        mutate=mutate,
        pr="7",
        base_repo=base_repo,
        worktree=str(worktree),
        remote="origin",
        **(env or {}),
    )


@pytest.mark.parametrize(
    "url",
    [
        "https://github.com/acme/widgets.git",
        "git@github.com:acme/widgets.git",
        "ssh://git@github.com:22/acme/widgets",
    ],
    ids=["https", "scp", "ssh-port"],
)
def test_matching_pr_identity_proceeds(tmp_path: Path, linked: LinkedWorktree, url: str) -> None:
    """A merged PR from this branch, host, owner, repository and commit passes."""
    result = identity(tmp_path, linked, url=url)
    assert (result.returncode, result.stdout, result.stderr) == (0, "", "")


@pytest.mark.parametrize(
    "override",
    [
        {"headRefName": "someone-elses-branch"},
        {"headRepositoryOwner": {"login": "fork-owner"}},
        {"headRepository": {"name": "other-repo"}},
        {"state": "OPEN"},
        {"headRefOid": "0" * 40},
        {"headRefName": None},
        {"headRepositoryOwner": None},
        {"headRepository": None},
        {"headRefOid": None},
    ],
    ids=["branch", "owner", "repo", "state", "oid", "no-branch", "no-owner", "no-repo", "no-oid"],
)
def test_mismatched_or_missing_pr_identity_keeps(
    tmp_path: Path, linked: LinkedWorktree, override: dict[str, object]
) -> None:
    """Any wrong or absent identity field keeps the worktree."""
    result = identity(tmp_path, linked, overrides=override)
    assert result.returncode != 0
    assert "keep: PR identity mismatch" in result.stderr
    assert linked.worktree.is_dir()


def test_push_remote_on_another_host_keeps(tmp_path: Path, linked: LinkedWorktree) -> None:
    """Same owner and repository on a different host is a different repository."""
    result = identity(tmp_path, linked, url="https://git.example.invalid/acme/widgets.git")
    assert result.returncode != 0
    assert "keep: PR identity mismatch" in result.stderr
    assert "git.example.invalid" in result.stderr


@pytest.mark.parametrize("field", PR_FIELDS)
def test_dropping_a_shipped_json_field_is_caught(tmp_path: Path, linked: LinkedWorktree, field: str) -> None:
    """A `--json` list missing a field fails the strict `gh`, so the original defect cannot return."""
    kept = ",".join(name for name in PR_FIELDS if name != field)
    result = identity(tmp_path, linked, mutate=Mutation(f'"{FIELDS}"', f'"{kept}"'))
    assert result.returncode != 0
    assert f"missing --json field {field}" in result.stderr


def test_gh_failure_keeps(tmp_path: Path, linked: LinkedWorktree) -> None:
    """A failing `gh` is unknown, never a pass."""
    result = identity(
        tmp_path, linked, url="git@github.com:acme/widgets.git", script="echo 'HTTP 502' >&2\nexit 1"
    )
    assert result.returncode != 0
    assert "keep: gh failed" in result.stderr


@pytest.mark.parametrize(
    ("pr_url", "diagnostic"),
    [
        ("https://git.example.invalid/acme/widgets/pull/7", "PR URL host mismatch"),
        (None, "missing or invalid PR URL"),
        ("https://[bad/acme/widgets/pull/7", "invalid PR URL"),
        ("/acme/widgets/pull/7", "PR URL host mismatch"),
    ],
    ids=["enterprise-default", "missing", "malformed", "relative"],
)
def test_pr_url_must_verify_the_push_host(
    tmp_path: Path, linked: LinkedWorktree, pr_url: str | None, diagnostic: str
) -> None:
    """Even with a matching branch and OID, a bare GH repo can query another host."""
    result = identity(tmp_path, linked, overrides={"url": pr_url})
    assert result.returncode != 0
    assert f"keep: {diagnostic}" in result.stderr


def test_successful_gh_with_stderr_keeps(tmp_path: Path, linked: LinkedWorktree) -> None:
    """A valid identity payload is not proof if `gh` also emitted a warning."""
    result = identity(tmp_path, linked, warn=True)
    assert result.returncode != 0
    assert "keep: gh failed (exit 0): b'incomplete metadata" in result.stderr


def test_command_wrapper_is_identical_in_all_shipped_blocks() -> None:
    """The standalone blocks must agree on command execution and failure handling."""
    wrappers = {}
    for heading in HEADINGS:
        script = block_source(heading).split("\n", 1)[1].removesuffix("\nPY")
        (wrapper,) = (
            node
            for node in ast.parse(script).body
            if isinstance(node, ast.FunctionDef) and node.name == "out"
        )
        wrappers[heading] = ast.dump(wrapper)
    assert len(set(wrappers.values())) == 1, wrappers


def test_missing_skill_heading_fails_clearly() -> None:
    """A reformatted skill gives an actionable failure, not an IndexError."""
    with pytest.raises(AssertionError, match="heading missing"):
        block("No such heading")


def test_prunable_record_alone_keeps(linked: LinkedWorktree) -> None:
    """Keep when `.git` exists but the admin dir's `gitdir` points nowhere, so Git reports it prunable."""
    repo, worktree = linked
    (gitdir,) = (repo / ".git/worktrees").glob("*/gitdir")
    gitdir.write_text(f"{worktree}-moved/.git\n", encoding="utf-8")
    assert (worktree / ".git").exists()
    assert "prunable gitdir file points to non-existent location" in git(
        repo, "worktree", "list", "--porcelain"
    )
    guard = prune_guard(repo)
    assert guard.returncode != 0
    assert "keep: Git reports" in guard.stderr


def test_hidden_worktree_with_empty_admin_gitdir_is_kept(linked: LinkedWorktree) -> None:
    """`git worktree list` omits a worktree whose admin `gitdir` is empty, but prune still deletes it."""
    repo, worktree = linked
    git(worktree, "update-ref", "refs/worktree/x", "HEAD")
    (admin,) = (repo / ".git/worktrees").iterdir()
    assert (admin / "refs/worktree/x").is_file()
    (admin / "gitdir").write_bytes(b"")
    assert (worktree / ".git").is_file()

    listing = git(repo, "worktree", "list", "--porcelain", "-z")
    assert "linked worktree" not in listing
    dry = dry_prune(repo)
    assert "Removing worktrees/linked-worktree: invalid gitdir file" in dry

    # The previous guard looked only at the list: nothing prunable, every listed `.git` present.
    assert "prunable" not in listing
    assert all(
        Path(line.removeprefix("worktree ")).exists()
        for line in listing.split("\0")
        if line.startswith("worktree ")
    )
    guard = prune_guard(repo)
    assert guard.returncode != 0
    assert "keep:" in guard.stderr
    assert admin.is_dir()

    git(repo, "worktree", "prune")
    assert not admin.exists()


def test_dot_git_file_pointing_at_another_admin_dir_is_kept(linked: LinkedWorktree) -> None:
    """Keep when the worktree's `.git` file names a different admin dir than the one registered for it."""
    repo, worktree = linked
    (worktree / ".git").write_text(f"gitdir: {repo}/.git/worktrees/other\n", encoding="utf-8")
    assert git(repo, "worktree", "list", "--porcelain", "-z").count("prunable") == 0
    guard = prune_guard(repo)
    assert guard.returncode != 0
    assert "no matching `.git` file" in guard.stderr


HOST = "git.example.invalid"


def test_base_repo_with_host_prefix_matches_remote_host(tmp_path: Path, linked: LinkedWorktree) -> None:
    """`<host>/<owner>/<repo>` names the expected host explicitly."""
    ok = identity(tmp_path, linked, url=f"https://{HOST}/acme/widgets.git", base_repo=f"{HOST}/acme/widgets")
    assert (ok.returncode, ok.stdout, ok.stderr) == (0, "", "")


def test_base_repo_with_host_prefix_rejects_github_remote(tmp_path: Path, linked: LinkedWorktree) -> None:
    """A github.com push remote does not satisfy a `<host>/<owner>/<repo>` base."""
    bad = identity(tmp_path, linked, base_repo=f"{HOST}/acme/widgets")
    assert bad.returncode != 0
    assert "keep: PR identity mismatch" in bad.stderr


def test_gh_host_environment_names_the_expected_host(tmp_path: Path, linked: LinkedWorktree) -> None:
    """`GH_HOST` replaces the `github.com` default for a bare `<owner>/<repo>`."""
    ok = identity(tmp_path, linked, url=f"https://{HOST}/acme/widgets.git", env={"GH_HOST": HOST})
    assert (ok.returncode, ok.stdout, ok.stderr) == (0, "", "")


def test_gh_host_environment_rejects_github_remote(tmp_path: Path, linked: LinkedWorktree) -> None:
    """With `GH_HOST` set, a github.com push remote is a different host."""
    bad = identity(tmp_path, linked, env={"GH_HOST": HOST})
    assert bad.returncode != 0
    assert "keep: PR identity mismatch" in bad.stderr


SKIP_OPERATION_CHECK = Mutation("for name in operations:", "for name in ():")
FAILING_PATCH = """From 1111111111111111111111111111111111111111 Mon Sep 17 00:00:00 2001
From: Fixture <fixture@example.invalid>
Date: Mon, 1 Jan 2024 00:00:00 +0000
Subject: [PATCH] Unappliable

---
 missing.txt | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)

diff --git a/missing.txt b/missing.txt
--- a/missing.txt
+++ b/missing.txt
@@ -1 +1 @@
-old
+new
--\x20
2.0.0
"""


def test_stopped_git_am_is_kept_though_status_is_clean(linked: LinkedWorktree) -> None:
    """A failed `git am` leaves `rebase-apply/` in the admin dir, which worktree removal deletes."""
    _, worktree = linked
    am = subprocess.run(
        ["git", "-C", str(worktree), "am"],
        input=FAILING_PATCH,
        env=git_env(),
        text=True,
        capture_output=True,
        check=False,
    )
    assert am.returncode != 0
    assert_looks_clean(worktree)
    assert (Path(git(worktree, "rev-parse", "--absolute-git-dir").strip()) / "rebase-apply").is_dir()

    assert scan(worktree, mutate=SKIP_OPERATION_CHECK).returncode == 0
    result = scan(worktree)
    assert result.returncode != 0
    assert "keep: in-progress operation `rebase-apply`" in result.stderr


@pytest.mark.parametrize("err", [errno.EACCES, errno.EIO], ids=["permission-denied", "io-error"])
def test_operation_marker_stat_error_keeps(tmp_path: Path, linked: LinkedWorktree, err: int) -> None:
    """Inject an admin lookup failure independently of privileges, while Git still runs normally."""
    worktree = linked.worktree
    git_dir = Path(git(worktree, "rev-parse", "--absolute-git-dir").strip())
    marker = os.fsencode(git_dir / "rebase-apply")
    (tmp_path / "sitecustomize.py").write_text(
        dedent(f"""\
            import os

            def fail_marker_lookup(stat):
                def checked(path, *args, **kwargs):
                    if path == {marker!r}:
                        raise OSError({err}, os.strerror({err}), path)
                    return stat(path, *args, **kwargs)
                return checked

            os.stat = fail_marker_lookup(os.stat)
            os.lstat = fail_marker_lookup(os.lstat)
            """),
        encoding="utf-8",
    )
    result = scan(worktree, PYTHONPATH=str(tmp_path))
    assert result.returncode != 0
    assert f"keep: cannot stat in-progress operation marker {marker!r}" in result.stderr
    assert os.strerror(err) in result.stderr


def test_dangling_operation_marker_keeps(linked: LinkedWorktree) -> None:
    """A dangling operation marker is still present and must not be treated as absent."""
    worktree = linked.worktree
    git_dir = Path(git(worktree, "rev-parse", "--absolute-git-dir").strip())
    (git_dir / "rebase-apply").symlink_to("missing")
    result = scan(worktree)
    assert result.returncode != 0
    assert "keep: in-progress operation `rebase-apply`" in result.stderr


def test_stopped_cherry_pick_is_kept(linked: LinkedWorktree) -> None:
    """A conflicted multi-commit cherry-pick leaves `sequencer/` and `CHERRY_PICK_HEAD`."""
    _, worktree = linked
    (worktree / "f").write_text("a\n", encoding="utf-8")
    git(worktree, "add", "f")
    git(worktree, "commit", "-m", "A")
    git(worktree, "switch", "-c", "side", "HEAD~1")
    (worktree / "f").write_text("b\n", encoding="utf-8")
    git(worktree, "add", "f")
    git(worktree, "commit", "-m", "B")
    (worktree / "g").write_text("g\n", encoding="utf-8")
    git(worktree, "add", "g")
    git(worktree, "commit", "-m", "C")
    git(worktree, "switch", "merged")
    pick = subprocess.run(
        ["git", "-C", str(worktree), "cherry-pick", "side~1", "side"],
        env=git_env(),
        capture_output=True,
        check=False,
    )
    assert pick.returncode != 0
    git_dir = Path(git(worktree, "rev-parse", "--absolute-git-dir").strip())
    assert (git_dir / "sequencer").is_dir()
    assert (git_dir / "CHERRY_PICK_HEAD").is_file()

    assert scan(worktree, mutate=SKIP_OPERATION_CHECK).returncode == 0
    result = scan(worktree)
    assert result.returncode != 0
    assert "keep: in-progress operation" in result.stderr
