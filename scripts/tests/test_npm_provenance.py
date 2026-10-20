"""Test real npm provenance shapes and fail-closed npm signature-audit orchestration.

References:
    https://registry.npmjs.org/-/npm/v1/attestations/vite@7.1.3
    https://docs.npmjs.com/cli/v11/commands/npm-audit#signature-audit
    https://slsa.dev/provenance/v1
"""

from __future__ import annotations

import base64
import io
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import npm_release as nr

FIXTURE = Path(__file__).with_name("fixtures") / "vite-7.1.3-provenance.json"
VERIFIED_REPORT = (
    "audited 1 package in 1s\n\n1 package has a verified registry signature\n\n"
    "1 package has a verified attestation\n"
)


@pytest.fixture
def identity() -> nr.Identity:
    """Provide a deterministic owned release identity for provenance assertions.

    Returns:
        Identity: Expected package, bytes and tagged source.
    """
    target = nr.Target(
        tag="@nredd/pi-session-kit@1.2.3",
        name="@nredd/pi-session-kit",
        version="1.2.3",
        directory="session-kit",
    )
    return nr.Identity(
        target=target,
        commit="a" * 40,
        tarball="nredd-pi-session-kit-1.2.3.tgz",
        sha256="b" * 64,
        integrity="sha512-" + base64.b64encode(b"c" * 64).decode(),
    )


def adapt_bundle(identity: nr.Identity) -> tuple[dict[str, Any], dict[str, Any]]:
    """Adapt only release-specific values in the real public npm bundle's statement.

    Parameters:
        identity (Identity): Owned test release.

    Returns:
        tuple[dict[str, Any], dict[str, Any]]: Registry envelope and decoded synthetic statement.
    """
    content = json.loads(FIXTURE.read_bytes())
    statement = json.loads(base64.b64decode(content["attestations"][0]["bundle"]["dsseEnvelope"]["payload"]))
    statement["subject"][0] = {
        "name": f"pkg:npm/{identity.target.name.replace('@', '%40')}@{identity.target.version}",
        "digest": {"sha512": base64.b64decode(identity.integrity.removeprefix("sha512-")).hex()},
    }
    ref = f"refs/tags/{identity.target.tag}"
    build = statement["predicate"]["buildDefinition"]
    build["externalParameters"]["workflow"] = {
        "repository": nr.WORKFLOW_REPOSITORY,
        "ref": ref,
        "path": nr.WORKFLOW_PATH,
    }
    build["resolvedDependencies"] = [
        {
            "uri": f"git+{nr.WORKFLOW_REPOSITORY}@{ref}",
            "digest": {"gitCommit": identity.commit},
        }
    ]
    return content, statement


def encode_bundle(content: dict[str, Any], statement: dict[str, Any]) -> bytes:
    """Serialize a synthetic statement into the original fixture's DSSE envelope shape.

    Parameters:
        content (dict[str, Any]): Trimmed registry response.
        statement (dict[str, Any]): Decoded statement under test.

    Returns:
        bytes: npm-shaped response, without a claim that its modified signature is valid.
    """
    content["attestations"][0]["bundle"]["dsseEnvelope"]["payload"] = base64.b64encode(
        json.dumps(statement).encode()
    ).decode()
    return json.dumps(content).encode()


def test_real_bundle_structure_and_adapted_binding(identity: nr.Identity) -> None:
    """Parse the unchanged public payload before checking a release-specific adaptation.

    Parameters:
        identity (Identity): Expected owned release.

    Returns:
        None: Assertions verify the real fixture's shape and the adapted binding.
    """
    actual = nr.RegistryAttestations.model_validate_json(FIXTURE.read_bytes())
    statement = nr.Statement.model_validate_json(
        base64.b64decode(actual.attestations[0].bundle.dsseEnvelope.payload)
    )
    assert statement.subject[0].name == "pkg:npm/vite@7.1.3"
    assert (
        statement.predicate.buildDefinition.externalParameters.workflow.repository
        == "https://github.com/vitejs/vite"
    )
    content, adapted = adapt_bundle(identity)
    nr.verify_provenance(identity, encode_bundle(content, adapted))
    with pytest.raises(nr.ReleaseError, match="subject"):
        nr.verify_provenance(identity, FIXTURE.read_bytes())


@pytest.mark.parametrize(
    "case", ["digest", "repo", "ref", "path", "subject", "predicate", "commit", "source"]
)
def test_provenance_rejects_wrong_binding(identity: nr.Identity, case: str) -> None:
    """A valid-looking bundle cannot bind another package, tarball, workflow or source to this release.

    Parameters:
        identity (Identity): Expected release.
        case (str): Statement field to corrupt.

    Returns:
        None: The corrupted statement is refused.
    """
    content, statement = adapt_bundle(identity)
    build = statement["predicate"]["buildDefinition"]
    if case == "digest":
        statement["subject"][0]["digest"]["sha512"] = "0" * 128
    elif case == "subject":
        statement["subject"][0]["name"] = "pkg:npm/%40nredd/pi-dev-tools@1.2.3"
    elif case == "predicate":
        statement["predicateType"] = "https://github.com/npm/attestation/tree/main/specs/publish/v0.1"
    elif case in {"commit", "source"}:
        if case == "commit":
            build["resolvedDependencies"][0]["digest"]["gitCommit"] = "0" * 40
        else:
            build["resolvedDependencies"][0]["uri"] = "git+https://github.com/other/repo@refs/heads/main"
    else:
        field = {"repo": "repository", "ref": "ref", "path": "path"}[case]
        build["externalParameters"]["workflow"][field] = "wrong"
    with pytest.raises((nr.ReleaseError, ValueError)):
        nr.verify_provenance(identity, encode_bundle(content, statement))


@pytest.mark.parametrize("case", ["missing", "duplicate", "metadata-only", "invalid-base64", "wrong-type"])
def test_provenance_requires_actual_dsse_statement(identity: nr.Identity, case: str) -> None:
    """Missing, ambiguous, malformed or metadata-only provenance is never enough.

    Parameters:
        identity (Identity): Expected release.
        case (str): Invalid envelope shape.

    Returns:
        None: The response is refused.
    """
    content, statement = adapt_bundle(identity)
    encoded = encode_bundle(content, statement)
    if case == "metadata-only":
        encoded = b'{"provenance":{"predicateType":"https://slsa.dev/provenance/v1"}}'
    else:
        if case == "missing":
            content["attestations"] = []
        elif case == "duplicate":
            content["attestations"] *= 2
        elif case == "invalid-base64":
            content["attestations"][0]["bundle"]["dsseEnvelope"]["payload"] = "!invalid!"
        else:
            content["attestations"][0]["bundle"]["dsseEnvelope"]["payloadType"] = "text/plain"
        encoded = json.dumps(content).encode()
    with pytest.raises((nr.ReleaseError, ValueError)):
        nr.verify_provenance(identity, encoded)


def write_signature_install_tree(project: Path, identity: nr.Identity, case: str) -> None:
    """Create a realistic installed subject with optional unrelated nested dependencies.

    Parameters:
        project (Path): Disposable npm installation root.
        identity (nr.Identity): Expected release identity.
        case (str): Test case selecting malformed or unrelated dependency state.

    Returns:
        None: Lock and installed package trees are written.
    """
    subject_key = f"node_modules/{identity.target.name}"
    entry = {
        "version": "other" if case == "wrong-version" else identity.target.version,
        "integrity": "wrong" if case == "wrong-integrity" else identity.integrity,
    }
    packages = {"": {}, subject_key: entry}
    if case in {"runtime-dependency", "unattested-subject"}:
        packages["node_modules/attested-dependency"] = {"version": "4.5.6", "integrity": identity.integrity}
        packages["node_modules/attested-dependency/node_modules/nested"] = {
            "version": "7.8.9",
            "integrity": identity.integrity,
        }
    (project / "package-lock.json").write_text(json.dumps({"packages": packages}))
    installed = project / subject_key
    installed.mkdir(parents=True)
    (installed / "package.json").write_text(
        json.dumps({"name": identity.target.name, "version": identity.target.version})
    )
    (installed / "index.js").write_text("export {};\n")
    if case in {"runtime-dependency", "unattested-subject"}:
        dependency = project / "node_modules/attested-dependency"
        dependency.mkdir()
        (dependency / "package.json").write_text('{"name":"attested-dependency","version":"4.5.6"}')
        nested = dependency / "node_modules/nested"
        nested.mkdir(parents=True)
        (nested / "package.json").write_text('{"name":"nested","version":"7.8.9"}')


@pytest.mark.parametrize(
    "case",
    [
        "valid",
        "signature-missing",
        "attestation-missing",
        "audit-failed",
        "wrong-integrity",
        "wrong-version",
        "runtime-dependency",
        "unattested-subject",
        "altered-root-bytes",
    ],
)
def test_npm_signature_audit_fails_closed(
    identity: nr.Identity,
    monkeypatch: pytest.MonkeyPatch,
    case: str,
) -> None:
    """Verify the exact subject after accepting an install with runtime dependencies.

    Parameters:
        identity (Identity): Expected release.
        monkeypatch (pytest.MonkeyPatch): Substitutes npm, not report validation or lock parsing.
        case (str): Install/audit outcome.

    Returns:
        None: Only the complete verified audit passes.
    """
    calls: list[str] = []
    projects: list[Path] = []

    def command(project: Path, tool: str, *args: str, timeout: int = 300) -> str:
        """Simulate npm's real lockfile and textual report, preserving its nonzero exception contract.

        Parameters:
            project (Path): Real throwaway npm project.
            tool (str): Expected npm executable name.
            *args (str): Literal npm arguments.
            timeout (int): Bounded subprocess budget.

        Returns:
            str: Simulated npm output.

        Raises:
            subprocess.CalledProcessError: For a failed cryptographic audit.
        """
        assert tool == "npm"
        assert timeout > 0
        assert project != nr.pc.REPO_ROOT
        assert json.loads((project / "package.json").read_text())["private"]
        calls.append(args[0])
        projects.append(project)
        if args[0] == "install":
            assert args == (
                "install",
                "@nredd/pi-session-kit@1.2.3",
                "--ignore-scripts",
                "--legacy-peer-deps",
                "--no-audit",
                "--no-fund",
                "--prefer-online",
                "--registry=https://registry.npmjs.org",
            )
            write_signature_install_tree(project, identity, case)
            return "installed release"
        assert args == (
            "audit",
            "signatures",
            "--color=false",
            "--prefer-online",
            "--registry=https://registry.npmjs.org",
        )
        assert project.name == "subject"
        subject_key = f"node_modules/{identity.target.name}"
        lock = json.loads((project / "package-lock.json").read_text())
        assert set(lock["packages"]) == {"", subject_key}
        assert {path.relative_to(project).as_posix() for path in project.rglob("*") if path.is_file()} == {
            "package.json",
            "package-lock.json",
            f"{subject_key}/package.json",
            f"{subject_key}/index.js",
        }
        if case == "altered-root-bytes":
            (project / "package.json").write_text('{"private":false}\n')
        if case == "audit-failed":
            raise subprocess.CalledProcessError(1, ["npm", *args], "invalid attestation signature")
        if case == "signature-missing":
            return "1 package has a verified attestation"
        if case in {"attestation-missing", "unattested-subject"}:
            return "1 package has a verified registry signature"
        return VERIFIED_REPORT

    monkeypatch.setattr(nr, "command", command)
    if case in {"valid", "runtime-dependency"}:
        nr.verify_signatures(identity)
    else:
        with pytest.raises((nr.ReleaseError, subprocess.CalledProcessError)):
            nr.verify_signatures(identity)
    assert calls == (["install"] if case in {"wrong-integrity", "wrong-version"} else ["install", "audit"])
    assert all(not project.exists() for project in projects)


@pytest.mark.parametrize("case", ["valid", "oversized", "network-error"])
def test_attestation_fetch_uses_canonical_bounded_endpoint(
    identity: nr.Identity,
    monkeypatch: pytest.MonkeyPatch,
    case: str,
) -> None:
    """Only the canonical exact-version HTTPS endpoint is fetched, with size and timeout bounds.

    Parameters:
        identity (Identity): Selected release.
        monkeypatch (pytest.MonkeyPatch): Substitutes the HTTP response boundary.
        case (str): Response size or network failure.

    Returns:
        None: The correct endpoint is requested and failures are refused.
    """
    content = FIXTURE.read_bytes() if case == "valid" else b"x" * (nr.MAX_ATTESTATION_BYTES + 1)

    def open_url(url: str, timeout: int) -> io.BytesIO:
        """Record the real request arguments while providing a bounded binary response.

        Parameters:
            url (str): Canonical registry URL.
            timeout (int): HTTPS timeout in seconds.

        Returns:
            BytesIO: Test response supporting the actual context-manager/read API.

        Raises:
            OSError: For the simulated network failure.
        """
        assert url == "https://registry.npmjs.org/-/npm/v1/attestations/@nredd/pi-session-kit@1.2.3"
        assert timeout == 30
        if case == "network-error":
            raise OSError("registry unreachable")
        return io.BytesIO(content)

    monkeypatch.setattr(nr.urllib.request, "urlopen", open_url)
    if case == "valid":
        assert nr.fetch_attestations(identity.target) == content
    else:
        with pytest.raises((nr.ReleaseError, OSError)):
            nr.fetch_attestations(identity.target)


@pytest.mark.parametrize("failure", ["none", "signature", "metadata-only"])
def test_post_publish_gate_requires_signature_and_binding(
    tmp_path: Path,
    identity: nr.Identity,
    monkeypatch: pytest.MonkeyPatch,
    failure: str,
) -> None:
    """No successful registry-check stage can rely on metadata alone or bypass npm's verification.

    Parameters:
        tmp_path (Path): Stand-in checkout directory.
        identity (Identity): Expected release.
        monkeypatch (pytest.MonkeyPatch): Substitutes network/npm boundaries, not binding validation.
        failure (str): Failed post-publication stage, or no failure.

    Returns:
        None: The complete chain alone passes.
    """
    events: list[str] = []
    content, statement = adapt_bundle(identity)

    def signatures(candidate: nr.Identity) -> None:
        """Record npm verification, optionally refusing the signature.

        Parameters:
            candidate (Identity): Release under audit.

        Returns:
            None: For the simulated successful audit.

        Raises:
            ReleaseError: For the simulated invalid signature.
        """
        assert candidate == identity
        events.append("signatures")
        if failure == "signature":
            raise nr.ReleaseError("invalid signature")

    def fetch(target: nr.Target) -> bytes:
        """Return the actual-bundle shape or the previously insufficient metadata-only shape.

        Parameters:
            target (Target): Selected release.

        Returns:
            bytes: Registry response under test.
        """
        assert target == identity.target
        events.append("fetch")
        return b'{"attestations":[]}' if failure == "metadata-only" else encode_bundle(content, statement)

    monkeypatch.setattr(nr, "assert_toolchain", lambda *_: None)
    monkeypatch.setattr(nr, "check_artifact", lambda *_: identity)
    monkeypatch.setattr(nr, "wait_for_registry", lambda *_: events.append("metadata"))
    monkeypatch.setattr(nr, "verify_signatures", signatures)
    monkeypatch.setattr(nr, "fetch_attestations", fetch)
    result = nr.main(
        [
            "registry-check",
            "--tag",
            identity.target.tag,
            "--repo-root",
            str(tmp_path),
            "--artifact-dir",
            str(tmp_path),
        ]
    )
    assert result == (0 if failure == "none" else 1)
    assert events == (
        ["metadata", "signatures"] if failure == "signature" else ["metadata", "signatures", "fetch"]
    )
