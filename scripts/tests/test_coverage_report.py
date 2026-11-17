"""Exercise presentation boundaries without publishing or touching GitHub.

References:
    https://github.com/nredd/pi-harness/issues/1001
"""

from __future__ import annotations

import json
import stat
import subprocess
import sys
import zipfile
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import coverage_report as report

PROVENANCE = report.Provenance("example/repository", "a" * 40, "b" * 40, 123, 2)


def document() -> dict[str, Any]:
    """Return a small independent measured summary with native-style unsupported counters.

    Parameters:
        None.

    Returns:
        dict[str, Any]: The boundary contract is satisfied.

    Raises:
        None.
    """
    return {
        "os": "linux",
        "measurement_only": False,
        "packages": {
            "pkg/primary": {"lines": 10, "uncovered_lines": 2, "functions": 0, "uncovered_functions": 0}
        },
        "signals": {
            "pkg/primary": {
                "enforcement": "enforced",
                "reason": "",
                "reference": {"lines": 3},
                "delta": {"lines": -1},
            }
        },
        "files": [
            {
                "package": "pkg",
                "signal": "primary",
                "os": "linux",
                "file": "src/a.py",
                "lines": 10,
                "uncovered_lines": 2,
            }
        ],
        "errors": [],
        "not_measured": {"native": "No native branch producer"},
    }


def plan(state: str = "available") -> dict[str, Any]:
    """Return a trusted caller plan independent of the measured summary.

    Parameters:
        state (str): Boundary input.

    Returns:
        dict[str, Any]: The boundary contract is satisfied.

    Raises:
        None.
    """
    return {
        "state": state,
        "signals": {
            "pkg/primary": {
                "enforcement": "enforced",
                "reason": "reason",
                "semantics": "coverage.py/7:lines",
                "state": "planned",
            }
        },
    }


def cell() -> report.Evidence:
    """Validate the synthetic summary at the public parsing boundary.

    Parameters:
        None.

    Returns:
        report.Evidence: The boundary contract is satisfied.

    Raises:
        None.
    """
    return report.Evidence.parse("ubuntu-24.04", plan(), report.Summary.parse(document()))


def test_numeric_rendering_and_independent_deltas() -> None:
    """Keep measured counts separate from policy budgets and measured-main baselines.

    Parameters:
        None.

    Returns:
        None: The boundary contract is satisfied.

    Raises:
        AssertionError: The boundary contract regresses.
    """
    current = cell()
    markdown = report.render_markdown((current,), PROVENANCE, (current,))
    assert "Ubuntu enforced signals: 0/1 zero uncovered (measured counters only)" in markdown
    assert "8/10 (2) | N/A | not measured | not measured" in markdown
    assert "vs policy reference | vs measured main" in markdown
    assert "lines -1 | lines +0, functions +0" in markdown
    assert "<details>" in markdown
    assert "</details>" in markdown
    assert "Omitted rows: 0 signal/status, 0 files." in markdown
    assert "tested: " + "b" * 40 in markdown
    assert "%" not in markdown
    assert report.render_markdown((current,), PROVENANCE) == report.render_markdown((current,), PROVENANCE)


def test_missing_signals_remain_in_denominator_and_report_only_separate() -> None:
    """Never derive the planned denominator from surviving artifacts.

    Parameters:
        None.

    Returns:
        None: The boundary contract is satisfied.

    Raises:
        AssertionError: The boundary contract regresses.
    """
    current = cell()
    zero = replace(
        report.Summary.parse(document()),
        packages={"pkg/primary": report.Counters.parse({"lines": 2, "uncovered_lines": 0})},
    )
    assert "1/1 zero uncovered" in report.headline(replace(current, summary=zero))
    missing = report.Signal("missing/primary", "enforced", "missing", "v1", "planned")
    advisory = report.Signal("advisory/bun", "report-only", "subset", "v1", "planned")
    current = replace(current, plan=(*current.plan, missing, advisory))
    markdown = report.render_markdown((current,), PROVENANCE)
    assert "0/2 zero uncovered (measured counters only); incomplete" in markdown
    assert "REPORT-ONLY (outside headline): subset" in markdown
    assert "unavailable | unavailable" in markdown
    assert "0/3 zero" not in markdown
    not_run = replace(missing, state="NOT RUN")
    markdown = report.render_markdown((replace(current, plan=(not_run,)),), PROVENANCE)
    assert "NOT RUN | NOT RUN" in markdown


@pytest.mark.parametrize("state", ["unavailable", "pending", "NOT RUN"])
def test_non_numeric_states_discard_stale_summary(state: str) -> None:
    """Expired evidence never reuses the previous numbers.

    Parameters:
        state (str): Boundary input.

    Returns:
        None: The boundary contract is satisfied.

    Raises:
        AssertionError: The boundary contract regresses.
    """
    current = report.Evidence.parse("ubuntu-24.04", plan(state), cell().summary)
    assert current.summary is None
    assert report.headline(current) == f"Ubuntu enforced signals: {state}"
    assert "8/10" not in report.render_markdown((current,), PROVENANCE)
    assert state in report.render_badge(current)


def test_errors_and_measurement_only_are_explicit() -> None:
    """Accounting errors and measurement-only mode cannot masquerade as gate evidence.

    Parameters:
        None.

    Returns:
        None: The boundary contract is satisfied.

    Raises:
        AssertionError: The boundary contract regresses.
    """
    obj = document() | {"errors": ["counter missing"], "measurement_only": True}
    current = replace(cell(), summary=report.Summary.parse(obj))
    markdown = report.render_markdown((current,), PROVENANCE)
    assert "; incomplete; measurement only, NOT gate evidence" in markdown
    assert "Error: counter missing" in markdown
    assert report.measured_delta(current, cell(), current.plan[0]) == "unavailable"


def test_main_delta_compatibility_added_removed_and_missing() -> None:
    """Never compare Linux and WSL or changed producer/counter semantics.

    Parameters:
        None.

    Returns:
        None: The boundary contract is satisfied.

    Raises:
        AssertionError: The boundary contract regresses.
    """
    current = cell()
    signal = current.plan[0]
    assert report.measured_delta(current, None, signal) == "unavailable"
    assert report.measured_delta(current, current, replace(signal, state="NOT RUN")) == "unavailable"
    assert (
        report.measured_delta(current, replace(current, plan=(replace(signal, state="NOT RUN"),)), signal)
        == "unavailable"
    )
    assert report.measured_delta(current, replace(current, plan=()), signal) == "added"
    assert report.measured_delta(current, replace(current, host="wsl2"), signal) == "incompatible"
    assert (
        report.measured_delta(current, replace(current, plan=(replace(signal, semantics="other"),)), signal)
        == "incompatible"
    )
    changed = replace(
        report.Summary.parse(document()),
        packages={signal.name: report.Counters.parse({"lines": 11, "uncovered_lines": 3})},
    )
    assert (
        report.measured_delta(current, replace(current, summary=changed), signal) == "incompatible counters"
    )
    missing = replace(report.Summary.parse(document()), packages={})
    assert report.measured_delta(current, replace(current, summary=missing), signal) == "unavailable"
    before = replace(
        report.Summary.parse(document()),
        packages={
            signal.name: report.Counters.parse(
                {"lines": 11, "uncovered_lines": 3, "functions": 0, "uncovered_functions": 0}
            )
        },
    )
    assert (
        report.measured_delta(current, replace(current, summary=before), signal) == "lines -1, functions +0"
    )
    removed = replace(signal, name="removed/primary")
    markdown = report.render_markdown((current,), PROVENANCE, (replace(current, plan=(signal, removed)),))
    assert "removed&#47;primary | removed vs measured main" in markdown
    assert report.policy_delta(None) == "unavailable"


def test_escape_and_svg_have_no_untrusted_links_or_mentions() -> None:
    """Artifact text cannot break a table, create links or notify users.

    Parameters:
        None.

    Returns:
        None: The boundary contract is satisfied.

    Raises:
        AssertionError: The boundary contract regresses.
    """
    unsafe = '<script>@owner [x](https://example.invalid) | `x` & "'
    safe = report.escape(unsafe)
    assert "@owner" not in safe
    assert "<script>" not in safe
    assert "https://" not in safe
    current = cell()
    current = replace(current, plan=(replace(current.plan[0], reason=unsafe),))
    markdown = report.render_markdown((current,), PROVENANCE)
    assert unsafe not in markdown
    assert safe in markdown
    svg = report.render_badge(current)
    assert "<svg " in svg
    assert "<a " not in svg
    assert "href" not in svg
    assert "0/1 zero uncovered" in svg


def test_deterministic_ordering_and_bounded_whole_rows() -> None:
    """Prioritize uncovered source rows and count every omitted row under the cap.

    Parameters:
        None.

    Returns:
        None: The boundary contract is satisfied.

    Raises:
        AssertionError: The boundary contract regresses.
    """
    current = cell()
    uncovered = report.File("pkg/primary", "z.py", report.Counters.parse({"lines": 2, "uncovered_lines": 2}))
    covered = report.File("pkg/primary", "a.py", report.Counters.parse({"lines": 2, "uncovered_lines": 0}))
    current = replace(current, summary=replace(report.Summary.parse(document()), files=(covered, uncovered)))
    full = report.render_markdown((current,), PROVENANCE)
    assert full.index("z&#46;py") < full.index("a&#46;py")
    files = tuple(replace(uncovered, path=f"{i:06d}" + "x" * 250) for i in range(1000))
    current = replace(current, summary=replace(report.Summary.parse(document()), files=files))
    truncated = report.render_markdown((current,), PROVENANCE, limit=2000)
    assert len(truncated) <= 2000
    assert "Omitted rows: 0 signal/status," in truncated
    assert "</details>" in truncated
    assert "1000 files." not in truncated
    assert len(report.render_markdown((current,), PROVENANCE)) <= 60_000
    for limit in (1, 60_001):
        with pytest.raises(ValueError, match=r"^Invalid Markdown limit or duplicate OS$"):
            report.render_markdown((current,), PROVENANCE, limit=limit)
    enormous = replace(current, plan=tuple(replace(current.plan[0], name=str(i)) for i in range(100)))
    result = report.render_markdown((enormous,), PROVENANCE, limit=1100)
    assert len(result) <= 1100
    assert "signal/status" in result
    with pytest.raises(ValueError, match=r"^Invalid Markdown limit or duplicate OS$"):
        report.render_markdown((current, current), PROVENANCE)
    with pytest.raises(ValueError, match=r"^Essential report state exceeds Markdown limit$"):
        report.render_markdown(
            (current, replace(current, host="wsl2"), replace(current, host="macos-14")),
            replace(PROVENANCE, repository="x" * 300 + "/repo"),
            limit=1000,
        )


@pytest.mark.parametrize("value", [None, [], 3, {1: "bad"}])
def test_object_types(value: object) -> None:
    """Reject non-object JSON values at every parsing entrypoint.

    Parameters:
        value (object): Non-object value.

    Returns:
        None: The boundary contract is satisfied.

    Raises:
        AssertionError: The boundary contract regresses.
    """
    with pytest.raises(ValueError, match=r"^Expected a JSON object$"):
        report.object_value(value)


@pytest.mark.parametrize("value", [None, 3, "line\nfeed", "x" * 8193])
def test_text_types(value: object) -> None:
    """Reject malformed labels before escaping or rendering.

    Parameters:
        value (object): Malformed text.

    Returns:
        None: The boundary contract is satisfied.

    Raises:
        AssertionError: The boundary contract regresses.
    """
    with pytest.raises(ValueError, match=r"^Expected bounded text without control or format characters$"):
        report.text_value(value)


@pytest.mark.parametrize(
    ("data", "message"),
    [
        (b"{", r"^Cannot decode JSON: 'Expecting property name"),
        (b"\xff", r"^Cannot decode JSON: "),
        (b"[]", r"^Cannot decode JSON: 'Expected a JSON object'$"),
        (b'{"x":1,"x":2}', r"^Cannot decode JSON: 'Duplicate JSON key: .x.'$"),
        (b" " * (report.MAX_JSON_BYTES + 1), r"^JSON byte limit exceeded$"),
        (b'{"x":NaN}', r"Non-finite JSON number: .NaN."),
        (b'{"x":Infinity}', r"Non-finite JSON number: .Infinity."),
        (b'{"x":-Infinity}', r"Non-finite JSON number: .-Infinity."),
        (b'{"x":1e999}', r"Non-finite JSON number: .1e999."),
        (b'{"x":' + b"9" * 5000 + b"}", r"Exceeds the limit"),
        (b"[" * 200_000, r"^Cannot decode JSON: .(Stack overflow|maximum recursion depth)"),
    ],
)
def test_json_refusals(data: bytes, message: str) -> None:
    """Reject malformed, duplicate-key, non-finite, huge-integer, deep and oversized JSON.

    Parameters:
        data (bytes): Hostile document.
        message (str): Specific expected refusal.

    Returns:
        None: The boundary contract is satisfied.

    Raises:
        AssertionError: The boundary contract regresses.
    """
    with pytest.raises(ValueError, match=message):
        report.decode_json(data)


@pytest.mark.parametrize(
    ("counts", "message"),
    [
        ({}, r"^No measured counters$"),
        ({"lines": True, "uncovered_lines": 0}, r"^Invalid measured counter: 'lines'$"),
        ({"lines": 1.0, "uncovered_lines": 0}, r"^Invalid measured counter: 'lines'$"),
        ({"lines": -1, "uncovered_lines": 0}, r"^Invalid measured counter: 'lines'$"),
        ({"lines": 1, "uncovered_lines": 2}, r"^Invalid measured counter: 'lines'$"),
        ({"lines": 1}, r"^Invalid measured counter: 'lines'$"),
        ({"uncovered_lines": 1}, r"^Invalid measured counter: 'lines'$"),
        ({"lines": 10**13, "uncovered_lines": 0}, r"^Invalid measured counter: 'lines'$"),
    ],
)
def test_invalid_counters(counts: object, message: str) -> None:
    """Reject invented, impossible or absurdly large measured counts.

    Parameters:
        counts (object): Hostile counters.
        message (str): Specific expected refusal.

    Returns:
        None: The boundary contract is satisfied.

    Raises:
        AssertionError: The boundary contract regresses.
    """
    with pytest.raises(ValueError, match=message):
        report.Counters.parse(counts)


def oversized_file() -> dict[str, object]:
    """Build a file row whose total exceeds its signal total.

    Parameters:
        None.

    Returns:
        dict[str, object]: Hostile row.

    Raises:
        None.
    """
    return document()["files"][0] | {"lines": 11}


@pytest.mark.parametrize(
    ("patch", "message"),
    [
        ({"os": "windows"}, r"^Invalid summary platform or measurement mode$"),
        ({"measurement_only": 0}, r"^Invalid summary platform or measurement mode$"),
        ({"files": {}}, r"^Expected file and error arrays$"),
        ({"errors": "error"}, r"^Expected file and error arrays$"),
        ({"signals": {}}, r"^Measured packages and signal metadata differ$"),
        ({"files": [oversized_file()]}, r"^Measured file rows exceed the package counters$"),
        ({"signals": {"pkg/primary": {"enforcement": "optional", "reason": ""}}}, r"^Invalid enforcement$"),
        (
            {
                "signals": {
                    "pkg/primary": {"enforcement": "enforced", "reason": "", "reference": {"lines": -1}}
                }
            },
            r"^Invalid policy reference counters$",
        ),
        (
            {"signals": {"pkg/primary": {"enforcement": "enforced", "reason": "", "delta": {"lines": True}}}},
            r"^Invalid policy reference counters$",
        ),
        (
            {"signals": {"pkg/primary": {"enforcement": "enforced", "reason": "", "delta": {"unknown": 1}}}},
            r"^Invalid policy reference counters$",
        ),
        (
            {
                "signals": {
                    "pkg/primary": {"enforcement": "enforced", "reason": "", "delta": {"lines": 10**13}}
                }
            },
            r"^Invalid policy reference counters$",
        ),
    ],
)
def test_summary_shape_validation(patch: dict[str, object], message: str) -> None:
    """Validate summary metadata rather than trusting accounting JSON shapes.

    Parameters:
        patch (dict[str, object]): Hostile replacement fields.
        message (str): Specific expected refusal.

    Returns:
        None: The boundary contract is satisfied.

    Raises:
        AssertionError: The boundary contract regresses.
    """
    with pytest.raises(ValueError, match=message):
        report.Summary.parse(document() | patch)


def test_duplicate_and_foreign_file_membership() -> None:
    """Refuse repeated or foreign file rows.

    Parameters:
        None.

    Returns:
        None: The boundary contract is satisfied.

    Raises:
        AssertionError: The boundary contract regresses.
    """
    for patch in ({"os": "darwin"}, {"package": "foreign"}, {}):
        obj = document()
        row = obj["files"][0]
        obj["files"] = [row, row | patch]
        with pytest.raises(ValueError, match=r"^Invalid or duplicate file membership$"):
            report.Summary.parse(obj)


@pytest.mark.parametrize("patch", [{"enforcement": "bad"}, {"state": "bad"}, {"semantics": ""}])
def test_invalid_plan(patch: dict[str, object]) -> None:
    """Require explicit valid trusted planning information.

    Parameters:
        patch (dict[str, object]): Hostile plan fields.

    Returns:
        None: The boundary contract is satisfied.

    Raises:
        AssertionError: The boundary contract regresses.
    """
    declaration = plan()["signals"]["pkg/primary"]
    with pytest.raises(ValueError, match=r"^Invalid signal plan$"):
        report.Signal.parse("pkg/primary", declaration | patch)


def test_invalid_evidence_and_provenance() -> None:
    """Bind OS and complete plan membership before displaying numbers.

    Parameters:
        None.

    Returns:
        None: The boundary contract is satisfied.

    Raises:
        AssertionError: The boundary contract regresses.
    """
    for host, value, summary, message in (
        ("windows", plan(), None, r"^Invalid evidence host or state$"),
        ("ubuntu-24.04", plan("expired"), None, r"^Invalid evidence host or state$"),
        ("ubuntu-24.04", plan(), None, r"^Available evidence lacks a compatible planned summary$"),
        ("macos-14", plan(), cell().summary, r"^Available evidence lacks a compatible planned summary$"),
        (
            "ubuntu-24.04",
            plan() | {"signals": {}},
            cell().summary,
            r"^Available evidence lacks a compatible planned summary$",
        ),
    ):
        with pytest.raises(ValueError, match=message):
            report.Evidence.parse(host, value, summary)
    declaration = plan()
    declaration["signals"]["pkg/primary"]["enforcement"] = "report-only"
    with pytest.raises(ValueError, match=r"^Measured signal conflicts with trusted plan$"):
        report.Evidence.parse("ubuntu-24.04", declaration, cell().summary)
    for patch in (
        {"repository": "bad"},
        {"head_sha": "bad"},
        {"tested_sha": "bad"},
        {"run_id": 0},
        {"run_id": True},
        {"attempt": -1},
        {"attempt": True},
    ):
        with pytest.raises(ValueError, match=r"^Invalid run provenance$"):
            replace(PROVENANCE, **patch)


def test_not_run_signal_with_measurement_is_flagged() -> None:
    """Render a NOT RUN plan entry that has a measurement explicitly instead of raising.

    Parameters:
        None.

    Returns:
        None: The boundary contract is satisfied.

    Raises:
        AssertionError: The boundary contract regresses.
    """
    declaration = plan()
    declaration["signals"]["pkg/primary"]["state"] = "NOT RUN"
    current = report.Evidence.parse("ubuntu-24.04", declaration, report.Summary.parse(document()))
    markdown = report.render_markdown((current,), PROVENANCE)
    assert "NOT RUN | NOT RUN | NOT RUN | NOT RUN" in markdown
    assert "INCONSISTENT: measurement present for a NOT RUN signal" in markdown
    assert "0/1 zero uncovered (measured counters only); incomplete" in markdown
    assert "8/10" not in markdown


@pytest.mark.parametrize(
    "name", ["../escape", "/absolute", "a/../b", "a\\b", "C:/file", "a//b", "./file", ""]
)
def test_archive_path_refusals(tmp_path: Path, name: str) -> None:
    """Never extract or accept unsafe ZIP paths, even unrelated members.

    Parameters:
        tmp_path (Path): Boundary input.
        name (str): Boundary input.

    Returns:
        None: The boundary contract is satisfied.

    Raises:
        AssertionError: The boundary contract regresses.
    """
    path = tmp_path / "artifact.zip"
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr(name or "/", "data")
    with pytest.raises(ValueError, match=r"^Unsafe archive member: "):
        report.read_summary(path)


def test_archive_duplicates_symlinks_missing_and_limits(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Refuse aliases, special members, malformed ZIPs and expansion bombs.

    Parameters:
        tmp_path (Path): Boundary input.
        monkeypatch (pytest.MonkeyPatch): Boundary input.

    Returns:
        None: The boundary contract is satisfied.

    Raises:
        AssertionError: The boundary contract regresses.
    """
    path = tmp_path / "artifact.zip"
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("same", "x")
        archive.writestr("same/", "")
    with pytest.raises(ValueError, match=r"^Unsafe archive member: "):
        report.read_summary(path)
    entry = zipfile.ZipInfo("link")
    entry.external_attr = (stat.S_IFLNK | 0o777) << 16
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr(entry, "target")
    with pytest.raises(ValueError, match=r"^Unsafe archive member: "):
        report.read_summary(path)
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("other", "x")
    with pytest.raises(ValueError, match=r"^Cannot read artifact ZIP: "):
        report.read_summary(path)
    monkeypatch.setattr(report, "MAX_MEMBERS", 0)
    with pytest.raises(ValueError, match=r"^Archive expansion limit exceeded$"):
        report.read_summary(path)
    monkeypatch.setattr(report, "MAX_MEMBERS", 4096)
    monkeypatch.setattr(report, "MAX_JSON_BYTES", 2)
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("coverage/summary.json", "{} ")
    with pytest.raises(ValueError, match=r"^Invalid summary member$"):
        report.read_summary(path)
    path.write_text("not a zip")
    with pytest.raises(ValueError, match=r"^Cannot read artifact ZIP: "):
        report.read_summary(path)
    monkeypatch.setattr(report, "MAX_ARCHIVE_BYTES", 1)
    with pytest.raises(ValueError, match=r"^Input byte limit exceeded$"):
        report.read_summary(path)
    path.unlink()
    with pytest.raises(ValueError, match=r"^Not a regular input file: "):
        report.read_summary(path)
    path.symlink_to(tmp_path / "missing")
    with pytest.raises(ValueError, match=r"^Not a regular input file: "):
        report.read_summary(path)


def test_load_json_zip_states_and_cli(tmp_path: Path) -> None:
    """Exercise real filesystem reads and CLI outputs without network or Git writes.

    Parameters:
        tmp_path (Path): Boundary input.

    Returns:
        None: The boundary contract is satisfied.

    Raises:
        AssertionError: The boundary contract regresses.
    """
    manifest = tmp_path / "plan.json"
    manifest.write_text(json.dumps({"ubuntu-24.04": plan()}))
    assert report.load_evidence(tmp_path, manifest)[0].state == "unavailable"
    artifact = tmp_path / "coverage-ubuntu-24.04/coverage/summary.json"
    artifact.parent.mkdir(parents=True)
    artifact.write_text(json.dumps(document()))
    summary = report.load_evidence(tmp_path, manifest)[0].summary
    assert summary is not None
    assert summary.packages["pkg/primary"].values[0] == (
        "lines",
        10,
        2,
    )
    zipped = tmp_path / "coverage-ubuntu-24.04.zip"
    with zipfile.ZipFile(zipped, "w") as archive:
        archive.writestr("coverage/summary.json", json.dumps(document()))
    assert report.load_evidence(tmp_path, manifest)[0].state == "available"
    manifest.write_text(json.dumps({"ubuntu-24.04": plan("pending")}))
    assert report.load_evidence(tmp_path, manifest)[0].summary is None
    args = [
        "--artifacts",
        str(tmp_path),
        "--plan",
        str(manifest),
        "--repository",
        "example/repository",
        "--head-sha",
        "a" * 40,
        "--tested-sha",
        "b" * 40,
        "--run-id",
        "123",
        "--attempt",
        "1",
        "--output",
        str(tmp_path / "report.md"),
        "--badge-dir",
        str(tmp_path / "badges"),
    ]
    assert report.main(args) == 0
    assert "pending" in (tmp_path / "report.md").read_text()
    assert (tmp_path / "badges/ubuntu-24.04.svg").is_file()
    assert report.main([*args, "--baseline-artifacts", str(tmp_path)]) == 1
    assert report.main([*args, "--baseline-artifacts", str(tmp_path), "--baseline-plan", str(manifest)]) == 0
    manifest.write_text("broken")
    assert report.main(args) == 1
    completed = subprocess.run(
        [sys.executable, str(Path(report.__file__)), *args], check=False, capture_output=True, text=True
    )
    assert completed.returncode == 1
    assert "Cannot render" in completed.stderr
