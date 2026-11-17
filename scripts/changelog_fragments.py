"""Validate and explicitly fold subagents changelog fragments, without releasing anything.

References:
    https://github.com/nredd/pi-harness/issues/932
    https://keepachangelog.com/en/1.0.0/
"""

from __future__ import annotations

import argparse
import logging
import os
import re
import tempfile
import unicodedata
from dataclasses import dataclass
from pathlib import Path

LOGGER = logging.getLogger(__name__)
PACKAGE = "packages/subagents"
CATEGORIES = ("added", "changed", "fixed", "refactored", "removed", "deprecated", "security")
FRAGMENT_NAME = re.compile(r"([1-9][0-9]*)\.(added|changed|fixed|refactored|removed|deprecated|security)\.md")
RELEASE_HEADER = re.compile(r"^## \[[^\]\n]+\].*$", re.MULTILINE)


@dataclass(frozen=True)
class Fragment:
    """Validated fragment data.

    Parameters:
        path (Path): Canonical fragment file.
        category (str): Closed lowercase category.
        bullet (str): Exact attributed, LF-terminated, one-line Markdown bullet.
    """

    path: Path
    category: str
    bullet: str


def fragment_path(package: str, path: str) -> bool:
    """Return whether a package-relative path belongs to the closed fragment grammar.

    Parameters:
        package (str): Repository-relative package directory.
        path (str): Package-relative path.

    Returns:
        bool: Only a direct subagents changes file with a canonical issue/category name.
    """
    return (
        package == PACKAGE
        and path.startswith("changes/")
        and FRAGMENT_NAME.fullmatch(path.removeprefix("changes/")) is not None
    )


def safe_path(root: Path, relative: str) -> Path:
    """Reject symlinks in every package-relative component before reading or writing.

    Parameters:
        root (Path): Trusted repository root.
        relative (str): Fixed relative path below it.

    Returns:
        Path: Unresolved checked path.

    Raises:
        ValueError: A component is a symbolic link.
    """
    current = root
    for part in Path(relative).parts:
        current /= part
        if current.is_symlink():
            raise ValueError(f"Refuse symlink '{current}'")
    return current


def read_fragments(root: Path) -> list[Fragment]:
    """Read all directory entries, refusing malformed names, payloads and duplicates.

    Parameters:
        root (Path): Repository root.

    Returns:
        list[Fragment]: Canonical numeric issue order, then category order.

    Raises:
        ValueError: An entry is malformed, linked, duplicated or not a regular file.
        OSError: A file cannot be read.
    """
    directory = safe_path(root, f"{PACKAGE}/changes")
    if not directory.exists():
        return []
    fragments: list[Fragment] = []
    bullets: set[str] = set()
    for path in sorted(directory.iterdir()):
        match = FRAGMENT_NAME.fullmatch(path.name)
        if match is None or path.is_symlink() or not path.is_file():
            raise ValueError(f"Invalid fragment path '{path}'")
        bullet = path.read_bytes().decode("utf-8")
        issue, category = match.groups()
        reference = f"[#{issue}](https://github.com/nredd/pi-harness/issues/{issue})"
        if (
            not bullet.startswith("- ")
            or not bullet.endswith("\n")
            or bullet.splitlines(keepends=True) != [bullet]
            or bullet[2:-1] != bullet[2:-1].strip()
            or any(unicodedata.category(char) == "Cc" for char in bullet[:-1])
            or reference not in bullet
        ):
            raise ValueError(f"Expected one exact bullet with issue attribution in '{path}'")
        if bullet in bullets:
            raise ValueError(f"Duplicate fragment bullet in '{path}'")
        bullets.add(bullet)
        fragments.append(Fragment(path, category, bullet))
    return sorted(fragments, key=lambda item: (int(item.path.name.split(".")[0]), item.category))


def folded_text(text: str, fragments: list[Fragment]) -> str:
    """Insert new bullets in category order, preserving released bytes and legacy entries.

    Parameters:
        text (str): Original UTF-8 changelog.
        fragments (list[Fragment]): Validated fragments.

    Returns:
        str: Replacement text; exact existing bullets are recognized after an interrupted fold.

    Raises:
        ValueError: Unreleased is missing/ambiguous, or its category/bullet data is malformed.
    """
    headers = list(RELEASE_HEADER.finditer(text))
    if not headers or headers[0].group() != "## [Unreleased]" or text.count("## [Unreleased]") != 1:
        raise ValueError("Expected exactly one first `## [Unreleased]` section")
    start = headers[0].end()
    end = headers[1].start() if len(headers) > 1 else len(text)
    lines = text[start:end].splitlines(keepends=True)
    existing, positions = unreleased_data(lines)
    additions: dict[str, list[str]] = {}
    for fragment in fragments:
        previous = existing.get(fragment.bullet)
        if previous is not None:
            if previous != fragment.category:
                raise ValueError(f"Fragment category conflicts with existing bullet '{fragment.path}'")
            continue
        additions.setdefault(fragment.category, []).append(fragment.bullet)
    # Reverse insertions keep offsets tied to the original lines. Missing categories append below.
    for position, key in sorted(((pos, key) for key, pos in positions.items()), reverse=True):
        lines[position:position] = additions.pop(key, [])
    for key in CATEGORIES:
        if key in additions:
            lines.extend([f"\n### {key.title()}\n", *additions[key], "\n"])
    return text[:start] + "".join(lines) + text[end:]


def unreleased_data(lines: list[str]) -> tuple[dict[str, str], dict[str, int]]:
    """Validate existing legacy lines and locate category insertion points.

    Parameters:
        lines (list[str]): Unreleased lines including original line endings.

    Returns:
        tuple[dict[str, str], dict[str, int]]: Exact bullets' categories and insertion offsets.

    Raises:
        ValueError: Existing headings, bullets or other data are ambiguous/malformed.
    """
    category: str | None = None
    existing: dict[str, str] = {}
    positions: dict[str, int] = {}
    for index, line in enumerate(lines):
        if line.startswith("### "):
            category = line[4:].strip().lower()
            if category not in CATEGORIES or line != f"### {category.title()}\n":
                raise ValueError(f"Invalid Unreleased category '{line.rstrip()}'")
            positions[category] = index + 1
        elif line.startswith("- "):
            if category is None or line in existing or not line.endswith("\n"):
                raise ValueError("Ambiguous Unreleased bullet")
            existing[line] = category
            positions[category] = index + 1
        elif line.strip() and not line.startswith("> "):
            raise ValueError("Malformed Unreleased data")
    return existing, positions


def run(root: Path, *, fold: bool) -> None:
    """Validate, or atomically replace the changelog before consuming fragments.

    An exclusive package-local lock serializes cooperating folds. A failure before replacement
    keeps all inputs; interruption during deletion is restart-safe because exact bullets already
    in their category are not inserted again. This is not an adversarial filesystem sandbox.

    Parameters:
        root (Path): Trusted checkout root, not an untrusted concurrently mutated directory.
        fold (bool): Explicitly opt into mutation.

    Returns:
        None: Validation succeeds, or a complete/restartable fold is written.

    Raises:
        ValueError: Fragment/changelog validation fails.
        OSError: Reading, locking, writing or deleting fails; retry after resolving the error.
    """
    changelog = safe_path(root, f"{PACKAGE}/CHANGELOG.md")
    lock = safe_path(root, f"{PACKAGE}/.changelog-fold.lock")
    # Checks never create a lock or write anything.
    if not fold:
        folded_text(changelog.read_bytes().decode("utf-8"), read_fragments(root))
        return
    lock.mkdir()
    try:
        fragments = read_fragments(root)
        original = changelog.read_bytes().decode("utf-8")
        replacement = folded_text(original, fragments)
        if replacement != original:
            with tempfile.NamedTemporaryFile(dir=changelog.parent, prefix=".changelog-", delete=False) as out:
                temporary = Path(out.name)
                try:
                    out.write(replacement.encode("utf-8"))
                    out.flush()
                    os.fsync(out.fileno())
                    temporary.chmod(changelog.stat().st_mode & 0o777)
                    temporary.replace(changelog)
                finally:
                    temporary.unlink(missing_ok=True)
        for fragment in fragments:
            fragment.path.unlink()
    finally:
        lock.rmdir()


def main(argv: list[str] | None = None) -> int:
    """Run the explicit check/fold CLI.

    Parameters:
        argv (list[str] | None): Arguments, defaulting to the process arguments.

    Returns:
        int: Zero on success, one on validation or filesystem failure.
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--fold", action="store_true", help="Fold subagents fragments, without releasing")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    try:
        run(args.repo.absolute(), fold=args.fold)
    except (OSError, ValueError) as error:
        LOGGER.error(f"Cannot process changelog fragments: {error}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
