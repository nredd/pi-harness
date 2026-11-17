"""Cover presentation filesystem, baseline and text edge cases at public boundaries.

References:
    https://github.com/nredd/pi-harness/issues/1001
"""

from __future__ import annotations

import json
import sys
import zipfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import coverage_report as report


@pytest.mark.parametrize("path", ["../a", "/a", "a//b", "a\\b", "", "safe-but-unplanned.py"])
def test_unsafe_source_paths_are_display_only(path: str) -> None:
    """Refuse artifact-supplied links, absolute paths and traversal in generated URLs.

    Parameters:
        path (str): Boundary input.

    Returns:
        None: The boundary contract is satisfied.

    Raises:
        AssertionError: The boundary contract regresses.
    """
    file = report.File("pkg/primary", path, report.Counters.parse({"lines": 1, "uncovered_lines": 0}))
    provenance = report.Provenance("example/repo", "a" * 40, "b" * 40, 1, 1)
    assert report.source_link(file, (), provenance) == report.escape(path)


def test_source_url_uses_trusted_root_and_tested_sha() -> None:
    """Encode hostile URL punctuation and link to the tested merge, not the PR head.

    Parameters:
        None.

    Returns:
        None: The boundary contract is satisfied.

    Raises:
        AssertionError: The boundary contract regresses.
    """
    file = report.File(
        "pkg/primary", "src/@owner(x).py", report.Counters.parse({"lines": 1, "uncovered_lines": 0})
    )
    signal = report.Signal.parse(
        "pkg/primary",
        {
            "state": "planned",
            "enforcement": "enforced",
            "reason": "",
            "semantics": "v1",
            "source_root": "packages/pkg",
        },
    )
    provenance = report.Provenance("example/repo", "a" * 40, "b" * 40, 1, 1)
    link = report.source_link(file, (signal,), provenance)
    assert f"https://github.com/example/repo/blob/{'b' * 40}/packages/pkg/src/%40owner%28x%29.py" in link
    assert "@owner" not in link


@pytest.mark.parametrize("root", ["../a", "/a", "a//b", "./a"])
def test_invalid_source_roots(root: str) -> None:
    """Reject unsafe trusted manifest paths before producing links.

    Parameters:
        root (str): Boundary input.

    Returns:
        None: The boundary contract is satisfied.

    Raises:
        AssertionError: The boundary contract regresses.
    """
    with pytest.raises(ValueError, match="source root"):
        report.Signal.parse(
            "pkg/primary",
            {
                "state": "planned",
                "enforcement": "enforced",
                "reason": "",
                "semantics": "v1",
                "source_root": root,
            },
        )


def test_invalid_manifest_host(tmp_path: Path) -> None:
    """Validate host identity before joining input artifact paths.

    Parameters:
        tmp_path (Path): Boundary input.

    Returns:
        None: The boundary contract is satisfied.

    Raises:
        AssertionError: The boundary contract regresses.
    """
    path = tmp_path / "manifest.json"
    path.write_text(json.dumps({"../../escape": {}}))
    with pytest.raises(ValueError, match="host"):
        report.load_evidence(tmp_path, path)


def test_zip_expanded_byte_limit(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Bound decompressed bytes even for a very small compressed ZIP.

    Parameters:
        tmp_path (Path): Boundary input.
        monkeypatch (pytest.MonkeyPatch): Boundary input.

    Returns:
        None: The boundary contract is satisfied.

    Raises:
        AssertionError: The boundary contract regresses.
    """
    path = tmp_path / "artifact.zip"
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("coverage/summary.json", " " * 10_000)
    monkeypatch.setattr(report, "MAX_ARCHIVE_BYTES", 1000)
    with pytest.raises(ValueError, match="expansion"):
        report.read_summary(path)


def test_cli_without_badges(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    """Keep SVG output optional on a successful CLI invocation.

    Parameters:
        tmp_path (Path): Disposable artifact directory.
        capsys (pytest.CaptureFixture[str]): Captured report stdout.

    Returns:
        None: The boundary contract is satisfied.

    Raises:
        AssertionError: The boundary contract regresses.
    """
    manifest = tmp_path / "manifest.json"
    manifest.write_text('{"wsl2":{"state":"NOT RUN","signals":{}}}')
    args = [
        "--artifacts",
        str(tmp_path),
        "--plan",
        str(manifest),
        "--repository",
        "example/repo",
        "--head-sha",
        "a" * 40,
        "--tested-sha",
        "b" * 40,
        "--run-id",
        "1",
        "--attempt",
        "1",
        "--output",
        str(tmp_path / "report.md"),
    ]
    assert report.main(args) == 0
    assert "WSL enforced signals: NOT RUN" in (tmp_path / "report.md").read_text()
    assert report.main(args[:-2]) == 0
    assert "WSL enforced signals: NOT RUN" in capsys.readouterr().out
