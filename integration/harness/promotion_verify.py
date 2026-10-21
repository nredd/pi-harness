"""Single entry point for the read-only `verify` job of `promote-stack.yml`.

The workflow passes every input through `env:` and runs `python -m harness.promotion_verify`;
all fetching and every `git`/`gh` call happens here, so the YAML carries no shell logic.

Environment:
- `OPERATION`, `REQUESTED_SHA`, `ROLLBACK_TAG`: the dispatch inputs.
- `GITHUB_REPOSITORY`, `GITHUB_WORKSPACE`, `GITHUB_OUTPUT`, `RUNNER_TEMP`: runner context.
- `PROMO`: directory for the evidence files and the candidate `stack-snapshot.json`.

References:
- https://cli.github.com/manual/gh_attestation_verify
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

from harness import promotion
from harness.promotion import (
    EvidenceError,
    GateEvidence,
    PromotionError,
    StackSnapshot,
    build_gates,
    build_snapshot,
    candidate_run_ids,
    channel_exists,
    collect_owned_evidence,
    descends_from,
    flatten_pages,
    registry_stack_runs,
    required_checks,
    select_source_sha,
    verify_core,
    verify_required_checks,
    verify_successor,
)
from harness.stack import Stack

if TYPE_CHECKING:
    from collections.abc import Mapping

STABLE_FILE = "stable.json"
SNAPSHOT_FILE = "stack-snapshot.json"
SIGNER_WORKFLOW = ".github/workflows/promote-stack.yml"


@dataclass(frozen=True)
class VerifyContext:
    """Resolved runner context for one verification.

    Parameters:
        operation (str): `verify-only`, `promote` or `rollback`.
        requested_sha (str): `source_sha` input.
        rollback_tag (str): `rollback_tag` input.
        repo (str): GitHub owner/repository.
        workspace (Path): checkout of `main`.
        github_output (Path): `$GITHUB_OUTPUT` file.
        temp (Path): runner temporary directory.
        promo (Path): evidence directory.
    """

    operation: str
    requested_sha: str
    rollback_tag: str
    repo: str
    workspace: Path
    github_output: Path
    temp: Path
    promo: Path

    @classmethod
    def from_env(cls, env: Mapping[str, str]) -> VerifyContext:
        """Read the context from the workflow environment.

        Parameters:
            env (Mapping[str, str]): process environment.

        Returns:
            VerifyContext: the resolved context.

        Raises:
            ValueError: a required variable is unset.
        """
        missing = [
            name
            for name in ("OPERATION", "GITHUB_REPOSITORY", "GITHUB_WORKSPACE", "GITHUB_OUTPUT", "PROMO")
            if not env.get(name)
        ]
        if missing:
            raise ValueError(f"Missing environment: {', '.join(missing)}")
        return cls(
            operation=env["OPERATION"],
            requested_sha=env.get("REQUESTED_SHA", ""),
            rollback_tag=env.get("ROLLBACK_TAG", ""),
            repo=env["GITHUB_REPOSITORY"],
            workspace=Path(env["GITHUB_WORKSPACE"]),
            github_output=Path(env["GITHUB_OUTPUT"]),
            temp=Path(env.get("RUNNER_TEMP") or tempfile.gettempdir()),
            promo=Path(env["PROMO"]),
        )


def run_tool(*args: str) -> str:
    """Run one `git`/`gh` command with captured diagnostics.

    Parameters:
        *args (str): literal executable and arguments.

    Returns:
        str: stdout.

    Raises:
        EvidenceError: the command could not run or exited nonzero.
    """
    try:
        return subprocess.run(args, capture_output=True, text=True, check=True).stdout
    except (OSError, subprocess.CalledProcessError) as error:
        detail = error.stderr.strip() if isinstance(error, subprocess.CalledProcessError) else str(error)
        raise EvidenceError(f"Command failed: {' '.join(args[:3])}: {detail}") from error


def gh_json(path: str, destination: Path) -> None:
    """Save a paginated, slurped `gh api` response.

    Parameters:
        path (str): API path, optionally with a query.
        destination (Path): output file.

    Raises:
        EvidenceError: `gh` failed.
    """
    destination.write_text(run_tool("gh", "api", "--paginate", "--slurp", path))


def attest(path: Path, ctx: VerifyContext) -> None:
    """Verify a file's attestation from this repository's promotion workflow on `main`.

    Parameters:
        path (Path): file to verify.
        ctx (VerifyContext): runner context.

    Raises:
        EvidenceError: attestation verification failed.
    """
    run_tool(
        "gh",
        "attestation",
        "verify",
        str(path),
        "--repo",
        ctx.repo,
        "--signer-workflow",
        f"{ctx.repo}/{SIGNER_WORKFLOW}",
        "--source-ref",
        "refs/heads/main",
        "--deny-self-hosted-runners",
    )


def verify_retained_snapshot(ctx: VerifyContext, source_sha: str) -> None:
    """Download and verify the snapshot retained for a rollback.

    Parameters:
        ctx (VerifyContext): runner context.
        source_sha (str): commit the rollback tag names.

    Raises:
        EvidenceError: download or attestation failed.
        ValueError: the snapshot is invalid or names another commit.
    """
    run_tool(
        "gh",
        "release",
        "download",
        ctx.rollback_tag,
        "--repo",
        ctx.repo,
        "--pattern",
        SNAPSHOT_FILE,
        "--dir",
        str(ctx.promo),
        "--clobber",
    )
    snapshot = ctx.promo / SNAPSHOT_FILE
    attest(snapshot, ctx)
    parsed = StackSnapshot.model_validate_json(snapshot.read_bytes())
    if parsed.source_sha != source_sha:
        raise ValueError(f"Snapshot source '{parsed.source_sha}' differs from '{source_sha}'")


def fetch_stack_runs(ctx: VerifyContext, source_sha: str) -> list[int]:
    """Read the CI runs and artifact pages for the selected commit and qualify runs.

    Parameters:
        ctx (VerifyContext): runner context.
        source_sha (str): selected commit.

    Returns:
        list[int]: qualifying run IDs.

    Raises:
        EvidenceError: GitHub could not provide the evidence.
        ValueError: no run qualifies or a response is malformed.
    """
    runs = json.loads(
        run_tool(
            "gh", "run", "list",
            "--repo", ctx.repo,
            "--workflow", "ci.yml",
            "--commit", source_sha,
            "--limit", "100",
            "--json", "databaseId,status,conclusion,event,headBranch,headSha",
        )
    )  # fmt: skip
    entries = flatten_pages([runs])
    artifacts = {
        str(run_id): json.loads(
            run_tool(
                "gh",
                "api",
                "--paginate",
                "--slurp",
                f"repos/{ctx.repo}/actions/runs/{run_id}/artifacts?per_page=100",
            )
        )
        for run_id in candidate_run_ids(entries, source_sha)
    }
    return registry_stack_runs(entries, artifacts, source_sha)


def build_candidate(ctx: VerifyContext, source_sha: str) -> None:
    """Verify every gate for the commit and write the candidate snapshot.

    Parameters:
        ctx (VerifyContext): runner context.
        source_sha (str): selected commit.

    Raises:
        PromotionError: a gate failed.
        ValueError: evidence is malformed or insufficient.
    """
    rules = json.loads(
        run_tool("gh", "api", "--paginate", "--slurp", f"repos/{ctx.repo}/rules/branches/main")
    )
    pages = json.loads(
        run_tool(
            "gh", "api", "--paginate", "--slurp",
            f"repos/{ctx.repo}/commits/{source_sha}/check-runs?per_page=100",
        )
    )  # fmt: skip
    checks = verify_required_checks(required_checks(flatten_pages(rules)), flatten_pages(pages), source_sha)
    stack_runs = fetch_stack_runs(ctx, source_sha)
    stack_path = ctx.promo / "personal.json"
    stack_path.write_text(
        run_tool(
            promotion.GIT_BIN,
            "-C",
            str(ctx.workspace),
            "show",
            f"{source_sha}:integration/stacks/personal.json",
        )
    )
    stack = Stack.model_validate_json(stack_path.read_bytes())
    core = verify_core(stack, ctx.temp / "core")
    owned = collect_owned_evidence(stack, ctx.workspace, ctx.temp / "packages")
    gates: GateEvidence = build_gates(stack, checks, stack_runs, owned, core)
    snapshot = build_snapshot(stack_path, source_sha, gates)
    (ctx.promo / SNAPSHOT_FILE).write_bytes(
        json.dumps(snapshot.model_dump(mode="json"), sort_keys=True, separators=(",", ":")).encode()
    )


def check_successor(ctx: VerifyContext) -> None:
    """Gate the candidate against the attested stable pointer; a missing channel is the seed.

    Parameters:
        ctx (VerifyContext): runner context.

    Raises:
        EvidenceError: GitHub or attestation failed.
        PromotionError: Git ancestry failed.
        ValueError: the candidate is not a successor.
    """
    refs = json.loads(
        run_tool(
            "gh", "api", "--paginate", "--slurp", f"repos/{ctx.repo}/git/matching-refs/heads/stack-channel"
        )
    )
    candidate = StackSnapshot.model_validate_json((ctx.promo / SNAPSHOT_FILE).read_bytes())
    stable = None
    if channel_exists(refs):
        stable_path = ctx.promo / STABLE_FILE
        stable_path.write_text(
            run_tool(
                "gh", "api", "-H", "Accept: application/vnd.github.raw+json",
                f"repos/{ctx.repo}/contents/{STABLE_FILE}?ref=stack-channel",
            )
        )  # fmt: skip
        attest(stable_path, ctx)
        stable = StackSnapshot.model_validate_json(stable_path.read_bytes())
    descends = stable is not None and descends_from(ctx.workspace, stable.source_sha, candidate.source_sha)
    verify_successor(candidate, stable, descends)


def verify(ctx: VerifyContext) -> str:
    """Run the whole read-only verification for one dispatch.

    Parameters:
        ctx (VerifyContext): runner context.

    Returns:
        str: the selected source SHA, also written to `$GITHUB_OUTPUT`.

    Raises:
        PromotionError: a gate failed.
        ValueError: inputs or evidence are invalid.
    """
    ctx.promo.mkdir(parents=True, exist_ok=True)
    source_sha = select_source_sha(ctx.operation, ctx.requested_sha, ctx.rollback_tag)
    with ctx.github_output.open("a") as output:
        output.write(f"source_sha={source_sha}\n")
    run_tool(promotion.GIT_BIN, "-C", str(ctx.workspace), "fetch", "origin", "main")
    if not descends_from(ctx.workspace, source_sha, "origin/main"):
        raise ValueError(f"'{source_sha}' is not an ancestor of 'origin/main'")
    if ctx.operation == "rollback":
        verify_retained_snapshot(ctx, source_sha)
        return source_sha
    build_candidate(ctx, source_sha)
    check_successor(ctx)
    return source_sha


def main(env: Mapping[str, str] | None = None) -> int:
    """Run the verification; refusals exit 1 with a one-line error.

    Parameters:
        env (Mapping[str, str] | None): environment, or the process environment.

    Returns:
        int: 0 on success, 1 on a failed gate.
    """
    try:
        verify(VerifyContext.from_env(os.environ if env is None else env))
    except (ValueError, OSError, PromotionError) as error:
        sys.stderr.write(f"FAILED: {error}\n")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
