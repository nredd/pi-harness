"""Test the package layout gate against disposable trees and the real repository.

References:
    https://github.com/nredd/pi-harness/issues/860
    https://github.com/nredd/pi-harness/issues/861
"""

from __future__ import annotations

import json
import os
import runpy
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import ci_paths
import package_layout

GIT = ci_paths.GIT
REPO_ROOT = ci_paths.REPO_ROOT
PACKAGE = "packages/x"
CLEAN = {
    "package.json": json.dumps({"scripts": {"lint": "x", "test": "x", "test:bun": "x", "check": "x"}}),
    "README.md": "# x\n",
    "CHANGELOG.md": "## [Unreleased]\n",
    "LICENSE": "MIT\n",
    "tsconfig.json": "{}\n",
    "vitest.config.ts": "export default {};\n",
    "src/index.ts": 'import { a } from "./area/a.ts";\nexport { a };\n',
    "src/area/a.ts": 'import { up } from "../index.ts";\nexport const a = up;\n',
    "tests/a.test.ts": "export {};\n",
    "tests/fixtures/helper.ts": "export {};\n",
    "tests/fixtures/data.json": "{}\n",
}
SHARED = "integration/inprocess"


def git(repo: Path, *args: str) -> str:
    """Run Git in a disposable repository.

    Parameters:
        repo (Path): Repository to operate in.
        *args (str): Git arguments after `-C <repo>`.

    Returns:
        str: Stripped standard output.
    """
    completed = subprocess.run([GIT, "-C", str(repo), *args], check=True, capture_output=True, text=True)
    return completed.stdout.strip()


def write_tree(repo: Path, files: dict[str, str]) -> None:
    """Write files under a repository and stage them.

    Parameters:
        repo (Path): Disposable repository.
        files (dict[str, str]): Repository-relative paths and contents.

    Returns:
        None: Files are written and `git add`ed.
    """
    for relative, content in files.items():
        target = repo / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
    git(repo, "add", "--all")


def commit(repo: Path, message: str) -> str:
    """Commit the staged tree.

    Parameters:
        repo (Path): Disposable repository.
        message (str): Commit subject.

    Returns:
        str: Full commit revision.
    """
    git(repo, "commit", "-q", "-m", message)
    return git(repo, "rev-parse", "HEAD")


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    """Create a real repository holding one clean package and an empty allowlist.

    Parameters:
        tmp_path (Path): Pytest temporary directory.

    Returns:
        Path: Repository with nothing committed yet.
    """
    git(tmp_path, "init", "-q", "-b", "main")
    git(tmp_path, "config", "user.email", "t@example.invalid")
    git(tmp_path, "config", "user.name", "t")
    git(tmp_path, "config", "commit.gpgsign", "false")
    write_tree(tmp_path, {f"{PACKAGE}/{path}": text for path, text in CLEAN.items()})
    write_tree(tmp_path, {package_layout.ALLOWLIST: "[]\n", f"{SHARED}/index.ts": "export {};\n"})
    return tmp_path


def lines(repo: Path) -> list[str]:
    """Return the current violation lines of a repository.

    Parameters:
        repo (Path): Disposable repository.

    Returns:
        list[str]: `<package>: <path>: <rule>` lines.
    """
    return [violation.line() for violation in package_layout.find_violations(repo)]


def test_clean_package_passes_with_no_allowlist_entry(repo: Path) -> None:
    """Pass a package that follows the standard.

    Parameters:
        repo (Path): Disposable repository.

    Returns:
        None: Assertions verify the report.
    """
    assert lines(repo) == []
    out: list[str] = []
    assert package_layout.run(repo, None, out.append) == 0
    assert out == []


@pytest.mark.parametrize(
    ("path", "text", "expected"),
    [
        ("AGENTS.md", "x\n", "packages/x: AGENTS.md: markdown"),
        ("SECURITY.md", "x\n", "packages/x: SECURITY.md: markdown"),
        ("src/NOTES.md", "x\n", "packages/x: src/NOTES.md: markdown"),
        ("docs/a.md", "x\n", "packages/x: docs: top-level-entry"),
        ("extensions/a.ts", "x\n", "packages/x: extensions: top-level-entry"),
        ("extra.json", "{}\n", "packages/x: extra.json: top-level-entry"),
        (".github/ci.yml", "x\n", "packages/x: .github: dotfile"),
        (".vitest.config.ts", "x\n", "packages/x: .vitest.config.ts: dotfile"),
        ("src/.cache/a.ts", "x\n", "packages/x: src/.cache: dotfile"),
        ("src/shot.PNG", "x\n", "packages/x: src/shot.PNG: media"),
        ("tests/fixtures/demo.mp4", "x\n", "packages/x: tests/fixtures/demo.mp4: media"),
        ("cover.png", "x\n", "packages/x: cover.png: media"),
        ("dist/index.js", "x\n", "packages/x: dist/index.js: tracked-dist"),
        ("src/a.test.ts", "x\n", "packages/x: src/a.test.ts: test-location"),
        ("a.test.ts", "x\n", "packages/x: a.test.ts: top-level-entry"),
        ("tests/a.test.mjs", "x\n", "packages/x: tests/a.test.mjs: test-extension"),
        ("src/a.test.js", "x\n", "packages/x: src/a.test.js: test-extension"),
        ("tests/helper.ts", "x\n", "packages/x: tests/helper.ts: test-content"),
        ("tests/area/helper.ts", "x\n", "packages/x: tests/area/helper.ts: test-content"),
        ("tests/support/h.test.ts", "x\n", "packages/x: tests/support/h.test.ts: test-support-dir"),
        ("test/a.test.ts", "x\n", "packages/x: test: top-level-entry"),
        ("tests/helpers/h.ts", "x\n", "packages/x: tests/helpers/h.ts: test-support-dir"),
        ("tests/lib/h.ts", "x\n", "packages/x: tests/lib/h.ts: test-support-dir"),
        ("tests/support/deep/h.ts", "x\n", "packages/x: tests/support/deep/h.ts: test-support-dir"),
        ("tests/bench/a.bench.ts", "x\n", "packages/x: tests/bench/a.bench.ts: test-content"),
        ("lib/a.ts", "x\n", "packages/x: lib: top-level-entry"),
        ("tests/bench/helper.ts", "x\n", "packages/x: tests/bench/helper.ts: test-content"),
        ("tests/bench/deep/a.bench.ts", "x\n", "packages/x: tests/bench/deep/a.bench.ts: test-content"),
        ("tests/issue-302-repro.test.ts", "x\n", "packages/x: tests/issue-302-repro.test.ts: test-name"),
        (
            "tests/area/index-coverage-a.test.ts",
            "x\n",
            "packages/x: tests/area/index-coverage-a.test.ts: test-name",
        ),
        ("tests/area/coverage.test.ts", "x\n", "packages/x: tests/area/coverage.test.ts: test-name"),
        ("tests/area/a.gh_12.test.ts", "x\n", "packages/x: tests/area/a.gh_12.test.ts: test-name"),
        ("tests/area/pr7.test.ts", "x\n", "packages/x: tests/area/pr7.test.ts: test-name"),
        ("biome.json", "{}\n", "packages/x: biome.json: biome-config"),
        ("src/biome.jsonc", "{}\n", "packages/x: src/biome.jsonc: biome-config"),
    ],
)
def test_violations_name_the_rule(repo: Path, path: str, text: str, expected: str) -> None:
    """Fail each banned path with `<package>: <path>: <rule>`.

    Parameters:
        repo (Path): Disposable repository.
        path (str): Package-relative path to add.
        text (str): File contents.
        expected (str): The one violation line the addition produces.

    Returns:
        None: Assertions verify the report.
    """
    write_tree(repo, {f"{PACKAGE}/{path}": text})
    assert lines(repo) == [expected]


@pytest.mark.parametrize(
    "path",
    [
        "tests/fixtures/.pi/agents/minimal.md",
        "tests/fixtures/README.md",
        "tests/fixtures/a.test.mjs",
        "tests/fixtures/helper.ts",
        "tests/__snapshots__/a.snap",
        "tests/area/__snapshots__/a.test.ts.snap",
        "tests/a.bench.ts",
        "tests/scenarios/a.test.ts",
        "tests/area/rust-coverage.test.ts",
        "tests/area/swift-coverage-errors.test.ts",
        "tests/area/pr-review.test.ts",
        "tests/area/coverages.test.ts",
        "skills/ship-issue/SKILL.md",
        "agents/reviewer.md",
        "themes/dark.json",
        "prompts/a.md",
        "settings/a.json",
        "NOTICE.md",
        "licenses/a.txt",
        "vitest.runtime-build.config.ts",
        "tsconfig.build.json",
        "native/macos/src/a.swift",
        "scripts/build.mjs",
        "examples/a.json",
        "schemas/a.json",
    ],
)
def test_allowed_paths_pass(repo: Path, path: str) -> None:
    """Accept the standard's exceptions: fixtures, Pi resources and the optional closed list.

    Parameters:
        repo (Path): Disposable repository.
        path (str): Package-relative path to add.

    Returns:
        None: Assertions verify the report.
    """
    write_tree(repo, {f"{PACKAGE}/{path}": "x\n"})
    assert lines(repo) == []


@pytest.mark.parametrize("path", ["README.md", "CHANGELOG.md", "LICENSE", "tsconfig.json", "src/index.ts"])
def test_missing_required_file_fails(repo: Path, path: str) -> None:
    """Fail a package that lacks a required file.

    Parameters:
        repo (Path): Disposable repository.
        path (str): Required package-relative path to delete.

    Returns:
        None: Assertions verify the report.
    """
    git(repo, "rm", "-q", "-f", f"{PACKAGE}/{path}")
    assert f"{PACKAGE}: {path}: missing-file" in lines(repo)


@pytest.mark.parametrize(
    ("specifier", "leaves"),
    [
        ("../../plan-mode/scripts/runtime-builder.mjs", True),
        ("../../../node_modules/a/b.js", True),
        ("../..", True),
        ("../index.ts", False),
        ("..", False),
        (".", False),
        ("./a.ts", False),
        ("@scope/pkg", False),
    ],
)
@pytest.mark.parametrize(
    "form",
    ["import a from '{}';", "const a = import('{}');", 'const a = require("{}");', "import '{}';"],
)
def test_relative_imports_leaving_the_package_fail(
    repo: Path, specifier: str, leaves: bool, form: str
) -> None:
    """Flag a relative import that resolves outside the package, however it is spelled.

    Parameters:
        repo (Path): Disposable repository.
        specifier (str): Import specifier, resolved from `scripts/`, one level below the package root.
        leaves (bool): Whether it must be reported.
        form (str): Import syntax template.

    Returns:
        None: Assertions verify the report.
    """
    write_tree(repo, {f"{PACKAGE}/scripts/build-runtime.mjs": form.format(specifier) + "\n"})
    expected = [f"{PACKAGE}: scripts/build-runtime.mjs: import-escape {specifier}"] if leaves else []
    assert lines(repo) == expected


def test_import_escape_reports_each_specifier_once(repo: Path) -> None:
    """Report each distinct leaving specifier once per file, in a stable order.

    Parameters:
        repo (Path): Disposable repository.

    Returns:
        None: Assertions verify the report.
    """
    text = 'import "../../../b/x.ts";\nimport "../../../a/y.ts";\nimport "../../../b/x.ts";\n'
    write_tree(repo, {f"{PACKAGE}/src/area/leak.ts": text})
    assert lines(repo) == [
        f"{PACKAGE}: src/area/leak.ts: import-escape ../../../a/y.ts",
        f"{PACKAGE}: src/area/leak.ts: import-escape ../../../b/x.ts",
    ]


def test_structure_rules_beneath_a_banned_directory_wait_for_the_move(repo: Path) -> None:
    """Report a banned directory once for structure rules, not every file inside it.

    Parameters:
        repo (Path): Disposable repository.

    Returns:
        None: Assertions verify the report.
    """
    write_tree(
        repo,
        {
            f"{PACKAGE}/lib/a.ts": "export {};\n",
            f"{PACKAGE}/lib/b.png": "x\n",
            f"{PACKAGE}/lib/c.md": "x\n",
            f"{PACKAGE}/test/d.test.ts": "export {};\n",
        },
    )
    assert lines(repo) == ["packages/x: lib: top-level-entry", "packages/x: test: top-level-entry"]


@pytest.mark.parametrize(
    ("path", "text", "expected"),
    [
        ("lib/a.ts", 'import "../../../y.ts";\n', "packages/x: lib/a.ts: import-escape ../../../y.ts"),
        ("test/a.test.mjs", "x\n", "packages/x: test/a.test.mjs: test-extension"),
        ("test/issue-9-b.test.ts", "x\n", "packages/x: test/issue-9-b.test.ts: test-name"),
        (
            "test/area/index-coverage.test.ts",
            "x\n",
            "packages/x: test/area/index-coverage.test.ts: test-name",
        ),
    ],
)
def test_content_rules_still_run_beneath_a_banned_directory(
    repo: Path, path: str, text: str, expected: str
) -> None:
    """Keep import, extension and name rules on files under a banned entry; they are debt, not waived.

    Parameters:
        repo (Path): Disposable repository.
        path (str): Package-relative path under a banned entry.
        text (str): File contents.
        expected (str): The file-level violation alongside the entry's own.

    Returns:
        None: Assertions verify the report.
    """
    write_tree(repo, {f"{PACKAGE}/{path}": text})
    top = path.split("/", maxsplit=1)[0]
    assert lines(repo) == sorted([f"packages/x: {top}: top-level-entry", expected])


def test_editing_a_file_under_a_banned_directory_cannot_add_an_escape_import(repo: Path) -> None:
    """Fail an escape import added to an existing file below a waived banned entry.

    Parameters:
        repo (Path): Disposable repository.

    Returns:
        None: Assertions verify the report and exit status.
    """
    waived = f"{PACKAGE}: test: top-level-entry"
    write_tree(
        repo,
        {f"{PACKAGE}/test/a.test.ts": "export {};\n", package_layout.ALLOWLIST: entries_for(waived)},
    )
    commit(repo, "base")
    git(repo, "checkout", "-q", "-b", "feature")
    write_tree(repo, {f"{PACKAGE}/test/a.test.ts": 'import "../../todo/state.ts";\n'})
    out: list[str] = []
    assert package_layout.run(repo, "main", out.append) == 1
    assert out == [f"{PACKAGE}: test/a.test.ts: import-escape ../../todo/state.ts: not allowlisted"]


def write_bytes(repo: Path, path: str, content: bytes) -> None:
    """Write and stage a binary file.

    Parameters:
        repo (Path): Disposable repository.
        path (str): Repository-relative path.
        content (bytes): File contents.

    Returns:
        None: The file is written and `git add`ed.
    """
    target = repo / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(content)
    git(repo, "add", "--all")


@pytest.mark.parametrize(
    "magic",
    [
        b"\x7fELF",
        b"\xcf\xfa\xed\xfe",
        b"\xca\xfe\xba\xbe",
        b"\xfe\xed\xfa\xcf",
        b"MZ" + b"\x00" * 58 + b"\x40\x00\x00\x00" + b"PE\x00\x00",
    ],
)
def test_tracked_binaries_are_found_by_content(repo: Path, magic: bytes) -> None:
    """Flag a native executable by magic number wherever it is tracked.

    Parameters:
        repo (Path): Disposable repository.
        magic (bytes): Leading bytes of an ELF, Mach-O or PE image.

    Returns:
        None: Assertions verify the report.
    """
    write_bytes(repo, f"{PACKAGE}/src/area/tool", magic + b"\x00" * 8)
    write_bytes(repo, f"{PACKAGE}/lib/tool", magic + b"\x00" * 8)
    write_bytes(repo, f"{PACKAGE}/src/area/text", b"#!/usr/bin/env node\n")
    assert lines(repo) == [
        "packages/x: lib/tool: tracked-binary",
        "packages/x: lib: top-level-entry",
        "packages/x: src/area/tool: tracked-binary",
    ]


def mz_header(e_lfanew: int) -> bytes:
    """Build a 64-byte `MZ` header whose `e_lfanew` field is set.

    Parameters:
        e_lfanew (int): Offset stored at 0x3c.

    Returns:
        bytes: The header.
    """
    head = bytearray(b"MZ" + b"\x00" * 62)
    head[60:64] = e_lfanew.to_bytes(4, "little")
    return bytes(head)


def pe_image(e_lfanew: int, signature: bytes = b"PE\x00\x00") -> bytes:
    """Build a minimal PE image with its signature at `e_lfanew`.

    Parameters:
        e_lfanew (int): Offset stored at 0x3c and used for the signature.
        signature (bytes): Four bytes written at that offset.

    Returns:
        bytes: The image bytes.
    """
    return mz_header(e_lfanew).ljust(e_lfanew, b"\x00") + signature + b"\x00" * 8


@pytest.mark.parametrize("e_lfanew", [0x40, 0x100, 0x118, 0xFFF0, 0x10000])
def test_pe_images_are_found_wherever_e_lfanew_points(repo: Path, e_lfanew: int) -> None:
    """Seek to `e_lfanew` instead of relying on the first 256 bytes.

    Parameters:
        repo (Path): Disposable repository.
        e_lfanew (int): Signature offset.

    Returns:
        None: Assertions verify the report.
    """
    write_bytes(repo, f"{PACKAGE}/src/area/tool", pe_image(e_lfanew))
    assert lines(repo) == ["packages/x: src/area/tool: tracked-binary"]


@pytest.mark.parametrize("e_lfanew", [0x10001, 0x7FFFFFFF, 0xFFFFFFFF, 0x200])
def test_out_of_bounds_e_lfanew_is_not_a_binary(repo: Path, e_lfanew: int) -> None:
    """Ignore an `e_lfanew` beyond the bound or past the end of the file without crashing.

    Parameters:
        repo (Path): Disposable repository.
        e_lfanew (int): Offset with no signature at it.

    Returns:
        None: Assertions verify the report.
    """
    write_bytes(repo, f"{PACKAGE}/src/area/notes", mz_header(e_lfanew))
    if e_lfanew == 0x10001:  # a real signature past the bound must still be ignored
        write_bytes(repo, f"{PACKAGE}/src/area/notes", pe_image(e_lfanew))
    assert lines(repo) == []


@pytest.mark.parametrize(
    ("first", "flagged"),
    [
        (b"#!/bin/sh\n", True),
        (b"#!/bin/bash -e\n", True),
        (b"#!/usr/bin/env zsh\n", True),
        (b"#!/usr/bin/env -S fish -l\n", True),
        (b"#! /bin/dash\n", True),
        (b"#!/usr/bin/ksh\n", True),
        (b"#!/bin/sh\r\n", True),
        (b"#!/usr/bin/env FOO=1 bash\n", True),
        (b"#!/usr/bin/env -u FOO sh\n", True),
        (b"#!/usr/bin/env -u sh\n", False),
        (b"#!/usr/bin/env -u FOO node\n", False),
        (b"\xef\xbb\xbf#!/bin/sh\n", False),
        (b"#!/usr/bin/env pwsh\n", True),
        (b"#!/usr/local/bin/powershell\n", True),
        (b"#!/usr/bin/env node\n", False),
        (b"#!/usr/bin/env python3\n", False),
        (b"#!/bin/shell-like\n", False),
        (b"#!\n", False),
        (b"#!/usr/bin/env\n", False),
        (b"echo hi\n#!/bin/sh\n", False),
    ],
)
def test_extensionless_shebang_shell_scripts_fail(repo: Path, first: bytes, flagged: bool) -> None:
    """Flag a shell shebang by content, not by extension.

    Parameters:
        repo (Path): Disposable repository.
        first (bytes): File contents.
        flagged (bool): Whether `shell-script` is expected.

    Returns:
        None: Assertions verify the report.
    """
    write_bytes(repo, f"{PACKAGE}/src/area/tool", first)
    write_bytes(repo, f"{PACKAGE}/tests/fixtures/tool", first)
    expected = ["packages/x: src/area/tool: shell-script"] if flagged else []
    assert lines(repo) == expected


@pytest.mark.parametrize(
    "text", [b"MZ is a text file\n", b"MZ" + b"\x00" * 62, b"MZ" + b"\x00" * 58 + b"\xff\xff\x00\x00"]
)
def test_text_that_starts_like_a_pe_image_is_not_a_binary(repo: Path, text: bytes) -> None:
    """Require the PE signature at `e_lfanew`, not just a leading `MZ`.

    Parameters:
        repo (Path): Disposable repository.
        text (bytes): File contents that begin with `MZ` but are not a PE image.

    Returns:
        None: Assertions verify the report.
    """
    write_bytes(repo, f"{PACKAGE}/src/area/notes", text)
    assert lines(repo) == []


def test_everything_tracked_under_prebuilt_is_a_binary_violation(repo: Path) -> None:
    """Report `prebuilt/` as a banned entry and every file below it, whatever its content.

    Parameters:
        repo (Path): Disposable repository.

    Returns:
        None: Assertions verify the report.
    """
    write_tree(repo, {f"{PACKAGE}/prebuilt/macos/arm64/bridge": "not a binary\n"})
    assert lines(repo) == [
        "packages/x: prebuilt/macos/arm64/bridge: tracked-binary",
        "packages/x: prebuilt: top-level-entry",
    ]


def test_missing_binary_is_skipped(repo: Path) -> None:
    """Skip a tracked file that is gone from the work tree.

    Parameters:
        repo (Path): Disposable repository.

    Returns:
        None: Assertions verify the report.
    """
    (repo / PACKAGE / "src/area/a.ts").unlink()
    assert lines(repo) == []


@pytest.mark.parametrize(
    "name",
    ["scripts/a.sh", "scripts/a.ps1", "src/a.bash", "scripts/a.CMD", "a.sh", "a.bat", "a.zsh", "a.psm1"],
)
def test_standalone_shell_scripts_fail(repo: Path, name: str) -> None:
    """Flag `.sh`, `.ps1`, `.bash` and `.cmd` files; they belong in Makefile targets.

    Parameters:
        repo (Path): Disposable repository.
        name (str): Package-relative path.

    Returns:
        None: Assertions verify the report.
    """
    write_tree(repo, {f"{PACKAGE}/{name}": "x\n"})
    found = lines(repo)
    assert f"packages/x: {name}: shell-script" in found


def test_shell_scripts_in_fixtures_are_data(repo: Path) -> None:
    """Allow shell scripts under `tests/fixtures/`.

    Parameters:
        repo (Path): Disposable repository.

    Returns:
        None: Assertions verify the report.
    """
    write_tree(repo, {f"{PACKAGE}/tests/fixtures/a.sh": "x\n"})
    assert lines(repo) == []


def test_unreadable_and_deleted_sources_are_skipped(repo: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Skip a tracked source that is gone from the work tree, and warn on one that cannot be read.

    Parameters:
        repo (Path): Disposable repository.
        monkeypatch (pytest.MonkeyPatch): Makes one read fail.

    Returns:
        None: Assertions verify the report.
    """
    write_tree(
        repo, {f"{PACKAGE}/src/gone.ts": 'import "../../../y.ts";\n', f"{PACKAGE}/src/locked.ts": "x\n"}
    )
    (repo / PACKAGE / "src/gone.ts").unlink()
    real = Path.read_text

    def read_text(self: Path, *args: Any, **kwargs: Any) -> str:
        """Fail for one file, read the rest.

        Parameters:
            *args (Any): Positional arguments.
            **kwargs (Any): Keyword arguments.

        Returns:
            str: File contents.

        Raises:
            PermissionError: For `locked.ts`.
        """
        if self.name == "locked.ts":
            raise PermissionError("denied")
        return real(self, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", read_text)
    assert lines(repo) == []


def test_pe_reopen_failure_is_not_a_binary(tmp_path: Path) -> None:
    """Treat a file that vanishes between the head read and the `e_lfanew` seek as not a PE.

    Parameters:
        tmp_path (Path): Scratch directory.

    Returns:
        None: Assertions verify the result.
    """
    head = pe_image(0x100)[:256]
    assert package_layout.has_pe_signature(head, tmp_path / "gone") is False
    assert package_layout.is_binary(head, tmp_path / "gone") is False


def test_package_json_script_names(repo: Path) -> None:
    """Accept the standard script names and `test:<signal>`; flag the rest, plus `pi` media.

    Parameters:
        repo (Path): Disposable repository.

    Returns:
        None: Assertions verify the report.
    """
    scripts = dict.fromkeys(
        ("lint", "format", "typecheck", "test", "test:bun", "check", "build", "prepack", "bench"), "x"
    )
    scripts |= {"test:dist": "x", "lint:fix": "x", "postinstall": "x"}
    manifest = {
        "scripts": scripts,
        "pi": {"extensions": ["./src/index.ts"], "video": "https://example.invalid/a"},
    }
    write_tree(repo, {f"{PACKAGE}/package.json": json.dumps(manifest)})
    assert lines(repo) == [
        f"{PACKAGE}: package.json: pi-media",
        f"{PACKAGE}: package.json: script-name lint:fix",
        f"{PACKAGE}: package.json: script-name postinstall",
    ]


def test_removed_upstream_sync_scripts_are_denied(repo: Path) -> None:
    """Deny `test:upstream-sync` and `test:sync-reverts` despite the `test:` prefix.

    Parameters:
        repo (Path): Disposable repository.

    Returns:
        None: Assertions verify the report.
    """
    manifest = {"scripts": {"test:upstream-sync": "x", "test:sync-reverts": "x", "test:ok": "x"}}
    write_tree(repo, {f"{PACKAGE}/package.json": json.dumps(manifest)})
    assert lines(repo) == [
        "packages/x: package.json: script-name test:sync-reverts",
        "packages/x: package.json: script-name test:upstream-sync",
    ]


@pytest.mark.parametrize(
    "text", ["{not json", "[]", '{"scripts": "x", "pi": []}', '{"pi": {"extensions": []}}']
)
def test_package_json_shapes(repo: Path, text: str) -> None:
    """Report an unreadable manifest and tolerate odd but valid shapes.

    Parameters:
        repo (Path): Disposable repository.
        text (str): `package.json` contents.

    Returns:
        None: Assertions verify the report.
    """
    write_tree(repo, {f"{PACKAGE}/package.json": text})
    expected = [f"{PACKAGE}: package.json: unreadable JSONDecodeError"] if text.startswith("{not") else []
    assert lines(repo) == expected


def test_unreadable_manifest_file_is_reported(repo: Path) -> None:
    """Report a tracked `package.json` that is absent from the work tree.

    Parameters:
        repo (Path): Disposable repository.

    Returns:
        None: Assertions verify the report.
    """
    (repo / PACKAGE / "package.json").unlink()
    assert lines(repo) == [f"{PACKAGE}: package.json: unreadable FileNotFoundError"]


def test_shared_packages_get_script_and_config_rules_only(repo: Path) -> None:
    """Apply `package.json` script and Biome rules to `integration/inprocess`, but not the publish rules.

    Parameters:
        repo (Path): Disposable repository.

    Returns:
        None: Assertions verify the report.
    """
    manifest = {"scripts": {"check": "x", "docs": "x"}, "pi": {"image": "a.png"}}
    write_tree(
        repo,
        {
            f"{SHARED}/package.json": json.dumps(manifest),
            f"{SHARED}/biome.json": "{}\n",
            f"{SHARED}/AGENTS.md": "x\n",
            f"{SHARED}/.gitignore": "x\n",
            f"{SHARED}/a.test.mjs": "x\n",
            "integration/other/package.json": json.dumps({"scripts": {"build:x": "x"}}),
        },
    )
    assert lines(repo) == [f"{SHARED}: biome.json: biome-config", f"{SHARED}: package.json: script-name docs"]


def test_shared_package_without_a_manifest_is_only_checked_for_config(repo: Path) -> None:
    """Accept a shared directory with no `package.json`.

    Parameters:
        repo (Path): Disposable repository.

    Returns:
        None: Assertions verify the report.
    """
    assert lines(repo) == []


def test_configured_shared_path_without_tracked_files_is_a_hard_error(
    repo: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Exit 2 when a configured shared path has no tracked files, so a move cannot leave it unchecked.

    Parameters:
        repo (Path): Disposable repository.
        monkeypatch (pytest.MonkeyPatch): Configures a second shared path that was never created.

    Returns:
        None: Assertions verify the exit status.
    """
    assert package_layout.run(repo, None, lambda _line: None) == 0
    monkeypatch.setattr(package_layout, "SHARED_PACKAGES", (SHARED, "tests/lib"))
    with pytest.raises(ValueError, match="tests/lib"):
        package_layout.find_violations(repo)
    assert package_layout.run(repo, None, lambda _line: None) == 2
    write_tree(repo, {"tests/lib/index.ts": "export {};\n", "tests/lib/biome.json": "{}\n"})
    assert lines(repo) == ["tests/lib: biome.json: biome-config"]
    git(repo, "rm", "-q", "-r", "-f", SHARED)
    assert package_layout.run(repo, None, lambda _line: None) == 2


def test_file_directly_under_packages_is_not_a_package(repo: Path) -> None:
    """Flag a stray file beside the packages.

    Parameters:
        repo (Path): Disposable repository.

    Returns:
        None: Assertions verify the report.
    """
    write_tree(repo, {"packages/stray.md": "x\n"})
    assert lines(repo) == ["packages: stray.md: not-a-package"]


def entries_for(*violations: str) -> str:
    """Render allowlist text for violation lines.

    Parameters:
        *violations (str): Violation lines.

    Returns:
        str: Canonical allowlist text.
    """
    return package_layout.render_allowlist(violations)


def test_allowlisted_violation_passes_and_unlisted_fails(repo: Path) -> None:
    """Fail a new violation until it is listed, and pass it once it is.

    Parameters:
        repo (Path): Disposable repository.

    Returns:
        None: Assertions verify the report and exit status.
    """
    write_tree(repo, {f"{PACKAGE}/AGENTS.md": "x\n"})
    out: list[str] = []
    assert package_layout.run(repo, None, out.append) == 1
    assert out == ["packages/x: AGENTS.md: markdown: not allowlisted"]
    write_tree(repo, {package_layout.ALLOWLIST: entries_for("packages/x: AGENTS.md: markdown")})
    out.clear()
    assert package_layout.run(repo, None, out.append) == 0
    assert out == []


def test_stale_allowlist_entry_fails(repo: Path) -> None:
    """Fail an entry whose violation is gone, e.g. a deleted `.test-support` left in the list.

    Parameters:
        repo (Path): Disposable repository.

    Returns:
        None: Assertions verify the report and exit status.
    """
    write_tree(repo, {package_layout.ALLOWLIST: entries_for("packages/x: .test-support: dotfile")})
    out: list[str] = []
    assert package_layout.run(repo, None, out.append) == 1
    assert out == [f"{package_layout.ALLOWLIST}: packages/x: .test-support: dotfile: stale allowlist entry"]


def test_allowlist_must_be_canonical(repo: Path) -> None:
    """Fail an allowlist that is unsorted, duplicated or oddly formatted.

    Parameters:
        repo (Path): Disposable repository.

    Returns:
        None: Assertions verify the report and exit status.
    """
    write_tree(repo, {f"{PACKAGE}/AGENTS.md": "x\n", f"{PACKAGE}/SECURITY.md": "x\n"})
    first, second = "packages/x: AGENTS.md: markdown", "packages/x: SECURITY.md: markdown"
    for text in (
        json.dumps([second, first], indent=2) + "\n",
        json.dumps([first, first, second], indent=2) + "\n",
        json.dumps([first, second]) + "\n",
    ):
        write_tree(repo, {package_layout.ALLOWLIST: text})
        out: list[str] = []
        assert package_layout.run(repo, None, out.append) == 1
        assert out == [f"{package_layout.ALLOWLIST}: allowlist is not sorted, unique and one entry per line"]
    write_tree(repo, {package_layout.ALLOWLIST: entries_for(first, second)})
    assert package_layout.run(repo, None, lambda _line: None) == 0


@pytest.mark.parametrize("text", [None, "{nope", '{"a": 1}', "[1, 2]"])
def test_unusable_allowlist_cannot_run_the_gate(repo: Path, text: str | None) -> None:
    """Exit 2 rather than pass when the allowlist is missing or malformed.

    Parameters:
        repo (Path): Disposable repository.
        text (str | None): Allowlist contents, or None to delete it.

    Returns:
        None: Assertions verify the exit status.
    """
    if text is None:
        git(repo, "rm", "-q", "-f", package_layout.ALLOWLIST)
    else:
        write_tree(repo, {package_layout.ALLOWLIST: text})
    assert package_layout.run(repo, None, lambda _line: None) == 2


def test_entries_cannot_be_added_after_the_merge_base(repo: Path) -> None:
    """Fail an entry the base branch does not carry, even though its violation is real.

    Parameters:
        repo (Path): Disposable repository.

    Returns:
        None: Assertions verify the report and exit status.
    """
    write_tree(
        repo,
        {
            f"{PACKAGE}/AGENTS.md": "x\n",
            package_layout.ALLOWLIST: entries_for("packages/x: AGENTS.md: markdown"),
        },
    )
    base = commit(repo, "base")
    git(repo, "checkout", "-q", "-b", "feature")
    write_tree(
        repo,
        {
            f"{PACKAGE}/SECURITY.md": "x\n",
            package_layout.ALLOWLIST: entries_for(
                "packages/x: AGENTS.md: markdown", "packages/x: SECURITY.md: markdown"
            ),
        },
    )
    commit(repo, "add a violation and waive it")
    out: list[str] = []
    assert package_layout.run(repo, "main", out.append) == 1
    assert out == [
        f"{package_layout.ALLOWLIST}: packages/x: SECURITY.md: markdown: "
        f"allowlist entry not present at merge base {base[:12]}"
    ]
    # An unchanged or shrinking list passes, and so does comparing without a ref.
    git(repo, "rm", "-q", "-f", f"{PACKAGE}/SECURITY.md")
    write_tree(repo, {package_layout.ALLOWLIST: entries_for("packages/x: AGENTS.md: markdown")})
    assert package_layout.run(repo, "main", out.append) == 0
    git(repo, "rm", "-q", "-f", f"{PACKAGE}/AGENTS.md")
    write_tree(repo, {package_layout.ALLOWLIST: "[]\n"})
    assert package_layout.run(repo, "main", out.append) == 0


def test_comparison_is_skipped_where_the_base_has_no_allowlist(repo: Path) -> None:
    """Pass the commit that introduces the allowlist; there is nothing to compare against.

    Parameters:
        repo (Path): Disposable repository.

    Returns:
        None: Assertions verify the exit status.
    """
    git(repo, "rm", "-q", "-f", "--cached", package_layout.ALLOWLIST)
    commit(repo, "base without allowlist")
    git(repo, "checkout", "-q", "-b", "feature")
    write_tree(repo, {package_layout.ALLOWLIST: "[]\n"})
    commit(repo, "introduce")
    assert package_layout.run(repo, "main", lambda _line: None) == 0


def test_comparison_fails_for_an_unknown_ref_or_malformed_base(repo: Path) -> None:
    """Exit 2 when the ref is missing or the base allowlist cannot be parsed.

    Parameters:
        repo (Path): Disposable repository.

    Returns:
        None: Assertions verify the exit status.
    """
    commit(repo, "base")
    assert package_layout.run(repo, "origin/nope", lambda _line: None) == 2
    write_tree(repo, {package_layout.ALLOWLIST: "{nope"})
    commit(repo, "break the list")
    git(repo, "checkout", "-q", "-b", "feature")
    write_tree(repo, {package_layout.ALLOWLIST: "[]\n"})
    commit(repo, "fix")
    assert package_layout.run(repo, "main", lambda _line: None) == 2


def feature_branch(repo: Path, files: dict[str, str]) -> None:
    """Commit a clean base on `main`, then a feature commit that adds files.

    Parameters:
        repo (Path): Disposable repository.
        files (dict[str, str]): Repository-relative paths and contents added on the branch.

    Returns:
        None: `HEAD` is the feature commit.
    """
    commit(repo, "base")
    git(repo, "checkout", "-q", "-b", "feature")
    write_tree(repo, files)
    commit(repo, "feature")


@pytest.mark.parametrize(
    ("banned", "added"),
    [
        ("test/a.test.ts", "test/b.test.ts"),
        ("lib/a.ts", "lib/deep/b.ts"),
        ("docs/a.md", "docs/shot.png"),
        (".github/ci.yml", ".github/workflows/x.yml"),
        ("view/a.ts", "view/b.ts"),
    ],
)
def test_new_files_under_an_allowlisted_banned_entry_fail(repo: Path, banned: str, added: str) -> None:
    """Fail a file added below a waived banned directory; the waiver covers the directory, not new files.

    Parameters:
        repo (Path): Disposable repository.
        banned (str): Package-relative file that makes its top-level entry a waived violation.
        added (str): Package-relative file added below the same entry on the branch.

    Returns:
        None: Assertions verify the report and exit status.
    """
    top = banned.split("/", maxsplit=1)[0]
    rule = "dotfile" if top.startswith(".") else "top-level-entry"
    waived = f"{PACKAGE}: {top}: {rule}"
    write_tree(repo, {f"{PACKAGE}/{banned}": "x\n", package_layout.ALLOWLIST: entries_for(waived)})
    feature_branch(repo, {f"{PACKAGE}/{added}": "x\n", f"{PACKAGE}/tests/new.test.ts": "x\n"})
    out: list[str] = []
    assert package_layout.run(repo, "main", out.append) == 1
    assert out == [f"{PACKAGE}: {added}: added-under-banned-entry (add it under `tests/` instead)"]
    # Without a ref there is nothing to compare, and a file that was already there is not new.
    assert package_layout.run(repo, None, lambda _line: None) == 0
    git(repo, "rm", "-q", "-f", f"{PACKAGE}/{added}")
    assert package_layout.run(repo, "main", lambda _line: None) == 0  # new `tests/new.test.ts` is fine


def test_moving_files_out_of_a_banned_entry_is_not_growth(repo: Path) -> None:
    """Pass the migration itself: `test/` shrinks while `tests/` appears under the per-file rules.

    Parameters:
        repo (Path): Disposable repository.

    Returns:
        None: Assertions verify the exit status.
    """
    waived = f"{PACKAGE}: test: top-level-entry"
    write_tree(repo, {f"{PACKAGE}/test/b.test.ts": "x\n", package_layout.ALLOWLIST: entries_for(waived)})
    commit(repo, "base")
    git(repo, "checkout", "-q", "-b", "feature")
    git(repo, "mv", f"{PACKAGE}/test/b.test.ts", f"{PACKAGE}/tests/b.test.ts")
    write_tree(repo, {package_layout.ALLOWLIST: "[]\n"})
    commit(repo, "migrate")
    assert package_layout.run(repo, "main", lambda _line: None) == 0


def test_renames_within_a_banned_entry_are_not_growth(repo: Path) -> None:
    """Allow a pure rename inside the same banned entry, but not a move into it or an edited copy.

    Parameters:
        repo (Path): Disposable repository.

    Returns:
        None: Assertions verify the exit status and report.
    """
    waived = f"{PACKAGE}: test: top-level-entry"
    body = "export const stable = 1;\n" * 20
    write_tree(
        repo,
        {
            f"{PACKAGE}/test/a.test.ts": body,
            f"{PACKAGE}/src/area/m.ts": body + "// m\n",
            package_layout.ALLOWLIST: entries_for(waived),
        },
    )
    commit(repo, "base")
    git(repo, "checkout", "-q", "-b", "feature")
    (repo / PACKAGE / "test/deep").mkdir()
    git(repo, "mv", f"{PACKAGE}/test/a.test.ts", f"{PACKAGE}/test/deep/b.test.ts")
    commit(repo, "rename within")
    assert package_layout.run(repo, "main", lambda _line: None) == 0
    git(repo, "mv", f"{PACKAGE}/src/area/m.ts", f"{PACKAGE}/test/m.test.ts")
    commit(repo, "move in")
    out: list[str] = []
    assert package_layout.run(repo, "main", out.append) == 1
    assert out == [f"{PACKAGE}: test/m.test.ts: added-under-banned-entry (add it under `tests/` instead)"]


def test_a_mostly_rewritten_file_is_not_a_rename(repo: Path) -> None:
    """Count a moved file as growth when under 90% of it survives, so a gutted file cannot launder new code.

    Parameters:
        repo (Path): Disposable repository.

    Returns:
        None: Assertions verify the report.
    """
    waived = f"{PACKAGE}: test: top-level-entry"
    old = "".join(f"export const line{n} = {n};\n" for n in range(20))
    write_tree(repo, {f"{PACKAGE}/test/a.test.ts": old, package_layout.ALLOWLIST: entries_for(waived)})
    commit(repo, "base")
    git(repo, "checkout", "-q", "-b", "feature")
    git(repo, "mv", f"{PACKAGE}/test/a.test.ts", f"{PACKAGE}/test/b.test.ts")
    rewritten = "".join(f"export const line{n} = {n};\n" for n in range(11))
    rewritten += "".join(f"export const fresh{n} = {n};\n" for n in range(9))
    write_tree(repo, {f"{PACKAGE}/test/b.test.ts": rewritten})
    commit(repo, "move and rewrite")
    out: list[str] = []
    assert package_layout.run(repo, "main", out.append) == 1
    assert out == [f"{PACKAGE}: test/b.test.ts: added-under-banned-entry (add it under `tests/` instead)"]


def test_growth_is_checked_where_the_base_has_no_allowlist(repo: Path) -> None:
    """Compare tracked paths even for the commit that introduces the allowlist.

    Parameters:
        repo (Path): Disposable repository.

    Returns:
        None: Assertions verify the report.
    """
    write_tree(repo, {f"{PACKAGE}/lib/a.ts": "x\n"})
    git(repo, "rm", "-q", "-f", "--cached", package_layout.ALLOWLIST)
    commit(repo, "base without allowlist")
    git(repo, "checkout", "-q", "-b", "feature")
    write_tree(
        repo,
        {
            f"{PACKAGE}/lib/b.ts": "x\n",
            package_layout.ALLOWLIST: entries_for(f"{PACKAGE}: lib: top-level-entry"),
        },
    )
    commit(repo, "introduce")
    out: list[str] = []
    assert package_layout.run(repo, "main", out.append) == 1
    assert out == [f"{PACKAGE}: lib/b.ts: added-under-banned-entry (add it under `tests/` instead)"]


def test_make_compares_against_origin_main_unless_base_is_set() -> None:
    """Never skip the merge-base comparison: unset or empty `BASE` means `origin/main`.

    Returns:
        None: `make -n` prints the comparison argument for each `BASE`.
    """
    env = {key: value for key, value in os.environ.items() if key not in {"MAKEFLAGS", "MFLAGS", "BASE"}}
    for overrides, expected in (([], "origin/main"), (["BASE="], "origin/main"), (["BASE=abc123"], "abc123")):
        result = subprocess.run(
            ["make", "-n", "check-scripts", *overrides],
            cwd=REPO_ROOT,
            env=env,
            capture_output=True,
            text=True,
            check=True,
        )
        assert f'scripts/package_layout.py --compare-ref "{expected}"' in result.stdout


def test_main_reports_exit_status(
    repo: Path, capsys: pytest.CaptureFixture[str], tmp_path_factory: pytest.TempPathFactory
) -> None:
    """Print violation lines on stdout and exit non-zero; exit 2 outside a repository.

    Parameters:
        repo (Path): Disposable repository.
        capsys (pytest.CaptureFixture[str]): Captured output.
        tmp_path_factory (pytest.TempPathFactory): Makes a directory outside any repository.

    Returns:
        None: Assertions verify output and exit status.
    """
    assert package_layout.main(["--repo", str(repo)]) == 0
    write_tree(repo, {f"{PACKAGE}/AGENTS.md": "x\n"})
    assert package_layout.main(["--repo", str(repo)]) == 1
    assert capsys.readouterr().out == "packages/x: AGENTS.md: markdown: not allowlisted\n"
    assert package_layout.main(["--repo", str(tmp_path_factory.mktemp("outside"))]) == 2


def test_script_entry_point_exits_with_the_gate_status(repo: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Run the file as the Makefile does.

    Parameters:
        repo (Path): Disposable repository.
        monkeypatch (pytest.MonkeyPatch): Argument override.

    Returns:
        None: Assertions verify the exit status.
    """
    monkeypatch.setattr(sys, "argv", ["package_layout.py", "--repo", str(repo)])
    with pytest.raises(SystemExit) as raised:
        runpy.run_path(package_layout.__file__, run_name="__main__")
    assert raised.value.code == 0


def test_real_repository_matches_its_allowlist() -> None:
    """Pass on this checkout: every deviation is listed and nothing listed is gone.

    Returns:
        None: Assertions verify the report and exit status.
    """
    out: list[str] = []
    assert package_layout.run(REPO_ROOT, None, out.append) == 0, out
    assert out == []


def test_removing_any_real_entry_turns_the_gate_red() -> None:
    """Fail when a listed deviation loses its waiver, for every entry; fail a made-up one as stale.

    Returns:
        None: Assertions verify each variant of the list.
    """
    violations = package_layout.find_violations(REPO_ROOT)
    entries = [violation.line() for violation in violations]
    assert entries, "the allowlist is empty: delete this test, #860 is done"
    _, listed = package_layout.load_allowlist(REPO_ROOT)
    assert listed == entries
    for removed in entries:
        kept = [entry for entry in entries if entry != removed]
        problems = package_layout.allowlist_problems(violations, entries_for(*kept), kept, None)
        assert problems == [f"{removed}: not allowlisted"]
    invented = [*entries, "packages/todo: .no-such-dir: dotfile"]
    problems = package_layout.allowlist_problems(violations, entries_for(*invented), invented, None)
    assert problems == [
        f"{package_layout.ALLOWLIST}: packages/todo: .no-such-dir: dotfile: stale allowlist entry"
    ]


def test_real_violation_lines_follow_the_documented_shape() -> None:
    """Keep every entry one `<package>: <path>: <rule>` line the gate can parse back.

    Returns:
        None: Assertions verify each entry.
    """
    _, listed = package_layout.load_allowlist(REPO_ROOT)
    for entry in listed:
        package, path, rule = entry.split(": ", 2)
        assert package.startswith(("packages/", "integration/inprocess"))
        assert path
        assert rule.split(" ")[0] in {
            "biome-config",
            "dotfile",
            "import-escape",
            "markdown",
            "media",
            "missing-file",
            "pi-media",
            "script-name",
            "test-content",
            "test-extension",
            "test-support-dir",
            "test-location",
            "test-name",
            "top-level-entry",
            "shell-script",
            "tracked-binary",
            "tracked-dist",
        }
