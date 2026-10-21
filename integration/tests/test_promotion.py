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
from pydantic import ValidationError

from harness import promotion, publish_gate
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


def test_cli_successor_and_ancestor_use_real_git(tmp_path: Path) -> None:
    """The `successor`/`ancestor` CLI gates use real ancestry, refusing divergent and rollback moves.

    Parameters:
        tmp_path (Path): private fixture directory

    Returns:
        None: None.
    """
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
    docs = {}
    for name, sha in {"one": one, "two": two, "side": side}.items():
        docs[name] = tmp_path / f"{name}.json"
        docs[name].write_text(snapshot(tmp_path, sha).model_dump_json())
    none, has = tmp_path / "no-channel.json", tmp_path / "channel.json"
    none.write_text("[[]]")
    has.write_text(json.dumps([[{"ref": "refs/heads/stack-channel"}]]))
    absent = tmp_path / "absent.json"

    def successor(candidate: str, stable: Path, refs: Path) -> int:
        """Run the `successor` CLI against a stable file and a channel listing.

        Parameters:
            candidate (str): candidate snapshot name in `docs`.
            stable (Path): stable snapshot path.
            refs (Path): `matching-refs` response.

        Returns:
            int: the CLI exit code.
        """
        args = [
            "successor", "--repo", str(repo), "--candidate", str(docs[candidate]),
            "--refs", str(refs), "--stable", str(stable),
        ]  # fmt: skip
        return promotion.main(args)

    assert promotion.main(["ancestor", "--repo", str(repo), "--ancestor", one, "--descendant", two]) == 0
    assert successor("one", absent, none) == 0  # first seed: the channel does not exist
    assert successor("one", absent, has) == 1  # channel exists but stable could not be read: fail closed
    assert successor("two", docs["one"], has) == 0
    assert successor("one", docs["two"], has) == 1
    assert successor("side", docs["two"], has) == 1
    assert successor("one", docs["one"], has) == 1
    assert promotion.main(["ancestor", "--repo", str(repo), "--ancestor", side, "--descendant", two]) == 1


def test_cli_rejects_non_personal_stack_and_bad_sha(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """`build` refuses a non-personal stack and a malformed SHA; `verify` pins the SHA.

    Parameters:
        tmp_path (Path): private fixture directory
        capsys (pytest.CaptureFixture[str]): captured process output

    Returns:
        None: None.
    """
    gates = tmp_path / "gates.json"
    gates.write_text(json.dumps(GATES))
    personal = tmp_path / "personal.json"
    write_stack(personal)
    local = tmp_path / "local.json"
    write_stack(local, name="local", sources=["./pkg"])
    out = tmp_path / "out.json"

    def build(stack: Path, sha: str) -> int:
        """Run the `build` CLI.

        Parameters:
            stack (Path): stack file to build from.
            sha (str): `--source-sha` value.

        Returns:
            int: the CLI exit code.
        """
        return promotion.main(
            ["build", "--stack", str(stack), "--source-sha", sha, "--gates", str(gates), "--output", str(out)]
        )

    assert build(local, "a" * 40) == 1
    assert build(personal, "A" * 40) == 1
    assert not out.exists()
    assert build(personal, "a" * 40) == 0
    assert promotion.main(["verify", "--snapshot", str(out), "--source-sha", "a" * 40]) == 0
    assert promotion.main(["verify", "--snapshot", str(out), "--source-sha", "b" * 40]) == 1
    assert "FAILED" in capsys.readouterr().err
    assert promotion.main(["select", "--operation", "rollback", "--rollback-tag", "stack/xyz"]) == 1
    assert promotion.main(["select", "--operation", "promote", "--source-sha", "a" * 40]) == 0
    assert capsys.readouterr().out == "a" * 40 + "\n"


def test_cli_checks_and_stack_runs_against_recorded_fixtures(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """The `checks` and `stack-runs` CLI stages read the real recorded API responses.

    Parameters:
        tmp_path (Path): private fixture directory
        capsys (pytest.CaptureFixture[str]): captured process output

    Returns:
        None: None.
    """
    artifacts = tmp_path / "artifacts"
    artifacts.mkdir()
    (artifacts / f"run-{FIXTURE_RUN}.json").write_text((FIXTURES / "github-run-artifacts.json").read_text())
    args = ["--source-sha", FIXTURE_SHA]
    runs = [
        "stack-runs",
        "--runs", str(FIXTURES / "github-runs.json"),
        "--artifacts-dir", str(artifacts),
        *args,
    ]  # fmt: skip
    assert promotion.main(runs) == 0
    assert json.loads(capsys.readouterr().out) == [FIXTURE_RUN]
    checks = [
        "checks",
        "--rules", str(FIXTURES / "github-rules-main.json"),
        "--check-pages", str(FIXTURES / "github-check-runs.json"),
        *args,
    ]  # fmt: skip
    assert promotion.main(checks) == 0
    assert "stack (ubuntu-24.04, personal)" in capsys.readouterr().out
    empty = tmp_path / "empty-rules.json"
    empty.write_text("[[]]")
    assert promotion.main([*checks[:2], str(empty), *checks[3:]]) == 1
    assert "no required status checks" in capsys.readouterr().err


def test_flatten_pages_flattens_lists_and_rejects_malformed_pages() -> None:
    """List pages are spread, object pages kept, anything else is a `ValueError`."""
    assert flatten_pages([[1, 2], {"a": 1}, []]) == [1, 2, {"a": 1}]
    for bad in ({"a": 1}, "x", [[1], 2], [None]):
        with pytest.raises(ValueError, match="JSON array"):
            flatten_pages(bad)


def test_candidate_runs_print_one_id_per_line(capsys: pytest.CaptureFixture[str]) -> None:
    """Only successful push/main runs of the SHA are fetched by `fetch-artifacts`.

    Parameters:
        capsys (pytest.CaptureFixture[str]): captured process output

    Returns:
        None: None.
    """
    runs = [
        *fixture("github-runs.json"),
        {**fixture("github-runs.json")[0], "databaseId": 7, "event": "pull_request"},
    ]
    assert candidate_run_ids(runs, FIXTURE_SHA) == [FIXTURE_RUN]
    assert candidate_run_ids(runs, "b" * 40) == []
    assert (
        promotion.main(
            ["candidate-runs", "--runs", str(FIXTURES / "github-runs.json"), "--source-sha", FIXTURE_SHA]
        )
        == 0
    )
    assert capsys.readouterr().out == f"{FIXTURE_RUN}\n"


def test_channel_exists_ignores_prefix_matches() -> None:
    """`matching-refs` is a prefix match; only the exact branch counts."""
    assert channel_exists([[{"ref": "refs/heads/stack-channel"}]])
    assert not channel_exists([[]])
    assert not channel_exists([[{"ref": "refs/heads/stack-channel-old"}]])
    with pytest.raises(ValueError, match="JSON array"):
        channel_exists({"ref": "refs/heads/stack-channel"})


def test_release_state_creates_resumes_or_refuses(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    """No existing asset means create; an equal one resumes; a differing one fails closed.

    Parameters:
        tmp_path (Path): private fixture directory
        capsys (pytest.CaptureFixture[str]): captured process output

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
    args = ["release-state", "--existing", str(existing), "--rebuilt", str(rebuilt)]
    assert publish_gate.main(args) == 1
    existing.unlink()
    assert publish_gate.main(args) == 0
    assert capsys.readouterr().out == "create\n"


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
    with pytest.raises(GitError, match="Could not check out") as missing:
        collect_owned_evidence(preset_stack(tmp_path), repo, work)
    assert missing.value.__cause__ is not None
    with pytest.raises(EvidenceError, match="Package check failed") as failed:
        run_stack_check(repo, "@nredd/pi-preset@0.2.0", repo)  # no `scripts/npm_release.py` here
    assert failed.value.__cause__ is not None


def test_cli_owned_evidence_feeds_gates(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """`owned-evidence` writes the list that `gates` consumes, with no shell parsing between them.

    Parameters:
        tmp_path (Path): private fixture directory
        monkeypatch (pytest.MonkeyPatch): patches the package-check boundary

    Returns:
        None: None.
    """
    repo = tagged_repo(tmp_path)
    monkeypatch.setattr(
        promotion,
        "run_stack_check",
        lambda _repo, _tag, _worktree: OwnedPackageEvidence.model_validate(OWNED),
    )
    stack, work, owned = tmp_path / "personal.json", tmp_path / "work", tmp_path / "owned.json"
    write_stack(stack)
    work.mkdir()
    base = ["owned-evidence", "--stack", str(stack), "--repo", str(repo), "--workdir", str(work)]
    assert promotion.main([*base, "--output", str(owned)]) == 0
    assert json.loads(owned.read_text()) == [OWNED]
    files = {name: tmp_path / f"{name}.json" for name in ("checks", "stack-runs", "core", "gates")}
    files["checks"].write_text(json.dumps(["a"]))
    files["stack-runs"].write_text("[5]")
    files["core"].write_text(json.dumps(CORE))
    gates = [
        "gates", "--stack", str(stack), "--checks", str(files["checks"]),
        "--stack-runs", str(files["stack-runs"]), "--owned", str(owned),
        "--core", str(files["core"]), "--output", str(files["gates"]),
    ]  # fmt: skip
    assert promotion.main(gates) == 0
    assert json.loads(files["gates"].read_text())["stack_run_ids"] == [5]


def test_descends_from_raises_a_distinct_chained_error(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """Git failing (not "not an ancestor") is a `GitError` from the cause, printed as `FAILED:`.

    Parameters:
        tmp_path (Path): private fixture directory
        capsys (pytest.CaptureFixture[str]): captured process output

    Returns:
        None: None.
    """
    with pytest.raises(GitError, match="Could not compare") as error:
        descends_from(tmp_path, "a" * 40, "b" * 40)
    assert error.value.__cause__ is not None
    assert not isinstance(error.value, ValueError)
    args = ["ancestor", "--repo", str(tmp_path), "--ancestor", "a" * 40, "--descendant", "b" * 40]
    assert promotion.main(args) == 1
    assert "FAILED: Could not compare" in capsys.readouterr().err


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
    assert promotion.main(["core", "--stack", str(stack_path), "--workdir", str(tmp_path / "core")]) == 0


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
        monkeypatch (pytest.MonkeyPatch): chdirs into the checkout and installs the `gh meta` stub.

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
    fake_gh(tmp_path, monkeypatch, [["api meta", 0, "ssh-ed25519 AAAA\n", ""]])
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


def test_promotion_workflow_has_no_inline_expressions_or_shell_logic() -> None:
    """Inputs reach `run:` only through `env:`, and every `run:` is a single command."""
    text = PROMOTION_WORKFLOW.read_text()
    runs = re.findall(r"^\s+run: (.*)$", text, flags=re.MULTILINE)
    assert runs
    assert not any("${{" in run for run in runs)
    assert not re.search(r"^\s+run: [|>]", text, flags=re.MULTILINE)
    assert not any(token in run for run in runs for token in (">", "&&", " | ", ";"))
