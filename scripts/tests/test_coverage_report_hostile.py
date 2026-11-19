"""Hostile-input, degraded-host and real-archive tests for the coverage presentation renderer.

References:
    https://github.com/nredd/pi-harness/issues/1001
"""

from __future__ import annotations

import json
import lzma
import struct
import sys
import zipfile
import zlib
from collections.abc import Iterator
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import coverage_report as report

PROVENANCE = report.Provenance(
    "example/repo",
    None,
    "b" * 40,
    1,
    1,
    "push",
    "example/repo/.github/workflows/ci.yml@refs/heads/main",
)
HOSTILE = ["\u202e", "\u2028", "\u200b", "\ufeff", "\ud800", "\x7f", "\x85", "\x00", "\ue000"]


def summary_document(name: str = "pkg/primary", path: str = "src/a.py") -> dict[str, object]:
    """Build a valid minimal accounting summary.

    Parameters:
        name (str): Package/signal label.
        path (str): File path.

    Returns:
        dict[str, object]: Summary document.

    Raises:
        None.
    """
    package, signal = name.split("/")
    counters = {"lines": 4, "uncovered_lines": 0}
    return {
        "os": "linux",
        "measurement_only": False,
        "packages": {name: counters},
        "signals": {name: {"enforcement": "enforced", "reason": "", "reference": None, "delta": None}},
        "files": [{"package": package, "signal": signal, "os": "linux", "file": path} | counters],
        "errors": [],
        "not_measured": {},
    }


def plan_document(state: str = "available") -> dict[str, object]:
    """Build a plan for the synthetic signal on every host.

    Parameters:
        state (str): Host state.

    Returns:
        dict[str, object]: Host cell.

    Raises:
        None.
    """
    signal = {"enforcement": "enforced", "reason": "r", "semantics": "v1", "state": "planned"}
    return {"state": state, "signals": {"pkg/primary": signal}}


@pytest.mark.parametrize("char", HOSTILE)
def test_hostile_characters_rejected_at_read(tmp_path: Path, char: str) -> None:
    """Reject bidi, separator, zero-width, surrogate, DEL, C1, NUL and private-use text in labels.

    Parameters:
        tmp_path (Path): Scratch directory.
        char (str): Hostile character.

    Returns:
        None: The boundary contract is satisfied.

    Raises:
        AssertionError: The boundary contract regresses.
    """
    for document in (
        summary_document(name=f"pkg{char}/primary", path="src/a.py"),
        summary_document(path=f"src/a{char}.py"),
    ):
        path = tmp_path / "summary.json"
        path.write_text(json.dumps(document))
        with pytest.raises(ValueError, match=r"^Expected bounded text without control or format characters$"):
            report.Summary.parse(report.read_summary(path))


@pytest.mark.parametrize("char", HOSTILE)
def test_hostile_characters_neutralised_in_markdown_and_svg(char: str) -> None:
    """Defence in depth: even if text reached the renderer, no raw hostile character is emitted.

    Parameters:
        char (str): Hostile character.

    Returns:
        None: The boundary contract is satisfied.

    Raises:
        AssertionError: The boundary contract regresses.
    """
    name = f"pkg{char}/primary"
    counters = report.Counters.parse({"lines": 4, "uncovered_lines": 1})
    signal = report.Signal(name, "enforced", f"why{char}", "v1", "planned")
    summary = report.Summary(
        "linux",
        False,
        {name: counters},
        {name: {"enforcement": "enforced", "reason": "", "delta": None}},
        (report.File(name, f"src/a{char}.py", counters),),
        {f"n{char}": f"r{char}"},
        (f"e{char}",),
    )
    cell = report.Evidence("ubuntu-24.04", "available", (signal,), summary)
    markdown = report.render_markdown((cell,), PROVENANCE)
    svg = report.render_badge(cell)
    assert char not in markdown
    assert char not in svg
    assert f"&#{ord(char)};" in markdown


def stored_zip(path: Path, payload: bytes) -> None:
    """Write a stored one-member artifact ZIP.

    Parameters:
        path (Path): Output archive.
        payload (bytes): Member bytes.

    Returns:
        None: The archive exists.

    Raises:
        AssertionError: The boundary contract regresses.
    """
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("coverage/summary.json", payload)


def test_real_oversized_archive_refused_before_reading(tmp_path: Path) -> None:
    """A real archive that expands past the byte budget is refused without decompressing it.

    Parameters:
        tmp_path (Path): Scratch directory.

    Returns:
        None: The boundary contract is satisfied.

    Raises:
        AssertionError: The boundary contract regresses.
    """
    path = tmp_path / "bomb.zip"
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("coverage/summary.json", bytes(report.MAX_ARCHIVE_BYTES + 1))
    assert path.stat().st_size < 1024 * 1024
    with pytest.raises(ValueError, match=r"^Archive expansion limit exceeded$"):
        report.read_summary(path)


def test_real_oversized_summary_member_refused(tmp_path: Path) -> None:
    """A real summary member beyond the JSON limit is refused.

    Parameters:
        tmp_path (Path): Scratch directory.

    Returns:
        None: The boundary contract is satisfied.

    Raises:
        AssertionError: The boundary contract regresses.
    """
    path = tmp_path / "big.zip"
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("coverage/summary.json", b" " * (report.MAX_JSON_BYTES + 1))
    with pytest.raises(ValueError, match=r"^Invalid summary member$"):
        report.read_summary(path)


def test_archive_with_lying_declared_size_refused(tmp_path: Path) -> None:
    """A ZIP whose headers declare a tiny size for a large member is refused, never trusted.

    Parameters:
        tmp_path (Path): Scratch directory.

    Returns:
        None: The boundary contract is satisfied.

    Raises:
        AssertionError: The boundary contract regresses.
    """
    path = tmp_path / "lie.zip"
    stored_zip(path, b" " * (report.MAX_JSON_BYTES + 4096))
    data = bytearray(path.read_bytes())
    local, central = data.index(b"PK\x03\x04"), data.index(b"PK\x01\x02")
    struct.pack_into("<II", data, local + 18, 10, 10)
    struct.pack_into("<II", data, central + 20, 10, 10)
    path.write_bytes(data)
    with pytest.raises(ValueError, match=r"^Cannot read artifact ZIP: "):
        report.read_summary(path)


def test_stored_member_declared_just_over_json_limit_is_refused(tmp_path: Path) -> None:
    """Reject a stored member at the declared-size check, before attempting its read.

    Parameters:
        tmp_path (Path): Scratch directory.

    Returns:
        None: The boundary contract is satisfied.

    Raises:
        AssertionError: The boundary contract regresses.
    """
    path = tmp_path / "just-over.zip"
    stored_zip(path, b"{" + b" " * report.MAX_JSON_BYTES)
    with pytest.raises(ValueError, match=r"^Invalid summary member$"):
        report.read_summary(path)


def test_one_bad_host_degrades_only_that_host(tmp_path: Path) -> None:
    """A malformed ZIP or summary for one OS leaves it unavailable with a bounded reason, others render.

    Parameters:
        tmp_path (Path): Scratch directory.

    Returns:
        None: The boundary contract is satisfied.

    Raises:
        AssertionError: The boundary contract regresses.
    """
    manifest = tmp_path / "plan.json"
    manifest.write_text(json.dumps({host: plan_document() for host in ("ubuntu-24.04", "macos-14", "wsl2")}))
    good = tmp_path / "coverage-ubuntu-24.04" / "coverage" / "summary.json"
    good.parent.mkdir(parents=True)
    good.write_text(json.dumps(summary_document()))
    good.with_name("provenance.json").write_text(
        json.dumps(PROVENANCE.record("owned", "coverage-ubuntu-24.04"))
    )
    (tmp_path / "coverage-macos-14.zip").write_text("not a zip")
    bad = tmp_path / "coverage-wsl2" / "coverage" / "summary.json"
    bad.parent.mkdir(parents=True)
    bad.write_text('{"x":1,"' + "k" * 1000 + '":1,"' + "k" * 1000 + '":2}')
    cells = {cell.host: cell for cell in report.load_evidence(tmp_path, manifest, PROVENANCE)}
    assert cells["ubuntu-24.04"].summary is not None
    for host in ("macos-14", "wsl2"):
        assert cells[host].summary is None
        assert cells[host].state == "unavailable"
        assert 0 < len(cells[host].reason) <= report.MAX_REASON
    markdown = report.render_markdown(tuple(cells.values()), PROVENANCE)
    assert "Ubuntu enforced signals: 1/1 zero uncovered" in markdown
    assert "macOS enforced signals: unavailable" in markdown
    assert "WSL enforced signals: unavailable" in markdown
    assert markdown.count("Unavailable:") == 2
    assert "pkg&#47;primary | unavailable | unavailable | unavailable | unavailable" in markdown
    assert "pkg&#47;primary | 4/4 (0)" in markdown


def test_unreadable_artifact_does_not_publish_runner_paths(tmp_path: Path) -> None:
    """Report only the error type and basename for a real unreadable artifact.

    Parameters:
        tmp_path (Path): Scratch directory.
    Returns:
        None: Private parent paths do not reach the public report.
    Raises:
        AssertionError: An absolute filesystem path leaks.
    """
    manifest = tmp_path / "plan.json"
    manifest.write_text(json.dumps({"ubuntu-24.04": plan_document()}))
    artifact = tmp_path / "coverage-ubuntu-24.04.zip"
    stored_zip(artifact, b"{}")
    artifact.chmod(0)
    try:
        with pytest.raises(PermissionError):
            artifact.read_bytes()
        cells = report.load_evidence(tmp_path, manifest, PROVENANCE)
        assert cells[0].reason == "PermissionError: coverage-ubuntu-24.04.zip"
        assert str(tmp_path) not in report.render_markdown(cells, PROVENANCE)
    finally:
        artifact.chmod(0o600)


def test_inconsistent_artifact_degrades_host_not_report(tmp_path: Path) -> None:
    """A summary for the wrong OS or an unplanned signal degrades its host instead of aborting.

    Parameters:
        tmp_path (Path): Scratch directory.

    Returns:
        None: The boundary contract is satisfied.

    Raises:
        AssertionError: The boundary contract regresses.
    """
    manifest = tmp_path / "plan.json"
    manifest.write_text(json.dumps({host: plan_document() for host in ("macos-14", "ubuntu-24.04")}))
    for host, document in (
        ("macos-14", summary_document()),
        ("ubuntu-24.04", summary_document(name="other/primary")),
    ):
        path = tmp_path / f"coverage-{host}" / "coverage" / "summary.json"
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps(document))
        path.with_name("provenance.json").write_text(
            json.dumps(PROVENANCE.record("owned", f"coverage-{host}"))
        )
    cells = report.load_evidence(tmp_path, manifest, PROVENANCE)
    assert [cell.state for cell in cells] == ["unavailable", "unavailable"]
    assert all(cell.summary is None and cell.reason.startswith("Available evidence") for cell in cells)


def test_bad_manifest_still_fails_the_report(tmp_path: Path) -> None:
    """Only per-host artifact problems degrade; an invalid trusted plan is a hard error.

    Parameters:
        tmp_path (Path): Scratch directory.

    Returns:
        None: The boundary contract is satisfied.

    Raises:
        AssertionError: The boundary contract regresses.
    """
    manifest = tmp_path / "plan.json"
    manifest.write_text(json.dumps({"wsl2": plan_document() | {"signals": {"pkg/primary": {}}}}))
    with pytest.raises(ValueError, match=r"^Expected bounded text without control or format characters$"):
        report.load_evidence(tmp_path, manifest, PROVENANCE)


def test_partial_rows_note_survives_a_full_signal_table() -> None:
    """Keep the partial-evidence warning even when a long signal row cannot fit.

    Parameters:
        None.
    Returns:
        None: Essential state survives the public Markdown cap.
    Raises:
        AssertionError: File rows render without their partial marker.
    """
    summary = report.Summary.parse(summary_document() | {"rows_trimmed": {"original_file_rows": 2}})
    signal = report.Signal("pkg/primary", "enforced", "\U0001f600" * 8192, "v1", "planned")
    cell = report.Evidence("ubuntu-24.04", "available", (signal,), summary)
    markdown = report.render_markdown((cell,), PROVENANCE)
    assert "src&#47;a&#46;py" in markdown
    assert "File rows partial (1 of 2)." in markdown
    assert len(markdown) <= report.MAX_MARKDOWN


def test_many_signals_validate_with_a_linear_row_budget() -> None:
    """Bound work for 10,000 signals without a machine-speed-dependent timeout.

    Parameters:
        None.
    Returns:
        None: Validation visits at most twice the input rows.
    Raises:
        AssertionError: Validation rescans the row set per signal.
    """
    counters = report.Counters.parse({"lines": 4, "uncovered_lines": 0})
    packages = {f"pkg{i}/primary": counters for i in range(10_000)}

    class BoundedRows(list[report.File]):
        """Fail promptly instead of letting a quadratic validation exhaust the test runner."""

        visits = 0

        def __iter__(self) -> Iterator[report.File]:
            """Yield rows within the fixed linear work budget.

            Parameters:
                None.
            Returns:
                Iterator[report.File]: Rows within the visit budget.
            Raises:
                AssertionError: The caller exhausts the linear work budget.
            """
            for row in super().__iter__():
                self.visits += 1
                assert self.visits <= 2 * len(self)
                yield row

    rows = BoundedRows(report.File(name, "src/a.py", counters) for name in packages)
    report.validate_totals(packages, rows, False)


def test_filesystem_error_without_filename_is_type_only() -> None:
    """Suppress even path-bearing strerror text when the exception has no filename.

    Parameters:
        None.
    Returns:
        None: The diagnostic contains only a type name.
    Raises:
        AssertionError: Private exception text reaches the diagnostic.
    """
    assert report.error_reason(OSError("cannot open /private/runner/file")) == "OSError"


def test_finite_floats_still_decode() -> None:
    """Finite JSON floats pass the decoder; type validation rejects them later as counters.

    Parameters:
        None.

    Returns:
        None: The boundary contract is satisfied.

    Raises:
        AssertionError: The boundary contract regresses.
    """
    assert report.decode_json(b'{"x":1.5}') == {"x": 1.5}


def deflated_zip(path: Path) -> tuple[int, int]:
    """Write a one-member deflated artifact ZIP and return its data offset and compressed size.

    Parameters:
        path (Path): Output archive.

    Returns:
        tuple[int, int]: Compressed data offset and size.

    Raises:
        None.
    """
    payload = json.dumps(summary_document() | {"filler": [str(i) for i in range(4000)]}).encode()
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("coverage/summary.json", payload)
    data = path.read_bytes()
    name_length, extra_length = struct.unpack_from("<HH", data, 26)
    (compressed,) = struct.unpack_from("<I", data, 18)
    return 30 + name_length + extra_length, compressed


def test_corrupt_deflate_stream_is_a_clean_refusal(tmp_path: Path) -> None:
    """A real corrupt deflate stream raises zlib.error inside zipfile and must become a ValueError.

    Parameters:
        tmp_path (Path): Scratch directory.

    Returns:
        None: The boundary contract is satisfied.

    Raises:
        AssertionError: The boundary contract regresses.
    """
    path = tmp_path / "corrupt.zip"
    offset, size = deflated_zip(path)
    data = bytearray(path.read_bytes())
    data[offset : offset + size] = b"\xff" * size
    path.write_bytes(data)
    with pytest.raises(zlib.error):
        zlib.decompress(bytes(data[offset : offset + size]), -15)
    with pytest.raises(ValueError, match=r"^Cannot read artifact ZIP: "):
        report.read_summary(path)


def test_truncated_deflate_stream_is_a_clean_refusal(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A file that shrinks after the directory is read makes zipfile raise EOFError, now a clean refusal.

    Parameters:
        tmp_path (Path): Scratch directory.
        monkeypatch (pytest.MonkeyPatch): Truncates the real file between open and read.

    Returns:
        None: The boundary contract is satisfied.

    Raises:
        AssertionError: The boundary contract regresses.
    """
    path = tmp_path / "truncated.zip"
    offset, size = deflated_zip(path)
    original = zipfile.ZipFile.getinfo

    def shrink(self: zipfile.ZipFile, name: str) -> zipfile.ZipInfo:
        """Truncate the real archive in half of its member data once the entry is located.

        Parameters:
            self (zipfile.ZipFile): Open archive.
            name (str): Member name.

        Returns:
            zipfile.ZipInfo: The located entry.

        Raises:
            KeyError: The member does not exist.
        """
        info = original(self, name)
        path.write_bytes(path.read_bytes()[: offset + size // 2])
        return info

    monkeypatch.setattr(zipfile.ZipFile, "getinfo", shrink)
    # `EOFError` has an empty message, which pins this to the EOFError path.
    with pytest.raises(ValueError, match=r"^Cannot read artifact ZIP: ''$"):
        report.read_summary(path)


@pytest.mark.parametrize("damage", ["corrupt", "spliced", "lzma"])
def test_damaged_archive_degrades_only_its_host(tmp_path: Path, damage: str) -> None:
    """One damaged host archive leaves it unavailable while healthy hosts still render.

    Parameters:
        tmp_path (Path): Scratch directory.
        damage (str): Kind of stream damage.

    Returns:
        None: The boundary contract is satisfied.

    Raises:
        AssertionError: The boundary contract regresses.
    """
    manifest = tmp_path / "plan.json"
    manifest.write_text(json.dumps({host: plan_document() for host in ("ubuntu-24.04", "macos-14")}))
    good = tmp_path / "coverage-ubuntu-24.04" / "coverage" / "summary.json"
    good.parent.mkdir(parents=True)
    good.write_text(json.dumps(summary_document()))
    good.with_name("provenance.json").write_text(
        json.dumps(PROVENANCE.record("owned", "coverage-ubuntu-24.04"))
    )
    bad = tmp_path / "coverage-macos-14.zip"
    if damage == "lzma":
        with zipfile.ZipFile(bad, "w", compression=zipfile.ZIP_LZMA) as archive:
            archive.writestr("coverage/summary.json", json.dumps(summary_document()))
        data = bytearray(bad.read_bytes())
        name_length, extra_length = struct.unpack_from("<HH", data, 26)
        offset = 30 + name_length + extra_length
        # ZIP LZMA carries a four-byte prefix, then five filter-property bytes.
        data[offset + 4 : offset + 9] = b"\xff" * 5
        bad.write_bytes(data)
        with zipfile.ZipFile(bad) as archive, pytest.raises(lzma.LZMAError):
            archive.read("coverage/summary.json")
    else:
        offset, size = deflated_zip(bad)
        data = bytearray(bad.read_bytes())
        if damage == "corrupt":
            data[offset : offset + size] = b"\xff" * size
        else:
            data[offset + size // 2 : offset + size] = b""
        bad.write_bytes(data)
    output = tmp_path / "report.md"
    assert (
        report.main(
            [
                "--artifacts",
                str(tmp_path),
                "--plan",
                str(manifest),
                "--repository",
                "example/repo",
                "--event-name",
                "push",
                "--workflow-ref",
                "example/repo/.github/workflows/ci.yml@refs/heads/main",
                "--tested-sha",
                "b" * 40,
                "--run-id",
                "1",
                "--attempt",
                "1",
                "--output",
                str(output),
            ]
        )
        == 0
    )
    assert "macOS enforced signals: unavailable" in output.read_text()
    with pytest.raises((ValueError, OSError)):
        report.read_summary(bad)
    cells = {cell.host: cell for cell in report.load_evidence(tmp_path, manifest, PROVENANCE)}
    assert cells["macos-14"].summary is None
    assert cells["macos-14"].state == "unavailable"
    assert 0 < len(cells["macos-14"].reason) <= report.MAX_REASON
    markdown = report.render_markdown(tuple(cells.values()), PROVENANCE)
    assert "Ubuntu enforced signals: 1/1 zero uncovered" in markdown
    assert "macOS enforced signals: unavailable" in markdown
