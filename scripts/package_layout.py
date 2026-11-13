"""Gate the layout of every tracked package against the standard in nredd/pi-harness#860.

Walks `git ls-files` for `packages/` (publish rules) plus `integration/inprocess` and `integration/testkit`
(script and config rules only) and prints one line per violation: `<package>: <path>: <rule>`.

Today's deviations live in `scripts/package_layout.json`, a sorted array with one violation line per entry.
The list can only shrink:

- an entry that is no longer violated is stale and fails
- with `--compare-ref`, an entry the merge base of `HEAD` and the ref does not carry fails, so a new
  violation cannot be waived by adding its line
- the file must be in canonical form (sorted, unique, one entry per line) so merges stay mechanical

A package issue deletes its own entries in the same PR that fixes the layout.

A violation under a top-level entry that is itself a violation (a banned directory, or a file outside the
closed list) is reported once, for that entry; the rules below the entry apply once it moves into place.
Import scanning is textual (`from`, `import`, `require`), so `new URL("../x", import.meta.url)` is not seen.

References:
    https://github.com/nredd/pi-harness/issues/860
    https://github.com/nredd/pi-harness/issues/861
"""

from __future__ import annotations

import argparse
import json
import logging
import posixpath
import re
import sys
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from pathlib import Path

from ci_paths import ClassificationError, repo_root, run_git

LOGGER = logging.getLogger(__name__)

ALLOWLIST = "scripts/package_layout.json"
PUBLISH_ROOT = "packages"
# Same `package.json` script and config rules as a package, none of the publish rules.
SHARED_PACKAGES = ("integration/inprocess", "integration/testkit")

REQUIRED_FILES = (
    "package.json",
    "README.md",
    "CHANGELOG.md",
    "LICENSE",
    "tsconfig.json",
    "vitest.config.ts",
    "src/index.ts",
)
# Closed list of top-level entries. `dist` may exist as gitignored output; tracking it is a violation.
TOP_LEVEL_ENTRIES = frozenset(
    {
        *REQUIRED_FILES,
        "src",
        "test",
        "dist",
        "tsconfig.build.json",
        "scripts",
        "native",
        "examples",
        "schemas",
        "agents",
        "skills",
        "themes",
        "prompts",
        "settings",
        "NOTICE.md",
        "licenses",
        "prebuilt",
    }
)
EXTRA_VITEST_CONFIG = re.compile(r"vitest\.[a-z0-9][a-z0-9-]*\.config\.ts")
PI_RESOURCE_DIRS = frozenset({"agents", "skills", "themes", "prompts", "settings"})
ROOT_MARKDOWN = frozenset({"README.md", "CHANGELOG.md", "NOTICE.md"})
MEDIA_SUFFIXES = frozenset(
    {
        ".avif",
        ".avi",
        ".bmp",
        ".gif",
        ".heic",
        ".ico",
        ".jpeg",
        ".jpg",
        ".m4v",
        ".mkv",
        ".mov",
        ".mp4",
        ".png",
        ".svg",
        ".tif",
        ".tiff",
        ".webm",
        ".webp",
    }
)
BIOME_CONFIGS = frozenset({"biome.json", "biome.jsonc"})
# `test:<signal>` is one name per extra `coverage/policy.json` signal, so any `test:` suffix is accepted.
SCRIPT_NAMES = frozenset(
    {"lint", "format", "typecheck", "test", "test:bun", "check", "build", "prepack", "bench"}
)
CODE_SUFFIXES = frozenset({".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"})
STRAY_TEST_SUFFIXES = (".test.mjs", ".test.js", ".test.mts", ".test.cts", ".test.tsx", ".test.jsx")
RELATIVE_SPECIFIER = re.compile(r"""\b(?:from|import|require)\s*\(?\s*["'](\.\.?(?:/[^"'\n]*)?)["']""")
TEST_SUPPORT_DIRS = frozenset({"support", "fixtures"})
SNAPSHOT_DIR = "__snapshots__"


@dataclass(frozen=True)
class Violation:
    """One layout violation.

    Parameters:
        package (str): Package directory relative to the repository root, e.g. `packages/todo`.
        path (str): Path inside the package, POSIX separators.
        rule (str): Rule name, with the offending name appended where the path alone is ambiguous.
    """

    package: str
    path: str
    rule: str

    def line(self) -> str:
        """Return the report and allowlist form of the violation.

        Returns:
            str: `<package>: <path>: <rule>`.
        """
        return f"{self.package}: {self.path}: {self.rule}"


def is_fixture(path: str) -> bool:
    """Return whether a package-relative path sits under `test/fixtures/`.

    Parameters:
        path (str): Package-relative POSIX path.

    Returns:
        bool: Whether the path is fixture data, which may model any on-disk layout.
    """
    return path.startswith("test/fixtures/")


def dot_entry(path: str) -> str | None:
    """Return the shortest prefix of a path that ends in a dotfile or dot directory.

    Parameters:
        path (str): Package-relative POSIX path.

    Returns:
        str | None: The prefix, or None when the path has no dot component or is a fixture.
    """
    if is_fixture(path):
        return None
    parts = path.split("/")
    for index, part in enumerate(parts):
        if part.startswith("."):
            return "/".join(parts[: index + 1])
    return None


def markdown_allowed(path: str) -> bool:
    """Return whether a markdown file is one the standard permits.

    Parameters:
        path (str): Package-relative POSIX path ending in `.md`.

    Returns:
        bool: Root `README.md`, `CHANGELOG.md` or `NOTICE.md`, a Pi resource, or a fixture.
    """
    return path in ROOT_MARKDOWN or path.split("/", maxsplit=1)[0] in PI_RESOURCE_DIRS or is_fixture(path)


def test_tree_problem(path: str) -> str | None:
    """Name the rule a file under `test/` breaks, if any.

    Parameters:
        path (str): Package-relative POSIX path starting with `test/`.

    Returns:
        str | None: A rule name, or None when the file belongs in `test/`.
    """
    parts = path.split("/")[1:]
    if SNAPSHOT_DIR in parts[:-1] or (len(parts) > 1 and parts[0] == "fixtures"):
        return None
    name = parts[-1]
    if parts[0] == "support":
        return "test-in-support" if name.endswith(".test.ts") else None
    if parts[0] == "bench":
        return None if name.endswith(".bench.ts") and len(parts) == 2 else "test-content"
    return None if name.endswith(".test.ts") else "test-content"


def import_escapes(package: str, path: str, root: Path) -> Iterable[Violation]:
    """Yield a violation per relative import in a source file that resolves outside its package.

    Parameters:
        package (str): Package directory relative to the repository root.
        path (str): Package-relative POSIX path of the source file.
        root (Path): Repository root.

    Returns:
        Iterable[Violation]: One per distinct leaving specifier; empty when the file is unreadable or absent.
    """
    source = root / package / path
    if not source.is_file():
        return
    try:
        text = source.read_text(encoding="utf-8", errors="replace")
    except OSError as e:
        LOGGER.warning(f"Cannot read '{source}' for the import check: {e}")
        return
    directory = posixpath.dirname(path)
    for specifier in sorted(set(RELATIVE_SPECIFIER.findall(text))):
        target = posixpath.normpath(posixpath.join(directory, specifier))
        if target == ".." or target.startswith("../"):
            yield Violation(package, path, f"import-escape {specifier}")


def file_violations(package: str, path: str, root: Path) -> Iterable[Violation]:
    """Yield the per-file rule violations of one tracked file inside an allowed top-level entry.

    Parameters:
        package (str): Package directory relative to the repository root.
        path (str): Package-relative POSIX path.
        root (Path): Repository root.

    Returns:
        Iterable[Violation]: Violations of the markdown, media, dist, test and import rules.
    """
    top = path.split("/", maxsplit=1)[0]
    suffix = posixpath.splitext(path)[1].lower()
    if suffix == ".md" and not markdown_allowed(path):
        yield Violation(package, path, "markdown")
    if suffix in MEDIA_SUFFIXES:
        yield Violation(package, path, "media")
    if top == "dist":
        yield Violation(package, path, "tracked-dist")
    if is_fixture(path):
        return
    if path.endswith(STRAY_TEST_SUFFIXES):
        yield Violation(package, path, "test-extension")
    elif path.endswith(".test.ts") and top != "test":
        yield Violation(package, path, "test-location")
    elif top == "test":
        problem = test_tree_problem(path)
        if problem is not None:
            yield Violation(package, path, problem)
    if posixpath.basename(path) in BIOME_CONFIGS:
        yield Violation(package, path, "biome-config")
    if suffix in CODE_SUFFIXES:
        yield from import_escapes(package, path, root)


def top_level_violation(package: str, entry: str, is_directory: bool) -> Violation | None:
    """Return the closed-list violation for one top-level entry, if it has one.

    Parameters:
        package (str): Package directory relative to the repository root.
        entry (str): Top-level file or directory name.
        is_directory (bool): Whether tracked paths sit below the entry.

    Returns:
        Violation | None: A `dotfile` or `top-level-entry` violation, or None when the entry is allowed or
            another rule (`markdown`, `media`, `biome-config`) already names it.
    """
    if entry.startswith("."):
        return Violation(package, entry, "dotfile")
    if entry in TOP_LEVEL_ENTRIES or EXTRA_VITEST_CONFIG.fullmatch(entry):
        return None
    if is_directory:
        return Violation(package, entry, "top-level-entry")
    suffix = posixpath.splitext(entry)[1].lower()
    if suffix == ".md" or suffix in MEDIA_SUFFIXES or entry in BIOME_CONFIGS:
        return None
    return Violation(package, entry, "top-level-entry")


def script_violations(package: str, manifest: Path, publish: bool) -> Iterable[Violation]:
    """Yield `package.json` violations: script names, and `pi.image` / `pi.video` for published packages.

    Parameters:
        package (str): Package directory relative to the repository root.
        manifest (Path): The package's `package.json`.
        publish (bool): Whether the publish-only `pi` media rule applies.

    Returns:
        Iterable[Violation]: One per nonstandard script name, one for `pi` media.
    """
    try:
        data = json.loads(manifest.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        yield Violation(package, "package.json", f"unreadable {type(e).__name__}")
        return
    scripts = data.get("scripts") if isinstance(data, dict) else None
    for name in sorted(scripts if isinstance(scripts, dict) else ()):
        if name not in SCRIPT_NAMES and not name.startswith("test:"):
            yield Violation(package, "package.json", f"script-name {name}")
    pi = data.get("pi") if isinstance(data, dict) else None
    if publish and isinstance(pi, dict) and ("image" in pi or "video" in pi):
        yield Violation(package, "package.json", "pi-media")


def check_package(package: str, paths: list[str], root: Path, publish: bool) -> list[Violation]:
    """Check one package's tracked files.

    Parameters:
        package (str): Package directory relative to the repository root.
        paths (list[str]): Tracked package-relative POSIX paths.
        root (Path): Repository root.
        publish (bool): Whether the publish rules apply (`packages/*`) or only the script and config rules.

    Returns:
        list[Violation]: Violations, unordered.
    """
    found: list[Violation] = []
    tracked = set(paths)
    if "package.json" in tracked:
        found.extend(script_violations(package, root / package / "package.json", publish))
    if not publish:
        found.extend(
            Violation(package, path, "biome-config")
            for path in paths
            if posixpath.basename(path) in BIOME_CONFIGS
        )
        return found
    found.extend(Violation(package, path, "missing-file") for path in REQUIRED_FILES if path not in tracked)
    banned_tops: set[str] = set()
    tops: dict[str, bool] = {}
    for path in paths:
        top = path.split("/")[0]
        tops[top] = tops.get(top, False) or "/" in path
    for top, is_directory in sorted(tops.items()):
        violation = top_level_violation(package, top, is_directory)
        if violation is not None:
            banned_tops.add(top)
            found.append(violation)
    for path in paths:
        top = path.split("/")[0]
        if top in banned_tops:
            continue
        found.extend(file_violations(package, path, root))
        # A dot directory nested below an allowed entry (e.g. `src/.cache`); fixtures are exempt.
        nested = dot_entry(path)
        if nested is not None:
            found.append(Violation(package, nested, "dotfile"))
    return found


def group_packages(tracked: Iterable[str]) -> tuple[dict[str, list[str]], list[Violation]]:
    """Split tracked paths into packages.

    Parameters:
        tracked (Iterable[str]): Repository-relative tracked paths.

    Returns:
        tuple[dict[str, list[str]], list[Violation]]: Package directory -> package-relative paths, and a
            `not-a-package` violation for each file sitting directly under `packages/`.
    """
    packages: dict[str, list[str]] = {}
    stray: list[Violation] = []
    shared = tuple(f"{name}/" for name in SHARED_PACKAGES)
    for path in sorted(tracked):
        if path.startswith(f"{PUBLISH_ROOT}/"):
            parts = path.split("/", 2)
            if len(parts) < 3:
                stray.append(Violation(PUBLISH_ROOT, parts[1], "not-a-package"))
                continue
            packages.setdefault(f"{parts[0]}/{parts[1]}", []).append(parts[2])
            continue
        for prefix in shared:
            if path.startswith(prefix):
                packages.setdefault(prefix.rstrip("/"), []).append(path.removeprefix(prefix))
    return packages, stray


def tracked_paths(root: Path) -> list[str]:
    """List the tracked paths the gate reads.

    Parameters:
        root (Path): Repository root.

    Returns:
        list[str]: Repository-relative POSIX paths under `packages/` and the shared packages.

    Raises:
        ClassificationError: Git fails.
    """
    out = run_git(root, "ls-files", "-z", "--", PUBLISH_ROOT, *SHARED_PACKAGES)
    return [path for path in out.split("\0") if path]


def find_violations(root: Path, tracked: Iterable[str] | None = None) -> list[Violation]:
    """Return every current violation, sorted.

    Parameters:
        root (Path): Repository root.
        tracked (Iterable[str] | None): Tracked paths to check; defaults to `git ls-files`.

    Returns:
        list[Violation]: Violations of every package.

    Raises:
        ClassificationError: Git fails.
    """
    packages, found = group_packages(tracked_paths(root) if tracked is None else tracked)
    for package, paths in packages.items():
        found.extend(check_package(package, paths, root, package.startswith(f"{PUBLISH_ROOT}/")))
    return sorted(set(found), key=Violation.line)


def render_allowlist(entries: Iterable[str]) -> str:
    """Render entries in the canonical allowlist form.

    Parameters:
        entries (Iterable[str]): Violation lines.

    Returns:
        str: Sorted, unique, one-per-line JSON array ending in a newline.
    """
    return json.dumps(sorted(set(entries)), indent=2, ensure_ascii=False) + "\n"


def parse_allowlist(text: str, source: str) -> list[str]:
    """Parse allowlist text.

    Parameters:
        text (str): File contents.
        source (str): Name for error messages.

    Returns:
        list[str]: Entries in file order.

    Raises:
        ValueError: The text is not a JSON array of strings.
    """
    try:
        data = json.loads(text)
    except ValueError as e:
        raise ValueError(f"'{source}' is not valid JSON: {e}") from e
    if not isinstance(data, list) or not all(isinstance(item, str) for item in data):
        raise ValueError(f"'{source}' must be a JSON array of violation lines")
    return data


def load_allowlist(root: Path) -> tuple[str, list[str]]:
    """Read the allowlist.

    Parameters:
        root (Path): Repository root.

    Returns:
        tuple[str, list[str]]: Raw text and parsed entries.

    Raises:
        ValueError: The file is missing or malformed.
    """
    path = root / ALLOWLIST
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as e:
        raise ValueError(f"Cannot read '{path}': {e}") from e
    return text, parse_allowlist(text, ALLOWLIST)


def base_entries(root: Path, reference: str) -> tuple[str, set[str]] | None:
    """Return the allowlist at the merge base of `HEAD` and a ref.

    Parameters:
        root (Path): Repository root.
        reference (str): Ref to compare against, e.g. `origin/main`.

    Returns:
        tuple[str, set[str]] | None: The merge base SHA and its entries, or None when the base has no
            allowlist yet (the commit that introduces it).

    Raises:
        ClassificationError: The ref or merge base cannot be resolved.
        ValueError: The base allowlist is malformed.
    """
    base = run_git(root, "merge-base", "--end-of-options", "HEAD", reference).strip()
    try:
        text = run_git(root, "show", f"{base}:{ALLOWLIST}")
    except ClassificationError:
        LOGGER.info(f"No '{ALLOWLIST}' at merge base {base[:12]}: nothing to compare entries against")
        return None
    return base, set(parse_allowlist(text, f"{base[:12]}:{ALLOWLIST}"))


def allowlist_problems(
    violations: Iterable[Violation], text: str, entries: list[str], base: tuple[str, set[str]] | None
) -> list[str]:
    """Compare violations with the allowlist.

    Parameters:
        violations (Iterable[Violation]): Current violations.
        text (str): Raw allowlist text.
        entries (list[str]): Parsed allowlist.
        base (tuple[str, set[str]] | None): Merge base SHA and entries, when comparing.

    Returns:
        list[str]: One report line per problem; empty when the gate passes.
    """
    current = {violation.line() for violation in violations}
    allowed = set(entries)
    problems = sorted(f"{line}: not allowlisted" for line in current - allowed)
    problems += sorted(f"{ALLOWLIST}: {entry}: stale allowlist entry" for entry in allowed - current)
    if text != render_allowlist(entries):
        problems.append(f"{ALLOWLIST}: allowlist is not sorted, unique and one entry per line")
    if base is not None:
        sha, known = base
        problems += sorted(
            f"{ALLOWLIST}: {entry}: allowlist entry not present at merge base {sha[:12]}"
            for entry in allowed - known
        )
    return problems


def run(root: Path, compare_ref: str | None, emit: Callable[[str], object]) -> int:
    """Run the gate and report through `emit`.

    Parameters:
        root (Path): Repository root.
        compare_ref (str | None): Ref whose merge base with `HEAD` bounds the allowlist, or None.
        emit (Callable[[str], object]): Receives one line per problem.

    Returns:
        int: 0 when clean, 1 on violations or allowlist problems, 2 when the gate cannot run.
    """
    try:
        violations = find_violations(root)
        text, entries = load_allowlist(root)
        base = base_entries(root, compare_ref) if compare_ref else None
    except (ClassificationError, ValueError) as e:
        LOGGER.error(f"Cannot check the package layout: {e}")
        return 2
    problems = allowlist_problems(violations, text, entries, base)
    for problem in problems:
        emit(problem)
    if problems:
        LOGGER.error(f"{len(problems)} package layout problem(s); the standard is nredd/pi-harness#860")
        return 1
    LOGGER.info(f"Package layout OK: {len(violations)} allowlisted deviation(s) remain")
    return 0


def main(argv: list[str] | None = None) -> int:
    """Check the package layout.

    Parameters:
        argv (list[str] | None): Arguments, or `sys.argv` when omitted.

    Returns:
        int: Process exit status.
    """
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    parser = argparse.ArgumentParser(description="Gate the package layout with a shrinking allowlist")
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument(
        "--compare-ref",
        help="Fail on allowlist entries the merge base of HEAD and this ref does not have",
    )
    args = parser.parse_args(argv)
    try:
        root = repo_root(args.repo)
    except ClassificationError as e:
        LOGGER.error(f"Cannot check the package layout: {e}")
        return 2
    return run(root, args.compare_ref, lambda line: sys.stdout.write(f"{line}\n"))


if __name__ == "__main__":
    raise SystemExit(main())
