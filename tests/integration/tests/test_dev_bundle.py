"""Dev bundle consumer contract.

References:
- https://github.com/nredd/pi-harness/issues/888
"""

from __future__ import annotations

import io
import json
import subprocess
import tarfile
from pathlib import Path
from typing import Any

import pytest
from pi_release.dev_bundle import Bundle, build_bundle, main, pack_package, relative_entry, run


def test_pack_checks_declared_entries(tmp_path: Path) -> None:
    """Reject an extension absent from the actual npm tarball."""
    package = tmp_path / "source"
    package.mkdir()
    (package / "package.json").write_text(
        json.dumps({"name": "@nredd/example", "version": "1.0.0", "pi": {"extensions": ["./missing.ts"]}})
    )
    output = tmp_path / "output"
    output.mkdir()
    with pytest.raises(ValueError, match=r"missing\.ts"):
        pack_package(package, output)
    assert not (output / "manifest.json").exists()


def test_pack_records_real_payload(tmp_path: Path) -> None:
    """Read extension metadata from the packed manifest, including directory entries."""
    package = tmp_path / "source"
    package.mkdir()
    (package / "package.json").write_text(
        json.dumps({"name": "@nredd/example", "version": "1.0.0", "pi": {"extensions": ["./src"]}})
    )
    (package / "src").mkdir()
    (package / "src/index.ts").write_text("export default () => {};\n")
    output = tmp_path / "output"
    output.mkdir()
    result = pack_package(package, output)
    assert result.extensions == ["src"]
    assert result.tarball == "nredd-example-1.0.0.tgz"
    with tarfile.open(output / result.tarball) as archive:
        assert archive.extractfile("package/src/index.ts") is not None


@pytest.mark.parametrize("entry", ["", ".", "/absolute", "../escape", "src/../escape", "src\\\\escape"])
def test_reject_unsafe_entries(entry: str) -> None:
    """A bundle never exports paths outside its package."""
    with pytest.raises(ValueError, match="Unsafe"):
        relative_entry(entry)


def test_missing_tool(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Missing build prerequisites fail before a command can run."""
    monkeypatch.setattr("shutil.which", lambda _: None)
    with pytest.raises(FileNotFoundError, match="unavailable"):
        run(tmp_path, "npm", "pack")


def archive_file(archive: tarfile.TarFile, name: str, content: bytes) -> None:
    """Write a literal fixture member without extracting arbitrary paths."""
    member = tarfile.TarInfo(name)
    member.size = len(content)
    archive.addfile(member, io.BytesIO(content))


class Toolchain:
    """Synthetic subprocess boundary; packages still pass through real tar inspection."""

    def __init__(self, root: Path) -> None:
        """Create a clean synthetic Gitlink and public-safe package inventory."""
        self.root = root
        self.gitlink = "160000 commit abc forks/pi"
        self.core_sha = "abc"
        self.dirty = ""
        self.cli = True
        self.commands: list[tuple[Path, list[str]]] = []
        self.entries: Any = ["./src/index.ts"]
        self.directory_manifest = False
        self.mapped = True
        self.fail = False
        for directory, name in [
            ("packages/preset", "@nredd/pi-preset"),
            ("packages/unowned", "other-package"),
            ("forks/pi/packages/coding-agent", "@earendil-works/pi-coding-agent"),
            ("forks/pi/packages/tui", "@earendil-works/pi-tui"),
            ("forks/pi/packages/agent", "@earendil-works/pi-agent-core"),
            ("forks/pi/packages/ai", "@earendil-works/pi-ai"),
        ]:
            path = root / directory
            path.mkdir(parents=True)
            (path / "package.json").write_text(json.dumps({"name": name, "version": "1.0.0"}))

    def __call__(self, cmd: list[str], *, cwd: Path, text: bool, stderr: int) -> str:
        """Emulate only external command results, writing actual packed bytes."""
        assert text
        assert stderr == subprocess.STDOUT
        args = cmd[1:]
        self.commands.append((cwd, args))
        if args[:2] == ["ls-tree", "HEAD"]:
            return self.gitlink
        if args == ["rev-parse", "HEAD"]:
            return self.core_sha if cwd.name == "pi" else "harness-sha"
        if args == ["status", "--porcelain"]:
            return self.dirty
        if self.fail:
            raise subprocess.CalledProcessError(1, cmd, output="synthetic build failure")
        if args[0] == "pack":
            destination = Path(args[-1])
            registry = args[1].startswith("@earendil")
            data: dict[str, Any] = (
                {"name": "models", "version": "1.0.0"}
                if registry
                else json.loads((cwd / "package.json").read_text())
            )
            if data["name"] == "@nredd/pi-preset":
                data["pi"] = {"extensions": self.entries}
                if not self.mapped:
                    data["pi"] = {"extensions": []}
            filename = data["name"].replace("@", "").replace("/", "-") + ".tgz"
            with tarfile.open(destination / filename, "w:gz") as archive:
                if self.directory_manifest and not registry:
                    member = tarfile.TarInfo("package/package.json")
                    member.type = tarfile.DIRTYPE
                    archive.addfile(member)
                else:
                    archive_file(archive, "package/package.json", json.dumps(data).encode())
                archive_file(archive, "package/src/index.ts", b"export default () => {};")
                if registry:
                    archive_file(archive, "package/dist/providers/data/models.json", b"{}")
            return json.dumps([{"filename": filename}])
        if args[0] == "install" and self.cli:
            cli = cwd / "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"
            cli.parent.mkdir(parents=True)
            cli.write_text("// synthetic CLI\n")
        return ""


@pytest.fixture
def toolchain(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Toolchain:
    """Replace subprocesses, not bundle-building collaborators."""
    tools = Toolchain(tmp_path / "checkout")
    monkeypatch.setattr(subprocess, "check_output", tools)
    return tools


def test_build_portable_bundle(toolchain: Toolchain, tmp_path: Path) -> None:
    """Build, inspect and consume the complete manifest without source layout knowledge."""
    output = tmp_path / "bundle"
    bundle = build_bundle(toolchain.root, output)
    assert Bundle.model_validate_json((output / "manifest.json").read_text()) == bundle
    assert bundle.source_sha == "harness-sha"
    assert bundle.core_sha == "abc"
    assert set(bundle.packages) == {
        "@nredd/pi-preset",
        "@earendil-works/pi-coding-agent",
        "@earendil-works/pi-tui",
        "@earendil-works/pi-agent-core",
        "@earendil-works/pi-ai",
    }
    assert (output / bundle.core_bin).is_file()
    assert bundle.packages["@nredd/pi-preset"].filter_mapping == {
        "extensions/expanded-footer.ts": "src/index.ts"
    }
    assert all((output / package.tarball).is_file() for package in bundle.packages.values())
    assert (toolchain.root, ["run", "build"]) in toolchain.commands
    assert (toolchain.root / "forks/pi", ["run", "build:offline"]) in toolchain.commands
    runtime = json.loads((output / "core/package.json").read_text())
    assert len(runtime["overrides"]) == 4
    assert runtime["overrides"] == runtime["dependencies"]


@pytest.mark.parametrize(
    "failure", ["existing", "inside", "gitlink", "mismatch", "dirty", "empty", "cli", "command"]
)
def test_build_fails_closed(toolchain: Toolchain, tmp_path: Path, failure: str) -> None:
    """Reject invalid input or failed tools without publishing a manifest."""
    output = tmp_path / "bundle"
    if failure == "existing":
        output.mkdir()
    if failure == "inside":
        output = toolchain.root / "bundle"
    if failure == "gitlink":
        toolchain.gitlink = ""
    if failure == "mismatch":
        toolchain.core_sha = "wrong"
    if failure == "dirty":
        toolchain.dirty = " M tracked-file"
    if failure == "empty":
        (toolchain.root / "packages/preset/package.json").unlink()
    if failure == "cli":
        toolchain.cli = False
    if failure == "command":
        toolchain.fail = True
    with pytest.raises((ValueError, FileExistsError, subprocess.CalledProcessError)):
        build_bundle(toolchain.root, output)
    assert not (output / "manifest.json").exists()
    assert not list(tmp_path.glob(".dev-bundle-*"))


@pytest.mark.parametrize("entries", ["src/index.ts", [42]])
def test_packed_extensions_must_be_strings(toolchain: Toolchain, tmp_path: Path, entries: Any) -> None:
    """Malformed packed metadata cannot silently turn off extension auditing."""
    toolchain.entries = entries
    with pytest.raises(ValueError, match="array of strings"):
        pack_package(toolchain.root / "packages/preset", tmp_path)


def test_packed_manifest_must_be_file(toolchain: Toolchain, tmp_path: Path) -> None:
    """Reject a directory substituted for the packed package manifest."""
    toolchain.directory_manifest = True
    with pytest.raises(ValueError, match="not a file"):
        pack_package(toolchain.root / "packages/preset", tmp_path)


def test_missing_preset_mapping(toolchain: Toolchain, tmp_path: Path) -> None:
    """Refuse a stale filter alias instead of activating unfiltered resources."""
    toolchain.mapped = False
    with pytest.raises(ValueError, match="mapping"):
        pack_package(toolchain.root / "packages/preset", tmp_path)


def test_command_success(toolchain: Toolchain, tmp_path: Path, caplog: pytest.LogCaptureFixture) -> None:
    """The CLI reports its single manifest location and never activates it."""
    with caplog.at_level("INFO"):
        assert main(["--root", str(toolchain.root), "--output", str(tmp_path / "bundle")]) == 0
    assert "manifest.json" in caplog.text


def test_command_failure(tmp_path: Path, caplog: pytest.LogCaptureFixture) -> None:
    """The CLI returns a nonzero status for a rejected destination."""
    assert main(["--output", str(tmp_path)]) == 1
    assert "Dev bundle failed" in caplog.text
