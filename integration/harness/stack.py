"""Validated, explicit package sets and installed package resource lookup.

References:
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
from pathlib import Path
from typing import Any, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

LOGGER = logging.getLogger(__name__)
PINNED_NPM = re.compile(r"^npm:(?:@[^/\s]+/)?[^@/\s]+@\d+\.\d+\.\d+(?:-[\w.-]+)?$")
PINNED_GIT = re.compile(r"^git:github\.com/[^/\s]+/[^@/\s]+@[^\s]+$")


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


def source_string(package: str | PackageSource) -> str:
    """Return the identity used for installation, uniqueness and exclusions.

    Parameters:
        package (str | PackageSource): validated stack entry.

    Returns:
        str: Pi install source, without interpreting resource filters.
    """
    return package if isinstance(package, str) else package.source


class Stack(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)
    name: str = Field(min_length=1, pattern=r"^[a-z][a-z0-9-]*$", description="Evidence/golden identity")
    sources: list[str | PackageSource] = Field(
        min_length=1, description="Exact npm/git sources or stack-relative local paths"
    )
    settings: dict[str, Any] = Field(
        default_factory=dict, description="Pi settings overlay after installation"
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
            if not (
                PINNED_NPM.fullmatch(source)
                or PINNED_GIT.fullmatch(source)
                or source.startswith(("./", "../", "/"))
            ):
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


def load_stack(path: Path) -> Stack:
    """Validate a package-set file.

    Parameters:
        path (Path): explicit JSON document.

    Returns:
        Stack: schema-validated package set.
    """
    return Stack.model_validate_json(path.read_bytes())


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
