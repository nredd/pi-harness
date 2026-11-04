"""`publish_gate` refusals driven through an injected `_command` replay.

`_command` is the write job's only process boundary, so every test replaces it with a recording
replay; no `gh` call leaves the process.
"""

from __future__ import annotations

import json
import runpy
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

from harness import publish_gate
from harness.publish_gate import PublishError

SHA = "a" * 40
TAG = f"stack/{SHA}"
REFS = json.dumps([[{"ref": f"refs/tags/{TAG}", "object": {"sha": SHA, "type": "commit"}}]])


def replay(
    monkeypatch: pytest.MonkeyPatch, rules: list[tuple[str, str, dict[str, str]]]
) -> list[tuple[str, ...]]:
    """Replace `_command` with a replay answering from `rules`.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): patches the module.
        rules (list[tuple[str, str, dict[str, str]]]): `(argv substring, stdout, files)`; first match
            wins, and `files` maps names written into a `release download`'s `--dir`.

    Returns:
        list[tuple[str, ...]]: every recorded argv.
    """
    calls: list[tuple[str, ...]] = []

    def command(*args: str, **_kwargs: Any) -> subprocess.CompletedProcess[str]:
        """Record one argv and answer from the first matching rule.

        Parameters:
            *args (str): argv.
            **_kwargs (Any): ignored `_command` options.

        Returns:
            subprocess.CompletedProcess[str]: the canned result.

        Raises:
            AssertionError: no rule matches.
        """
        calls.append(args)
        for needle, stdout, files in rules:
            if needle in " ".join(args):
                for name, contents in files.items():
                    (Path(args[args.index("--dir") + 1]) / name).write_text(contents)
                return subprocess.CompletedProcess(list(args), 0, stdout, "")
        raise AssertionError(f"unexpected command {args}")

    monkeypatch.setattr(publish_gate, "_command", command)
    return calls


def candidate(tmp_path: Path) -> tuple[Path, Path]:
    """Write a rebuilt snapshot and dependency graph.

    Parameters:
        tmp_path (Path): fixture directory.

    Returns:
        tuple[Path, Path]: the snapshot and graph paths.
    """
    rebuilt, graph = tmp_path / "rebuilt.json", tmp_path / "graph.json"
    rebuilt.write_text("{}")
    graph.write_text('{"graph":1}')
    return rebuilt, graph


def release(*assets: str) -> str:
    """Build a release response naming the assets.

    Parameters:
        *assets (str): asset names.

    Returns:
        str: JSON release.
    """
    return json.dumps({"assets": [{"name": name} for name in assets]})


def test_json_refuses_a_non_json_response(monkeypatch: pytest.MonkeyPatch) -> None:
    """A garbled `gh` answer is a `PublishError` naming the command, never treated as absent."""
    replay(monkeypatch, [("matching-refs", "<html>502</html>", {})])
    with pytest.raises(PublishError, match=r"^Unreadable response from gh api --paginate: "):
        publish_gate.confirm_tag("o/r", SHA)


def test_tag_refs_refuses_a_response_that_is_not_a_page_list(monkeypatch: pytest.MonkeyPatch) -> None:
    """An object where slurped pages belong is malformed, not an empty (absent) tag."""
    replay(monkeypatch, [("matching-refs", '{"message": "Not Found"}', {})])
    with pytest.raises(PublishError, match=rf"^Malformed matching-refs response for '{TAG}'$"):
        publish_gate.confirm_tag("o/r", SHA)


def test_prepare_release_refuses_a_missing_dependency_graph_before_any_read(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """New-format publication without its graph candidate stops before GitHub is asked anything."""
    calls = replay(monkeypatch, [])
    rebuilt, _graph = candidate(tmp_path)
    with pytest.raises(
        PublishError, match=r"^Required candidate dependency-graph.json is missing; publication refused$"
    ):
        publish_gate.prepare_release("o/r", SHA, rebuilt, tmp_path / "existing", tmp_path / "absent.json")
    assert calls == []


def test_prepare_release_refuses_a_graph_asset_that_did_not_download(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A listed graph asset that the download did not produce is never read as "create"."""
    calls = replay(
        monkeypatch,
        [
            ("matching-refs", REFS, {}),
            (f"releases/tags/{TAG}", release("stack-snapshot.json", "dependency-graph.json"), {}),
            ("--pattern stack-snapshot.json", "", {"stack-snapshot.json": "{}"}),
            ("--pattern dependency-graph.json", "", {}),
        ],
    )
    rebuilt, graph = candidate(tmp_path)
    with pytest.raises(PublishError, match=r"^Existing dependency graph was not downloaded$"):
        publish_gate.prepare_release("o/r", SHA, rebuilt, tmp_path / "existing", graph)
    assert [call[:3] for call in calls[2:]] == [("gh", "release", "download")] * 2


def test_confirm_tag_refuses_an_absent_tag(monkeypatch: pytest.MonkeyPatch) -> None:
    """After publication an empty `matching-refs` answer means the tag is missing."""
    replay(monkeypatch, [("matching-refs", "[[]]", {})])
    with pytest.raises(PublishError, match=rf"^Tag '{TAG}' does not exist after publication$"):
        publish_gate.confirm_tag("o/r", SHA)


def prepare_argv(tmp_path: Path, graph: Path) -> list[str]:
    """Build `prepare-release` arguments.

    Parameters:
        tmp_path (Path): fixture directory holding the rebuilt snapshot.
        graph (Path): dependency graph candidate.

    Returns:
        list[str]: CLI arguments.
    """
    return [
        "prepare-release",
        "--repo",
        "o/r",
        "--source-sha",
        SHA,
        "--rebuilt",
        str(tmp_path / "rebuilt.json"),
        "--existing-dir",
        str(tmp_path / "existing"),
        "--dependency-graph",
        str(graph),
        "--github-output",
        str(tmp_path / "output"),
    ]


def test_main_prepare_release_writes_the_state_output(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`prepare-release` writes `state=` for the next workflow step."""
    replay(monkeypatch, [("matching-refs", "[[]]", {})])
    _rebuilt, graph = candidate(tmp_path)
    assert publish_gate.main(prepare_argv(tmp_path, graph)) == 0
    assert (tmp_path / "output").read_text() == "state=create\n"


def test_main_prepare_release_reports_a_refusal_as_exit_1(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """A refused preparation exits 1 with one `FAILED:` line and writes no state."""
    replay(monkeypatch, [])
    candidate(tmp_path)
    assert publish_gate.main(prepare_argv(tmp_path, tmp_path / "absent.json")) == 1
    assert capsys.readouterr().err == (
        "FAILED: Required candidate dependency-graph.json is missing; publication refused\n"
    )
    assert not (tmp_path / "output").exists()


def test_module_entrypoint_exits_1_when_gh_cannot_run(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """`python -m harness.publish_gate` with no `gh` on `PATH` is a one-line refusal, not a traceback."""
    monkeypatch.setenv("PATH", str(tmp_path))
    monkeypatch.setattr(sys, "argv", ["publish_gate", "tag-target", "--repo", "o/r", "--source-sha", SHA])
    monkeypatch.delitem(sys.modules, "harness.publish_gate")
    with pytest.raises(SystemExit) as exit_info:
        runpy.run_module("harness.publish_gate", run_name="__main__")
    assert exit_info.value.code == 1
    err = capsys.readouterr().err
    assert err.startswith("FAILED: Command failed: gh api: ")
    assert "Traceback" not in err
