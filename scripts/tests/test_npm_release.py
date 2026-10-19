"""Exercise tag/ancestry, registry refusals and immutable artifacts without running Pi or publishing.

References:
    https://docs.npmjs.com/trusted-publishers/
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import npm_release as nr
import package_contracts as pc

TAG = "@nredd/pi-session-kit@1.2.3"


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
    git(root, "add", "packages")
    git(root, "commit", "-qm", "Initial packages")
    git(root, "tag", TAG)
    git(root, "update-ref", "refs/remotes/origin/main", "HEAD")
    return root


def test_resolve_all_owned_names(repo: Path) -> None:
    """All four owned names resolve by manifest identity, not tag path guessing."""
    for contract in nr.CONTRACTS:
        target = nr.resolve_target(repo, f"{contract.name}@1.2.3")
        assert (target.name, target.directory, target.version) == (contract.name, contract.directory, "1.2.3")


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
    """
    with pytest.raises(nr.ReleaseError):
        nr.resolve_target(repo, tag)


def test_private_and_duplicate_names_refused(repo: Path) -> None:
    """Private or ambiguous workspace identities must never be publishable."""
    path = repo / "packages/session-kit/package.json"
    value = json.loads(path.read_text())
    path.write_text(json.dumps(value | {"private": True}))
    with pytest.raises(nr.ReleaseError, match="public owned"):
        nr.resolve_target(repo, TAG)
    path.write_text(json.dumps(value))
    (repo / "packages/preset/package.json").write_text(json.dumps(value))
    with pytest.raises(nr.ReleaseError, match="public owned"):
        nr.resolve_target(repo, TAG)


def test_preflight_ancestry_and_existing_version(repo: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Real git ancestry and tag/HEAD checks precede any packing; existing npm versions refuse.

    Parameters:
        repo (Path): Test repository.
        monkeypatch (pytest.MonkeyPatch): Replaces registry only, not git.
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
    """

    def fail(_repo: Path, tool: str, *args: str) -> str:
        """Keep merged-stream JSON parseable and force fresh registry metadata."""
        assert tool == "npm"
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


def test_registry_requires_integrity_and_provenance() -> None:
    """A publish receipt alone is not provenance and changed bytes can never recover."""
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
    nr.confirm_registry(identity, dist)
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
            nr.confirm_registry(identity, bad)


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

    def exercise(_work: Path, _stock: Path, only: list[str], supplied: dict[str, Path]) -> SimpleNamespace:
        """Assert the stock gate receives precisely the already-packed candidate bytes."""
        assert only == ["session-kit"]
        assert set(supplied) == {"session-kit"}
        assert supplied["session-kit"].is_file()
        return SimpleNamespace(model_dump_json=lambda: '{"test": "Pi exercise substituted"}')

    monkeypatch.setattr(pc, "run_gate", exercise)
    original_command = nr.command

    def skip_package_check(root: Path, tool: str, *args: str, timeout: int = 300) -> str:
        """Skip only install/check, retaining real git, npm pack and byte validation."""
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
    """The artifact bytes, SHA-256, SRI, manifest, tag and source commit cross-check together."""
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
    """
    output = repo / "artifacts" if case == "inside" else tmp_path

    def forbid(*_args: object) -> str:
        """No child process should run for an invalid destination."""
        pytest.fail("Install ran before destination validation")

    monkeypatch.setattr(nr, "command", forbid)
    with pytest.raises(nr.ReleaseError, match="new and outside"):
        nr.verify(repo, nr.resolve_target(repo, TAG), output)


def test_workflow_permissions_and_immutable_transfer() -> None:
    """Pin release workflow security/transfer invariants without running a workflow locally."""
    workflow = (pc.REPO_ROOT / ".github/workflows/publish.yml").read_text()
    assert "tags: ['@nredd/*@*']" in workflow
    assert "cancel-in-progress: false" in workflow
    assert workflow.count("id-token: write") == 1
    assert workflow.count("contents: write") == 1
    assert "environment: npm" in workflow
    assert "secrets." not in workflow
    assert "NODE_AUTH_TOKEN" not in workflow
    assert 'npm publish "$RUNNER_TEMP/npm-release/$TARBALL" --access public' in workflow
    assert "if: steps.candidate.outputs.publish == 'true'" in workflow
    assert 'gh release create "$RELEASE_TAG" --verify-tag' in workflow
    assert "package-manager-cache: false" in workflow
    assert workflow.count("npm publish ") == 1
    assert "npm pack" not in workflow  # Packing and release checks live in the tested Python module.


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
    """
    events: list[str] = []
    original_command = nr.command
    original_pack = pc.pack
    candidate: list[Path] = []

    def command(root: Path, tool: str, *args: str, timeout: int = 300) -> str:
        """Record install/check without executing any package scenario suite."""
        if tool == "npm":
            assert args in (("ci", "--ignore-scripts"), ("run", "check", "--workspace", contract.name))
            events.append(args[0])
            return "substituted package check"
        return original_command(root, tool, *args, timeout=timeout)

    def pack(c: pc.PackageContract, dest: Path, sandbox: pc.Sandbox, source: Path) -> pc.PackedArtifact:
        """Retain real npm packing and insist it happens only after the selected check."""
        assert events == ["ci", "run"]
        events.append("pack")
        artifact = original_pack(c, dest, sandbox, source)
        candidate.append(artifact.path)
        return artifact

    def gate(kind: str, supplied: dict[str, Path]) -> SimpleNamespace:
        """Require both gates to consume exactly the candidate's original path and bytes."""
        assert supplied == {contract.directory: candidate[0]}
        assert pc.load_tarball(contract, candidate[0]).version == "1.2.3"
        events.append(kind)
        return SimpleNamespace(model_dump_json=lambda: '{"test": "Pi substituted"}')

    monkeypatch.setattr(nr, "command", command)
    monkeypatch.setattr(pc, "pack", pack)
    monkeypatch.setattr(pc, "run_gate", lambda _w, _s, _only, supplied: gate("stock", supplied))
    monkeypatch.setattr(nr.fork, "run_fork_gate", lambda _w, _s, _r, supplied: gate("fork", supplied))
    target = nr.resolve_target(repo, f"{contract.name}@1.2.3")
    nr.verify(repo, target, tmp_path / "candidate")
    expected = ["ci", "run", "pack"]
    if contract in pc.CONTRACTS:
        expected.append("stock")
    if contract in (nr.fork.DEV_TOOLS_CONTRACT, pc.PRESET_CONTRACT):
        expected.append("fork")
    assert events == expected


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
    """

    def fail(_repo: Path, _tool: str, *args: str, timeout: int = 300) -> str:
        """Return an npm failure without running package checks."""
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
        "absent": [None] * 7,
        "no-provenance": [nr.Distribution(integrity=identity.integrity)] * 7,
        "different": [nr.Distribution(integrity="different")],
    }[case]
    reads: list[nr.Distribution | None] = []
    sleeps: list[int] = []

    def lookup(_repo: Path, _target: nr.Target) -> nr.Distribution | None:
        """Serve a finite response sequence, failing if retries exceed the budget."""
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
    assert sleeps == [10] * (len(responses) - 1)
