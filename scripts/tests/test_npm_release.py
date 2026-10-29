"""Exercise tag/ancestry, registry refusals and immutable artifacts without running Pi or publishing.

References:
    https://docs.npmjs.com/trusted-publishers/
"""

from __future__ import annotations

import io
import json
import os
import subprocess
import sys
import tarfile
from collections.abc import Mapping
from dataclasses import replace
from pathlib import Path, PurePosixPath
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import npm_release as nr
import package_contracts as pc
import release_descriptors as rd

TAG = "@nredd/pi-session-kit@1.2.3"
NATIVE_ARTIFACT_CASES = (
    ("prebuilt/*", "prebuilt/helper", True),
    ("prebuilt/*", "prebuilt/macos/helper", False),
    ("prebuilt/**/helper", "prebuilt/helper", True),
    ("prebuilt/**/helper", "prebuilt/macos/helper", True),
    ("prebuilt/helper?", "prebuilt/helper1", True),
    ("prebuilt/helper?", "prebuilt/helper/one", False),
    ("prebuilt/[mh]elper", "prebuilt/helper", True),
    ("prebuilt/[mh]elper", "prebuilt/zelper", False),
)


def git(repo: Path, *args: str) -> str:
    """Run real git in an isolated test repository.

    Parameters:
        repo (Path): Disposable repository.
        *args (str): Git arguments.

    Returns:
        str: Command output.
    """
    return nr.command(repo, "git", *args)


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    """Create a clean owned-workspace fixture with an unsigned test tag and origin/main.

    Parameters:
        tmp_path (Path): Temporary directory.

    Returns:
        Path: Test repository.
    """
    root = tmp_path / "repo"
    root.mkdir()
    git(root, "init", "-q", "-b", "main")
    for key, value in (
        ("user.name", "Release Test"),
        ("user.email", "release@example.invalid"),
        ("commit.gpgsign", "false"),
        ("tag.gpgSign", "false"),
    ):
        git(root, "config", key, value)
    for contract in nr.CONTRACTS:
        package = root / "packages" / contract.directory
        package.mkdir(parents=True)
        (package / "package.json").write_text(json.dumps({"name": contract.name, "version": "1.2.3"}))
        descriptor = rd.descriptor_for(contract.name)
        assert descriptor is not None
        for artifact in descriptor.native_artifacts:
            path = package / artifact
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("native helper")
    git(root, "add", "packages")
    git(root, "commit", "-qm", "Initial packages")
    git(root, "tag", TAG)
    git(root, "update-ref", "refs/remotes/origin/main", "HEAD")
    return root


def test_resolve_all_owned_names(repo: Path) -> None:
    """All four owned names resolve by manifest identity, not tag path guessing.

    Parameters:
        repo (Path): Test repository.

    Returns:
        None: Every owned package resolves to its workspace.
    """
    for contract in nr.CONTRACTS:
        target = nr.resolve_target(repo, f"{contract.name}@1.2.3")
        assert (target.name, target.directory, target.version) == (contract.name, contract.directory, "1.2.3")


@pytest.mark.parametrize("packages", [{}, {"@nredd/pi-session-kit": SimpleNamespace(evidence={})}])
def test_stock_contract_requires_subject_evidence(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, packages: dict[str, SimpleNamespace]
) -> None:
    """A descriptor release fails when its executable gate omits evidence for the subject.

    Parameters:
        tmp_path (Path): Empty runner scratch directory.
        monkeypatch (pytest.MonkeyPatch): Replaces the stock runner without starting Pi.
        packages (dict[str, SimpleNamespace]): Missing or empty synthetic subject evidence.

    Returns:
        None: The publisher rejects incomplete evidence.
    """
    descriptor = rd.descriptor_for("@nredd/pi-session-kit")
    assert descriptor is not None
    monkeypatch.setattr(
        pc,
        "run_gate",
        lambda *_args, **_kwargs: SimpleNamespace(packages=packages, model_dump_json=lambda: "{}"),
    )
    with pytest.raises(nr.ReleaseError, match=r"subject|empty"):
        nr.run_stock_contract(tmp_path, tmp_path, descriptor, {"session-kit": tmp_path / "subject.tgz"})


@pytest.mark.parametrize(
    "tag",
    [
        "v1.2.3",
        "@other/pi-session-kit@1.2.3",
        "@nredd/unknown@1.2.3",
        "@nredd/pi-session-kit@01.2.3",
        "@nredd/pi-session-kit@1.2",
        "@nredd/pi-session-kit@1.2.3\nx",
        "@nredd/pi-session-kit@1.2.3;id",
        "@nredd/pi-session-kit@1.2.4",
        "@nredd/pi-session-kit@1.2.3-01",
    ],
)
def test_resolve_rejects_bad_tags(repo: Path, tag: str) -> None:
    """Unknown names, malformed versions, injection and version skew fail closed.

    Parameters:
        repo (Path): Test repository.
        tag (str): Invalid tag.

    Returns:
        None: Invalid tags are refused.
    """
    with pytest.raises(nr.ReleaseError):
        nr.resolve_target(repo, tag)


def test_private_descriptor_workspace_is_refused(repo: Path) -> None:
    """A descriptor cannot publish a package explicitly marked private.

    Parameters:
        repo: Disposable descriptor repository.

    Returns:
        None: The package identity is refused.
    """
    path = repo / "packages/session-kit/package.json"
    value = json.loads(path.read_text())
    path.write_text(json.dumps(value | {"private": True}))
    with pytest.raises(nr.ReleaseError, match="public descriptor"):
        nr.resolve_target(repo, TAG)


def test_descriptor_rejects_workspace_escape_and_missing_native_artifact(
    repo: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Descriptor paths and declared native package bytes fail closed before release work.

    Parameters:
        repo: Disposable descriptor repository.
        monkeypatch: Replaces the immutable descriptor registry for this test only.

    Returns:
        None: Escapes and absent native helper patterns are refused.
    """
    descriptor = rd.descriptor_for("@nredd/pi-session-kit")
    assert descriptor is not None
    outside = replace(descriptor, workspace=PurePosixPath("../outside"))
    monkeypatch.setattr(rd, "DESCRIPTORS", (outside,))
    with pytest.raises(nr.ReleaseError, match="unsafe workspace"):
        nr.resolve_target(repo, TAG)
    native = replace(descriptor, native_artifacts=(PurePosixPath("prebuilt/**/helper?"),))
    workspace = repo / "packages/session-kit"
    helper = workspace / "prebuilt/macos/helper1"
    helper.parent.mkdir(parents=True)
    helper.write_text("native helper")
    nr.validate_native_sources(workspace, native)
    tarball = repo.parent / "candidate.tgz"
    with tarfile.open(tarball, "w:gz") as archive:
        data = b"native helper"
        member = tarfile.TarInfo("package/prebuilt/macos/helper1")
        member.size = len(data)
        archive.addfile(member, io.BytesIO(data))
    nr.validate_native_tarball(tarball, native)
    helper.unlink()
    with pytest.raises(nr.ReleaseError, match="Missing native artifact"):
        nr.validate_native_sources(workspace, native)
    with pytest.raises(nr.ReleaseError, match="Packed tarball omits"):
        nr.validate_native_tarball(
            tarball, replace(native, native_artifacts=(PurePosixPath("prebuilt/macos/missing"),))
        )


@pytest.mark.parametrize(("pattern", "relative", "expected"), NATIVE_ARTIFACT_CASES)
def test_native_artifact_patterns_match_full_relative_paths(
    pattern: str, relative: str, expected: bool
) -> None:
    """Native artifact patterns use segment-confined ``PurePosixPath.full_match`` semantics.

    Parameters:
        pattern (str): Descriptor-native artifact pattern.
        relative (str): Candidate package-relative path.
        expected (bool): Expected full-match result.

    Returns:
        None: The shared matcher accepts exactly the declared paths.
    """
    assert nr.matches_native_artifact(PurePosixPath(pattern), PurePosixPath(relative)) is expected


@pytest.mark.parametrize(("pattern", "relative", "expected"), NATIVE_ARTIFACT_CASES)
def test_native_tarball_patterns_match_full_relative_paths(
    tmp_path: Path, pattern: str, relative: str, expected: bool
) -> None:
    """Tarball native-artifact checks use the same full-path glob semantics as source checks.

    Parameters:
        tmp_path (Path): Disposable tarball directory.
        pattern (str): Descriptor-native artifact pattern.
        relative (str): Packed package-relative path.
        expected (bool): Whether the tarball should satisfy the pattern.

    Returns:
        None: Matching and non-matching packed paths are distinguished.
    """
    descriptor = rd.descriptor_for("@nredd/pi-session-kit")
    assert descriptor is not None
    tarball = tmp_path / "candidate.tgz"
    with tarfile.open(tarball, "w:gz") as archive:
        data = b"native helper"
        member = tarfile.TarInfo(f"package/{relative}")
        member.size = len(data)
        archive.addfile(member, io.BytesIO(data))
    native = replace(descriptor, native_artifacts=(PurePosixPath(pattern),))
    if expected:
        nr.validate_native_tarball(tarball, native)
    else:
        with pytest.raises(nr.ReleaseError, match="Packed tarball omits"):
            nr.validate_native_tarball(tarball, native)


def test_stock_contract_refuses_missing_gate_and_unselected_subject(tmp_path: Path) -> None:
    """The real release chain rejects bad descriptor gates and supplied subjects before tool setup.

    Parameters:
        tmp_path (Path): Empty runner scratch directory.

    Returns:
        None: Neither invalid descriptor reaches stock-Pi discovery.
    """
    descriptor = rd.descriptor_for("@nredd/pi-session-kit")
    assert descriptor is not None
    with pytest.raises(nr.ReleaseError, match="No executable stock gate"):
        nr.run_stock_contract(tmp_path, tmp_path, replace(descriptor, stock_gate=None), {})
    with pytest.raises(pc.ContractError, match="no selected release contract"):
        nr.run_stock_contract(tmp_path, tmp_path, descriptor, {"wrong": tmp_path / "subject.tgz"})


def test_native_matches_skip_external_symlinked_directory(tmp_path: Path) -> None:
    """Source native-artifact discovery never follows a directory symlink outside its workspace.

    Parameters:
        tmp_path (Path): Disposable package and external helper root.

    Returns:
        None: The outside helper cannot satisfy a descriptor artifact requirement.
    """
    descriptor = rd.descriptor_for("@nredd/pi-session-kit")
    assert descriptor is not None
    workspace = tmp_path / "package"
    workspace.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "helper").write_text("native")
    (workspace / "prebuilt").symlink_to(outside, target_is_directory=True)
    native = replace(descriptor, native_artifacts=(PurePosixPath("prebuilt/helper"),))
    with pytest.raises(nr.ReleaseError, match="Missing native artifact"):
        nr.validate_native_sources(workspace, native)


def test_native_matches_skip_non_symlink_path_resolved_outside_workspace(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Native-artifact discovery rejects a non-symlink candidate whose resolved path escapes.

    Parameters:
        tmp_path (Path): Disposable package and external helper root.
        monkeypatch (pytest.MonkeyPatch): Supplies a traversal-shaped candidate from the workspace walk.

    Returns:
        None: The resolved outside file cannot satisfy the native-artifact requirement.
    """
    descriptor = rd.descriptor_for("@nredd/pi-session-kit")
    assert descriptor is not None
    workspace = tmp_path / "package"
    workspace.mkdir()
    outside = tmp_path / "outside"
    outside.write_text("native")
    candidate = workspace / "prebuilt" / ".." / ".." / "outside"

    def rglob(path: Path, _pattern: str) -> tuple[Path, ...]:
        """Return the crafted traversal candidate from this workspace only.

        Parameters:
            path (Path): Path receiving the recursive-glob call.
            _pattern (str): Unused glob pattern.

        Returns:
            tuple[Path, ...]: One non-symlink path resolving outside the workspace.
        """
        assert path == workspace
        return (candidate,)

    native = replace(descriptor, native_artifacts=(PurePosixPath("prebuilt/helper"),))
    with monkeypatch.context() as scoped:
        scoped.setattr(Path, "rglob", rglob)
        with pytest.raises(nr.ReleaseError, match="Missing native artifact"):
            nr.validate_native_sources(workspace, native)


@pytest.mark.parametrize(
    "subject",
    [descriptor for descriptor in rd.DESCRIPTORS if descriptor.stock_gate is not None],
    ids=lambda descriptor: descriptor.contract.directory,
)
def test_release_contract_gives_each_stock_descriptor_all_other_siblings(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, subject: rd.ReleaseDescriptor
) -> None:
    """The release path supplies every descriptor peer to each executable stock scenario.

    Parameters:
        tmp_path (Path): Disposable contract-gate workspace.
        monkeypatch (pytest.MonkeyPatch): Replaces pack, install and stock-Pi boundaries only.
        subject (rd.ReleaseDescriptor): Descriptor whose stock scenario is captured.

    Returns:
        None: Context sibling contracts and sibling-tool rejection remain complete.
    """
    tools = pc.Tools(node=Path("/bin/true"), npm=Path("/bin/true"), git=Path("/bin/true"))
    artifact = pc.PackedArtifact(
        subject.contract,
        tmp_path / f"{subject.contract.directory}.tgz",
        "1.2.3",
        "sha512-placeholder",
        "0" * 40,
        1,
        ("package.json",),
    )

    def select(
        contract: pc.PackageContract, _dest: Path, _sandbox: pc.Sandbox, _supplied: dict[str, Path]
    ) -> pc.PackedArtifact:
        """Return the subject artifact without packing or reading a tarball.

        Parameters:
            contract (pc.PackageContract): Selected contract.
            _dest (Path): Unused tarball directory.
            _sandbox (pc.Sandbox): Unused base sandbox.
            _supplied (dict[str, Path]): Unused supplied-artifact mapping.

        Returns:
            pc.PackedArtifact: Stub artifact for the selected subject.
        """
        assert contract is subject.contract
        return artifact

    def install(_artifact: pc.PackedArtifact, _sandbox: pc.Sandbox, project: Path) -> Path:
        """Create a fake installed package directory without invoking npm.

        Parameters:
            _artifact (pc.PackedArtifact): Unused selected tarball.
            _sandbox (pc.Sandbox): Unused package sandbox.
            project (Path): Installation project root.

        Returns:
            Path: Empty fake installed package directory.
        """
        installed = project / "node_modules" / "@nredd" / subject.contract.directory
        installed.mkdir(parents=True)
        return installed

    def scenario(ctx: pc.Context) -> pc.ScenarioEvidence:
        """Capture the real context passed by ``run_gate``.

        Parameters:
            ctx (pc.Context): Scenario context assembled by the unpatched runner.

        Returns:
            pc.ScenarioEvidence: Nonempty synthetic evidence.
        """
        assert ctx.siblings == tuple(
            descriptor.contract for descriptor in rd.DESCRIPTORS if descriptor is not subject
        )
        return {
            "tool": "git_status",
            "untracked": ["fixture"],
            "failure_path": "substituted",
            "resource_ranking": "rss",
            "resource_sampler_integrity": json.loads((pc.REPO_ROOT / "package-lock.json").read_text())[
                "packages"
            ]["packages/dev-tools/node_modules/@nredd/pi-resource-sampler"]["integrity"],
            "resource_failure_path": "process_limit 51 refused",
        }

    monkeypatch.setattr(pc, "locate_tools", lambda: tools)
    monkeypatch.setattr(pc, "ensure_stock_pi", lambda *_: tmp_path / "pi")
    monkeypatch.setattr(pc, "select_artifact", select)
    monkeypatch.setattr(pc, "audit_tarball", lambda *_: [])
    monkeypatch.setattr(pc, "install_alone", install)
    monkeypatch.setattr(
        pc,
        "run",
        lambda args, **_: subprocess.CompletedProcess(args, 0, stdout="v22.0.0\n", stderr=""),
    )
    monkeypatch.setattr(
        pc,
        "validate_report",
        lambda _report: SimpleNamespace(
            packages={subject.name: SimpleNamespace(evidence={"subject": subject.name})}
        ),
    )
    nr.run_stock_contract(
        tmp_path / "gate",
        tmp_path / "stock",
        replace(subject, stock_gate=scenario),
        {subject.contract.directory: artifact.path},
    )


def test_require_tools_rejects_a_sibling_tool_on_the_release_path() -> None:
    """A session-kit release refuses dev-tools' ``git_status`` on the isolated package path.

    Returns:
        None: Sibling tools cannot leak into the subject scenario.
    """
    session_kit = next(
        descriptor.contract for descriptor in rd.DESCRIPTORS if descriptor.name.endswith("session-kit")
    )
    dev_tools = next(
        descriptor.contract for descriptor in rd.DESCRIPTORS if descriptor.name.endswith("dev-tools")
    )
    result = pc.PiRun(returncode=0, events=(), stdout="", stderr="")
    request = pc.RecordedRequest(model="m", roles=(), tools=("monitor_start", "git_status"))
    with pytest.raises(pc.ContractError, match="sibling tools present"):
        pc.require_tools(result, session_kit, (dev_tools,), [request])


def test_preflight_ancestry_and_existing_version(repo: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Real git ancestry and tag/HEAD checks precede any packing; existing npm versions refuse.

    Parameters:
        repo (Path): Test repository.
        monkeypatch (pytest.MonkeyPatch): Replaces registry only, not git.

    Returns:
        None: Source ancestry and registry preconditions hold.
    """
    monkeypatch.setattr(nr, "registry_dist", lambda *_: None)
    assert nr.preflight(repo, TAG).directory == "session-kit"
    monkeypatch.setattr(nr, "registry_dist", lambda *_: nr.Distribution(integrity="sha512-existing"))
    with pytest.raises(nr.ReleaseError, match="Already published"):
        nr.preflight(repo, TAG)
    monkeypatch.setattr(nr, "registry_dist", lambda *_: None)
    git(repo, "commit", "--allow-empty", "-qm", "Off main")
    with pytest.raises(nr.ReleaseError, match="not tagged commit"):
        nr.preflight(repo, TAG)
    tag = "@nredd/pi-dev-tools@1.2.3"
    git(repo, "tag", tag)
    with pytest.raises(nr.ReleaseError, match="ancestor of `origin/main`"):
        nr.preflight(repo, tag)


def test_selected_release_verifies_the_exact_registry_subject(
    repo: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Reuse the publisher verifier for a selected already-published stack package.

    Parameters:
        repo (Path): Disposable tagged package checkout.
        monkeypatch (pytest.MonkeyPatch): Replaces registry and cryptographic boundaries.

    Returns:
        None.
    """
    captured: list[nr.PublishedIdentity] = []
    integrity = "sha512-" + "A" * 86 + "=="
    monkeypatch.setattr(nr, "registry_dist", lambda *_: nr.Distribution(integrity=integrity))
    monkeypatch.setattr(nr, "verify_signatures", captured.append)
    monkeypatch.setattr(nr, "fetch_attestations", lambda _: b"attestation")
    monkeypatch.setattr(
        nr,
        "verify_provenance",
        lambda identity, content: captured.append(identity) if content == b"attestation" else None,
    )

    result = nr.verify_selected_published(repo, TAG)

    assert result == captured[0]
    assert len(captured) == 2
    assert captured[0] == captured[1]
    assert captured[0].target.tag == TAG
    assert captured[0].integrity == integrity
    assert captured[0].commit == git(repo, "rev-list", "-n", "1", TAG)


def test_selected_published_rejects_absent_registry(repo: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A selected package missing from npm is a hard failure, never skipped.

    Parameters:
        repo (Path): Disposable tagged package checkout.
        monkeypatch (pytest.MonkeyPatch): Reports an explicit registry miss.

    Returns:
        None.
    """
    monkeypatch.setattr(nr, "registry_dist", lambda *_: None)
    with pytest.raises(nr.ReleaseError, match="absent from the npm registry"):
        nr.verify_selected_published(repo, TAG)


def test_selected_published_propagates_signature_failure(repo: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Signature failure must stop before provenance is even fetched.

    Parameters:
        repo (Path): Disposable tagged package checkout.
        monkeypatch (pytest.MonkeyPatch): Replaces registry and signature boundaries.

    Returns:
        None.
    """
    monkeypatch.setattr(
        nr, "registry_dist", lambda *_: nr.Distribution(integrity="sha512-" + "A" * 86 + "==")
    )

    def fail(_identity: nr.PublishedIdentity) -> None:
        """Simulate npm refusing the signature.

        Parameters:
            _identity (nr.PublishedIdentity): Unused verified identity.

        Raises:
            nr.ReleaseError: Always, as npm would.
        """
        raise nr.ReleaseError("npm must verify the selected release signature AND attestation")

    monkeypatch.setattr(nr, "verify_signatures", fail)
    monkeypatch.setattr(
        nr, "fetch_attestations", lambda _: pytest.fail("provenance fetched after signature failure")
    )
    with pytest.raises(nr.ReleaseError, match="signature"):
        nr.verify_selected_published(repo, TAG)


def test_selected_published_propagates_provenance_mismatch(
    repo: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A provenance binding mismatch fails the selected package.

    Parameters:
        repo (Path): Disposable tagged package checkout.
        monkeypatch (pytest.MonkeyPatch): Replaces registry and attestation boundaries.

    Returns:
        None.
    """
    monkeypatch.setattr(
        nr, "registry_dist", lambda *_: nr.Distribution(integrity="sha512-" + "A" * 86 + "==")
    )
    monkeypatch.setattr(nr, "verify_signatures", lambda _: None)
    monkeypatch.setattr(nr, "fetch_attestations", lambda _: b"{}")
    with pytest.raises(ValueError, match="attestations"):
        nr.verify_selected_published(repo, TAG)


def test_stack_check_stage_prints_real_integrity_and_fails_closed(
    repo: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """The `stack-check` CLI emits exact evidence on success and exits 1 on refusal.

    Parameters:
        repo (Path): Disposable tagged package checkout.
        monkeypatch (pytest.MonkeyPatch): Replaces registry and cryptographic boundaries.
        capsys (pytest.CaptureFixture[str]): Captures stdout evidence.

    Returns:
        None.
    """
    integrity = "sha512-" + "B" * 86 + "=="
    monkeypatch.setattr(nr, "registry_dist", lambda *_: nr.Distribution(integrity=integrity))
    monkeypatch.setattr(nr, "verify_signatures", lambda _: None)
    monkeypatch.setattr(nr, "fetch_attestations", lambda _: b"x")
    monkeypatch.setattr(nr, "verify_provenance", lambda *_: None)
    assert nr.main(["stack-check", "--tag", TAG, "--repo-root", str(repo)]) == 0
    assert json.loads(capsys.readouterr().out) == {
        "package": "@nredd/pi-session-kit@1.2.3",
        "integrity": integrity,
    }
    monkeypatch.setattr(nr, "registry_dist", lambda *_: None)
    assert nr.main(["stack-check", "--tag", TAG, "--repo-root", str(repo)]) == 1


@pytest.mark.parametrize(("code", "absent"), [("E404", True), ("E500", False), ("E401", False)])
def test_registry_only_404_is_absence(
    repo: Path,
    monkeypatch: pytest.MonkeyPatch,
    code: str,
    absent: bool,
) -> None:
    """Registry outages/auth errors must not turn into permission to publish.

    Parameters:
        repo (Path): Test repository.
        monkeypatch (pytest.MonkeyPatch): Injects npm errors.
        code (str): npm error code.
        absent (bool): Whether this code proves absence.

    Returns:
        None: Only an explicit registry miss permits publishing.
    """

    def fail(cwd: Path, tool: str, *args: str, env: Mapping[str, str] | None = None) -> str:
        """Keep merged-stream JSON parseable, force fresh metadata, and isolate npm from the checkout.

        Parameters:
            cwd (Path): Working directory; must not be the selected checkout.
            tool (str): Expected npm command.
            *args (str): Registry query arguments.
            env (Mapping[str, str] | None): Environment overrides; must disable the user `.npmrc`.

        Returns:
            str: Never returned; this simulates an npm failure.

        Raises:
            subprocess.CalledProcessError: The selected npm error.
        """
        assert tool == "npm"
        assert cwd != repo
        assert not cwd.is_relative_to(repo)
        assert env == {"NPM_CONFIG_USERCONFIG": os.devnull}
        assert args == (
            "view",
            "@nredd/pi-session-kit@1.2.3",
            "dist",
            "--json",
            "--loglevel=silent",
            "--prefer-online",
            "--registry=https://registry.npmjs.org",
        )
        raise subprocess.CalledProcessError(1, ["npm"], json.dumps({"error": {"code": code}}))

    target = nr.resolve_target(repo, TAG)
    monkeypatch.setattr(nr, "command", fail)
    if absent:
        assert nr.registry_dist(repo, target) is None
    else:
        with pytest.raises(nr.ReleaseError, match="Registry lookup failed"):
            nr.registry_dist(repo, target)


def test_registry_metadata_requires_integrity_and_provenance_hint() -> None:
    """A publish receipt alone cannot satisfy the preliminary provenance-visibility gate.

    Returns:
        None: Metadata visibility and byte identity are enforced before actual attestation verification.
    """
    target = nr.Target(tag=TAG, name="@nredd/pi-session-kit", version="1.2.3", directory="session-kit")
    identity = nr.Identity(
        target=target,
        commit="a" * 40,
        tarball="x.tgz",
        sha256="b" * 64,
        integrity="sha512-" + "A" * 86 + "==",
    )
    dist = nr.Distribution.model_validate(
        {
            "integrity": identity.integrity,
            "attestations": {
                "url": "https://registry.npmjs.org/attestations",
                "provenance": {"predicateType": nr.PROVENANCE_TYPE},
            },
        }
    )
    nr.confirm_registry_metadata(identity, dist)
    for bad in (
        None,
        dist.model_copy(update={"integrity": "changed"}),
        nr.Distribution(integrity=identity.integrity),
        nr.Distribution.model_validate(
            {
                "integrity": identity.integrity,
                "attestations": {"url": "https://registry.npmjs.org/attestations", "publish": {}},
            }
        ),
        nr.Distribution.model_validate(
            {
                "integrity": identity.integrity,
                "attestations": {
                    "url": "https://registry.npmjs.org/attestations",
                    "provenance": {"predicateType": "not-provenance"},
                },
            }
        ),
    ):
        with pytest.raises(nr.ReleaseError):
            nr.confirm_registry_metadata(identity, bad)


@pytest.mark.parametrize(
    ("tool", "version", "ok"),
    [
        ("node", "v22.14.0", True),
        ("node", "v22.13.9", False),
        ("node", "v26.0.0", True),
        ("npm", "11.5.1", True),
        ("npm", "11.5.0", False),
        ("npm", "12.0.0", True),
        ("npm", "11.5.1-beta.1", False),
    ],
)
def test_toolchain_minima(
    repo: Path,
    monkeypatch: pytest.MonkeyPatch,
    tool: str,
    version: str,
    ok: bool,
) -> None:
    """Exact OIDC toolchain boundaries and prereleases are checked.

    Parameters:
        repo (Path): Test repository.
        monkeypatch (pytest.MonkeyPatch): Replaces version probes.
        tool (str): Tool under test.
        version (str): Reported version.
        ok (bool): Expected acceptance.

    Returns:
        None: Supported stable toolchains alone pass.
    """
    monkeypatch.setattr(nr, "command", lambda _repo, name, *_: version if name == tool else "26.0.0")
    if ok:
        nr.assert_toolchain(repo)
    else:
        with pytest.raises(nr.ReleaseError, match="Unsupported"):
            nr.assert_toolchain(repo)


@pytest.fixture
def verified(repo: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[Path, nr.Identity]:
    """Pack a real fixture once; substitute only the Pi exercise, retaining manifest/git/hash operations.

    Parameters:
        repo (Path): Clean fixture.
        tmp_path (Path): Artifact parent.
        monkeypatch (pytest.MonkeyPatch): Prevents any local Pi invocation.

    Returns:
        tuple[Path, Identity]: Artifact directory and verified identity.
    """

    def exercise(
        _work: Path,
        _stock: Path,
        only: list[str],
        supplied: dict[str, Path],
        *,
        contracts: tuple[pc.PackageContract, ...],
        scenarios: dict[str, object],
        siblings: tuple[pc.PackageContract, ...],
    ) -> SimpleNamespace:
        """Assert the stock gate receives precisely the already-packed candidate bytes.

        Parameters:
            _work (Path): Unused gate scratch directory.
            _stock (Path): Unused Pi install directory.
            only (list[str]): Selected package directories.
            supplied (dict[str, Path]): Candidate tarball paths.
            contracts (tuple[pc.PackageContract, ...]): Selected descriptor contract.
            scenarios (dict[str, object]): Executable descriptor scenario by directory.
            siblings (tuple[pc.PackageContract, ...]): Full descriptor peer contract set.

        Returns:
            SimpleNamespace: Synthetic gate evidence without running Pi.
        """
        assert only == ["session-kit"]
        assert set(supplied) == {"session-kit"}
        assert supplied["session-kit"].is_file()
        assert [contract.directory for contract in contracts] == ["session-kit"]
        assert set(scenarios) == {"session-kit"}
        assert siblings == tuple(candidate.contract for candidate in rd.DESCRIPTORS)
        return SimpleNamespace(
            packages={"@nredd/pi-session-kit": SimpleNamespace(evidence={"subject": "session-kit"})},
            model_dump_json=lambda: '{"test": "Pi exercise substituted"}',
        )

    monkeypatch.setattr(pc, "run_gate", exercise)
    original_command = nr.command

    def skip_package_check(root: Path, tool: str, *args: str, timeout: int = 300) -> str:
        """Skip only install/check, retaining real git, npm pack and byte validation.

        Parameters:
            root (Path): Command working directory.
            tool (str): Executable name.
            *args (str): Command arguments.
            timeout (int): Subprocess timeout in seconds.

        Returns:
            str: Substituted package-check output or real command output.
        """
        if tool == "npm" and args in (
            ("ci", "--ignore-scripts"),
            ("run", "check", "--workspace", "@nredd/pi-session-kit"),
        ):
            return "Package check substituted (no local scenarios)"
        return original_command(root, tool, *args, timeout=timeout)

    monkeypatch.setattr(nr, "command", skip_package_check)
    output = tmp_path / "artifacts"
    identity = nr.verify(repo, nr.resolve_target(repo, TAG), output)
    return output, identity


def test_real_pack_manifest_checksum_round_trip(repo: Path, verified: tuple[Path, nr.Identity]) -> None:
    """The artifact bytes, SHA-256, SRI, manifest, tag and source commit cross-check together.

    Parameters:
        repo (Path): Test repository.
        verified (tuple[Path, Identity]): Real packed fixture.

    Returns:
        None: Artifact identity round-trips without a rebuild.
    """
    output, identity = verified
    assert nr.check_artifact(repo, TAG, output) == identity
    assert len(list(output.glob("*.tgz"))) == 1
    assert (
        json.loads((output / "manifest.json").read_text())["evidence"]["npm_integrity"] == identity.integrity
    )


@pytest.mark.parametrize("file", ["SHA256SUMS", "identity.json", "manifest.json", "tarball"])
def test_artifact_tampering_refused(repo: Path, verified: tuple[Path, nr.Identity], file: str) -> None:
    """Tampering any part of the identity chain fails before publication.

    Parameters:
        repo (Path): Test repository.
        verified (tuple[Path, Identity]): Real packed fixture.
        file (str): Artifact component to corrupt.

    Returns:
        None: Modified artifacts fail validation.
    """
    output, identity = verified
    if file == "tarball":
        with (output / identity.tarball).open("ab") as stream:
            stream.write(b"tampered")
    elif file == "SHA256SUMS":
        (output / file).write_text("wrong\n")
    else:
        value = json.loads((output / file).read_text())
        if file == "identity.json":
            value["commit"] = "0" * 40
        else:
            value["artifacts"][0]["sha256"] = "0" * 64
        (output / file).write_text(json.dumps(value))
    with pytest.raises(nr.ReleaseError):
        nr.check_artifact(repo, TAG, output)


def test_publish_recovery_skips_accepted_version(
    repo: Path,
    verified: tuple[Path, nr.Identity],
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """Failed-job reruns validate accepted bytes/provenance and never request a second publish.

    Parameters:
        repo (Path): Test repository.
        verified (tuple[Path, Identity]): Verified artifact fixture.
        monkeypatch (pytest.MonkeyPatch): Injects registry response only.
        tmp_path (Path): GitHub output file parent.

    Returns:
        None: Matching bytes skip publication, different bytes fail closed.
    """
    output, identity = verified
    monkeypatch.setattr(nr, "assert_toolchain", lambda *_: None)
    dist = nr.Distribution.model_validate(
        {
            "integrity": identity.integrity,
            "attestations": {
                "url": "https://registry.npmjs.org/attestations",
                "provenance": {"predicateType": nr.PROVENANCE_TYPE},
            },
        }
    )
    outputs = tmp_path / "outputs"
    monkeypatch.setenv("GITHUB_OUTPUT", str(outputs))
    args = ["publish-check", "--repo-root", str(repo), "--tag", TAG, "--artifact-dir", str(output)]
    monkeypatch.setattr(nr, "registry_dist", lambda *_: dist)
    assert nr.main(args) == 0
    assert "publish=false\n" in outputs.read_text()
    monkeypatch.setattr(nr, "registry_dist", lambda *_: None)
    assert nr.main(args) == 0
    assert "publish=true\n" in outputs.read_text()
    monkeypatch.setattr(nr, "registry_dist", lambda *_: nr.Distribution(integrity=identity.integrity))
    assert nr.main(args) == 0  # Skip publish even when the subsequent attestation check must retry.
    monkeypatch.setattr(nr, "registry_dist", lambda *_: nr.Distribution(integrity="changed"))
    outputs.unlink()
    assert nr.main(args) == 1
    assert not outputs.exists()


@pytest.mark.parametrize("case", ["existing", "inside"])
def test_artifact_destination_checked_before_install(
    repo: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    case: str,
) -> None:
    """Refuse dirtying the tagged checkout or replacing prior artifacts before doing work.

    Parameters:
        repo (Path): Source fixture.
        tmp_path (Path): Artifact parent.
        monkeypatch (pytest.MonkeyPatch): Forbids invoking install/check.
        case (str): Invalid destination kind.

    Returns:
        None: No install runs for an invalid artifact destination.
    """
    output = repo / "artifacts" if case == "inside" else tmp_path

    def forbid(*_args: object) -> str:
        """No child process should run for an invalid destination.

        Parameters:
            *_args (object): Unexpected command arguments.

        Returns:
            str: Never returned; an invocation fails the test.
        """
        pytest.fail("Install ran before destination validation")

    monkeypatch.setattr(nr, "command", forbid)
    with pytest.raises(nr.ReleaseError, match="new and outside"):
        nr.verify(repo, nr.resolve_target(repo, TAG), output)


@pytest.mark.parametrize("suffix", ["", "/"], ids=["exact", "trailing-slash"])
def test_commands_run_outside_the_uv_run_venv(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, suffix: str
) -> None:
    """Child tools never see the venv `uv run --project integration` activated for this script.

    Parameters:
        tmp_path (Path): Holds a fake activated venv with a tool found nowhere else.
        monkeypatch (pytest.MonkeyPatch): Simulates the `uv run` activation.
        suffix (str): `PATH` spelling of the venv's `bin` entry.

    Returns:
        None: The real child sees neither `VIRTUAL_ENV` nor the venv's tools.
    """
    scripts = tmp_path / "venv" / "bin"
    scripts.mkdir(parents=True)
    tool = scripts / "harness-only-tool"
    tool.write_text("#!/bin/sh\necho leaked\n")
    tool.chmod(0o755)
    monkeypatch.setenv("VIRTUAL_ENV", str(scripts.parent))
    monkeypatch.setenv("PATH", os.pathsep.join([f"{scripts}{suffix}", os.environ["PATH"]]))
    # A real child reports what it can see; the lookup logic stays in Python, not a shell string.
    probe = (
        "import json, os, shutil; "
        "print(json.dumps([shutil.which('harness-only-tool'), os.environ.get('VIRTUAL_ENV')]))"
    )
    assert json.loads(nr.command(tmp_path, "python3", "-c", probe)) == [None, None]


def test_host_environment_without_activation_is_unchanged(monkeypatch: pytest.MonkeyPatch) -> None:
    """Outside `uv run` (e.g. a direct local invocation) the environment passes through as is.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): Removes any real activation from this test process.

    Returns:
        None: No `PATH` entry is dropped when no venv is active.
    """
    monkeypatch.delenv("VIRTUAL_ENV", raising=False)
    assert nr.host_environment() == dict(os.environ)


def test_workflow_permissions_and_immutable_transfer() -> None:
    """Pin release workflow security/transfer invariants without running a workflow locally.

    Returns:
        None: Permissions, immutable transfer and release dependencies match the design.
    """
    workflow = (pc.REPO_ROOT / ".github/workflows/publish.yml").read_text()
    assert "tags: ['@nredd/*@*']" in workflow
    assert "cancel-in-progress: false" in workflow
    assert workflow.count("id-token: write") == 2  # Isolated attestor and npm publisher.
    assert workflow.count("contents: write") == 1
    assert "environment: npm" in workflow
    assert "secrets." not in workflow
    assert "NODE_AUTH_TOKEN" not in workflow
    assert 'npm publish "$RUNNER_TEMP/npm-release/$TARBALL" --access public --tag latest' in workflow
    assert "if: steps.candidate.outputs.publish == 'true'" in workflow
    assert 'gh release create "$RELEASE_TAG" --verify-tag' in workflow
    assert "package-manager-cache: false" in workflow
    assert workflow.count("npm publish ") == 1
    assert "npm pack" not in workflow  # Packing and release checks live in the tested Python module.
    assert "needs_fork_contract" not in workflow
    assert "directory == 'preset'" not in workflow


def compile_native_fixture(root: Path, descriptor: rd.ReleaseDescriptor) -> str:
    """Emit fresh fixture payloads only after the release builder deletes imported bytes.

    Parameters:
        root (Path): Staged package workspace.
        descriptor (rd.ReleaseDescriptor): Selected native requirements.

    Returns:
        str: Compiler fixture diagnostics.
    """
    for relative in descriptor.native_artifacts:
        assert not (root / relative).exists()
        (root / relative).write_text("fresh compiler fixture")
    return "substituted compiler"


@pytest.mark.parametrize("contract", nr.CONTRACTS, ids=lambda c: c.directory)
def test_verify_checks_then_packs_and_routes_exact_bytes(
    repo: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    contract: pc.PackageContract,
) -> None:
    """All four release paths check before packing and feed that one candidate to each applicable gate.

    Parameters:
        repo (Path): Clean repository fixture.
        tmp_path (Path): Artifact parent.
        monkeypatch (pytest.MonkeyPatch): Replaces package checks and Pi gates, never packing or hashing.
        contract (PackageContract): Selected owned package contract.

    Returns:
        None: The selected package check precedes one pack and every applicable gate.
    """
    descriptor = rd.descriptor_for(contract.name)
    assert descriptor is not None
    monkeypatch.setattr(sys, "platform", descriptor.native_build_platform or sys.platform)
    verify_args = [command[1:] for command in descriptor.verify_commands]
    verify_events = [args[0] for args in verify_args]
    events: list[str] = []
    original_command = nr.command
    original_pack = pc.pack
    candidate: list[Path] = []

    def command(root: Path, tool: str, *args: str, timeout: int = 300) -> str:
        """Record install/check without executing any package scenario suite.

        Parameters:
            root (Path): Command working directory.
            tool (str): Executable name.
            *args (str): Command arguments.
            timeout (int): Subprocess timeout in seconds.

        Returns:
            str: Synthetic install/check output or real Git output.
        """
        if tool == "npm":
            assert args in verify_args
            events.append(args[0])
            return "substituted package check"
        if tool == "node" and descriptor.native_build_commands:
            assert (tool, *args) in descriptor.native_build_commands
            return compile_native_fixture(root, descriptor)
        return original_command(root, tool, *args, timeout=timeout)

    def pack(c: pc.PackageContract, dest: Path, sandbox: pc.Sandbox, source: Path) -> pc.PackedArtifact:
        """Retain real npm packing and insist it happens only after the selected check.

        Parameters:
            c (PackageContract): Package being packed.
            dest (Path): Tarball destination.
            sandbox (Sandbox): Scrubbed npm environment.
            source (Path): Source package directory.

        Returns:
            PackedArtifact: Real packed candidate identity.
        """
        assert events == verify_events
        events.append("pack")
        artifact = original_pack(c, dest, sandbox, source)
        candidate.append(artifact.path)
        return artifact

    def gate(kind: str, supplied: dict[str, Path]) -> SimpleNamespace:
        """Require both gates to consume exactly the candidate's original path and bytes.

        Parameters:
            kind (str): Gate name recorded in the event log.
            supplied (dict[str, Path]): Candidate tarball paths.

        Returns:
            SimpleNamespace: Synthetic gate evidence without running Pi.
        """
        assert supplied == {contract.directory: candidate[0]}
        assert pc.load_tarball(contract, candidate[0]).version == "1.2.3"
        events.append(kind)
        return SimpleNamespace(
            packages={contract.name: SimpleNamespace(evidence={"subject": contract.directory})},
            model_dump_json=lambda: '{"test": "Pi substituted"}',
        )

    def stock_gate(
        _work: Path,
        _stock: Path,
        _only: list[str],
        supplied: dict[str, Path],
        *,
        contracts: tuple[pc.PackageContract, ...],
        scenarios: dict[str, object],
        siblings: tuple[pc.PackageContract, ...],
    ) -> SimpleNamespace:
        """Assert the descriptor passes its contract and executable subject gate.

        Parameters:
            _work (Path): Unused release scratch directory.
            _stock (Path): Unused stock Pi directory.
            _only (list[str]): Selected contract directory.
            supplied (dict[str, Path]): Packed candidate bytes.
            contracts (tuple[pc.PackageContract, ...]): Selected release contract.
            scenarios (dict[str, object]): Selected executable gate by contract directory.
            siblings (tuple[pc.PackageContract, ...]): All descriptor contracts for context peers.

        Returns:
            SimpleNamespace: Synthetic per-subject evidence report.
        """
        assert contracts == (contract,)
        assert set(scenarios) == {contract.directory}
        assert siblings == tuple(candidate.contract for candidate in rd.DESCRIPTORS)
        return gate("stock", supplied)

    monkeypatch.setattr(nr, "command", command)
    monkeypatch.setattr(pc, "pack", pack)
    monkeypatch.setattr(pc, "run_gate", stock_gate)

    def audit_gate(
        _work: Path, _contract: pc.PackageContract, supplied: dict[str, Path]
    ) -> dict[str, object]:
        """Record the audit gate and return a dict, as production `run_audit_gate` does.

        Parameters:
            _work (Path): Scratch directory, unused.
            _contract (pc.PackageContract): Contract, unused.
            supplied (dict[str, Path]): Candidate tarball paths.

        Returns:
            dict[str, object]: Synthetic audit evidence.
        """
        gate("audit", supplied)
        return {"name": contract.name, "version": "1.2.3"}

    monkeypatch.setattr(pc, "run_audit_gate", audit_gate)
    target = nr.resolve_target(repo, f"{contract.name}@1.2.3")
    nr.verify(repo, target, tmp_path / "candidate")
    expected = [*verify_events, "pack"]
    if "stock" in descriptor.contract_gates:
        expected.append("stock")
    if "audit" in descriptor.contract_gates:
        expected.append("audit")
    assert events == expected
    if contract.directory == "plan-mode":
        assert events == ["ci", "run", "pack", "stock"]


def test_every_standalone_descriptor_has_a_packed_artifact_gate() -> None:
    """No descriptor may ship without a gate that audits its real packed bytes."""
    for descriptor in rd.DESCRIPTORS:
        assert descriptor.contract_gates, descriptor.name
        assert ("stock" in descriptor.contract_gates) == (descriptor.stock_gate is not None), descriptor.name
        if descriptor.contract.library:
            assert descriptor.contract_gates == ("audit",), descriptor.name
            assert descriptor.contract.node_probe, descriptor.name
            assert descriptor.stock_gate is None, descriptor.name
        elif descriptor.name != "@nredd/pi-preset":
            assert "stock" in descriptor.contract_gates, descriptor.name
            assert descriptor.stock_gate is not None, descriptor.name


def test_plan_mode_descriptor_pins_its_own_commands_and_routing() -> None:
    """Hard-coded, independent of the descriptor data the release code consumes."""
    descriptor = rd.descriptor_for("@nredd/pi-plan-mode")
    assert descriptor is not None
    assert descriptor.verify_commands == (
        ("npm", "ci", "--ignore-scripts"),
        ("npm", "run", "check", "--workspace", "@nredd/pi-plan-mode"),
    )
    assert descriptor.contract_gates == ("stock",)
    assert descriptor.stock_gate is pc.scenario_plan_mode


@pytest.mark.parametrize("failure", ["ci", "run"])
def test_check_failure_never_packs(
    repo: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    failure: str,
) -> None:
    """Real subprocess failures stop the release before any output is created.

    Parameters:
        repo (Path): Source fixture.
        tmp_path (Path): Artifact parent.
        monkeypatch (pytest.MonkeyPatch): Substitutes a failed install or check.
        failure (str): Command to fail.

    Returns:
        None: A failed package check produces no release artifact.
    """

    def fail(_repo: Path, _tool: str, *args: str, timeout: int = 300) -> str:
        """Return an npm failure without running package checks.

        Parameters:
            _repo (Path): Unused checkout.
            _tool (str): Unused executable name.
            *args (str): Arguments selecting the simulated command.
            timeout (int): Unused subprocess timeout.

        Returns:
            str: Synthetic successful output for the other command.

        Raises:
            subprocess.CalledProcessError: For the selected failed command.
        """
        if args[0] == failure:
            raise subprocess.CalledProcessError(1, ["npm", *args], "check failed")
        return "okay"

    monkeypatch.setattr(nr, "command", fail)
    output = tmp_path / "artifacts"
    target = nr.resolve_target(repo, TAG)
    with pytest.raises(subprocess.CalledProcessError):
        nr.verify(repo, target, output)
    assert not output.exists()


@pytest.mark.parametrize("case", ["appears", "absent", "no-provenance", "different"])
def test_registry_propagation_is_bounded(
    repo: Path,
    verified: tuple[Path, nr.Identity],
    monkeypatch: pytest.MonkeyPatch,
    case: str,
) -> None:
    """Registry retries tolerate propagation, fail changed bytes immediately, and never call publish.

    Parameters:
        repo (Path): Test repository.
        verified (tuple[Path, Identity]): Verified byte identity.
        monkeypatch (pytest.MonkeyPatch): Substitutes registry reads and sleep.
        case (str): Registry outcome.

    Returns:
        None: Metadata-visibility retries stay within their budget.
    """
    _, identity = verified
    published = nr.Distribution.model_validate(
        {
            "integrity": identity.integrity,
            "attestations": {
                "url": "https://registry.npmjs.org/attestations",
                "provenance": {"predicateType": nr.PROVENANCE_TYPE},
            },
        }
    )
    responses = {
        "appears": [None, nr.Distribution(integrity=identity.integrity), published],
        "absent": [None] * nr.REGISTRY_POLL_ATTEMPTS,
        "no-provenance": [nr.Distribution(integrity=identity.integrity)] * nr.REGISTRY_POLL_ATTEMPTS,
        "different": [nr.Distribution(integrity="different")],
    }[case]
    reads: list[nr.Distribution | None] = []
    sleeps: list[int] = []

    def lookup(_repo: Path, _target: nr.Target) -> nr.Distribution | None:
        """Serve a finite response sequence, failing if retries exceed the budget.

        Parameters:
            _repo (Path): Unused checkout.
            _target (Target): Unused selected release.

        Returns:
            Distribution | None: The next simulated registry response.
        """
        value = responses[len(reads)]
        reads.append(value)
        return value

    monkeypatch.setattr(nr, "registry_dist", lookup)
    monkeypatch.setattr(nr.time, "sleep", sleeps.append)
    if case == "appears":
        nr.wait_for_registry(repo, identity)
    else:
        with pytest.raises(nr.ReleaseError):
            nr.wait_for_registry(repo, identity)
    assert len(reads) == len(responses)
    assert sleeps == [nr.REGISTRY_POLL_INTERVAL_S] * (len(responses) - 1)


def test_command_overlays_environment_overrides(tmp_path: Path) -> None:
    """Overrides win over the host environment without leaking into it.

    Parameters:
        tmp_path (Path): Private working directory.

    Returns:
        None.
    """
    output = nr.command(tmp_path, "env", env={"NPM_CONFIG_USERCONFIG": os.devnull})
    assert f"NPM_CONFIG_USERCONFIG={os.devnull}" in output.splitlines()
    assert os.environ.get("NPM_CONFIG_USERCONFIG") != os.devnull
