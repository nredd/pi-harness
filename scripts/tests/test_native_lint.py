"""Exercise the lint CLI with native tools and isolated malformed repositories.

References:
    https://github.com/rhysd/actionlint
    https://github.com/PowerShell/PSScriptAnalyzer
"""

from __future__ import annotations

import hashlib
import io
import json
import shutil
import subprocess
import sys
import tarfile
import zipfile
from pathlib import Path
from unittest.mock import Mock

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import native_lint

PREFIX = native_lint.ROOT / ".native-lint"
GIT = str(Path(shutil.which("git") or "/usr/bin/git").resolve())


@pytest.fixture
def repository(tmp_path: Path) -> Path:
    """Create a real tracked repository with all three valid source kinds.

    Parameters:
        tmp_path (Path): Isolated test directory.
    Returns:
        Path: Minimal valid repository.
    """
    subprocess.check_output([GIT, "init", "-q", str(tmp_path)])
    (tmp_path / "script.sh").write_text("#!/bin/sh\nprintf '%s\\n' hello\n")
    (tmp_path / "script.ps1").write_text("Write-Output 'hello'\n")
    workflow = tmp_path / ".github/workflows/valid.yml"
    workflow.parent.mkdir(parents=True)
    workflow.write_text(
        "on: push\njobs:\n  test:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo hello\n"
    )
    subprocess.check_output([GIT, "-C", str(tmp_path), "add", "."])
    return tmp_path


def test_native_valid_source_is_not_executed(repository: Path) -> None:
    """Lint valid syntax without running its deliberately fatal command.

    Parameters:
        repository (Path): Disposable tracked source.
    Returns:
        None.
    """
    (repository / "script.sh").write_text("#!/bin/sh\nexit 93\n")
    native_lint.lint(repository, PREFIX)


@pytest.mark.parametrize(
    ("file", "content", "diagnostic"),
    [
        ("script.sh", '#!/bin/sh\necho "$unassigned"\n', "SC2154"),
        ("script.ps1", "function Broken {\n", "MissingEndCurlyBrace"),
        (
            "script.ps1",
            'ConvertTo-SecureString "secret" -AsPlainText -Force\n',
            "PSAvoidUsingConvertToSecureStringWithPlainText",
        ),
        (
            ".github/workflows/valid.yml",
            "on: push\njobs:\n  test:\n    runs-on: ubuntu-24.04\n"
            "    steps:\n      - run: echo ${{ secrets }}\n",
            "secrets",
        ),
        (
            ".github/workflows/valid.yml",
            "on: push\njobs:\n  test:\n    runs-on: ubuntu-24.04\n"
            "    steps:\n      - run: echo $unassigned\n",
            "SC2086",
        ),
        (
            ".github/workflows/valid.yml",
            "on: push\njobs:\n  test:\n    runs-on: windows-2025\n"
            "    steps:\n      - shell: pwsh\n        run: 'function Broken {'\n",
            "MissingEndCurlyBrace",
        ),
    ],
)
def test_native_malformed_refusal(repository: Path, file: str, content: str, diagnostic: str) -> None:
    """Require each real analyzer to reject invalid syntax or semantics.

    Parameters:
        repository (Path): Tracked source repository.
        file (str): Existing source path.
        content (str): Deliberately invalid source.
        diagnostic (str): Native diagnostic identifier.
    Returns:
        None.
    """
    (repository / file).write_text(content)
    with pytest.raises(subprocess.CalledProcessError) as caught:
        native_lint.lint(repository, PREFIX)
    assert diagnostic in caught.value.output


@pytest.mark.parametrize("shell", ["bash", "bash -e {0}", "pwsh", "unsupported"])
def test_composite_shells(repository: Path, shell: str) -> None:
    """Analyze composite shells and refuse unknown shell dialects.

    Parameters:
        repository (Path): Real tracked repository.
        shell (str): Composite shell declaration.
    Returns:
        None.
    """
    action = repository / ".github/actions/demo/action.yaml"
    action.parent.mkdir(parents=True)
    action.write_text(
        "runs:\n  using: composite\n  steps:\n    - uses: example/action@main\n"
        f"    - shell: '{shell}'\n      run: '{'Write-Output hello' if shell == 'pwsh' else 'echo hello'}'\n"
    )
    subprocess.check_output([GIT, "-C", str(repository), "add", "."])
    if shell == "unsupported":
        with pytest.raises(ValueError, match="Unsupported composite shell"):
            native_lint.lint(repository, PREFIX)
    else:
        native_lint.lint(repository, PREFIX)


@pytest.mark.parametrize("missing", ["script.sh", "script.ps1", ".github/workflows/valid.yml"])
def test_empty_inventory_refusal(repository: Path, missing: str) -> None:
    """Do not silently pass a missing source class.

    Parameters:
        repository (Path): Source repository.
        missing (str): Source to untrack.
    Returns:
        None.
    """
    subprocess.check_output([GIT, "-C", str(repository), "rm", "-f", missing])
    with pytest.raises(ValueError, match="Empty"):
        native_lint.lint(repository, PREFIX)


def test_missing_tool_refusal(tmp_path: Path) -> None:
    """Never fall back to a globally installed executable.

    Parameters:
        tmp_path (Path): Empty isolated prefix.
    Returns:
        None.
    """
    with pytest.raises(FileNotFoundError, match="shellcheck"):
        native_lint.verify(tmp_path)


def test_wrong_native_version(tmp_path: Path) -> None:
    """A real executable with a mismatched version cannot admit a gate.

    Parameters:
        tmp_path (Path): Fake executable prefix.
    Returns:
        None.
    """
    for name in native_lint.VERSIONS:
        binary = tmp_path / name / name
        binary.parent.mkdir()
        binary.write_text("#!/bin/sh\necho 99.0.0\n")
        binary.chmod(0o755)
    with pytest.raises(ValueError, match="Wrong 'shellcheck' version"):
        native_lint.verify(tmp_path)


@pytest.mark.parametrize("kind", ["wheel", "tar"])
def test_bootstrap_checksum_and_replacement(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, kind: str
) -> None:
    """Use tiny real archives to exercise verified install and reinstall.

    Parameters:
        tmp_path (Path): Disposable archive and prefix.
        monkeypatch (pytest.MonkeyPatch): Download/native process boundary doubles.
        kind (str): Archive encoding.
    Returns:
        None.
    """
    archive = tmp_path / ("source.whl" if kind == "wheel" else "source.tar.gz")
    content = b"#!/bin/sh\necho fake\n"
    if kind == "wheel":
        with zipfile.ZipFile(archive, "w") as bundle:
            bundle.writestr("shellcheck/", b"")
            bundle.writestr("nested/shellcheck", content)
    else:
        with tarfile.open(archive, "w:gz") as bundle:
            member = tarfile.TarInfo("nested/shellcheck")
            member.size = len(content)
            bundle.addfile(member, io.BytesIO(content))
    manifest = tmp_path / "manifest.json"
    asset = {"url": archive.as_uri(), "sha256": hashlib.sha256(archive.read_bytes()).hexdigest()}
    manifest.write_text(json.dumps({"test": {"shellcheck": asset}}))
    monkeypatch.setattr(native_lint, "MANIFEST", manifest)
    verifier = Mock()
    monkeypatch.setattr(native_lint, "verify", verifier)
    destination = tmp_path / "isolated"
    native_lint.bootstrap(destination, "test")
    native_lint.bootstrap(destination, "test")
    assert (destination / "shellcheck/nested/shellcheck").stat().st_mode & 0o111
    assert verifier.call_count == 2
    asset["sha256"] = "0" * 64
    manifest.write_text(json.dumps({"test": {"shellcheck": asset}}))
    with pytest.raises(ValueError, match="Checksum mismatch"):
        native_lint.bootstrap(destination, "test")
    with pytest.raises(ValueError, match="Unsupported lint host"):
        native_lint.bootstrap(destination, "unknown")


def test_cli_native_and_failure(repository: Path) -> None:
    """Exercise the actual CLI success and native diagnostic exit path.

    Parameters:
        repository (Path): Disposable source repository.
    Returns:
        None.
    """
    cmd = [
        sys.executable,
        str(Path(native_lint.__file__)),
        "check",
        "--root",
        str(repository),
        "--prefix",
        str(PREFIX),
    ]
    output = subprocess.check_output(cmd, text=True, stderr=subprocess.STDOUT)
    assert "static analysis only" in output
    (repository / "script.ps1").write_text("function Broken {\n")
    with pytest.raises(subprocess.CalledProcessError) as caught:
        subprocess.check_output(cmd, text=True, stderr=subprocess.STDOUT)
    assert "MissingEndCurlyBrace" in caught.value.output


def test_cli_bootstrap_boundary(monkeypatch: pytest.MonkeyPatch) -> None:
    """Cover CLI bootstrap dispatch without redownloading real release archives.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): Network/install boundary doubles.
    Returns:
        None.
    """
    install = Mock()
    monkeypatch.setattr(native_lint, "bootstrap", install)
    monkeypatch.setattr(sys, "argv", ["native_lint.py", "bootstrap"])
    native_lint.main()
    assert install.call_count == 1
    install.side_effect = OSError("download failed")
    with pytest.raises(SystemExit) as caught:
        native_lint.main()
    assert caught.value.code == 1


@pytest.mark.parametrize("module_version", [None, "99.0.0"])
def test_native_analyzer_missing_or_wrong_version(
    repository: Path, tmp_path: Path, module_version: str | None
) -> None:
    """Refuse a missing or wrong-version PowerShell analyzer, even with valid binaries.

    Parameters:
        repository (Path): Valid tracked source repository.
        tmp_path (Path): Disposable prefix.
        module_version (str | None): Dummy module version, or no module.
    Returns:
        None.
    """
    prefix = tmp_path / "tools"
    prefix.mkdir()
    for name in native_lint.VERSIONS:
        (prefix / name).symlink_to(PREFIX / name, target_is_directory=True)
    if module_version is not None:
        module = prefix / "analyzer/PSScriptAnalyzer.psd1"
        module.parent.mkdir()
        module.write_text(f"@{{ ModuleVersion = '{module_version}' }}")
    with pytest.raises(subprocess.CalledProcessError):
        native_lint.lint(repository, prefix)


def test_manifest_pins_all_supported_hosts() -> None:
    """Validate exact HTTPS asset/checksum pins for all native execution hosts.

    Parameters:
        None.
    Returns:
        None.
    """
    manifest = json.loads(native_lint.MANIFEST.read_text())
    assert set(manifest) == {"darwin-arm64", "darwin-x86_64", "linux-x86_64", "linux-aarch64"}
    for tools in manifest.values():
        assert set(tools) == {"shellcheck", "actionlint", "pwsh", "analyzer"}
        for asset in tools.values():
            assert asset["url"].startswith("https://")
            assert len(bytes.fromhex(asset["sha256"])) == 32
