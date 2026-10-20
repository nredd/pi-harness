"""Formula-equivalent release input, checksum and prebuild-selection tests, no binary execution.

References:
- https://github.com/nredd/homebrew-tap/blob/main/Formula/pi-coding-agent.rb
- https://docs.python.org/3/library/hashlib.html
"""

from __future__ import annotations

import hashlib
import io
import json
import subprocess
import tarfile
from typing import TYPE_CHECKING, Any

import pytest

from harness import release
from harness.release import (
    ATTESTATION_WORKFLOW,
    fetch_release,
    gitlink_tag,
    manifest_checksums,
    prune_native,
    release_checksums,
    verify_asset,
    verify_provenance,
)

if TYPE_CHECKING:
    from pathlib import Path


def test_exact_gitlink_tag_or_clear_failure(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """Require an exact tag and retain git diagnostics plus exception chaining on failure.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): substitute successful and failing git output.
        tmp_path (Path): explicit Gitlink directory.
    """
    calls = []

    def tagged(argv: list[str], **kwargs: Any) -> str:
        """Return an exact tag while recording the requested git command.

        Parameters:
            argv (list[str]): git command and arguments.
            **kwargs (Any): subprocess capture options.

        Returns:
            str: simulated tagged git output.
        """
        calls.append(argv)
        assert kwargs["text"]
        assert kwargs["stderr"] == subprocess.STDOUT
        return "v1.3.0-nredd.4\n"

    monkeypatch.setattr(subprocess, "check_output", tagged)
    assert gitlink_tag(tmp_path) == "v1.3.0-nredd.4"
    assert calls[0][-3:] == ["describe", "--tags", "--exact-match"]

    def untagged(*args: Any, **kwargs: Any) -> str:
        """Simulate git's diagnostic for an untagged checkout.

        Parameters:
            *args (Any): subprocess positional arguments.
            **kwargs (Any): subprocess capture options.

        Raises:
            subprocess.CalledProcessError: exact tag lookup failed with captured output.
        """
        raise subprocess.CalledProcessError(128, args[0], output="fatal: no tag exactly matches")

    monkeypatch.setattr(subprocess, "check_output", untagged)
    with pytest.raises(RuntimeError, match=r"untagged; release it.*fatal: no tag exactly matches") as caught:
        gitlink_tag(tmp_path)
    assert isinstance(caught.value.__cause__, subprocess.CalledProcessError)


def test_manifest_checksums_fail_closed(tmp_path: Path) -> None:
    """Accept matching bytes only, refusing mismatches and missing recorded identities.

    Parameters:
        tmp_path (Path): private downloaded asset and manifest directory.
    """
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
    with pytest.raises(ValueError, match="No recorded release checksum"):
        verify_asset(asset, url + "missing", checksums)
    with pytest.raises(ValueError, match="No recorded release checksum"):
        verify_asset(asset, url, {})
    with pytest.raises(ValueError, match="No recorded release checksums"):
        manifest_checksums("v1.3.0-nredd.9", tmp_path)
    manifest.write_text(
        json.dumps(
            {
                "forks": [{"path": "forks/pi", "tag": tag}],
                "artifacts": [{"url": "https://example.invalid/unrelated.tgz", "sha256": sha}],
            }
        )
    )
    with pytest.raises(ValueError, match="no release assets"):
        manifest_checksums(tag, tmp_path)


@pytest.mark.parametrize("snapshot_name", ["0-source.json", "z-source.json"])
def test_source_only_snapshot_keeps_recorded_asset_checksums(tmp_path: Path, snapshot_name: str) -> None:
    """A Gitlink-only snapshot neither declares assets nor hides real release identities.

    Parameters:
        tmp_path (Path): private release and source-only manifests.
        snapshot_name (str): sort the source snapshot before or after the asset receipt.
    """
    tag = "v1.3.0-nredd.6"
    url = f"https://github.com/nredd/pi/releases/download/{tag}/core.tgz"
    (tmp_path / snapshot_name).write_text(
        json.dumps({"forks": [{"path": "forks/pi", "tag": tag}], "artifacts": []})
    )
    (tmp_path / "release.json").write_text(json.dumps({"artifacts": [{"url": url, "sha256": "a" * 64}]}))
    assert manifest_checksums(tag, tmp_path) == {url: "a" * 64}
    with pytest.raises(ValueError, match="No recorded release checksum"):
        verify_asset(tmp_path / "unrecorded.tgz", url + "missing", manifest_checksums(tag, tmp_path))
    (tmp_path / "release.json").unlink()
    with pytest.raises(ValueError, match="No recorded release checksums"):
        fetch_release(tag, tmp_path / "prefix", tmp_path)
    assert not (tmp_path / "prefix").exists()


@pytest.mark.parametrize("exists", [False, True])
def test_missing_manifest_refuses_installation_before_network(tmp_path: Path, exists: bool) -> None:
    """Refuse missing or empty manifest directories before creating an install prefix.

    Parameters:
        tmp_path (Path): isolated installation paths.
        exists (bool): create the directory without a manifest when true.
    """
    manifests = tmp_path / "manifests"
    if exists:
        manifests.mkdir()
    prefix = tmp_path / "prefix"
    with pytest.raises(ValueError, match="No recorded release checksums"):
        fetch_release("v1.3.0-nredd.6", prefix, manifests)
    assert not prefix.exists()


def test_manifest_without_requested_tag_refuses_installation(tmp_path: Path) -> None:
    """Refuse a recorded release unrelated to the requested tag.

    Parameters:
        tmp_path (Path): private manifest and installation paths.
    """
    (tmp_path / "other.json").write_text(
        json.dumps({"forks": [{"path": "forks/pi", "tag": "v1.3.0-nredd.4"}], "artifacts": []})
    )
    with pytest.raises(ValueError, match="No recorded release checksums"):
        fetch_release("v1.3.0-nredd.6", tmp_path / "prefix", tmp_path)
    assert not (tmp_path / "prefix").exists()


def test_conflicting_manifests_are_not_ignored(tmp_path: Path) -> None:
    """Refuse conflicting digests for one release URL across manifests.

    Parameters:
        tmp_path (Path): private contradictory manifest directory.
    """
    url = "https://github.com/nredd/pi/releases/download/v1.3.0-nredd.4/core.tgz"
    for index in range(2):
        (tmp_path / f"{index}.json").write_text(
            json.dumps({"artifacts": [{"url": url, "sha256": str(index) * 64}]})
        )
    with pytest.raises(ValueError, match="Conflicting"):
        manifest_checksums("v1.3.0-nredd.4", tmp_path)


def test_release_checksums_require_release_file_except_named_legacy(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Trust only committed legacy identities or a strict release `SHA256SUMS` file.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): replace release checksum download.
        tmp_path (Path): private manifest directory.
    """
    tag = "v1.3.0-nredd.8"
    base = f"https://github.com/nredd/pi/releases/download/{tag}/"
    monkeypatch.setattr(
        release,
        "urlopen",
        lambda url, **kwargs: io.BytesIO(f"{'a' * 64}  earendil-works-pi-coding-agent-1.3.0.tgz\n".encode()),
    )
    assert release_checksums(tag, tmp_path) == {base + "earendil-works-pi-coding-agent-1.3.0.tgz": "a" * 64}
    monkeypatch.setattr(release, "urlopen", lambda url, **kwargs: io.BytesIO(b"not a checksum\n"))
    with pytest.raises(ValueError, match="Invalid"):
        release_checksums(tag, tmp_path)


def test_provenance_verification_pins_workflow_and_tag(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Pass exact provenance identity arguments to the GitHub CLI.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): replace GitHub CLI discovery and execution.
        tmp_path (Path): private release artifact.
    """
    artifact = tmp_path / "core.tgz"
    artifact.write_bytes(b"core")
    calls = []

    def gh(argv: list[str], **kwargs: Any) -> str:
        """Record a successful provenance invocation.

        Parameters:
            argv (list[str]): GitHub CLI command and arguments.
            **kwargs (Any): subprocess options.

        Returns:
            str: simulated verification output.
        """
        calls.append(argv)
        assert kwargs["timeout"] == 120
        return "verified"

    monkeypatch.setattr(release.shutil, "which", lambda name: "/explicit/gh")
    monkeypatch.setattr(subprocess, "check_output", gh)
    verify_provenance(artifact, "v1.3.0-nredd.8")
    assert calls == [
        [
            "/explicit/gh",
            "attestation",
            "verify",
            str(artifact),
            "--repo",
            "nredd/pi",
            "--signer-workflow",
            ATTESTATION_WORKFLOW,
            "--source-ref",
            "refs/tags/v1.3.0-nredd.8",
            "--deny-self-hosted-runners",
        ]
    ]


def test_prune_matches_formula_platform_spellings(tmp_path: Path) -> None:
    """Retain only native prebuilds using each dependency's platform spelling.

    Parameters:
        tmp_path (Path): private fake nested node_modules tree.
    """
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
    """Use fake downloads/npm writes to exercise the entire recipe without a Pi launch.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): substitute network downloads, npm discovery and execution.
        tmp_path (Path): private release prefix and recorded checksum directory.
    """
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as archive:
        member = tarfile.TarInfo("package/package.json")
        data = b'{"name":"@earendil-works/pi-tui","version":"1.3.0"}'
        member.size = len(data)
        archive.addfile(member, io.BytesIO(data))
    tarball = output.getvalue()
    urls: list[str] = []

    def download(url: str, **kwargs: Any) -> io.BytesIO:
        """Serve a deterministic tarball instead of contacting GitHub.

        Parameters:
            url (str): canonical release asset URL.
            **kwargs (Any): network timeout options.

        Returns:
            io.BytesIO: in-memory download stream.
        """
        urls.append(url)
        assert kwargs["timeout"] == 120
        return io.BytesIO(tarball)

    prefix = tmp_path / "prefix"
    destination = (
        prefix / "lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui"
    )
    commands = []

    def npm(argv: list[str], **kwargs: Any) -> str:
        """Write the formula's nested dependency layout without executing npm.

        Parameters:
            argv (list[str]): npm install command.
            **kwargs (Any): isolated subprocess environment and capture options.

        Returns:
            str: simulated npm output.
        """
        commands.append(argv)
        assert kwargs["stderr"] == subprocess.STDOUT
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
    manifests = tmp_path / "manifests"
    manifests.mkdir()
    base = "https://github.com/nredd/pi/releases/download/v1.3.0-nredd.4/"
    (manifests / "release.json").write_text(
        json.dumps(
            {
                "artifacts": [
                    {
                        "url": base + f"earendil-works-{package}-1.3.0.tgz",
                        "sha256": hashlib.sha256(tarball).hexdigest(),
                    }
                    for package in ("pi-coding-agent", "pi-tui")
                ]
            }
        )
    )
    binary = fetch_release("v1.3.0-nredd.4", prefix, manifests)
    assert binary == prefix / "bin/pi"
    assert len(urls) == 2
    assert urls[0].endswith("/earendil-works-pi-coding-agent-1.3.0.tgz")
    assert urls[1].endswith("/earendil-works-pi-tui-1.3.0.tgz")
    assert commands[0][1:6] == ["install", "--global", "--prefix", str(prefix), "--min-release-age=0"]
    assert {"--build-from-source", "--ignore-scripts", "--loglevel=silly"} <= set(commands[0])
    assert not (destination / "stale").exists()
    assert json.loads((destination / "package.json").read_text())["name"] == "@earendil-works/pi-tui"


def test_fetch_refuses_bad_tag_or_reused_prefix_before_network(tmp_path: Path) -> None:
    """Reject floating tags and nonempty destinations before touching network or npm.

    Parameters:
        tmp_path (Path): private prefix and sentinel file.
    """
    with pytest.raises(ValueError, match="release tag"):
        fetch_release("main", tmp_path / "new", tmp_path)
    (tmp_path / "sentinel").write_text("do not overwrite")
    with pytest.raises(ValueError, match="must be empty"):
        fetch_release("v1.3.0-nredd.4", tmp_path, tmp_path)
