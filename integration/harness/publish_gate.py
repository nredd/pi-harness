"""Standard-library-only gates for the write-privileged promotion job.

`attest-and-publish` holds `contents`/`attestations`/`id-token` write and installs no
dependencies, so everything it runs lives here and imports nothing outside the standard
library (and stays compatible with the runner's system Python).

References:
- https://docs.github.com/rest/git/refs#get-a-reference
- https://docs.github.com/rest/releases/releases#get-a-release-by-tag-name
"""

from __future__ import annotations

import argparse
import json
import os
import stat
import subprocess
import sys
from pathlib import Path
from typing import Literal


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
    """Require the snapshot tag to point at the selected commit.

    Parameters:
        ref (object): `git/ref/tags/stack/<sha>` response.
        source_sha (str): selected commit.

    Raises:
        ValueError: the tag response is malformed or points elsewhere.
    """
    target = ref.get("object") if isinstance(ref, dict) else None
    tagged = target.get("sha") if isinstance(target, dict) else None
    if not isinstance(tagged, str):
        raise ValueError("Tag ref response has no `object.sha`")
    if tagged != source_sha:
        raise ValueError(f"Tag points at '{tagged}', not '{source_sha}'")


def _command(
    *args: str,
    cwd: Path | None = None,
    env: dict[str, str] | None = None,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    """Run one workflow command with captured diagnostics.

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
        PublishError: GitHub cannot answer about the tag or release asset.
        ValueError: an existing tag points at another commit or its asset differs.
    """
    tag = f"stack/{source_sha}"
    ref = _command("gh", "api", f"repos/{repo}/git/ref/tags/{tag}", check=False)
    if ref.returncode == 0:
        verify_tag_target(json.loads(ref.stdout), source_sha)
        existing_dir.mkdir(parents=True, exist_ok=True)
        _command(
            "gh",
            "release",
            "download",
            tag,
            "--repo",
            repo,
            "--pattern",
            "stack-snapshot.json",
            "--dir",
            str(existing_dir),
            "--clobber",
        )
    elif ref.returncode != 1:
        raise PublishError(f"Could not read snapshot tag '{tag}': {ref.stderr.strip()}")
    return release_state(existing_dir / "stack-snapshot.json", rebuilt)


def advance_channel(repo: str, source_sha: str, snapshot: Path, deploy_key: str, temp_dir: Path) -> None:
    """Commit the verified snapshot as the sole `stack-channel` file and push it over SSH.

    Parameters:
        repo (str): GitHub owner/repository.
        source_sha (str): selected commit.
        snapshot (Path): verified snapshot to copy to `stable.json`.
        deploy_key (str): ruleset-bypassing deploy private key.
        temp_dir (Path): runner temporary directory.

    Raises:
        PublishError: the key is absent or an SSH/Git operation fails.
    """
    if not deploy_key:
        raise PublishError("STACK_CHANNEL_DEPLOY_KEY (write deploy key, ruleset bypass actor) is required")
    key, known_hosts = temp_dir / "stack-channel-key", temp_dir / "known_hosts"
    key.write_text(f"{deploy_key}\n")
    key.chmod(stat.S_IRUSR | stat.S_IWUSR)
    try:
        keys = _command("gh", "api", "meta", "--jq", '.ssh_keys[] | "github.com " + .').stdout
        known_hosts.write_text(keys)
        ssh = (
            f"ssh -i {key} -o IdentitiesOnly=yes -o UserKnownHostsFile={known_hosts} "
            "-o StrictHostKeyChecking=yes"
        )
        env = os.environ | {"GIT_SSH_COMMAND": ssh}
        remote = f"git@github.com:{repo}.git"
        listed = subprocess.run(
            ["git", "ls-remote", "--exit-code", "--heads", remote, "stack-channel"],
            capture_output=True,
            text=True,
            env=env,
            check=False,
        )
        if listed.returncode == 0:
            _command("git", "fetch", remote, "stack-channel:refs/remotes/origin/stack-channel", env=env)
            _command("git", "switch", "-C", "stack-channel-next", "origin/stack-channel", env=env)
        elif listed.returncode == 2:
            _command("git", "switch", "--orphan", "stack-channel-next", env=env)
        else:
            raise PublishError(f"Could not list stack-channel over SSH: {listed.stderr.strip()}")
        _command("git", "rm", "-rf", "--ignore-unmatch", ".", env=env)
        Path("stable.json").write_bytes(snapshot.read_bytes())
        _command("git", "add", "stable.json", env=env)
        changed = subprocess.run(["git", "diff", "--cached", "--quiet"], env=env, check=False)
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
    state = commands.add_parser("release-state", help="Print create or resume for the snapshot release")
    state.add_argument("--existing", type=Path, required=True)
    state.add_argument("--rebuilt", type=Path, required=True)
    tag = commands.add_parser("tag-target", help="Fail unless the snapshot tag points at the SHA")
    tag.add_argument("--ref", type=Path, required=True)
    tag.add_argument("--source-sha", required=True)
    prepare = commands.add_parser("prepare-release", help="Validate an existing tag before attestation")
    prepare.add_argument("--repo", required=True)
    prepare.add_argument("--source-sha", required=True)
    prepare.add_argument("--rebuilt", type=Path, required=True)
    prepare.add_argument("--existing-dir", type=Path, required=True)
    prepare.add_argument("--github-output", type=Path, required=True)
    channel = commands.add_parser("advance-channel", help="Advance stack-channel over the deploy key")
    channel.add_argument("--repo", required=True)
    channel.add_argument("--source-sha", required=True)
    channel.add_argument("--snapshot", type=Path, required=True)
    channel.add_argument("--deploy-key-env", required=True)
    channel.add_argument("--temp-dir", type=Path, required=True)
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
        if args.command == "release-state":
            sys.stdout.write(f"{release_state(args.existing, args.rebuilt)}\n")
        elif args.command == "tag-target":
            verify_tag_target(json.loads(args.ref.read_bytes()), args.source_sha)
        elif args.command == "prepare-release":
            state = prepare_release(args.repo, args.source_sha, args.rebuilt, args.existing_dir)
            args.github_output.write_text(f"state={state}\n")
        else:
            advance_channel(
                args.repo,
                args.source_sha,
                args.snapshot,
                os.environ.get(args.deploy_key_env, ""),
                args.temp_dir,
            )
    except (ValueError, OSError, PublishError, json.JSONDecodeError) as error:
        sys.stderr.write(f"FAILED: {error}\n")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
