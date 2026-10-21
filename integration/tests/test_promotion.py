"""Promotion snapshot serialization and fail-closed successor tests.

References:
- https://docs.github.com/actions/security-for-github-actions/using-artifact-attestations/using-artifact-attestations-to-establish-provenance-for-builds
"""

from __future__ import annotations

import ast
import copy
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest
import yaml
from pydantic import ValidationError

from harness import promotion, promotion_verify, publish_gate
from harness.promotion import (
    AttestationError,
    CoreEvidence,
    EvidenceError,
    GateEvidence,
    GitError,
    OwnedPackageEvidence,
    RequiredCheck,
    StackSnapshot,
    build_gates,
    build_snapshot,
    candidate_run_ids,
    collect_owned_evidence,
    descends_from,
    flatten_pages,
    owned_tags,
    registry_stack_runs,
    required_checks,
    run_stack_check,
    select_source_sha,
    stack_bytes,
    verify_core_assets,
    verify_required_checks,
)
from harness.publish_gate import PublishError, release_state, verify_tag_target
from harness.release import LEGACY_CHECKSUMS
from harness.stack import Stack

FIXTURES = Path(__file__).parent / "fixtures"
CI_WORKFLOW = Path(__file__).parents[2] / ".github/workflows/ci.yml"
PROMOTION_WORKFLOW = Path(__file__).parents[2] / ".github/workflows/promote-stack.yml"
FIXTURE_SHA = "40e119a68a286cf498968605bcf9217359184e40"
FIXTURE_RUN = 39545048647

CORE = {
    "tag": "v1.3.0-nredd.7",
    "integrity": {"earendil-works-pi-coding-agent-1.3.0.tgz": "0" * 64},
}
OWNED = {"package": "@nredd/pi-preset@0.2.0", "integrity": "sha512-" + "A" * 86 + "=="}
GATES = {
    "required_checks": ["owned (ubuntu-24.04)"],
    "stack_run_ids": [123],
    "owned_packages": [OWNED],
    "core": CORE,
}


def write_stack(path: Path, **overrides: Any) -> None:
    """Write a minimal authoritative stack document.

    Parameters:
        path (Path): stack output path.
        **overrides (Any): stack fields to replace.

    Returns:
        None.
    """
    document = {
        "schema_version": 1,
        "name": "personal",
        "core": CORE,
        "sources": ["npm:@nredd/pi-preset@0.2.0"],
    } | overrides
    path.write_text(json.dumps(document))


def snapshot(tmp_path: Path, source_sha: str = "a" * 40) -> StackSnapshot:
    """Build one valid snapshot fixture.

    Parameters:
        tmp_path (Path): private fixture directory.
        source_sha (str): candidate main commit.

    Returns:
        StackSnapshot: valid snapshot.
    """
    path = tmp_path / "personal.json"
    write_stack(path)
    return build_snapshot(path, source_sha, GateEvidence.model_validate(GATES))


def test_snapshot_binds_sorted_canonical_stack_bytes(tmp_path: Path) -> None:
    """Use one compact sorted representation for snapshot digesting.

    Parameters:
        tmp_path (Path): private fixture directory

    Returns:
        None: None.
    """
    item = snapshot(tmp_path)
    canonical = stack_bytes(item.stack)
    assert item.stack_sha256 == canonical.sha256
    assert (
        canonical.contents
        == json.dumps(item.stack.model_dump(mode="json"), sort_keys=True, separators=(",", ":")).encode()
    )
    assert StackSnapshot.model_validate_json(item.model_dump_json()) == item


def test_snapshot_refuses_a_float_in_stack_settings(tmp_path: Path) -> None:
    """The consumer rejects floats, so the producer must refuse them before attesting."""
    path = tmp_path / "personal.json"
    write_stack(path, settings={"temperature": 0.5})
    with pytest.raises(ValidationError, match=r"Float at `\$\.settings\.temperature`"):
        build_snapshot(path, "a" * 40, GateEvidence.model_validate(GATES))


@pytest.mark.parametrize(
    "change",
    [
        {"schema_version": 2},
        {"source_sha": "A" * 40},
        {"source_sha": "a" * 39},
        {"stack_sha256": "0" * 64},
        {"stack": {"schema_version": 1, "name": "local", "core": CORE, "sources": ["./pkg"]}},
        {"gates": {**GATES, "stack_run_ids": [1, 1]}},
        {
            "gates": {
                **GATES,
                "owned_packages": [{"package": "pi-preset", "integrity": "sha512-" + "A" * 86 + "=="}],
            }
        },
        {"gates": {**GATES, "core": {"tag": "v1.3.0-nredd.6", "integrity": CORE["integrity"]}}},
    ],
)
def test_snapshot_rejects_tampering(tmp_path: Path, change: dict[str, Any]) -> None:
    """Reject altered schema, digest, personal stack, and gate evidence.

    Parameters:
        tmp_path (Path): private fixture directory
        change (dict[str, Any]): snapshot field replacement

    Returns:
        None: None.
    """
    item = snapshot(tmp_path)
    document = item.model_dump(mode="json") | change
    with pytest.raises(ValidationError):
        StackSnapshot.model_validate(document)


def fixture(name: str) -> Any:
    """Load one recorded GitHub API response.

    Parameters:
        name (str): file under `tests/fixtures`.

    Returns:
        Any: decoded JSON.
    """
    return json.loads((FIXTURES / name).read_text())


RULESET = [
    {
        "type": "required_status_checks",
        "parameters": {
            "required_status_checks": [{"context": "owned (ubuntu-24.04)", "integration_id": 15368}]
        },
    }
]
APP = 15368


def test_required_checks_from_real_ruleset() -> None:
    """The recorded `rules/branches/main` response lists all eight checks with their app."""
    checks = required_checks(flatten_pages(fixture("github-rules-main.json")))
    names = [check.context for check in checks]
    assert len(names) == 8
    assert "stack (ubuntu-24.04, personal)" in names
    assert names == sorted(set(names))
    assert {check.integration_id for check in checks} == {APP}
    assert required_checks(RULESET) == [RequiredCheck("owned (ubuntu-24.04)", APP)]


@pytest.mark.parametrize(
    ("rules", "message"),
    [
        ([], "no required status checks"),
        ([{"type": "deletion"}], "no required status checks"),
        ([{"type": "required_status_checks", "parameters": {}}], "malformed"),
        (
            [{"type": "required_status_checks", "parameters": {"required_status_checks": [{"app_id": 1}]}}],
            "invalid `context`",
        ),
        (
            [
                {
                    "type": "required_status_checks",
                    "parameters": {"required_status_checks": [{"context": "a", "integration_id": "x"}]},
                }
            ],
            "invalid `integration_id`",
        ),
    ],
)
def test_required_checks_fail_closed(rules: list[Any], message: str) -> None:
    """An empty, absent or malformed rules response never yields a check list.

    Parameters:
        rules (list[Any]): rules API response
        message (str): expected error text

    Returns:
        None: None.
    """
    with pytest.raises(ValueError, match=message):
        required_checks(rules)


def test_checks_against_real_check_runs() -> None:
    """Every real configured check succeeded on the recorded main SHA; a wrong SHA, failure or app refuses."""
    required = required_checks(flatten_pages(fixture("github-rules-main.json")))
    pages = fixture("github-check-runs.json")
    assert verify_required_checks(required, pages, FIXTURE_SHA) == [check.context for check in required]
    with pytest.raises(ValueError, match="did not succeed"):
        verify_required_checks(required, pages, "b" * 40)
    failed = copy.deepcopy(pages)
    failed[0]["check_runs"][0]["conclusion"] = "failure"
    with pytest.raises(ValueError, match="did not succeed"):
        verify_required_checks(required, failed, FIXTURE_SHA)
    with pytest.raises(ValueError, match="did not succeed"):
        verify_required_checks([*required, RequiredCheck("absent", None)], pages, FIXTURE_SHA)


def test_checks_require_the_configured_app() -> None:
    """A same-named check from another app does not satisfy a rule that names `integration_id`."""
    pages = copy.deepcopy(fixture("github-check-runs.json"))
    for run in pages[0]["check_runs"]:
        run["app"]["id"] = 1
    required = required_checks(flatten_pages(fixture("github-rules-main.json")))
    with pytest.raises(ValueError, match="did not succeed"):
        verify_required_checks(required, pages, FIXTURE_SHA)
    unpinned = [RequiredCheck(check.context, None) for check in required]
    assert verify_required_checks(unpinned, pages, FIXTURE_SHA)
    for run in pages[0]["check_runs"]:
        del run["app"]
    with pytest.raises(ValueError, match="did not succeed"):
        verify_required_checks(required, pages, FIXTURE_SHA)


@pytest.mark.parametrize("pages", [[[]], ["x"], [{"check_runs": {}}]])
def test_checks_reject_malformed_pages(pages: list[Any]) -> None:
    """A malformed API page is a `ValueError`, not a traceback.

    Parameters:
        pages (list[Any]): malformed API pages

    Returns:
        None: None.
    """
    with pytest.raises(ValueError, match="check_runs"):
        verify_required_checks([RequiredCheck("a", None)], pages, FIXTURE_SHA)


def artifacts_fixture() -> dict[str, Any]:
    """Load the recorded `actions/runs/<id>/artifacts` pages keyed by run ID.

    Returns:
        dict[str, Any]: run ID -> slurped artifact pages.
    """
    return {str(FIXTURE_RUN): fixture("github-run-artifacts.json")}


def test_stack_runs_match_real_recorded_run() -> None:
    """The recorded run has a live stack artifact bound to its run and SHA."""
    runs = fixture("github-runs.json")
    assert registry_stack_runs(runs, artifacts_fixture(), FIXTURE_SHA) == [FIXTURE_RUN]


def stack_job_block() -> str:
    """Return the `stack:` job text from `ci.yml`.

    Returns:
        str: the job's lines up to the next top-level job.
    """
    text = CI_WORKFLOW.read_text()
    start = text.index("\n  stack:\n")
    match = re.search(r"\n  [a-z-]+:\n", text[start + 1 :])
    assert match
    return text[start : start + 1 + match.start()]


def test_stack_signal_still_comes_from_ci() -> None:
    """Drift guard: the artifact template and its `steps.plan.outputs.run` gate remain promotion contracts."""
    block = stack_job_block()
    upload = block.index("name: stack-${{ matrix.os }}-${{ matrix.stack }}")
    step = block[block.rindex("- uses:", 0, upload) : upload]
    assert "actions/upload-artifact@" in step
    assert "steps.plan.outputs.run == 'true'" in step  # a docs-only or smoke cell never uploads
    assert promotion.PERSONAL_STACK_ARTIFACT == "stack-ubuntu-24.04-personal"


def test_stack_runs_accept_renamed_job_with_valid_artifact_evidence() -> None:
    """Job names are not evidence: a valid artifact qualifies the run whatever the matrix cell is called."""
    runs = fixture("github-runs.json")
    assert registry_stack_runs(runs, artifacts_fixture(), FIXTURE_SHA) == [FIXTURE_RUN]
    assert not hasattr(promotion, "PERSONAL_STACK_JOB")


@pytest.mark.parametrize(
    "mutate",
    [
        lambda run, artifacts: run.update(event="pull_request"),
        lambda run, artifacts: run.update(headBranch="topic"),
        lambda run, artifacts: run.update(conclusion="failure"),
        lambda run, artifacts: run.update(headSha="b" * 40),
        lambda run, artifacts: artifacts.clear(),
        lambda run, artifacts: artifacts[str(FIXTURE_RUN)][0]["artifacts"].clear(),
        lambda run, artifacts: artifacts[str(FIXTURE_RUN)][0]["artifacts"][3].update(expired=True),
        lambda run, artifacts: artifacts[str(FIXTURE_RUN)][0]["artifacts"][3].update(
            name="stack-macos-14-personal"
        ),
        lambda run, artifacts: artifacts[str(FIXTURE_RUN)][0]["artifacts"][3]["workflow_run"].update(
            head_sha="b" * 40
        ),
        lambda run, artifacts: artifacts[str(FIXTURE_RUN)][0]["artifacts"][3]["workflow_run"].update(id=1),
    ],
)
def test_stack_runs_reject_absent_expired_or_mismatched_evidence(mutate: Any) -> None:
    """Only successful push/main runs with job data and a live matching artifact qualify.

    Parameters:
        mutate (Any): mutation applied to the recorded run and artifacts.

    Returns:
        None: None.
    """
    runs = copy.deepcopy(fixture("github-runs.json"))
    artifacts = copy.deepcopy(artifacts_fixture())
    assert artifacts[str(FIXTURE_RUN)][0]["artifacts"][3]["name"] == promotion.PERSONAL_STACK_ARTIFACT
    mutate(runs[0], artifacts)
    with pytest.raises(ValueError, match="docs-only"):
        registry_stack_runs(runs, artifacts, FIXTURE_SHA)


@pytest.mark.parametrize("pages", ["x", [1], [{"artifacts": {}}]])
def test_stack_runs_reject_malformed_artifact_pages(pages: Any) -> None:
    """A malformed artifact response is a `ValueError`, not a traceback.

    Parameters:
        pages (Any): malformed API pages

    Returns:
        None: None.
    """
    with pytest.raises(ValueError, match="rtifact"):
        registry_stack_runs(fixture("github-runs.json"), {str(FIXTURE_RUN): pages}, FIXTURE_SHA)


def test_owned_tags_and_gates_require_exact_owned_evidence(tmp_path: Path) -> None:
    """Gate evidence must cover exactly the stack's owned sources and keep the earliest run.

    Parameters:
        tmp_path (Path): private fixture directory

    Returns:
        None: None.
    """
    path = tmp_path / "personal.json"
    write_stack(path)
    stack = Stack.model_validate_json(path.read_bytes())
    assert owned_tags(stack) == ["@nredd/pi-preset@0.2.0"]
    owned = [OwnedPackageEvidence.model_validate(item) for item in [OWNED]]
    core = CoreEvidence.model_validate(CORE)
    gates = build_gates(stack, ["b", "a"], [9, 3], owned, core)
    assert gates.stack_run_ids == [3]
    with pytest.raises(ValueError, match="exactly"):
        build_gates(stack, ["a"], [3], [], core)
    with pytest.raises(ValueError, match="CI run"):
        build_gates(stack, ["a"], [], owned, core)


@pytest.mark.parametrize("operation", ["promote", "verify-only"])
def test_select_source_sha_accepts(operation: str) -> None:
    """Accept an exactly-shaped SHA for each operation.

    Parameters:
        operation (str): dispatch operation

    Returns:
        None: None.
    """
    assert select_source_sha(operation, "a" * 40) == "a" * 40


@pytest.mark.parametrize(
    ("operation", "sha"),
    [
        ("promote", "A" * 40),
        ("promote", "a" * 39),
        ("promote", ""),
        ("promote", "a" * 40 + "\n"),
        ("rollback", "a" * 40),
        ("delete", "a" * 40),
    ],
)
def test_select_source_sha_rejects(operation: str, sha: str) -> None:
    """Reject malformed SHAs and unknown operations (`rollback` no longer exists).

    Parameters:
        operation (str): dispatch operation
        sha (str): `source_sha` input

    Returns:
        None: None.
    """
    with pytest.raises(ValueError, match=r"source_sha|operation"):
        select_source_sha(operation, sha)


def git(repo: Path, *args: str) -> str:
    """Run Git in a disposable repository.

    Parameters:
        repo (Path): repository.
        *args (str): Git arguments.

    Returns:
        str: stripped stdout.
    """
    env = {"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t",
           "GIT_COMMITTER_EMAIL": "t@t", "PATH": "/usr/bin:/bin"}  # fmt: skip
    return subprocess.run(
        ["/usr/bin/git", "-C", str(repo), *args], check=True, capture_output=True, text=True, env=env
    ).stdout.strip()


def test_flatten_pages_flattens_lists_and_rejects_malformed_pages() -> None:
    """List pages are spread, object pages kept, anything else is a `ValueError`."""
    assert flatten_pages([[1, 2], {"a": 1}, []]) == [1, 2, {"a": 1}]
    for bad in ({"a": 1}, "x", [[1], 2], [None]):
        with pytest.raises(ValueError, match="JSON array"):
            flatten_pages(bad)


def test_candidate_runs_are_successful_push_main_runs_of_the_sha() -> None:
    """Only successful push/main runs of the SHA have their artifacts fetched."""
    runs = [
        *fixture("github-runs.json"),
        {**fixture("github-runs.json")[0], "databaseId": 7, "event": "pull_request"},
    ]
    assert candidate_run_ids(runs, FIXTURE_SHA) == [FIXTURE_RUN]
    assert candidate_run_ids(runs, "b" * 40) == []


def test_release_state_creates_resumes_or_refuses(tmp_path: Path) -> None:
    """No existing asset means create; an equal one resumes; a differing one fails closed.

    Parameters:
        tmp_path (Path): private fixture directory

    Returns:
        None: None.
    """
    rebuilt, existing = tmp_path / "rebuilt.json", tmp_path / "existing.json"
    rebuilt.write_bytes(b"{}")
    assert release_state(existing, rebuilt) == "create"
    existing.write_bytes(b"{}")
    assert release_state(existing, rebuilt) == "resume"
    existing.write_bytes(b'{"x":1}')
    with pytest.raises(ValueError, match="differs"):
        release_state(existing, rebuilt)


def test_tag_target_requires_the_selected_sha() -> None:
    """The release tag must be a lightweight tag resolving to the source SHA."""
    ref = {"object": {"sha": "a" * 40, "type": "commit"}}
    verify_tag_target(ref, "a" * 40)
    with pytest.raises(ValueError, match="not"):
        verify_tag_target(ref, "b" * 40)
    for bad in ({}, {"object": {}}, [], {"object": {"sha": 1}}):
        with pytest.raises(ValueError, match=r"object\.sha"):
            verify_tag_target(bad, "a" * 40)
    with pytest.raises(ValueError, match="annotated"):
        verify_tag_target({"object": {"sha": "a" * 40, "type": "tag"}}, "a" * 40)


def tagged_repo(tmp_path: Path) -> Path:
    """Create a repository with the owned package tag.

    Parameters:
        tmp_path (Path): private fixture directory.

    Returns:
        Path: the repository.
    """
    repo = tmp_path / "main"
    repo.mkdir()
    git(repo, "init", "-q", "-b", "main")
    (repo / "marker.txt").write_text("tagged")
    git(repo, "add", "marker.txt")
    git(repo, "commit", "-q", "-m", "release")
    git(repo, "tag", "@nredd/pi-preset@0.2.0")
    return repo


def preset_stack(tmp_path: Path) -> Stack:
    """Load the minimal personal stack.

    Parameters:
        tmp_path (Path): private fixture directory.

    Returns:
        Stack: the stack owning `@nredd/pi-preset@0.2.0`.
    """
    path = tmp_path / "personal.json"
    write_stack(path)
    return Stack.model_validate_json(path.read_bytes())


def test_collect_owned_evidence_checks_out_each_tag(tmp_path: Path) -> None:
    """Each owned tag gets its own worktree and is verified there, in stack order.

    Parameters:
        tmp_path (Path): private fixture directory

    Returns:
        None: None.
    """
    repo = tagged_repo(tmp_path)
    seen: list[tuple[str, str]] = []

    def check(tag: str, worktree: Path) -> OwnedPackageEvidence:
        """Record the checked-out tree instead of running npm.

        Parameters:
            tag (str): checked tag.
            worktree (Path): the tag's worktree.

        Returns:
            OwnedPackageEvidence: canned evidence.
        """
        seen.append((tag, (worktree / "marker.txt").read_text()))
        return OwnedPackageEvidence.model_validate(OWNED)

    work = tmp_path / "work"
    work.mkdir()
    evidence = collect_owned_evidence(preset_stack(tmp_path), repo, work, check)
    assert seen == [("@nredd/pi-preset@0.2.0", "tagged")]
    assert [item.package for item in evidence] == ["@nredd/pi-preset@0.2.0"]


def test_collect_owned_evidence_fails_on_missing_tag_and_failed_check(tmp_path: Path) -> None:
    """A missing tag is a `GitError` and a failing package check an `EvidenceError`, both chained.

    Parameters:
        tmp_path (Path): private fixture directory

    Returns:
        None: None.
    """
    repo = tagged_repo(tmp_path)
    git(repo, "tag", "-d", "@nredd/pi-preset@0.2.0")
    work = tmp_path / "work"
    work.mkdir()
    with pytest.raises(GitError, match="Command failed: /usr/bin/git") as missing:
        collect_owned_evidence(preset_stack(tmp_path), repo, work)
    assert missing.value.__cause__ is not None
    with pytest.raises(EvidenceError, match="Command failed") as failed:
        run_stack_check(repo, "@nredd/pi-preset@0.2.0", repo)  # no `scripts/npm_release.py` here
    assert failed.value.__cause__ is not None


def test_descends_from_uses_real_git_ancestry(tmp_path: Path) -> None:
    """Descendants pass; a diverged or later commit is refused."""
    repo = tmp_path / "repo"
    repo.mkdir()
    git(repo, "init", "-q", "-b", "main")
    git(repo, "commit", "-q", "--allow-empty", "-m", "one")
    one = git(repo, "rev-parse", "HEAD")
    git(repo, "commit", "-q", "--allow-empty", "-m", "two")
    two = git(repo, "rev-parse", "HEAD")
    git(repo, "checkout", "-q", "-b", "side", one)
    git(repo, "commit", "-q", "--allow-empty", "-m", "side")
    side = git(repo, "rev-parse", "HEAD")
    assert descends_from(repo, one, two)
    assert descends_from(repo, two, two)
    assert not descends_from(repo, two, one)
    assert not descends_from(repo, side, two)


def test_descends_from_raises_a_distinct_chained_error(tmp_path: Path) -> None:
    """Git failing (not "not an ancestor") is a `GitError`, distinct from a `ValueError` refusal.

    Parameters:
        tmp_path (Path): private fixture directory

    Returns:
        None: None.
    """
    with pytest.raises(GitError, match="Could not compare") as error:
        descends_from(tmp_path, "a" * 40, "b" * 40)
    assert not isinstance(error.value, ValueError)


def test_publish_gate_imports_only_the_standard_library() -> None:
    """The write-privileged job installs nothing, so `publish_gate` may not need a dependency."""
    tree = ast.parse(Path(publish_gate.__file__).read_text())
    modules = {
        alias.name.split(".")[0]
        for node in ast.walk(tree)
        if isinstance(node, ast.Import)
        for alias in node.names
    } | {
        node.module.split(".")[0]
        for node in ast.walk(tree)
        if isinstance(node, ast.ImportFrom) and node.module
    }
    assert modules <= set(sys.stdlib_module_names) | {"__future__"}


NEW_CORE_TAG = "v1.3.0-nredd.8"
NEW_ASSET = "earendil-works-pi-coding-agent-1.3.0.tgz"
ASSET_BYTES = b"asset"


def core_stack(tmp_path: Path, tag: str, digest: str) -> Stack:
    """Build a stack whose core release records one asset digest.

    Parameters:
        tmp_path (Path): private fixture directory.
        tag (str): core release tag.
        digest (str): recorded SHA-256 of the asset.

    Returns:
        Stack: the stack.
    """
    path = tmp_path / "core-stack.json"
    write_stack(path, core={"tag": tag, "integrity": {NEW_ASSET: digest}})
    return Stack.model_validate_json(path.read_bytes())


def fake_fetch(url: str, destination: Path) -> None:
    """Write canned bytes instead of downloading.

    Parameters:
        url (str): requested asset URL, which must be the tag's release URL.
        destination (Path): file to write.
    """
    assert url == f"https://github.com/nredd/pi/releases/download/{NEW_CORE_TAG}/{NEW_ASSET}"
    destination.write_bytes(ASSET_BYTES)


def test_core_assets_are_hashed_and_attested_for_new_tags(tmp_path: Path) -> None:
    """Every recorded asset is downloaded, matched to its digest and provenance-verified at its tag."""
    digest = hashlib.sha256(ASSET_BYTES).hexdigest()
    attested: list[tuple[str, str]] = []
    stack = core_stack(tmp_path, NEW_CORE_TAG, digest)
    verify_core_assets(
        stack, tmp_path / "core", fake_fetch, lambda path, tag: attested.append((path.name, tag))
    )
    assert attested == [(NEW_ASSET, NEW_CORE_TAG)]


def test_core_assets_refuse_wrong_bytes_and_failed_provenance(tmp_path: Path) -> None:
    """A digest mismatch or a provenance failure stops promotion; a download failure is evidence-level."""
    stack = core_stack(tmp_path, NEW_CORE_TAG, "0" * 64)
    with pytest.raises(AttestationError, match="expected"):
        verify_core_assets(stack, tmp_path / "core", fake_fetch, lambda path, tag: None)
    good = core_stack(tmp_path, NEW_CORE_TAG, hashlib.sha256(ASSET_BYTES).hexdigest())

    def reject(path: Path, tag: str) -> None:
        """Simulate `gh attestation verify` rejecting the asset.

        Parameters:
            path (Path): asset.
            tag (str): core tag.

        Raises:
            AttestationError: always.
        """
        raise AttestationError(f"no provenance for {path.name} at {tag}")

    with pytest.raises(AttestationError, match="no provenance"):
        verify_core_assets(good, tmp_path / "core", fake_fetch, reject)


def test_default_core_boundaries_translate_failures(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """`gh` rejection and network failure become domain errors chained to the cause."""
    stack = core_stack(tmp_path, NEW_CORE_TAG, hashlib.sha256(ASSET_BYTES).hexdigest())

    def refused(path: Path, tag: str) -> None:
        """Simulate the release verifier refusing.

        Parameters:
            path (Path): asset.
            tag (str): core tag.

        Raises:
            RuntimeError: always.
        """
        raise RuntimeError("provenance verification failed")

    monkeypatch.setattr(promotion, "verify_provenance", refused)
    with pytest.raises(AttestationError, match="provenance") as attest_error:
        verify_core_assets(stack, tmp_path / "a", fake_fetch)
    assert isinstance(attest_error.value.__cause__, RuntimeError)

    def offline(url: str, timeout: int) -> None:
        """Simulate an unreachable release host.

        Parameters:
            url (str): requested URL.
            timeout (int): requested timeout.

        Raises:
            OSError: always.
        """
        raise OSError("offline")

    monkeypatch.setattr(promotion, "urlopen", offline)
    with pytest.raises(EvidenceError, match="Could not download") as fetch_error:
        verify_core_assets(stack, tmp_path / "b")
    assert isinstance(fetch_error.value.__cause__, OSError)


def test_legacy_core_tags_skip_attestation(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Legacy `.3`-`.7` rely on frozen digests: nothing is downloaded or attested, so `core` runs offline."""
    tag = "v1.3.0-nredd.7"
    frozen = LEGACY_CHECKSUMS[tag]
    stack_path = tmp_path / "legacy.json"
    write_stack(stack_path, core={"tag": tag, "integrity": dict(frozen)})

    def forbidden(*_args: object, **_kwargs: object) -> None:
        """Fail if legacy validation touches the network or provenance verifier.

        Parameters:
            *_args (object): ignored positional arguments.
            **_kwargs (object): ignored keyword arguments.

        Raises:
            pytest.fail.Exception: always.
        """
        pytest.fail("legacy tags must not download or attest")

    monkeypatch.setattr(promotion, "urlopen", forbidden)
    monkeypatch.setattr(promotion, "verify_provenance", forbidden)
    stack = Stack.model_validate_json(stack_path.read_bytes())
    verify_core_assets(stack, tmp_path / "core")


FAKE_GH = """#!{python}
import json, os, sys
from pathlib import Path

state = Path(os.environ["FAKE_GH_DIR"])
argv = sys.argv[1:]
with (state / "calls.log").open("a") as log:
    log.write(json.dumps(argv) + "\\n")
for needle, code, out, err in json.loads((state / "rules.json").read_text()):
    if needle in " ".join(argv):
        if argv[:2] == ["release", "download"] and code == 0:
            (Path(argv[argv.index("--dir") + 1]) / "stack-snapshot.json").write_text(out)
        else:
            sys.stdout.write(out)
        sys.stderr.write(err)
        raise SystemExit(code)
sys.stderr.write("unexpected gh call: " + " ".join(argv))
raise SystemExit(99)
"""

SHA = "a" * 40


def fake_gh(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, rules: list[list[Any]]) -> Path:
    """Install a `gh` executable at the process boundary that answers from `rules`.

    Parameters:
        tmp_path (Path): private fixture directory.
        monkeypatch (pytest.MonkeyPatch): puts the stub first on `PATH`.
        rules (list[list[Any]]): `[argv substring, exit code, stdout, stderr]`, first match wins.

    Returns:
        Path: the stub's state directory (`calls.log` records every argv).
    """
    state = tmp_path / "fake-gh"
    state.mkdir(parents=True)
    (state / "rules.json").write_text(json.dumps(rules))
    (state / "calls.log").write_text("")
    binary = state / "bin" / "gh"
    binary.parent.mkdir()
    binary.write_text(FAKE_GH.format(python=sys.executable))
    binary.chmod(0o755)
    monkeypatch.setenv("FAKE_GH_DIR", str(state))
    monkeypatch.setenv("PATH", f"{binary.parent}:/usr/bin:/bin")
    return state


def refs_for(tag: str, sha: str, kind: str = "commit") -> str:
    """Build a slurped `matching-refs` response naming one tag.

    Parameters:
        tag (str): tag name.
        sha (str): object SHA.
        kind (str): git object type.

    Returns:
        str: JSON pages.
    """
    return json.dumps([[{"ref": f"refs/tags/{tag}", "object": {"sha": sha, "type": kind}}]])


def release_json(assets: list[str]) -> str:
    """Build a release response with the named assets.

    Parameters:
        assets (list[str]): asset names.

    Returns:
        str: release JSON.
    """
    return json.dumps({"assets": [{"name": name} for name in assets]})


def prepare(tmp_path: Path, rules: list[list[Any]], monkeypatch: pytest.MonkeyPatch) -> Any:
    """Run `prepare_release` against a stubbed `gh` with a rebuilt snapshot of `{}`.

    Parameters:
        tmp_path (Path): private fixture directory.
        monkeypatch (pytest.MonkeyPatch): process boundary.
        rules (list[list[Any]]): stub rules.

    Returns:
        Any: the release state.
    """
    fake_gh(tmp_path, monkeypatch, rules)
    rebuilt = tmp_path / "rebuilt.json"
    rebuilt.write_bytes(b"{}")
    return publish_gate.prepare_release("o/r", SHA, rebuilt, tmp_path / "existing")


TAG = f"stack/{SHA}"
REFS_API = ["matching-refs/tags/" + TAG, 0]


def test_prepare_release_creates_when_the_tag_is_absent(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An empty `matching-refs` (or only a prefix match) is the one "absent" answer."""
    assert prepare(tmp_path, [[*REFS_API, "[[]]", ""]], monkeypatch) == "create"
    other = json.dumps([[{"ref": f"refs/tags/{TAG}-x", "object": {"sha": SHA, "type": "commit"}}]])
    assert prepare(tmp_path / "prefix", [[*REFS_API, other, ""]], monkeypatch) == "create"


def test_prepare_release_resumes_a_matching_tag_and_asset(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A lightweight tag on the SHA with an equal snapshot asset resumes, after downloading it."""
    rules = [
        [*REFS_API, refs_for(TAG, SHA), ""],
        ["releases/tags/" + TAG, 0, release_json(["stack-snapshot.json"]), ""],
        ["release download", 0, "{}", ""],
    ]
    assert prepare(tmp_path, rules, monkeypatch) == "resume"
    assert (tmp_path / "existing" / "stack-snapshot.json").read_bytes() == b"{}"


@pytest.mark.parametrize(
    "stderr", ["HTTP 403: rate limit exceeded", "HTTP 502: Bad Gateway", "HTTP 404: Not Found"]
)
def test_prepare_release_fails_closed_on_any_gh_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, stderr: str
) -> None:
    """Every `gh` failure (even exit 1) is an error, never "tag absent"."""
    with pytest.raises(PublishError, match="Command failed"):
        prepare(tmp_path, [[*REFS_API[:1], 1, "", stderr]], monkeypatch)


def test_prepare_release_refuses_a_release_without_the_asset(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The tag exists but the release has no snapshot (or no release): refuse before any download."""
    rules = [
        [*REFS_API, refs_for(TAG, SHA), ""],
        ["releases/tags/" + TAG, 0, release_json(["other.txt"]), ""],
    ]
    with pytest.raises(PublishError, match=r"no stack-snapshot\.json"):
        prepare(tmp_path, rules, monkeypatch)
    assert "release download" not in (tmp_path / "fake-gh" / "calls.log").read_text()
    gone = [[*REFS_API, refs_for(TAG, SHA), ""], ["releases/tags/" + TAG, 1, "", "HTTP 404"]]
    with pytest.raises(PublishError, match="Command failed"):
        prepare(tmp_path / "gone", gone, monkeypatch)


def test_prepare_release_refuses_a_mismatched_or_annotated_tag(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A tag on another commit, or an annotated tag, refuses before the release is read."""
    with pytest.raises(ValueError, match="Tag points"):
        prepare(tmp_path, [[*REFS_API, refs_for(TAG, "b" * 40), ""]], monkeypatch)
    with pytest.raises(ValueError, match="annotated"):
        prepare(tmp_path / "ann", [[*REFS_API, refs_for(TAG, SHA, "tag"), ""]], monkeypatch)
    assert "releases/tags" not in (tmp_path / "ann" / "fake-gh" / "calls.log").read_text()


def test_prepare_release_refuses_a_differing_asset(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """An existing asset that differs from the rebuilt snapshot fails closed."""
    rules = [
        [*REFS_API, refs_for(TAG, SHA), ""],
        ["releases/tags/" + TAG, 0, release_json(["stack-snapshot.json"]), ""],
        ["release download", 0, '{"x":1}', ""],
    ]
    with pytest.raises(ValueError, match="differs"):
        prepare(tmp_path, rules, monkeypatch)


def test_confirm_tag_reads_the_exact_ref(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """`tag-target` fetches the ref itself and refuses an absent, moved or annotated tag."""
    fake_gh(tmp_path, monkeypatch, [[*REFS_API, refs_for(TAG, SHA), ""]])
    assert publish_gate.main(["tag-target", "--repo", "o/r", "--source-sha", SHA]) == 0
    assert publish_gate.main(["tag-target", "--repo", "o/r", "--source-sha", "b" * 40]) == 1


# promotion_verify: drive `verify()`/`main()` with a `gh` stub on PATH and real git repositories.


def verify_env(tmp_path: Path, operation: str, *, sha: str = "") -> dict[str, str]:
    """Build the workflow environment for `promotion_verify.main`.

    Parameters:
        tmp_path (Path): fixture directory holding `workspace`.
        operation (str): dispatch operation.
        sha (str): `source_sha` input.

    Returns:
        dict[str, str]: environment mapping.
    """
    return {
        "OPERATION": operation, "REQUESTED_SHA": sha,
        "GITHUB_REPOSITORY": "o/r", "GITHUB_WORKSPACE": str(tmp_path / "workspace"),
        "GITHUB_OUTPUT": str(tmp_path / "output"), "PROMO": str(tmp_path / "promo"),
        "RUNNER_TEMP": str(tmp_path / "runner"),
    }  # fmt: skip


def main_repo(tmp_path: Path) -> tuple[str, str, str]:
    """Create `origin` plus a `workspace` clone, and one commit that is not on `origin/main`.

    Parameters:
        tmp_path (Path): fixture directory.

    Returns:
        tuple[str, str, str]: `origin/main`'s first commit, its second, and an unmerged commit.
    """
    origin = tmp_path / "origin"
    origin.mkdir()
    git(origin, "init", "-q", "-b", "main")
    git(origin, "commit", "-q", "--allow-empty", "-m", "one")
    one = git(origin, "rev-parse", "HEAD")
    git(origin, "commit", "-q", "--allow-empty", "-m", "two")
    two = git(origin, "rev-parse", "HEAD")
    git(tmp_path, "clone", "-q", str(origin), "workspace")
    work = tmp_path / "workspace"
    git(work, "checkout", "-q", "-b", "side", one)
    git(work, "commit", "-q", "--allow-empty", "-m", "unmerged")
    side = git(work, "rev-parse", "HEAD")
    git(work, "checkout", "-q", "main")
    return one, two, side


def stub_candidate(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """Replace the evidence-heavy `build_candidate` with one that writes a valid snapshot.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): patches the module.
        tmp_path (Path): fixture directory.
    """

    def build(ctx: promotion_verify.VerifyContext, source_sha: str) -> None:
        """Write the candidate snapshot a real build would produce.

        Parameters:
            ctx (promotion_verify.VerifyContext): runner context.
            source_sha (str): selected commit.
        """
        (ctx.promo / "stack-snapshot.json").write_text(snapshot(tmp_path, source_sha).model_dump_json())

    monkeypatch.setattr(promotion_verify, "build_candidate", build)


def test_verify_refuses_a_sha_that_is_not_on_origin_main(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """The ancestor step runs against the fetched `origin/main`, before any evidence is read."""
    _one, _two, side = main_repo(tmp_path)
    fake_gh(tmp_path, monkeypatch, [])  # any gh call would exit 99
    assert promotion_verify.main(verify_env(tmp_path, "promote", sha=side)) == 1
    assert "is not an ancestor of 'origin/main'" in capsys.readouterr().err
    assert (tmp_path / "fake-gh" / "calls.log").read_text() == ""


def test_verify_writes_the_selected_sha_for_a_commit_on_origin_main(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An ancestor of `origin/main` builds the candidate and reads no channel, release or attestation."""
    _one, two, _side = main_repo(tmp_path)
    stub_candidate(monkeypatch, tmp_path)
    fake_gh(tmp_path, monkeypatch, [])  # any gh call would exit 99
    assert promotion_verify.main(verify_env(tmp_path, "verify-only", sha=two)) == 0
    assert f"source_sha={two}" in (tmp_path / "output").read_text()
    assert StackSnapshot.model_validate_json((tmp_path / "promo" / "stack-snapshot.json").read_bytes())
    assert (tmp_path / "fake-gh" / "calls.log").read_text() == ""


def test_verify_reports_a_failed_gh_call_without_a_traceback(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """A failing `gh` call exits 1 with a one-line `FAILED:` error, never a traceback."""
    _one, two, _side = main_repo(tmp_path)
    fake_gh(tmp_path, monkeypatch, [["rules/branches/main", 1, "", "HTTP 502"]])
    assert promotion_verify.main(verify_env(tmp_path, "verify-only", sha=two)) == 1
    err = capsys.readouterr().err
    assert err.startswith("FAILED:")
    assert "Traceback" not in err


def test_context_from_env_reports_every_missing_variable() -> None:
    """A missing required variable is a `ValueError` naming it, and `main` turns it into exit 1."""
    env = {"OPERATION": "promote", "GITHUB_REPOSITORY": "o/r"}
    with pytest.raises(ValueError, match="GITHUB_WORKSPACE, GITHUB_OUTPUT, PROMO"):
        promotion_verify.VerifyContext.from_env(env)
    assert promotion_verify.main(env) == 1


# Workflow shape.


def workflow() -> dict[str, Any]:
    """Parse `promote-stack.yml`.

    Returns:
        dict[str, Any]: the workflow mapping (`on` is parsed by YAML as `True`).
    """
    return yaml.safe_load(PROMOTION_WORKFLOW.read_text())


def test_workflow_permissions_environment_and_concurrency() -> None:
    """Least privilege per job, the approval environment only on the write job, one per-SHA queue."""
    wf = workflow()
    assert wf["permissions"] == {}
    jobs = wf["jobs"]
    assert jobs["verify"]["permissions"] == {"contents": "read", "actions": "read", "checks": "read"}
    assert jobs["attest-and-publish"]["permissions"] == {
        "contents": "write", "attestations": "write", "id-token": "write",
    }  # fmt: skip
    assert "environment" not in jobs["verify"]
    assert jobs["attest-and-publish"]["environment"] == "stack-promotion"
    assert all(job["if"].startswith("github.ref == 'refs/heads/main'") for job in jobs.values())
    assert wf["concurrency"]["cancel-in-progress"] is False
    assert wf["concurrency"]["group"] == "stack-promotion-${{ inputs.operation }}-${{ inputs.source_sha }}"
    assert all("concurrency" not in job for job in jobs.values())
    triggers = next(value for key, value in wf.items() if key in {True, "on"})  # YAML 1.1 reads `on` as True
    inputs = triggers["workflow_dispatch"]["inputs"]
    assert inputs["operation"]["options"] == ["verify-only", "promote"]
    assert set(inputs) == {"source_sha", "operation"}
    assert inputs["source_sha"]["required"] is True
    assert "secrets." not in PROMOTION_WORKFLOW.read_text()


def test_workflow_validates_the_tag_before_any_side_effect() -> None:
    """`prepare-release` precedes the attestation and release; `tag-target` confirms after them."""
    steps = workflow()["jobs"]["attest-and-publish"]["steps"]
    commands = [step.get("run", step.get("uses", "")) for step in steps]

    def index(needle: str) -> int:
        """Find the first step mentioning `needle`.

        Parameters:
            needle (str): substring of a `run:` or `uses:` value.

        Returns:
            int: its position.
        """
        return next(i for i, command in enumerate(commands) if needle in command)

    prepare_at = index("prepare-release")
    assert prepare_at < index("attest-build-provenance") < index("gh release create") < index("tag-target")
    assert index("gh attestation verify") < index("gh release create")
    assert commands[-1].endswith('tag-target --repo "$GITHUB_REPOSITORY" --source-sha "$SOURCE_SHA"')


ALLOWED_RUN_PREFIXES = (
    "uv sync --locked --directory integration",
    'uv run --locked --directory "$GITHUB_WORKSPACE/integration" python -m harness.',
    'PYTHONPATH="$GITHUB_WORKSPACE/integration" python3 -m harness.publish_gate ',
    "gh ",
)


def test_workflow_runs_are_single_allowlisted_commands_without_expressions() -> None:
    """Inputs reach `run:` only through `env:`; every `run:` is one allowlisted command."""
    runs = [step["run"] for job in workflow()["jobs"].values() for step in job["steps"] if "run" in step]
    assert runs
    for run in runs:
        assert "${{" not in run
        assert "\n" not in run.strip()
        assert run.startswith(ALLOWED_RUN_PREFIXES), run
        assert not re.search(r"\|\||\||&|;|>|<|`|\$\(", run), run
