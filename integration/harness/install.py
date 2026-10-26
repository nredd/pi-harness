"""Install one attested, promoted `stack/<sha>` into a user's Pi home, independent of any dotfiles.

Order of operations, every step fail-closed:

0. Restore an interrupted switch from its journal, offline and with consent (`--plan` only reports it).
1. Check the platform, prerequisites and one-filesystem layout, all at once, before touching anything.
2. Download `stack-snapshot.json` and its public attestation bundle, verify the attestation
   against `promote-stack.yml` on `refs/heads/main`, then validate it with `StackSnapshot` and
   require its `source_sha` to equal the pin.
3. Verify the core release assets (recorded digests, plus provenance for non-legacy tags) and
   the Node.js engine the core declares.
4. Print the plan. Anything that would overwrite existing state needs consent.
5. Stage the core and every package outside the live tree, verify installed versions and owned
   npm integrity against the snapshot, then switch over under a journal that a rerun rolls back.

Only the stack's own state is managed: the core prefix, a `pi` link, the agent `npm`/`git`
package trees, the `packages` and stack settings keys, and `subagents.json` `packageAgents`.
Credentials, models, sessions, memory and every other file are never read or written.

References:
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md
- https://docs.github.com/rest/users/attestations
- https://cli.github.com/manual/gh_attestation_verify
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import platform
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import uuid
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import IntEnum
from pathlib import Path
from typing import TYPE_CHECKING, Any
from urllib.error import HTTPError
from urllib.request import urlopen

# Native Windows has no fcntl: let platform/lock admission refuse it without an import traceback.
try:
    import fcntl
except ModuleNotFoundError:
    fcntl = None

from harness.files import NonRegularFileError, entry_kind
from harness.files import read_regular as read_regular_file
from harness.paths import is_wsl
from harness.promotion import (
    SHA_PATTERN,
    SNAPSHOT_ASSET,
    SNAPSHOT_REPO,
    SNAPSHOT_SIGNER_WORKFLOW,
    SNAPSHOT_SOURCE_REF,
    PromotionError,
    StackSnapshot,
    load_promoted_snapshot,
    snapshot_url,
    verify_core_assets,
)
from harness.release import (
    fetch_release,
    release_asset_url,
    release_checksums,
    release_tarballs,
    verify_asset,
    verify_provenance_anonymously,
    verify_public_attestation,
    without_github_tokens,
)
from harness.sandbox import deep_merge
from harness.stack import (
    CORE_TAG,
    install_overrides,
    installed_identities,
    package_agents_policy,
    package_declarations,
    source_string,
    validate_release_identity,
    validate_shipped_stack,
)

if TYPE_CHECKING:
    from collections.abc import Callable, Iterator, Mapping

    from harness.stack import Stack

LOGGER = logging.getLogger(__name__)
SEMVER = re.compile(r"(\d+)\.(\d+)\.(\d+)")
NODE_ENGINE = re.compile(r"^>=\s*(\d+\.\d+\.\d+)$")
# Only platforms an installer run was recorded on. Others are refused, not guessed.
SUPPORTED_PLATFORMS = {("Darwin", "arm64"): "macOS on Apple silicon", ("Linux", "x86_64"): "Linux x86-64"}
REQUIRED_TOOLS = {
    "gh": "GitHub CLI verifies the snapshot and core attestations (no login needed): https://cli.github.com",
    "node": "Node.js runs Pi: https://nodejs.org",
    "npm": "npm installs the core and packages; it ships with Node.js",
}
PACKAGE_TREES = ("npm", "git")
# The documented `uvx --exclude-newer` bound: the installer's own Python dependencies resolve as
# of this instant, never "latest". Bump it deliberately with the installer's dependencies.
EXCLUDE_NEWER = "2026-10-23T00:00:00Z"
# The documented `uvx --python`: the interpreter `ty` and the unit gate check, not the newest one.
INSTALLER_PYTHON = "3.13"
INSTALL_TIMEOUT = 600
VERSION_TIMEOUT = 60
STATE_FILE = "installed.json"
JOURNAL_FILE = "transaction.json"
# Only the owner may write or read the journal: it names every path a restore deletes.
JOURNAL_MODE = 0o600
LINK_BACKUP = "bin-pi"
CORE_MARKER = "pi-stack-core.json"
SETTINGS_FILE = "settings.json"
SUBAGENTS_FILE = "subagents.json"
SELF_CONFIGURED = (
    "provider login (`pi`, then `/login`) and any API keys",
    "default model, enabled models and router profiles",
    "memory, sessions, MCP servers, themes and personal prompts or skills",
)


class ExitCode(IntEnum):
    """Process exit status, one per outcome a caller may branch on."""

    OK = 0
    FAILED = 1
    UNSUPPORTED = 2
    VERIFICATION = 3
    CONSENT = 4


class InstallError(Exception):
    """The installation could not complete; the live tree is unchanged or was restored."""


class UnsupportedError(InstallError):
    """Unusable input, platform, filesystem layout or prerequisite; nothing was changed.

    A malformed stack SHA is a usage error and shares this status with argparse's own usage
    errors (`2`).
    """


class VerificationError(InstallError):
    """The snapshot, its attestation or the core release failed verification; nothing was changed."""


class ConsentError(InstallError):
    """The plan overwrites existing state and the user did not agree; nothing was changed."""


class RollbackError(InstallError):
    """An interrupted switch could not be fully restored; the journal and backups are kept."""


def expand_tilde(value: str, home: Path) -> Path:
    """Expand a leading `~` or `~/` the way Pi expands `PI_CODING_AGENT_DIR`.

    Pi (`expandTildePath` in `packages/coding-agent/src/config.ts`, which delegates to
    `normalizePath` in `packages/coding-agent/src/utils/paths.ts`) maps `~` to the home
    directory and `~/<rest>` to `<home>/<rest>`. Nothing else is expanded: not `~user`, not
    `$VAR`, not a `~` anywhere but the start. Pi also converts a value matching `^file://` with
    Node's `fileURLToPath`; that is refused here rather than reimplemented, so the installer
    never writes somewhere Pi does not read. Any other `file:` value is a relative path to both.

    Parameters:
        value (str): the raw environment value.
        home (Path): the user's home directory, injected rather than read from the environment.

    Returns:
        Path: the expanded path, or `value` unchanged.

    Raises:
        UnsupportedError: `value` is a `file://` URL.
    """
    if value.startswith("file://"):
        raise UnsupportedError(
            f"`PI_CODING_AGENT_DIR` '{value}' is a `file://` URL; set it to the plain path, nothing changed"
        )
    if value == "~":
        return home
    if value.startswith("~/"):
        # Like `path.join(home, rest)`: a leading `/` in the rest must not make it absolute.
        return home / value[2:].lstrip("/")
    return Path(value)


@dataclass(frozen=True)
class Layout:
    """Every path the installer owns or edits."""

    root: Path
    agent_dir: Path
    bin_dir: Path

    @classmethod
    def from_env(cls, env: Mapping[str, str], home: Path, bin_dir: Path | None) -> Layout:
        """Resolve the layout from the environment Pi itself honors.

        Parameters:
            env (Mapping[str, str]): process environment.
            home (Path): the user's home directory.
            bin_dir (Path | None): explicit link directory, default `~/.local/bin`.

        Returns:
            Layout: the resolved paths.
        """
        # Real paths: npm records lockfile keys relative to symlinked parents (e.g. macOS `/tmp`),
        # which would hide the packages it installed from the integrity check.
        home = home.resolve()
        data = Path(env["XDG_DATA_HOME"]) if env.get("XDG_DATA_HOME") else home / ".local" / "share"
        agent = (
            expand_tilde(env["PI_CODING_AGENT_DIR"], home)
            if env.get("PI_CODING_AGENT_DIR")
            else home / ".pi" / "agent"
        )
        links = bin_dir or home / ".local" / "bin"
        return cls((data / "pi-stack").resolve(), agent.resolve(), links.resolve())

    @property
    def backups(self) -> Path:
        """Store holding one directory per run of everything that run replaced."""
        return self.root / "backups"

    def core(self, tag: str) -> Path:
        """Return the immutable prefix of one core release.

        Parameters:
            tag (str): core tag.

        Returns:
            Path: the prefix.
        """
        return self.root / "core" / tag

    @property
    def link(self) -> Path:
        """The `pi` executable link."""
        return self.bin_dir / "pi"

    @property
    def state(self) -> Path:
        """Record of the last completed installation."""
        return self.root / STATE_FILE

    @property
    def journal(self) -> Path:
        """Switch-over journal; present only while a switch is incomplete."""
        return self.root / JOURNAL_FILE


@dataclass(frozen=True)
class Verified:
    """A snapshot whose attestation, schema, pin and core release all verified."""

    snapshot: StackSnapshot
    sources: list[str]
    # Release URL -> SHA-256 the staged core download must match. Every asset the snapshot
    # records carries the snapshot's digest, so the installed bytes are the verified ones.
    core_checksums: dict[str, str]

    @property
    def stack(self) -> Stack:
        """The promoted stack."""
        return self.snapshot.stack


@dataclass
class Plan:
    """Changes one run would make, split into additions and overwrites of existing state."""

    install_core: bool = False
    install_packages: bool = False
    link: str | None = None
    settings: dict[str, Any] | None = None
    subagents: dict[str, Any] | None = None
    creates: list[str] = field(default_factory=list)
    overwrites: list[str] = field(default_factory=list)

    @property
    def empty(self) -> bool:
        """Whether the installation already matches the snapshot."""
        return not (self.creates or self.overwrites)


def node_version(node: str) -> tuple[int, int, int]:
    """Return the installed Node.js version.

    Parameters:
        node (str): absolute `node` path.

    Returns:
        tuple[int, int, int]: major, minor, patch.

    Raises:
        UnsupportedError: `node --version` failed or printed no version.
    """
    try:
        output = subprocess.check_output(
            [node, "--version"],
            text=True,
            stderr=subprocess.STDOUT,
            timeout=VERSION_TIMEOUT,
            env=without_github_tokens(os.environ),
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise UnsupportedError(f"Could not run '{node} --version': {error}") from error
    match = SEMVER.search(output)
    if match is None:
        raise UnsupportedError(f"`node --version` printed no version: '{output.strip()}'")
    major, minor, patch = (int(part) for part in match.groups())
    return major, minor, patch


def preflight(
    system: str,
    machine: str,
    which: Callable[[str], str | None] = shutil.which,
    *,
    wsl: bool | None = None,
) -> dict[str, str]:
    """Check the platform and every prerequisite, reporting all problems at once.

    WSL reports `Linux/x86_64` but was never an installer acceptance platform, so the physical
    check (`harness.paths.is_wsl`) refuses it. There is no flag to bypass it.

    Parameters:
        system (str): `platform.system()`.
        machine (str): `platform.machine()`.
        which (Callable[[str], str | None]): executable lookup.
        wsl (bool | None): whether this is WSL; `None` detects it on Linux. Tests inject it.

    Returns:
        dict[str, str]: tool name -> absolute path as discovered, links not followed.

    Raises:
        UnsupportedError: the platform is unsupported, this is WSL, or a tool is missing.
    """
    problems = []
    if (system, machine) not in SUPPORTED_PLATFORMS:
        supported = ", ".join(f"{name} ({os_}/{arch})" for (os_, arch), name in SUPPORTED_PLATFORMS.items())
        problems.append(f"platform '{system}/{machine}' is not supported; tested: {supported}")
    detected = wsl if wsl is not None else system == "Linux" and is_wsl()
    if detected:
        problems.append("Windows Subsystem for Linux (WSL) is not supported; use native Linux or macOS")
    tools = {}
    for name, reason in REQUIRED_TOOLS.items():
        path = which(name)
        if path is None:
            problems.append(f"`{name}` not found on PATH: {reason}")
        else:
            # Absolute, not resolved: Volta, mise and similar managers link `node` to one dispatcher
            # that picks the runtime from its own name (`argv[0]`), so the link target is not Node.js.
            tools[name] = str(Path(path).absolute())
    if problems:
        raise UnsupportedError("Prerequisites not met, nothing changed:\n- " + "\n- ".join(problems))
    return tools


def required_node(tarball: Path) -> tuple[int, int, int]:
    """Read the minimum Node.js version from a verified core tarball's `engines`.

    Parameters:
        tarball (Path): verified `pi-coding-agent` release tarball.

    Returns:
        tuple[int, int, int]: minimum major, minor, patch.

    Raises:
        VerificationError: the manifest has malformed consumed fields or an unsupported Node range.
    """
    try:
        with tarfile.open(tarball) as archive:
            member = archive.extractfile("package/package.json")
            manifest = json.loads(member.read()) if member is not None else {}
    except (OSError, KeyError, tarfile.TarError, ValueError) as error:
        raise VerificationError(f"Could not read the core manifest from '{tarball.name}': {error}") from error
    label = f"Core `package.json` from '{tarball.name}'"
    if not isinstance(manifest, dict):
        raise VerificationError(f"{label} must be an object")
    if manifest.get("name") != "@earendil-works/pi-coding-agent":
        raise VerificationError(f"{label} must name '@earendil-works/pi-coding-agent' in `name`")
    version = manifest.get("version")
    if not isinstance(version, str) or SEMVER.fullmatch(version) is None:
        raise VerificationError(f"{label} must declare a numeric major.minor.patch string in `version`")
    binaries = manifest.get("bin")
    if not isinstance(binaries, dict):
        raise VerificationError(f"{label} must declare a `bin` object mapping `pi` to its CLI path")
    binary = binaries.get("pi")
    if not isinstance(binary, str) or not binary.strip():
        raise VerificationError(f"{label} must declare a nonempty CLI path string in `bin.pi`")
    engines = manifest.get("engines")
    if not isinstance(engines, dict):
        raise VerificationError(f"{label} must declare an `engines` object with a `node` range")
    engine = engines.get("node")
    match = NODE_ENGINE.fullmatch(engine) if isinstance(engine, str) else None
    if match is None:
        raise VerificationError(f"{label} must declare a supported `engines.node` range, e.g. '>=22.19.0'")
    major, minor, patch = (int(part) for part in match.group(1).split("."))
    return major, minor, patch


def download(url: str, destination: Path) -> Path:
    """Download one public URL without credentials.

    Parameters:
        url (str): HTTPS URL.
        destination (Path): file to write.

    Returns:
        Path: `destination`.

    Raises:
        VerificationError: the URL does not exist or could not be read.
    """
    try:
        with urlopen(url, timeout=120) as response:
            destination.write_bytes(response.read())
    except HTTPError as error:
        raise VerificationError(f"Could not download '{url}': HTTP {error.code}") from error
    except OSError as error:
        raise VerificationError(f"Could not download '{url}': {error}") from error
    return destination


def verify_snapshot(source_sha: str, workdir: Path) -> StackSnapshot:
    """Download a promoted snapshot, verify its attestation, then validate it against the pin.

    Parameters:
        source_sha (str): pinned promoted commit.
        workdir (Path): private temporary directory.

    Returns:
        StackSnapshot: the verified snapshot.

    Raises:
        VerificationError: the release is missing, unattested, attested by another identity, invalid
            or for another commit.
    """
    path = download(snapshot_url(source_sha), workdir / SNAPSHOT_ASSET)
    try:
        verify_public_attestation(path, SNAPSHOT_REPO, SNAPSHOT_SIGNER_WORKFLOW, SNAPSHOT_SOURCE_REF)
    except (OSError, RuntimeError) as error:
        raise VerificationError(f"Snapshot attestation rejected: {error}") from error
    try:
        snapshot = load_promoted_snapshot(path.read_bytes(), source_sha)
        validate_shipped_stack(snapshot.stack)
    except ValueError as error:
        raise VerificationError(f"Snapshot rejected: {error}") from error
    LOGGER.info(
        f"Verified `stack/{source_sha}`: attested by {SNAPSHOT_SIGNER_WORKFLOW} on {SNAPSHOT_SOURCE_REF}"
    )
    return snapshot


def verify_release(snapshot: StackSnapshot, node: str, workdir: Path) -> Verified:
    """Verify the snapshot's core release and that the installed Node.js can run it.

    Parameters:
        snapshot (StackSnapshot): verified snapshot.
        node (str): absolute `node` path.
        workdir (Path): private temporary directory.

    Returns:
        Verified: the verified installation input.

    Raises:
        VerificationError: core digests or provenance disagree.
        UnsupportedError: Node.js is older than the core requires.
    """
    stack = snapshot.stack
    tag = stack.core.tag
    try:
        checksums = release_checksums(tag)
        validate_release_identity(stack, tag, checksums)
        tarballs = release_tarballs(tag)[:2]
        missing = [name for name in tarballs if name not in stack.core.integrity]
        if missing:
            raise ValueError(f"the snapshot records no integrity for installed asset(s) {', '.join(missing)}")
        verify_core_assets(stack, workdir / "core", attest=verify_provenance_anonymously)
    except (ValueError, PromotionError, RuntimeError) as error:
        raise VerificationError(f"Core release '{tag}' rejected: {error}") from error
    core_checksums = checksums | {
        release_asset_url(tag, name): digest for name, digest in stack.core.integrity.items()
    }
    name = tarballs[0]
    tarball = workdir / "core" / name
    if not tarball.is_file():
        # Legacy tags verify against frozen digests without downloading; fetch the manifest's tarball.
        url = release_asset_url(tag, name)
        tarball = download(url, workdir / name)
        try:
            verify_asset(tarball, url, core_checksums)
        except ValueError as error:
            raise VerificationError(f"Core asset '{name}' rejected: {error}") from error
    minimum, installed = required_node(tarball), node_version(node)
    if installed < minimum:
        raise UnsupportedError(
            f"Node.js {'.'.join(map(str, installed))} is older than the {'.'.join(map(str, minimum))} "
            f"core '{stack.core.tag}' requires; upgrade Node.js, nothing changed"
        )
    LOGGER.info(
        f"Verified core '{stack.core.tag}' assets; Node.js {'.'.join(map(str, installed))} is supported"
    )
    return Verified(snapshot, [source_string(package) for package in stack.sources], core_checksums)


def device(path: Path) -> int:
    """Return the filesystem device of a path, or of its nearest existing ancestor.

    Parameters:
        path (Path): absolute path that may not exist yet.

    Returns:
        int: `st_dev`.
    """
    while not path.exists() and path != path.parent:
        path = path.parent
    return path.stat().st_dev


def require_one_filesystem(layout: Layout) -> None:
    """Refuse a layout whose switch-over renames would cross filesystems.

    Staging and backups live under the installer root and are moved into the agent and link
    directories with `rename(2)`, which fails with `EXDEV` across filesystems. That is refused
    here, before anything changes, instead of failing mid-switch.

    Parameters:
        layout (Layout): installer paths.

    Raises:
        UnsupportedError: the installer root, agent dir and link dir are not on one filesystem.
    """
    # The installer directory's own `staging`, `backups` and `core` may be mount points.
    paths = (
        layout.root,
        layout.root / "staging",
        layout.backups,
        layout.root / "core",
        layout.agent_dir,
        layout.bin_dir,
    )
    if len({device(path) for path in paths}) > 1:
        raise UnsupportedError(
            "The installer directory (with its `staging`, `backups` and `core`), agent directory and "
            f"link directory must be on one filesystem ('{layout.root}', '{layout.agent_dir}', "
            f"'{layout.bin_dir}'); move `XDG_DATA_HOME`, "
            "`PI_CODING_AGENT_DIR` or `--bin-dir` so they share one, nothing changed"
        )


def is_real_directory_or_absent(path: Path) -> bool:
    """Report whether a path is a real directory (not a link) or does not exist yet.

    Shared by the journal reader and the backup writer so they can never disagree.

    Parameters:
        path (Path): store or backup directory.

    Returns:
        bool: `True` for a directory or an absent path.
    """
    return entry_kind(path) in {None, "directory"}


def require_backup_store(layout: Layout) -> None:
    """Refuse a backup store the journal reader would refuse, before anything is written to it.

    This is the early planning check. The switch also anchors writes to open, no-follow directory
    descriptors, since a path-only check cannot protect the later rename.

    Parameters:
        layout (Layout): installer paths.

    Raises:
        UnsupportedError: the store exists as anything but a real directory.
    """
    if not is_real_directory_or_absent(layout.backups):
        raise UnsupportedError(
            f"Backup store '{layout.backups}' is a {entry_kind(layout.backups)}; the installer keeps "
            "backups only in a real directory there. Move it aside yourself, nothing changed"
        )


def refuse_symlink(path: Path) -> None:
    """Refuse to replace a symlinked settings file before anything changes.

    The atomic replace would turn the link into a regular file and its backup into a copy of the
    target, so rollback could not restore the link. The user's own link stays theirs to resolve.

    Parameters:
        path (Path): settings file the plan would write.

    Raises:
        InstallError: `path` is a symlink.
    """
    if path.is_symlink():
        raise InstallError(
            f"'{path}' is a symlink to '{path.readlink()}'; the installer would replace the link, not "
            "its target. Replace it with a regular file or move it, nothing changed"
        )


def read_json(path: Path) -> dict[str, Any]:
    """Read a JSON object, treating a missing file as empty.

    Parameters:
        path (Path): file.

    Returns:
        dict[str, Any]: the object.

    Raises:
        InstallError: the file exists but is not a JSON object; it is never overwritten blindly.
        UnsupportedError: the path, or its link target, is not a regular file.
    """
    try:
        text = read_regular(path, follow=True)
        if text is None:
            return {}
        value = json.loads(text)
    except (OSError, ValueError) as error:
        raise InstallError(
            f"Existing '{path}' is not readable JSON; fix or move it, nothing changed: {error}"
        ) from error
    if not isinstance(value, dict):
        raise InstallError(f"Existing '{path}' is not a JSON object; fix or move it, nothing changed")
    return value


def core_ready(layout: Layout, stack: Stack) -> bool:
    """Report whether a previously installed core prefix matches the stack's verified identity.

    Parameters:
        layout (Layout): installer paths.
        stack (Stack): verified stack.

    Returns:
        bool: whether the prefix carries a matching marker and its `pi` executable.
    """
    prefix = layout.core(stack.core.tag)
    marker = read_marker(prefix / CORE_MARKER)
    return marker == stack.core.model_dump(mode="json") and (prefix / "bin" / "pi").is_file()


def read_marker(path: Path) -> object:
    """Read an installer-written JSON marker, `None` when absent, unreadable or not a regular file.

    A link or special file is never followed or opened for reading; whoever plans a replacement
    of the path refuses its kind (`require_restorable_kind`).

    Parameters:
        path (Path): marker file.

    Returns:
        object: decoded JSON, or `None`.
    """
    try:
        text = read_regular(path, follow=False)
        return None if text is None else json.loads(text)
    except (OSError, ValueError, UnsupportedError):
        return None


def read_regular(path: Path, *, follow: bool) -> str | None:
    """Read a regular file, refusing any other kind before opening it.

    Opening a FIFO for reading blocks until a writer appears, and a socket cannot be opened at
    all, so the kind is checked first, without following a final link unless `follow` allows
    one to a regular file. The open is non-blocking and re-checked with `fstat` in case the
    entry changed in between.

    Parameters:
        path (Path): file.
        follow (bool): accept a symlink whose target is a regular file; a dangling one is absent.

    Returns:
        str | None: contents, `None` when absent.

    Raises:
        UnsupportedError: the path, or the target it is allowed to follow, is not a regular file.
        OSError: the file cannot be read.
    """
    try:
        return read_regular_file(path, follow=follow)
    except NonRegularFileError as error:
        raise UnsupportedError(str(error)) from error


def packages_ready(layout: Layout, verified: Verified) -> bool:
    """Report whether the live package trees already hold this snapshot's exact packages.

    Parameters:
        layout (Layout): installer paths.
        verified (Verified): verified installation input.

    Returns:
        bool: whether the last completed install was this snapshot and every version still matches.
    """
    state = read_marker(layout.state)
    if not isinstance(state, dict) or state.get("stack_sha256") != verified.snapshot.stack_sha256:
        return False
    try:
        installed_identities(verified.stack, verified.sources, layout.agent_dir)
        verify_owned_integrity(verified.snapshot, layout.agent_dir)
    except (OSError, ValueError, InstallError):
        return False
    return True


def plan_install(layout: Layout, verified: Verified) -> Plan:
    """Compare the live installation with the snapshot and list every change.

    Parameters:
        layout (Layout): installer paths.
        verified (Verified): verified installation input.

    Returns:
        Plan: additions and overwrites, empty when already installed.

    Raises:
        InstallError: an existing settings file is unreadable.
    """
    stack, plan = verified.stack, Plan()
    prefix = layout.core(stack.core.tag)
    if not core_ready(layout, stack):
        require_restorable_kind(layout, prefix)
        plan.install_core = True
        # A dangling link is still replaced, so it counts as existing state (consent required).
        target = plan.overwrites if prefix.exists(follow_symlinks=False) else plan.creates
        target.append(f"install core '{stack.core.tag}' into '{prefix}'")
    executable = str(prefix / "bin" / "pi")
    if not (layout.link.is_symlink() and str(layout.link.readlink()) == executable):
        plan.link = executable
        if layout.link.exists() or layout.link.is_symlink():
            plan.overwrites.append(
                f"replace '{layout.link}' (now '{describe(layout.link)}') with a link to '{executable}'"
            )
        else:
            plan.creates.append(f"link '{layout.link}' -> '{executable}'")
    if not packages_ready(layout, verified):
        plan.install_packages = True
        for tree in PACKAGE_TREES:
            if (layout.agent_dir / tree).exists(follow_symlinks=False):
                plan.overwrites.append(f"replace package tree '{layout.agent_dir / tree}' (backed up)")
        plan.creates.append(
            f"install {len(verified.sources)} packages in stack order into '{layout.agent_dir}'"
        )
    settings_path = layout.agent_dir / SETTINGS_FILE
    current = read_json(settings_path)
    desired = deep_merge(current, stack.settings) | {
        "packages": package_declarations(stack, verified.sources)
    }
    if desired != current:
        refuse_symlink(settings_path)
        plan.settings = desired
        changed = sorted(key for key in desired if desired.get(key) != current.get(key))
        message = f"set {', '.join(f'`{key}`' for key in changed)} in '{settings_path}'"
        (plan.overwrites if current else plan.creates).append(message)
        existing = current.get("packages")
        existing = existing if isinstance(existing, list) else []
        dropped = sorted(set(map(declared_source, existing)) - set(verified.sources))
        if dropped:
            plan.overwrites.append(f"stop loading packages not in the stack: {', '.join(dropped)}")
    subagents_path = layout.agent_dir / SUBAGENTS_FILE
    current_subagents = read_json(subagents_path)
    desired_subagents = deep_merge(current_subagents, package_agents_policy(stack))
    if desired_subagents != current_subagents:
        refuse_symlink(subagents_path)
        plan.subagents = desired_subagents
        message = f"set `packageAgents: false` in '{subagents_path}' so filtered packages stay filtered"
        (plan.overwrites if current_subagents else plan.creates).append(message)
    if not plan.empty:
        # Before consent: a kind the journal cannot restore must never be moved into a backup.
        for target in replaced_targets(layout, plan):
            require_restorable_kind(layout, target)
        require_backup_store(layout)
    return plan


def replaced_targets(layout: Layout, plan: Plan) -> list[Path]:
    """List every existing path a switch for this plan may replace.

    Parameters:
        layout (Layout): installer paths.
        plan (Plan): non-empty plan.

    Returns:
        list[Path]: targets, the state record always included.
    """
    targets = [layout.agent_dir / tree for tree in PACKAGE_TREES] if plan.install_packages else []
    if plan.settings is not None:
        targets.append(layout.agent_dir / SETTINGS_FILE)
    if plan.subagents is not None:
        targets.append(layout.agent_dir / SUBAGENTS_FILE)
    if plan.link is not None:
        targets.append(layout.link)
    return [*targets, layout.state]


def require_restorable_kind(layout: Layout, target: Path, outcome: str = "nothing changed") -> None:
    """Refuse to replace an entry whose backup the journal validator would not restore.

    Parameters:
        layout (Layout): installer paths.
        target (Path): path a switch replaces.
        outcome (str): what the refusal leaves behind, for the message.

    Raises:
        UnsupportedError: `target` exists as a kind its backup may not hold.
    """
    try:
        _, kinds = journaled_path(layout, target)
    except ValueError as error:
        raise UnsupportedError(f"Cannot safely replace '{target}': {error}; {outcome}") from error
    kind = entry_kind(target)
    if kind is not None and kind not in kinds:
        raise UnsupportedError(
            f"'{target}' is a {kind}; the installer only replaces a {' or '.join(sorted(kinds))} there. "
            f"Move it aside yourself, {outcome}"
        )


def declared_source(package: object) -> str:
    """Return the source of one existing `packages` entry.

    Parameters:
        package (object): a string or `{source: ...}` entry.

    Returns:
        str: the source, or its JSON when malformed.
    """
    if isinstance(package, dict) and isinstance(package.get("source"), str):
        return package["source"]
    return package if isinstance(package, str) else json.dumps(package)


def describe(path: Path) -> str:
    """Describe an existing path for the plan.

    Parameters:
        path (Path): existing file, directory or link.

    Returns:
        str: link target, or the kind of entry.
    """
    if path.is_symlink():
        return f"link to {path.readlink()}"
    return "directory" if path.is_dir() else "file"


def owned_lock_entries(agent_dir: Path) -> dict[str, Any]:
    """Read the npm lockfile of the agent's npm package tree.

    Parameters:
        agent_dir (Path): agent tree.

    Returns:
        dict[str, Any]: lockfile `packages` entries keyed by `node_modules/<name>`; a value need
            not be an object in a malformed lockfile.

    Raises:
        InstallError: the lockfile is missing or malformed.
    """
    lock = agent_dir / "npm" / "package-lock.json"
    packages = read_json(lock).get("packages")
    if not isinstance(packages, dict):
        raise InstallError(f"No npm lockfile packages in '{lock}'")
    return packages


def verify_owned_integrity(snapshot: StackSnapshot, agent_dir: Path) -> None:
    """Require every owned package npm installed to carry the integrity the promotion verified.

    Parameters:
        snapshot (StackSnapshot): verified snapshot.
        agent_dir (Path): agent tree holding the installed packages.

    Raises:
        InstallError: an owned package is missing or its integrity differs.
    """
    entries = owned_lock_entries(agent_dir)
    for owned in snapshot.gates.owned_packages:
        name, version = owned.package.rsplit("@", 1)
        entry = entries.get(f"node_modules/{name}")
        if not isinstance(entry, dict):
            entry = {}
        if entry.get("version") != version or entry.get("integrity") != owned.integrity:
            raise InstallError(
                f"Installed '{name}' is '{entry.get('version')}' with integrity '{entry.get('integrity')}', "
                f"the promotion verified '{version}' with '{owned.integrity}'"
            )


def report_plan(plan: Plan, verified: Verified) -> None:
    """Log the plan and what stays untouched.

    Parameters:
        plan (Plan): planned changes.
        verified (Verified): verified installation input.
    """
    stack = verified.stack
    LOGGER.info(f"Stack `stack/{verified.snapshot.source_sha}`: core '{stack.core.tag}', packages in order:")
    for package, source in zip(stack.sources, verified.sources, strict=True):
        filters = (
            ""
            if isinstance(package, str)
            else f" filters {package.model_dump(exclude_unset=True, exclude={'source'})}"
        )
        disabled = " DISABLED (installed, never loaded)" if source in stack.disabled_extensions else ""
        LOGGER.info(f"  {source}{filters}{disabled}")
    for line in plan.creates:
        LOGGER.info(f"CREATE {line}")
    for line in plan.overwrites:
        LOGGER.info(f"OVERWRITE {line}")
    LOGGER.info(
        "Never touched: auth.json, models.json, sessions, memory and every other file in the agent dir"
    )


def consent(plan: Plan, assume_yes: bool, ask: Callable[[str], str] | None) -> None:
    """Require agreement before any overwrite of existing state.

    Parameters:
        plan (Plan): planned changes.
        assume_yes (bool): `--yes` was passed.
        ask (Callable[[str], str] | None): interactive prompt, `None` when stdin is not a terminal.

    Raises:
        ConsentError: overwrites were planned and not agreed to.
    """
    if not plan.overwrites or assume_yes:
        return
    if ask is None:
        raise ConsentError("The plan overwrites existing state; rerun with `--yes` to agree, nothing changed")
    try:
        answer = ask("Apply these changes? Existing state is backed up first. [y/N] ")
    except EOFError as error:
        raise ConsentError("Declined (end of input), nothing changed") from error
    if answer.strip().lower() not in {"y", "yes"}:
        raise ConsentError("Declined, nothing changed")


class Journal:
    """Durable list of switch-over steps, so an interrupted switch can be restored exactly."""

    def __init__(self, layout: Layout, backups: Path) -> None:
        """Start an empty journal.

        Parameters:
            layout (Layout): installer paths.
            backups (Path): directory receiving the replaced state.
        """
        self.layout = layout
        self.path = layout.journal
        self.backups = backups
        self.steps: list[dict[str, Any]] = []
        self.backup_fd: int | None = None
        self.directory_identities: dict[Path, tuple[int, int]] = {}

    @contextmanager
    def open_backups(self, *, create: bool = True) -> Iterator[None]:
        """Anchor backup operations to real directories, never a later ancestor lookup.

        Parameters:
            create (bool): create a new run directory; `False` when restoring an existing one.

        Yields:
            None: directory descriptors remain open for the operation.
        """
        if create:
            self.layout.backups.mkdir(parents=True, exist_ok=True)
        flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_DIRECTORY
        store_fd = os.open(self.layout.backups, flags)
        try:
            info = os.fstat(store_fd)
            self.directory_identities[self.layout.backups] = (info.st_dev, info.st_ino)
            if create:
                os.mkdir(self.backups.name, mode=0o700, dir_fd=store_fd)
            self.backup_fd = os.open(self.backups.name, flags, dir_fd=store_fd)
            try:
                info = os.fstat(self.backup_fd)
                self.directory_identities[self.backups] = (info.st_dev, info.st_ino)
                self.check_store()
                yield
                self.check_store()
            finally:
                os.close(self.backup_fd)
                self.backup_fd = None
        finally:
            os.close(store_fd)

    def check_store(self) -> None:
        """Fail closed if the backup store path no longer names the opened directory."""
        for path, identity in self.directory_identities.items():
            info = path.lstat()
            if not stat.S_ISDIR(info.st_mode) or (info.st_dev, info.st_ino) != identity:
                raise OSError(f"Backup store directory '{path}' changed during the switch")

    def save(self, live: Path, backup: Path) -> None:
        """Move an original into the anchored run directory, ignoring replaced ancestor paths.

        Parameters:
            live (Path): original target.
            backup (Path): validated destination within this run's backup directory.
        """
        if self.backup_fd is None:
            raise OSError("Backup directory is not open")
        self.check_store()
        os.replace(live, backup.name, dst_dir_fd=self.backup_fd)
        self.check_store()

    def record(self, target: Path, name: str) -> Path | None:
        """Durably record a step before it runs.

        Parameters:
            target (Path): path about to be replaced or created.
            name (str): backup name inside the backup directory.

        Returns:
            Path | None: where the existing target will be kept, `None` when it does not exist.

        Raises:
            UnsupportedError: the target changed since planning into a kind a restore would
                refuse; it is not recorded, so the journal stays restorable and the switch
                rolls back the steps before it.
        """
        self.check_store()
        require_restorable_kind(self.layout, target, "the steps before it are rolled back")
        existed = target.exists() or target.is_symlink()
        backup = self.backups / name if existed else None
        self.steps.append({"target": str(target), "backup": str(backup) if backup else None})
        document = {"backups": str(self.backups), "steps": self.steps}
        write_atomic(self.path, json.dumps(document, indent=2), mode=JOURNAL_MODE)
        return backup

    def commit(self) -> None:
        """Mark the switch complete; nothing will be rolled back."""
        self.check_store()
        self.path.unlink()


def write_atomic(path: Path, text: str, mode: int | None = None) -> None:
    """Replace a file atomically, fsyncing the new contents first.

    Parameters:
        path (Path): destination.
        text (str): new contents.
        mode (int | None): permission bits; default keeps the existing file's, or 0o644.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    keep = mode if mode is not None else (path.stat().st_mode & 0o777 if path.exists() else 0o644)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    # Created owner-only whatever the umask, and given its final mode before any data: the
    # journal names every path a restore deletes, so it is never readable by others.
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "w") as handle:
        os.fchmod(descriptor, keep)
        handle.write(text)
        handle.flush()
        os.fsync(descriptor)
    temporary.replace(path)


def remove(path: Path) -> None:
    """Remove a file, link or directory if present.

    Parameters:
        path (Path): entry to remove.
    """
    if path.is_symlink() or path.is_file():
        path.unlink()
    elif path.is_dir():
        shutil.rmtree(path)


@dataclass(frozen=True)
class Step:
    """One validated journal step: a path the switch replaced and where its original is kept."""

    target: Path
    backup: Path | None


def journaled_paths(layout: Layout) -> dict[Path, tuple[str, frozenset[str]]]:
    """Map every path a switch may replace to its backup name and the entry kinds it may hold.

    Parameters:
        layout (Layout): installer paths.

    Returns:
        dict[Path, tuple[str, frozenset[str]]]: target -> backup name, allowed backup kinds.
    """
    trees = {layout.agent_dir / tree: (tree, frozenset({"directory", "symlink"})) for tree in PACKAGE_TREES}
    files = {layout.agent_dir / name: (name, frozenset({"file"})) for name in (SETTINGS_FILE, SUBAGENTS_FILE)}
    return (
        trees
        | files
        | {
            layout.link: (LINK_BACKUP, frozenset({"file", "symlink"})),
            layout.state: (STATE_FILE, frozenset({"file"})),
        }
    )


def journaled_path(layout: Layout, target: Path) -> tuple[str, frozenset[str]]:
    """Resolve one switch target, including an exact versioned core prefix for offline recovery.

    Parameters:
        layout (Layout): installer paths.
        target (Path): canonical target path.

    Returns:
        tuple[str, frozenset[str]]: backup basename and restorable kinds.

    Raises:
        ValueError: the target is outside the installer layout or its core parent is not real.
    """
    known = journaled_paths(layout).get(target)
    if known is not None:
        return known
    if target.parent == layout.root / "core" and CORE_TAG.fullmatch(target.name):
        if entry_kind(target.parent) not in {None, "directory"}:
            raise ValueError(f"Core parent '{target.parent}' is not a real directory")
        return f"core-{target.name}", frozenset({"directory", "symlink"})
    raise ValueError(f"step target '{target}' is not a path the installer replaces")


def read_journal(path: Path) -> object:
    """Read the journal only if it is a private regular file the current user owns.

    Parameters:
        path (Path): journal file.

    Returns:
        object: decoded JSON.

    Raises:
        ValueError: the journal is a link, not private, foreign-owned or not JSON.
    """
    try:
        # Non-blocking: a FIFO in its place must fail the regular-file check, not wait for a writer.
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_NOCTTY)
    except OSError as error:
        raise ValueError(f"cannot open it without following links: {error}") from error
    with os.fdopen(descriptor) as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode):
            raise ValueError("it is not a regular file")
        if info.st_uid != os.getuid():
            raise ValueError(f"it is owned by uid '{info.st_uid}', not the current user")
        if info.st_mode & 0o077:
            raise ValueError(f"its mode is '{oct(info.st_mode & 0o777)}', not private")
        try:
            return json.loads(handle.read())
        except (OSError, ValueError) as error:
            raise ValueError(f"it is not readable JSON: {error}") from error


def validate_journal(layout: Layout, document: object) -> list[Step]:
    """Check every journal step against the paths a switch can touch, before anything is restored.

    Parameters:
        layout (Layout): installer paths.
        document (object): decoded journal.

    Returns:
        list[Step]: steps in the order they were recorded.

    Raises:
        ValueError: any step names a path outside the layout, a backup outside its directory, an
            unexpected entry kind, or the document is malformed.
    """
    if not isinstance(document, dict) or set(document) != {"backups", "steps"}:
        raise ValueError("it is not a `{backups, steps}` object")
    raw_backups, raw_steps = document["backups"], document["steps"]
    store = layout.backups
    if not isinstance(raw_backups, str) or not isinstance(raw_steps, list):
        raise ValueError("`backups` is not a path or `steps` is not a list")
    backups = Path(raw_backups)
    # Exact strings: `Path` would normalize `a//b` and keep `..`, neither of which a journal holds.
    if str(backups) != raw_backups or backups.parent != store or backups.name in {"", ".", ".."}:
        raise ValueError(f"backup directory '{raw_backups}' is not directly inside '{store}'")
    for directory in (store, backups):
        if not is_real_directory_or_absent(directory):
            raise ValueError(f"'{directory}' is not a real directory")
    if entry_kind(backups) == "directory" and backups.lstat().st_uid != os.getuid():
        raise ValueError(f"'{backups}' is not owned by the current user")
    steps: list[Step] = []
    for raw in raw_steps:
        if not isinstance(raw, dict) or set(raw) != {"target", "backup"}:
            raise ValueError(f"step {raw!r} is not a `{{target, backup}}` object")
        if not isinstance(raw["target"], str) or str(Path(raw["target"])) != raw["target"]:
            raise ValueError(f"step target '{raw['target']}' is not a canonical path")
        target = Path(raw["target"])
        name, kinds = journaled_path(layout, target)
        if any(step.target == target for step in steps):
            raise ValueError(f"step target '{target}' is recorded twice")
        backup = backups / name
        if raw["backup"] is None:
            steps.append(Step(target, None))
            continue
        if raw["backup"] != str(backup):
            raise ValueError(f"backup '{raw['backup']}' for '{target}' is not '{backup}'")
        kind = entry_kind(backup)
        if kind is not None and kind not in kinds:
            raise ValueError(f"backup '{backup}' is a {kind}, expected {' or '.join(sorted(kinds))}")
        steps.append(Step(target, backup))
    return steps


def load_journal(layout: Layout) -> tuple[Path, list[Step]]:
    """Read and validate the journal of an interrupted switch.

    Parameters:
        layout (Layout): installer paths.

    Returns:
        tuple[Path, list[Step]]: backup directory and validated steps in recorded order.

    Raises:
        RollbackError: the journal is not trusted; nothing was changed.
    """
    try:
        document = read_journal(layout.journal)
        if not isinstance(document, dict):
            raise ValueError("journal is not a JSON object")
        steps = validate_journal(layout, document)
        return Path(document["backups"]), steps
    except ValueError as error:
        raise RollbackError(
            f"Journal '{layout.journal}' is not trusted: {error}; nothing was restored. It only names the "
            "paths of the run that wrote it: if that run used another `--bin-dir` or "
            "`PI_CODING_AGENT_DIR`, rerun with the same ones. Otherwise restore by hand from "
            f"'{layout.backups}'"
        ) from error


def rollback(layout: Layout) -> list[str]:
    """Restore every journaled step of an interrupted switch, newest first.

    Every step is validated before the first one is restored, so an untrusted journal changes
    nothing.

    Parameters:
        layout (Layout): installer paths.

    Returns:
        list[str]: restored targets.

    Raises:
        RollbackError: the journal is not trusted, or a step could not be restored; the journal is
            kept for another attempt.
    """
    if not layout.journal.exists(follow_symlinks=False):
        return []
    backups, steps = load_journal(layout)
    journal = Journal(layout, backups)
    restored = []
    try:
        with journal.open_backups(create=False):
            # A missing backup is ambiguous (not started, already restored, or lost). Never call
            # that success: a switched target may still be live. Validate all before deleting any.
            for step in steps:
                if step.backup is not None:
                    try:
                        os.stat(step.backup.name, dir_fd=journal.backup_fd, follow_symlinks=False)
                    except FileNotFoundError as error:
                        raise OSError(
                            f"Expected backup '{step.backup}' is missing; restore by hand"
                        ) from error
            for step in reversed(steps):
                journal.check_store()
                remove(step.target)
                if step.backup is not None:
                    os.replace(step.backup.name, step.target, src_dir_fd=journal.backup_fd)
                journal.check_store()
                restored.append(str(step.target))
    except OSError as error:
        raise RollbackError(
            f"Could not restore an interrupted install: {error}; journal kept at '{layout.journal}'"
        ) from error
    journal.commit()
    return restored


def install_packages(verified: Verified, pi_bin: Path, staging: Path) -> Path:
    """Install every source in stack order into a staging agent tree with a clean npm config.

    Parameters:
        verified (Verified): verified installation input.
        pi_bin (Path): installed core executable.
        staging (Path): private staging directory.

    Returns:
        Path: the staged agent tree.

    Raises:
        InstallError: `pi install` failed, or an installed version or owned integrity differs.
    """
    stack = verified.stack
    agent, home = staging / "agent", staging / "home"
    agent.mkdir(parents=True)
    home.mkdir()
    for name in ("npmrc-user", "npmrc-global"):
        (staging / name).touch()
    env = {
        "PATH": os.environ.get("PATH", os.defpath),
        "HOME": str(home),
        "PI_CODING_AGENT_DIR": str(agent),
        "PI_SKIP_VERSION_CHECK": "1",
        "PI_TELEMETRY": "0",
        "NO_UPDATE_NOTIFIER": "1",
        "npm_config_userconfig": str(staging / "npmrc-user"),
        "npm_config_globalconfig": str(staging / "npmrc-global"),
        "npm_config_cache": str(staging / "npm-cache"),
        "npm_config_registry": "https://registry.npmjs.org/",
    }
    for package, source in zip(stack.sources, verified.sources, strict=True):
        LOGGER.info(f"pi install '{source}'")
        try:
            subprocess.check_output(
                [str(pi_bin), "install", source],
                cwd=home,
                env=env | install_overrides(stack, package),
                text=True,
                stderr=subprocess.STDOUT,
                timeout=INSTALL_TIMEOUT,
            )
        except subprocess.CalledProcessError as error:
            raise InstallError(f"`pi install` failed for '{source}': {error.output[-4000:]}") from error
        except (OSError, subprocess.TimeoutExpired) as error:
            raise InstallError(f"`pi install` could not complete for '{source}': {error}") from error
    try:
        installed_identities(stack, verified.sources, agent)
    except (OSError, ValueError) as error:
        raise InstallError(f"Staged packages do not match the snapshot: {error}") from error
    verify_owned_integrity(verified.snapshot, agent)
    return agent


def stage(layout: Layout, verified: Verified, plan: Plan, staging: Path) -> Path | None:
    """Install the core and packages outside the live tree.

    Parameters:
        layout (Layout): installer paths.
        verified (Verified): verified installation input.
        plan (Plan): planned changes.
        staging (Path): private staging directory.

    Returns:
        Path | None: the staged agent tree, `None` when packages are already installed.

    Raises:
        InstallError: the core or a package failed to install or verify.
    """
    stack = verified.stack
    prefix = layout.core(stack.core.tag)
    if plan.install_core:
        staged_core = staging / "core"
        try:
            # Bound to the snapshot's digests, not a re-read `SHA256SUMS`: the bytes installed
            # are the bytes `verify_release` accepted.
            fetch_release(
                stack.core.tag,
                staged_core,
                provenance=verify_provenance_anonymously,
                checksums=verified.core_checksums,
            )
        except (OSError, ValueError, RuntimeError) as error:
            raise InstallError(f"Core '{stack.core.tag}' installation failed: {error}") from error
        for leftover in ("fetch-home", "npm-cache", "tui-resource"):
            remove(staged_core / leftover)
        write_atomic(staged_core / CORE_MARKER, json.dumps(stack.core.model_dump(mode="json"), indent=2))
        prefix = staged_core
    return install_packages(verified, prefix / "bin" / "pi", staging) if plan.install_packages else None


def switch(
    layout: Layout,
    verified: Verified,
    plan: Plan,
    staged_agent: Path | None,
    journal: Journal,
    *,
    staged_core: Path | None = None,
) -> None:
    """Move staged state into place, journaling every replacement first.

    Parameters:
        layout (Layout): installer paths.
        verified (Verified): verified installation input.
        plan (Plan): planned changes.
        staged_agent (Path | None): staged agent tree, when packages changed.
        journal (Journal): durable step record.
        staged_core (Path | None): verified private core prefix, when the core changed.
    """
    with journal.open_backups():
        switch_anchored(layout, verified, plan, staged_agent, journal, staged_core=staged_core)


def switch_anchored(
    layout: Layout,
    verified: Verified,
    plan: Plan,
    staged_agent: Path | None,
    journal: Journal,
    *,
    staged_core: Path | None,
) -> None:
    """Switch targets while `journal` holds the backup directory descriptors open.

    Parameters:
        layout (Layout): installer paths.
        verified (Verified): verified input.
        plan (Plan): desired changes.
        staged_agent (Path | None): staged packages.
        journal (Journal): journal with an open backup directory.
        staged_core (Path | None): staged core prefix.
    """
    layout.agent_dir.mkdir(parents=True, exist_ok=True)
    if staged_core is not None:
        prefix = layout.core(verified.stack.core.tag)
        backup = journal.record(prefix, f"core-{verified.stack.core.tag}")
        if backup is not None:
            journal.save(prefix, backup)
        prefix.parent.mkdir(parents=True, exist_ok=True)
        staged_core.replace(prefix)
    if staged_agent is not None:
        # Every existing tree is replaced, as planned, even when the stack stages none of it: a
        # leftover `git` tree is backed up rather than kept beside packages it no longer declares.
        for tree in PACKAGE_TREES:
            staged, live = staged_agent / tree, layout.agent_dir / tree
            if not (staged.exists() or live.exists() or live.is_symlink()):
                continue
            backup = journal.record(live, tree)
            if backup is not None:
                journal.save(live, backup)
            if staged.exists():
                staged.replace(live)
    for name, desired in ((SETTINGS_FILE, plan.settings), (SUBAGENTS_FILE, plan.subagents)):
        if desired is not None:
            replace_file(journal, layout.agent_dir / name, name, json.dumps(desired, indent=2) + "\n")
    if plan.link is not None:
        layout.bin_dir.mkdir(parents=True, exist_ok=True)
        backup = journal.record(layout.link, LINK_BACKUP)
        if backup is not None:
            journal.save(layout.link, backup)
        layout.link.symlink_to(plan.link)
    state = {
        "source_sha": verified.snapshot.source_sha,
        "stack_sha256": verified.snapshot.stack_sha256,
        "core": str(layout.core(verified.stack.core.tag)),
        "link": str(layout.link),
        "agent_dir": str(layout.agent_dir),
        "installed_at": datetime.now(UTC).isoformat(timespec="seconds"),
    }
    replace_file(journal, layout.state, STATE_FILE, json.dumps(state, indent=2) + "\n")


def replace_file(journal: Journal, live: Path, name: str, text: str) -> None:
    """Journal, back up, then atomically replace one file.

    Parameters:
        journal (Journal): durable step record.
        live (Path): file to replace.
        name (str): backup name.
        text (str): new contents.
    """
    backup = journal.record(live, name)
    mode = live.stat().st_mode & 0o777 if backup is not None else None
    if backup is not None:
        journal.save(live, backup)
    write_atomic(live, text, mode=mode)


def apply(layout: Layout, verified: Verified, plan: Plan) -> tuple[Path, str]:
    """Stage, switch under a journal and run the post-check; any failure restores the previous state.

    The installed `pi --version` runs before the journal commits, so an install that does not
    run is rolled back instead of being left in place and reported as healthy on the next run.

    Parameters:
        layout (Layout): installer paths.
        verified (Verified): verified installation input.
        plan (Plan): planned changes.

    Returns:
        tuple[Path, str]: backup directory holding everything that was replaced, and the
            installed `pi --version` output.

    Raises:
        UnsupportedError: the backup store turned into a link while staging (nothing changed).
        InstallError: staging failed (nothing changed), or the switch or post-check failed
            (previous state restored).
        RollbackError: the switch failed and could not be fully restored.
    """
    staging = layout.root / "staging" / uuid.uuid4().hex
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    backups = layout.backups / f"{stamp}-{verified.snapshot.source_sha[:12]}-{uuid.uuid4().hex[:6]}"
    staging.mkdir(parents=True)
    try:
        staged_agent = stage(layout, verified, plan, staging)
        # Staging is slow: check the store again just before the first journaled step.
        require_backup_store(layout)
        journal = Journal(layout, backups)
        try:
            switch(
                layout,
                verified,
                plan,
                staged_agent,
                journal,
                staged_core=staging / "core" if plan.install_core else None,
            )
            version = checked_version(
                layout, None if plan.install_core else layout.core(verified.stack.core.tag)
            )
        except BaseException as error:
            restored = rollback(layout)
            raise InstallError(
                f"Switch failed and was rolled back ({len(restored)} steps restored): {error}"
            ) from error
        journal.commit()
    finally:
        remove(staging)
    if backups.exists() and not any(backups.iterdir()):
        backups.rmdir()
    return backups, version


def post_check(layout: Layout) -> str:
    """Run the installed `pi --version` through the new link.

    Parameters:
        layout (Layout): installer paths.

    Returns:
        str: version output.

    Raises:
        InstallError: the installed executable does not run.
    """
    try:
        return subprocess.check_output(
            [str(layout.link), "--version"],
            text=True,
            stderr=subprocess.STDOUT,
            timeout=VERSION_TIMEOUT,
            env=without_github_tokens(os.environ) | {"PI_SKIP_VERSION_CHECK": "1", "PI_OFFLINE": "1"},
        ).strip()
    except (OSError, subprocess.SubprocessError) as error:
        raise InstallError(f"Installed '{layout.link}' does not run: {error}") from error


def checked_version(layout: Layout, kept_core: Path | None) -> str:
    """Run `post_check`, naming a kept core prefix as the manual fix when it fails.

    A core prefix whose marker matches the snapshot is never reinstalled, so a damaged one fails
    every rerun until it is removed.

    Parameters:
        layout (Layout): installer paths.
        kept_core (Path | None): core prefix this run did not reinstall, `None` when it did.

    Returns:
        str: version output.

    Raises:
        InstallError: the installed executable does not run.
    """
    try:
        return post_check(layout)
    except InstallError as error:
        if kept_core is None:
            raise
        raise InstallError(
            f"{error}. Core '{kept_core}' was kept because its marker matches the snapshot; if it is "
            "damaged, remove it and rerun to reinstall it"
        ) from error


@contextmanager
def locked(layout: Layout) -> Iterator[None]:
    """Hold the installer lock, creating the installer root if needed.

    Parameters:
        layout (Layout): installer paths.

    Yields:
        None: while the lock is held.

    Raises:
        InstallError: another installer holds the lock.
        UnsupportedError: the lock is not an owned regular file, or is writable by others.
    """
    if fcntl is None:
        raise UnsupportedError(
            f"platform '{platform.system()}/{platform.machine()}' is not supported: "
            "Unix file locking is unavailable, nothing changed"
        )
    layout.root.mkdir(parents=True, exist_ok=True)
    path = layout.root / "lock"
    kind = entry_kind(path)
    if kind not in {None, "file"}:
        raise UnsupportedError(f"Lock '{path}' is a {kind}; move it aside yourself, nothing changed")
    try:
        descriptor = os.open(
            path, os.O_RDWR | os.O_CREAT | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_NOCTTY, 0o600
        )
    except OSError as error:
        raise UnsupportedError(f"Cannot safely open lock '{path}'; nothing changed: {error}") from error
    with os.fdopen(descriptor, "rb", buffering=0) as lock:
        info = os.fstat(lock.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o022:
            raise UnsupportedError(
                f"Lock '{path}' must be a regular file you own, not writable by others; nothing changed"
            )
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise InstallError(f"Another installer holds '{path}'") from error
        yield


def recover(layout: Layout, assume_yes: bool, ask: Callable[[str], str] | None) -> None:
    """Restore an interrupted switch, with consent, before anything else runs.

    Parameters:
        layout (Layout): installer paths, with the lock held.
        assume_yes (bool): `--yes` was passed.
        ask (Callable[[str], str] | None): interactive prompt, `None` without a terminal.

    Raises:
        ConsentError: the restore was not agreed to.
        RollbackError: the journal is not trusted (nothing changed) or a step could not be restored.
    """
    if not layout.journal.exists(follow_symlinks=False):
        return
    report_pending(layout, restoring=True)
    consent(Plan(overwrites=["restore the state replaced by the interrupted install"]), assume_yes, ask)
    LOGGER.info(f"Restored {', '.join(rollback(layout)) or 'nothing'}")


def report_pending(layout: Layout, restoring: bool) -> None:
    """Log the steps an interrupted switch left in its journal, newest first.

    An install plan computed now would describe a half-switched tree, so none is shown until the
    restore has run.

    Parameters:
        layout (Layout): installer paths.
        restoring (bool): this run restores now; `False` for `--plan`, which only reports.

    Raises:
        RollbackError: restoring and the journal is not trusted, so the run fails closed before
            asking for consent.
    """
    when = (
        "This run restores them (with consent)"
        if restoring
        else "The next run without `--plan` restores them (with consent)"
    )
    LOGGER.warning(
        f"PENDING: a previous install was interrupted; '{layout.journal}' lists its steps. {when} "
        "before planning anything"
    )
    try:
        _, steps = load_journal(layout)
    except RollbackError as error:
        if restoring:
            raise
        LOGGER.warning(str(error))
        return
    for step in reversed(steps):
        source = f"from '{step.backup}'" if step.backup else "by removing it (it was new)"
        LOGGER.info(f"RESTORE '{step.target}' {source}")


@dataclass(frozen=True)
class Options:
    """Parsed command-line options."""

    source_sha: str
    assume_yes: bool
    plan_only: bool
    bin_dir: Path | None


def run(opts: Options, env: Mapping[str, str], ask: Callable[[str], str] | None) -> ExitCode:
    """Install one promoted stack.

    Parameters:
        opts (Options): parsed options.
        env (Mapping[str, str]): process environment.
        ask (Callable[[str], str] | None): interactive prompt, `None` without a terminal.

    Returns:
        ExitCode: `OK` when installed or already up to date.

    Raises:
        InstallError: any refused or failed step, typed by outcome.
    """
    if SHA_PATTERN.fullmatch(opts.source_sha) is None:
        raise UnsupportedError(f"Stack SHA must be 40 lowercase hex characters, got '{opts.source_sha}'")
    layout = Layout.from_env(env, Path.home(), opts.bin_dir)
    if layout.journal.exists(follow_symlinks=False):
        if opts.plan_only:
            report_pending(layout, restoring=False)
            return ExitCode.OK
        # Restoring needs only the journal and its backups: no network, no tools, no snapshot.
        with locked(layout):
            recover(layout, opts.assume_yes, ask)
    tools = preflight(platform.system(), platform.machine())
    require_one_filesystem(layout)
    with tempfile.TemporaryDirectory(prefix="pi-stack-verify-") as temporary:
        workdir = Path(temporary)
        verified = verify_release(verify_snapshot(opts.source_sha, workdir), tools["node"], workdir)
    if opts.plan_only:
        report_plan(plan_install(layout, verified), verified)
        return ExitCode.OK
    with locked(layout):
        # Another run may have been interrupted while this one verified.
        recover(layout, opts.assume_yes, ask)
        remove(layout.root / "staging")
        plan = plan_install(layout, verified)
        report_plan(plan, verified)
        if plan.empty:
            # Matching files are not a working install: it must still run.
            try:
                version = checked_version(layout, layout.core(verified.stack.core.tag))
            except InstallError as error:
                raise InstallError(
                    f"`stack/{opts.source_sha}` matches the snapshot but is not healthy, nothing was "
                    f"changed: {error}"
                ) from error
            LOGGER.info(f"Already installed: `stack/{opts.source_sha}`: {version}, nothing to do")
            return ExitCode.OK
        consent(plan, opts.assume_yes, ask)
        backups, version = apply(layout, verified, plan)
    LOGGER.info(f"Installed `stack/{opts.source_sha}`: {version} at '{layout.link}'")
    if backups.exists():
        LOGGER.info(f"Replaced state is kept in '{backups}'")
    if not any(
        Path(entry).resolve() == layout.bin_dir.resolve()
        for entry in env.get("PATH", "").split(os.pathsep)
        if entry
    ):
        LOGGER.warning(f"'{layout.bin_dir}' is not on PATH; add it, or run '{layout.link}' directly")
    disabled = [
        f"`{source}` is installed without lifecycle scripts and never loaded: {reason}"
        for source, reason in verified.stack.disabled_extensions.items()
    ]
    LOGGER.info("Configure yourself:\n- " + "\n- ".join([*SELF_CONFIGURED, *disabled]))
    return ExitCode.OK


def parse(argv: list[str] | None) -> Options:
    """Parse command-line arguments.

    Parameters:
        argv (list[str] | None): arguments, default `sys.argv[1:]`.

    Returns:
        Options: parsed options.
    """
    parser = argparse.ArgumentParser(
        prog="pi-stack-install", description="Install one attested promoted pi-harness stack (`stack/<sha>`)."
    )
    parser.add_argument("source_sha", help="exact promoted commit, the `<sha>` of a `stack/<sha>` release")
    parser.add_argument(
        "--yes", action="store_true", help="agree to overwrite existing state (backed up first)"
    )
    parser.add_argument("--plan", action="store_true", help="verify and print the plan, change nothing")
    parser.add_argument("--bin-dir", type=Path, help="directory for the `pi` link (default `~/.local/bin`)")
    args = parser.parse_args(argv)
    return Options(args.source_sha, args.yes, args.plan, args.bin_dir)


def main(argv: list[str] | None = None) -> int:
    """Console entry point.

    Parameters:
        argv (list[str] | None): arguments, default `sys.argv[1:]`.

    Returns:
        int: process exit status.
    """
    logging.basicConfig(level=logging.INFO, format="%(message)s", stream=sys.stderr)
    opts = parse(argv)
    ask = input if sys.stdin.isatty() else None
    try:
        return run(opts, os.environ, ask)
    except UnsupportedError as error:
        LOGGER.error(f"UNSUPPORTED: {error}")
        return ExitCode.UNSUPPORTED
    except VerificationError as error:
        LOGGER.error(f"VERIFICATION FAILED, nothing changed: {error}")
        return ExitCode.VERIFICATION
    except ConsentError as error:
        LOGGER.error(f"NOT APPLIED: {error}")
        return ExitCode.CONSENT
    except InstallError as error:
        LOGGER.error(f"FAILED: {error}")
        return ExitCode.FAILED
    except KeyboardInterrupt:
        LOGGER.error("INTERRUPTED: staging is discarded; an interrupted switch is restored on the next run")
        return ExitCode.FAILED


if __name__ == "__main__":
    sys.exit(main())
