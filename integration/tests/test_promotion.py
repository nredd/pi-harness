"""Promotion snapshot serialization and fail-closed successor tests.

References:
- https://docs.github.com/actions/security-for-github-actions/using-artifact-attestations/using-artifact-attestations-to-establish-provenance-for-builds
"""

from __future__ import annotations

import copy
import json
import subprocess
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from harness import promotion
from harness.promotion import (
    CoreEvidence,
    GateEvidence,
    OwnedPackageEvidence,
    RequiredCheck,
    StackSnapshot,
    build_gates,
    build_snapshot,
    flatten_pages,
    owned_tags,
    registry_stack_runs,
    required_checks,
    select_source_sha,
    stack_bytes,
    verify_required_checks,
    verify_successor,
)
from harness.stack import Stack

FIXTURES = Path(__file__).parent / "fixtures"
CI_WORKFLOW = Path(__file__).parents[2] / ".github/workflows/ci.yml"
FIXTURE_SHA = "40e119a68a286cf498968605bcf9217359184e40"
FIXTURE_RUN = 39545048647

CORE = {
    "tag": "v1.3.0-nredd.7",
    "integrity": {"earendil-works-pi-coding-agent-1.3.0.tgz": "0" * 64},
}
GATES = {
    "required_checks": ["owned (ubuntu-24.04)"],
    "stack_run_ids": [123],
    "owned_packages": [{"package": "@nredd/pi-preset@0.2.0", "integrity": "sha512-" + "A" * 86 + "=="}],
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
    """Use one compact sorted representation for snapshot digesting."""
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
    """Reject altered schema, digest, personal stack, and gate evidence."""
    item = snapshot(tmp_path)
    document = item.model_dump(mode="json") | change
    with pytest.raises(ValidationError):
        StackSnapshot.model_validate(document)


def test_successor_accepts_seed_and_descendant(tmp_path: Path) -> None:
    """Allow the initial promotion and a Git-descendant candidate."""
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
    """Require a new source SHA descended from the current stable source."""
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
    """An empty, absent or malformed rules response never yields a check list."""
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
    """A malformed API page is a `ValueError`, not a traceback."""
    with pytest.raises(ValueError, match="check_runs"):
        verify_required_checks([RequiredCheck("a", None)], pages, FIXTURE_SHA)


def jobs_fixture() -> dict[str, dict[str, Any]]:
    """Load the recorded `gh run view --json jobs` response keyed by run ID.

    Returns:
        dict[str, dict[str, Any]]: run ID -> jobs response.
    """
    return {str(FIXTURE_RUN): fixture("github-run-jobs.json")}


def test_stack_runs_match_real_recorded_run() -> None:
    """The real step name (with its suffix) is recognized."""
    runs = fixture("github-runs.json")
    assert registry_stack_runs(runs, jobs_fixture(), FIXTURE_SHA) == [FIXTURE_RUN]


def test_stack_run_step_name_still_exists_in_ci() -> None:
    """Drift guard: the matched step prefix must still head a step name in `ci.yml`."""
    assert f"- name: {promotion.ASSEMBLED_STACK_STEP_PREFIX}" in CI_WORKFLOW.read_text()


@pytest.mark.parametrize(
    "mutate",
    [
        lambda run, jobs: run.update(event="pull_request"),
        lambda run, jobs: run.update(headBranch="topic"),
        lambda run, jobs: run.update(conclusion="failure"),
        lambda run, jobs: run.update(headSha="b" * 40),
        lambda run, jobs: jobs.clear(),
    ],
)
def test_stack_runs_reject_wrong_event_branch_or_missing_jobs(mutate: Any) -> None:
    """Only successful push/main runs of the selected SHA with job data qualify."""
    runs = copy.deepcopy(fixture("github-runs.json"))
    jobs = copy.deepcopy(jobs_fixture())
    mutate(runs[0], jobs)
    with pytest.raises(ValueError, match="docs-only"):
        registry_stack_runs(runs, jobs, FIXTURE_SHA)


def test_stack_runs_reject_skipped_assembled_step() -> None:
    """A skipped assembled step (the stack job gated off) is not evidence."""
    jobs = copy.deepcopy(jobs_fixture())
    for job in jobs[str(FIXTURE_RUN)]["jobs"]:
        if job["name"] == promotion.PERSONAL_STACK_JOB:
            for step in job["steps"]:
                if step["name"].startswith(promotion.ASSEMBLED_STACK_STEP_PREFIX):
                    step["conclusion"] = "skipped"
    with pytest.raises(ValueError, match="docs-only"):
        registry_stack_runs(fixture("github-runs.json"), jobs, FIXTURE_SHA)


def test_owned_tags_and_gates_require_exact_owned_evidence(tmp_path: Path) -> None:
    """Gate evidence must cover exactly the stack's owned sources and keep the earliest run."""
    path = tmp_path / "personal.json"
    write_stack(path)
    stack = Stack.model_validate_json(path.read_bytes())
    assert owned_tags(stack) == ["@nredd/pi-preset@0.2.0"]
    owned = [OwnedPackageEvidence.model_validate(item) for item in GATES["owned_packages"]]
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
    """Accept exactly-shaped inputs for each operation."""
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
    """Reject malformed SHAs, tags, and operation/input mixes."""
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
    """The `successor`/`ancestor` CLI gates use real ancestry, refusing divergent and rollback moves."""
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
    base = ["successor", "--repo", str(repo)]
    assert promotion.main(["ancestor", "--repo", str(repo), "--ancestor", one, "--descendant", two]) == 0
    assert promotion.main([*base, "--candidate", str(docs["one"])]) == 0
    assert promotion.main([*base, "--candidate", str(docs["two"]), "--stable", str(docs["one"])]) == 0
    assert promotion.main([*base, "--candidate", str(docs["one"]), "--stable", str(docs["two"])]) == 1
    assert promotion.main([*base, "--candidate", str(docs["side"]), "--stable", str(docs["two"])]) == 1
    assert promotion.main([*base, "--candidate", str(docs["one"]), "--stable", str(docs["one"])]) == 1
    assert promotion.main(["ancestor", "--repo", str(repo), "--ancestor", side, "--descendant", two]) == 1


def test_cli_rejects_non_personal_stack_and_bad_sha(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """`build` refuses a non-personal stack and a malformed SHA; `verify` pins the SHA."""
    gates = tmp_path / "gates.json"
    gates.write_text(json.dumps(GATES))
    personal = tmp_path / "personal.json"
    write_stack(personal)
    local = tmp_path / "local.json"
    write_stack(local, name="local", sources=["./pkg"])
    out = tmp_path / "out.json"

    def build(stack: Path, sha: str) -> int:
        """Run the `build` CLI."""
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
    assert json.loads(capsys.readouterr().out) == "a" * 40


def test_cli_checks_and_stack_runs_against_recorded_fixtures(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """The `checks` and `stack-runs` CLI stages read the real recorded API responses."""
    jobs = tmp_path / f"run-{FIXTURE_RUN}.json"
    jobs.write_text((FIXTURES / "github-run-jobs.json").read_text())
    args = ["--source-sha", FIXTURE_SHA]
    runs = ["stack-runs", "--runs", str(FIXTURES / "github-runs.json"), "--jobs-dir", str(tmp_path), *args]
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
