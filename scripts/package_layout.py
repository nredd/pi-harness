"""Gate the layout of every tracked package against the standard in nredd/pi-harness#860.

Walks `git ls-files` for `packages/` (publish rules) plus the shared packages in `SHARED_PACKAGES`
(script and config rules only) and prints one line per violation: `<package>: <path>: <rule>`. A shared
package with no tracked files is a hard error (exit 2), so moving one without updating the gate cannot
leave its tree silently unchecked.

The test layout is plural `tests/` everywhere: per package `tests/*.test.ts` (and `tests/*.bench.ts`) plus
`tests/fixtures/` for every non-test file, and no `support/`, `helpers/` or `lib/` below `tests/`. Root-level
shared code is `tests/lib/` with data in `tests/fixtures/`; add `tests/lib` to `SHARED_PACKAGES` in the PR
that creates it. Today's `test/` directories are migration debt, one `top-level-entry` line per package.

Today's deviations live in `scripts/package_layout.json`, a sorted array with one violation line per entry.
The list can only shrink:

- an entry that is no longer violated is stale and fails
- with `--compare-ref`, an entry the merge base of `HEAD` and the ref does not carry fails, so a new
  violation cannot be waived by adding its line
- with `--compare-ref`, a tracked path that is new since the merge base and sits under an allowlisted
  banned top-level entry (e.g. `test/`, `lib/`) fails, so the waiver does not cover new files; a pure
  rename inside the same entry is exempt
- the file must be in canonical form (sorted, unique, one entry per line) so merges stay mechanical

A package issue deletes its own entries in the same PR that fixes the layout.

A structure violation (markdown, media, test location) under a top-level entry that is itself a violation (a
banned directory, or a file outside the closed list) is reported once, for that entry, and until the entry
moves into place the growth check above keeps new files out of it. The content rules (`import-escape`,
`test-extension`, `test-name`, `shell-script`, `tracked-binary`) still run below a banned entry, so editing
a file there cannot add a new one; their lines stay in the allowlist as debt.

No committed binaries: anything tracked under `prebuilt/` and any tracked file with an ELF, Mach-O or PE
magic number is `tracked-binary`. No standalone `.sh`, `.ps1`, `.bash` or `.cmd` outside `tests/fixtures/`
(`shell-script`), nor an extensionless file whose `#!` line names sh, bash, zsh, fish, dash, ksh, pwsh or
powershell (directly or via `env`); use a Makefile target.
A PE is found by seeking to `e_lfanew` (at most 64 KiB).
`test:upstream-sync` and `test:sync-reverts` are denied names.
Import scanning is textual (`from`, `import`, `require`), so `new URL("../x", import.meta.url)` and
`vi.mock("../x")` are not seen.

Not mechanically checkable here, so not gated: runtime data loaded away from its loader, tests that write
inside the package tree, `tests/` mirroring `src/`, and the `package.json` field values (`name`, `files`,
`pi.extensions`, the `check` composition) and `tsconfig.json` / `CHANGELOG.md` contents. `test:<signal>`
script names are matched by prefix, not against `coverage/policy.json`.

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
SHARED_PACKAGES = ("integration/inprocess",)

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
        "tests",
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
SHELL_SUFFIXES = frozenset({".sh", ".ps1", ".psm1", ".bash", ".zsh", ".fish", ".bat", ".cmd"})
BINARY_MAGICS = (
    b"\x7fELF",
    b"\xfe\xed\xfa\xce",
    b"\xfe\xed\xfa\xcf",
    b"\xce\xfa\xed\xfe",
    b"\xcf\xfa\xed\xfe",
    b"\xca\xfe\xba\xbe",
)
SHELL_INTERPRETERS = frozenset({"sh", "bash", "zsh", "fish", "dash", "ksh", "pwsh", "powershell"})
ENV_OPTIONS_WITH_ARGUMENT = frozenset({"-u", "--unset", "-C", "--chdir"})
PE_MAX_OFFSET = 64 * 1024
BIOME_CONFIGS = frozenset({"biome.json", "biome.jsonc"})
# `test:<signal>` is one name per extra `coverage/policy.json` signal, so any `test:` suffix is accepted.
DENIED_SCRIPT_NAMES = frozenset({"test:upstream-sync", "test:sync-reverts"})
# `pretest` builds the gitignored `dist/` a test loads (#890), so it is a standard name.
SCRIPT_NAMES = frozenset(
    {"lint", "format", "typecheck", "test", "test:bun", "check", "build", "prepack", "pretest", "bench"}
)
# Root home of the shared toolchain (`runtime-builder.mjs`, `run-vitest.ts`): importing it is no escape.
SHARED_TOOLCHAIN = "scripts"
CODE_SUFFIXES = frozenset({".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"})
STRAY_TEST_SUFFIXES = (".test.mjs", ".test.js", ".test.mts", ".test.cts", ".test.tsx", ".test.jsx")
# A test is named for the behavior it pins: not a ticket (`issue-302-repro`) and not a coverage campaign
# (`index-coverage-agents`). `rust-` and `swift-` name the coverage producers `computer-use` tests.
TICKET_TEST_NAME = re.compile(r"(?:^|[-_.])(?:issue|pr|gh)[-_]?\d+")
CAMPAIGN_TEST_NAME = re.compile(r"(?:^|[-_.])coverage(?:[-_.]|$)")
COVERAGE_TOOL_PREFIXES = ("rust-", "swift-")
RELATIVE_SPECIFIER = re.compile(r"""\b(?:from|import|require)\s*\(?\s*["'](\.\.?(?:/[^"'\n]*)?)["']""")
# Below `tests/` only `fixtures/` holds non-test files; these are the superseded homes for them.
TEST_SUPPORT_DIRS = frozenset({"support", "helpers", "lib"})
ADDED_RULE = "added-under-banned-entry (add it under `tests/` instead)"
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
    """Return whether a package-relative path sits under `tests/fixtures/`.

    Parameters:
        path (str): Package-relative POSIX path.

    Returns:
        bool: Whether the path is fixture data, which may model any on-disk layout.
    """
    return path.startswith("tests/fixtures/")


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


def tree_rule(path: str) -> str | None:
    """Name the rule a file under `tests/` breaks, if any.

    Parameters:
        path (str): Package-relative POSIX path starting with `tests/`, outside `tests/fixtures/`.

    Returns:
        str | None: A rule name, or None when the file belongs in `tests/`.
    """
    parts = path.split("/")[1:]
    if SNAPSHOT_DIR in parts[:-1]:
        return None
    if len(parts) > 1 and parts[0] in TEST_SUPPORT_DIRS:
        return "test-support-dir"
    name = parts[-1]
    if name.endswith(".bench.ts"):
        return None if len(parts) == 1 else "test-content"
    return None if name.endswith(".test.ts") else "test-content"


def misnamed_test(name: str) -> bool:
    """Return whether a test file is named after a ticket or a coverage campaign.

    Parameters:
        name (str): Test file name, e.g. `issue-302-repro.test.ts`.

    Returns:
        bool: Whether the name carries an issue or PR number, or a `coverage` token that is not a producer's.
    """
    stem = name.split(".test.", maxsplit=1)[0]
    if TICKET_TEST_NAME.search(stem):
        return True
    return not stem.startswith(COVERAGE_TOOL_PREFIXES) and CAMPAIGN_TEST_NAME.search(stem) is not None


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
            if posixpath.normpath(posixpath.join(package, target)).startswith(f"{SHARED_TOOLCHAIN}/"):
                continue
            yield Violation(package, path, f"import-escape {specifier}")


def file_violations(package: str, path: str) -> Iterable[Violation]:
    """Yield the per-file rule violations of one tracked file inside an allowed top-level entry.

    Parameters:
        package (str): Package directory relative to the repository root.
        path (str): Package-relative POSIX path.

    Returns:
        Iterable[Violation]: Violations of the structure rules (markdown, media, dist, test location,
            biome); the content rules come from `content_violations`.
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
        return
    if path.endswith(".test.ts") and top != "tests":
        yield Violation(package, path, "test-location")
    elif top == "tests":
        problem = tree_rule(path)
        if problem is not None:
            yield Violation(package, path, problem)
    if posixpath.basename(path) in BIOME_CONFIGS:
        yield Violation(package, path, "biome-config")


def read_magic(package: str, path: str, root: Path) -> bytes:
    """Read the leading bytes of a tracked file.

    Parameters:
        package (str): Package directory relative to the repository root.
        path (str): Package-relative POSIX path.
        root (Path): Repository root.

    Returns:
        bytes: Up to 256 bytes; empty when the file is absent or unreadable.
    """
    try:
        with (root / package / path).open("rb") as handle:
            return handle.read(256)
    except OSError as e:
        LOGGER.debug(f"Cannot read '{package}/{path}' for the binary check: {e}")
        return b""


def has_pe_signature(head: bytes, source: Path) -> bool:
    """Return whether `PE\\0\\0` sits at the `e_lfanew` offset of an `MZ` header.

    Parameters:
        head (bytes): Leading bytes of the file.
        source (Path): The file, reopened to seek to `e_lfanew`.

    Returns:
        bool: False for a short header, an offset beyond `PE_MAX_OFFSET`, an unreadable file, or no signature.
    """
    if not head.startswith(b"MZ") or len(head) < 64:
        return False
    offset = int.from_bytes(head[60:64], "little")
    if offset > PE_MAX_OFFSET:
        return False
    try:
        with source.open("rb") as handle:
            handle.seek(offset)
            return handle.read(4) == b"PE\x00\x00"
    except OSError as e:
        LOGGER.debug(f"Cannot read '{source}' at e_lfanew for the binary check: {e}")
        return False


def is_binary(head: bytes, source: Path) -> bool:
    """Return whether a file is an ELF, Mach-O (thin or fat) or PE image.

    Parameters:
        head (bytes): Up to 256 leading bytes of the file.
        source (Path): The file, for the PE signature at `e_lfanew`.

    Returns:
        bool: Whether a native-executable magic number matches; a PE needs `PE\\0\\0` at `e_lfanew`, so a text
            file that merely starts with `MZ` does not count. Java `.class` files share the fat Mach-O magic.
    """
    return head.startswith(BINARY_MAGICS) or has_pe_signature(head, source)


def env_command(words: list[str]) -> list[str]:
    """Drop the options and `NAME=value` assignments that precede the command of an `env` shebang.

    Parameters:
        words (list[str]): Shebang words after `env`.

    Returns:
        list[str]: The command and its arguments; empty when none follows.
    """
    rest = iter(words)
    for word in rest:
        if word in ENV_OPTIONS_WITH_ARGUMENT:
            next(rest, None)
        elif not word.startswith("-") and "=" not in word:
            return [word, *rest]
    return []


def is_shell_shebang(head: bytes) -> bool:
    """Return whether a file starts with a shebang naming a shell, directly or via `env`.

    Parameters:
        head (bytes): Up to 256 leading bytes of the file.

    Returns:
        bool: Whether the first line is `#!` followed by an `sh`, `bash`, `zsh`, `fish`, `dash`, `ksh`,
            `pwsh` or `powershell` interpreter, optionally after `env` and its flags.
    """
    if not head.startswith(b"#!"):
        return False
    words = head[2:].split(b"\n", maxsplit=1)[0].decode("utf-8", errors="replace").split()
    if words and posixpath.basename(words[0]) == "env":
        words = env_command(words[1:])
    return bool(words) and posixpath.basename(words[0]) in SHELL_INTERPRETERS


def content_violations(package: str, path: str, root: Path) -> Iterable[Violation]:
    """Yield the rules that apply to a file even below a banned top-level entry.

    The banned entry is reported once for its structure; these rules judge what is in the files, so they
    keep running and their lines stay in the allowlist as debt.

    Parameters:
        package (str): Package directory relative to the repository root.
        path (str): Package-relative POSIX path.
        root (Path): Repository root.

    Returns:
        Iterable[Violation]: Binary, shell script, test extension, test name and import escape violations.
    """
    top = path.split("/", maxsplit=1)[0]
    suffix = posixpath.splitext(path)[1].lower()
    head = read_magic(package, path, root)
    if top == "prebuilt" or is_binary(head, root / package / path):
        yield Violation(package, path, "tracked-binary")
    if is_fixture(path):
        return
    if suffix in SHELL_SUFFIXES or is_shell_shebang(head):
        yield Violation(package, path, "shell-script")
    if ".test." in path and misnamed_test(posixpath.basename(path)):
        yield Violation(package, path, "test-name")
    if path.endswith(STRAY_TEST_SUFFIXES):
        yield Violation(package, path, "test-extension")
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
        if name in DENIED_SCRIPT_NAMES or (name not in SCRIPT_NAMES and not name.startswith("test:")):
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
        found.extend(content_violations(package, path, root))
        if top in banned_tops:
            continue
        found.extend(file_violations(package, path))
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
        ValueError: A configured shared package has no tracked files.
    """
    packages, found = group_packages(tracked_paths(root) if tracked is None else tracked)
    missing = [name for name in SHARED_PACKAGES if name not in packages]
    if missing:
        raise ValueError(
            f"Shared package(s) with no tracked files: {', '.join(missing)}; update SHARED_PACKAGES"
        )
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


def banned_entries(violations: Iterable[Violation]) -> set[tuple[str, str]]:
    """Return the top-level entries of packages that are themselves violations.

    Parameters:
        violations (Iterable[Violation]): Current violations.

    Returns:
        set[tuple[str, str]]: `(package, entry)` for each `top-level-entry` and `dotfile` violation of an
            entry directly under the package, i.e. the tops whose files skip the per-file rules.
    """
    return {
        (violation.package, violation.path)
        for violation in violations
        if violation.rule in {"top-level-entry", "dotfile"} and "/" not in violation.path
    }


def base_tracked(root: Path, reference: str) -> set[str]:
    """List the tracked paths the gate reads at the merge base of `HEAD` and a ref.

    Parameters:
        root (Path): Repository root.
        reference (str): Ref to compare against, e.g. `origin/main`.

    Returns:
        set[str]: Repository-relative POSIX paths under `packages/` and the shared packages.

    Raises:
        ClassificationError: The ref or merge base cannot be resolved, or Git fails.
    """
    base = run_git(root, "merge-base", "--end-of-options", "HEAD", reference).strip()
    out = run_git(root, "ls-tree", "-r", "--name-only", "-z", base, "--", PUBLISH_ROOT, *SHARED_PACKAGES)
    return {path for path in out.split("\0") if path}


def base_renames(root: Path, reference: str) -> dict[str, str]:
    """Map paths renamed since the merge base of `HEAD` and a ref to their old paths.

    Parameters:
        root (Path): Repository root.
        reference (str): Ref to compare against, e.g. `origin/main`.

    Returns:
        dict[str, str]: Repository-relative new path -> old path, for renames Git detects.

    Raises:
        ClassificationError: The ref or merge base cannot be resolved, or Git fails.
    """
    base = run_git(root, "merge-base", "--end-of-options", "HEAD", reference).strip()
    out = run_git(
        root,
        "diff",
        "--name-status",
        "-z",
        "--find-renames=90%",
        "--diff-filter=R",
        base,
        "HEAD",
        "--",
        PUBLISH_ROOT,
        *SHARED_PACKAGES,
    )
    fields = [field for field in out.split("\0") if field]
    return {new: old for _status, old, new in zip(fields[::3], fields[1::3], fields[2::3], strict=False)}


def growth_problems(
    violations: Iterable[Violation],
    tracked: Iterable[str],
    known: set[str],
    renames: dict[str, str] | None = None,
) -> list[str]:
    """Report tracked paths new since the base under a banned top-level entry.

    The allowlist waives the entry, not what is added to it, and the per-file rules skip it.

    Parameters:
        violations (Iterable[Violation]): Current violations.
        tracked (Iterable[str]): Tracked paths at `HEAD`.
        known (set[str]): Tracked paths at the merge base.
        renames (dict[str, str] | None): New path -> old path for renames since the merge base; one inside
            the same banned entry is a move within the debt, not growth.

    Returns:
        list[str]: One `<package>: <path>: added-under-banned-entry (...)` line per new path, sorted.
    """
    renames = renames or {}
    prefixes = {f"{package}/{entry}/": package for package, entry in banned_entries(violations)}
    problems: set[str] = set()
    for path in tracked:
        if path in known:
            continue
        for prefix, package in prefixes.items():
            if path.startswith(prefix) and not renames.get(path, "").startswith(prefix):
                problems.add(Violation(package, path.removeprefix(f"{package}/"), ADDED_RULE).line())
    return sorted(problems)


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
        compare_ref (str | None): Ref whose merge base with `HEAD` bounds the gate, or None.
        emit (Callable[[str], object]): Receives one line per problem.

    Returns:
        int: 0 when clean, 1 on violations or allowlist problems, 2 when the gate cannot run.
    """
    try:
        tracked = tracked_paths(root)
        violations = find_violations(root, tracked)
        text, entries = load_allowlist(root)
        base = base_entries(root, compare_ref) if compare_ref else None
        known = base_tracked(root, compare_ref) if compare_ref else None
        renames = base_renames(root, compare_ref) if compare_ref else None
    except (ClassificationError, ValueError) as e:
        LOGGER.error(f"Cannot check the package layout: {e}")
        return 2
    problems = allowlist_problems(violations, text, entries, base)
    if known is not None:
        problems += growth_problems(violations, tracked, known, renames)
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
