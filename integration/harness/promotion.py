"""Build and verify attested promoted-stack snapshots.

References:
- https://docs.github.com/rest/repos/rules#get-rules-for-a-branch
- https://docs.github.com/actions/security-for-github-actions/using-artifact-attestations/using-artifact-attestations-to-establish-provenance-for-builds
"""

from __future__ import annotations

import hashlib
import re
import subprocess
import sys
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

from harness.release import (
    LEGACY_RELEASE_TAGS,
    FetchError,
    fetch_bytes,
    release_asset_url,
    release_checksums,
    verify_provenance,
)
from harness.stack import Stack, canonical_stack_bytes, validate_release_identity

SNAPSHOT_SCHEMA_VERSION = 1
SHA256_HEX_LENGTH = 64
GIT_SHA_LENGTH = 40
PERSONAL_STACK_ARTIFACT = "stack-ubuntu-24.04-personal"
# The sole CI job that produces PERSONAL_STACK_ARTIFACT. Keep this machine contract exact.
SHA_PATTERN = re.compile(rf"[0-9a-f]{{{GIT_SHA_LENGTH}}}")
OPERATIONS = ("verify-only", "promote")
"""The only permitted operations both require green CI evidence."""
GIT_BIN = "/usr/bin/git"
STACK_CHECK_TIMEOUT = 900
STRICT = ConfigDict(extra="forbid", strict=True, frozen=True)
# The consumer contract: who must have signed a `stack/<sha>` snapshot, and from which ref.
SNAPSHOT_REPO = "nredd/pi-harness"
SNAPSHOT_ASSET = "stack-snapshot.json"
SNAPSHOT_SIGNER_WORKFLOW = f"{SNAPSHOT_REPO}/.github/workflows/promote-stack.yml"
SNAPSHOT_SOURCE_REF = "refs/heads/main"


class PromotionError(Exception):
    """An external tool or service a gate depends on failed (distinct from a refused gate)."""


class GitError(PromotionError):
    """Git could not answer a question about the checkout."""


class AttestationError(PromotionError):
    """Release bytes did not match the recorded digest or lacked the required provenance."""


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
    """Serialize a stack with `canonical_stack_bytes`, the one representation the golden fixture locks.

    Parameters:
        stack (Stack): the validated stack.

    Returns:
        CanonicalStack: compact sorted UTF-8 JSON and its SHA-256.
    """
    contents = canonical_stack_bytes(stack)
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


def snapshot_url(source_sha: str) -> str:
    """Return the immutable release URL of one promoted snapshot.

    Parameters:
        source_sha (str): the pinned, promoted `main` commit.

    Returns:
        str: `stack/<source_sha>` release asset URL.
    """
    return f"https://github.com/{SNAPSHOT_REPO}/releases/download/stack/{source_sha}/{SNAPSHOT_ASSET}"


def load_promoted_snapshot(contents: bytes, pinned_sha: str) -> StackSnapshot:
    """Validate attested snapshot bytes and require them to be the pinned promotion.

    Call only after the bytes' attestation was verified against `SNAPSHOT_SIGNER_WORKFLOW` and
    `SNAPSHOT_SOURCE_REF`; this checks what the attestation cannot: the schema, the canonical
    stack digest and that the snapshot names the commit the consumer pinned.

    Parameters:
        contents (bytes): downloaded `stack-snapshot.json`.
        pinned_sha (str): the `source_sha` the consumer asked for.

    Returns:
        StackSnapshot: the validated snapshot.

    Raises:
        ValueError: the bytes are not a valid snapshot, or it promotes another commit.
    """
    snapshot = StackSnapshot.model_validate_json(contents)
    if snapshot.source_sha != pinned_sha:
        raise ValueError(f"Snapshot promotes '{snapshot.source_sha}', not the pinned '{pinned_sha}'")
    return snapshot


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
    """List the CI runs worth fetching artifacts for.

    Parameters:
        runs (list[dict[str, Any]]): `gh run list --json` entries.
        source_sha (str): selected commit.

    Returns:
        list[int]: sorted IDs of successful push/main runs of the selected commit.
    """
    return sorted(run["databaseId"] for run in runs if _is_main_push_success(run, source_sha))


def registry_stack_runs(
    runs: list[dict[str, Any]],
    artifacts_by_run: dict[str, Any],
    source_sha: str,
) -> list[int]:
    """Return successful push/main CI runs with the personal-stack machine evidence.

    The artifact is the evidence: `ci.yml` uploads it only after the registry stack scenario ran,
    and its API provenance binds it to the exact run and source SHA. A skipped docs-only or
    main-push-smoke cell cannot qualify. Job names are deliberately not consulted, so renaming a
    matrix cell cannot break promotion.

    Parameters:
        runs (list[dict[str, Any]]): `gh run list --json` entries.
        artifacts_by_run (dict[str, Any]): run ID -> slurped `actions/runs/<id>/artifacts` pages.
        source_sha (str): selected commit.

    Returns:
        list[int]: sorted qualifying run IDs.

    Raises:
        ValueError: no run qualifies, or an artifact response is malformed.
    """
    verified = [
        run_id
        for run_id in candidate_run_ids(runs, source_sha)
        if _has_live_stack_artifact(artifacts_by_run.get(str(run_id), []), run_id, source_sha)
    ]
    if not verified:
        raise ValueError(
            f"No successful push/main CI run with a live '{PERSONAL_STACK_ARTIFACT}' artifact found for "
            f"'{source_sha}'; docs-only SHAs and runs whose artifacts expired cannot be promoted"
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


AssetFetch = Callable[[str, Path], None]
AssetAttest = Callable[[Path, str], None]


def _fetch_asset(url: str, destination: Path) -> None:
    """Download one release asset.

    Parameters:
        url (str): canonical release asset URL.
        destination (Path): file to write.

    Raises:
        EvidenceError: the download failed.
    """
    try:
        destination.write_bytes(fetch_bytes(url))
    except FetchError as error:
        raise EvidenceError(str(error)) from error
    except OSError as error:
        raise EvidenceError(f"Could not download '{url}': {error}") from error


def _attest_asset(path: Path, tag: str) -> None:
    """Verify one asset's GitHub provenance against `nredd/pi`'s release workflow.

    Parameters:
        path (Path): downloaded asset.
        tag (str): core tag the provenance must be bound to.

    Raises:
        AttestationError: `gh attestation verify` rejected the asset.
    """
    try:
        verify_provenance(path, tag)
    except RuntimeError as error:
        raise AttestationError(str(error)) from error


def verify_core_assets(
    stack: Stack, workdir: Path, fetch: AssetFetch | None = None, attest: AssetAttest | None = None
) -> None:
    """Hash the real core release assets and verify their provenance (non-legacy tags only).

    `SHA256SUMS` is a mutable release asset, so matching it proves nothing alone. The assets the
    stack records are downloaded, compared with the recorded digests, and verified read-only with
    `gh attestation verify` (signer `fork-release.yml`, source ref the tag). Legacy tags predate
    that workflow and rely on `LEGACY_CHECKSUMS`.

    Parameters:
        stack (Stack): selected personal stack.
        workdir (Path): directory for the downloaded assets; created when absent.
        fetch (AssetFetch | None): downloader taking a URL and destination; defaults to HTTPS.
        attest (AssetAttest | None): verifier taking an asset and its tag; defaults to `gh`.

    Raises:
        AttestationError: an asset's bytes differ from the recorded digest or lack provenance.
        EvidenceError: an asset could not be downloaded.
    """
    tag = stack.core.tag
    if tag in LEGACY_RELEASE_TAGS:
        return
    download, verify = fetch or _fetch_asset, attest or _attest_asset
    workdir.mkdir(parents=True, exist_ok=True)
    for name, digest in sorted(stack.core.integrity.items()):
        path = workdir / name
        download(release_asset_url(tag, name), path)
        actual = hashlib.sha256(path.read_bytes()).hexdigest()
        if actual != digest:
            raise AttestationError(f"Core asset '{name}' has sha256 '{actual}', expected '{digest}'")
        verify(path, tag)


def verify_core(stack: Stack, workdir: Path) -> CoreEvidence:
    """Verify the stack's core release identity, asset bytes and provenance.

    Parameters:
        stack (Stack): selected personal stack.
        workdir (Path): directory for downloaded core assets.

    Returns:
        CoreEvidence: tag and asset digests that agree with the published release.

    Raises:
        ValueError: the release checksums are unreadable or disagree.
        AttestationError: an asset's bytes or provenance is wrong (non-legacy tags).
        EvidenceError: an asset could not be downloaded.
    """
    validate_release_identity(stack, stack.core.tag, release_checksums(stack.core.tag))
    verify_core_assets(stack, workdir)
    return CoreEvidence(tag=stack.core.tag, integrity=dict(stack.core.integrity))


def select_source_sha(operation: str, requested_sha: str) -> str:
    """Validate dispatch inputs and return the selected source SHA.

    Parameters:
        operation (str): `verify-only` or `promote`.
        requested_sha (str): `source_sha` input.

    Returns:
        str: the 40-character lowercase source SHA.

    Raises:
        ValueError: unknown operation or a malformed SHA.
    """
    if operation not in OPERATIONS:
        raise ValueError(f"Unknown operation '{operation}'")
    if SHA_PATTERN.fullmatch(requested_sha) is None:
        raise ValueError("`source_sha` must be 40 lowercase hex characters")
    return requested_sha


def run_command(
    *args: str,
    error: type[PromotionError] = EvidenceError,
    cwd: Path | None = None,
    check: bool = True,
    timeout: float | None = None,
) -> subprocess.CompletedProcess[str]:
    """Run one literal `git`/`gh`/script command with captured diagnostics.

    The only subprocess wrapper for `promotion` and `promotion_verify`; `publish_gate` keeps its
    own because the write job may import nothing outside the standard library.

    Parameters:
        *args (str): executable and arguments, never a shell string.
        error (type[PromotionError]): exception type raised on failure.
        cwd (Path | None): optional working directory.
        check (bool): whether a nonzero exit raises; the caller inspects `returncode` otherwise.
        timeout (float | None): optional seconds before the command is abandoned.

    Returns:
        subprocess.CompletedProcess[str]: the finished command.

    Raises:
        PromotionError: (`error`) the command could not run, timed out, or exited nonzero.
    """
    try:
        return subprocess.run(args, cwd=cwd, capture_output=True, text=True, check=check, timeout=timeout)
    except subprocess.CalledProcessError as failure:
        raise error(f"Command failed: {' '.join(args[:3])}: {failure.stderr.strip()[-3000:]}") from failure
    except (OSError, subprocess.TimeoutExpired) as failure:
        raise error(f"Command could not complete: {' '.join(args[:3])}: {failure}") from failure


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
    result = run_command(
        GIT_BIN, "-C", str(repo), "merge-base", "--is-ancestor", "--", ancestor, descendant,
        error=GitError, check=False,
    )  # fmt: skip
    if result.returncode not in {0, 1}:
        raise GitError(f"Could not compare '{ancestor}' with '{descendant}': {result.stderr.strip()}")
    return result.returncode == 0


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
    result = run_command(*command, cwd=repo, timeout=STACK_CHECK_TIMEOUT, error=EvidenceError)
    try:
        return OwnedPackageEvidence.model_validate_json(result.stdout)
    except ValueError as error:
        raise EvidenceError(f"Package check printed unusable evidence for '{tag}': {error}") from error


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
        run_command(
            GIT_BIN, "-C", str(repo), "worktree", "add", "--detach", str(worktree), f"refs/tags/{tag}",
            error=GitError,
        )  # fmt: skip
        evidence.append(verify(tag, worktree))
    return evidence
