"""Replay PR135's captured GitHub evidence and fail-closed counterexamples.

References:
    https://github.com/nredd/pi-harness/actions/runs/40072686016
    https://github.com/nredd/pi-harness/actions/runs/40072686131
"""

from __future__ import annotations

import copy
import json
import os
import re
import subprocess
import sys
import textwrap
from pathlib import Path
from typing import Any

import pytest
import yaml
from pydantic import ValidationError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import merge_pr_checks as checks

FIXTURE = Path(__file__).parent / "fixtures" / "merge-pr-135.json"
REPO = "nredd/pi-harness"


class Replay(checks.GitHub):
    """Serve projected real REST/CLI captures without credentials or mutations."""

    def __init__(self) -> None:
        """Load independent fixture state for each test.

        Returns:
            None: Initializes independent capture state and the recorded CLI call list.

        Raises:
            OSError: The captured fixture cannot be read.
            ValueError: The captured fixture contains invalid JSON.
        """
        self.data = json.loads(FIXTURE.read_text())
        # Keep the historical capture unchanged. Explicit synthetic successors extend
        # its replacement-run proof to the current matrix, not hosted WSL evidence.
        present = {job["name"] for job in self.data["new_jobs"]}
        template = next(job for job in self.data["new_jobs"] if job["name"] in checks.EXPECTED_MATRIX)
        for index, name in enumerate(sorted(checks.EXPECTED_MATRIX - present), start=1):
            job = copy.deepcopy(template)
            job["id"] += index * 100000
            job["name"] = name
            job["html_url"] = f"https://github.com/{REPO}/actions/runs/{job['run_id']}/job/{job['id']}"
            self.data["new_jobs"].append(job)
        self.old_run = self.data["runs"][1]
        self.commands: list[tuple[str, ...]] = []
        self.binary = "/fixture/gh"

    def command(self, *args: str) -> Any:
        """Replay exact read-only endpoints; unexpected requests fail the test.

        Parameters:
            *args (str): Read-only CLI arguments identifying the captured endpoint.

        Returns:
            Any: Captured JSON evidence for the requested endpoint.

        Raises:
            pytest.fail.Exception: The request has no captured response.
        """
        self.commands.append(args)
        if args[:2] == ("pr", "checks"):
            return self.data["checks"]
        endpoint = args[-1]
        if args[:3] == ("api", "--paginate", "--slurp"):
            return self.page_response(endpoint)
        objects = {
            f"repos/{REPO}/pulls/135": self.data["pr"],
            f"repos/{REPO}/rules/branches/main": self.data["rules"],
        }
        if endpoint in objects:
            return objects[endpoint]
        if "/actions/jobs/" in endpoint:
            return next(j for j in self.data["old_jobs"] if str(j["id"]) == endpoint.rsplit("/", 1)[1])
        if "/actions/runs/" in endpoint:
            return self.old_run
        if "/check-suites/" in endpoint:
            return self.data["suites"][endpoint.rsplit("/", 1)[1]]
        pytest.fail(f"Unexpected request: {args}")

    def page_response(self, endpoint: str) -> Any:
        """Return split captures to exercise real production pagination flattening.

        Parameters:
            endpoint (str): REST collection endpoint, including query parameters.

        Returns:
            Any: Captured records split into synthetic REST response pages.

        Raises:
            pytest.fail.Exception: The collection endpoint is unsupported.
        """
        if "/check-runs?" in endpoint:
            return [{"check_runs": self.data["check_runs"][:5]}, {"check_runs": self.data["check_runs"][5:]}]
        if "/actions/runs?" in endpoint:
            # Newest first is NOT an admission assumption; deliberately put it on page two.
            return [{"workflow_runs": self.data["runs"][1:]}, {"workflow_runs": self.data["runs"][:1]}]
        if endpoint.endswith("/jobs?per_page=100"):
            return [{"jobs": self.data["new_jobs"][:3]}, {"jobs": self.data["new_jobs"][3:]}]
        pytest.fail(f"Unexpected page request: {endpoint}")

    def gate(self) -> None:
        """Exercise the production gate, not a separate fixture classifier.

        Returns:
            None: Completes when the captured evidence permits admission.

        Raises:
            checks.CheckError: The replayed evidence does not permit merging.
            ValidationError: The replayed evidence has an invalid record shape.
        """
        checks.gate(self, REPO, "135", self.data["pr"]["head"]["sha"])


def test_captured_superseded_placeholders() -> None:
    """Real same-second runs and split pages pass only with complete successor proof.

    Returns:
        None: Completes after validating captured supersession and all nine contexts.
    """
    gh = Replay()
    assert gh.data["runs"][0]["created_at"] == gh.data["runs"][1]["created_at"]
    assert len([c for c in gh.data["checks"] if c["state"] == "CANCELLED"]) == 3
    gh.gate()
    assert len(gh.data["rules"][0]["parameters"]["required_status_checks"]) == 9


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("conclusion", "cancelled"),
        ("conclusion", "failure"),
        ("status", "in_progress"),
        ("workflow_id", 42),
        ("path", ".github/workflows/other.yml"),
        ("event", "push"),
        ("head_sha", "wrong"),
        ("run_number", 434),
    ],
)
def test_wrong_or_unsuccessful_successor(field: str, value: Any) -> None:
    """Pending, failed, latest cancelled and different-context executions block.

    Parameters:
        field (str): Successor execution field to corrupt.
        value (Any): Replacement value representing an inadmissible execution.

    Returns:
        None: Completes after the production gate refuses the successor.
    """
    gh = Replay()
    gh.data["runs"][0][field] = value
    with pytest.raises(checks.CheckError):
        gh.gate()


@pytest.mark.parametrize(
    ("side", "field"), [("base", "sha"), ("head", "sha"), ("base", "ref"), ("head", "ref")]
)
def test_wrong_pr_context(side: str, field: str) -> None:
    """Never use successes from a different base/head context.

    Parameters:
        side (str): PR side whose identity is changed, head or base.
        field (str): Branch identity field to corrupt, SHA or ref.

    Returns:
        None: Completes after the mismatched PR context is refused.
    """
    gh = Replay()
    gh.data["runs"][0]["pull_requests"][0][side][field] = "wrong"
    with pytest.raises(checks.CheckError):
        gh.gate()


@pytest.mark.parametrize("change", ["missing", "pending", "failed", "skipped", "wrong_attempt", "wrong_sha"])
def test_incomplete_matrix(change: str) -> None:
    """A successful run summary cannot substitute for every actual matrix cell.

    Parameters:
        change (str): Missing-cell or unsuccessful-cell mutation to apply.

    Returns:
        None: Completes after incomplete matrix coverage is refused.
    """
    gh = Replay()
    job = next(j for j in gh.data["new_jobs"] if j["name"] in checks.EXPECTED_MATRIX)
    if change == "missing":
        gh.data["new_jobs"].remove(job)
    elif change == "wrong_attempt":
        job["run_attempt"] += 1
    elif change == "wrong_sha":
        job["head_sha"] = "wrong"
    else:
        job["conclusion"] = {"pending": None, "failed": "failure", "skipped": "skipped"}[change]
    with pytest.raises(checks.CheckError, match="matrix coverage"):
        gh.gate()


@pytest.mark.parametrize("target", ["old", "new"])
def test_wrong_app(target: str) -> None:
    """Same workflow labels from another app do not establish replacement.

    Parameters:
        target (str): Old or new execution whose producing app is changed.

    Returns:
        None: Completes after the wrong app identity is refused.
    """
    gh = Replay()
    run = gh.data["runs"][0 if target == "new" else 1]
    gh.data["suites"][str(run["check_suite_id"])]["app"]["id"] = 42
    with pytest.raises(checks.CheckError, match="app mismatch"):
        gh.gate()


@pytest.mark.parametrize("state", ["FAILURE", "PENDING", "CANCELLED", "TIMED_OUT"])
def test_optional_failure_blocks(state: str) -> None:
    """Required-only success never bypasses triggered optional workflow failures.

    Parameters:
        state (str): Non-success outcome of the additional optional check.

    Returns:
        None: Completes after the optional check blocks admission.
    """
    gh = Replay()
    gh.data["checks"].append({"name": "core (forks/pi)", "state": state, "link": "https://example.invalid"})
    with pytest.raises(checks.CheckError):
        gh.gate()


@pytest.mark.parametrize("change", ["executed", "ordinary", "not_cancelled", "wrong_job_sha"])
def test_not_a_stale_placeholder(change: str) -> None:
    """Only the exact zero-step cancelled matrix template gets special treatment.

    Parameters:
        change (str): Mutation that invalidates the historical placeholder proof.

    Returns:
        None: Completes after an executed, ordinary or mismatched job is refused.
    """
    gh = Replay()
    job = next(j for j in gh.data["old_jobs"] if j["name"].startswith("stack"))
    if change == "executed":
        job["steps"] = [{"name": "started"}]
    elif change == "ordinary":
        gh.data["checks"][0]["name"] = "stack (ubuntu-24.04, personal)"
    elif change == "not_cancelled":
        job["conclusion"] = "failure"
    else:
        job["head_sha"] = "wrong"
    with pytest.raises(checks.CheckError):
        gh.gate()


@pytest.mark.parametrize("change", ["missing", "app", "failure", "pending", "sha"])
def test_required_contexts_independent(change: str) -> None:
    """All nine app-bound contexts must independently succeed on the reviewed SHA.

    Parameters:
        change (str): Missing or invalid required-context evidence to introduce.

    Returns:
        None: Completes after the invalid required context blocks admission.
    """
    gh = Replay()
    job = next(j for j in gh.data["check_runs"] if j["name"].startswith("wsl2"))
    if change == "missing":
        gh.data["check_runs"].remove(job)
    elif change == "app":
        job["app"]["id"] = 42
    elif change == "sha":
        job["head_sha"] = "wrong"
    else:
        job["conclusion"] = "failure" if change == "failure" else None
    with pytest.raises(checks.CheckError, match="Required context"):
        gh.gate()


def test_newest_cancellation_after_success_blocks() -> None:
    """Do not choose an intermediate successful run when the newest run cancels.

    Returns:
        None: Completes after a later cancellation prevents stale-green admission.
    """
    gh = Replay()
    later = copy.deepcopy(gh.data["runs"][0])
    later["run_number"] += 1
    later["conclusion"] = "cancelled"
    gh.data["runs"].append(later)
    with pytest.raises(checks.CheckError, match="Latest workflow"):
        gh.gate()


def test_rerun_attempt_order() -> None:
    """A later attempt of the same workflow run can prove supersession.

    Returns:
        None: Completes after the later successful attempt is admitted.
    """
    gh = Replay()
    new, old = gh.data["runs"]
    new["id"], new["run_number"], new["run_attempt"] = old["id"], old["run_number"], 2
    for job in gh.data["new_jobs"]:
        job["run_id"], job["run_attempt"] = new["id"], 2
    gh.gate()


def test_expected_head_and_no_checks() -> None:
    """Head drift and absent checks refuse before any admission.

    Returns:
        None: Completes after both head drift and missing checks are refused.
    """
    gh = Replay()
    with pytest.raises(checks.CheckError, match="reviewed"):
        checks.gate(gh, REPO, "135", "wrong")
    gh.data["checks"] = []
    with pytest.raises(checks.CheckError, match="No checks"):
        gh.gate()


def test_workflow_matrix_contract() -> None:
    """CI matrix changes must update the bounded replacement proof explicitly.

    Returns:
        None: Completes after comparing the workflow matrices with the gate contract.
    """
    workflow = (Path(__file__).resolve().parents[2] / ".github/workflows/ci.yml").read_text()
    jobs = yaml.safe_load(workflow)["jobs"]
    expected = set()
    for name in ("owned", "contracts", "stack"):
        matrix = jobs[name]["strategy"]["matrix"]
        assert matrix["os"] == ["ubuntu-24.04", "macos-14", "wsl2"]
        assert "exclude" not in matrix
        for os_name in matrix["os"]:
            if name == "stack":
                assert matrix["stack"] == ["personal", "local"]
                expected |= {f"stack ({os_name}, {stack})" for stack in matrix["stack"]}
            else:
                expected.add(f"{name} ({os_name})")
    assert expected == checks.EXPECTED_MATRIX
    assert all(f"    name: {name}\n" in workflow for name in checks.MATRIX)


def test_cli_failures_and_pagination(monkeypatch: pytest.MonkeyPatch) -> None:
    """API failures are fatal; all returned pages, including empty pages, are consumed.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): Fixture replacing the CLI subprocess seam.

    Returns:
        None: Completes after empty evidence and CLI failure are refused.
    """
    gh = Replay()
    gh.data["runs"] = []
    with pytest.raises(checks.CheckError):
        gh.gate()

    def failed(cmd: list[str], **kwargs: Any) -> str:
        """Return a credential-free HTTP failure from the executable seam.

        Parameters:
            cmd (list[str]): CLI argument vector supplied by the gate.
            **kwargs (Any): Subprocess options accepted by the fixture replacement.

        Raises:
            subprocess.CalledProcessError: Always reports the captured HTTP refusal.
        """
        raise subprocess.CalledProcessError(1, cmd, output="HTTP 403")

    monkeypatch.setattr(subprocess, "check_output", failed)
    with pytest.raises(checks.CheckError, match="HTTP 403"):
        checks.GitHub.command(gh, "api", "repos/example")


def corrupt_transcript(transcript: Path, mode: str) -> None:
    """Replace a transcript with the requested invalid filesystem entry.

    Parameters:
        transcript (Path): Disposable reviewer transcript file.
        mode (str): Requested path failure, or an unrelated unchanged mode.

    Returns:
        None: Leaves the requested invalid entry, or preserves unrelated modes.

    Raises:
        OSError: A disposable transcript entry cannot be replaced.
    """
    if mode not in ("directory-transcript", "missing-transcript", "dangling-transcript"):
        return
    transcript.unlink()
    if mode == "directory-transcript":
        transcript.mkdir()
    elif mode == "dangling-transcript":
        transcript.symlink_to(transcript.parent / "missing")


def poison_path(bin_dir: Path, tmp_path: Path, mode: str) -> Path:
    """Install hostile utility candidates without touching trusted executable inputs.

    Parameters:
        bin_dir (Path): Disposable PATH prefix.
        tmp_path (Path): Disposable test workspace.
        mode (str): Utility attack to install.

    Returns:
        Path: Marker created if any hostile executable or redirected gate runs.

    Raises:
        OSError: A disposable utility or redirected gate cannot be created.
    """
    injected = bin_dir / "gh"
    injected.write_text("#!/bin/sh\nexit 99\n")
    injected.chmod(0o755)
    poisoned = tmp_path / "poisoned"
    bypass = tmp_path / "bypass"
    bypass.mkdir()
    (bypass / "merge_pr_checks.py").write_text(f"from pathlib import Path\nPath({str(poisoned)!r}).touch()\n")
    utilities = {
        "poisoned-dirname": ("dirname",),
        "poisoned-path": ("dirname", "ls", "wc", "mktemp", "cat", "bash", "python3"),
    }.get(mode, ())
    for utility in utilities:
        executable = bin_dir / utility
        if executable.is_symlink():
            executable.unlink()
        executable.write_text(f"#!/bin/sh\n: > '{poisoned}'\nprintf '%s\\n' '{bypass}'\n")
        executable.chmod(0o755)
    return poisoned


def git_results(mode: str, source: Path) -> list[dict[str, Any]]:
    """Build real-shaped transcript results, including successful reads of this guard.

    Parameters:
        mode (str): Result outcome or malformed metadata case to exercise.
        source (Path): Actual helper source containing every negative diagnostic pattern.

    Returns:
        list[dict[str, Any]]: Transcript rows using the captured toolResult/isError contract.

    Raises:
        OSError: The actual helper source cannot be read.
    """
    diagnostics = {
        "unresolved-review": "fatal: bad revision HEAD",
        "git-unknown-revision": "git_diff: unknown revision",
        "git-ambiguous-argument": "fatal: ambiguous argument HEAD",
        "git-invalid-object": "fatal: Not a valid object HEAD",
        "git-corrected": "fatal: bad revision HEAD",
    }
    if mode not in diagnostics and mode not in (
        "git-quoted-source",
        "read-quoted-source",
        "git-no-status",
        "git-string-status",
        "git-null-status",
        "git-malformed-content",
    ):
        return []
    message: dict[str, Any] = {
        "role": "toolResult",
        "toolCallId": "review-diff",
        "toolName": "git_diff",
        "isError": mode in diagnostics,
        "content": [{"type": "text", "text": diagnostics.get(mode, source.read_text())}],
        "details": {},
    }
    if mode == "read-quoted-source":
        message["toolName"] = "read"
        del message["isError"]
    elif mode == "git-no-status":
        del message["isError"]
    elif mode in ("git-string-status", "git-null-status"):
        message["isError"] = "false" if mode == "git-string-status" else None
    elif mode == "git-malformed-content":
        message["content"] = [{"type": "text", "text": None}]
    rows = [{"message": message}]
    if mode == "git-corrected":
        rows.append(
            {"message": message | {"isError": False, "content": [{"type": "text", "text": "valid diff"}]}}
        )
    return rows


def reviewer_template_report(axis: str, sha: str, *, inline_none: bool) -> str:
    """Render the packed `code-reviewer` skeleton the way a reviewer would, for the real parser.

    Parameters:
        axis (str): Review axis to substitute for the template placeholder.
        sha (str): Full reviewed HEAD to substitute.
        inline_none (bool): Collapse `Findings:` and `None.` onto one line, the rejected form.

    Returns:
        str: A final report derived from the shipped template, not a hand-written fixture.
    """
    agent = Path(__file__).resolve().parents[2] / "packages" / "preset" / "agents" / "code-reviewer.md"
    match = re.search(r"```text\n(Axis: .*?)```", agent.read_text(), re.S)
    assert match, "code-reviewer.md lost its report skeleton"
    lines = match.group(1).splitlines()
    report = "\n".join(lines[: lines.index("Findings:") + 1])
    report = report.replace("<Standards|Spec>", axis).replace("<full-40-character-sha>", sha)
    report = re.sub(r"^- <rule.*$", "- Exact diff -- git_diff -- ok", report, flags=re.M)
    return report + (" None." if inline_none else "\nNone.")


@pytest.mark.parametrize(
    "mode",
    [
        "green",
        "head-drift",
        "unresolved-review",
        "optional-failure",
        "duplicate-id",
        "stale-head",
        "missing-head",
        "wrong-axis",
        "incidental-sha",
        "conflicting-receipt",
        "relative-root",
        "relative-gh",
        "relative-python",
        "final-wrong-head",
        "poisoned-dirname",
        "poisoned-path",
        "directory-transcript",
        "missing-transcript",
        "dangling-transcript",
        "git-quoted-source",
        "read-quoted-source",
        "template-skeleton",
        "template-inline-none",
        "git-unknown-revision",
        "git-ambiguous-argument",
        "git-invalid-object",
        "git-corrected",
        "git-no-status",
        "git-string-status",
        "git-null-status",
        "git-malformed-content",
    ],
)
def test_shell_receipt_and_merge_boundary(tmp_path: Path, mode: str) -> None:
    """Run the actual shell and Python gate, with only GitHub/transcript storage isolated.

    Parameters:
        tmp_path (Path): Fixture workspace for transcripts, fake GitHub and hostile utilities.
        mode (str): Receipt, executable, path or CI condition to exercise.

    Returns:
        None: Completes after checking receipt output and the exact mutation boundary.
    """
    scripts = Path(__file__).resolve().parents[1]
    root = tmp_path / "transcripts"
    tasks = root / "session" / "tasks"
    tasks.mkdir(parents=True)
    sha = Replay().data["pr"]["head"]["sha"]
    for task, axis in (("standards-id", "Standards"), ("spec-id", "Spec")):
        reviewed = "0" * 40 if mode in ("stale-head", "incidental-sha") else sha
        header = f"Axis: {axis}\nReviewed HEAD: {reviewed}\n"
        if mode == "missing-head":
            header = f"Axis: {axis}\n"
        elif mode == "wrong-axis":
            header = f"Axis: Spec\nReviewed HEAD: {sha}\n"
        elif mode == "conflicting-receipt":
            header += f"Reviewed HEAD: {'0' * 40}\n"
        report = header + "Checked:\n- Exact diff\nFindings:\nNone."
        if mode.startswith("template-"):
            report = reviewer_template_report(axis, sha, inline_none=mode == "template-inline-none")
        if mode == "incidental-sha":
            report += f"\nPrior request mentioned {sha}; this conclusion reviews {reviewed}."
        messages = [
            {
                "message": {
                    "role": "assistant",
                    "provider": "review",
                    "model": "fixture",
                    "content": [
                        {
                            "type": "toolCall",
                            "id": "review-diff",
                            "name": "git_diff",
                            "arguments": {"base": "main...HEAD"},
                        },
                    ],
                }
            }
        ]
        messages.extend(git_results(mode, scripts / "merge-pr.sh"))
        messages.append(
            {
                "message": {
                    "role": "assistant",
                    "provider": "review",
                    "model": "fixture",
                    "content": [{"type": "text", "text": report}],
                }
            }
        )
        if mode == "final-wrong-head":
            messages.append(
                {
                    "message": {
                        "role": "assistant",
                        "provider": "review",
                        "model": "fixture",
                        "content": [
                            {
                                "type": "text",
                                "text": f"Axis: {axis}\nReviewed HEAD: {'0' * 40}\n"
                                "Checked:\n- Other HEAD\nFindings:\nNone.",
                            }
                        ],
                    }
                }
            )
        (tasks / f"{task}.output").write_text("\n".join(json.dumps(m) for m in messages) + "\n")
    corrupt_transcript(tasks / "spec-id.output", mode)
    isolated = scripts / "merge-pr.sh"
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (bin_dir / "python3").symlink_to(sys.executable)
    poisoned = poison_path(bin_dir, tmp_path, mode)
    fake = tmp_path / "trusted-gh"
    fake.write_text(
        f"#!{sys.executable}\n"
        + textwrap.dedent("""
        import json, os, sys
        from pathlib import Path
        sys.path.insert(0, os.environ["REPLAY_TESTS"])
        from test_merge_pr_checks import Replay
        gh = Replay()
        args = tuple(sys.argv[1:])
        if args[:2] == ("pr", "view"):
            print("wrong" if os.environ["REPLAY_MODE"] == "head-drift" else
                  "MERGED" if "state" in args else gh.data["pr"]["head"]["sha"])
        elif args[:2] in (("pr", "comment"), ("pr", "merge")):
            with Path(os.environ["REPLAY_MUTATIONS"]).open("a") as out:
                out.write(json.dumps(args) + "\\n")
        else:
            if os.environ["REPLAY_MODE"] in ("optional-failure", "poisoned-dirname"):
                gh.data["checks"].append({"name": "optional", "state": "FAILURE", "link": ""})
            print(json.dumps(gh.command(*args)))
    """)
    )
    fake.chmod(0o755)
    mutations = tmp_path / "mutations"
    result = subprocess.run(
        [
            "/bin/bash",
            str(isolated),
            "135",
            sha,
            "standards-id",
            "standards-id" if mode == "duplicate-id" else "spec-id",
        ],
        env=os.environ
        | {
            "PATH": f"{bin_dir}:{os.environ['PATH']}",
            "REPLAY_TESTS": str(Path(__file__).parent),
            "REPLAY_MODE": mode,
            "REPLAY_MUTATIONS": str(mutations),
            "MERGE_PR_TRANSCRIPT_ROOT": "relative" if mode == "relative-root" else str(root),
            "MERGE_PR_GH": "gh" if mode == "relative-gh" else str(fake),
            "MERGE_PR_PYTHON": "python3" if mode == "relative-python" else sys.executable,
        },
        capture_output=True,
        text=True,
        check=False,
    )
    assert not poisoned.exists(), result.stderr
    if mode in ("green", "poisoned-path", "git-quoted-source", "read-quoted-source", "template-skeleton"):
        assert result.returncode == 0, result.stderr
        assert f"Review receipt, final HEAD `{sha}`" in result.stdout
        assert "`review/fixture`" in result.stdout
        calls = [json.loads(line) for line in mutations.read_text().splitlines()]
        assert calls[0][:2] == ["pr", "comment"]
        assert calls[1] == ["pr", "merge", "135", "--repo", REPO, "--merge", "--match-head-commit", sha]
    else:
        assert result.returncode != 0
        assert not mutations.exists()
        if mode in ("directory-transcript", "dangling-transcript"):
            assert "not a file" in result.stderr


@pytest.mark.parametrize("target", ["pr", "checks", "rules", "runs", "old_jobs", "new_jobs", "check_runs"])
def test_malformed_evidence_blocks(target: str) -> None:
    """Malformed identity records cannot enter the gate as untyped JSON assumptions.

    Parameters:
        target (str): Captured REST or CLI record collection to corrupt.

    Returns:
        None: Completes after typed evidence validation rejects the malformed record.
    """
    gh = Replay()
    if target == "pr":
        gh.data[target]["head"]["repo"]["id"] = "not-an-integer"
    elif target == "checks":
        del gh.data[target][0]["link"]
    elif target == "old_jobs":
        next(j for j in gh.data[target] if j["name"].startswith("stack"))["head_sha"] = 17
    elif target == "rules":
        gh.data[target][0]["parameters"]["required_status_checks"][0]["integration_id"] = "15368"
    else:
        del gh.data[target][0]["app" if target == "check_runs" else "id"]
    with pytest.raises(ValidationError):
        gh.gate()


@pytest.mark.parametrize("code", [0, 8, 1])
def test_subprocess_pending_and_failure(monkeypatch: pytest.MonkeyPatch, code: int) -> None:
    """Only pending `pr checks` may return parsed output after a nonzero CLI exit.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): Fixture replacing subprocess output collection.
        code (int): CLI exit code, zero, pending-check eight or fatal one.

    Returns:
        None: Completes after validating successful, pending and fatal CLI handling.
    """
    gh = Replay()

    def output(cmd: list[str], *, text: bool, stderr: int) -> str:
        """Check the prescribed subprocess contract and return or raise fixture output.

        Parameters:
            cmd (list[str]): Absolute executable and CLI argument vector.
            text (bool): Whether the subprocess returns decoded text.
            stderr (int): Requested stderr redirection, required to be STDOUT.

        Returns:
            str: Successful check JSON when the selected exit code is zero.

        Raises:
            subprocess.CalledProcessError: The selected CLI exit code is nonzero.
        """
        assert text is True
        assert stderr == subprocess.STDOUT
        if code:
            raise subprocess.CalledProcessError(code, cmd, output='[{"state":"PENDING"}]')
        return '[{"state":"SUCCESS"}]'

    monkeypatch.setattr(subprocess, "check_output", output)
    if code == 1:
        with pytest.raises(checks.CheckError):
            checks.GitHub.command(gh, "pr", "checks", "135")
    else:
        assert checks.GitHub.command(gh, "pr", "checks", "135")
    if code == 8:
        with pytest.raises(checks.CheckError):
            checks.GitHub.command(gh, "api", "repos/example")


@pytest.mark.parametrize("binary", ["gh", "/nonexistent/gh"])
def test_explicit_binary_validation(binary: str) -> None:
    """No PATH fallback can replace a missing explicit absolute executable.

    Parameters:
        binary (str): Relative or nonexistent executable path to refuse.

    Returns:
        None: Completes after the explicit executable validation fails closed.
    """
    with pytest.raises(checks.CheckError, match="trusted"):
        checks.GitHub(Path(binary))
