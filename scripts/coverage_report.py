"""Render existing accounting evidence without publishing or executing artifact code.

Presentation only: reads trusted-plan JSON plus downloaded `coverage-<host>` artifacts (a ZIP, never
extracted, or an already-unpacked `coverage/summary.json`) and prints deterministic Markdown and optional
per-OS SVG badges. It runs no tests, accounting, network or Git calls and writes only explicit outputs.

Plan JSON, supplied by the trusted caller and never derived from the artifact: a mapping of
`ubuntu-24.04` | `macos-14` | `wsl2` to `{state, signals}`. `state` is `available`, `unavailable`,
`pending` or `NOT RUN`. `signals` maps `package/signal` to `{enforcement: enforced|report-only, reason,
semantics, state: planned|NOT RUN, source_root}`. `semantics` names the producer and counter meaning, so
`vs measured main` is computed only when it matches. The caller must authenticate repository, SHAs, run,
attempt and artifact freshness first. A host whose artifact is missing or malformed degrades to
`unavailable` with a bounded reason; the healthy hosts still render.

Implemented limits: Markdown is capped at 60,000 characters with uncovered-first file rows and omitted
counts. No step-summary cap or changed-files ordering exists yet (slice 2/3 of #1001).

References:
    - https://github.com/nredd/pi-harness/issues/1001
    - https://docs.python.org/3/library/zipfile.html
"""

from __future__ import annotations

import argparse
import html
import json
import logging
import math
import re
import stat
import struct
import sys
import unicodedata
import zipfile
import zlib
from dataclasses import dataclass, replace
from pathlib import Path, PurePosixPath
from urllib.parse import quote

LOGGER = logging.getLogger(__name__)
MAX_JSON_BYTES = 4 * 1024 * 1024
MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
MAX_MEMBERS = 4096
MAX_MARKDOWN = 60_000
MAX_COUNT = 10**12
MAX_INT_DIGITS = 20
MAX_REASON = 200
FORBIDDEN_CATEGORIES = frozenset({"Cc", "Cf", "Cs", "Co", "Zl", "Zp"})
COUNTERS = ("lines", "functions", "branches", "statements")
HOSTS = {"ubuntu-24.04": ("Ubuntu", "linux"), "macos-14": ("macOS", "darwin"), "wsl2": ("WSL", "linux")}
SHA = re.compile(r"[0-9a-f]{40}\Z")
SAFE_REPOSITORY = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\Z")


def object_value(value: object) -> dict[str, object]:
    """Require a JSON object with string keys.

    Parameters:
        value (object): Decoded JSON value.
    Returns:
        dict[str, object]: Validated object.
    Raises:
        ValueError: The value is not an object.
    """
    if not isinstance(value, dict) or any(not isinstance(key, str) for key in value):
        raise ValueError("Expected a JSON object")
    return value


def text_value(value: object) -> str:
    """Require bounded text without control, format, separator, private or surrogate characters.

    Parameters:
        value (object): Untrusted JSON value.
    Returns:
        str: Validated text.
    Raises:
        ValueError: Text is malformed or too large.
    """
    if (
        not isinstance(value, str)
        or len(value) > 8192
        or any(unicodedata.category(c) in FORBIDDEN_CATEGORIES for c in value)
    ):
        raise ValueError("Expected bounded text without control or format characters")
    return value


def unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    """Reject duplicate JSON keys instead of silently accepting the last.

    Parameters:
        pairs (list[tuple[str, object]]): Object entries from the JSON decoder.
    Returns:
        dict[str, object]: Unique entries.
    Raises:
        ValueError: A key occurs more than once.
    """
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"Duplicate JSON key: '{key}'")
        result[key] = value
    return result


def reject_constant(token: str) -> object:
    """Refuse the non-finite tokens Python's JSON decoder accepts by default.

    Parameters:
        token (str): `NaN`, `Infinity` or `-Infinity`.
    Returns:
        object: Never returns.
    Raises:
        ValueError: Always.
    """
    raise ValueError(f"Non-finite JSON number: '{token}'")


def parse_int(token: str) -> int:
    """Parse a JSON integer with our own length bound, before `int()` and any interpreter limit.

    Parameters:
        token (str): Decimal integer token.
    Returns:
        int: The value.
    Raises:
        ValueError: The literal is longer than `MAX_INT_DIGITS` characters.
    """
    if len(token) > MAX_INT_DIGITS:
        raise ValueError("Integer literal too long")
    return int(token)


def parse_float(token: str) -> float:
    """Parse a JSON float, refusing overflow to infinity.

    Parameters:
        token (str): Decimal float token.
    Returns:
        float: Finite value.
    Raises:
        ValueError: The value is not finite.
    """
    value = float(token)
    if not math.isfinite(value):
        raise ValueError(f"Non-finite JSON number: '{token}'")
    return value


def decode_json(data: bytes) -> dict[str, object]:
    """Decode bounded JSON with no duplicate keys.

    Parameters:
        data (bytes): UTF-8 JSON document.
    Returns:
        dict[str, object]: Decoded object.
    Raises:
        ValueError: Encoding, size or JSON structure is invalid.
    """
    if len(data) > MAX_JSON_BYTES:
        raise ValueError("JSON byte limit exceeded")
    try:
        return object_value(
            json.loads(
                data,
                object_pairs_hook=unique_object,
                parse_constant=reject_constant,
                parse_float=parse_float,
                parse_int=parse_int,
            )
        )
    except (ValueError, RecursionError) as error:
        raise ValueError(f"Cannot decode JSON: '{error}'") from error


def read_summary(path: Path) -> dict[str, object]:
    """Read a bounded summary or ZIP without extracting any archive member.

    Parameters:
        path (Path): JSON summary or complete downloaded artifact ZIP.
    Returns:
        dict[str, object]: Decoded accounting summary.
    Raises:
        ValueError: Archive paths, types, duplicates or byte limits are unsafe.
        OSError: The input cannot be read.
    """
    if path.is_symlink() or not path.is_file():
        raise ValueError(f"Not a regular input file: '{path.name}'")
    if path.stat().st_size > MAX_ARCHIVE_BYTES:
        raise ValueError("Input byte limit exceeded")
    if path.suffix != ".zip":
        with path.open("rb") as stream:
            return decode_json(stream.read(MAX_JSON_BYTES + 1))
    try:
        with zipfile.ZipFile(path) as archive:
            members = archive.infolist()
            if len(members) > MAX_MEMBERS or sum(item.file_size for item in members) > MAX_ARCHIVE_BYTES:
                raise ValueError("Archive expansion limit exceeded")
            names: set[str] = set()
            for item in members:
                name = text_value(item.filename)
                parts = PurePosixPath(name).parts
                mode = stat.S_IFMT(item.external_attr >> 16)
                if (
                    not parts
                    or name.startswith("/")
                    or "\\" in name
                    or ":" in name
                    or any(part in {".", "..", ""} for part in name.rstrip("/").split("/"))
                    or mode not in {0, stat.S_IFREG, stat.S_IFDIR}
                    or name.rstrip("/") in names
                ):
                    raise ValueError(f"Unsafe archive member: '{name}'")
                names.add(name.rstrip("/"))
            member = archive.getinfo("coverage/summary.json")
            if member.file_size > MAX_JSON_BYTES or member.is_dir():
                raise ValueError("Invalid summary member")
            with archive.open(member) as stream:
                return decode_json(stream.read(MAX_JSON_BYTES + 1))
    except (
        zipfile.BadZipFile,
        KeyError,
        RuntimeError,
        NotImplementedError,
        zlib.error,
        EOFError,
        struct.error,
        OverflowError,
    ) as error:
        raise ValueError(f"Cannot read artifact ZIP: '{error}'") from error


@dataclass(frozen=True)
class Counters:
    """Immutable measured counters; unsupported metrics are absent, never zero."""

    values: tuple[tuple[str, int, int], ...]

    @classmethod
    def parse(cls, value: object) -> Counters:
        """Validate measured totals and uncovered counts.

        Parameters:
            value (object): Accounting counter object.
        Returns:
            Counters: Validated supported metrics.
        Raises:
            ValueError: A counter is negative, nonintegral, unpaired or impossible.
        """
        obj = object_value(value)
        values = []
        for name in COUNTERS:
            total, uncovered = obj.get(name), obj.get(f"uncovered_{name}")
            if total is None and uncovered is None:
                continue
            if (
                type(total) is not int
                or type(uncovered) is not int
                or not 0 <= uncovered <= total <= MAX_COUNT
            ):
                raise ValueError(f"Invalid measured counter: '{name}'")
            values.append((name, total, uncovered))
        if not values:
            raise ValueError("No measured counters")
        return cls(tuple(values))

    def cells(self) -> str:
        """Render independent L/F/B/S cells, never percentages.

        Returns:
            str: Four covered/total and uncovered table cells.

        Parameters:
            None.

        Raises:
            None.
        """
        metrics = {name: (total, uncovered) for name, total, uncovered in self.values}
        return " | ".join(
            "not measured"
            if name not in metrics
            else "N/A"
            if metrics[name][0] == 0
            else f"{metrics[name][0] - metrics[name][1]}/{metrics[name][0]} ({metrics[name][1]})"
            for name in COUNTERS
        )


@dataclass(frozen=True)
class Signal:
    """One planned signal supplied by trusted caller, not discovered from measurements."""

    name: str
    enforcement: str
    reason: str
    semantics: str
    state: str
    source_root: str = ""

    @classmethod
    def parse(cls, name: str, value: object) -> Signal:
        """Validate the publication plan's explicit producer identity and state.

        Parameters:
            name (str): Package/signal label.
            value (object): Trusted plan declaration.
        Returns:
            Signal: Validated signal plan.
        Raises:
            ValueError: Enforcement, semantics or state is absent or invalid.
        """
        obj = object_value(value)
        enforcement = text_value(obj.get("enforcement"))
        state = text_value(obj.get("state"))
        semantics = text_value(obj.get("semantics"))
        if (
            enforcement not in {"enforced", "report-only"}
            or state not in {"planned", "NOT RUN"}
            or not semantics
        ):
            raise ValueError("Invalid signal plan")
        root = text_value(obj.get("source_root", ""))
        if root and (PurePosixPath(root).is_absolute() or any(p in {"", ".", ".."} for p in root.split("/"))):
            raise ValueError("Invalid source root")
        return cls(text_value(name), enforcement, text_value(obj.get("reason")), semantics, state, root)


@dataclass(frozen=True)
class File:
    """One measured source row; paths are display text, never executable paths or links."""

    signal: str
    path: str
    counters: Counters


@dataclass(frozen=True)
class Summary:
    """Validated accounting output without any artifact-supplied provenance."""

    os: str
    measurement_only: bool
    packages: dict[str, Counters]
    signals: dict[str, dict[str, object]]
    files: tuple[File, ...]
    not_measured: dict[str, str]
    errors: tuple[str, ...]
    trimmed_from: int | None = None

    @classmethod
    def parse(cls, obj: dict[str, object]) -> Summary:
        """Validate accounting types, metadata and file membership.

        Parameters:
            obj (dict[str, object]): Decoded accounting summary.
        Returns:
            Summary: Validated immutable report holder.
        Raises:
            ValueError: Shape, counter, membership or duplicate validation fails.
        """
        os_name = text_value(obj.get("os"))
        measurement = obj.get("measurement_only")
        if os_name not in {"linux", "darwin"} or type(measurement) is not bool:
            raise ValueError("Invalid summary platform or measurement mode")
        packages = {text_value(k): Counters.parse(v) for k, v in object_value(obj.get("packages")).items()}
        signals = {}
        for name, value in object_value(obj.get("signals")).items():
            meta = object_value(value)
            if meta.get("enforcement") not in {"enforced", "report-only"}:
                raise ValueError("Invalid enforcement")
            text_value(meta.get("reason"))
            for key in ("reference", "delta"):
                if meta.get(key) is not None:
                    for metric, count in object_value(meta[key]).items():
                        if (
                            metric not in COUNTERS
                            or type(count) is not int
                            or abs(count) > MAX_COUNT
                            or (key == "reference" and count < 0)
                        ):
                            raise ValueError("Invalid policy reference counters")
            signals[text_value(name)] = meta
        if packages.keys() != signals.keys():
            raise ValueError("Measured packages and signal metadata differ")
        raw_files, raw_errors = obj.get("files"), obj.get("errors")
        if not isinstance(raw_files, list) or not isinstance(raw_errors, list):
            raise ValueError("Expected file and error arrays")
        files = []
        seen: set[tuple[str, str]] = set()
        for value in raw_files:
            row = object_value(value)
            label = text_value(row.get("package")) + "/" + text_value(row.get("signal"))
            path = text_value(row.get("file"))
            if label not in packages or row.get("os") != os_name or (label, path) in seen:
                raise ValueError("Invalid or duplicate file membership")
            seen.add((label, path))
            files.append(File(label, path, Counters.parse(row)))
        trimmed = parse_trimmed(obj.get("rows_trimmed"), len(files))
        validate_totals(packages, files, trimmed is not None)
        return cls(
            os_name,
            measurement,
            packages,
            signals,
            tuple(files),
            {text_value(k): text_value(v) for k, v in object_value(obj.get("not_measured")).items()},
            tuple(text_value(value) for value in raw_errors),
            trimmed,
        )


def parse_trimmed(value: object, rows: int) -> int | None:
    """Validate the explicit marker that file rows are a deliberate subset of the original rows.

    Parameters:
        value (object): `rows_trimmed` summary field, `{"original_file_rows": M}` or absent.
        rows (int): Retained file rows.
    Returns:
        int | None: Original row count, or None when the summary is complete.
    Raises:
        ValueError: The marker is malformed or does not exceed the retained rows.
    """
    if value is None:
        return None
    original = object_value(value).get("original_file_rows")
    if type(original) is not int or not rows < original <= MAX_COUNT:
        raise ValueError("Invalid trimmed file row marker")
    return original


def validate_totals(packages: dict[str, Counters], files: list[File], trimmed: bool) -> None:
    """Require per-file rows to add up to their signal's measured totals.

    Only a summary carrying the explicit `rows_trimmed` marker may hold a subset, never more than the total.

    Parameters:
        packages (dict[str, Counters]): Measured signal totals.
        files (list[File]): Validated unique source rows.
        trimmed (bool): Whether the summary declares a deliberate row subset.
    Returns:
        None: File rows match (or, when trimmed, fit within) every measured counter.
    Raises:
        ValueError: File rows disagree with, or when trimmed exceed, the signal totals.
    """
    for label, counters in packages.items():
        for metric, total, uncovered in counters.values:
            measured = [
                (t, u)
                for file in files
                if file.signal == label
                for name, t, u in file.counters.values
                if name == metric
            ]
            rows_total, rows_uncovered = sum(t for t, _ in measured), sum(u for _, u in measured)
            if trimmed and (rows_total > total or rows_uncovered > uncovered):
                raise ValueError("Measured file rows exceed the package counters")
            if not trimmed and (rows_total, rows_uncovered) != (total, uncovered):
                raise ValueError("Measured file rows disagree with the package counters")


@dataclass(frozen=True)
class Evidence:
    """Caller-authenticated OS evidence; missing states deliberately discard stale summaries."""

    host: str
    state: str
    plan: tuple[Signal, ...]
    summary: Summary | None
    reason: str = ""

    @classmethod
    def parse(cls, host: str, value: object, summary: Summary | None) -> Evidence:
        """Bind explicit planned signals and current availability to one host.

        Parameters:
            host (str): Artifact OS label, distinguishing Linux from WSL.
            value (object): Trusted manifest cell.
            summary (Summary | None): Current accounting artifact, if available.
        Returns:
            Evidence: Validated evidence, dropping stale numbers on missing states.
        Raises:
            ValueError: Host, state, platform or planned membership is invalid.
        """
        obj = object_value(value)
        state = text_value(obj.get("state"))
        if host not in HOSTS or state not in {"available", "unavailable", "pending", "NOT RUN"}:
            raise ValueError("Invalid evidence host or state")
        plan = tuple(Signal.parse(k, v) for k, v in sorted(object_value(obj.get("signals")).items()))
        if state != "available":
            return cls(host, state, plan, None)
        if (
            summary is None
            or summary.os != HOSTS[host][1]
            or not summary.packages.keys() <= {s.name for s in plan}
        ):
            raise ValueError("Available evidence lacks a compatible planned summary")
        for signal in plan:
            meta = summary.signals.get(signal.name)
            if meta is not None and meta["enforcement"] != signal.enforcement:
                raise ValueError("Measured signal conflicts with trusted plan")
        return cls(host, state, plan, summary)


def escape(value: str) -> str:
    """Encode all punctuation as entities, blocking Markdown, HTML, autolinks and mentions.

    Parameters:
        value (str): Untrusted display text.
    Returns:
        str: Safe single-cell Markdown/HTML text.

    Raises:
        None.
    """
    return "".join(c if c.isalnum() or c == " " else f"&#{ord(c)};" for c in value)


def headline(evidence: Evidence) -> str:
    """Count zero-uncovered enforced signals against the complete planned denominator.

    Parameters:
        evidence (Evidence): Current OS evidence.
    Returns:
        str: Numeric per-OS headline or explicit nonnumeric availability.

    Raises:
        None.
    """
    label = HOSTS[evidence.host][0] + " enforced signals: "
    summary = evidence.summary
    if summary is None:
        return label + evidence.state
    enforced = [s for s in evidence.plan if s.enforcement == "enforced"]
    zero = sum(
        s.state == "planned"
        and s.name in summary.packages
        and all(uncovered == 0 for _, _, uncovered in summary.packages[s.name].values)
        for s in enforced
    )
    incomplete = summary.errors or any(
        s.state != "planned" or s.name not in summary.packages for s in enforced
    )
    suffix = "; incomplete" if incomplete else ""
    suffix += "; measurement only, NOT gate evidence" if summary.measurement_only else ""
    return f"{label}{zero}/{len(enforced)} zero uncovered (measured counters only){suffix}"


def measured_delta(current: Evidence, baseline: Evidence | None, signal: Signal) -> str:
    """Compare only identical OS, signal and caller-declared producer semantics.

    Parameters:
        current (Evidence): Current measured evidence.
        baseline (Evidence | None): Optional authenticated main snapshot.
        signal (Signal): Planned current signal.
    Returns:
        str: Signed uncovered deltas or an explicit unavailable/added/incompatible label.

    Raises:
        None.
    """
    if baseline is None or baseline.summary is None or current.summary is None or signal.state != "planned":
        return "unavailable"
    previous = next((s for s in baseline.plan if s.name == signal.name), None)
    if previous is None:
        return "added"
    if baseline.host != current.host or previous.semantics != signal.semantics:
        return "incompatible"
    before = baseline.summary.packages.get(signal.name)
    after = current.summary.packages.get(signal.name)
    if (
        before is None
        or after is None
        or baseline.summary.errors
        or current.summary.errors
        or previous.state != "planned"
    ):
        return "unavailable"
    if tuple(n for n, _, _ in before.values) != tuple(n for n, _, _ in after.values):
        return "incompatible counters"
    return ", ".join(
        f"{name} {new - old:+d}"
        for (name, _, new), (_, _, old) in zip(after.values, before.values, strict=True)
    )


def policy_delta(value: object) -> str:
    """Format already-labelled policy-reference deltas, never measured-main deltas.

    Parameters:
        value (object): Validated signed counter mapping or null.
    Returns:
        str: Independent signed counters or unavailable.

    Raises:
        None.
    """
    if value is None:
        return "unavailable"
    return ", ".join(
        f"{name} {count:+d}" for name in COUNTERS if type(count := object_value(value).get(name)) is int
    )


def source_link(file: File, plan: tuple[Signal, ...], provenance: Provenance) -> str:
    """Build source links only from a trusted repository and tested checkout identity.

    Parameters:
        file (File): Untrusted file display path.
        plan (tuple[Signal, ...]): Trusted package roots.
        provenance (Provenance): Authenticated repository and checkout SHA.
    Returns:
        str: Escaped link at the tested SHA, or display-only text for unsafe paths.

    Raises:
        None.
    """
    display = escape(file.path)
    if (
        not file.path
        or not file.path.isprintable()
        or PurePosixPath(file.path).is_absolute()
        or "\\" in file.path
        or any(p in {"", ".", ".."} for p in file.path.split("/"))
    ):
        return display
    signal = next((s for s in plan if s.name == file.signal), None)
    if signal is None:
        return display
    path = "/".join(part for part in (signal.source_root, file.path) if part)
    url = f"https://github.com/{provenance.repository}/blob/{provenance.tested_sha}/{quote(path, safe='/')}"
    return f"[{display}]({url})"


def signal_row(cell: Evidence, signal: Signal, main: Evidence | None) -> str:
    """Render one planned signal, flagging a measurement the plan says was NOT RUN.

    Parameters:
        cell (Evidence): Host evidence.
        signal (Signal): Trusted planned signal.
        main (Evidence | None): Optional measured-main evidence for the same host.
    Returns:
        str: One escaped table row.

    Raises:
        None.
    """
    summary = cell.summary
    counts = summary.packages.get(signal.name) if summary is not None else None
    note = ""
    if signal.state != "planned":
        counters = " | ".join([signal.state] * 4)
        if counts is not None:
            note = "; INCONSISTENT: measurement present for a NOT RUN signal"
    elif counts is not None:
        counters = counts.cells()
    else:
        counters = " | ".join(["unavailable" if summary is not None else cell.state] * 4)
    meta = summary.signals.get(signal.name, {}) if summary is not None and signal.state == "planned" else {}
    enforcement = signal.enforcement if signal.enforcement == "enforced" else "REPORT-ONLY (outside headline)"
    return (
        f"{escape(signal.name)} | {counters} | {enforcement}: {escape(signal.reason)}{note} | "
        f"{policy_delta(meta.get('delta'))} | {measured_delta(cell, main, signal)}"
    )


def host_rows(cell: Evidence, main: Evidence | None) -> list[str]:
    """Build one host's table, removed-signal, error and not-measured rows.

    Parameters:
        cell (Evidence): Host evidence.
        main (Evidence | None): Optional measured-main evidence for the same host.
    Returns:
        list[str]: Ordered rows, header first.

    Raises:
        None.
    """
    rows = [
        f"\n{HOSTS[cell.host][0]}:\n\nSignal | L | F | B | S | Enforcement / reason | "
        "vs policy reference | vs measured main\n"
        "--- | --- | --- | --- | --- | --- | --- | ---"
    ]
    rows.extend(
        signal_row(cell, signal, main)
        for signal in sorted(cell.plan, key=lambda s: (s.enforcement != "enforced", s.name))
    )
    if main is not None:
        removed = sorted({s.name for s in main.plan} - {s.name for s in cell.plan})
        rows.extend(f"{escape(name)} | removed vs measured main" for name in removed)
    summary = cell.summary
    if summary is None:
        if cell.reason:
            rows.append(f"\nUnavailable: {escape(cell.reason)}")
        return rows
    if summary.trimmed_from is not None:
        rows.append(f"\nFile rows partial ({len(summary.files)} of {summary.trimmed_from}).")
    rows.extend(f"Error: {escape(error)}" for error in summary.errors)
    rows.extend(
        f"Not measured: {escape(name)}: {escape(reason)}"
        for name, reason in sorted(summary.not_measured.items())
    )
    return rows


def host_file_rows(cell: Evidence, provenance: Provenance) -> list[str]:
    """Build one host's per-file rows, most uncovered first.

    Parameters:
        cell (Evidence): Host evidence.
        provenance (Provenance): Authenticated run identity for source links.
    Returns:
        list[str]: Ordered rows for planned signals only.

    Raises:
        None.
    """
    if cell.summary is None:
        return []
    planned = {s.name for s in cell.plan if s.state == "planned"}
    files = sorted(
        (file for file in cell.summary.files if file.signal in planned),
        key=lambda f: (-sum(u for _, _, u in f.counters.values), f.signal, f.path),
    )
    return [
        f"{HOSTS[cell.host][0]} | {escape(file.signal)} | {source_link(file, cell.plan, provenance)} | "
        f"{file.counters.cells()}"
        for file in files
    ]


def admit_rows(rows: list[str], budget: int) -> tuple[list[str], int]:
    """Admit whole rows in order until the character budget is spent.

    Parameters:
        rows (list[str]): Candidate rows.
        budget (int): Remaining characters.
    Returns:
        tuple[list[str], int]: Admitted rows and the budget left.

    Raises:
        None.
    """
    kept: list[str] = []
    for row in rows:
        if len(row) + 1 > budget:
            break
        kept.append(row)
        budget -= len(row) + 1
    return kept, budget


def assemble(blocks: list[str], signal_rows: list[str], file_rows: list[str], footer: str) -> str:
    """Join the report sections; the details element is always closed.

    Parameters:
        blocks (list[str]): Provenance, headlines and legend.
        signal_rows (list[str]): Admitted signal/status rows.
        file_rows (list[str]): Admitted per-file rows.
        footer (str): Omitted-row counts.
    Returns:
        str: Complete Markdown.

    Raises:
        None.
    """
    details = (
        "<details><summary>Per-file measurements (uncovered first)</summary>\n\n"
        "OS | Signal | File | L | F | B | S\n--- | --- | --- | --- | --- | --- | ---"
    )
    return (
        "\n\n".join(blocks)
        + "\n"
        + "\n".join(signal_rows)
        + "\n\n"
        + details
        + "\n"
        + "\n".join(file_rows)
        + "\n\n</details>"
        + footer
    )


def render_markdown(
    evidence: tuple[Evidence, ...],
    provenance: Provenance,
    baseline: tuple[Evidence, ...] = (),
    limit: int = MAX_MARKDOWN,
) -> str:
    """Render bounded deterministic independent tables and collapsed source details.

    Parameters:
        evidence (tuple[Evidence, ...]): Validated OS evidence.
        provenance (Provenance): Authenticated run identity supplied by caller.
        baseline (tuple[Evidence, ...]): Optional authenticated measured-main snapshot.
        limit (int): Maximum output characters, at most 60,000.
    Returns:
        str: Escaped Markdown with deterministic whole-row omission counts.
    Raises:
        ValueError: The limit is invalid or cannot fit essential report state.
    """
    if not 1000 <= limit <= MAX_MARKDOWN or len({e.host for e in evidence}) != len(evidence):
        raise ValueError("Invalid Markdown limit or duplicate OS")
    ordered = sorted(evidence, key=lambda e: e.host)
    blocks = [
        provenance.markdown(),
        "\n".join(headline(e) for e in ordered),
        "L/F/B/S = lines/functions/branches/statements. Cells: covered/total (uncovered). "
        "Unsupported: not measured; zero denominator: N/A. Signals are never averaged. "
        "Badges and cached reports are not merge evidence.",
    ]
    rows = [
        row
        for cell in ordered
        for row in host_rows(cell, next((e for e in baseline if e.host == cell.host), None))
    ]
    files = [row for cell in ordered for row in host_file_rows(cell, provenance)]
    # The reserved footer is built from the full counts, so the final one is never longer.
    reserved = f"\nOmitted rows: {len(rows)} signal/status, {len(files)} files."
    budget = limit - len(assemble(blocks, [], [], reserved))
    if budget < 0:
        raise ValueError("Essential report state exceeds Markdown limit")
    kept_rows, budget = admit_rows(rows, budget)
    kept_files, _ = admit_rows(files, budget)
    footer = (
        f"\nOmitted rows: {len(rows) - len(kept_rows)} signal/status, {len(files) - len(kept_files)} files."
    )
    return assemble(blocks, kept_rows, kept_files, footer)


@dataclass(frozen=True)
class Provenance:
    """Authenticated run identity, never accepted from accounting artifacts."""

    repository: str
    head_sha: str
    tested_sha: str
    run_id: int
    attempt: int

    def __post_init__(self) -> None:
        """Reject malformed caller-provided provenance.

        Raises:
            ValueError: Repository, SHA, run or attempt is invalid.

        Parameters:
            None.

        Returns:
            None: The boundary contract is satisfied.
        """
        if (
            not SAFE_REPOSITORY.fullmatch(self.repository)
            or not SHA.fullmatch(self.head_sha)
            or not SHA.fullmatch(self.tested_sha)
            or type(self.run_id) is not int
            or self.run_id <= 0
            or type(self.attempt) is not int
            or self.attempt <= 0
        ):
            raise ValueError("Invalid run provenance")

    def markdown(self) -> str:
        """Render explicit repository, head, tested checkout, run and attempt.

        Returns:
            str: Run identity without artifact-supplied URLs.

        Parameters:
            None.

        Raises:
            None.
        """
        return (
            f"Repository: {escape(self.repository)}; head: {self.head_sha}; tested: {self.tested_sha}; "
            f"run: {self.run_id}; attempt: {self.attempt}."
        )


def render_badge(evidence: Evidence) -> str:
    """Render an escaped text-only SVG badge with no links or global percentage.

    Parameters:
        evidence (Evidence): OS evidence, including explicit availability.
    Returns:
        str: Standalone SVG with a numeric or unavailable headline.

    Raises:
        None.
    """
    label = html.escape(headline(evidence), quote=True)
    width = min(1200, 7 * len(headline(evidence)) + 20)
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="24" role="img" '
        f'aria-label="{label}"><title>{label}</title><rect width="100%" height="24" fill="#444"/>'
        f'<text x="10" y="16" fill="white" font-family="sans-serif" font-size="11">{label}</text></svg>'
    )


def read_host_summary(directory: Path, host: str) -> Summary | None:
    """Read and validate one host's artifact, if it was downloaded.

    Parameters:
        directory (Path): Artifact parent.
        host (str): Trusted host label.
    Returns:
        Summary | None: Validated summary, or None when no artifact exists.
    Raises:
        ValueError: The artifact is malformed or unsafe.
        OSError: The artifact cannot be read.
    """
    path = directory / f"coverage-{host}.zip"
    if not path.exists():
        path = directory / f"coverage-{host}" / "coverage" / "summary.json"
    return Summary.parse(read_summary(path)) if path.exists() else None


def load_evidence(directory: Path, plan_path: Path) -> tuple[Evidence, ...]:
    """Read a trusted explicit manifest and its locally downloaded summaries.

    A bad or missing artifact degrades only its own host to `unavailable` with a bounded reason.

    Parameters:
        directory (Path): Artifact parent containing coverage-HOST/coverage/summary.json or coverage-HOST.zip.
        plan_path (Path): Trusted JSON mapping hosts to state and complete signal plans.
    Returns:
        tuple[Evidence, ...]: Validated evidence, never carrying numbers for a degraded host.
    Raises:
        ValueError: The manifest itself is malformed.
        OSError: The manifest cannot be read.
    """
    manifest = read_summary(plan_path)
    cells = []
    for host, value in sorted(manifest.items()):
        obj = object_value(value)
        if host not in HOSTS:
            raise ValueError("Invalid evidence host")
        reason = "artifact missing or expired"
        if obj.get("state") == "available":
            try:
                summary = read_host_summary(directory, host)
                if summary is not None:
                    cells.append(Evidence.parse(host, obj, summary))
                    continue
            except (OSError, ValueError) as error:
                LOGGER.warning(f"Host '{host}' artifact unusable: '{error}'")
                reason = str(error)[:MAX_REASON]
            obj = obj | {"state": "unavailable"}
            cells.append(replace(Evidence.parse(host, obj, None), reason=reason))
        else:
            cells.append(Evidence.parse(host, obj, None))
    return tuple(cells)


def main(argv: list[str] | None = None) -> int:
    """Write local Markdown and optional SVG files; never call GitHub or mutate Git.

    Parameters:
        argv (list[str] | None): CLI arguments, otherwise process arguments.
    Returns:
        int: Zero on success, one for invalid or unreadable inputs.
    Raises:
        SystemExit: Argparse rejects missing arguments.
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifacts", type=Path, required=True)
    parser.add_argument("--plan", type=Path, required=True)
    parser.add_argument("--head-sha", required=True)
    parser.add_argument("--tested-sha", required=True)
    parser.add_argument("--run-id", type=int, required=True)
    parser.add_argument("--attempt", type=int, required=True)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--output", type=Path, help="Write Markdown here, otherwise stdout.")
    parser.add_argument("--baseline-artifacts", type=Path)
    parser.add_argument("--baseline-plan", type=Path)
    parser.add_argument("--badge-dir", type=Path)
    args = parser.parse_args(argv)
    try:
        provenance = Provenance(args.repository, args.head_sha, args.tested_sha, args.run_id, args.attempt)
        if bool(args.baseline_artifacts) != bool(args.baseline_plan):
            raise ValueError("Measured-main inputs require both artifacts and plan")
        cells = load_evidence(args.artifacts.resolve(), args.plan.resolve())
        baseline = (
            load_evidence(args.baseline_artifacts.resolve(), args.baseline_plan.resolve())
            if args.baseline_plan
            else ()
        )
        markdown = render_markdown(cells, provenance, baseline)
        if args.output:
            args.output.write_text(markdown, encoding="utf-8")
        else:
            sys.stdout.write(markdown + "\n")
        if args.badge_dir:
            args.badge_dir.mkdir(parents=True, exist_ok=True)
            for cell in cells:
                (args.badge_dir / f"{cell.host}.svg").write_text(render_badge(cell), encoding="utf-8")
    except (OSError, ValueError) as error:
        LOGGER.error(f"Cannot render coverage report: '{error}'")
        return 1
    return 0


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    sys.exit(main())
