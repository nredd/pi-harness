"""Single entry point for the read-only `verify` job of `promote-stack.yml`.

The workflow passes every input through `env:` and runs `python -m harness.promotion_verify`;
all fetching and every `git`/`gh` call happens here, so the YAML carries no shell logic.

Environment:
- `OPERATION`, `REQUESTED_SHA`: the dispatch inputs.
- `GITHUB_REPOSITORY`, `GITHUB_WORKSPACE`, `GITHUB_OUTPUT`, `RUNNER_TEMP`: runner context.
- `PROMO`: directory for the evidence files and the candidate `stack-snapshot.json`.
"""

from __future__ import annotations

import json
import logging
import os
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

from harness import promotion
from harness.promotion import (
    EvidenceError,
    GateEvidence,
    GitError,
    PromotionError,
    build_gates,
    build_snapshot,
    candidate_run_ids,
    collect_owned_evidence,
    descends_from,
    flatten_pages,
    registry_stack_runs,
    required_checks,
    run_command,
    select_source_sha,
    verify_core,
    verify_required_checks,
)
from harness.release_gate import require_full_verification
from harness.stack import Stack

if TYPE_CHECKING:
    from collections.abc import Mapping

SNAPSHOT_FILE = "stack-snapshot.json"


LOGGER = logging.getLogger(__name__)


@dataclass(frozen=True)
class VerifyContext:
    """Resolved runner context for one verification.

    Parameters:
        operation (str): `verify-only` or `promote`.
        requested_sha (str): `source_sha` input.
        repo (str): GitHub owner/repository.
        workspace (Path): checkout of `main`.
        github_output (Path): `$GITHUB_OUTPUT` file.
        temp (Path): runner temporary directory.
        promo (Path): evidence directory.
    """

    operation: str
    requested_sha: str
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
            repo=env["GITHUB_REPOSITORY"],
            workspace=Path(env["GITHUB_WORKSPACE"]),
            github_output=Path(env["GITHUB_OUTPUT"]),
            temp=Path(env.get("RUNNER_TEMP") or tempfile.gettempdir()),
            promo=Path(env["PROMO"]),
        )


def gh_json(path: str) -> object:
    """Read a paginated, slurped `gh api` response.

    Parameters:
        path (str): API path, optionally with a query.

    Returns:
        object: the decoded pages.

    Raises:
        EvidenceError: `gh` failed or printed non-JSON.
    """
    try:
        return json.loads(run_command("gh", "api", "--paginate", "--slurp", path).stdout)
    except json.JSONDecodeError as error:
        raise EvidenceError(f"Unreadable response from gh api {path}: {error}") from error


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
    listed = run_command(
        "gh", "run", "list",
        "--repo", ctx.repo,
        "--workflow", "ci.yml",
        "--commit", source_sha,
        "--limit", "100",
        "--json", "databaseId,status,conclusion,event,headBranch,headSha",
    )  # fmt: skip
    entries = flatten_pages([json.loads(listed.stdout)])
    artifacts = {
        str(run_id): gh_json(f"repos/{ctx.repo}/actions/runs/{run_id}/artifacts?per_page=100")
        for run_id in candidate_run_ids(entries, source_sha)
    }
    return registry_stack_runs(entries, artifacts, source_sha)


def override_stack_runs(ctx: VerifyContext, source_sha: str) -> list[int]:
    """List every push/main CI run of the commit, whatever its conclusion, for an owner override.

    Parameters:
        ctx (VerifyContext): runner context.
        source_sha (str): selected commit.

    Returns:
        list[int]: sorted run IDs recorded as (waived) stack evidence.

    Raises:
        ValueError: no CI run exists for the commit at all.
    """
    listed = run_command(
        "gh", "run", "list",
        "--repo", ctx.repo,
        "--workflow", "ci.yml",
        "--commit", source_sha,
        "--limit", "100",
        "--json", "databaseId,event,headBranch,headSha,conclusion",
    )  # fmt: skip
    runs = [
        run for run in json.loads(listed.stdout)
        if run.get("event") == "push" and run.get("headBranch") == "main" and run.get("headSha") == source_sha
    ]  # fmt: skip
    if not runs:
        raise ValueError(f"OWNER OVERRIDE still needs a push/main CI run for '{source_sha}'")
    for run in runs:
        LOGGER.warning(
            f"OWNER OVERRIDE records CI run {run['databaseId']} with conclusion {run.get('conclusion')!r}"
        )
    return sorted(int(run["databaseId"]) for run in runs)


def build_candidate(ctx: VerifyContext, source_sha: str) -> None:
    """Verify every gate for the commit and write the candidate snapshot.

    Parameters:
        ctx (VerifyContext): runner context.
        source_sha (str): selected commit.

    Raises:
        PromotionError: a gate failed.
        ValueError: evidence is malformed or insufficient.
    """
    full_run = require_full_verification(ctx.repo, source_sha)
    rules = gh_json(f"repos/{ctx.repo}/rules/branches/main")
    pages = gh_json(f"repos/{ctx.repo}/commits/{source_sha}/check-runs?per_page=100")
    required = required_checks(flatten_pages(rules))
    if ctx.operation == "owner-override":
        checks = sorted(check.context for check in required)
        try:
            verify_required_checks(required, flatten_pages(pages), source_sha)
        except ValueError as waived:
            LOGGER.warning(f"OWNER OVERRIDE waives required checks: {waived}")
        stack_runs = override_stack_runs(ctx, source_sha)
    else:
        checks = verify_required_checks(required, flatten_pages(pages), source_sha)
        # Record the actual full dispatch, not the selective push/main smoke.
        stack_runs = [full_run]
    stack_path = ctx.promo / "personal.json"
    stack_path.write_text(
        run_command(
            promotion.GIT_BIN,
            "-C",
            str(ctx.workspace),
            "show",
            f"{source_sha}:integration/stacks/personal.json",
        ).stdout
    )
    stack = Stack.model_validate_json(stack_path.read_bytes())
    core = verify_core(stack, ctx.temp / "core")
    owned = collect_owned_evidence(stack, ctx.workspace, ctx.temp / "packages")
    gates: GateEvidence = build_gates(stack, checks, stack_runs, owned, core)
    snapshot = build_snapshot(stack_path, source_sha, gates)
    (ctx.promo / SNAPSHOT_FILE).write_bytes(
        json.dumps(snapshot.model_dump(mode="json"), sort_keys=True, separators=(",", ":")).encode()
    )


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
    source_sha = select_source_sha(ctx.operation, ctx.requested_sha)
    with ctx.github_output.open("a") as output:
        output.write(f"source_sha={source_sha}\n")
    # The repository is public, so this credential-less fetch (`persist-credentials: false`) works.
    run_command(promotion.GIT_BIN, "-C", str(ctx.workspace), "fetch", "origin", "main", error=GitError)
    if not descends_from(ctx.workspace, source_sha, "origin/main"):
        raise ValueError(f"'{source_sha}' is not an ancestor of 'origin/main'")
    build_candidate(ctx, source_sha)
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
