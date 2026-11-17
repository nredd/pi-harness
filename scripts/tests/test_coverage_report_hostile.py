"""Hostile-input, degraded-host and real-archive tests for the coverage presentation renderer.

References:
    https://github.com/nredd/pi-harness/issues/1001
"""

from __future__ import annotations

import json
import struct
import sys
import zipfile
import zlib
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import coverage_report as report

PROVENANCE = report.Provenance("example/repo", "a" * 40, "b" * 40, 1, 1)
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


def test_oversized_member_read_is_bounded_even_if_declared_sizes_agree(tmp_path: Path) -> None:
    """The member read itself is capped, so a member just over the limit cannot be fully buffered.

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
    (tmp_path / "coverage-macos-14.zip").write_text("not a zip")
    bad = tmp_path / "coverage-wsl2" / "coverage" / "summary.json"
    bad.parent.mkdir(parents=True)
    bad.write_text('{"x":1,"' + "k" * 1000 + '":1,"' + "k" * 1000 + '":2}')
    cells = {cell.host: cell for cell in report.load_evidence(tmp_path, manifest)}
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
    manifest.write_text(json.dumps({"macos-14": plan_document(), "wsl2": plan_document()}))
    for host, document in (
        ("macos-14", summary_document()),
        ("wsl2", summary_document(name="other/primary")),
    ):
        path = tmp_path / f"coverage-{host}" / "coverage" / "summary.json"
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps(document))
    cells = report.load_evidence(tmp_path, manifest)
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
        report.load_evidence(tmp_path, manifest)


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


@pytest.mark.parametrize("damage", ["corrupt", "spliced"])
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
    bad = tmp_path / "coverage-macos-14.zip"
    offset, size = deflated_zip(bad)
    data = bytearray(bad.read_bytes())
    if damage == "corrupt":
        data[offset : offset + size] = b"\xff" * size
    else:
        data[offset + size // 2 : offset + size] = b""
    bad.write_bytes(data)
    cells = {cell.host: cell for cell in report.load_evidence(tmp_path, manifest)}
    assert cells["macos-14"].summary is None
    assert cells["macos-14"].state == "unavailable"
    assert 0 < len(cells["macos-14"].reason) <= report.MAX_REASON
    markdown = report.render_markdown(tuple(cells.values()), PROVENANCE)
    assert "Ubuntu enforced signals: 1/1 zero uncovered" in markdown
    assert "macOS enforced signals: unavailable" in markdown
