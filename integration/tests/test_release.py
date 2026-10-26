"""Formula-equivalent release input, checksum and prebuild-selection tests, no binary execution.

References:
- https://github.com/nredd/homebrew-tap/blob/main/Formula/pi-coding-agent.rb
- https://docs.python.org/3/library/hashlib.html
"""

from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import shlex
import shutil
import subprocess
import sys
import tarfile
from collections.abc import Callable
from email.message import Message
from pathlib import Path
from types import MappingProxyType
from typing import Any
from urllib.error import HTTPError

import pytest

from harness import release
from harness.release import (
    ATTESTATION_WORKFLOW,
    GITHUB_TOKEN_VARIABLES,
    RELEASE_PACKAGES,
    AttestationRateLimitedError,
    attestation_bundle,
    fetch_release,
    gitlink_tag,
    prune_native,
    release_checksums,
    release_tarballs,
    verify_asset,
    verify_provenance,
    verify_public_attestation,
    verify_root_overrides,
)

# sha256 (frozen in `LEGACY_CHECKSUMS`) -> npm SRI sha512 of the same downloaded legacy tarball.
# Re-derive both from one download: `gh release download <tag> --repo nredd/pi -p <asset>`, then
# `shasum -a 256 <asset>` and `printf 'sha512-%s' "$(openssl dgst -sha512 -binary <asset> | base64)"`.
LOCK_INTEGRITY = {
    "16479a0cb393c7820d8b1fbcdc5c941ceb5a271dc64ecb4b8be6574df3a2e617": (
        "sha512-M7jiF/SqKQdUOlogM7SqXzNVNNtTCpF3CxA8/tWnvCv0sHT48SEbagIyj8oriBRglz4Q5lZMrjDgt6QJDky3Tg=="
    ),
    "dd8ac6c221bfd8e76fcc5b93418ba8feffd63dd705bde814aea6d4b1b46938e0": (
        "sha512-5eGojgZgCgakNg8GR19x+FS7PXGb0GLUllZEFJto9lUhKFXv5Z0u15UpWkvOyJmDiQ0EZXMyM2Xh75uA5a5FFw=="
    ),
    "e08bbd6b348a00eb97250ebfa33a722c70323b55a2d1e6f5b446513fcb5dad35": (
        "sha512-zXQEUNTFyIt1a7uus/b1TY/VRWh+P8IjupnqKda2v4TZC6WrbuYZ+3JosZWhOqbh6RP38aYhRH9kb4qn2EbMJQ=="
    ),
    "1b7ed741d704e0e288056630c1abc1a71eaec83eac148689c1d9b152361085b7": (
        "sha512-shL6PmzE7Dyb1dwGJ73leWPVu6zHis5lTs3o1NBaf5Z09oiG2VOYuIdBs0es66GxMAJ4z3mKILNogWx3+lRCWA=="
    ),
}


def checksums_for(tag: str, contents: bytes) -> dict[str, str]:
    """Record one digest for every package a new release must publish.

    Parameters:
        tag (str): new (non-legacy) release tag.
        contents (bytes): bytes served for every asset.

    Returns:
        dict[str, str]: asset URL -> sha256 for all `RELEASE_PACKAGES`.
    """
    base = f"https://github.com/nredd/pi/releases/download/{tag}/"
    return {
        base + f"earendil-works-{package}-1.3.0.tgz": hashlib.sha256(contents).hexdigest()
        for package in RELEASE_PACKAGES
    }


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


def test_verify_asset_fails_closed(tmp_path: Path) -> None:
    """Accept matching bytes only, refusing mismatches and unrecorded assets.

    Parameters:
        tmp_path (Path): private downloaded asset.
    """
    url = "https://github.com/nredd/pi/releases/download/v1.3.0-nredd.8/core.tgz"
    asset = tmp_path / "core.tgz"
    asset.write_bytes(b"actual bytes")
    sha = hashlib.sha256(asset.read_bytes()).hexdigest()
    verify_asset(asset, url, {url: sha})
    with pytest.raises(ValueError, match="mismatch"):
        verify_asset(asset, url, {url: "0" * 64})
    with pytest.raises(ValueError, match="No recorded release checksum"):
        verify_asset(asset, url + "missing", {url: sha})
    with pytest.raises(ValueError, match="No recorded release checksum"):
        verify_asset(asset, url, {})


def test_legacy_checksums_are_frozen_and_complete() -> None:
    """Freeze the legacy map and record every asset each legacy release shipped."""
    assert isinstance(release.LEGACY_CHECKSUMS, MappingProxyType)
    assert all(isinstance(assets, MappingProxyType) for assets in release.LEGACY_CHECKSUMS.values())
    core_only = {release.CODING_AGENT_TARBALL, release.TUI_TARBALL}
    for tag, assets in release.LEGACY_CHECKSUMS.items():
        expected = (
            core_only
            if tag in {"v1.3.0-nredd.3", "v1.3.0-nredd.7"}
            else core_only
            | {
                release.AGENT_CORE_TARBALL,
                release.AI_TARBALL,
            }
        )
        assert set(assets) == expected, tag


def test_legacy_checksums_are_the_recorded_urls() -> None:
    """Read the hard-coded legacy release identities as canonical asset URLs."""
    tag = "v1.3.0-nredd.6"
    checksums = release_checksums(tag)
    assert checksums == {
        f"https://github.com/nredd/pi/releases/download/{tag}/{name}": digest
        for name, digest in release.LEGACY_CHECKSUMS[tag].items()
    }
    assert release.LEGACY_CHECKSUMS[tag][release.CODING_AGENT_TARBALL] == (
        "0c1b9549cfed58c19f03b642cb259bf52f83beb1a339f154e5616c9b28c939b8"
    )
    assert release.LEGACY_CHECKSUMS[tag][release.TUI_TARBALL] == (
        "dd8ac6c221bfd8e76fcc5b93418ba8feffd63dd705bde814aea6d4b1b46938e0"
    )


def test_release_checksums_require_release_file_except_named_legacy(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Trust only committed legacy identities or a strict release `SHA256SUMS` file.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): replace release checksum download.
    """
    tag = "v1.3.0-nredd.8"
    base = f"https://github.com/nredd/pi/releases/download/{tag}/"
    monkeypatch.setattr(
        release,
        "urlopen",
        lambda url, **kwargs: io.BytesIO(f"{'a' * 64}  earendil-works-pi-coding-agent-1.3.0.tgz\n".encode()),
    )
    assert release_checksums(tag) == {base + "earendil-works-pi-coding-agent-1.3.0.tgz": "a" * 64}
    monkeypatch.setattr(release, "urlopen", lambda url, **kwargs: io.BytesIO(b"not a checksum\n"))
    with pytest.raises(ValueError, match="Invalid"):
        release_checksums(tag)


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

    gh_bin = tmp_path / "gh"
    gh_bin.touch()
    monkeypatch.setattr(release, "GH_BIN", str(gh_bin))
    monkeypatch.setattr(subprocess, "check_output", gh)
    verify_provenance(artifact, "v1.3.0-nredd.8")
    assert calls == [
        [
            str(gh_bin),
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


@pytest.mark.parametrize("missing_gh", [True, False])
def test_fetch_aborts_when_provenance_cannot_verify(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, missing_gh: bool
) -> None:
    """Stop new-release installation before npm when provenance verification fails.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): replace checksum, download, and CLI operations.
        tmp_path (Path): isolated release prefix and binaries.
        missing_gh (bool): simulate an absent CLI or a failed verification command.
    """
    tag = "v1.3.0-nredd.8"
    contents = b"core release bytes"
    checksums = checksums_for(tag, contents)
    npm_bin = tmp_path / "npm"
    npm_bin.touch()
    npm_calls: list[list[str]] = []
    monkeypatch.setattr(release, "NPM_BIN", str(npm_bin))
    monkeypatch.setattr(release, "release_checksums", lambda *_: checksums)
    monkeypatch.setattr(release, "urlopen", lambda *_args, **_kwargs: io.BytesIO(contents))
    if missing_gh:
        monkeypatch.setattr(release, "GH_BIN", str(tmp_path / "missing-gh"))
        error = FileNotFoundError
    else:
        gh_bin = tmp_path / "gh"
        gh_bin.touch()
        monkeypatch.setattr(release, "GH_BIN", str(gh_bin))

        def gh_fails(argv: list[str], **_kwargs: Any) -> str:
            """Fail provenance verification, recording any npm install that follows.

            Parameters:
                argv (list[str]): GitHub CLI or npm command.
                **_kwargs (Any): subprocess options.

            Raises:
                subprocess.CalledProcessError: always.
            """
            if argv[0] == str(npm_bin):
                npm_calls.append(argv)
            raise subprocess.CalledProcessError(1, argv, output="bad provenance")

        monkeypatch.setattr(subprocess, "check_output", gh_fails)
        error = RuntimeError
    prefix = tmp_path / "prefix"
    with pytest.raises(error, match=r"provenance|requires `gh`"):
        fetch_release(tag, prefix)
    assert npm_calls == []
    assert not (prefix / "lib").exists()
    assert not (prefix / "bin").exists()


def test_legacy_fetch_enforces_checksum_without_provenance(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Reject bad legacy bytes before attempting provenance verification.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): serve wrong release bytes and record provenance calls.
        tmp_path (Path): isolated release prefix.
    """
    provenance: list[tuple[Path, str]] = []
    monkeypatch.setattr(release, "urlopen", lambda *_args, **_kwargs: io.BytesIO(b"wrong bytes"))
    monkeypatch.setattr(release, "verify_provenance", lambda path, tag: provenance.append((path, tag)))
    with pytest.raises(ValueError, match="checksum mismatch"):
        fetch_release("v1.3.0-nredd.7", tmp_path / "prefix")
    assert provenance == []


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

    tag = "v1.3.0-nredd.8"
    checksums = checksums_for(tag, tarball)
    provenance: list[tuple[Path, str]] = []
    npm_bin = tmp_path / "npm"
    npm_bin.touch()
    monkeypatch.setattr(release, "urlopen", download)
    monkeypatch.setattr(release, "release_checksums", lambda *_: checksums)
    monkeypatch.setattr(
        release, "verify_provenance", lambda path, release_tag: provenance.append((path, release_tag))
    )
    monkeypatch.setattr(release, "NPM_BIN", str(npm_bin))
    monkeypatch.setattr(subprocess, "check_output", npm)
    binary = fetch_release(tag, prefix)
    assert binary == prefix / "bin/pi"
    assert [url.rsplit("/", 1)[1] for url in urls] == [
        f"earendil-works-{p}-1.3.0.tgz" for p in RELEASE_PACKAGES
    ]
    assert provenance == [(prefix / f"earendil-works-{p}-1.3.0.tgz", tag) for p in RELEASE_PACKAGES]
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
        fetch_release("main", tmp_path / "new")
    (tmp_path / "sentinel").write_text("do not overwrite")
    with pytest.raises(ValueError, match="must be empty"):
        fetch_release("v1.3.0-nredd.4", tmp_path)


@pytest.mark.parametrize("stage", ["provenance", "npm"])
def test_subprocess_timeouts_become_chained_runtime_errors(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, stage: str
) -> None:
    """Turn a hung `gh` or `npm` into a `RuntimeError` chained from `TimeoutExpired`.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): make the chosen subprocess time out.
        tmp_path (Path): isolated prefix and fake binaries.
        stage (str): which subprocess hangs.
    """
    gh_bin = tmp_path / "gh"
    gh_bin.touch()
    npm_bin = tmp_path / "npm"
    npm_bin.touch()
    monkeypatch.setattr(release, "GH_BIN", str(gh_bin))
    monkeypatch.setattr(release, "NPM_BIN", str(npm_bin))

    def hang(argv: list[str], **kwargs: Any) -> str:
        """Time out the targeted command, succeeding for the other one.

        Parameters:
            argv (list[str]): GitHub CLI or npm command.
            **kwargs (Any): subprocess options.

        Returns:
            str: simulated success output.

        Raises:
            subprocess.TimeoutExpired: the targeted command hung, with partial bytes output.
        """
        if (argv[0] == str(gh_bin)) == (stage == "provenance"):
            raise subprocess.TimeoutExpired(argv, kwargs["timeout"], output=b"partial \xff output")
        return "ok"

    monkeypatch.setattr(subprocess, "check_output", hang)
    tag = "v1.3.0-nredd.8"
    contents = b"core"
    monkeypatch.setattr(release, "release_checksums", lambda *_: checksums_for(tag, contents))
    monkeypatch.setattr(release, "urlopen", lambda *_args, **_kwargs: io.BytesIO(contents))
    with pytest.raises(RuntimeError, match=r"partial .* output") as caught:
        fetch_release(tag, tmp_path / "prefix")
    assert isinstance(caught.value.__cause__, subprocess.TimeoutExpired)
    if stage == "provenance":
        assert "provenance" in str(caught.value)
    else:
        assert "npm installation" in str(caught.value)


def test_error_tail_keeps_last_6000_characters() -> None:
    """Decode bytes and truncate to the tail, tolerating absent output."""
    long = "x" * 7000 + "tail"
    assert release._error_tail(subprocess.CalledProcessError(1, "gh", output=long)) == long[-6000:]
    assert release._error_tail(subprocess.TimeoutExpired("gh", 1, output=b"bytes")) == "bytes"
    assert release._error_tail(subprocess.TimeoutExpired("gh", 1)) == ""


def test_new_release_must_publish_every_consumed_asset(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Refuse a new release whose `SHA256SUMS` omits `pi-agent-core` or `pi-ai`.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): serve an incomplete checksum set.
        tmp_path (Path): isolated prefix.
    """
    tag = "v1.3.0-nredd.8"
    checksums = {url: digest for url, digest in checksums_for(tag, b"x").items() if "pi-ai" not in url}
    monkeypatch.setattr(release, "release_checksums", lambda *_: checksums)
    with pytest.raises(ValueError, match=r"No recorded release checksum.*pi-ai"):
        fetch_release(tag, tmp_path / "prefix")


@pytest.mark.parametrize("tag", sorted(release.LEGACY_RELEASE_TAGS))
def test_legacy_fetch_verifies_exactly_the_recorded_assets(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, tag: str
) -> None:
    """Download and checksum every recorded legacy asset, and nothing else.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): serve per-asset bytes and stub installation.
        tmp_path (Path): isolated prefix.
        tag (str): legacy release.
    """
    recorded = release_checksums(tag)
    payloads = {url: url.encode() for url in recorded}
    seen: list[str] = []

    def download(url: str, **_kwargs: Any) -> io.BytesIO:
        """Record the request and serve that asset's bytes.

        Parameters:
            url (str): asset URL.
            **_kwargs (Any): network options.

        Returns:
            io.BytesIO: the asset's bytes.
        """
        seen.append(url)
        return io.BytesIO(payloads[url])

    def install(*_args: Any, **_kwargs: Any) -> None:
        """Stop after verification; installation is covered elsewhere.

        Parameters:
            *_args (Any): ignored.
            **_kwargs (Any): ignored.

        Raises:
            _Installed: always.
        """
        raise _Installed

    monkeypatch.setattr(
        release,
        "release_checksums",
        lambda _tag: {url: hashlib.sha256(data).hexdigest() for url, data in payloads.items()},
    )
    npm_bin = tmp_path / "npm"
    npm_bin.touch()
    monkeypatch.setattr(release, "NPM_BIN", str(npm_bin))
    monkeypatch.setattr(release, "urlopen", download)
    monkeypatch.setattr(release.subprocess, "check_output", install)
    with pytest.raises(_Installed):
        fetch_release(tag, tmp_path / "prefix")
    assert sorted(seen) == sorted(recorded)


@pytest.mark.parametrize("tag", sorted(release.LEGACY_RELEASE_TAGS))
def test_legacy_fetch_rejects_a_wrong_asset(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, tag: str
) -> None:
    """Serve wrong bytes for the last recorded asset; `fetch_release` must abort before npm.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): serve per-asset bytes and trap installation.
        tmp_path (Path): isolated prefix.
        tag (str): legacy release.
    """
    recorded = list(release_checksums(tag))
    payloads = {url: url.encode() for url in recorded}

    def download(url: str, **_kwargs: Any) -> io.BytesIO:
        """Serve the asset's bytes, corrupting the last one.

        Parameters:
            url (str): asset URL.
            **_kwargs (Any): network options.

        Returns:
            io.BytesIO: the asset's bytes, or wrong bytes for the last asset.
        """
        return io.BytesIO(b"wrong" if url == recorded[-1] else payloads[url])

    def install(*_args: Any, **_kwargs: Any) -> None:
        """Fail the test if installation is reached.

        Parameters:
            *_args (Any): ignored.
            **_kwargs (Any): ignored.
        """
        pytest.fail("npm install reached despite a checksum mismatch")

    npm_bin = tmp_path / "npm"
    npm_bin.touch()
    monkeypatch.setattr(release, "NPM_BIN", str(npm_bin))
    monkeypatch.setattr(
        release,
        "release_checksums",
        lambda _tag: {url: hashlib.sha256(data).hexdigest() for url, data in payloads.items()},
    )
    monkeypatch.setattr(release, "urlopen", download)
    monkeypatch.setattr(release.subprocess, "check_output", install)
    with pytest.raises(ValueError, match="checksum mismatch"):
        fetch_release(tag, tmp_path / "prefix")


class _Installed(Exception):
    """Raised by the stubbed installer once every asset verified."""


def test_root_overrides_stay_tied_to_verified_legacy_releases() -> None:
    """npm resolves the root overrides from the lockfile, NOT through `fetch_release`.

    Each override tarball is covered only by the lockfile's sha512. Require every nredd/pi
    override to name a legacy release, match the lockfile `resolved` URL, and carry an
    `integrity` equal to the sha512 of the very bytes whose sha256 `LEGACY_CHECKSUMS` records,
    so the two verification paths cannot silently diverge. Moving an override to a new tag
    means migrating it onto `fetch_release`'s `SHA256SUMS` plus provenance path first.
    """
    root = Path(__file__).resolve().parents[2]
    overrides = json.loads((root / "package.json").read_text())["overrides"]
    lock = json.loads((root / "package-lock.json").read_text())["packages"]
    prefix = "https://github.com/nredd/pi/releases/download/"
    pinned = {name: url for name, url in overrides.items() if isinstance(url, str) and url.startswith(prefix)}
    assert set(pinned) == {f"@earendil-works/{package}" for package in RELEASE_PACKAGES}
    for name, url in pinned.items():
        tag, asset = url.removeprefix(prefix).split("/")
        assert tag in release.LEGACY_RELEASE_TAGS, f"{name} moved to {tag}: verify it before changing"
        assert asset in release.LEGACY_CHECKSUMS[tag], f"{name}: {tag} never shipped {asset}"
        sha256 = release.LEGACY_CHECKSUMS[tag][asset]
        entry = lock[f"node_modules/{name}"]
        assert entry["resolved"] == url
        assert entry["integrity"] == LOCK_INTEGRITY[sha256]


def serve_attestations(monkeypatch: pytest.MonkeyPatch, outcome: bytes | int) -> list[str]:
    """Answer the attestations API with a body or an HTTP status, recording requests.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): module patcher.
        outcome (bytes | int): response body, or an HTTP error status.

    Returns:
        list[str]: requested URLs; each request is also checked to carry no credentials.
    """
    requests: list[str] = []

    def fake_urlopen(request: Any, timeout: int) -> io.BytesIO:
        """Serve the configured outcome.

        Parameters:
            request (Any): `urllib.request.Request`.
            timeout (int): seconds.

        Returns:
            io.BytesIO: the body.

        Raises:
            HTTPError: the configured status.
        """
        requests.append(request.full_url)
        assert not request.has_header("Authorization")
        if isinstance(outcome, int):
            raise HTTPError(request.full_url, outcome, "refused", Message(), None)
        return io.BytesIO(outcome)

    monkeypatch.setattr(release, "urlopen", fake_urlopen)
    return requests


def test_attestation_bundle_writes_every_bundle_anonymously(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Bundles are looked up by the artifact digest, without credentials, one JSON line each."""
    artifact = tmp_path / "a.json"
    artifact.write_bytes(b"snapshot")
    body = json.dumps({"attestations": [{"bundle": {"n": 1}}, {"bundle": {"n": 2}}]}).encode()
    requests = serve_attestations(monkeypatch, body)
    bundle = attestation_bundle("o/r", artifact, tmp_path / "b.jsonl")
    digest = hashlib.sha256(b"snapshot").hexdigest()
    assert requests == [f"https://api.github.com/repos/o/r/attestations/sha256:{digest}"]
    assert [json.loads(line) for line in bundle.read_text().splitlines()] == [{"n": 1}, {"n": 2}]


@pytest.mark.parametrize(
    ("outcome", "error"),
    [
        (403, AttestationRateLimitedError),
        (429, AttestationRateLimitedError),
        (404, RuntimeError),
        (b'{"attestations": []}', RuntimeError),
        (b"not json", RuntimeError),
    ],
)
def test_attestation_bundle_failures(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, outcome: bytes | int, error: type[Exception]
) -> None:
    """Rate limits are distinguishable; every other failure is a plain verification error."""
    artifact = tmp_path / "a.json"
    artifact.write_bytes(b"snapshot")
    serve_attestations(monkeypatch, outcome)
    with pytest.raises(error) as caught:
        attestation_bundle("o/r", artifact, tmp_path / "b.jsonl")
    assert (type(caught.value) is AttestationRateLimitedError) == (error is AttestationRateLimitedError)


@pytest.mark.parametrize(
    ("outcome", "with_bundle"), [(b'{"attestations":[{"bundle":{}}]}', True), (403, False)]
)
def test_public_attestation_falls_back_to_gh_login_only_when_rate_limited(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, outcome: bytes | int, with_bundle: bool
) -> None:
    """The anonymous bundle is preferred; only a rate limit hands the lookup to `gh` itself."""
    artifact = tmp_path / "a.json"
    artifact.write_bytes(b"snapshot")
    serve_attestations(monkeypatch, outcome)
    calls: list[tuple[list[str], dict[str, str] | None]] = []
    gh_bin = tmp_path / "gh"
    gh_bin.touch()
    monkeypatch.setattr(release, "GH_BIN", str(gh_bin))
    monkeypatch.setenv("GH_TOKEN", "ghp_sentinel-not-a-real-token")
    monkeypatch.setattr(
        subprocess, "check_output", lambda argv, **kwargs: calls.append((argv, kwargs["env"])) or ""
    )
    verify_public_attestation(artifact, "o/r", "o/r/.github/workflows/w.yml", "refs/heads/main")
    ((argv, env),) = calls
    assert ("--bundle" in argv) == with_bundle
    # The bundle path needs no API call, so `gh` only inherits a token for the login fallback.
    if with_bundle:
        assert env is not None
        assert not GITHUB_TOKEN_VARIABLES & set(env)
        assert "ghp_sentinel-not-a-real-token" not in env.values()
    else:
        assert env is None
    assert argv[argv.index("--signer-workflow") + 1] == "o/r/.github/workflows/w.yml"
    assert argv[argv.index("--source-ref") + 1] == "refs/heads/main"
    assert "--deny-self-hosted-runners" in argv


def test_fetch_release_binds_bytes_to_explicit_checksums(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Explicit digests (the installer's snapshot) win over a re-read `SHA256SUMS`, before npm runs."""
    tag = "v1.3.0-nredd.8"
    served = b"republished bytes"
    monkeypatch.setattr(release, "urlopen", lambda *_args, **_kwargs: io.BytesIO(served))
    monkeypatch.setattr(release, "release_checksums", lambda *_: checksums_for(tag, served))
    monkeypatch.setattr(release, "verify_provenance", lambda path, release_tag: None)
    npm_bin = tmp_path / "npm"
    npm_bin.touch()
    monkeypatch.setattr(release, "NPM_BIN", str(npm_bin))
    npm_calls: list[list[str]] = []
    monkeypatch.setattr(subprocess, "check_output", lambda argv, **kwargs: npm_calls.append(argv) or "")
    with pytest.raises(ValueError, match="checksum mismatch"):
        fetch_release(tag, tmp_path / "prefix", checksums=checksums_for(tag, b"snapshot bytes"))
    assert npm_calls == []


def test_release_tarballs_names_installed_assets_first() -> None:
    """The first two names are the coding-agent and tui tarballs `fetch_release` installs."""
    assert release_tarballs("v1.3.0-nredd.8")[:2] == [
        "earendil-works-pi-coding-agent-1.3.0.tgz",
        "earendil-works-pi-tui-1.3.0.tgz",
    ]
    with pytest.raises(ValueError, match="Not a core fork release tag"):
        release_tarballs("main")


NEW_TAG = "v1.3.0-nredd.8"
NEW_BYTES = b"new core release bytes"


def sri(contents: bytes) -> str:
    """Return the npm SRI sha512 of bytes.

    Parameters:
        contents (bytes): tarball bytes.

    Returns:
        str: `sha512-<base64>`.
    """
    return "sha512-" + base64.b64encode(hashlib.sha512(contents).digest()).decode("ascii")


def write_root(root: Path, tag: str = NEW_TAG, contents: bytes = NEW_BYTES) -> dict[str, str]:
    """Write a root `package.json` and lockfile pinning all four core overrides.

    Parameters:
        root (Path): repository root fixture.
        tag (str): core tag every override names.
        contents (bytes): bytes whose sha512 the lock records.

    Returns:
        dict[str, str]: override name -> URL.
    """
    urls = {f"@earendil-works/{package}": url for package, url in release.release_package_urls(tag).items()}
    (root / "package.json").write_text(json.dumps({"overrides": urls}))
    packages = {
        f"node_modules/{name}": {"resolved": url, "integrity": sri(contents)} for name, url in urls.items()
    }
    (root / "package-lock.json").write_text(json.dumps({"packages": packages}))
    return urls


Edit = Callable[[dict[str, Any]], object]


def merge_at(*path: str, values: dict[str, Any]) -> Edit:
    """Build a fixture edit that merges `values` into the JSON object at `path`.

    Parameters:
        *path (str): keys leading from the document root to the object to extend.
        values (dict[str, Any]): entries to add or replace.

    Returns:
        Edit: callable mutating a parsed document in place.
    """

    def edit(document: dict[str, Any]) -> None:
        """Merge entries into the targeted fixture object.

        Parameters:
            document (dict[str, Any]): parsed fixture to mutate.
        """
        target = document
        for key in path:
            target = target[key]
        target |= values

    return edit


def rewrite(path: Path, edit: Edit) -> None:
    """Apply an in-place edit to a JSON fixture.

    Parameters:
        path (Path): JSON file.
        edit (Edit): callable mutating the parsed document.
    """
    document = json.loads(path.read_text())
    edit(document)
    path.write_text(json.dumps(document))


@pytest.fixture
def new_release(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> tuple[Path, list[list[str]]]:
    """Serve a non-legacy release offline, recording each `gh` invocation.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): replace checksums, download and `gh`.
        tmp_path (Path): root fixture parent.

    Returns:
        tuple[Path, list[list[str]]]: fixture root and recorded `gh` commands.
    """
    root = tmp_path / "root"
    root.mkdir()
    write_root(root)
    gh_bin = tmp_path / "gh"
    gh_bin.touch()
    gh_calls: list[list[str]] = []
    monkeypatch.setattr(release, "GH_BIN", str(gh_bin))
    monkeypatch.setattr(release, "release_checksums", lambda tag: checksums_for(tag, NEW_BYTES))
    monkeypatch.setattr(release, "urlopen", lambda *_a, **_k: io.BytesIO(NEW_BYTES))
    monkeypatch.setattr(subprocess, "check_output", lambda argv, **_k: gh_calls.append(argv) or "ok")
    return root, gh_calls


def test_root_override_gate_passes_all_four_with_exact_provenance(
    new_release: tuple[Path, list[list[str]]],
) -> None:
    """Verify every override's checksum, lock sha512 and provenance at the exact tag."""
    root, gh_calls = new_release
    verify_root_overrides(root)
    assert len(gh_calls) == len(RELEASE_PACKAGES)
    for call in gh_calls:
        assert call[1:3] == ["attestation", "verify"]
        assert call[call.index("--signer-workflow") + 1] == ATTESTATION_WORKFLOW
        assert call[call.index("--source-ref") + 1] == f"refs/tags/{NEW_TAG}"
        assert "--deny-self-hosted-runners" in call


def test_root_override_gate_rejects_resolved_url_mismatch_before_any_download(
    monkeypatch: pytest.MonkeyPatch, new_release: tuple[Path, list[list[str]]]
) -> None:
    """A lock that resolves elsewhere than the override fails without touching the network."""
    root, gh_calls = new_release

    def forbidden(*_args: Any, **_kwargs: Any) -> None:
        """Fail if the gate downloads anything.

        Parameters:
            *_args (Any): ignored positional arguments.
            **_kwargs (Any): ignored keyword arguments.

        Raises:
            AssertionError: always.
        """
        raise AssertionError("downloaded before the lockfile agreed")

    monkeypatch.setattr(release, "urlopen", forbidden)
    rewrite(
        root / "package-lock.json",
        merge_at(
            "packages",
            "node_modules/@earendil-works/pi-ai",
            values={"resolved": "https://registry.npmjs.org/@earendil-works/pi-ai/-/pi-ai-1.3.0.tgz"},
        ),
    )
    with pytest.raises(ValueError, match=r"`resolved` for '@earendil-works/pi-ai'"):
        verify_root_overrides(root)
    assert gh_calls == []


@pytest.mark.parametrize("breakage", ["missing_entry", "no_packages", "no_integrity", "weak_integrity"])
def test_root_override_gate_rejects_missing_or_weak_lock_metadata(
    new_release: tuple[Path, list[list[str]]], breakage: str
) -> None:
    """Missing `packages` metadata or a non-sha512 integrity can never pass."""
    root, _ = new_release
    lock = root / "package-lock.json"
    key = "node_modules/@earendil-works/pi-tui"
    edits: dict[str, Edit] = {
        "missing_entry": lambda doc: doc["packages"].pop(key),
        "no_packages": lambda doc: doc.pop("packages"),
        "no_integrity": lambda doc: doc["packages"][key].pop("integrity"),
        "weak_integrity": merge_at("packages", key, values={"integrity": "sha1-AAAA"}),
    }
    rewrite(lock, edits[breakage])
    with pytest.raises(ValueError, match=r"packages|integrity"):
        verify_root_overrides(root)


def test_root_override_gate_rejects_sha512_mismatch_with_matching_sha256(
    new_release: tuple[Path, list[list[str]]],
) -> None:
    """Bytes recorded by `SHA256SUMS` must also equal the lockfile's sha512."""
    root, _ = new_release
    rewrite(
        root / "package-lock.json",
        merge_at("packages", "node_modules/@earendil-works/pi-ai", values={"integrity": sri(b"other")}),
    )
    with pytest.raises(ValueError, match=r"integrity` mismatch for '@earendil-works/pi-ai'"):
        verify_root_overrides(root)


def test_root_override_gate_rejects_altered_tarball_bytes(
    monkeypatch: pytest.MonkeyPatch, new_release: tuple[Path, list[list[str]]]
) -> None:
    """Served bytes that differ from the recorded sha256 fail before provenance."""
    root, gh_calls = new_release
    monkeypatch.setattr(release, "urlopen", lambda *_a, **_k: io.BytesIO(NEW_BYTES + b"tampered"))
    with pytest.raises(ValueError, match="Release checksum mismatch"):
        verify_root_overrides(root)
    assert gh_calls == []


def test_root_override_gate_rejects_altered_legacy_bytes(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Frozen legacy sha256 values still bind the bytes; nothing is skipped for legacy tags."""
    write_root(tmp_path, "v1.3.0-nredd.6")
    monkeypatch.setattr(release, "urlopen", lambda *_a, **_k: io.BytesIO(b"altered"))
    monkeypatch.setattr(release, "verify_provenance", lambda *_a: pytest.fail("legacy has no provenance"))
    with pytest.raises(ValueError, match="Release checksum mismatch"):
        verify_root_overrides(tmp_path)


@pytest.mark.parametrize("missing_gh", [True, False])
def test_root_override_gate_fails_on_provenance_failure_or_missing_gh(
    monkeypatch: pytest.MonkeyPatch,
    new_release: tuple[Path, list[list[str]]],
    tmp_path: Path,
    missing_gh: bool,
) -> None:
    """A non-legacy tag without verifiable provenance, or without `gh`, is a hard failure."""
    root, _ = new_release
    if missing_gh:
        monkeypatch.setattr(release, "GH_BIN", str(tmp_path / "absent-gh"))
        with pytest.raises(FileNotFoundError, match="requires `gh`"):
            verify_root_overrides(root)
        return

    def refuse(argv: list[str], **_kwargs: Any) -> str:
        """Simulate `gh attestation verify` rejecting the artifact.

        Parameters:
            argv (list[str]): GitHub CLI command.
            **_kwargs (Any): ignored subprocess options.

        Raises:
            subprocess.CalledProcessError: always.
        """
        raise subprocess.CalledProcessError(1, argv, output="no matching attestation")

    monkeypatch.setattr(subprocess, "check_output", refuse)
    with pytest.raises(RuntimeError, match=r"provenance verification failed.*no matching attestation"):
        verify_root_overrides(root)


def test_root_override_gate_requires_every_core_asset_in_sha256sums(
    monkeypatch: pytest.MonkeyPatch, new_release: tuple[Path, list[list[str]]]
) -> None:
    """A new tag whose `SHA256SUMS` omits one of the four assets is rejected."""
    root, _ = new_release
    partial = dict(list(checksums_for(NEW_TAG, NEW_BYTES).items())[:-1])
    monkeypatch.setattr(release, "release_checksums", lambda _tag: partial)
    with pytest.raises(ValueError, match="does not publish checksums"):
        verify_root_overrides(root)


@pytest.mark.parametrize("breakage", ["extra", "missing", "blanket", "foreign_url", "wrong_asset", "nested"])
def test_root_override_gate_rejects_unexpected_override_shapes(
    new_release: tuple[Path, list[list[str]]], breakage: str
) -> None:
    """No extra, blanket, foreign or mismatched override and no nested lock copy is tolerated."""
    root, _ = new_release
    url = release.release_package_urls(NEW_TAG)["pi-tui"]
    edits: dict[str, Edit] = {
        "extra": merge_at("overrides", values={"@earendil-works/pi-mcp": url}),
        "missing": lambda doc: doc["overrides"].pop("@earendil-works/pi-tui"),
        "blanket": merge_at("overrides", values={"@earendil-works/pi-tui": {".": url}}),
        "foreign_url": merge_at(
            "overrides", values={"@earendil-works/pi-tui": "https://example.com/pi-tui.tgz"}
        ),
        "wrong_asset": merge_at(
            "overrides",
            values={"@earendil-works/pi-tui": release.release_package_urls(NEW_TAG)["pi-ai"]},
        ),
    }
    if breakage == "nested":
        rewrite(
            root / "package-lock.json",
            merge_at(
                "packages",
                values={
                    "node_modules/x/node_modules/@earendil-works/pi-tui": {"resolved": "https://e/x.tgz"}
                },
            ),
        )
        match = "Nested lock entries"
    else:
        rewrite(root / "package.json", edits[breakage])
        match = "overrides|Override"
    with pytest.raises(ValueError, match=match):
        verify_root_overrides(root)


def test_root_override_gate_runs_before_install_and_blocks_it(tmp_path: Path) -> None:
    """`make install` verifies first: a bad lock stops it before `npm` or `uv` ever run."""
    root = tmp_path / "root"
    root.mkdir()
    shutil.copy(Path(__file__).resolve().parents[2] / "Makefile", root / "Makefile")
    (root / "integration").symlink_to(Path(__file__).resolve().parents[1])
    write_root(root, "v1.3.0-nredd.6")
    rewrite(
        root / "package-lock.json",
        merge_at("packages", "node_modules/@earendil-works/pi-ai", values={"resolved": "https://e/x.tgz"}),
    )
    commands, marker = tmp_path / "commands", tmp_path / "ran"
    commands.mkdir()
    for tool in ("npm", "uv"):
        (commands / tool).write_text(f"#!/bin/sh\necho {shlex.quote(tool)} >> {shlex.quote(str(marker))}\n")
        (commands / tool).chmod(0o755)
    env = os.environ | {"PATH": f"{commands}{os.pathsep}{os.environ['PATH']}"}
    completed = subprocess.run(
        ["make", "install"], cwd=root, env=env, capture_output=True, text=True, check=False
    )
    assert completed.returncode != 0
    assert "Root core override verification failed" in completed.stderr
    assert not marker.exists()


def test_make_install_hides_token_from_installers_but_not_preflight(tmp_path: Path) -> None:
    """Only the preflight sees `GH_TOKEN`; `npm ci` and `uv sync` run without it."""
    root = tmp_path / "root"
    root.mkdir()
    shutil.copy(Path(__file__).resolve().parents[2] / "Makefile", root / "Makefile")
    (root / "integration").symlink_to(Path(__file__).resolve().parents[1])
    (root / "benchmarks" / "comparison").mkdir(parents=True)
    commands, log = tmp_path / "commands", tmp_path / "seen"
    commands.mkdir()
    for tool in ("python3", "npm", "uv"):
        (commands / tool).write_text(
            f'#!/bin/sh\necho "{tool}=${{GH_TOKEN:-unset}}" >> {shlex.quote(str(log))}\n'
        )
        (commands / tool).chmod(0o755)
    env = os.environ | {"PATH": f"{commands}{os.pathsep}{os.environ['PATH']}", "GH_TOKEN": "fixture-token"}
    completed = subprocess.run(
        ["make", "install"], cwd=root, env=env, capture_output=True, text=True, check=False
    )
    assert completed.returncode == 0, completed.stderr
    assert log.read_text().splitlines() == [
        "python3=fixture-token",
        "npm=unset",
        "uv=unset",
        "uv=unset",
    ]


def test_cli_verify_flag_reports_failure_and_rejects_prefix(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The CLI exits with the failure text and refuses the fetch-only `--prefix`."""
    monkeypatch.setattr(sys, "argv", ["release", "--verify-root-overrides", "--root", str(tmp_path)])
    with pytest.raises(SystemExit, match="Root core override verification failed"):
        release.main()
    monkeypatch.setattr(sys, "argv", ["release", "--verify-root-overrides", "--prefix", str(tmp_path)])
    with pytest.raises(SystemExit) as caught:
        release.main()
    assert caught.value.code == 2
