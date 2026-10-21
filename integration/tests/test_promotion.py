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
    channel_exists,
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
    verify_successor,
)
from harness.publish_gate import PublishError, advance_channel, release_state, verify_tag_target
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


def test_successor_accepts_seed_and_descendant(tmp_path: Path) -> None:
    """Allow the initial promotion and a Git-descendant candidate.

    Parameters:
        tmp_path (Path): private fixture directory

    Returns:
        None: None.
    """
    stable = snapshot(tmp_path, "a" * 40)
    candidate = snapshot(tmp_path, "b" * 40)
    verify_successor(stable, None, False)
    verify_successor(candidate, stable, True)


@pytest.mark.parametrize(
    ("source_sha", "descends", "message"),
    [
        ("a" * 40, True, "already"),
        ("b" * 40, False, "does not descend"),
    ],
)
def test_successor_rejects_stale_or_rollback_candidate(
    tmp_path: Path, source_sha: str, descends: bool, message: str
) -> None:
    """Require a new source SHA descended from the current stable source.

    Parameters:
        tmp_path (Path): private fixture directory
        source_sha (str): candidate source commit
        descends (bool): whether the candidate descends from stable
        message (str): expected error text

    Returns:
        None: None.
    """
    stable = snapshot(tmp_path, "a" * 40)
    with pytest.raises(ValueError, match=message):
        verify_successor(snapshot(tmp_path, source_sha), stable, descends)


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


@pytest.mark.parametrize(
    ("operation", "sha", "tag", "expected"),
    [
        ("promote", "a" * 40, "", "a" * 40),
        ("verify-only", "a" * 40, "", "a" * 40),
        ("rollback", "", "stack/" + "c" * 40, "c" * 40),
    ],
)
def test_select_source_sha_accepts(operation: str, sha: str, tag: str, expected: str) -> None:
    """Accept exactly-shaped inputs for each operation.

    Parameters:
        operation (str): dispatch operation
        sha (str): `source_sha` input
        tag (str): `rollback_tag` input
        expected (str): expected selected SHA

    Returns:
        None: None.
    """
    assert select_source_sha(operation, sha, tag) == expected


@pytest.mark.parametrize(
    ("operation", "sha", "tag"),
    [
        ("promote", "A" * 40, ""),
        ("promote", "a" * 39, ""),
        ("promote", "", ""),
        ("promote", "a" * 40, "stack/" + "c" * 40),
        ("rollback", "", "stack/" + "c" * 39),
        ("rollback", "", "stack/" + "C" * 40),
        ("rollback", "", "stack/" + "c" * 40 + "\n"),
        ("rollback", "", "xstack/" + "c" * 40),
        ("rollback", "a" * 40, "stack/" + "c" * 40),
        ("delete", "a" * 40, ""),
    ],
)
def test_select_source_sha_rejects(operation: str, sha: str, tag: str) -> None:
    """Reject malformed SHAs, tags, and operation/input mixes.

    Parameters:
        operation (str): dispatch operation
        sha (str): `source_sha` input
        tag (str): `rollback_tag` input

    Returns:
        None: None.
    """
    with pytest.raises(ValueError, match=r"source_sha|Rollback|operation"):
        select_source_sha(operation, sha, tag)


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


def test_successor_and_descends_from_use_real_git(tmp_path: Path) -> None:
    """Real ancestry: descendants pass; stale, divergent and duplicate candidates are refused."""
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
    snaps = {name: snapshot(tmp_path, sha) for name, sha in {"one": one, "two": two, "side": side}.items()}

    def gate(candidate: str, stable: str | None) -> None:
        """Run the real-ancestry successor gate.

        Parameters:
            candidate (str): candidate name.
            stable (str | None): stable name, or `None` for the seed.
        """
        current = snaps[stable] if stable else None
        descends = current is not None and descends_from(
            repo, current.source_sha, snaps[candidate].source_sha
        )
        verify_successor(snaps[candidate], current, descends)

    assert descends_from(repo, one, two)
    assert not descends_from(repo, side, two)
    gate("one", None)
    gate("two", "one")
    for candidate, stable in (("one", "two"), ("side", "two"), ("one", "one")):
        with pytest.raises(ValueError, match="stable"):
            gate(candidate, stable)


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


def test_channel_exists_ignores_prefix_matches() -> None:
    """`matching-refs` is a prefix match; only the exact branch counts."""
    assert channel_exists([[{"ref": "refs/heads/stack-channel"}]])
    assert not channel_exists([[]])
    assert not channel_exists([[{"ref": "refs/heads/stack-channel-old"}]])
    with pytest.raises(ValueError, match="JSON array"):
        channel_exists({"ref": "refs/heads/stack-channel"})


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


def test_advance_channel_requires_deploy_key(tmp_path: Path) -> None:
    """The write boundary refuses before touching Git when its ruleset bypass key is absent.

    Parameters:
        tmp_path (Path): private snapshot and temporary paths.

    Returns:
        None: None.
    """
    snapshot = tmp_path / "snapshot.json"
    snapshot.write_bytes(b"{}")
    with pytest.raises(PublishError, match="STACK_CHANNEL_DEPLOY_KEY"):
        advance_channel("nredd/pi-harness", "a" * 40, snapshot, "", tmp_path)


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


def channel_fixture(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[Path, Path, list[str]]:
    """Create a bare `stack-channel` remote and a working checkout with linear plus diverged commits.

    Parameters:
        tmp_path (Path): private fixture directory.
        monkeypatch (pytest.MonkeyPatch): chdirs into the checkout and stubs the SSH host-key fetch.

    Returns:
        tuple[Path, Path, list[str]]: remote, checkout, and the SHAs `[c1, c2, side]` where `c2`
            descends from `c1` and `side` forks from `c1`.
    """
    remote, work = tmp_path / "remote.git", tmp_path / "work"
    remote.mkdir()
    git(remote, "init", "-q", "--bare")
    work.mkdir()
    git(work, "init", "-q", "-b", "main")
    shas: list[str] = []
    for name in ("c1", "c2"):
        (work / "f.txt").write_text(name)
        git(work, "add", "f.txt")
        git(work, "commit", "-q", "-m", name)
        shas.append(git(work, "rev-parse", "HEAD"))
    git(work, "checkout", "-q", "-b", "side", shas[0])
    (work / "f.txt").write_text("side")
    git(work, "commit", "-q", "-am", "side")
    shas.append(git(work, "rev-parse", "HEAD"))
    git(work, "checkout", "-q", "main")
    monkeypatch.setattr(publish_gate, "ssh_host_keys", lambda: "github.com ssh-ed25519 AAAA\n")
    monkeypatch.chdir(work)
    return remote, work, shas


def snapshot_for(tmp_path: Path, sha: str) -> Path:
    """Write a minimal snapshot naming `sha` (the channel gate only reads `source_sha`).

    Parameters:
        tmp_path (Path): fixture directory.
        sha (str): commit.

    Returns:
        Path: the snapshot file.
    """
    path = tmp_path / f"snapshot-{sha[:8]}.json"
    path.write_bytes(json.dumps({"source_sha": sha}, sort_keys=True, separators=(",", ":")).encode())
    return path


def advance(tmp_path: Path, remote: Path, sha: str, *, require_successor: bool = False) -> None:
    """Run `advance_channel` against the bare remote.

    Parameters:
        tmp_path (Path): fixture directory.
        remote (Path): bare remote.
        sha (str): candidate commit.
        require_successor (bool): whether to apply the live-tip ancestry gate.
    """
    advance_channel(
        "o/r", sha, snapshot_for(tmp_path, sha), "KEY", tmp_path,
        require_successor=require_successor, remote=str(remote),
    )  # fmt: skip


def channel_tip(remote: Path) -> tuple[str, str]:
    """Return the remote `stack-channel` commit and its `stable.json`.

    Parameters:
        remote (Path): bare remote.

    Returns:
        tuple[str, str]: commit SHA and file contents.
    """
    return git(remote, "rev-parse", "stack-channel"), git(remote, "show", "stack-channel:stable.json")


def test_advance_channel_seeds_then_noops_at_the_target(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A missing branch is seeded as an orphan with only `stable.json`; a repeat pushes nothing."""
    remote, _work, (c1, *_rest) = channel_fixture(tmp_path, monkeypatch)
    advance(tmp_path, remote, c1, require_successor=True)
    tip, content = channel_tip(remote)
    assert json.loads(content)["source_sha"] == c1
    assert git(remote, "ls-tree", "--name-only", tip) == "stable.json"
    advance(tmp_path, remote, c1, require_successor=True)
    assert channel_tip(remote)[0] == tip
    assert not (tmp_path / "stack-channel-key").exists()


def test_advance_channel_requires_a_successor_of_the_live_tip(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Promotion re-checks ancestry against the live tip; rollback may move anywhere."""
    remote, _work, (c1, c2, side) = channel_fixture(tmp_path, monkeypatch)
    advance(tmp_path, remote, c1)
    advance(tmp_path, remote, c2, require_successor=True)
    tip = channel_tip(remote)[0]
    for stale in (c1, side):
        with pytest.raises(ValueError, match="does not descend"):
            advance(tmp_path, remote, stale, require_successor=True)
    assert channel_tip(remote)[0] == tip
    advance(tmp_path, remote, c1)  # rollback
    assert json.loads(channel_tip(remote)[1])["source_sha"] == c1


def test_advance_channel_refuses_same_commit_with_different_bytes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A tip naming the candidate commit but holding other bytes is not silently replaced."""
    remote, _work, (c1, *_rest) = channel_fixture(tmp_path, monkeypatch)
    advance(tmp_path, remote, c1)
    snapshot = tmp_path / "other.json"
    snapshot.write_bytes(json.dumps({"source_sha": c1, "x": 1}).encode())
    with pytest.raises(PublishError, match="different bytes"):
        advance_channel("o/r", c1, snapshot, "KEY", tmp_path, require_successor=True, remote=str(remote))


def test_advance_channel_surfaces_a_failing_push(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A rejected push raises `PublishError` and leaves the remote untouched."""
    remote, _work, (c1, c2, _side) = channel_fixture(tmp_path, monkeypatch)
    advance(tmp_path, remote, c1)
    before = channel_tip(remote)
    hook = remote / "hooks" / "pre-receive"
    hook.write_text("#!/bin/sh\necho rejected by ruleset >&2\nexit 1\n")
    hook.chmod(0o755)
    with pytest.raises(PublishError, match="git push"):
        advance(tmp_path, remote, c2, require_successor=True)
    assert channel_tip(remote) == before


def test_advance_channel_writes_the_key_privately_and_scrubs_the_environment(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The key is created `0600` and removed; git/ssh children get no tokens or secrets."""
    remote, _work, (c1, *_rest) = channel_fixture(tmp_path, monkeypatch)
    monkeypatch.setenv("GH_TOKEN", "token-leak")
    monkeypatch.setenv("DEPLOY_KEY", "key-leak")
    seen: list[dict[str, str] | None] = []
    real = publish_gate._command

    def spy(*args: str, **kwargs: Any) -> Any:
        """Record each child environment, then run the real command.

        Parameters:
            *args (str): command.
            **kwargs (Any): command options.

        Returns:
            Any: the completed process.
        """
        seen.append(kwargs.get("env"))
        return real(*args, **kwargs)

    monkeypatch.setattr(publish_gate, "_command", spy)
    modes: list[int] = []
    real_write = publish_gate._write_private
    monkeypatch.setattr(
        publish_gate,
        "_write_private",
        lambda path, content: (real_write(path, content), modes.append(path.stat().st_mode & 0o777))[0],
    )
    advance(tmp_path, remote, c1)
    assert modes == [0o600]
    assert seen
    for env in seen:
        assert env is not None
        assert set(env) == {"GIT_SSH_COMMAND", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "PATH", "HOME"}
    key = tmp_path / "stack-channel-key"
    key.write_text("stale")
    with pytest.raises(FileExistsError):
        advance(tmp_path, remote, c1)  # O_EXCL: never reuse a pre-existing key file


def stable_rules(sha: str, *, channel: bool = True) -> list[list[Any]]:
    """Build `gh` stub rules for a live `stack-channel` whose tip names `sha`.

    Parameters:
        sha (str): commit in the tip's `stable.json`.
        channel (bool): whether the channel branch exists.

    Returns:
        list[list[Any]]: stub rules.
    """
    listing = [[{"ref": "refs/heads/stack-channel"}]] if channel else [[]]
    return [
        ["matching-refs/heads/stack-channel", 0, json.dumps(listing), ""],
        ["contents/stable.json", 0, snapshot_for_bytes(sha), ""],
        ["attestation verify", 0, "", ""],
    ]


def snapshot_for_bytes(sha: str) -> str:
    """Return the minimal snapshot text used by `snapshot_for`.

    Parameters:
        sha (str): commit.

    Returns:
        str: compact JSON.
    """
    return json.dumps({"source_sha": sha}, sort_keys=True, separators=(",", ":"))


def preflight(tmp_path: Path, sha: str, operation: str = "promote", *, key_present: bool = True) -> None:
    """Run `preflight_channel` for a minimal snapshot.

    Parameters:
        tmp_path (Path): fixture directory.
        sha (str): candidate commit.
        operation (str): `promote` or `rollback`.
        key_present (bool): whether the deploy key secret is set.
    """
    publish_gate.preflight_channel(
        "o/r", sha, snapshot_for(tmp_path, sha),
        key_present=key_present, operation=operation,
        temp_dir=tmp_path, existing_dir=tmp_path / "retained",
    )  # fmt: skip


def test_preflight_passes_for_a_seed_a_descendant_and_an_identical_tip(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """No channel (seed), a descendant of the tip, and the same bytes all pass without writing."""
    _remote, _work, (c1, c2, _side) = channel_fixture(tmp_path, monkeypatch)
    fake_gh(tmp_path, monkeypatch, stable_rules(c1, channel=False))
    preflight(tmp_path, c1)
    fake_gh(tmp_path / "b", monkeypatch, stable_rules(c1))
    preflight(tmp_path, c2)
    fake_gh(tmp_path / "c", monkeypatch, stable_rules(c2))
    preflight(tmp_path, c2)


def test_preflight_refuses_before_any_side_effect(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A missing key, stale or diverged candidate, bad tip, or failed attestation all fail closed."""
    _remote, _work, (c1, c2, side) = channel_fixture(tmp_path, monkeypatch)
    with pytest.raises(PublishError, match="STACK_CHANNEL_DEPLOY_KEY"):
        preflight(tmp_path, c1, key_present=False)
    fake_gh(tmp_path, monkeypatch, stable_rules(c2))
    for stale in (c1, side):
        with pytest.raises(ValueError, match="does not descend"):
            preflight(tmp_path, stale)
    fake_gh(
        tmp_path / "b",
        monkeypatch,
        [*stable_rules(c1)[:1], ["contents/stable.json", 0, '{"source_sha":"--x"}', ""], stable_rules(c1)[2]],
    )
    with pytest.raises(PublishError, match="malformed"):
        preflight(tmp_path, c2)
    fake_gh(tmp_path / "c", monkeypatch, [*stable_rules(c1)[:2], ["attestation verify", 1, "", "no match"]])
    with pytest.raises(PublishError, match="no match"):
        preflight(tmp_path, c2)
    other = stable_rules(c2)
    other[1][2] = json.dumps({"source_sha": c2, "x": 1})
    fake_gh(tmp_path / "d", monkeypatch, other)
    with pytest.raises(PublishError, match="different bytes"):
        preflight(tmp_path, c2)


def test_preflight_rollback_requires_a_retained_promoted_snapshot(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A rollback target needs its tag, a release asset and byte-equal contents."""
    _remote, _work, (c1, *_rest) = channel_fixture(tmp_path, monkeypatch)
    tag = f"stack/{c1}"
    fake_gh(tmp_path, monkeypatch, [[f"matching-refs/tags/{tag}", 0, "[[]]", ""]])
    with pytest.raises(PublishError, match="not a previously promoted"):
        preflight(tmp_path, c1, "rollback")
    rules = [
        [f"matching-refs/tags/{tag}", 0, refs_for(tag, c1), ""],
        [f"releases/tags/{tag}", 0, release_json(["stack-snapshot.json"]), ""],
        ["release download", 0, snapshot_for_bytes(c1), ""],
    ]
    fake_gh(tmp_path / "b", monkeypatch, rules)
    preflight(tmp_path, c1, "rollback")


def test_preflight_cli_reads_the_key_flag_from_the_environment(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """`preflight-channel` exits 1 unless the flag variable is exactly `true`."""
    _remote, _work, (c1, *_rest) = channel_fixture(tmp_path, monkeypatch)
    fake_gh(tmp_path, monkeypatch, stable_rules(c1, channel=False))
    argv = [
        "preflight-channel", "--repo", "o/r", "--source-sha", c1,
        "--snapshot", str(snapshot_for(tmp_path, c1)), "--key-present-env", "HAS_KEY",
        "--temp-dir", str(tmp_path), "--existing-dir", str(tmp_path / "retained"),
        "--operation", "promote",
    ]  # fmt: skip
    monkeypatch.setenv("HAS_KEY", "false")
    assert publish_gate.main(argv) == 1
    assert "STACK_CHANNEL_DEPLOY_KEY" in capsys.readouterr().err
    monkeypatch.setenv("HAS_KEY", "true")
    assert publish_gate.main(argv) == 0


def test_tip_source_sha_validates_the_commit() -> None:
    """Only a 40-hex string is a usable revision; option-like values are refused."""
    assert publish_gate.tip_source_sha(b'{"source_sha":"' + b"a" * 40 + b'"}') == "a" * 40
    for bad in (
        b"{}",
        b"[",
        b'{"source_sha":"-x"}',
        b'{"source_sha":5}',
        b'{"source_sha":"' + b"A" * 40 + b'"}',
    ):
        with pytest.raises(PublishError):
            publish_gate.tip_source_sha(bad)


# promotion_verify: drive `verify()`/`main()` with a `gh` stub on PATH and real git repositories.


def verify_env(tmp_path: Path, operation: str, *, sha: str = "", tag: str = "") -> dict[str, str]:
    """Build the workflow environment for `promotion_verify.main`.

    Parameters:
        tmp_path (Path): fixture directory holding `workspace`.
        operation (str): dispatch operation.
        sha (str): `source_sha` input.
        tag (str): `rollback_tag` input.

    Returns:
        dict[str, str]: environment mapping.
    """
    return {
        "OPERATION": operation, "REQUESTED_SHA": sha, "ROLLBACK_TAG": tag,
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


def test_verify_seeds_a_missing_channel_and_requires_a_successor_otherwise(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """No channel is the seed; an attested descendant passes; stale, duplicate and bad evidence fail."""
    one, two, _side = main_repo(tmp_path)
    stub_candidate(monkeypatch, tmp_path)
    fake_gh(tmp_path, monkeypatch, stable_rules(one, channel=False))
    assert promotion_verify.main(verify_env(tmp_path, "promote", sha=two)) == 0
    assert f"source_sha={two}" in (tmp_path / "output").read_text()
    snapshot_text = snapshot(tmp_path, one).model_dump_json()
    fake_gh(
        tmp_path / "b",
        monkeypatch,
        [
            *stable_rules(one)[:1],
            ["contents/stable.json", 0, snapshot_text, ""],
            ["attestation verify", 0, "", ""],
        ],
    )
    assert promotion_verify.main(verify_env(tmp_path, "promote", sha=two)) == 0
    fake_gh(
        tmp_path / "c",
        monkeypatch,
        [
            *stable_rules(one)[:1],
            ["contents/stable.json", 0, snapshot_text, ""],
            ["attestation verify", 1, "", "bad signer"],
        ],
    )
    assert promotion_verify.main(verify_env(tmp_path, "promote", sha=two)) == 1
    assert "bad signer" in capsys.readouterr().err
    newer = snapshot(tmp_path, two).model_dump_json()
    fake_gh(
        tmp_path / "d",
        monkeypatch,
        [*stable_rules(one)[:1], ["contents/stable.json", 0, newer, ""], ["attestation verify", 0, "", ""]],
    )
    assert promotion_verify.main(verify_env(tmp_path, "promote", sha=two)) == 1
    assert "already is the stable snapshot" in capsys.readouterr().err
    assert promotion_verify.main(verify_env(tmp_path, "promote", sha=one)) == 1
    assert "does not descend" in capsys.readouterr().err


def test_verify_fails_closed_on_a_failing_gh_call(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """A `gh` failure (here the channel listing) exits 1 with one `FAILED:` line, never a seed."""
    _one, two, _side = main_repo(tmp_path)
    stub_candidate(monkeypatch, tmp_path)
    fake_gh(tmp_path, monkeypatch, [["matching-refs/heads/stack-channel", 1, "", "HTTP 502"]])
    assert promotion_verify.main(verify_env(tmp_path, "promote", sha=two)) == 1
    err = capsys.readouterr().err
    assert err.startswith("FAILED:")
    assert "HTTP 502" in err


def test_verify_rollback_downloads_attests_and_pins_the_snapshot(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """Rollback verifies the retained asset only; another commit's snapshot or a bad attestation fails."""
    one, _two, _side = main_repo(tmp_path)
    tag = f"stack/{one}"
    retained = snapshot(tmp_path, one).model_dump_json()
    fake_gh(tmp_path, monkeypatch, [["release download", 0, retained, ""], ["attestation verify", 0, "", ""]])
    assert promotion_verify.main(verify_env(tmp_path, "rollback", tag=tag)) == 0
    calls = (tmp_path / "fake-gh" / "calls.log").read_text()
    assert "matching-refs" not in calls
    mismatched = snapshot(tmp_path, "b" * 40).model_dump_json()
    fake_gh(
        tmp_path / "b",
        monkeypatch,
        [["release download", 0, mismatched, ""], ["attestation verify", 0, "", ""]],
    )
    assert promotion_verify.main(verify_env(tmp_path, "rollback", tag=tag)) == 1
    assert "differs" in capsys.readouterr().err
    fake_gh(
        tmp_path / "c",
        monkeypatch,
        [["release download", 0, retained, ""], ["attestation verify", 1, "", "unsigned"]],
    )
    assert promotion_verify.main(verify_env(tmp_path, "rollback", tag=tag)) == 1
    assert "unsigned" in capsys.readouterr().err


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


def step_names(job: str) -> list[str]:
    """List one job's step labels (name, else `uses`/`id`) in order.

    Parameters:
        job (str): job id.

    Returns:
        list[str]: labels.
    """
    return [step.get("name") or step.get("uses", "") for step in workflow()["jobs"][job]["steps"]]


def test_workflow_permissions_environment_and_concurrency() -> None:
    """Least privilege per job, the environment only on the write job, and the two queues."""
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
    assert "inputs.operation" in wf["concurrency"]["group"]
    assert "concurrency" not in jobs["verify"]
    assert jobs["attest-and-publish"]["concurrency"] == {
        "group": "stack-channel",
        "cancel-in-progress": False,
    }


def test_workflow_preflight_runs_before_any_side_effect() -> None:
    """`preflight-channel` precedes the attestation, release, tag and pointer steps."""
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

    preflight_at = index("preflight-channel")
    assert index("prepare-release") < preflight_at
    for side_effect in ("attest-build-provenance", "gh release create", "tag-target", "advance-channel"):
        assert preflight_at < index(side_effect)
    assert "DEPLOY_KEY" not in steps[preflight_at]["env"]  # only its presence is passed on
    advance = next(step for step in steps if "advance-channel" in step.get("run", ""))
    assert "GH_TOKEN" not in advance["env"]
    assert [name for name in advance["env"] if "KEY" in name] == ["DEPLOY_KEY"]


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
