"""Formula-equivalent release input, checksum and prebuild-selection tests, no binary execution."""

from __future__ import annotations

import hashlib
import io
import json
import subprocess
import tarfile
from typing import TYPE_CHECKING, Any

import pytest

from harness import release
from harness.release import fetch_release, gitlink_tag, manifest_checksums, prune_native, verify_asset

if TYPE_CHECKING:
    from pathlib import Path


def test_exact_gitlink_tag_or_clear_failure(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    calls = []

    def tagged(argv: list[str], **kwargs: Any) -> str:
        calls.append(argv)
        assert kwargs["text"]
        return "v1.3.0-nredd.4\n"

    monkeypatch.setattr(subprocess, "check_output", tagged)
    assert gitlink_tag(tmp_path) == "v1.3.0-nredd.4"
    assert calls[0][-3:] == ["describe", "--tags", "--exact-match"]

    def untagged(*args: Any, **kwargs: Any) -> str:
        raise subprocess.CalledProcessError(128, args[0])

    monkeypatch.setattr(subprocess, "check_output", untagged)
    with pytest.raises(RuntimeError, match="untagged; release it"):
        gitlink_tag(tmp_path)


def test_manifest_checksums_fail_closed(tmp_path: Path) -> None:
    tag = "v1.3.0-nredd.4"
    url = f"https://github.com/nredd/pi/releases/download/{tag}/core.tgz"
    asset = tmp_path / "core.tgz"
    asset.write_bytes(b"actual bytes")
    sha = hashlib.sha256(asset.read_bytes()).hexdigest()
    manifest = tmp_path / "release.json"
    manifest.write_text(
        json.dumps({"forks": [{"path": "forks/pi", "tag": tag}], "artifacts": [{"url": url, "sha256": sha}]})
    )
    checksums = manifest_checksums(tag, tmp_path)
    assert checksums == {url: sha}
    verify_asset(asset, url, checksums)
    with pytest.raises(ValueError, match="mismatch"):
        verify_asset(asset, url, {url: "0" * 64})
    with pytest.raises(ValueError, match="mismatch"):
        verify_asset(asset, url + "missing", checksums)
    verify_asset(asset, url, {})
    assert manifest_checksums("v1.3.0-nredd.9", tmp_path) == {}
    manifest.write_text(json.dumps({"forks": [{"path": "forks/pi", "tag": tag}], "artifacts": []}))
    with pytest.raises(ValueError, match="no release assets"):
        manifest_checksums(tag, tmp_path)


def test_conflicting_manifests_are_not_ignored(tmp_path: Path) -> None:
    url = "https://github.com/nredd/pi/releases/download/v1.3.0-nredd.4/core.tgz"
    for index in range(2):
        (tmp_path / f"{index}.json").write_text(
            json.dumps({"artifacts": [{"url": url, "sha256": str(index) * 64}]})
        )
    with pytest.raises(ValueError, match="Conflicting"):
        manifest_checksums("v1.3.0-nredd.4", tmp_path)


def test_prune_matches_formula_platform_spellings(tmp_path: Path) -> None:
    for system, arch in (("darwin", "arm64"), ("linux", "x64")):
        (tmp_path / f"koffi/build/koffi/{system}_{arch}").mkdir(parents=True)
        (tmp_path / f"@earendil-works/pi-tui/native/tui/prebuilds/{system}-{arch}").mkdir(parents=True)
    prune_native(tmp_path, "darwin", "arm64")
    assert (tmp_path / "koffi/build/koffi/darwin_arm64").is_dir()
    assert not (tmp_path / "koffi/build/koffi/linux_x64").exists()
    assert (tmp_path / "@earendil-works/pi-tui/native/tui/prebuilds/darwin-arm64").is_dir()
    assert not (tmp_path / "@earendil-works/pi-tui/native/tui/prebuilds/linux-x64").exists()


def test_fetch_installs_formula_layout_and_replaces_nested_tui(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Use fake downloads/npm writes to exercise the entire recipe without a Pi launch."""
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as archive:
        member = tarfile.TarInfo("package/package.json")
        data = b'{"name":"@earendil-works/pi-tui","version":"1.3.0"}'
        member.size = len(data)
        archive.addfile(member, io.BytesIO(data))
    tarball = output.getvalue()
    urls: list[str] = []

    def download(url: str, **kwargs: Any) -> io.BytesIO:
        urls.append(url)
        assert kwargs["timeout"] == 120
        return io.BytesIO(tarball)

    prefix = tmp_path / "prefix"
    destination = (
        prefix / "lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui"
    )
    commands = []

    def npm(argv: list[str], **kwargs: Any) -> str:
        commands.append(argv)
        assert kwargs["env"]["HOME"] == str(prefix / "fetch-home")
        assert kwargs["env"]["npm_config_userconfig"] == str(prefix / "npmrc-user")
        assert kwargs["env"]["npm_config_globalconfig"] == str(prefix / "npmrc-global")
        assert (prefix / "npmrc-user").read_text() == ""
        assert (prefix / "npmrc-global").read_text() == ""
        destination.mkdir(parents=True)
        (destination / "stale").write_text("registry copy must go away")
        return "installed"

    monkeypatch.setattr(release, "urlopen", download)
    monkeypatch.setattr(release.shutil, "which", lambda _: "/explicit/npm")
    monkeypatch.setattr(subprocess, "check_output", npm)
    binary = fetch_release("v1.3.0-nredd.4", prefix, tmp_path / "manifests")
    assert binary == prefix / "bin/pi"
    assert len(urls) == 2
    assert urls[0].endswith("/earendil-works-pi-coding-agent-1.3.0.tgz")
    assert urls[1].endswith("/earendil-works-pi-tui-1.3.0.tgz")
    assert commands[0][1:6] == ["install", "--global", "--prefix", str(prefix), "--min-release-age=0"]
    assert not (destination / "stale").exists()
    assert json.loads((destination / "package.json").read_text())["name"] == "@earendil-works/pi-tui"


def test_fetch_refuses_bad_tag_or_reused_prefix_before_network(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="release tag"):
        fetch_release("main", tmp_path / "new", tmp_path)
    (tmp_path / "sentinel").write_text("do not overwrite")
    with pytest.raises(ValueError, match="must be empty"):
        fetch_release("v1.3.0-nredd.4", tmp_path, tmp_path)
