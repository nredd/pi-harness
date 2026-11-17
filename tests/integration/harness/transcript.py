"""Invariants over a captured transcript: every settled tool entry occupies one line.

Entries with hidden detail start with `▸`; entries with nothing more to show have a blank
(two-space) disclosure gutter. Both must end before the next entry rule or marked entry.
Assistant text is explicitly allowed by each scenario.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

COLLAPSED = "▸ "
EXPANDED = "▾ "
EDITOR_RULE = re.compile(r"^─{20,}$")
ENTRY_RULE = re.compile(r"^┄{20,}$")
SUMMARY_SEPARATOR = " · "
KEY_LENGTH = 24


@dataclass(frozen=True)
class Entry:
    """One collapsed transcript entry.

    Attributes:
        row (int): screen row.
        text (str): full row text.
        key (str): stable prefix used to find the entry again after it is toggled.
    """

    row: int
    text: str
    key: str


def entry_key(row_text: str) -> str:
    """Return the call part of a marked row, which survives toggling.

    Parameters:
        row_text (str): row starting with `▸ ` or `▾ `.

    Returns:
        str: up to `KEY_LENGTH` chars of the call, before any ` · ` summary.
    """
    body = row_text[len(COLLAPSED) :].strip()
    return body.split(SUMMARY_SEPARATOR, 1)[0][:KEY_LENGTH].strip()


def transcript_region(
    rows: list[str], start_pattern: str, last_pattern: str | None = None
) -> tuple[int, int]:
    """Locate the transcript rows after the user prompt and above the editor.

    Widgets placed above the editor (e.g. a todo overlay) sit between the transcript and the
    editor rule, so `last_pattern` can end the region at the last row it matches instead.

    Parameters:
        rows (list[str]): plain screen rows.
        start_pattern (str): regex for the user prompt row; the region starts after it.
        last_pattern (str | None): regex for the final transcript row, matched against the
            stripped row; the last match ends the region (inclusive).

    Returns:
        tuple[int, int]: `[start, end)` row indexes.

    Raises:
        AssertionError: the prompt, the editor rule, or the last row is not on screen.
    """
    start_re = re.compile(start_pattern)
    start = next((index for index, row in enumerate(rows) if start_re.search(row)), None)
    if start is None:
        raise AssertionError(f"Prompt row /{start_pattern}/ not on screen:\n" + "\n".join(rows))
    end = next(
        (index for index in range(start + 1, len(rows)) if EDITOR_RULE.match(rows[index].strip())), None
    )
    if end is None:
        raise AssertionError("Editor rule not on screen:\n" + "\n".join(rows))
    if last_pattern is not None:
        last_re = re.compile(last_pattern)
        matches = [index for index in range(start + 1, end) if last_re.search(rows[index].strip())]
        if not matches:
            raise AssertionError(f"Last row /{last_pattern}/ not in the transcript:\n" + "\n".join(rows))
        end = matches[-1] + 1
    return start + 1, end


def collapsed_entries(rows: list[str], start: int, end: int) -> list[Entry]:
    """Return every collapsed entry in a region.

    Parameters:
        rows (list[str]): plain screen rows.
        start (int): first region row.
        end (int): one past the last region row.

    Returns:
        list[Entry]: entries in screen order.
    """
    return [
        Entry(row=index, text=rows[index], key=entry_key(rows[index]))
        for index in range(start, end)
        if rows[index].startswith(COLLAPSED)
    ]


def one_line_violations(rows: list[str], start: int, end: int, allowed: list[str]) -> list[str]:
    """Report rows that break the one-line, detail-only-disclosure invariant.

    Parameters:
        rows (list[str]): plain screen rows.
        start (int): first region row.
        end (int): one past the last region row.
        allowed (list[str]): regexes for unmarked rows the scenario expects (assistant text).

    Returns:
        list[str]: human-readable violations; empty when the region is clean.
    """
    allowed_res = [re.compile(pattern) for pattern in allowed]
    problems = []
    for index in range(start, end):
        row = rows[index]
        if not row.strip() or ENTRY_RULE.match(row.strip()):
            continue
        if row.startswith(EXPANDED):
            problems.append(f"row {index} is expanded by default: {row!r}")
            continue
        static_entry = row.startswith("  ") and (
            index == start or bool(ENTRY_RULE.match(rows[index - 1].strip()))
        )
        if row.startswith(COLLAPSED) or static_entry:
            follower = rows[index + 1] if index + 1 < end else ""
            if (
                follower.strip()
                and not follower.startswith((COLLAPSED, EXPANDED))
                and not ENTRY_RULE.match(follower.strip())
            ):
                problems.append(f"row {index} spills onto a second line: {row!r} / {follower!r}")
            continue
        if not any(pattern.search(row.strip()) for pattern in allowed_res):
            problems.append(f"row {index} is output outside any one-line entry: {row!r}")
    return problems
