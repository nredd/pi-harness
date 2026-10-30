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
        raise ValueError("The existing release snapshot differs from the rebuilt one; refusing. Investigate")
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
    repo: str, source_sha: str, rebuilt: Path, existing_dir: Path, dependency_graph: Path | None = None
) -> Literal["create", "resume"]:
    """Validate an existing tag before any new attestation or release is created.

    Parameters:
        repo (str): GitHub owner/repository.
        source_sha (str): selected commit.
        rebuilt (Path): rebuilt candidate snapshot.
        existing_dir (Path): destination for a retained release asset.
        dependency_graph (Path | None): required supplemental candidate for new-format publication;
            `None` retains the library's snapshot-only comparison for historical evidence callers.

    Returns:
        Literal["create", "resume"]: whether publication creates or resumes the immutable release.

    Raises:
        PublishError: GitHub could not answer, or the tag exists without a snapshot release asset.
        ValueError: an existing tag is annotated or points at another commit, or its asset differs.
    """
    if dependency_graph is not None and not dependency_graph.is_file():
        raise PublishError("Required candidate dependency-graph.json is missing; publication refused")
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
    state = release_state(existing_dir / "stack-snapshot.json", rebuilt)
    if dependency_graph is not None:
        if not any(
            isinstance(asset, dict) and asset.get("name") == "dependency-graph.json" for asset in assets
        ):
            raise PublishError(
                f"Tag '{tag}' lacks dependency-graph.json; legacy promotions cannot be upgraded"
            )
        _command(
            "gh",
            "release",
            "download",
            tag,
            "--repo",
            repo,
            "--pattern",
            "dependency-graph.json",
            "--dir",
            str(existing_dir),
            "--clobber",
        )
        if release_state(existing_dir / "dependency-graph.json", dependency_graph) != "resume":
            raise PublishError("Existing dependency graph was not downloaded")
    return state


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


def _parser() -> argparse.ArgumentParser:
    """Build the subcommand parser.

    Returns:
        argparse.ArgumentParser: parser for the release and tag gates.
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
    prepare.add_argument("--dependency-graph", type=Path, required=True)
    prepare.add_argument("--github-output", type=Path, required=True)
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
        else:
            state = prepare_release(
                args.repo, args.source_sha, args.rebuilt, args.existing_dir, args.dependency_graph
            )
            args.github_output.write_text(f"state={state}\n")
    except (ValueError, OSError, PublishError, json.JSONDecodeError) as error:
        sys.stderr.write(f"FAILED: {error}\n")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
