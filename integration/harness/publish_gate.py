"""Standard-library-only gates for the write-privileged promotion job.

`attest-and-publish` holds `contents`/`attestations`/`id-token` write and installs no
dependencies, so everything it runs lives here and imports nothing outside the standard
library (and stays compatible with the runner's system Python).

References:
- https://docs.github.com/rest/git/refs#list-matching-references
- https://docs.github.com/rest/releases/releases#get-a-release-by-tag-name
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Literal

SHA_PATTERN = re.compile(r"^[0-9a-f]{40}$")
META_URL = "https://api.github.com/meta"
SIGNER_WORKFLOW = ".github/workflows/promote-stack.yml"


class PublishError(Exception):
    """A write-job boundary could not complete safely."""


def release_state(existing: Path, rebuilt: Path) -> Literal["create", "resume"]:
    """Decide whether a snapshot release must be created or may be resumed.

    Parameters:
        existing (Path): the release's downloaded snapshot; absent when no release exists.
        rebuilt (Path): the snapshot rebuilt from the selected commit.

    Returns:
        Literal["create", "resume"]: `create` when no release asset exists, `resume` when it is byte-equal.

    Raises:
        ValueError: an existing snapshot differs from the rebuilt one.
    """
    if not existing.exists():
        return "create"
    if existing.read_bytes() != rebuilt.read_bytes():
        raise ValueError(
            "The existing release snapshot differs from the rebuilt one; refusing. "
            "Roll back to it or investigate"
        )
    return "resume"


def verify_tag_target(ref: object, source_sha: str) -> None:
    """Require the snapshot tag to point directly at the selected commit.

    Annotated tags are rejected rather than dereferenced: `gh release create --target <sha>` only
    ever makes a lightweight tag, so an annotated `stack/<sha>` was made by hand, and following
    it would need an extra trusted API hop for a state the workflow never produces.

    Parameters:
        ref (object): a git ref object from `git/ref/tags/...` or one `git/matching-refs` entry.
        source_sha (str): selected commit.

    Raises:
        ValueError: the response is malformed, an annotated tag, or points elsewhere.
    """
    target = ref.get("object") if isinstance(ref, dict) else None
    tagged = target.get("sha") if isinstance(target, dict) else None
    if not isinstance(target, dict) or not isinstance(tagged, str):
        raise ValueError("Tag ref response has no `object.sha`")
    if target.get("type") == "tag":
        raise ValueError("Tag is annotated; snapshot tags must be lightweight tags on the commit")
    if tagged != source_sha:
        raise ValueError(f"Tag points at '{tagged}', not '{source_sha}'")


def _command(
    *args: str,
    cwd: Path | None = None,
    env: dict[str, str] | None = None,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    """Run one workflow command with captured diagnostics.

    Deliberately not `harness.promotion.run_command`: the write job installs nothing, so this
    module may import only the standard library.

    Parameters:
        *args (str): literal executable and arguments.
        cwd (Path | None): optional working directory.
        env (dict[str, str] | None): optional environment replacing the inherited environment.
        check (bool): whether a nonzero exit status raises.

    Returns:
        subprocess.CompletedProcess[str]: completed command result.

    Raises:
        PublishError: the executable could not run or rejected its arguments.
    """
    try:
        return subprocess.run(args, cwd=cwd, env=env, capture_output=True, text=True, check=check)
    except (OSError, subprocess.CalledProcessError) as error:
        detail = error.stderr.strip() if isinstance(error, subprocess.CalledProcessError) else str(error)
        raise PublishError(f"Command failed: {' '.join(args[:2])}: {detail}") from error


def _json(*args: str) -> object:
    """Run one `gh` command and decode its JSON; any failure is an error, never "absent".

    Parameters:
        *args (str): literal executable and arguments.

    Returns:
        object: decoded stdout.

    Raises:
        PublishError: the command failed (404, 403, 5xx and rate limits alike) or printed non-JSON.
    """
    result = _command(*args)
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise PublishError(f"Unreadable response from {' '.join(args[:3])}: {error}") from error


def _tag_refs(repo: str, tag: str) -> list[dict[str, object]]:
    """List the refs named exactly `refs/tags/<tag>`.

    `matching-refs` answers 200 with an empty list for an absent ref (a prefix match, so the
    exact name is filtered), unlike `git/ref`, which answers 404 and cannot be told apart from
    other failures by exit code alone.

    Parameters:
        repo (str): GitHub owner/repository.
        tag (str): tag name.

    Returns:
        list[dict[str, object]]: zero or one exact ref entries.

    Raises:
        PublishError: GitHub could not answer.
    """
    refs = _json("gh", "api", "--paginate", "--slurp", f"repos/{repo}/git/matching-refs/tags/{tag}")
    entries = (
        [entry for page in refs if isinstance(page, list) for entry in page]
        if isinstance(refs, list)
        else None
    )
    if entries is None:
        raise PublishError(f"Malformed matching-refs response for '{tag}'")
    return [entry for entry in entries if isinstance(entry, dict) and entry.get("ref") == f"refs/tags/{tag}"]


def prepare_release(
    repo: str, source_sha: str, rebuilt: Path, existing_dir: Path
) -> Literal["create", "resume"]:
    """Validate an existing tag before any new attestation or release is created.

    Parameters:
        repo (str): GitHub owner/repository.
        source_sha (str): selected commit.
        rebuilt (Path): rebuilt candidate snapshot.
        existing_dir (Path): destination for a retained release asset.

    Returns:
        Literal["create", "resume"]: whether publication creates or resumes the immutable release.

    Raises:
        PublishError: GitHub could not answer, or the tag exists without a snapshot release asset.
        ValueError: an existing tag is annotated or points at another commit, or its asset differs.
    """
    tag = f"stack/{source_sha}"
    exact = _tag_refs(repo, tag)
    if not exact:
        return "create"
    verify_tag_target(exact[0], source_sha)
    release = _json("gh", "api", f"repos/{repo}/releases/tags/{tag}")
    assets = release.get("assets") if isinstance(release, dict) else None
    if not isinstance(assets, list) or not any(
        isinstance(asset, dict) and asset.get("name") == "stack-snapshot.json" for asset in assets
    ):
        raise PublishError(f"Tag '{tag}' exists but its release has no stack-snapshot.json asset; refusing")
    existing_dir.mkdir(parents=True, exist_ok=True)
    _command(
        "gh", "release", "download", tag,
        "--repo", repo,
        "--pattern", "stack-snapshot.json",
        "--dir", str(existing_dir),
        "--clobber",
    )  # fmt: skip
    return release_state(existing_dir / "stack-snapshot.json", rebuilt)


def confirm_tag(repo: str, source_sha: str) -> None:
    """Fail unless the published snapshot tag exists and points directly at the selected commit.

    Parameters:
        repo (str): GitHub owner/repository.
        source_sha (str): selected commit.

    Raises:
        PublishError: GitHub could not answer or the tag is absent.
        ValueError: the tag is annotated or points elsewhere.
    """
    exact = _tag_refs(repo, f"stack/{source_sha}")
    if not exact:
        raise PublishError(f"Tag 'stack/{source_sha}' does not exist after publication")
    verify_tag_target(exact[0], source_sha)


def tip_source_sha(tip_bytes: bytes) -> str:
    """Parse the `source_sha` of a stable pointer once, requiring a full lowercase SHA.

    Parameters:
        tip_bytes (bytes): `stable.json` at the current `stack-channel` tip.

    Returns:
        str: the 40-hex `source_sha`; never starts with `-`, so it is safe as a git revision.

    Raises:
        PublishError: the pointer is unreadable or names no valid commit.
    """
    try:
        current = json.loads(tip_bytes)["source_sha"]
    except (ValueError, KeyError, TypeError) as error:
        raise PublishError(f"Current stack-channel stable.json is unreadable: {error}") from error
    if not isinstance(current, str) or not SHA_PATTERN.fullmatch(current):
        raise PublishError("Current stack-channel stable.json has a malformed `source_sha`")
    return current


def channel_tip_is_candidate(tip_bytes: bytes, snapshot_bytes: bytes, source_sha: str) -> bool:
    """Report whether the live tip already is the candidate; refuse same-commit different bytes.

    Closes the window between the read-only verification and the push: a manual push in between
    must not be silently overwritten by an older or diverged candidate.

    Parameters:
        tip_bytes (bytes): `stable.json` at the current `stack-channel` tip.
        snapshot_bytes (bytes): the candidate snapshot.
        source_sha (str): the candidate commit.

    Returns:
        bool: `True` when the tip already is the candidate (nothing to push), `False` when
            ancestry against the tip's `source_sha` must still be checked by the caller.

    Raises:
        PublishError: the tip is unreadable, or is the candidate commit with different bytes.
    """
    if tip_source_sha(tip_bytes) != source_sha:
        return False
    if tip_bytes != snapshot_bytes:
        raise PublishError("stack-channel already names this commit with different bytes; refusing")
    return True


def _require_descendant(current: str, source_sha: str, env: dict[str, str] | None) -> None:
    """Fail unless the candidate commit strictly descends from the channel tip's commit.

    Parameters:
        current (str): validated `source_sha` of the tip.
        source_sha (str): candidate commit.
        env (dict[str, str] | None): command environment.

    Raises:
        PublishError: Git could not compare the commits.
        ValueError: the candidate does not descend from the tip.
    """
    result = _command("git", "merge-base", "--is-ancestor", "--", current, source_sha, env=env, check=False)
    if result.returncode == 1:
        raise ValueError(f"Candidate '{source_sha}' does not descend from the current stable '{current}'")
    if result.returncode != 0:
        raise PublishError(f"Could not compare '{current}' with '{source_sha}': {result.stderr.strip()}")


def ssh_host_keys() -> str:
    """Fetch GitHub's SSH host keys as `known_hosts` lines, unauthenticated.

    Returns:
        str: one `github.com <key>` line per published key.

    Raises:
        PublishError: the meta endpoint was unreachable or malformed.
    """
    try:
        with urllib.request.urlopen(META_URL, timeout=30) as response:
            keys = json.load(response)["ssh_keys"]
        return "".join(f"github.com {key}\n" for key in keys)
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise PublishError(f"Could not read GitHub SSH host keys: {error}") from error


def _write_private(path: Path, content: str) -> None:
    """Create a new file readable only by the owner, with no window at a wider mode.

    Parameters:
        path (Path): file that must not exist yet.
        content (str): its contents.
    """
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as handle:
        handle.write(content)


def _live_tip(repo: str) -> bytes | None:
    """Read `stable.json` at the live `stack-channel` tip through the API, read-only.

    Parameters:
        repo (str): GitHub owner/repository.

    Returns:
        bytes | None: the file, or `None` when the channel does not exist yet (the seed).

    Raises:
        PublishError: GitHub could not answer.
    """
    refs = _json("gh", "api", "--paginate", "--slurp", f"repos/{repo}/git/matching-refs/heads/stack-channel")
    pages = refs if isinstance(refs, list) else None
    if pages is None:
        raise PublishError("Malformed matching-refs response for 'stack-channel'")
    if not any(
        isinstance(entry, dict) and entry.get("ref") == "refs/heads/stack-channel"
        for page in pages
        for entry in (page if isinstance(page, list) else [])
    ):
        return None
    result = _command(
        "gh", "api", "-H", "Accept: application/vnd.github.raw+json",
        f"repos/{repo}/contents/stable.json?ref=stack-channel",
    )  # fmt: skip
    return result.stdout.encode()


def preflight_channel(
    repo: str,
    source_sha: str,
    snapshot: Path,
    *,
    key_present: bool,
    operation: str,
    temp_dir: Path,
    existing_dir: Path,
) -> None:
    """Fail before any attestation, release or tag if the pointer could not advance afterwards.

    Read-only. `advance_channel` repeats the live-tip checks as the final guard; this step only
    makes a doomed promotion fail while it still has no side effect.

    Parameters:
        repo (str): GitHub owner/repository.
        source_sha (str): selected commit.
        snapshot (Path): verified candidate snapshot.
        key_present (bool): whether the deploy key secret is non-empty.
        operation (str): `promote` or `rollback`.
        temp_dir (Path): scratch directory for the attested tip.
        existing_dir (Path): destination for the retained rollback asset.

    Raises:
        PublishError: the key is absent, GitHub or the attestation failed, or a rollback target
            is not a retained promoted snapshot.
        ValueError: a promotion candidate is stale, duplicate or diverged.
    """
    if not key_present:
        raise PublishError("STACK_CHANNEL_DEPLOY_KEY (write deploy key, ruleset bypass actor) is required")
    if operation == "rollback":
        # The retained snapshot is the only trust root; rollback must work even if the tip is bad.
        if prepare_release(repo, source_sha, snapshot, existing_dir) != "resume":
            raise PublishError(f"'stack/{source_sha}' is not a previously promoted, retained snapshot")
        return
    tip = _live_tip(repo)
    if tip is not None:
        tip_path = temp_dir / "stack-channel-tip.json"
        tip_path.write_bytes(tip)
        _command(
            "gh", "attestation", "verify", str(tip_path),
            "--repo", repo,
            "--signer-workflow", f"{repo}/{SIGNER_WORKFLOW}",
            "--source-ref", "refs/heads/main",
            "--deny-self-hosted-runners",
        )  # fmt: skip
    if tip is not None and not channel_tip_is_candidate(tip, snapshot.read_bytes(), source_sha):
        _require_descendant(tip_source_sha(tip), source_sha, None)


def advance_channel(
    repo: str,
    source_sha: str,
    snapshot: Path,
    deploy_key: str,
    temp_dir: Path,
    *,
    require_successor: bool = False,
    remote: str | None = None,
) -> None:
    """Commit the verified snapshot as the sole `stack-channel` file and push it over SSH.

    Parameters:
        repo (str): GitHub owner/repository.
        source_sha (str): selected commit.
        snapshot (Path): verified snapshot to copy to `stable.json`.
        deploy_key (str): ruleset-bypassing deploy private key.
        temp_dir (Path): runner temporary directory.
        require_successor (bool): re-check against the live tip that the candidate descends from it
            (promotion); rollback leaves this off because it may move to a non-descendant.
        remote (str | None): remote URL override; defaults to the repository's SSH URL.

    Raises:
        PublishError: the key is absent or an SSH/Git operation fails.
        ValueError: `require_successor` and the live tip is not an ancestor of the candidate.
    """
    if not deploy_key:
        raise PublishError("STACK_CHANNEL_DEPLOY_KEY (write deploy key, ruleset bypass actor) is required")
    key, known_hosts = temp_dir / "stack-channel-key", temp_dir / "known_hosts"
    _write_private(key, f"{deploy_key}\n")
    try:
        known_hosts.write_text(ssh_host_keys())
        ssh = (
            f"ssh -i {key} -o IdentitiesOnly=yes -o UserKnownHostsFile={known_hosts} "
            "-o StrictHostKeyChecking=yes"
        )
        # Neither secret nor token reaches the git/ssh children: only what they need to run. Ambient
        # git config is ignored, so e.g. `fetch.prune` cannot change what the fetch below does.
        env = {
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_SSH_COMMAND": ssh,
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": os.environ.get("HOME", str(temp_dir)),
        }
        remote = remote or f"git@github.com:{repo}.git"
        listed = _command(
            "git", "ls-remote", "--exit-code", "--heads", remote, "stack-channel", env=env, check=False
        )
        if listed.returncode == 0:
            _command(
                "git",
                "fetch",
                remote,
                "stack-channel:refs/remotes/origin/stack-channel",
                env=env,
            )
            if require_successor:
                tip = _command("git", "show", "refs/remotes/origin/stack-channel:stable.json", env=env).stdout
                if channel_tip_is_candidate(tip.encode(), snapshot.read_bytes(), source_sha):
                    return
                _require_descendant(tip_source_sha(tip.encode()), source_sha, env)
            _command("git", "switch", "-C", "stack-channel-next", "origin/stack-channel", env=env)
        elif listed.returncode == 2:
            _command("git", "switch", "--orphan", "stack-channel-next", env=env)
        else:
            raise PublishError(f"Could not list stack-channel over SSH: {listed.stderr.strip()}")
        _command("git", "rm", "-rf", "--ignore-unmatch", ".", env=env)
        Path("stable.json").write_bytes(snapshot.read_bytes())
        _command("git", "add", "stable.json", env=env)
        changed = _command("git", "diff", "--cached", "--quiet", env=env, check=False)
        if changed.returncode == 0:
            return
        if changed.returncode != 1:
            raise PublishError("Could not inspect the staged stack-channel update")
        _command(
            "git",
            "-c",
            "user.name=stack-promotion",
            "-c",
            "user.email=stack-promotion@users.noreply.github.com",
            "commit",
            "-m",
            f"Advance stable stack to {source_sha}",
            env=env,
        )
        _command("git", "push", remote, "HEAD:refs/heads/stack-channel", env=env)
    finally:
        key.unlink(missing_ok=True)


def _parser() -> argparse.ArgumentParser:
    """Build the subcommand parser.

    Returns:
        argparse.ArgumentParser: parser for release, tag and channel gates.
    """
    parser = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True)
    tag = commands.add_parser("tag-target", help="Fail unless the snapshot tag points at the SHA")
    tag.add_argument("--repo", required=True)
    tag.add_argument("--source-sha", required=True)
    prepare = commands.add_parser("prepare-release", help="Validate an existing tag before attestation")
    prepare.add_argument("--repo", required=True)
    prepare.add_argument("--source-sha", required=True)
    prepare.add_argument("--rebuilt", type=Path, required=True)
    prepare.add_argument("--existing-dir", type=Path, required=True)
    prepare.add_argument("--github-output", type=Path, required=True)
    preflight = commands.add_parser(
        "preflight-channel", help="Read-only: fail before any side effect if the pointer cannot advance"
    )
    preflight.add_argument("--repo", required=True)
    preflight.add_argument("--source-sha", required=True)
    preflight.add_argument("--snapshot", type=Path, required=True)
    preflight.add_argument(
        "--key-present-env", required=True, help="Env var that is `true` if the key is set"
    )
    preflight.add_argument("--temp-dir", type=Path, required=True)
    preflight.add_argument("--existing-dir", type=Path, required=True)
    preflight.add_argument("--operation", choices=("promote", "rollback"), required=True)
    channel = commands.add_parser("advance-channel", help="Advance stack-channel over the deploy key")
    channel.add_argument("--repo", required=True)
    channel.add_argument("--source-sha", required=True)
    channel.add_argument("--snapshot", type=Path, required=True)
    channel.add_argument("--deploy-key-env", required=True)
    channel.add_argument("--temp-dir", type=Path, required=True)
    channel.add_argument(
        "--operation",
        choices=("promote", "rollback"),
        required=True,
        help="`promote` refuses unless the candidate descends from the live tip; `rollback` may not",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    """Run one gate subcommand; refusals exit 1 with a one-line error.

    Parameters:
        argv (list[str] | None): arguments, or the process arguments.

    Returns:
        int: 0 on success, 1 on a failed gate.
    """
    args = _parser().parse_args(argv)
    try:
        if args.command == "tag-target":
            confirm_tag(args.repo, args.source_sha)
        elif args.command == "prepare-release":
            state = prepare_release(args.repo, args.source_sha, args.rebuilt, args.existing_dir)
            args.github_output.write_text(f"state={state}\n")
        elif args.command == "preflight-channel":
            preflight_channel(
                args.repo,
                args.source_sha,
                args.snapshot,
                key_present=os.environ.get(args.key_present_env) == "true",
                operation=args.operation,
                temp_dir=args.temp_dir,
                existing_dir=args.existing_dir,
            )
        else:
            advance_channel(
                args.repo,
                args.source_sha,
                args.snapshot,
                os.environ.get(args.deploy_key_env, ""),
                args.temp_dir,
                require_successor=args.operation == "promote",
            )
    except (ValueError, OSError, PublishError, json.JSONDecodeError) as error:
        sys.stderr.write(f"FAILED: {error}\n")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
