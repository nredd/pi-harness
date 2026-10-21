"""Validated package stacks, local derivation and installed resource lookup.

References:
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
from pathlib import Path
from typing import Any, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

LOGGER = logging.getLogger(__name__)
PINNED_NPM = re.compile(r"^npm:(?:@[^/\s]+/)?[^@/\s]+@\d+\.\d+\.\d+(?:-[\w.-]+)?$")
PINNED_GIT = re.compile(r"^git:github\.com/[^/\s]+/[^@/\s]+@v\d+\.\d+\.\d+(?:-[\w.-]+)?$")
CORE_TAG = re.compile(r"^v\d+\.\d+\.\d+-nredd\.\d+$")
LOCAL_SOURCE_PREFIXES = ("./", "../", "/")
OWNED_WORKSPACE_PATHS = {
    "@nredd/pi-dev-tools": "../../packages/dev-tools",
    "@nredd/pi-session-kit": "../../packages/session-kit",
    "@nredd/pi-subscription-router": "../../packages/subscription-router",
    "@nredd/pi-preset": "../../packages/preset",
}
PRESET_IDENTITY = "@nredd/pi-preset"


class PackageSource(BaseModel):
    # An omitted filter inherits the package manifest; an explicit empty list disables that kind.
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)
    source: str = Field(min_length=1, description="Exact npm/git source or explicit local path")
    extensions: list[str] = Field(
        default_factory=list,
        description="Pi extension filters; omitted inherits the manifest, empty disables",
    )
    skills: list[str] = Field(default_factory=list, description="Pi skill filters, if supplied")
    prompts: list[str] = Field(default_factory=list, description="Pi prompt filters, if supplied")
    themes: list[str] = Field(default_factory=list, description="Pi theme filters, if supplied")


class CoreRelease(BaseModel):
    """Exact core release data, independent of a machine's Homebrew installation."""

    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)
    tag: str = Field(pattern=CORE_TAG.pattern, description="Exact `forks/pi` release tag")
    integrity: dict[str, str] = Field(
        min_length=1,
        description="Release asset filename -> SHA-256 digest for formula-consumed core artifacts",
    )

    @model_validator(mode="after")
    def validate_integrity(self) -> Self:
        """Reject malformed core artifact checksums.

        Returns:
            Self: validated core release.

        Raises:
            ValueError: an asset name or SHA-256 digest is ambiguous.
        """
        if any("/" in name or not name.endswith(".tgz") for name in self.integrity):
            raise ValueError("`core.integrity` keys must be release tarball filenames")
        if any(re.fullmatch(r"[0-9a-f]{64}", digest) is None for digest in self.integrity.values()):
            raise ValueError("`core.integrity` values must be lowercase SHA-256 digests")
        return self


class Stack(BaseModel):
    """Authoritative shipped package selection and harness-only test settings."""

    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)
    schema_version: Literal[1]
    name: str = Field(min_length=1, pattern=r"^[a-z][a-z0-9-]*$", description="Evidence/golden identity")
    core: CoreRelease
    sources: list[str | PackageSource] = Field(
        min_length=1, description="Ordered exact extension sources or stack-relative local paths"
    )
    settings: dict[str, Any] = Field(
        default_factory=dict, description="Harness-only Pi settings overlay after installation"
    )
    disabled_extensions: dict[str, str] = Field(
        default_factory=dict, description="Source -> documented headless exclusion; still installed"
    )

    @model_validator(mode="after")
    def validate_sources(self) -> Self:
        """Reject floating, duplicate and implicit-home inputs before installation.

        Returns:
            Self: validated package set.

        Raises:
            ValueError: an input is ambiguous or could replace the installed package set.
        """
        sources = [source_string(package) for package in self.sources]
        if len(sources) != len(set(sources)):
            raise ValueError("`sources` must be unique by source string")
        for source in sources:
            if not (PINNED_NPM.fullmatch(source) or PINNED_GIT.fullmatch(source) or is_local_source(source)):
                raise ValueError(f"Source must be pinned or an explicit local path: '{source}'")
        if "packages" in self.settings:
            raise ValueError("`settings` cannot override `packages`")
        if not self.disabled_extensions.keys() <= set(sources) or not all(
            reason.strip() for reason in self.disabled_extensions.values()
        ):
            raise ValueError("`disabled_extensions` needs a reason for a declared source")
        return self

    def resolved_sources(self, path: Path) -> list[str]:
        """Resolve local sources relative to the supplied stack, never the caller's home.

        Parameters:
            path (Path): stack document.

        Returns:
            list[str]: install arguments.

        Raises:
            FileNotFoundError: a local package has no manifest.
        """
        resolved = []
        for package in self.sources:
            source = source_string(package)
            if source.startswith(("npm:", "git:")):
                resolved.append(source)
                continue
            local = (path.parent / source).resolve()
            if not (local / "package.json").is_file():
                raise FileNotFoundError(f"Local package has no `package.json`: '{local}'")
            resolved.append(str(local))
        return resolved


class LocalStackDocument(BaseModel):
    """Minimal descriptor for the generated development stack."""

    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)
    schema_version: Literal[1]
    name: Literal["local"]
    derived_from: Literal["personal.json"]


def source_string(package: str | PackageSource) -> str:
    """Return the identity used for installation, uniqueness and exclusions.

    Parameters:
        package (str | PackageSource): validated stack entry.

    Returns:
        str: Pi install source, without interpreting resource filters.
    """
    return package if isinstance(package, str) else package.source


def is_local_source(source: str) -> bool:
    """Return whether a source is an explicit local filesystem path.

    Parameters:
        source (str): declared package source.

    Returns:
        bool: whether `source` is resolved relative to the stack document or is absolute.
    """
    return source.startswith(LOCAL_SOURCE_PREFIXES)


def npm_identity(source: str) -> str | None:
    """Return an npm package identity without its exact version.

    Parameters:
        source (str): validated source string.

    Returns:
        str | None: package identity, or `None` for non-npm sources.
    """
    if not source.startswith("npm:"):
        return None
    return source.removeprefix("npm:").rsplit("@", 1)[0]


def derive_local_stack(personal: Stack) -> Stack:
    """Derive the full-preset development stack from the authoritative personal selection.

    Parameters:
        personal (Stack): shipped personal package selection.

    Returns:
        Stack: local workspace stack with the existing package order preserved.

    Raises:
        ValueError: the personal stack does not contain exactly one owned preset source.
    """
    derived_sources: list[str | PackageSource] = []
    preset_count = 0
    for package in personal.sources:
        source = source_string(package)
        identity = npm_identity(source)
        if identity == PRESET_IDENTITY:
            preset_count += 1
            continue
        local_source = OWNED_WORKSPACE_PATHS.get(identity or "")
        if local_source is None:
            derived_sources.append(package)
        elif isinstance(package, PackageSource):
            derived_sources.append(package.model_copy(update={"source": local_source}))
        else:
            derived_sources.append(local_source)
    if preset_count != 1:
        raise ValueError("Personal stack must declare exactly one `@nredd/pi-preset` source")
    derived_sources.append(OWNED_WORKSPACE_PATHS[PRESET_IDENTITY])
    replacements = {
        source_string(package): (
            OWNED_WORKSPACE_PATHS.get(npm_identity(source_string(package)) or "", source_string(package))
        )
        for package in personal.sources
    }
    return Stack(
        schema_version=personal.schema_version,
        name="local",
        core=personal.core,
        sources=derived_sources,
        settings=personal.settings,
        disabled_extensions={
            replacements[source]: reason for source, reason in personal.disabled_extensions.items()
        },
    )


def validate_shipped_stack(stack: Stack) -> None:
    """Reject local development sources in a shipped stack.

    Parameters:
        stack (Stack): canonical shipped stack.

    Raises:
        ValueError: the document has a local source or is not the personal selection.
    """
    if stack.name != "personal":
        raise ValueError("Shipped stack must be named `personal`")
    local_sources = [
        source_string(package) for package in stack.sources if is_local_source(source_string(package))
    ]
    if local_sources:
        raise ValueError(f"Shipped stack cannot declare local paths: {local_sources}")


def validate_local_derivation(personal: Stack, local: Stack) -> None:
    """Require the checked local stack to equal the authoritative derivation.

    Parameters:
        personal (Stack): canonical personal stack.
        local (Stack): generated local stack.

    Raises:
        ValueError: the local selection differs from the required derivation.
    """
    expected = derive_local_stack(personal)
    if local != expected:
        raise ValueError("Local stack does not match the personal-stack derivation")


def validate_release_identity(stack: Stack, gitlink_tag: str, checksums: dict[str, str]) -> None:
    """Require the stack core identity and recorded artifact integrity to agree.

    Parameters:
        stack (Stack): canonical personal stack.
        gitlink_tag (str): exact tag on the `forks/pi` Gitlink.
        checksums (dict[str, str]): release URL -> SHA-256 map from the release verifier.

    Raises:
        ValueError: the Gitlink tag or recorded core artifact integrity disagrees.
    """
    if stack.core.tag != gitlink_tag:
        raise ValueError(f"Stack core tag '{stack.core.tag}' does not match Gitlink tag '{gitlink_tag}'")
    base = f"https://github.com/nredd/pi/releases/download/{stack.core.tag}/"
    for name, digest in stack.core.integrity.items():
        if checksums.get(f"{base}{name}") != digest:
            raise ValueError(f"Stack core integrity does not match release asset '{name}'")


def load_stack(path: Path) -> Stack:
    """Load a strict stack document, deriving the local development selection on demand.

    Parameters:
        path (Path): explicit JSON document.

    Returns:
        Stack: schema-validated package set.
    """
    document = json.loads(path.read_bytes())
    if "derived_from" not in document:
        return Stack.model_validate(document)
    descriptor = LocalStackDocument.model_validate(document)
    personal_path = path.parent / descriptor.derived_from
    personal = load_stack(personal_path)
    local = derive_local_stack(personal)
    validate_local_derivation(personal, local)
    return local


def stack_digest(path: Path) -> str:
    """Return the SHA-256 of the exact supplied document bytes.

    Parameters:
        path (Path): stack file.

    Returns:
        str: hexadecimal digest.
    """
    return hashlib.sha256(path.read_bytes()).hexdigest()


def package_directory(source: str, agent_dir: Path) -> Path:
    """Resolve only a declared source inside an explicitly installed agent tree.

    Parameters:
        source (str): source installed through `pi install`.
        agent_dir (Path): sandbox agent root.

    Returns:
        Path: package directory.

    Raises:
        FileNotFoundError: the source has not been installed.
    """
    if source.startswith("npm:"):
        spec = source.removeprefix("npm:").rsplit("@", 1)[0]
        path = agent_dir / "npm" / "node_modules" / spec
    elif source.startswith("git:"):
        spec = source.removeprefix("git:").rsplit("@", 1)[0]
        path = agent_dir / "git" / spec
    else:
        path = Path(source)
    if not (path / "package.json").is_file():
        raise FileNotFoundError(f"Declared package is not installed: '{source}' at '{path}'")
    return path


def find_package(name: str, packages: list[Any], agent_dir: Path) -> Path:
    """Find a package by its manifest name, not an owner's checkout convention.

    Parameters:
        name (str): short name or exact npm name.
        packages (list[Any]): supplied sandbox settings entries.
        agent_dir (Path): sandbox install root.

    Returns:
        Path: installed package.

    Raises:
        LookupError: the package set does not contain the name.
    """
    for package in packages:
        source = package["source"] if isinstance(package, dict) else package
        directory = package_directory(source, agent_dir)
        actual = json.loads((directory / "package.json").read_text())["name"]
        if actual == name or actual.rsplit("/", 1)[-1] == name:
            return directory
    raise LookupError(f"Package '{name}' is not declared in this stack")
