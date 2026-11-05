"""Prove native release staging never falls back to imported payloads or installs a helper.

References:
    https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations
"""

from __future__ import annotations

import io
import sys
import tarfile
from dataclasses import replace
from pathlib import Path

import pytest
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import npm_release as nr
import package_contracts as pc
import release_descriptors as rd

ROOT = Path(__file__).resolve().parents[2]


def test_native_staging(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Delete imported bytes before compilation and leave the source checkout untouched.

    Parameters:
        tmp_path (Path): Isolated fixture repository and scratch parent.
        monkeypatch (pytest.MonkeyPatch): Substitute the compiler and host platform.

    Returns:
        None: Imported payloads cannot survive a missing compiler output.
    """
    descriptor = rd.descriptor_for("@nredd/pi-computer-use")
    assert descriptor is not None
    workspace = tmp_path / descriptor.workspace
    workspace.mkdir(parents=True)
    (workspace / "package.json").write_text("{}")
    for relative in descriptor.native_artifacts:
        payload = workspace / relative
        payload.parent.mkdir(parents=True, exist_ok=True)
        payload.write_bytes(b"owner laptop")
    work = tmp_path / "scratch"
    work.mkdir()
    monkeypatch.setattr(sys, "platform", "darwin")
    calls: list[tuple[str, ...]] = []

    def compile_fixture(cwd: Path, *cmd: str, timeout: int) -> str:
        """Stand in for the compiler, requiring deletion before producing fresh bytes.

        Parameters:
            cwd (Path): Disposable source workspace.
            *cmd (str): Exact descriptor build invocation.
            timeout (int): Required build deadline.

        Returns:
            str: Synthetic compiler diagnostics.
        """
        assert timeout == 1200
        calls.append(cmd)
        for relative in descriptor.native_artifacts:
            assert not (cwd / relative).exists()
            (cwd / relative).write_bytes(b"compiled fixture")
        return "compiled"

    monkeypatch.setattr(nr, "command", compile_fixture)
    staged = nr.build_native_workspace(tmp_path, descriptor, work)
    assert calls == list(descriptor.native_build_commands)
    assert "--no-sign" in calls[0]
    for relative in descriptor.native_artifacts:
        assert (staged / relative).read_bytes() == b"compiled fixture"
        assert (workspace / relative).read_bytes() == b"owner laptop"
    # A nominally successful compiler which omits outputs must fail closed.
    monkeypatch.setattr(nr, "command", lambda *_args, **_kwargs: "success without outputs")
    other = tmp_path / "other"
    other.mkdir()
    with pytest.raises(nr.ReleaseError, match="Missing native artifact"):
        nr.build_native_workspace(tmp_path, descriptor, other)
    monkeypatch.setattr(sys, "platform", "linux")
    with pytest.raises(nr.ReleaseError, match="requires platform"):
        nr.build_native_workspace(tmp_path, descriptor, other)
    plain = replace(descriptor, native_build_commands=())
    assert nr.build_native_workspace(tmp_path, plain, other) == workspace


def test_native_check_packs_compiled_helpers(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Pack the real computer-use workspace with fresh Mach-O payloads, in process and via `main`.

    Parameters:
        tmp_path (Path): External artifact parents.
        monkeypatch (pytest.MonkeyPatch): Substitute only the Swift compiler and host platform.

    Returns:
        None: Both compiled architectures pass the packed contract; invalid destinations refuse.
    """
    descriptor = rd.descriptor_for("@nredd/pi-computer-use")
    assert descriptor is not None
    monkeypatch.setattr(sys, "platform", "darwin")
    compiled: list[Path] = []

    def compile_fixture(cwd: Path, *cmd: str, timeout: int) -> str:
        """Write thin 64-bit Mach-O headers for each architecture, as the real compiler would.

        Parameters:
            cwd (Path): Disposable staged workspace.
            *cmd (str): Descriptor build invocation.
            timeout (int): Required build deadline.

        Returns:
            str: Synthetic compiler diagnostics.
        """
        assert cmd == descriptor.native_build_commands[0]
        assert timeout == 1200
        for arch, cpu in pc.MACHO_CPU_TYPES.items():
            payload = cwd / "prebuilt/macos" / arch / "bridge"
            payload.write_bytes(pc.MACHO_MAGIC_64 + cpu.to_bytes(4, "little") + bytes(24))
            payload.chmod(0o755)
        compiled.append(cwd)
        return "compiled"

    monkeypatch.setattr(nr, "command", compile_fixture)
    output = tmp_path / "artifacts"
    nr.native_check(ROOT, output)
    assert len(compiled) == 1
    assert len(list(output.glob("nredd-pi-computer-use-*.tgz"))) == 1
    with pytest.raises(nr.ReleaseError, match="must be new and outside the checkout"):
        nr.native_check(ROOT, output)
    with pytest.raises(nr.ReleaseError, match="must be new and outside the checkout"):
        nr.native_check(ROOT, ROOT / "artifacts")
    assert nr.main(["native-check", "--repo-root", str(ROOT), "--artifact-dir", str(tmp_path / "cli")]) == 0
    monkeypatch.setattr(rd, "DESCRIPTORS", ())
    with pytest.raises(nr.ReleaseError, match="Missing computer-use descriptor"):
        nr.native_check(ROOT, tmp_path / "missing")


def test_packed_compiler_bytes(tmp_path: Path) -> None:
    """A swapped or stale payload cannot pass merely because its path is present.

    Parameters:
        tmp_path (Path): Disposable source and tarball parent.

    Returns:
        None: Only exact compiler bytes pass the packed-payload comparison.
    """
    descriptor = rd.descriptor_for("@nredd/pi-computer-use")
    assert descriptor is not None
    for relative in descriptor.native_artifacts:
        payload = tmp_path / relative
        payload.parent.mkdir(parents=True, exist_ok=True)
        payload.write_bytes(b"compiled")
    for data in (b"compiled", b"stale"):
        tarball = tmp_path / "candidate.tgz"
        with tarfile.open(tarball, "w:gz") as archive:
            for relative in descriptor.native_artifacts:
                member = tarfile.TarInfo(f"package/{relative}")
                member.size = len(data)
                archive.addfile(member, io.BytesIO(data))
        if data == b"compiled":
            nr.check_built_payloads(tmp_path, tarball, descriptor)
        else:
            with pytest.raises(nr.ReleaseError, match="differs from compiled"):
                nr.check_built_payloads(tmp_path, tarball, descriptor)


def test_build_attestation_credential_boundary() -> None:
    """Only the isolated attestor gets attestation write, and publish verifies the exact source.

    Returns:
        None: Build, attestation and publication permissions remain separated.
    """
    jobs = yaml.safe_load((ROOT / ".github/workflows/publish.yml").read_text())["jobs"]
    assert "macos-15" in jobs["verify"]["runs-on"]
    # `actions: read` lets the frozen-candidate evidence check read workflow runs.
    assert jobs["verify"]["permissions"] == {"contents": "read", "actions": "read"}
    attest = jobs["attest"]
    assert attest["needs"] == "verify"
    assert attest["permissions"] == {"contents": "read", "id-token": "write", "attestations": "write"}
    assert all("run" not in step for step in attest["steps"])
    assert all("checkout" not in step.get("uses", "") for step in attest["steps"])
    assert attest["steps"][-1]["with"]["subject-path"].endswith("/*.tgz")
    assert jobs["publish"]["needs"] == "attest"
    steps = jobs["publish"]["steps"]
    verify_index = next(i for i, step in enumerate(steps) if "gh attestation verify" in step.get("run", ""))
    publish_index = next(i for i, step in enumerate(steps) if step.get("run", "").startswith("npm publish"))
    assert verify_index < publish_index
    for flag in ("--source-ref", "--source-digest", "--signer-workflow", "--deny-self-hosted-runners"):
        assert flag in steps[verify_index]["run"]
    staging = yaml.safe_load((ROOT / ".github/workflows/native-helper.yml").read_text())
    assert staging["permissions"] == {"contents": "read"}
    assert staging["jobs"]["build"]["runs-on"] == "macos-15"
