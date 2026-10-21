"""Promotion snapshot serialization and fail-closed successor tests.

References:
- https://docs.github.com/actions/security-for-github-actions/using-artifact-attestations/using-artifact-attestations-to-establish-provenance-for-builds
"""

from __future__ import annotations

import ast
import copy
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
    verify_required_checks,
    verify_successor,
)
from harness.publish_gate import release_state, verify_tag_target
from harness.stack import Stack

FIXTURES = Path(__file__).parent / "fixtures"
CI_WORKFLOW = Path(__file__).parents[2] / ".github/workflows/ci.yml"
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


def jobs_fixture() -> dict[str, dict[str, Any]]:
    """Load the recorded `gh run view --json jobs` response keyed by run ID.

    Returns:
        dict[str, dict[str, Any]]: run ID -> jobs response.
    """
    return {str(FIXTURE_RUN): fixture("github-run-jobs.json")}


def artifacts_fixture() -> dict[str, Any]:
    """Load the recorded `actions/runs/<id>/artifacts` pages keyed by run ID.

    Returns:
        dict[str, Any]: run ID -> slurped artifact pages.
    """
    return {str(FIXTURE_RUN): fixture("github-run-artifacts.json")}


def test_stack_runs_match_real_recorded_run() -> None:
    """The recorded run has a successful personal job and a live `stack-ubuntu-24.04-personal` artifact."""
    runs = fixture("github-runs.json")
    assert registry_stack_runs(runs, jobs_fixture(), artifacts_fixture(), FIXTURE_SHA) == [FIXTURE_RUN]


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
    """Drift guard: the job name and artifact templates render the names the verifier requires."""
    block = stack_job_block()
    assert "name: stack (${{ matrix.os }}, ${{ matrix.stack }})" in block
    job = "stack (ubuntu-24.04, personal)"
    assert promotion.PERSONAL_STACK_JOB.fullmatch(job)
    upload = block.index("name: stack-${{ matrix.os }}-${{ matrix.stack }}")
    step = block[block.rindex("- uses:", 0, upload) : upload]
    assert "actions/upload-artifact@" in step
    assert "steps.plan.outputs.run == 'true'" in step  # a docs-only or smoke cell never uploads
    assert promotion.PERSONAL_STACK_ARTIFACT == "stack-ubuntu-24.04-personal"


def test_recorded_run_proves_job_success_alone_is_not_evidence() -> None:
    """The real macOS personal cell is `success` on a main push although it skipped every step."""
    jobs = {job["name"]: job["conclusion"] for job in fixture("github-run-jobs.json")["jobs"]}
    assert jobs["stack (macos-14, personal)"] == "success"
    artifacts = {item["name"] for page in fixture("github-run-artifacts.json") for item in page["artifacts"]}
    assert "stack-macos-14-personal" not in artifacts


@pytest.mark.parametrize(
    "mutate",
    [
        lambda run, jobs, artifacts: run.update(event="pull_request"),
        lambda run, jobs, artifacts: run.update(headBranch="topic"),
        lambda run, jobs, artifacts: run.update(conclusion="failure"),
        lambda run, jobs, artifacts: run.update(headSha="b" * 40),
        lambda run, jobs, artifacts: jobs.clear(),
        lambda run, jobs, artifacts: artifacts.clear(),
        lambda run, jobs, artifacts: artifacts[str(FIXTURE_RUN)][0]["artifacts"].clear(),
        lambda run, jobs, artifacts: artifacts[str(FIXTURE_RUN)][0]["artifacts"][3].update(expired=True),
        lambda run, jobs, artifacts: artifacts[str(FIXTURE_RUN)][0]["artifacts"][3].update(
            name="stack-macos-14-personal"
        ),
        lambda run, jobs, artifacts: artifacts[str(FIXTURE_RUN)][0]["artifacts"][3]["workflow_run"].update(
            head_sha="b" * 40
        ),
        lambda run, jobs, artifacts: artifacts[str(FIXTURE_RUN)][0]["artifacts"][3]["workflow_run"].update(
            id=1
        ),
    ],
)
def test_stack_runs_reject_absent_expired_or_mismatched_evidence(mutate: Any) -> None:
    """Only successful push/main runs with job data and a live matching artifact qualify.

    Parameters:
        mutate (Any): mutation applied to the recorded runs, jobs and artifacts

    Returns:
        None: None.
    """
    runs = copy.deepcopy(fixture("github-runs.json"))
    jobs = copy.deepcopy(jobs_fixture())
    artifacts = copy.deepcopy(artifacts_fixture())
    assert artifacts[str(FIXTURE_RUN)][0]["artifacts"][3]["name"] == promotion.PERSONAL_STACK_ARTIFACT
    mutate(runs[0], jobs, artifacts)
    with pytest.raises(ValueError, match="docs-only"):
        registry_stack_runs(runs, jobs, artifacts, FIXTURE_SHA)


def test_stack_runs_reject_failed_personal_job_despite_artifact() -> None:
    """`ci.yml` uploads the artifact even on failure, so the job conclusion must still be `success`."""
    jobs = copy.deepcopy(jobs_fixture())
    for job in jobs[str(FIXTURE_RUN)]["jobs"]:
        if promotion.PERSONAL_STACK_JOB.fullmatch(job["name"]):
            job["conclusion"] = "failure"
    with pytest.raises(ValueError, match="docs-only"):
        registry_stack_runs(fixture("github-runs.json"), jobs, artifacts_fixture(), FIXTURE_SHA)


@pytest.mark.parametrize("pages", ["x", [1], [{"artifacts": {}}]])
def test_stack_runs_reject_malformed_artifact_pages(pages: Any) -> None:
    """A malformed artifact response is a `ValueError`, not a traceback.

    Parameters:
        pages (Any): malformed API pages

    Returns:
        None: None.
    """
    with pytest.raises(ValueError, match="rtifact"):
        registry_stack_runs(
            fixture("github-runs.json"), jobs_fixture(), {str(FIXTURE_RUN): pages}, FIXTURE_SHA
        )


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
    jobs = tmp_path / "jobs"
    jobs.mkdir()
    (jobs / f"run-{FIXTURE_RUN}.json").write_text((FIXTURES / "github-run-jobs.json").read_text())
    artifacts = tmp_path / "artifacts"
    artifacts.mkdir()
    (artifacts / f"run-{FIXTURE_RUN}.json").write_text((FIXTURES / "github-run-artifacts.json").read_text())
    args = ["--source-sha", FIXTURE_SHA]
    runs = [
        "stack-runs",
        "--runs", str(FIXTURES / "github-runs.json"),
        "--jobs-dir", str(jobs),
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
    """Only successful push/main runs of the SHA are fetched, printed for a shell loop.

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


def test_tag_target_requires_the_selected_sha(tmp_path: Path) -> None:
    """The release tag must resolve to the source SHA.

    Parameters:
        tmp_path (Path): private fixture directory

    Returns:
        None: None.
    """
    ref = {"object": {"sha": "a" * 40, "type": "commit"}}
    verify_tag_target(ref, "a" * 40)
    with pytest.raises(ValueError, match="not"):
        verify_tag_target(ref, "b" * 40)
    for bad in ({}, {"object": {}}, [], {"object": {"sha": 1}}):
        with pytest.raises(ValueError, match=r"object\.sha"):
            verify_tag_target(bad, "a" * 40)
    path = tmp_path / "ref.json"
    path.write_text(json.dumps(ref))
    assert publish_gate.main(["tag-target", "--ref", str(path), "--source-sha", "a" * 40]) == 0
    assert publish_gate.main(["tag-target", "--ref", str(path), "--source-sha", "b" * 40]) == 1


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
