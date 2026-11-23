"""Prove native release staging never falls back to imported payloads or installs a helper.

References:
    https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations
"""

from __future__ import annotations

import io
import json
import shutil
import subprocess
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
COMPUTER_USE = ROOT / "packages/computer-use"
HELPER_BUILD = "src/platform/macos/helper-build.mjs"


def node_helper_build(package: Path) -> str:
    """Compute a package's helper build identity with the real `macosHelperBuild`.

    Parameters:
        package (Path): Package root holding `package.json`, `helper-build.mjs` and the Swift sources.

    Returns:
        str: The identity the client expects from that package's helper.
    """
    node = shutil.which("node")
    assert node is not None, "node is required"
    script = (
        "const [module, root] = process.argv.slice(1);"
        "const { macosHelperBuild } = await import(module);"
        "process.stdout.write(macosHelperBuild(root));"
    )
    module = (package / HELPER_BUILD).as_uri()
    return subprocess.run(
        [node, "--input-type=module", "-e", script, module, str(package)],
        check=True,
        capture_output=True,
        text=True,
        timeout=60,
    ).stdout


def helper(arch: str, *literals: bytes) -> bytes:
    """Build a thin Mach-O header followed by NUL-delimited string literals, as `swiftc` lays them out.

    Parameters:
        arch (str): `arm64` or `x64`.
        *literals (bytes): Embedded C strings.

    Returns:
        bytes: Helper bytes.
    """
    cpu = pc.MACHO_CPU_TYPES["arm64" if arch == "arm64" else "x64"]
    header = pc.MACHO_MAGIC_64 + cpu.to_bytes(4, "little") + bytes(24)
    return header + b"".join(literal + b"\0" for literal in literals)


def write_tarball(path: Path, members: dict[str, bytes]) -> Path:
    """Write an npm-shaped tarball holding `members` under `package/`.

    Parameters:
        path (Path): Destination.
        members (dict[str, bytes]): Package-relative path to content.

    Returns:
        Path: `path`.
    """
    with tarfile.open(path, "w:gz") as archive:
        for name, data in members.items():
            member = tarfile.TarInfo(f"package/{name}")
            member.size, member.mode = len(data), 0o755
            archive.addfile(member, io.BytesIO(data))
    return path


def package_members(package: Path) -> dict[str, bytes]:
    """Collect the files the build identity reads from a package root.

    Parameters:
        package (Path): Package root.

    Returns:
        dict[str, bytes]: Package-relative path to content.
    """
    names = ["package.json", HELPER_BUILD]
    names += [
        f"native/macos/{name}"
        for name in pc.parse_helper_source_list(HELPER_BUILD, (package / HELPER_BUILD).read_text())
    ]
    return {name: (package / name).read_bytes() for name in names}


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
        None: Both compiled architectures pass the packed contract and build identity; a helper
            reporting another build and invalid destinations refuse.
    """
    descriptor = rd.descriptor_for("@nredd/pi-computer-use")
    assert descriptor is not None
    monkeypatch.setattr(sys, "platform", "darwin")
    compiled: list[Path] = []

    def compile_fixture(cwd: Path, *cmd: str, timeout: int) -> str:
        """Write thin 64-bit Mach-O headers holding the packed build identity, as the real compiler would.

        Parameters:
            cwd (Path): Disposable staged workspace.
            *cmd (str): Descriptor build invocation.
            timeout (int): Required build deadline.

        Returns:
            str: Synthetic compiler diagnostics.
        """
        assert cmd == descriptor.native_build_commands[0]
        assert timeout == 1200
        build = node_helper_build(cwd).encode()
        for arch in pc.MACHO_CPU_TYPES:
            payload = cwd / "prebuilt/macos" / arch / "bridge"
            payload.parent.mkdir(parents=True, exist_ok=True)
            payload.write_bytes(helper(arch, b"diagnostics", build))
            payload.chmod(0o755)
        compiled.append(cwd)
        return "compiled"

    monkeypatch.setattr(nr, "command", compile_fixture)
    output = tmp_path / "artifacts"
    nr.native_check(ROOT, output)
    assert len(compiled) == 1
    # On macOS `npm run build` recompiles both helpers for real, so expect another build instead.
    with monkeypatch.context() as patch:
        patch.setattr(pc, "macos_helper_build", lambda _tarball: "0.0.1+" + "0" * 64)
        with pytest.raises(
            pc.ContractError, match=r"arm64/bridge reports build .*, expected '0\.0\.1\+0{64}'"
        ):
            nr.native_check(ROOT, tmp_path / "stale")
    assert len(list(output.glob("nredd-pi-computer-use-*.tgz"))) == 1
    with pytest.raises(nr.ReleaseError, match="must be new and outside the checkout"):
        nr.native_check(ROOT, output)
    with pytest.raises(nr.ReleaseError, match="must be new and outside the checkout"):
        nr.native_check(ROOT, ROOT / "artifacts")
    assert nr.main(["native-check", "--repo-root", str(ROOT), "--artifact-dir", str(tmp_path / "cli")]) == 0
    monkeypatch.setattr(rd, "DESCRIPTORS", ())
    with pytest.raises(nr.ReleaseError, match="Missing computer-use descriptor"):
        nr.native_check(ROOT, tmp_path / "missing")


def test_native_build_starts_from_a_clean_checkout(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Compile when no prebuilt exists, as in CI and release checkouts, and drop stale local builds.

    Parameters:
        tmp_path (Path): Disposable repository and work parents.
        monkeypatch (pytest.MonkeyPatch): Substitute the compiler and host platform.

    Returns:
        None: The staged copy holds only fresh compiler output; a missing output still fails.
    """
    descriptor = rd.descriptor_for("@nredd/pi-computer-use")
    assert descriptor is not None
    monkeypatch.setattr(sys, "platform", descriptor.native_build_platform)
    repo = tmp_path / "repo"
    workspace = repo / descriptor.workspace
    workspace.mkdir(parents=True)
    (workspace / "package.json").write_text("{}")
    assert nr.native_matches(workspace, descriptor, required=False) == ()
    with pytest.raises(nr.ReleaseError, match="Missing native artifact"):
        nr.native_matches(workspace, descriptor)
    seen: list[bool] = []

    def compile_fixture(cwd: Path, *cmd: str, timeout: int) -> str:
        """Record whether a stale payload survived into the build, then write fresh output.

        Parameters:
            cwd (Path): Disposable staged workspace.
            *cmd (str): Descriptor build invocation.
            timeout (int): Required build deadline.

        Returns:
            str: Synthetic compiler diagnostics.
        """
        seen.append(any((cwd / relative).exists() for relative in descriptor.native_artifacts))
        for arch, cpu in pc.MACHO_CPU_TYPES.items():
            payload = cwd / "prebuilt/macos" / arch / "bridge"
            payload.parent.mkdir(parents=True, exist_ok=True)
            payload.write_bytes(pc.MACHO_MAGIC_64 + cpu.to_bytes(4, "little") + bytes(24))
        return "compiled"

    monkeypatch.setattr(nr, "command", compile_fixture)
    monkeypatch.setattr(nr, "validate_native_sources", lambda *_: None)
    staged = nr.build_native_workspace(repo, descriptor, tmp_path / "clean")
    assert len(nr.native_matches(staged, descriptor)) == len(descriptor.native_artifacts)
    stale = workspace / descriptor.native_artifacts[0]
    stale.parent.mkdir(parents=True)
    stale.write_bytes(b"stale")
    nr.build_native_workspace(repo, descriptor, tmp_path / "stale")
    assert seen == [False, False]


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


def test_packed_build_matches_the_client(tmp_path: Path) -> None:
    """The release gate's identity equals the one `helper-build.mjs` computes from the same files.

    Parameters:
        tmp_path (Path): Fixture package and tarball parent.

    Returns:
        None: CRLF, non-ASCII and the real sources hash as the client hashes them.
    """
    real = write_tarball(tmp_path / "real.tgz", package_members(COMPUTER_USE))
    assert pc.macos_helper_build(real) == node_helper_build(COMPUTER_USE)
    fixture = tmp_path / "fixture"
    for name, data in package_members(COMPUTER_USE).items():
        (fixture / name).parent.mkdir(parents=True, exist_ok=True)
        (fixture / name).write_bytes(data)
    (fixture / "package.json").write_text(json.dumps({"version": "1.2.3-rc.1"}))
    (fixture / "native/macos/bridge.swift").write_bytes('let s = "\u00e9"\r\nlet t = 1\r\n'.encode())
    packed = write_tarball(tmp_path / "fixture.tgz", package_members(fixture))
    assert pc.macos_helper_build(packed) == node_helper_build(fixture)
    assert pc.macos_helper_build(packed).startswith("1.2.3-rc.1+")


def test_packed_build_refuses_unreadable_inputs(tmp_path: Path) -> None:
    """A missing version or a non-UTF-8 source fails closed instead of hashing something else.

    Parameters:
        tmp_path (Path): Tarball parent.

    Returns:
        None: Both inputs raise `ContractError`.
    """
    members = package_members(COMPUTER_USE)
    for version in ({}, {"version": ""}, {"version": 7}):
        broken = write_tarball(tmp_path / "v.tgz", members | {"package.json": json.dumps(version).encode()})
        with pytest.raises(pc.ContractError, match=r"package\.json has no version"):
            pc.macos_helper_build(broken)
    broken = write_tarball(tmp_path / "s.tgz", members | {"native/macos/bridge.swift": b"\xff"})
    with pytest.raises(pc.ContractError, match=r"'s.tgz:native/macos/bridge.swift' is not UTF-8"):
        pc.macos_helper_build(broken)


@pytest.mark.parametrize(
    ("literals", "message"),
    [
        ((), r"has 0 build identities, expected exactly 1: \[\]"),
        ((b"x1.2.3+" + b"a" * 64,), "has 0 build identities"),
        ((b"1.2.3+" + b"a" * 64, b"1.2.3+" + b"b" * 64), "has 2 build identities"),
        ((b"1.2.3+" + b"b" * 64,), "reports build '1.2.3[+]b+', expected '1.2.3[+]a+'"),
    ],
    ids=["none", "not-delimited", "several", "other"],
)
def test_packed_helper_build_refuses(tmp_path: Path, literals: tuple[bytes, ...], message: str) -> None:
    """Only exactly one compiled identity, equal to the expected one, passes.

    Parameters:
        tmp_path (Path): Tarball parent.
        literals (tuple[bytes, ...]): Strings compiled into the fixture helper.
        message (str): Expected refusal.

    Returns:
        None: Each malformed helper raises `ContractError`.
    """
    tarball = write_tarball(tmp_path / "cu.tgz", {"prebuilt/macos/x64/bridge": helper("x64", *literals)})
    with pytest.raises(pc.ContractError, match=f"prebuilt/macos/x64/bridge {message}"):
        pc.check_macos_helper_build(tarball, "x64", "1.2.3+" + "a" * 64)


def test_packed_helper_build_accepts_the_expected_identity(tmp_path: Path) -> None:
    """A repeated equal literal is one identity; the evidence names the arch and build.

    Parameters:
        tmp_path (Path): Tarball parent.

    Returns:
        None: The matching helper passes.
    """
    build = "0.7.0-beta.2+" + "c" * 64
    data = helper("arm64", b"buildIdentity", build.encode(), build.encode())
    tarball = write_tarball(tmp_path / "cu.tgz", {"prebuilt/macos/arm64/bridge": data})
    assert pc.check_macos_helper_build(tarball, "arm64", build) == f"arm64 build {build}"
