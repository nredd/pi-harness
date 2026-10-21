"""Build and verify attested promoted-stack snapshots.

References:
- https://docs.github.com/rest/repos/rules#get-rules-for-a-branch
- https://docs.github.com/actions/security-for-github-actions/using-artifact-attestations/using-artifact-attestations-to-establish-provenance-for-builds
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

from harness.release import release_checksums
from harness.stack import Stack, validate_release_identity

SNAPSHOT_SCHEMA_VERSION = 1
SHA256_HEX_LENGTH = 64
GIT_SHA_LENGTH = 40
PERSONAL_STACK_JOB = re.compile(r"stack \(.+, personal\)")
PERSONAL_STACK_ARTIFACT = "stack-ubuntu-24.04-personal"
SHA_PATTERN = re.compile(rf"[0-9a-f]{{{GIT_SHA_LENGTH}}}")
ROLLBACK_TAG_PATTERN = re.compile(rf"stack/([0-9a-f]{{{GIT_SHA_LENGTH}}})")
OPERATIONS = ("verify-only", "promote", "rollback")
GIT_BIN = "/usr/bin/git"
STACK_CHECK_TIMEOUT = 900
STRICT = ConfigDict(extra="forbid", strict=True, frozen=True)


class PromotionError(Exception):
    """An external tool or service a gate depends on failed (distinct from a refused gate)."""


class GitError(PromotionError):
    """Git could not answer a question about the checkout."""


class EvidenceError(PromotionError):
    """A per-package evidence check could not run or produced unusable output."""


class OwnedPackageEvidence(BaseModel):
    """Registry integrity of one verified `@nredd/` package version."""

    model_config = STRICT
    package: str = Field(
        pattern=r"^@nredd/[a-z0-9-]+@[0-9]+\.[0-9]+\.[0-9]+(?:-[\w.-]+)?$",
        description="Exact npm package and version",
    )
    integrity: str = Field(
        pattern=r"^sha512-[A-Za-z0-9+/]{86}==$", description="Verified npm SHA-512 integrity"
    )


class CoreEvidence(BaseModel):
    """Verified core release identity: its tag and asset digests."""

    model_config = STRICT
    tag: str = Field(pattern=r"^v[0-9]+\.[0-9]+\.[0-9]+-nredd\.[0-9]+$", description="Exact core release tag")
    integrity: dict[str, str] = Field(min_length=1, description="Verified asset filename to SHA-256 mapping")

    @model_validator(mode="after")
    def validate_integrity(self) -> Self:
        """Reject incomplete or ambiguous core asset evidence.

        Returns:
            Self: the validated evidence.

        Raises:
            ValueError: an asset is not a tarball name or a digest is not lowercase SHA-256.
        """
        if any("/" in name or not name.endswith(".tgz") for name in self.integrity) or any(
            len(digest) != SHA256_HEX_LENGTH or any(char not in "0123456789abcdef" for char in digest)
            for digest in self.integrity.values()
        ):
            raise ValueError("`core.integrity` must contain tarball names and lowercase SHA-256 digests")
        return self


class GateEvidence(BaseModel):
    """Every gate a snapshot's source commit passed."""

    model_config = STRICT
    required_checks: list[str] = Field(min_length=1, description="Configured checks completed successfully")
    stack_run_ids: list[int] = Field(
        min_length=1, description="Successful push/main registry-stack CI run IDs"
    )
    owned_packages: list[OwnedPackageEvidence] = Field(
        min_length=1, description="Verified owned npm subjects"
    )
    core: CoreEvidence = Field(description="Verified core release assets")

    @model_validator(mode="after")
    def validate_unique_evidence(self) -> Self:
        """Reject duplicated or malformed evidence.

        Returns:
            Self: the validated evidence.

        Raises:
            ValueError: checks, run IDs or packages are duplicated, empty, or non-positive.
        """
        if len(self.required_checks) != len(set(self.required_checks)) or not all(
            item.strip() for item in self.required_checks
        ):
            raise ValueError("`required_checks` must contain unique nonempty names")
        if len(self.stack_run_ids) != len(set(self.stack_run_ids)) or any(
            item <= 0 for item in self.stack_run_ids
        ):
            raise ValueError("`stack_run_ids` must contain unique positive workflow run IDs")
        packages = [item.package for item in self.owned_packages]
        if len(packages) != len(set(packages)):
            raise ValueError("`owned_packages` must contain unique exact package versions")
        return self


class StackSnapshot(BaseModel):
    """The promoted deployment state: one personal stack plus the evidence that gated it."""

    model_config = STRICT
    schema_version: Literal[1] = Field(description="Snapshot schema version")
    source_sha: str = Field(pattern=rf"^[0-9a-f]{{{GIT_SHA_LENGTH}}}$", description="Selected main commit")
    stack_sha256: str = Field(
        pattern=rf"^[0-9a-f]{{{SHA256_HEX_LENGTH}}}$", description="Canonical stack JSON SHA-256"
    )
    stack: Stack = Field(description="Canonical authoritative personal stack")
    gates: GateEvidence = Field(description="Verified promotion gate evidence")

    @model_validator(mode="after")
    def validate_snapshot(self) -> Self:
        """Require a personal stack, a matching canonical digest, and matching core evidence.

        Returns:
            Self: the validated snapshot.

        Raises:
            ValueError: the stack is not `personal`, the digest differs, or core evidence disagrees.
        """
        if self.stack.name != "personal":
            raise ValueError("Promoted snapshots must contain the `personal` stack")
        if self.stack_sha256 != stack_bytes(self.stack).sha256:
            raise ValueError("`stack_sha256` does not match canonical `stack` bytes")
        if (
            self.gates.core.tag != self.stack.core.tag
            or self.gates.core.integrity != self.stack.core.integrity
        ):
            raise ValueError("Core gate evidence does not match the promoted stack identity")
        return self


@dataclass(frozen=True)
class CanonicalStack:
    """Canonical serialized stack bytes and their SHA-256 digest."""

    contents: bytes
    sha256: str


def stack_bytes(stack: Stack) -> CanonicalStack:
    """Serialize a stack using the sole snapshot digest representation.

    Parameters:
        stack (Stack): the validated stack.

    Returns:
        CanonicalStack: compact sorted UTF-8 JSON and its SHA-256.
    """
    contents = json.dumps(stack.model_dump(mode="json"), sort_keys=True, separators=(",", ":")).encode(
        "utf-8"
    )
    return CanonicalStack(contents, hashlib.sha256(contents).hexdigest())


def build_snapshot(stack_path: Path, source_sha: str, gates: GateEvidence) -> StackSnapshot:
    """Build a fail-closed snapshot from the selected authoritative stack.

    Parameters:
        stack_path (Path): the selected commit's `personal.json`.
        source_sha (str): the selected `main` commit.
        gates (GateEvidence): verified gate evidence.

    Returns:
        StackSnapshot: the validated snapshot.

    Raises:
        pydantic.ValidationError: the stack or any snapshot field is invalid.
    """
    stack = Stack.model_validate_json(stack_path.read_bytes())
    canonical = stack_bytes(stack)
    return StackSnapshot(
        schema_version=1, source_sha=source_sha, stack_sha256=canonical.sha256, stack=stack, gates=gates
    )


def flatten_pages(value: object) -> list[Any]:
    """Flatten `gh api --paginate --slurp` output into one list of page items.

    Parameters:
        value (object): decoded slurp output, a list of pages (each a list or an object).

    Returns:
        list[Any]: every element of list pages, plus every object page as-is.

    Raises:
        ValueError: the value is not a list, or a page is neither a list nor an object.
    """
    if not isinstance(value, list):
        raise ValueError("Expected a JSON array of API pages")
    flat: list[Any] = []
    for page in value:
        if isinstance(page, list):
            flat.extend(page)
        elif isinstance(page, dict):
            flat.append(page)
        else:
            raise ValueError("Expected each API page to be a JSON array or object")
    return flat


@dataclass(frozen=True)
class RequiredCheck:
    """One required status check and the app that must report it."""

    context: str
    integration_id: int | None


def required_checks(rules: list[Any]) -> list[RequiredCheck]:
    """Collect the required status checks from the branch rules API.

    Parameters:
        rules (list[Any]): flattened `GET /rules/branches/main` rules (readable by `GITHUB_TOKEN`).

    Returns:
        list[RequiredCheck]: unique checks sorted by context.

    Raises:
        ValueError: the rules yield no check, or a rule is malformed.
    """
    found: dict[str, RequiredCheck] = {}
    for rule in rules:
        if not isinstance(rule, dict) or rule.get("type") != "required_status_checks":
            continue
        parameters = rule.get("parameters")
        entries = parameters.get("required_status_checks") if isinstance(parameters, dict) else None
        if not isinstance(entries, list):
            raise ValueError("Required-status-checks rule has malformed parameters")
        for entry in entries:
            check = _check(entry)
            if found.setdefault(check.context, check) != check:
                raise ValueError(f"Required check '{check.context}' is configured with conflicting apps")
    if not found:
        raise ValueError(
            "The `main` rules API lists no required status checks; they must live in a ruleset "
            "(`GET /repos/{owner}/{repo}/rules/branches/main`), not classic branch protection"
        )
    return sorted(found.values(), key=lambda item: item.context)


def _check(entry: object) -> RequiredCheck:
    """Return one validated required check.

    Parameters:
        entry (object): one `required_status_checks` entry.

    Returns:
        RequiredCheck: the nonempty context and optional app ID.

    Raises:
        ValueError: the entry has no string `context` or a non-integer `integration_id`.
    """
    if not isinstance(entry, dict):
        raise ValueError("Required-status-checks entry has an invalid `context`")
    context = entry.get("context")
    if not isinstance(context, str) or not context:
        raise ValueError("Required-status-checks entry has an invalid `context`")
    integration_id = entry.get("integration_id")
    if integration_id is not None and (
        not isinstance(integration_id, int) or isinstance(integration_id, bool)
    ):
        raise ValueError(f"Required check '{context}' has an invalid `integration_id`")
    return RequiredCheck(context, integration_id)


def verify_required_checks(
    required: list[RequiredCheck], check_pages: list[Any], source_sha: str
) -> list[str]:
    """Require every configured check to have succeeded on the exact selected commit.

    When a rule names an `integration_id`, the reporting check run's `app.id` must equal it, so
    another app cannot satisfy the check by reusing its name.

    Parameters:
        required (list[RequiredCheck]): configured checks.
        check_pages (list[Any]): `commits/<sha>/check-runs` pages.
        source_sha (str): selected commit.

    Returns:
        list[str]: the required contexts, sorted.

    Raises:
        ValueError: a required check is missing, failed, or came from the wrong app, or a page is malformed.
    """
    runs: list[dict[str, Any]] = []
    for page in check_pages:
        entries = page.get("check_runs") if isinstance(page, dict) else None
        if not isinstance(entries, list):
            raise ValueError("Check-runs page has no `check_runs` list")
        runs.extend(run for run in entries if isinstance(run, dict))
    missing = [
        check.context
        for check in required
        if not any(
            run.get("name") == check.context
            and run.get("head_sha") == source_sha
            and run.get("status") == "completed"
            and run.get("conclusion") == "success"
            and (check.integration_id is None or _app_id(run) == check.integration_id)
            for run in runs
        )
    ]
    if missing:
        raise ValueError(f"Required checks did not succeed on '{source_sha}': {', '.join(missing)}")
    return sorted(check.context for check in required)


def _app_id(run: dict[str, Any]) -> object:
    """Return the ID of the app that reported a check run.

    Parameters:
        run (dict[str, Any]): one check run.

    Returns:
        object: `app.id`, or `None` when absent.
    """
    app = run.get("app")
    return app.get("id") if isinstance(app, dict) else None


def _has_live_stack_artifact(pages: object, run_id: int, source_sha: str) -> bool:
    """Report whether a run uploaded the personal stack artifact and it is still downloadable.

    Parameters:
        pages (object): `actions/runs/<id>/artifacts` slurped pages.
        run_id (int): the run being checked.
        source_sha (str): selected commit.

    Returns:
        bool: whether a non-expired `PERSONAL_STACK_ARTIFACT` from this run and commit exists.

    Raises:
        ValueError: the artifact pages are malformed.
    """
    if not isinstance(pages, list):
        raise ValueError("Artifact response must be a list of API pages")
    for page in pages:
        entries = page.get("artifacts") if isinstance(page, dict) else None
        if not isinstance(entries, list):
            raise ValueError("Artifact page has no `artifacts` list")
        for artifact in entries:
            origin = artifact.get("workflow_run") if isinstance(artifact, dict) else None
            if (
                isinstance(origin, dict)
                and artifact.get("name") == PERSONAL_STACK_ARTIFACT
                and artifact.get("expired") is False
                and origin.get("id") == run_id
                and origin.get("head_sha") == source_sha
            ):
                return True
    return False


def _is_main_push_success(run: dict[str, Any], source_sha: str) -> bool:
    """Report whether a CI run is a completed, successful push to `main` of the selected commit.

    Parameters:
        run (dict[str, Any]): one `gh run list --json` entry.
        source_sha (str): selected commit.

    Returns:
        bool: whether the run is a candidate for stack evidence.
    """
    return (
        isinstance(run.get("databaseId"), int)
        and run.get("event") == "push"
        and run.get("headBranch") == "main"
        and run.get("headSha") == source_sha
        and run.get("status") == "completed"
        and run.get("conclusion") == "success"
    )


def candidate_run_ids(runs: list[dict[str, Any]], source_sha: str) -> list[int]:
    """List the CI runs worth fetching jobs and artifacts for.

    Parameters:
        runs (list[dict[str, Any]]): `gh run list --json` entries.
        source_sha (str): selected commit.

    Returns:
        list[int]: sorted IDs of successful push/main runs of the selected commit.
    """
    return sorted(run["databaseId"] for run in runs if _is_main_push_success(run, source_sha))


def registry_stack_runs(
    runs: list[dict[str, Any]],
    jobs_by_run: dict[str, dict[str, Any]],
    artifacts_by_run: dict[str, Any],
    source_sha: str,
) -> list[int]:
    """Return successful push/main CI runs that really executed the personal stack scenario.

    Only `event=push`, `branch=main` runs count. Job conclusions alone prove nothing: a docs-only
    or main-push-smoke cell still reports its job as `success` after skipping every step. The
    machine signal is the `PERSONAL_STACK_ARTIFACT` upload, which `ci.yml` makes only when the
    scenario ran (`steps.plan.outputs.run == 'true'`), plus a successful job matching
    `PERSONAL_STACK_JOB` so a scenario failure still disqualifies the run. No step or job
    display text beyond the matrix name pattern is used.

    Parameters:
        runs (list[dict[str, Any]]): `gh run list --json` entries.
        jobs_by_run (dict[str, dict[str, Any]]): run ID -> `gh run view --json jobs` output.
        artifacts_by_run (dict[str, Any]): run ID -> slurped `actions/runs/<id>/artifacts` pages.
        source_sha (str): selected commit.

    Returns:
        list[int]: sorted qualifying run IDs.

    Raises:
        ValueError: no run qualifies, or an artifact response is malformed.
    """
    verified: list[int] = []
    for run_id in candidate_run_ids(runs, source_sha):
        jobs = jobs_by_run.get(str(run_id), {}).get("jobs", [])
        if not any(
            isinstance(job, dict)
            and PERSONAL_STACK_JOB.fullmatch(str(job.get("name", "")))
            and job.get("status") == "completed"
            and job.get("conclusion") == "success"
            for job in jobs
        ):
            continue
        if _has_live_stack_artifact(artifacts_by_run.get(str(run_id), []), run_id, source_sha):
            verified.append(run_id)
    if not verified:
        raise ValueError(
            f"No successful push/main CI run with a passing personal stack job and a live "
            f"'{PERSONAL_STACK_ARTIFACT}' artifact found for '{source_sha}'; docs-only SHAs and "
            "runs whose artifacts expired cannot be promoted"
        )
    return sorted(verified)


def owned_tags(stack: Stack) -> list[str]:
    """Return the exact package release tags of every owned npm source in a stack.

    Parameters:
        stack (Stack): the selected personal stack.

    Returns:
        list[str]: `@nredd/<name>@<version>` tags, in stack order.
    """
    sources = [item if isinstance(item, str) else item.source for item in stack.sources]
    return [item.removeprefix("npm:") for item in sources if item.startswith("npm:@nredd/")]


def build_gates(
    stack: Stack,
    required_checks: list[str],
    run_ids: list[int],
    owned: list[OwnedPackageEvidence],
    core: CoreEvidence,
) -> GateEvidence:
    """Assemble gate evidence, requiring owned evidence to cover exactly the stack's owned sources.

    Parameters:
        stack (Stack): selected personal stack.
        required_checks (list[str]): verified check names.
        run_ids (list[int]): qualifying CI run IDs; only the earliest is kept so a rebuild is stable.
        owned (list[OwnedPackageEvidence]): per-package npm evidence from `stack-check`.
        core (CoreEvidence): verified core release.

    Returns:
        GateEvidence: validated evidence.

    Raises:
        ValueError: evidence is missing, extra, or empty.
    """
    expected = set(owned_tags(stack))
    if not run_ids:
        raise ValueError("No registry-stack CI run evidence")
    if {item.package for item in owned} != expected:
        raise ValueError("Owned package evidence does not match the stack's `@nredd/` sources exactly")
    return GateEvidence(
        required_checks=required_checks,
        stack_run_ids=[min(run_ids)],
        owned_packages=sorted(owned, key=lambda item: item.package),
        core=core,
    )


def verify_core(stack: Stack) -> CoreEvidence:
    """Verify the stack's core asset digests against the release's checksum file.

    CI's registry-stack job separately fetched this release with `gh attestation verify`.

    Parameters:
        stack (Stack): selected personal stack.

    Returns:
        CoreEvidence: tag and asset digests that agree with the published release.

    Raises:
        ValueError: the release checksums are unreadable or disagree.
    """
    validate_release_identity(stack, stack.core.tag, release_checksums(stack.core.tag))
    return CoreEvidence(tag=stack.core.tag, integrity=dict(stack.core.integrity))


def select_source_sha(operation: str, requested_sha: str, rollback_tag: str) -> str:
    """Validate dispatch inputs and return the selected source SHA.

    Parameters:
        operation (str): `verify-only`, `promote` or `rollback`.
        requested_sha (str): `source_sha` input, required unless rolling back.
        rollback_tag (str): `rollback_tag` input, required only when rolling back.

    Returns:
        str: the 40-character lowercase source SHA.

    Raises:
        ValueError: unknown operation or inputs that do not exactly fit the operation.
    """
    if operation not in OPERATIONS:
        raise ValueError(f"Unknown operation '{operation}'")
    if operation == "rollback":
        match = ROLLBACK_TAG_PATTERN.fullmatch(rollback_tag)
        if match is None or requested_sha:
            raise ValueError(
                "Rollback needs `rollback_tag` exactly `stack/<40 lowercase hex>` and no `source_sha`"
            )
        return match[1]
    if rollback_tag or SHA_PATTERN.fullmatch(requested_sha) is None:
        raise ValueError("`source_sha` must be 40 lowercase hex characters and `rollback_tag` empty")
    return requested_sha


def descends_from(repo: Path, ancestor: str, descendant: str) -> bool:
    """Ask Git whether one commit is an ancestor of another.

    Parameters:
        repo (Path): checkout containing both commits.
        ancestor (str): candidate ancestor revision.
        descendant (str): candidate descendant revision.

    Returns:
        bool: whether `ancestor` is reachable from `descendant`.

    Raises:
        GitError: Git could not run or failed for a reason other than "not an ancestor".
    """
    try:
        result = subprocess.run(
            [GIT_BIN, "-C", str(repo), "merge-base", "--is-ancestor", ancestor, descendant],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode not in {0, 1}:
            result.check_returncode()
    except (OSError, subprocess.CalledProcessError) as error:
        detail = error.stderr.strip() if isinstance(error, subprocess.CalledProcessError) else str(error)
        raise GitError(f"Could not compare '{ancestor}' with '{descendant}': {detail}") from error
    return result.returncode == 0


def verify_successor(
    candidate: StackSnapshot, stable: StackSnapshot | None, descends_from_stable: bool
) -> None:
    """Refuse a stale, duplicate, or rollback candidate in normal promotion mode.

    Parameters:
        candidate (StackSnapshot): the rebuilt snapshot.
        stable (StackSnapshot | None): the attested current pointer, or `None` for the first seed.
        descends_from_stable (bool): whether the candidate SHA is a strict descendant of stable's.

    Raises:
        ValueError: the candidate is the stable commit or not a descendant of it.
    """
    if stable is None:
        return
    if candidate.source_sha == stable.source_sha:
        raise ValueError("Candidate already is the stable snapshot")
    if not descends_from_stable:
        raise ValueError("Candidate source SHA does not descend from stable source SHA")


def channel_exists(refs: object) -> bool:
    """Report whether the `stack-channel` branch exists.

    Parameters:
        refs (object): slurped `git/matching-refs/heads/stack-channel` pages.

    Returns:
        bool: whether `refs/heads/stack-channel` itself is listed (not merely a longer prefix match).

    Raises:
        ValueError: the response is malformed.
    """
    return any(
        isinstance(ref, dict) and ref.get("ref") == "refs/heads/stack-channel" for ref in flatten_pages(refs)
    )


StackCheck = Callable[[str, Path], OwnedPackageEvidence]


def run_stack_check(repo: Path, tag: str, worktree: Path) -> OwnedPackageEvidence:
    """Run trusted `scripts/npm_release.py stack-check` against a worktree of one package tag.

    Parameters:
        repo (Path): trusted `main` checkout providing `scripts/npm_release.py`.
        tag (str): exact `@nredd/<package>@<version>` tag.
        worktree (Path): checkout of that tag.

    Returns:
        OwnedPackageEvidence: the registry's real integrity for the package.

    Raises:
        EvidenceError: the check failed, timed out, or printed unusable evidence.
    """
    command = [
        sys.executable,
        str(repo / "scripts" / "npm_release.py"),
        "stack-check",
        "--tag",
        tag,
        "--repo-root",
        str(worktree),
    ]
    try:
        result = subprocess.run(
            command, cwd=repo, capture_output=True, text=True, check=True, timeout=STACK_CHECK_TIMEOUT
        )
        return OwnedPackageEvidence.model_validate_json(result.stdout)
    except subprocess.CalledProcessError as error:
        raise EvidenceError(f"Package check failed for '{tag}': {error.stderr.strip()[-3000:]}") from error
    except (OSError, subprocess.TimeoutExpired, ValueError) as error:
        raise EvidenceError(f"Package check could not complete for '{tag}': {error}") from error


def collect_owned_evidence(
    stack: Stack, repo: Path, workdir: Path, check: StackCheck | None = None
) -> list[OwnedPackageEvidence]:
    """Check out every owned package tag and verify it.

    Parameters:
        stack (Stack): selected personal stack.
        repo (Path): trusted `main` checkout that owns the tags and the checking script.
        workdir (Path): directory to hold one worktree per package; created when absent.
        check (StackCheck | None): per-tag verifier receiving the tag and its worktree; defaults to
            `run_stack_check` against `repo`.

    Returns:
        list[OwnedPackageEvidence]: one verified entry per owned tag, in stack order.

    Raises:
        GitError: a tag could not be checked out.
        EvidenceError: a package check failed.
    """
    verify = check or (lambda tag, worktree: run_stack_check(repo, tag, worktree))
    workdir.mkdir(parents=True, exist_ok=True)
    evidence: list[OwnedPackageEvidence] = []
    for index, tag in enumerate(owned_tags(stack), start=1):
        worktree = workdir / f"pkg-{index}"
        try:
            subprocess.run(
                [GIT_BIN, "-C", str(repo), "worktree", "add", "--detach", str(worktree), f"refs/tags/{tag}"],
                capture_output=True,
                text=True,
                check=True,
            )
        except (OSError, subprocess.CalledProcessError) as error:
            detail = error.stderr.strip() if isinstance(error, subprocess.CalledProcessError) else str(error)
            raise GitError(f"Could not check out tag '{tag}': {detail}") from error
        evidence.append(verify(tag, worktree))
    return evidence


def _read_json(path: Path) -> Any:
    """Read one JSON file.

    Parameters:
        path (Path): file to decode.

    Returns:
        Any: decoded JSON.
    """
    return json.loads(path.read_bytes())


def _write_json(path: Path, value: object) -> None:
    """Write compact sorted JSON.

    Parameters:
        path (Path): output file.
        value (object): JSON-serializable value.
    """
    path.write_bytes(json.dumps(value, sort_keys=True, separators=(",", ":")).encode())


def _emit(value: object) -> None:
    """Write one JSON document to stdout for the workflow to capture.

    Parameters:
        value (object): JSON-serializable value.
    """
    sys.stdout.write(json.dumps(value) + "\n")


def _emit_lines(values: Iterable[object]) -> None:
    """Write one plain-text value per line to stdout for a shell loop or assignment.

    Parameters:
        values (Iterable[object]): printable values.
    """
    for value in values:
        sys.stdout.write(f"{value}\n")


def _load_stack(path: Path) -> Stack:
    """Read and validate a stack file.

    Parameters:
        path (Path): stack JSON.

    Returns:
        Stack: the validated stack.
    """
    return Stack.model_validate_json(path.read_bytes())


def _add_evidence_commands(commands: Any) -> None:
    """Register the subcommands that read GitHub responses and verify evidence.

    Parameters:
        commands (Any): the parser's subparsers action.
    """
    select = commands.add_parser("select", help="Validate dispatch inputs, print the source SHA")
    select.add_argument("--operation", required=True)
    select.add_argument("--source-sha", default="")
    select.add_argument("--rollback-tag", default="")
    ancestor = commands.add_parser("ancestor", help="Fail unless --ancestor is reachable from --descendant")
    ancestor.add_argument("--repo", type=Path, default=Path())
    ancestor.add_argument("--ancestor", required=True)
    ancestor.add_argument("--descendant", required=True)
    checks = commands.add_parser("checks", help="Verify required checks succeeded on the SHA")
    checks.add_argument("--rules", type=Path, required=True)
    checks.add_argument("--check-pages", type=Path, required=True)
    checks.add_argument("--source-sha", required=True)
    candidates = commands.add_parser(
        "candidate-runs", help="Print push/main CI run IDs to fetch, one per line"
    )
    candidates.add_argument("--runs", type=Path, required=True)
    candidates.add_argument("--source-sha", required=True)
    runs = commands.add_parser(
        "stack-runs", help="Find push/main CI runs that ran the personal stack scenario"
    )
    runs.add_argument("--runs", type=Path, required=True)
    runs.add_argument("--jobs-dir", type=Path, required=True)
    runs.add_argument("--artifacts-dir", type=Path, required=True)
    runs.add_argument("--source-sha", required=True)


def _add_snapshot_commands(commands: Any) -> None:
    """Register the subcommands that assemble, verify and publish-gate the snapshot.

    Parameters:
        commands (Any): the parser's subparsers action.
    """
    owned = commands.add_parser(
        "owned-evidence", help="Verify every owned package tag, write the evidence list"
    )
    owned.add_argument("--stack", type=Path, required=True)
    owned.add_argument("--repo", type=Path, required=True)
    owned.add_argument("--workdir", type=Path, required=True)
    owned.add_argument("--output", type=Path, required=True)
    core = commands.add_parser("core", help="Verify core asset digests, print core evidence")
    core.add_argument("--stack", type=Path, required=True)
    gates = commands.add_parser("gates", help="Assemble gate evidence JSON")
    gates.add_argument("--stack", type=Path, required=True)
    gates.add_argument("--checks", type=Path, required=True)
    gates.add_argument("--stack-runs", type=Path, required=True)
    gates.add_argument("--owned", type=Path, required=True)
    gates.add_argument("--core", type=Path, required=True)
    gates.add_argument("--output", type=Path, required=True)
    build = commands.add_parser("build", help="Build the snapshot")
    build.add_argument("--stack", type=Path, required=True)
    build.add_argument("--source-sha", required=True)
    build.add_argument("--gates", type=Path, required=True)
    build.add_argument("--output", type=Path, required=True)
    verify = commands.add_parser("verify", help="Validate a snapshot, optionally against a SHA")
    verify.add_argument("--snapshot", type=Path, required=True)
    verify.add_argument("--source-sha")
    channel = commands.add_parser("channel-exists", help="Print true or false: does `stack-channel` exist")
    channel.add_argument("--refs", type=Path, required=True)
    successor = commands.add_parser("successor", help="Gate a candidate against the attested stable")
    successor.add_argument("--candidate", type=Path, required=True)
    successor.add_argument("--refs", type=Path, required=True)
    successor.add_argument("--stable", type=Path, required=True)
    successor.add_argument("--repo", type=Path, default=Path())


def _parser() -> argparse.ArgumentParser:
    """Build the subcommand parser.

    Returns:
        argparse.ArgumentParser: parser with one subcommand per gate.
    """
    parser = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True)
    _add_evidence_commands(commands)
    _add_snapshot_commands(commands)
    return parser


def _cmd_select(args: argparse.Namespace) -> None:
    """Print the validated source SHA.

    Parameters:
        args (argparse.Namespace): `select` arguments.
    """
    _emit_lines([select_source_sha(args.operation, args.source_sha, args.rollback_tag)])


def _cmd_ancestor(args: argparse.Namespace) -> None:
    """Fail unless one commit is an ancestor of another.

    Parameters:
        args (argparse.Namespace): `ancestor` arguments.

    Raises:
        ValueError: the commit is not an ancestor.
    """
    if not descends_from(args.repo, args.ancestor, args.descendant):
        raise ValueError(f"'{args.ancestor}' is not an ancestor of '{args.descendant}'")


def _cmd_checks(args: argparse.Namespace) -> None:
    """Verify the required checks and print their names.

    Parameters:
        args (argparse.Namespace): `checks` arguments.
    """
    required = required_checks(flatten_pages(_read_json(args.rules)))
    _emit(verify_required_checks(required, flatten_pages(_read_json(args.check_pages)), args.source_sha))


def _cmd_candidate_runs(args: argparse.Namespace) -> None:
    """Print the run IDs to fetch.

    Parameters:
        args (argparse.Namespace): `candidate-runs` arguments.
    """
    _emit_lines(candidate_run_ids(flatten_pages([_read_json(args.runs)]), args.source_sha))


def _cmd_stack_runs(args: argparse.Namespace) -> None:
    """Print the run IDs that executed the personal stack scenario.

    Parameters:
        args (argparse.Namespace): `stack-runs` arguments.
    """
    jobs = {path.stem.removeprefix("run-"): _read_json(path) for path in args.jobs_dir.glob("run-*.json")}
    artifacts = {
        path.stem.removeprefix("run-"): _read_json(path) for path in args.artifacts_dir.glob("run-*.json")
    }
    _emit(registry_stack_runs(flatten_pages([_read_json(args.runs)]), jobs, artifacts, args.source_sha))


def _cmd_owned_evidence(args: argparse.Namespace) -> None:
    """Verify every owned package and write the evidence list.

    Parameters:
        args (argparse.Namespace): `owned-evidence` arguments.
    """
    evidence = collect_owned_evidence(_load_stack(args.stack), args.repo, args.workdir)
    _write_json(args.output, [item.model_dump(mode="json") for item in evidence])


def _cmd_core(args: argparse.Namespace) -> None:
    """Verify the core release and print its evidence.

    Parameters:
        args (argparse.Namespace): `core` arguments.
    """
    _emit(verify_core(_load_stack(args.stack)).model_dump(mode="json"))


def _cmd_gates(args: argparse.Namespace) -> None:
    """Assemble and write gate evidence.

    Parameters:
        args (argparse.Namespace): `gates` arguments.
    """
    owned = [OwnedPackageEvidence.model_validate(item) for item in _read_json(args.owned)]
    gates = build_gates(
        _load_stack(args.stack),
        _read_json(args.checks),
        _read_json(args.stack_runs),
        owned,
        CoreEvidence.model_validate_json(args.core.read_bytes()),
    )
    _write_json(args.output, gates.model_dump(mode="json"))


def _cmd_build(args: argparse.Namespace) -> None:
    """Build and write the snapshot.

    Parameters:
        args (argparse.Namespace): `build` arguments.
    """
    gates = GateEvidence.model_validate_json(args.gates.read_bytes())
    _write_json(args.output, build_snapshot(args.stack, args.source_sha, gates).model_dump(mode="json"))


def _cmd_verify(args: argparse.Namespace) -> None:
    """Validate a snapshot, optionally pinning its source SHA.

    Parameters:
        args (argparse.Namespace): `verify` arguments.

    Raises:
        ValueError: the snapshot's source differs from `--source-sha`.
    """
    snapshot = StackSnapshot.model_validate_json(args.snapshot.read_bytes())
    if args.source_sha and snapshot.source_sha != args.source_sha:
        raise ValueError(f"Snapshot source '{snapshot.source_sha}' differs from '{args.source_sha}'")


def _cmd_channel_exists(args: argparse.Namespace) -> None:
    """Print whether `stack-channel` exists.

    Parameters:
        args (argparse.Namespace): `channel-exists` arguments.
    """
    _emit_lines([str(channel_exists(_read_json(args.refs))).lower()])


def _cmd_successor(args: argparse.Namespace) -> None:
    """Gate a candidate against the stable pointer; a missing channel is the only seed.

    Parameters:
        args (argparse.Namespace): `successor` arguments.
    """
    candidate = StackSnapshot.model_validate_json(args.candidate.read_bytes())
    stable = None
    if channel_exists(_read_json(args.refs)):
        stable = StackSnapshot.model_validate_json(args.stable.read_bytes())
    descends = stable is not None and descends_from(args.repo, stable.source_sha, candidate.source_sha)
    verify_successor(candidate, stable, descends)


COMMANDS: dict[str, Callable[[argparse.Namespace], None]] = {
    "select": _cmd_select,
    "ancestor": _cmd_ancestor,
    "checks": _cmd_checks,
    "candidate-runs": _cmd_candidate_runs,
    "stack-runs": _cmd_stack_runs,
    "owned-evidence": _cmd_owned_evidence,
    "core": _cmd_core,
    "gates": _cmd_gates,
    "build": _cmd_build,
    "verify": _cmd_verify,
    "channel-exists": _cmd_channel_exists,
    "successor": _cmd_successor,
}


def main(argv: list[str] | None = None) -> int:
    """Run one gate subcommand; refusals exit 1 with a one-line error.

    Parameters:
        argv (list[str] | None): arguments, or the process arguments.

    Returns:
        int: 0 on success, 1 on a failed gate.
    """
    args = _parser().parse_args(argv)
    try:
        COMMANDS[args.command](args)
    except (ValueError, OSError, PromotionError) as error:
        sys.stderr.write(f"FAILED: {error}\n")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
