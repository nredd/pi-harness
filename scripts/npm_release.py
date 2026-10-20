"""Validate owned npm release tags and carry verified tarball bytes between CI jobs.

This module never publishes or creates tags. Only the environment-protected workflow publishes.

References:
    https://docs.npmjs.com/trusted-publishers/
    https://docs.npmjs.com/cli/v11/commands/npm-view
    https://docs.npmjs.com/generating-provenance-statements
    https://docs.npmjs.com/cli/v11/commands/npm-audit#signature-audit
    https://slsa.dev/provenance/v1
"""

from __future__ import annotations

import argparse
import base64
import json
import logging
import os
import re
import shutil
import subprocess
import tarfile
import tempfile
import time
import urllib.parse
import urllib.request
from collections.abc import Sequence
from pathlib import Path
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

import fork_package_contracts as fork
import package_contracts as pc
import release_descriptors as rd
import release_manifest as rm

LOGGER = logging.getLogger(__name__)
# Compatibility export for the existing four-package contract tests. Release selection
# itself is driven exclusively by ``release_descriptors.DESCRIPTORS``.
CONTRACTS = tuple(descriptor.contract for descriptor in rd.DESCRIPTORS)
# npm versions must be canonical SemVer, not ranges, aliases, leading zeroes or shell syntax.
NUMBER = r"(?:0|[1-9][0-9]*)"
PRE_ID = rf"(?:{NUMBER}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)"
VERSION = rf"{NUMBER}\.{NUMBER}\.{NUMBER}(?:-{PRE_ID}(?:\.{PRE_ID})*)?"
TAG = re.compile(rf"(?P<name>@nredd/[a-z0-9-]+)@(?P<version>{VERSION})")
TOOL_VERSION = re.compile(r"v?(\d+)\.(\d+)\.(\d+)")
PROVENANCE_TYPE = "https://slsa.dev/provenance/v1"
WORKFLOW_REPOSITORY = "https://github.com/nredd/pi-harness"
WORKFLOW_PATH = ".github/workflows/publish.yml"
MAX_ATTESTATION_BYTES = 2 * 1024 * 1024
# npm says a new version "may take a few minutes" to appear; the first OIDC release took ~4.
REGISTRY_POLL_INTERVAL_S = 15
REGISTRY_POLL_ATTEMPTS = 41  # 40 waits x 15 s = 10 minutes
STRICT = ConfigDict(extra="forbid", frozen=True, strict=True)


class ReleaseError(RuntimeError):
    """A release precondition or identity check failed."""


class Target(BaseModel):
    model_config = STRICT
    tag: str = Field(description="Exact signed monorepo tag")
    name: str = Field(description="Owned npm package name")
    version: str = Field(description="Canonical tag/package version")
    directory: str = Field(description="Owned workspace directory under packages/")


class Identity(BaseModel):
    model_config = STRICT
    target: Target = Field(description="Selected release")
    commit: rm.GitCommit = Field(description="Tagged source commit")
    tarball: pc.TarballName = Field(description="Verified artifact basename")
    sha256: pc.Sha256Hex = Field(description="SHA-256 of verified tarball bytes")
    integrity: pc.Sha512Integrity = Field(description="npm SHA-512 integrity of the same bytes")


class Provenance(BaseModel):
    model_config = ConfigDict(extra="ignore", strict=True)
    predicateType: str = Field(description="npm provenance predicate type")


class Attestations(BaseModel):
    model_config = ConfigDict(extra="ignore", strict=True)
    url: Annotated[str, StringConstraints(pattern=r"^https://")] = Field(
        description="Registry attestation URL"
    )
    provenance: Provenance | None = Field(
        default=None, description="Provenance attestation, not merely a publish receipt"
    )


class Distribution(BaseModel):
    model_config = ConfigDict(extra="ignore", strict=True)
    integrity: str = Field(description="Published tarball integrity")
    attestations: Attestations | None = Field(default=None, description="npm provenance metadata")


class DsseEnvelope(BaseModel):
    model_config = ConfigDict(extra="ignore", strict=True)
    payloadType: Literal["application/vnd.in-toto+json"] = Field(description="In-toto DSSE content type")
    payload: str = Field(description="Base64-encoded in-toto statement")


class ProvenanceBundle(BaseModel):
    model_config = ConfigDict(extra="ignore", strict=True)
    dsseEnvelope: DsseEnvelope = Field(description="Signed provenance envelope")


class RegistryAttestation(BaseModel):
    model_config = ConfigDict(extra="ignore", strict=True)
    predicateType: str = Field(description="Registry predicate selector")
    bundle: ProvenanceBundle = Field(description="Sigstore bundle, cryptographically verified by npm")


class RegistryAttestations(BaseModel):
    model_config = ConfigDict(extra="ignore", strict=True)
    attestations: list[RegistryAttestation] = Field(
        description="Actual attestation bundles, not dist metadata"
    )


class Subject(BaseModel):
    model_config = ConfigDict(extra="ignore", strict=True)
    name: str = Field(description="Package URL naming the released npm version")
    digest: dict[str, str] = Field(description="Subject digests, including hex SHA-512")


class Workflow(BaseModel):
    model_config = ConfigDict(extra="ignore", strict=True)
    repository: str = Field(description="Build workflow repository URL")
    ref: str = Field(description="Exact tagged Git ref")
    path: str = Field(description="Workflow file path")


class ExternalParameters(BaseModel):
    model_config = ConfigDict(extra="ignore", strict=True)
    workflow: Workflow = Field(description="GitHub Actions build workflow")


class ResolvedDependency(BaseModel):
    model_config = ConfigDict(extra="ignore", strict=True)
    uri: str = Field(description="Resolved build source URI")
    digest: dict[str, str] = Field(description="Resolved source commit")


class BuildDefinition(BaseModel):
    model_config = ConfigDict(extra="ignore", strict=True)
    externalParameters: ExternalParameters = Field(description="Build workflow identity")
    resolvedDependencies: list[ResolvedDependency] = Field(description="Resolved tagged source")


class Predicate(BaseModel):
    model_config = ConfigDict(extra="ignore", strict=True)
    buildDefinition: BuildDefinition = Field(description="SLSA v1 build definition")


class Statement(BaseModel):
    model_config = ConfigDict(extra="ignore", strict=True)
    statement_type: Literal["https://in-toto.io/Statement/v1"] = Field(
        alias="_type", description="Statement schema"
    )
    subject: list[Subject] = Field(min_length=1, max_length=1, description="The one released package")
    predicateType: Literal["https://slsa.dev/provenance/v1"] = Field(description="SLSA provenance v1")
    predicate: Predicate = Field(description="Build/source binding")


def host_environment() -> dict[str, str]:
    """Return this process's environment without the integration venv that `uv run` activated.

    `publish.yml` runs this script via `uv run --project integration`, which exports `VIRTUAL_ENV` and
    puts its `bin` first on `PATH`. Child tools must see what CI's `owned` job sees: otherwise a
    package check that expects a tool to be missing from its own project (e.g. dev-tools' `uv run
    pytest` case) silently finds the harness's `pytest`.

    Returns:
        dict[str, str]: `os.environ` minus `VIRTUAL_ENV` and that venv's `bin` `PATH` entries.
    """
    env = dict(os.environ)
    venv = env.pop("VIRTUAL_ENV", None)
    if venv:
        scripts = Path(venv) / "bin"
        entries = env.get("PATH", "").split(os.pathsep)
        env["PATH"] = os.pathsep.join(e for e in entries if not e or Path(e) != scripts)
    return env


def command(repo: Path, executable: str, *args: str, timeout: int = 300) -> str:
    """Run a bounded, absolute-path tool command outside the `uv run` venv, preserving diagnostics.

    Parameters:
        repo (Path): Working directory.
        executable (str): Tool resolved once before invocation.
        *args (str): Literal arguments.
        timeout (int): Maximum command duration in seconds.

    Returns:
        str: Combined output with trailing whitespace removed.
    """
    return subprocess.check_output(
        [str(pc.locate_executable(executable)), *args],
        cwd=repo,
        env=host_environment(),
        text=True,
        stderr=subprocess.STDOUT,
        timeout=timeout,
    ).strip()


def descriptor_for(target: Target) -> rd.ReleaseDescriptor:
    """Return the registered descriptor for a resolved target.

    Parameters:
        target: Tag-derived release identity.

    Returns:
        ReleaseDescriptor: The matching package data.

    Raises:
        ReleaseError: If the package has no unique descriptor.
    """
    descriptor = rd.descriptor_for(target.name)
    if descriptor is None:
        raise ReleaseError(f"No release descriptor for '{target.name}'")
    return descriptor


def resolve_target(repo: Path, tag: str) -> Target:
    """Resolve a descriptor-backed tag, refusing unknown, private or skewed packages.

    Parameters:
        repo: Tagged checkout.
        tag: GitHub ref name.

    Returns:
        Target: Validated release identity.

    Raises:
        ReleaseError: If descriptor, workspace or package identity validation fails.
    """
    match = TAG.fullmatch(tag)
    if match is None:
        raise ReleaseError(f"Invalid release tag: '{tag}'")
    descriptor = rd.descriptor_for(match["name"])
    if descriptor is None:
        raise ReleaseError(f"No release descriptor for '{match['name']}'")
    try:
        workspace = rd.resolve_workspace(repo, descriptor)
        raw = json.loads((workspace / "package.json").read_text(encoding="utf-8"))
    except (OSError, ValueError, json.JSONDecodeError) as e:
        raise ReleaseError(f"Cannot resolve release workspace for '{match['name']}': {e}") from e
    if not isinstance(raw, dict) or raw.get("private", False) is True:
        raise ReleaseError(f"Tag must name one public descriptor workspace: '{tag}'")
    try:
        manifest = pc.PackedManifestIdentity.model_validate(raw)
    except ValueError as e:
        raise ReleaseError(f"Invalid descriptor package manifest for '{match['name']}': {e}") from e
    if manifest.name != descriptor.name or manifest.version != match["version"]:
        raise ReleaseError(f"Tag version/name differs from descriptor workspace for '{match['name']}'")
    if descriptor.contract.name != descriptor.name:
        raise ReleaseError(f"Descriptor contract disagrees with package name: '{match['name']}'")
    return Target(
        tag=tag, name=manifest.name, version=manifest.version, directory=descriptor.contract.directory
    )


def release_workspace(repo: Path, descriptor: rd.ReleaseDescriptor) -> Path:
    """Resolve a registered workspace and require its package manifest.

    Parameters:
        repo: Repository root.
        descriptor: Package release data.

    Returns:
        Path: Existing package workspace within ``repo``.

    Raises:
        ReleaseError: If the descriptor workspace is unsafe or incomplete.
    """
    try:
        workspace = rd.resolve_workspace(repo, descriptor)
    except ValueError as e:
        raise ReleaseError(str(e)) from e
    if not workspace.is_dir() or not (workspace / "package.json").is_file():
        raise ReleaseError(f"Release workspace is not a package: '{descriptor.workspace}'")
    return workspace


def native_matches(workspace: Path, descriptor: rd.ReleaseDescriptor) -> tuple[Path, ...]:
    """Expand descriptor-native artifacts without allowing path traversal.

    Parameters:
        workspace: Validated package source directory.
        descriptor: Package release data.

    Returns:
        tuple[Path, ...]: Required regular files in deterministic order.

    Raises:
        ReleaseError: If a native-artifact pattern is unsafe or has no files.
    """
    matches: list[Path] = []
    for pattern in descriptor.native_artifacts:
        if pattern.is_absolute() or any(part in {"", ".", ".."} for part in pattern.parts):
            raise ReleaseError(f"Release descriptor has unsafe native artifact: '{pattern}'")
        found = sorted(path for path in workspace.glob(pattern.as_posix()) if path.is_file())
        if not found:
            raise ReleaseError(f"Missing native artifact: '{pattern}'")
        matches.extend(found)
    return tuple(matches)


def validate_native_sources(workspace: Path, descriptor: rd.ReleaseDescriptor) -> None:
    """Require every descriptor-native artifact before packing.

    Parameters:
        workspace: Validated package source directory.
        descriptor: Package release data.

    Returns:
        None: Required source artifacts exist.
    """
    native_matches(workspace, descriptor)


def validate_native_tarball(tarball: Path, descriptor: rd.ReleaseDescriptor) -> None:
    """Require descriptor-native artifacts in the accepted packed bytes.

    Parameters:
        tarball: One npm package tarball.
        descriptor: Package release data.

    Returns:
        None: Required native files are present beneath npm's ``package/`` root.

    Raises:
        ReleaseError: If packed bytes omit a required native artifact.
    """
    if not descriptor.native_artifacts:
        return
    with tarfile.open(tarball, "r:gz") as archive:
        entries = {member.name for member in archive.getmembers() if member.isfile()}
    for pattern in descriptor.native_artifacts:
        expression = re.compile("^package/" + re.escape(pattern.as_posix()).replace(r"\*", "[^/]*") + "$")
        if not any(expression.fullmatch(entry) for entry in entries):
            raise ReleaseError(f"Packed tarball omits native artifact: '{pattern}'")


def registry_dist(repo: Path, target: Target) -> Distribution | None:
    """Read exact-version npm metadata; only an explicit E404 means absent.

    Parameters:
        repo (Path): Working directory.
        target (Target): Exact package version.

    Returns:
        Distribution | None: Published distribution or an explicit registry miss.

    Raises:
        ReleaseError: On registry errors other than E404.
    """
    try:
        output = command(
            repo,
            "npm",
            "view",
            f"{target.name}@{target.version}",
            "dist",
            "--json",
            "--loglevel=silent",  # Keep npm's stderr diagnostics out of the JSON error body.
            "--prefer-online",  # Do not reuse cached pre-publication metadata during recovery.
            "--registry=https://registry.npmjs.org",
        )
    except subprocess.CalledProcessError as e:
        try:
            error = json.loads(e.output)
        except ValueError:
            raise ReleaseError(f"Registry lookup failed: {e.output}") from e
        if (
            isinstance(error, dict)
            and isinstance(error.get("error"), dict)
            and error["error"].get("code") == "E404"
        ):
            return None
        raise ReleaseError(f"Registry lookup failed: {e.output}") from e
    return Distribution.model_validate_json(output)


def preflight(repo: Path, tag: str) -> Target:
    """Require tag == HEAD, ancestry on freshly fetched main, matching version, and an unpublished version.

    Parameters:
        repo (Path): Full-history tagged checkout with origin/main fetched.
        tag (str): Trigger tag name.

    Returns:
        Target: Release selection after all checks pass.

    Raises:
        ReleaseError: If the source or registry preconditions fail.
    """
    target = resolve_target(repo, tag)
    head = command(repo, "git", "rev-parse", "HEAD")
    tagged = command(repo, "git", "rev-parse", f"refs/tags/{tag}^{{commit}}")
    if head != tagged:
        raise ReleaseError(f"HEAD '{head}' is not tagged commit '{tagged}'")
    try:
        command(repo, "git", "merge-base", "--is-ancestor", tagged, "origin/main")
    except subprocess.CalledProcessError as e:
        raise ReleaseError(
            f"Tagged commit '{tagged}' must be an ancestor of `origin/main`: {e.output}"
        ) from e
    if registry_dist(repo, target) is not None:
        raise ReleaseError(f"Already published: '{target.name}@{target.version}'; never republish")
    return target


def emit_outputs(**values: str) -> None:
    """Append validated single-line values to GitHub's output file when running in Actions.

    Parameters:
        **values (str): Step outputs.

    Returns:
        None: Outputs are appended when running in GitHub Actions.
    """
    output = os.environ.get("GITHUB_OUTPUT")
    if output:
        with Path(output).open("a", encoding="utf-8") as stream:
            for key, value in values.items():
                if "\n" in value or "\r" in value:
                    raise ReleaseError(f"Multiline output '{key}' is forbidden")
                stream.write(f"{key}={value}\n")


def verify(repo: Path, target: Target, output: Path) -> Identity:
    """Install, check, pack once, exercise those bytes, and record checksums plus a release manifest.

    Parameters:
        repo (Path): Clean tagged checkout, with the pinned Bun and optional contract fork installed.
        target (Target): Preflighted release.
        output (Path): New artifact directory OUTSIDE the checkout.

    Returns:
        Identity: Verified byte identity.
    """
    if output.exists() or output.is_relative_to(repo):
        raise ReleaseError(f"Artifact directory must be new and outside the checkout: '{output}'")
    descriptor = descriptor_for(target)
    for verify_command in descriptor.verify_commands:
        LOGGER.info(command(repo, verify_command[0], *verify_command[1:], timeout=1200))
    workspace = release_workspace(repo, descriptor)
    validate_native_sources(workspace, descriptor)
    output.mkdir(parents=True)
    contract = descriptor.contract
    with tempfile.TemporaryDirectory(prefix="npm-release-") as temporary:
        work = Path(temporary)
        sandbox = pc.Sandbox(work / "pack", pc.locate_tools())
        artifact = pc.pack(contract, output, sandbox, workspace)
        if artifact.version != target.version:
            raise ReleaseError("Packed version differs from release tag")
        validate_native_tarball(artifact.path, descriptor)
        supplied = {target.directory: artifact.path}
        stock = work / "stock"
        evidence: dict[str, str] = {}
        if "stock" in descriptor.contract_gates:
            gate = work / "standalone"
            gate.mkdir()
            report = pc.run_gate(gate, stock, [target.directory], supplied)
            evidence["stock_contract"] = report.model_dump_json()
        if "fork" in descriptor.contract_gates:
            gate = work / "fork-contract"
            gate.mkdir()
            report_fork = fork.run_fork_gate(gate, stock, repo, supplied)
            evidence["fork_contract"] = report_fork.model_dump_json()
        identity = Identity(
            target=target,
            commit=command(repo, "git", "rev-parse", "HEAD"),
            tarball=artifact.path.name,
            sha256=rm.sha256_file(artifact.path),
            integrity=artifact.integrity,
        )
        evidence["npm_integrity"] = identity.integrity
        manifest = rm.build_manifest(repo, target.tag, {target.name: str(artifact.path)}, {}, evidence)
        (output / "manifest.json").write_text(manifest.model_dump_json(indent=2) + "\n")
        (output / "identity.json").write_text(identity.model_dump_json(indent=2) + "\n")
        (output / "SHA256SUMS").write_text(f"{identity.sha256}  {identity.tarball}\n")
        # Detect any mutation during contract execution, rather than trusting the initial hash.
        check_artifact(repo, target.tag, output)
    return identity


def check_artifact(repo: Path, tag: str, output: Path) -> Identity:
    """Cross-check downloaded bytes, checksum, manifest, source commit and tag before publication.

    Parameters:
        repo (Path): Tagged checkout.
        tag (str): Trigger tag.
        output (Path): Downloaded artifact directory.

    Returns:
        Identity: Validated artifact metadata.
    """
    identity = Identity.model_validate_json((output / "identity.json").read_text())
    if identity.target != resolve_target(repo, tag):
        raise ReleaseError("Artifact target differs from release tag")
    if identity.commit != command(repo, "git", "rev-parse", "HEAD"):
        raise ReleaseError("Artifact source commit differs from checkout")
    descriptor = descriptor_for(identity.target)
    artifact = pc.load_tarball(descriptor.contract, output / identity.tarball)
    validate_native_tarball(artifact.path, descriptor)
    checksum = f"{identity.sha256}  {identity.tarball}\n"
    if (
        (output / "SHA256SUMS").read_text() != checksum
        or rm.sha256_file(artifact.path) != identity.sha256
        or artifact.integrity != identity.integrity
        or artifact.version != identity.target.version
    ):
        raise ReleaseError("Downloaded tarball checksum/integrity/version mismatch")
    manifest = rm.ReleaseManifest.model_validate_json((output / "manifest.json").read_text())
    expected = rm.artifacts({identity.target.name: str(artifact.path)}, {})
    if (
        manifest.artifacts != expected
        or manifest.release.commit != identity.commit
        or manifest.release.id != tag
        or manifest.release.dirty
    ):
        raise ReleaseError("Release manifest does not describe the verified artifact")
    return identity


def assert_toolchain(repo: Path) -> None:
    """Print and require stable Node >=22.14.0 and npm >=11.5.1 for OIDC.

    Parameters:
        repo (Path): Working directory.

    Returns:
        None: Both toolchains meet the OIDC minimum versions.
    """
    for tool, minimum in (("node", (22, 14, 0)), ("npm", (11, 5, 1))):
        version = command(repo, tool, "--version")
        LOGGER.info(f"{tool}: {version}")
        match = TOOL_VERSION.fullmatch(version)
        if match is None or tuple(map(int, match.groups())) < minimum:
            raise ReleaseError(f"Unsupported '{tool}' version '{version}', minimum {minimum}")


def confirm_registry_metadata(identity: Identity, dist: Distribution | None) -> None:
    """Wait for integrity and provenance metadata; this is not attestation verification.

    Parameters:
        identity (Identity): Verified artifact identity.
        dist (Distribution | None): Exact-version registry response.

    Returns:
        None: Metadata advertises matching bytes and a provenance bundle.

    Raises:
        ReleaseError: If publication is absent, changed, or lacks provenance.
    """
    if dist is None or dist.integrity != identity.integrity:
        raise ReleaseError("Registry integrity differs from verified tarball (or version is absent)")
    if (
        dist.attestations is None
        or dist.attestations.provenance is None
        or dist.attestations.provenance.predicateType != PROVENANCE_TYPE
    ):
        raise ReleaseError("Registry version has no provenance attestation")


def wait_for_registry(repo: Path, identity: Identity) -> None:
    """Bound propagation retries without ever retrying publication or accepting changed bytes.

    Parameters:
        repo (Path): Working directory for npm metadata reads.
        identity (Identity): Verified artifact identity.

    Returns:
        None: Registry metadata is visible and ready for attestation verification.

    Raises:
        ReleaseError: If bytes differ immediately, or metadata is still absent after ten minutes.
    """
    for attempt in range(REGISTRY_POLL_ATTEMPTS):
        dist = registry_dist(repo, identity.target)
        if dist is not None and dist.integrity != identity.integrity:
            raise ReleaseError("Registry integrity differs from verified tarball; refusing recovery")
        try:
            confirm_registry_metadata(identity, dist)
            return
        except ReleaseError:
            if attempt == REGISTRY_POLL_ATTEMPTS - 1:
                raise
            time.sleep(REGISTRY_POLL_INTERVAL_S)


def verify_signatures(identity: Identity) -> None:
    """Use npm to verify the release subject even when it has runtime dependencies.

    The ordinary install keeps the dependency closure intact and proves the selected
    lock entry has the expected version and integrity. A second, subject-only audit
    project copies only that installed package and its exact lock entry. npm then
    verifies one named package rather than an aggregate which a dependency could
    satisfy. Provenance subject/source binding remains a separate DSSE check.

    Parameters:
        identity: Exact released version and verified tarball integrity.

    Returns:
        None: npm has verified the selected package signature and attestation.

    Raises:
        ReleaseError: If the installed subject or npm verification report is incomplete.
        subprocess.CalledProcessError: If npm installation or cryptographic verification fails.
    """
    with tempfile.TemporaryDirectory(prefix="npm-signatures-") as temporary:
        project = Path(temporary)
        (project / "package.json").write_text('{"name":"release-signature-check","private":true}\n')
        LOGGER.info(
            command(
                project,
                "npm",
                "install",
                f"{identity.target.name}@{identity.target.version}",
                "--ignore-scripts",
                "--legacy-peer-deps",
                "--no-audit",
                "--no-fund",
                "--prefer-online",
                "--registry=https://registry.npmjs.org",
            )
        )
        lock_path = project / "package-lock.json"
        lock = pc.read_lockfile(lock_path)
        key = f"node_modules/{identity.target.name}"
        installed = lock.packages.get(key)
        if (
            installed is None
            or installed.version != identity.target.version
            or installed.integrity != identity.integrity
        ):
            raise ReleaseError("Signature audit installed bytes differ from the verified tarball")
        raw_lock = json.loads(lock_path.read_text(encoding="utf-8"))
        raw_entry = raw_lock.get("packages", {}).get(key) if isinstance(raw_lock, dict) else None
        if not isinstance(raw_entry, dict):
            raise ReleaseError("Signature audit lock lacks the selected package entry")
        subject = project / "subject"
        package = subject / key
        package.parent.mkdir(parents=True)
        shutil.copytree(project / key, package)
        (subject / "package.json").write_text(
            json.dumps(
                {
                    "name": "release-signature-subject",
                    "private": True,
                    "dependencies": {identity.target.name: identity.target.version},
                }
            )
            + "\n"
        )
        (subject / "package-lock.json").write_text(
            json.dumps(
                {
                    "name": "release-signature-subject",
                    "lockfileVersion": 3,
                    "requires": True,
                    "packages": {
                        "": {"dependencies": {identity.target.name: identity.target.version}},
                        key: raw_entry,
                    },
                }
            )
            + "\n"
        )
        report = command(
            subject,
            "npm",
            "audit",
            "signatures",
            "--color=false",
            "--prefer-online",
            "--registry=https://registry.npmjs.org",
        )
        LOGGER.info(report)
        required = {"1 package has a verified registry signature", "1 package has a verified attestation"}
        if not required <= set(report.splitlines()):
            raise ReleaseError("npm must verify the selected release signature AND attestation")


def fetch_attestations(target: Target) -> bytes:
    """Fetch actual bundles from the canonical npm endpoint, not an untrusted metadata URL.

    Parameters:
        target (Target): Exact public package version.

    Returns:
        bytes: Bounded registry attestation response.

    Raises:
        ReleaseError: If the response exceeds the size limit.
        OSError: If the bounded HTTPS fetch fails.
    """
    package = urllib.parse.quote(f"{target.name}@{target.version}", safe="@/")
    url = f"https://registry.npmjs.org/-/npm/v1/attestations/{package}"
    with urllib.request.urlopen(url, timeout=30) as response:
        content = response.read(MAX_ATTESTATION_BYTES + 1)
    if len(content) > MAX_ATTESTATION_BYTES:
        raise ReleaseError("Registry attestation response exceeds the size limit")
    return content


def verify_provenance(identity: Identity, content: bytes) -> None:
    """Bind the actual DSSE statement to the published bytes, workflow, tag and source commit.

    Signature verification belongs to npm, not this parser. Call after `verify_signatures` succeeds.

    Parameters:
        identity (Identity): Contract-tested tarball and tagged source identity.
        content (bytes): Actual npm attestation endpoint response.

    Returns:
        None: Only when the sole SLSA provenance statement describes this release.

    Raises:
        ReleaseError: If provenance or any expected binding is absent or different.
        ValueError: If the response, base64 payload or statement is malformed.
    """
    attestations = RegistryAttestations.model_validate_json(content)
    provenance = [a for a in attestations.attestations if a.predicateType == PROVENANCE_TYPE]
    if len(provenance) != 1:
        raise ReleaseError("Registry must return exactly one SLSA provenance attestation")
    payload = base64.b64decode(provenance[0].bundle.dsseEnvelope.payload, validate=True)
    statement = Statement.model_validate_json(payload)
    subject = statement.subject[0]
    expected_name = f"pkg:npm/{identity.target.name}@{identity.target.version}"
    expected_digest = base64.b64decode(identity.integrity.removeprefix("sha512-"), validate=True).hex()
    if urllib.parse.unquote(subject.name) != expected_name or subject.digest.get("sha512") != expected_digest:
        raise ReleaseError("Provenance subject or SHA-512 digest differs from the verified tarball")
    build = statement.predicate.buildDefinition
    expected_ref = f"refs/tags/{identity.target.tag}"
    expected_workflow = Workflow(repository=WORKFLOW_REPOSITORY, ref=expected_ref, path=WORKFLOW_PATH)
    if build.externalParameters.workflow != expected_workflow:
        raise ReleaseError("Provenance workflow repository, ref or path differs from the tagged release")
    source_uri = f"git+{WORKFLOW_REPOSITORY}@{expected_ref}"
    if not any(
        d.uri == source_uri and d.digest.get("gitCommit") == identity.commit
        for d in build.resolvedDependencies
    ):
        raise ReleaseError("Provenance source commit differs from the tagged release")


def verify_published(repo: Path, identity: Identity) -> None:
    """Require registry visibility, npm cryptographic verification and actual provenance binding.

    Parameters:
        repo (Path): Working directory for metadata probes.
        identity (Identity): Verified release identity.

    Returns:
        None: Only after all post-publication gates pass.
    """
    wait_for_registry(repo, identity)
    verify_signatures(identity)
    verify_provenance(identity, fetch_attestations(identity.target))
    LOGGER.info("Verified npm registry signatures, Sigstore attestations and tagged-source binding")


def main(argv: Sequence[str] | None = None) -> int:
    """Run one workflow stage without ever publishing.

    Parameters:
        argv (Sequence[str] | None): CLI arguments, or process arguments.

    Returns:
        int: Zero on success, one on a release refusal.
    """
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stage", choices=["preflight", "verify", "publish-check", "registry-check"])
    parser.add_argument("--tag", required=True)
    parser.add_argument("--repo-root", type=Path, default=pc.REPO_ROOT)
    parser.add_argument("--artifact-dir", type=Path)
    args = parser.parse_args(argv)
    repo = args.repo_root.resolve()
    try:
        if args.stage == "preflight":
            target = preflight(repo, args.tag)
            descriptor = descriptor_for(target)
            emit_outputs(
                workspace=target.name,
                directory=target.directory,
                needs_fork_contract=str("fork" in descriptor.contract_gates).lower(),
            )
            return 0
        if args.artifact_dir is None:
            raise ReleaseError("This stage requires `--artifact-dir`")
        output = args.artifact_dir.resolve()
        if args.stage == "verify":
            verify(repo, resolve_target(repo, args.tag), output)
            return 0
        assert_toolchain(repo)
        identity = check_artifact(repo, args.tag, output)
        if args.stage == "publish-check":
            dist = registry_dist(repo, identity.target)
            if dist is not None:
                if dist.integrity != identity.integrity:
                    raise ReleaseError("Registry integrity differs from verified tarball; refusing recovery")
                LOGGER.info("::notice::Already accepted with matching integrity; skipping publication")
            emit_outputs(publish=str(dist is None).lower(), tarball=identity.tarball)
        else:
            verify_published(repo, identity)
    except (
        ReleaseError,
        pc.ContractError,
        rm.ManifestError,
        OSError,
        ValueError,
        subprocess.SubprocessError,
    ) as e:
        detail = f"\n{e.output}" if isinstance(e, subprocess.CalledProcessError) else ""
        LOGGER.error(f"FAILED: {e}{detail}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
