"""Build and verify attested promoted-stack snapshots.

References:
- https://docs.github.com/rest/repos/rules#get-rules-for-a-branch
- https://docs.github.com/rest/branches/branch-protection#get-status-checks-protection
- https://docs.github.com/actions/security-for-github-actions/using-artifact-attestations/using-artifact-attestations-to-establish-provenance-for-builds
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

from harness.release import release_checksums
from harness.stack import Stack, validate_release_identity

SNAPSHOT_SCHEMA_VERSION = 1
SHA256_HEX_LENGTH = 64
GIT_SHA_LENGTH = 40
PERSONAL_STACK_JOB = "stack (ubuntu-24.04, personal)"
ASSEMBLED_STACK_STEP_PREFIX = "Assembled D and E boundaries"
SHA_PATTERN = re.compile(rf"[0-9a-f]{{{GIT_SHA_LENGTH}}}")
ROLLBACK_TAG_PATTERN = re.compile(rf"stack/([0-9a-f]{{{GIT_SHA_LENGTH}}})")
OPERATIONS = ("verify-only", "promote", "rollback")
GIT_BIN = "/usr/bin/git"
STRICT = ConfigDict(extra="forbid", strict=True, frozen=True)


class OwnedPackageEvidence(BaseModel):
    model_config = STRICT
    package: str = Field(
        pattern=r"^@nredd/[a-z0-9-]+@[0-9]+\.[0-9]+\.[0-9]+(?:-[\w.-]+)?$",
        description="Exact npm package and version",
    )
    integrity: str = Field(
        pattern=r"^sha512-[A-Za-z0-9+/]{86}==$", description="Verified npm SHA-512 integrity"
    )


class CoreEvidence(BaseModel):
    model_config = STRICT
    tag: str = Field(pattern=r"^v[0-9]+\.[0-9]+\.[0-9]+-nredd\.[0-9]+$", description="Exact core release tag")
    integrity: dict[str, str] = Field(min_length=1, description="Verified asset filename to SHA-256 mapping")

    @model_validator(mode="after")
    def validate_integrity(self) -> Self:
        """Reject incomplete or ambiguous core asset evidence."""
        if any("/" in name or not name.endswith(".tgz") for name in self.integrity) or any(
            len(digest) != SHA256_HEX_LENGTH or any(char not in "0123456789abcdef" for char in digest)
            for digest in self.integrity.values()
        ):
            raise ValueError("`core.integrity` must contain tarball names and lowercase SHA-256 digests")
        return self


class GateEvidence(BaseModel):
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
        """Reject duplicated or malformed evidence."""
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
        """Require a personal stack and matching canonical digest."""
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
    """Serialize a stack using the sole snapshot digest representation."""
    contents = json.dumps(stack.model_dump(mode="json"), sort_keys=True, separators=(",", ":")).encode(
        "utf-8"
    )
    return CanonicalStack(contents, hashlib.sha256(contents).hexdigest())


def build_snapshot(stack_path: Path, source_sha: str, gates: GateEvidence) -> StackSnapshot:
    """Build a fail-closed snapshot from the selected authoritative stack."""
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
        ValueError: the value is not a list of pages.
    """
    if not isinstance(value, list):
        raise ValueError("Expected a JSON array of API pages")
    flat: list[Any] = []
    for page in value:
        flat.extend(page) if isinstance(page, list) else flat.append(page)
    return flat


def required_check_names(rules: list[Any], protection: dict[str, Any] | None = None) -> list[str]:
    """Union the required status-check contexts of branch rulesets and classic protection.

    Parameters:
        rules (list[Any]): flattened `GET /rules/branches/main` rules (readable by `GITHUB_TOKEN`).
        protection (dict[str, Any] | None): `branches/main/protection/required_status_checks`
            (needs administration read), or `None` when no token was supplied.

    Returns:
        list[str]: sorted unique required contexts.

    Raises:
        ValueError: neither source yields a check, or a source is malformed.
    """
    contexts: list[str] = []
    for rule in rules:
        if not isinstance(rule, dict) or rule.get("type") != "required_status_checks":
            continue
        parameters = rule.get("parameters")
        entries = parameters.get("required_status_checks") if isinstance(parameters, dict) else None
        if not isinstance(entries, list):
            raise ValueError("Required-status-checks rule has malformed parameters")
        contexts.extend(_context(entry) for entry in entries)
    if protection:
        entries = protection.get("checks")
        if not isinstance(entries, list):
            raise ValueError("Branch protection response has no `checks` list")
        contexts.extend(_context(entry) for entry in entries)
    if not contexts:
        raise ValueError(
            "No required status checks are readable: the `main` rules API lists none and branch "
            "protection was not read. Move the checks into a ruleset, or provide "
            "`STACK_PROMOTION_RULES_TOKEN` (read-only Administration) for branch protection"
        )
    return sorted(set(contexts))


def _context(entry: object) -> str:
    """Return one validated check context.

    Parameters:
        entry (object): one `required_status_checks` entry.

    Returns:
        str: the nonempty context name.

    Raises:
        ValueError: the entry has no string `context`.
    """
    context = entry.get("context") if isinstance(entry, dict) else None
    if not isinstance(context, str) or not context:
        raise ValueError("Required-status-checks entry has an invalid `context`")
    return context


def verify_required_checks(required: list[str], check_pages: list[Any], source_sha: str) -> list[str]:
    """Require every configured check to have succeeded on the exact selected commit.

    Parameters:
        required (list[str]): configured check names.
        check_pages (list[Any]): `commits/<sha>/check-runs` pages.
        source_sha (str): selected commit.

    Returns:
        list[str]: the required names, sorted.

    Raises:
        ValueError: a required check is missing or did not complete successfully.
    """
    runs = [run for page in check_pages for run in page.get("check_runs", []) if isinstance(run, dict)]
    missing = [
        name
        for name in required
        if not any(
            run.get("name") == name
            and run.get("head_sha") == source_sha
            and run.get("status") == "completed"
            and run.get("conclusion") == "success"
            for run in runs
        )
    ]
    if missing:
        raise ValueError(f"Required checks did not succeed on '{source_sha}': {', '.join(missing)}")
    return sorted(required)


def registry_stack_runs(
    runs: list[dict[str, Any]], jobs_by_run: dict[str, dict[str, Any]], source_sha: str
) -> list[int]:
    """Return successful push/main CI runs whose personal stack job ran the assembled step.

    Only `event=push`, `branch=main` runs count, so docs-only SHAs (where the stack job is
    skipped) and PR runs are never promotable. The signal is the job name plus a step whose
    name starts with `ASSEMBLED_STACK_STEP_PREFIX` concluding `success` (not `skipped`).

    Parameters:
        runs (list[dict[str, Any]]): `gh run list --json` entries.
        jobs_by_run (dict[str, dict[str, Any]]): run ID -> `gh run view --json jobs` output.
        source_sha (str): selected commit.

    Returns:
        list[int]: sorted qualifying run IDs.

    Raises:
        ValueError: no run qualifies.
    """
    verified: list[int] = []
    for run in runs:
        run_id = run.get("databaseId")
        if not isinstance(run_id, int) or not (
            run.get("event") == "push"
            and run.get("headBranch") == "main"
            and run.get("headSha") == source_sha
            and run.get("status") == "completed"
            and run.get("conclusion") == "success"
        ):
            continue
        jobs = jobs_by_run.get(str(run_id), {}).get("jobs", [])
        job = next((item for item in jobs if item.get("name") == PERSONAL_STACK_JOB), None)
        if not isinstance(job, dict) or job.get("conclusion") != "success":
            continue
        if any(
            isinstance(step, dict)
            and str(step.get("name", "")).startswith(ASSEMBLED_STACK_STEP_PREFIX)
            and step.get("status") == "completed"
            and step.get("conclusion") == "success"
            for step in job.get("steps", [])
        ):
            verified.append(run_id)
    if not verified:
        raise ValueError(
            f"No successful push/main CI run with a passing '{PERSONAL_STACK_JOB}' assembled step "
            f"found for '{source_sha}'; docs-only SHAs cannot be promoted"
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
        ValueError: Git failed for a reason other than "not an ancestor".
    """
    result = subprocess.run(
        [GIT_BIN, "-C", str(repo), "merge-base", "--is-ancestor", ancestor, descendant],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode not in {0, 1}:
        raise ValueError(f"Could not compare '{ancestor}' with '{descendant}': {result.stderr.strip()}")
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


def _parser() -> argparse.ArgumentParser:
    """Build the subcommand parser.

    Returns:
        argparse.ArgumentParser: parser with one subcommand per gate.
    """
    parser = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True)
    select = commands.add_parser("select", help="Validate dispatch inputs, print the source SHA")
    select.add_argument("--operation", required=True)
    select.add_argument("--source-sha", default="")
    select.add_argument("--rollback-tag", default="")
    ancestor = commands.add_parser("ancestor", help="Fail unless --ancestor is reachable from --descendant")
    ancestor.add_argument("--repo", type=Path, default=Path())
    ancestor.add_argument("--ancestor", required=True)
    ancestor.add_argument("--descendant", required=True)
    checks = commands.add_parser("checks", help="Verify configured checks succeeded on the SHA")
    checks.add_argument("--rules", type=Path, required=True)
    checks.add_argument("--protection", type=Path)
    checks.add_argument("--check-pages", type=Path, required=True)
    checks.add_argument("--source-sha", required=True)
    runs = commands.add_parser("stack-runs", help="Find push/main CI runs with the assembled step")
    runs.add_argument("--runs", type=Path, required=True)
    runs.add_argument("--jobs-dir", type=Path, required=True)
    runs.add_argument("--source-sha", required=True)
    owned = commands.add_parser("owned-tags", help="Print the stack's owned package release tags")
    owned.add_argument("--stack", type=Path, required=True)
    core = commands.add_parser("core", help="Verify core asset digests, print core evidence")
    core.add_argument("--stack", type=Path, required=True)
    gates = commands.add_parser("gates", help="Assemble gate evidence JSON")
    gates.add_argument("--stack", type=Path, required=True)
    gates.add_argument("--checks", type=Path, required=True)
    gates.add_argument("--stack-runs", type=Path, required=True)
    gates.add_argument("--owned-dir", type=Path, required=True)
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
    successor = commands.add_parser("successor", help="Gate a candidate against the attested stable")
    successor.add_argument("--candidate", type=Path, required=True)
    successor.add_argument("--stable", type=Path)
    successor.add_argument("--repo", type=Path, default=Path())
    return parser


def _run(args: argparse.Namespace) -> None:
    """Dispatch one validated subcommand.

    Parameters:
        args (argparse.Namespace): parsed arguments.

    Raises:
        ValueError: a gate failed.
    """
    command = args.command
    if command == "select":
        _emit(select_source_sha(args.operation, args.source_sha, args.rollback_tag))
    elif command == "ancestor":
        if not descends_from(args.repo, args.ancestor, args.descendant):
            raise ValueError(f"'{args.ancestor}' is not an ancestor of '{args.descendant}'")
    elif command == "checks":
        protection = _read_json(args.protection) if args.protection else None
        required = required_check_names(flatten_pages(_read_json(args.rules)), protection)
        _emit(verify_required_checks(required, flatten_pages(_read_json(args.check_pages)), args.source_sha))
    elif command == "stack-runs":
        jobs = {path.stem.removeprefix("run-"): _read_json(path) for path in args.jobs_dir.glob("run-*.json")}
        _emit(registry_stack_runs(flatten_pages([_read_json(args.runs)]), jobs, args.source_sha))
    elif command == "owned-tags":
        _emit(owned_tags(Stack.model_validate_json(args.stack.read_bytes())))
    elif command == "core":
        _emit(verify_core(Stack.model_validate_json(args.stack.read_bytes())).model_dump(mode="json"))
    elif command == "gates":
        owned = [
            OwnedPackageEvidence.model_validate_json(path.read_bytes())
            for path in sorted(args.owned_dir.glob("owned-*.json"))
        ]
        gates = build_gates(
            Stack.model_validate_json(args.stack.read_bytes()),
            _read_json(args.checks),
            _read_json(args.stack_runs),
            owned,
            CoreEvidence.model_validate_json(args.core.read_bytes()),
        )
        _write_json(args.output, gates.model_dump(mode="json"))
    elif command == "build":
        gates = GateEvidence.model_validate_json(args.gates.read_bytes())
        _write_json(args.output, build_snapshot(args.stack, args.source_sha, gates).model_dump(mode="json"))
    elif command == "verify":
        snapshot = StackSnapshot.model_validate_json(args.snapshot.read_bytes())
        if args.source_sha and snapshot.source_sha != args.source_sha:
            raise ValueError(f"Snapshot source '{snapshot.source_sha}' differs from '{args.source_sha}'")
    else:
        candidate = StackSnapshot.model_validate_json(args.candidate.read_bytes())
        stable = StackSnapshot.model_validate_json(args.stable.read_bytes()) if args.stable else None
        descends = stable is not None and descends_from(args.repo, stable.source_sha, candidate.source_sha)
        verify_successor(candidate, stable, descends)


def main(argv: list[str] | None = None) -> int:
    """Run one gate subcommand; refusals exit 1 with a one-line error.

    Parameters:
        argv (list[str] | None): arguments, or the process arguments.

    Returns:
        int: 0 on success, 1 on a failed gate.
    """
    args = _parser().parse_args(argv)
    try:
        _run(args)
    except (ValueError, OSError) as error:
        sys.stderr.write(f"FAILED: {error}\n")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
