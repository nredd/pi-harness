"""Real packed preset and dev-tools agents running through the selected pi-subagents fork.

The standalone package gate (`package_contracts.py`) proves each plugin alone against stock Pi. This
gate proves the optional integration: a REAL packed `@nredd/pi-preset` `code-reviewer` agent and the
REAL packed `@nredd/pi-dev-tools` extension working through the pi-subagents commit the parent
Gitlink selects, driven by exact stock Pi `1.3.0` and a loopback faux provider.

1. Preflight (before anything is built): `forks/pi-subagents` must be initialized, clean, and its
   `HEAD` must equal BOTH the Gitlink in the parent index and in the parent `HEAD`. Nothing is
   bootstrapped, updated, installed into, or otherwise changed in the fork.
2. The exact commit is archived (`git archive`) into a disposable directory. Its native
   `package-lock.json` is kept and `npm ci --ignore-scripts --omit=dev --omit=peer` installs only the
   locked runtime dependencies (`croner`, `nanoid`) there. Host packages (`@earendil-works/*`,
   `typebox`) must not appear anywhere in that tree. The fork identity (Gitlink SHA, lockfile digest,
   installed dependency versions and integrities) goes into the report.
3. Preset and dev-tools are packed with `npm pack`, audited like the plugins (the preset against its
   own multi-license contract), and installed into separate fresh projects. Pi sees them only as
   `settings.json` `packages` of a scrubbed agent directory, never from the workspace sources.
4. Stock Pi runs `--no-extensions --extension <fork copy>` under an explicit one-time trust flag;
   the parent model calls `Agent(subagent_type="code-reviewer", run_in_background=false)`. The child
   is answered from a separate script chosen by a marker in its USER task (`faux_provider.Route`), so
   the parent script is never replayed in the child. The child really calls one allowed tool on a
   disposable git repository and then every denied tool (`write`, `bash`, `git_status`, `git_commit`
   its allowlist lacks), which Pi must refuse as unknown without any effect on sentinel files or the
   repository. Per case the gate records the child's declared tools and system prompt and the
   `Agent` result.

Cases: the packaged agent, a global override, a project override (trusted and untrusted), dev-tools
absent (the documented degradation), and a project-scoped install (trusted: the packaged agent;
untrusted: the fork's `general-purpose` fallback).

Not covered: Bun, the full assembled stack, authenticated providers, `pi install`, and any
registry-published artifact. Dependency setup needs the npm registry on every run (the npm cache is
per-run); the Pi runs themselves use only the loopback provider.

References:
    https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md
    https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/security.md
    https://docs.npmjs.com/cli/v11/commands/npm-ci
    https://git-scm.com/docs/git-archive
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import re
import shlex
import shutil
import sys
import tarfile
import tempfile
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, Any, Literal, Self, TypedDict

from pydantic import BaseModel, Field, StringConstraints, ValidationError, model_validator

from faux_provider import FauxProvider, RecordedRequest, Route, TextStep, ToolStep, models_json
from package_contracts import (
    CONTRACTS,
    DEFAULT_STOCK_PREFIX,
    HOST_MODULES,
    LENIENT_STRICT_MODEL,
    NPM_TIMEOUT_S,
    PHYSICAL_MODEL,
    PRESET_CONTRACT,
    PROTOCOL_MODEL,
    PROVIDER,
    STOCK_PI_INTEGRITY,
    STOCK_PI_PACKAGE,
    STOCK_PI_VERSION,
    ContractError,
    NonEmptyText,
    PackageContract,
    PackedArtifact,
    PiRun,
    Sandbox,
    Semver,
    Sha1Hex,
    Sha256Hex,
    Sha512Integrity,
    StockPiIdentity,
    TarballName,
    ToolContentBlock,
    audit_tarball,
    describe_validation,
    ensure_stock_pi,
    install_alone,
    locate_tools,
    parse_tarballs,
    read_member,
    require,
    require_clean_run,
    run,
    run_pi,
    select_artifact,
    tool_is_error,
)

LOGGER = logging.getLogger(__name__)

REPO_ROOT = Path(__file__).resolve().parents[1]
FORK_RELATIVE = "forks/pi-subagents"
FORK_PACKAGE = "@tintinweb/pi-subagents"
# `dependencies` of the selected fork. A change here must be a deliberate edit of this gate.
FORK_RUNTIME_DEPENDENCIES = ("croner", "nanoid")
GITLINK_MODE = "160000"
GIT_TIMEOUT_S = 120
AGENT_TYPE = "code-reviewer"
DEV_TOOLS_CONTRACT = CONTRACTS[0]
# Unique, never-natural strings so a hit proves the exact path was taken.
CHILD_MARKER = "FORK-CONTRACT-CHILD-TASK-7f3a"
CHILD_TEXT = "fork-contract-child-answer-91c2"
PARENT_TEXT = "fork-contract-parent-done-4d18"
GLOBAL_MARKER = "FORK-CONTRACT-GLOBAL-OVERRIDE-2b6e"
PROJECT_MARKER = "FORK-CONTRACT-PROJECT-OVERRIDE-c05d"
# Content of the disposable repository the child's allowed calls inspect.
NOTE_TEXT = "fork-contract-note-5e8b"
LOG_SUBJECT = "Fork contract seed commit 0a47"
UNTRACKED_NAME = "fork-contract-untracked-3c91.txt"

# What the packaged `code-reviewer` may call: the built-ins named in its `tools:` plus the four
# read-only dev-tools it selects as `ext:pi-dev-tools/<tool>`.
REVIEWER_TOOLS = frozenset({"read", "grep", "find", "git_diff", "git_show", "git_log", "git_status"})
# Injected into every child with extensions loaded by `createWorkflowRefusalTool` in the fork's
# `src/agent-runner.ts`: a stand-in named `SubagentWorkflow` whose only behavior is to refuse. It is
# the single always-present fork helper for this agent; nested-delegation tools need
# `allowed_subagents` (absent here) and `StructuredOutput` needs a schema (none requested).
FORK_HELPER_TOOLS = frozenset({"SubagentWorkflow"})
# Tools the reviewer must never be able to call, spelled out so a failure names the culprit.
FORBIDDEN_REVIEWER_TOOLS = frozenset(
    {"edit", "write", "bash", "ssh_exec", "Agent", "get_subagent_result", "steer_subagent", "git_commit"}
)
CASE_NAMES = (
    "package-default",
    "global-override",
    "project-override",
    "project-override-untrusted",
    "missing-dev-tools",
    "project-package-trusted",
    "project-package-untrusted",
)
ChildTool = Literal["git_status", "git_log", "read"]
Trust = Literal["approve", "no-approve"]
DENIED_TOOLS = ("write", "bash", "git_status", "git_commit")


# --- fork selection -------------------------------------------------------------------------------


@dataclass(frozen=True)
class ForkSource:
    """The selected, verified fork checkout.

    Parameters:
        path (Path): Absolute fork checkout directory.
        sha (str): Full commit SHA, equal to the parent index and `HEAD` Gitlinks and the fork `HEAD`.
    """

    path: Path
    sha: str


def git_text(sandbox: Sandbox, repo: Path, *args: str) -> str:
    """Run `git -C repo ...` in the scrubbed environment and return its stdout.

    Parameters:
        sandbox (Sandbox): Scrubbed environment and tool locations.
        repo (Path): Directory to run in.
        *args (str): Git arguments.

    Returns:
        str: Standard output with trailing whitespace removed.

    Raises:
        ContractError: If git fails.
    """
    return run(
        [sandbox.tools.git, "-C", repo, *args], env=sandbox.env(), cwd=repo, timeout=GIT_TIMEOUT_S
    ).stdout.rstrip()


def gitlink_sha(listing: str, fork_relative: str, where: str) -> str:
    """Extract the Gitlink commit from `git ls-files -s` or `git ls-tree` output.

    Parameters:
        listing (str): Command output; one line expected.
        fork_relative (str): Fork path relative to the parent root.
        where (str): `index` or `HEAD`, for messages.

    Returns:
        str: Commit SHA recorded for the path.

    Raises:
        ContractError: If the path is absent, not a Gitlink, or conflicted.
    """
    lines = [line for line in listing.splitlines() if line.strip()]
    if len(lines) != 1:
        raise ContractError(f"'{fork_relative}' has {len(lines)} entries in the parent {where}, expected 1")
    index_form = re.fullmatch(rf"{GITLINK_MODE} ([0-9a-f]{{40}}) (\d)\t{re.escape(fork_relative)}", lines[0])
    tree_form = re.fullmatch(rf"{GITLINK_MODE} commit ([0-9a-f]{{40}})\t{re.escape(fork_relative)}", lines[0])
    if index_form is not None:
        if index_form.group(2) != "0":
            raise ContractError(f"'{fork_relative}' is conflicted in the parent index")
        return index_form.group(1)
    if tree_form is not None:
        return tree_form.group(1)
    raise ContractError(f"'{fork_relative}' is not a Gitlink in the parent {where}: '{lines[0]}'")


def preflight_fork(repo_root: Path, sandbox: Sandbox) -> ForkSource:
    """Verify the selected fork is initialized, clean, and exactly the Gitlink revision.

    Read-only: it runs `git rev-parse`, `ls-files`, `ls-tree` and `status`, and never initializes,
    updates, cleans or writes anything. A missing or mismatched fork is a clear refusal that names
    the bootstrap command to run by hand.

    Parameters:
        repo_root (Path): Parent repository root.
        sandbox (Sandbox): Scrubbed environment and tool locations.

    Returns:
        ForkSource: The verified checkout and its commit.

    Raises:
        ContractError: If the fork is missing, uninitialized, dirty, or not at both Gitlinks.
    """
    fork = repo_root / FORK_RELATIVE
    hint = "run `make bootstrap-forks` yourself; this gate never bootstraps or updates forks"
    if not fork.is_dir():
        raise ContractError(f"Fork '{fork}' is missing: {hint}")
    # An uninitialized submodule is an empty directory, where `git -C` would silently resolve the
    # PARENT repository (`--show-toplevel` is not enough: git reports the cwd for a broken `.git`).
    # Require the fork's own `.git`, and a git directory distinct from the parent's.
    if not (fork / ".git").exists():
        raise ContractError(f"Fork '{fork}' is not initialized (no `.git`): {hint}")
    fork_git = Path(git_text(sandbox, fork, "rev-parse", "--absolute-git-dir")).resolve()
    parent_git = Path(git_text(sandbox, repo_root, "rev-parse", "--absolute-git-dir")).resolve()
    if fork_git == parent_git:
        raise ContractError(f"Fork '{fork}' is not its own repository (git dir '{fork_git}'): {hint}")
    head = git_text(sandbox, fork, "rev-parse", "HEAD")
    indexed = gitlink_sha(
        git_text(sandbox, repo_root, "ls-files", "-s", "--", FORK_RELATIVE), FORK_RELATIVE, "index"
    )
    committed = gitlink_sha(
        git_text(sandbox, repo_root, "ls-tree", "HEAD", "--", FORK_RELATIVE), FORK_RELATIVE, "HEAD"
    )
    if not head == indexed == committed:
        raise ContractError(
            f"Fork HEAD '{head}' differs from the parent Gitlink "
            f"(index '{indexed}', HEAD '{committed}'): {hint}"
        )
    dirty = git_text(sandbox, fork, "status", "--porcelain=v1", "--untracked-files=all").splitlines()
    if dirty:
        listed = "\n".join(f"    {line}" for line in dirty[:20])
        raise ContractError(
            f"Fork '{fork}' is dirty ({len(dirty)} entries); commit or discard by hand:\n{listed}"
        )
    return ForkSource(fork, head)


def archive_fork(source: ForkSource, dest: Path, sandbox: Sandbox) -> None:
    """Export the exact fork commit into a new disposable directory.

    Parameters:
        source (ForkSource): Verified fork.
        dest (Path): Directory to create; must not exist.
        sandbox (Sandbox): Scrubbed environment and tool locations.

    Raises:
        ContractError: If `dest` exists, the archive cannot be made, or it lacks the files the gate needs.
    """
    if dest.exists():
        raise ContractError(f"Fork archive destination already exists: '{dest}'")
    dest.mkdir(parents=True)
    tarball = dest.parent / f"{dest.name}.tar"
    run(
        [sandbox.tools.git, "-C", source.path, "archive", "--format=tar", "--output", tarball, source.sha],
        env=sandbox.env(),
        cwd=source.path,
        timeout=GIT_TIMEOUT_S,
    )
    try:
        with tarfile.open(tarball) as tar:
            tar.extractall(dest, filter="data")  # `data` refuses absolute paths, links out, and devices.
    except (tarfile.TarError, OSError) as e:
        raise ContractError(f"Could not extract the fork archive '{tarball}': {e}") from e
    missing = [
        name for name in ("package.json", "package-lock.json", "src/index.ts") if not (dest / name).is_file()
    ]
    if missing:
        raise ContractError(f"Fork archive at '{source.sha}' lacks {missing}")


# --- fork dependencies ----------------------------------------------------------------------------


class ForkLockPackage(BaseModel):
    model_config = LENIENT_STRICT_MODEL
    version: str | None = Field(default=None, description="Locked version")
    integrity: str | None = Field(default=None, description="Locked registry integrity")
    dependencies: dict[str, str] = Field(default_factory=dict, description="Declared runtime dependencies")
    optionalDependencies: dict[str, str] = Field(
        default_factory=dict, description="Optional runtime dependencies"
    )


class ForkLockfile(BaseModel):
    model_config = LENIENT_STRICT_MODEL
    lockfileVersion: int = Field(description="npm lockfile schema version")
    packages: dict[str, ForkLockPackage] = Field(description="Lock entries by `node_modules/` path")


class ForkPi(BaseModel):
    model_config = LENIENT_STRICT_MODEL
    extensions: list[str] = Field(default_factory=list, description="Extension entry files Pi loads")


class ForkManifest(BaseModel):
    model_config = LENIENT_STRICT_MODEL
    name: str = Field(description="npm package name")
    version: Semver = Field(description="Fork package version")
    dependencies: dict[str, str] = Field(default_factory=dict, description="Runtime dependencies")
    optionalDependencies: dict[str, str] = Field(
        default_factory=dict, description="Optional runtime dependencies"
    )
    pi: ForkPi = Field(default_factory=ForkPi, description="Pi package manifest section")


class InstalledManifest(BaseModel):
    model_config = LENIENT_STRICT_MODEL
    version: str = Field(description="Installed version")


class LockedDependency(BaseModel):
    model_config = PROTOCOL_MODEL
    name: NonEmptyText = Field(description="Dependency package name")
    version: Semver = Field(description="Locked and installed version")
    integrity: Sha512Integrity = Field(description="Registry integrity from the fork lockfile")


class ForkIdentity(BaseModel):
    model_config = PROTOCOL_MODEL
    path: Literal["forks/pi-subagents"] = Field(description="Gitlink path in the parent repository")
    sha: Sha1Hex = Field(description="Commit that the parent Gitlinks and the fork HEAD all name")
    version: Semver = Field(description="Fork `package.json` version")
    lock_sha256: Sha256Hex = Field(description="SHA-256 of the fork's own, unmodified `package-lock.json`")
    dependencies: list[LockedDependency] = Field(
        min_length=1, description="Runtime dependencies installed from the lockfile"
    )

    @model_validator(mode="after")
    def _dependencies_are_the_runtime_set(self) -> Self:
        """Require exactly the expected runtime dependencies.

        Returns:
            Self: The validated model.

        Raises:
            ValueError: If the dependency names differ from `FORK_RUNTIME_DEPENDENCIES`.
        """
        names = tuple(sorted(dep.name for dep in self.dependencies))
        if names != tuple(sorted(FORK_RUNTIME_DEPENDENCIES)):
            raise ValueError(f"dependencies {names} are not {FORK_RUNTIME_DEPENDENCIES}")
        return self


def read_validated[M: BaseModel](model: type[M], path: Path, what: str) -> M:
    """Read and validate one JSON file the gate consumes.

    Parameters:
        model (type[M]): Boundary model.
        path (Path): File to read.
        what (str): Document name for diagnostics.

    Returns:
        M: The validated document.

    Raises:
        ContractError: If the file is unreadable, not JSON, or malformed.
    """
    try:
        return model.model_validate_json(path.read_text(encoding="utf-8"))
    except (OSError, ValidationError) as e:
        raise ContractError(f"Malformed {what} '{path}': {e}") from e


@dataclass(frozen=True)
class ForkInstall:
    """Result of installing the fork copy's locked runtime dependencies.

    Parameters:
        version (str): Fork `package.json` version.
        lock_sha256 (str): SHA-256 of the unmodified `package-lock.json`.
        dependencies (list[LockedDependency]): Installed runtime dependencies.
    """

    version: str
    lock_sha256: str
    dependencies: list[LockedDependency]


def install_fork_dependencies(fork_dir: Path, sandbox: Sandbox) -> ForkInstall:
    """Install the fork's locked runtime dependencies into its disposable copy and describe them.

    Uses the fork's own lockfile (`npm ci`, never a floating `npm install`), without lifecycle scripts,
    dev dependencies or peers. Registry access is allowed for this step only; `npm ci` verifies every
    integrity in the lockfile.

    Parameters:
        fork_dir (Path): Extracted fork archive, never the real checkout.
        sandbox (Sandbox): Scrubbed environment; proxies are cleared for this install.

    Returns:
        ForkInstall: Version, lockfile digest and installed dependencies.

    Raises:
        ContractError: If the lockfile or install deviates from the expected runtime set, a host
            package was installed, or the lockfile changed.
    """
    manifest = read_validated(ForkManifest, fork_dir / "package.json", "fork `package.json`")
    require(manifest.name == FORK_PACKAGE, f"fork package is '{manifest.name}', expected '{FORK_PACKAGE}'")
    require(
        manifest.pi.extensions == ["./src/index.ts"],
        f"fork `pi.extensions` is {manifest.pi.extensions}, expected ['./src/index.ts']",
    )
    require(
        sorted(manifest.dependencies) == sorted(FORK_RUNTIME_DEPENDENCIES),
        f"fork dependencies {sorted(manifest.dependencies)} differ from {sorted(FORK_RUNTIME_DEPENDENCIES)}",
    )
    require(not manifest.optionalDependencies, "the fork manifest declares unsupported optional dependencies")
    lock_path = fork_dir / "package-lock.json"
    lock_before = lock_path.read_bytes()
    lock = read_validated(ForkLockfile, lock_path, "fork lockfile")
    root = lock.packages.get("")
    require(
        root is not None
        and sorted(root.dependencies) == sorted(FORK_RUNTIME_DEPENDENCIES)
        and not root.optionalDependencies,
        "the fork lockfile's root dependencies differ from the fork `package.json`",
    )
    locked_runtime_dependencies(lock)
    run(
        [
            sandbox.tools.npm,
            "ci",
            "--ignore-scripts",
            "--omit=dev",
            "--omit=peer",
            "--no-audit",
            "--no-fund",
        ],
        env=sandbox.env() | {"HTTP_PROXY": "", "HTTPS_PROXY": ""},
        cwd=fork_dir,
        timeout=NPM_TIMEOUT_S,
    )
    require(lock_path.read_bytes() == lock_before, "`npm ci` modified the fork lockfile")
    dependencies = audit_fork_install(fork_dir, lock)
    return ForkInstall(manifest.version, hashlib.sha256(lock_before).hexdigest(), dependencies)


def locked_runtime_dependencies(lock: ForkLockfile) -> list[LockedDependency]:
    """Validate every supported runtime identity before any registry access.

    Parameters:
        lock (ForkLockfile): Parsed native fork lockfile.

    Returns:
        list[LockedDependency]: Complete validated runtime identities, sorted by name.

    Raises:
        ContractError: If a required identity is absent, malformed, or introduces an unsupported
            transitive dependency graph.
    """
    dependencies: list[LockedDependency] = []
    for name in sorted(FORK_RUNTIME_DEPENDENCIES):
        entry = lock.packages.get(f"node_modules/{name}")
        if entry is None or entry.version is None or entry.integrity is None:
            raise ContractError(f"the fork lockfile has no versioned, integrity-checked '{name}'")
        require(
            not entry.dependencies and not entry.optionalDependencies,
            f"unsupported runtime dependencies of '{name}' in the fork lockfile",
        )
        try:
            dependencies.append(LockedDependency(name=name, version=entry.version, integrity=entry.integrity))
        except ValidationError as e:
            raise ContractError(f"lock entry for '{name}' is malformed: {describe_validation(e)}") from e
    return dependencies


def audit_fork_install(fork_dir: Path, lock: ForkLockfile) -> list[LockedDependency]:
    """Check the installed tree is exactly the locked runtime dependencies, with no host copy.

    Parameters:
        fork_dir (Path): Fork copy after `npm ci`.
        lock (ForkLockfile): Its lockfile.

    Returns:
        list[LockedDependency]: Installed dependencies with their locked integrity, sorted by name.

    Raises:
        ContractError: On an extra or missing package, a version that differs from the lock, or any
            host package (`@earendil-works/*`, `typebox`) anywhere below `node_modules`.
    """
    modules = fork_dir / "node_modules"
    require(modules.is_dir(), f"`npm ci` produced no '{modules}'")
    top = sorted(p.name for p in modules.iterdir() if p.name not in {".bin", ".package-lock.json"})
    require(
        top == sorted(FORK_RUNTIME_DEPENDENCIES),
        f"fork `node_modules` holds {top}, expected exactly {sorted(FORK_RUNTIME_DEPENDENCIES)}",
    )
    host_names = {module.split("/", 1)[0] for module in HOST_MODULES}
    duplicates = sorted(
        p.relative_to(fork_dir).as_posix() for p in modules.rglob("*") if p.is_dir() and p.name in host_names
    )
    require(not duplicates, f"host packages installed into the fork copy: {duplicates}")
    nested = sorted(p.relative_to(fork_dir).as_posix() for p in modules.rglob("node_modules") if p.is_dir())
    require(not nested, f"unrecorded nested dependency trees in the fork copy: {nested}")
    dependencies = locked_runtime_dependencies(lock)
    for locked in dependencies:
        installed = read_validated(
            InstalledManifest, modules / locked.name / "package.json", f"installed '{locked.name}' manifest"
        )
        require(
            installed.version == locked.version,
            f"installed '{locked.name}' is {installed.version}, the lockfile says {locked.version}",
        )
    return dependencies


# --- agent files ----------------------------------------------------------------------------------

FRONTMATTER = re.compile(r"\A---\n(?P<front>.*?)\n---\n(?P<body>.*)\Z", re.DOTALL)
TOOLS_LINE = re.compile(r"^tools:[ \t]*(?P<value>.+)$", re.MULTILINE)


def split_agent_markdown(text: str) -> tuple[str, str]:
    """Split an agent file into frontmatter and body.

    Parameters:
        text (str): File content.

    Returns:
        tuple[str, str]: Frontmatter text (between the `---` fences) and the stripped body.

    Raises:
        ContractError: If the file has no frontmatter fence.
    """
    match = FRONTMATTER.match(text)
    if match is None:
        raise ContractError("agent file has no `---` frontmatter fence")
    return match.group("front"), match.group("body").strip()


def declared_tools(frontmatter: str) -> frozenset[str]:
    """Tool names an agent's `tools:` line grants: built-ins and the tool of each `ext:name/tool`.

    Parameters:
        frontmatter (str): Frontmatter text.

    Returns:
        frozenset[str]: Plain tool names.

    Raises:
        ContractError: If there is no `tools:` line or an `ext:` entry names no tool.
    """
    match = TOOLS_LINE.search(frontmatter)
    if match is None:
        raise ContractError("agent frontmatter has no `tools:` line")
    names: set[str] = set()
    for entry in (part.strip() for part in match.group("value").split(",")):
        if not entry:
            continue
        if entry.startswith("ext:"):
            _, _, tool = entry.removeprefix("ext:").partition("/")
            if not tool:
                raise ContractError(f"`{entry}` selects a whole extension, not a tool")
            names.add(tool)
        else:
            names.add(entry)
    return frozenset(names)


def override_agent(marker: str, tools: str, extensions: str) -> str:
    """Render a local override of the `code-reviewer` agent.

    Parameters:
        marker (str): Text proving this file's body reached the child's system prompt.
        tools (str): Value of the `tools:` line.
        extensions (str): Value of the `extensions:` line.

    Returns:
        str: Agent file content.
    """
    return (
        f"---\nname: {AGENT_TYPE}\ndescription: Local override ({marker})\n"
        f"tools: {tools}\nextensions: {extensions}\nprompt_mode: replace\n---\n"
        f"{marker}: you are a local override of the packaged reviewer.\n"
    )


# --- cases ----------------------------------------------------------------------------------------


@dataclass(frozen=True)
class CaseSpec:
    """One stock Pi run and what it must show.

    Parameters:
        name (str): Entry in `CASE_NAMES`.
        with_dev_tools (bool): Whether the installed dev-tools package is in `settings.json`.
        global_agent (str | None): Content of `<agent dir>/agents/code-reviewer.md`, if any.
        project_agent (str | None): Content of `<cwd>/.pi/agents/code-reviewer.md`, if any.
        expected_tools (frozenset[str]): Exact tool names the child's request must declare.
        prompt_marker (str): Text that must be in the child's system prompt.
        absent_markers (tuple[str, ...]): Texts that must NOT be in it (lower-precedence agents).
        extension_errors (int): The fork's `extension-error` diagnostics (its documented warnings for
            an `extensions:`/`ext:` name that did not load), 0 when everything resolved. The fork
            counts each as a tool use, so `toolUses` must equal this plus one per child call
            (refused calls end like any other).
        packaged_max_turns (int | None): `max_turns` the packaged frontmatter declares, if checked.
        allowed (ChildTool): Tool the child really calls; it must be in `expected_tools`.
        trust (Trust): One-time project-trust decision passed to the parent Pi run.
        project_scope (bool): Install the packages through `<cwd>/.pi/settings.json` (only a trusted
            project reads it) instead of the agent directory's `settings.json`.
        agent (str): Agent type the child actually runs as: `code-reviewer`, or the fork's documented
            `general-purpose` fallback when the requested type is not discoverable.
    """

    name: str
    with_dev_tools: bool
    global_agent: str | None
    project_agent: str | None
    expected_tools: frozenset[str]
    prompt_marker: str
    absent_markers: tuple[str, ...]
    extension_errors: int
    packaged_max_turns: int | None = None
    allowed: ChildTool = "read"
    trust: Trust = "no-approve"
    project_scope: bool = False
    agent: str = AGENT_TYPE

    @property
    def denied(self) -> tuple[str, ...]:
        """Tools the child tries to call although its allowlist excludes them.

        Returns:
            tuple[str, ...]: Members of `DENIED_TOOLS` absent from `expected_tools`, in order.
        """
        return tuple(tool for tool in DENIED_TOOLS if tool not in self.expected_tools)


class AgentDetails(BaseModel):
    model_config = LENIENT_STRICT_MODEL
    subagentType: str = Field(description="Agent type the call resolved to")
    status: str = Field(description="Terminal status of the child run")
    toolUses: int = Field(description="Tool activity events counted for the child")
    tags: list[str] = Field(default_factory=list, description="Metadata badges shown for the child")
    maxTurns: int | None = Field(default=None, description="Turn limit applied to the child")


class AgentResult(BaseModel):
    model_config = LENIENT_STRICT_MODEL
    content: list[ToolContentBlock] = Field(description="Result content blocks")
    details: AgentDetails = Field(description="Structured description of the child run")


class AgentRecord(BaseModel):
    model_config = LENIENT_STRICT_MODEL
    result: AgentResult = Field(description="`Agent` tool result")


class AssistantMessage(BaseModel):
    model_config = LENIENT_STRICT_MODEL
    content: list[ToolContentBlock] = Field(description="Assistant content blocks")


class AssistantEnd(BaseModel):
    model_config = LENIENT_STRICT_MODEL
    message: AssistantMessage = Field(description="Finished assistant message")


class CaseEvidence(TypedDict):
    """Return shape of `assess_case`."""

    case: str
    trust: str
    child_tools: list[str]
    prompt_marker: str
    child_text: str
    allowed_call: str
    denied_calls: list[str]
    tool_uses: int
    parent_tools: list[str]


class CaseEvidenceModel(BaseModel):
    model_config = PROTOCOL_MODEL
    case: Literal[
        "package-default",
        "global-override",
        "project-override",
        "project-override-untrusted",
        "missing-dev-tools",
        "project-package-trusted",
        "project-package-untrusted",
    ] = Field(description="Case name")
    trust: Trust = Field(description="Project-trust decision of the parent run")
    child_tools: list[NonEmptyText] = Field(min_length=1, description="Tools the child's request declared")
    prompt_marker: NonEmptyText = Field(description="Text found in the child's system prompt")
    child_text: NonEmptyText = Field(description="Text the `Agent` result returned from the child")
    allowed_call: NonEmptyText = Field(description="Tool the child really called and Pi ran")
    denied_calls: list[NonEmptyText] = Field(description="Tools the child called and Pi refused as unknown")
    tool_uses: int = Field(ge=0, description="`toolUses` of the `Agent` result")
    parent_tools: list[NonEmptyText] = Field(min_length=1, description="Tools the parent's request declared")


@dataclass(frozen=True)
class Targets:
    """Disposable files the child's calls act on.

    Parameters:
        repo (Path): Git repository with one commit (`LOG_SUBJECT`, tracked `note.txt`) and one
            untracked file (`UNTRACKED_NAME`).
        write_sentinel (Path): Path the forbidden `write` call tries to create; must stay absent.
        bash_sentinel (Path): Path the forbidden `bash` call tries to `touch`; must stay absent.
    """

    repo: Path
    write_sentinel: Path
    bash_sentinel: Path

    @property
    def note(self) -> Path:
        """Tracked file the allowed `read` call opens.

        Returns:
            Path: `<repo>/note.txt`.
        """
        return self.repo / "note.txt"


@dataclass(frozen=True)
class ChildCall:
    """One tool call the faux child makes and the text Pi must answer with.

    Parameters:
        tool (str): Tool name.
        arguments (dict[str, Any]): Call arguments, all pointing into `Targets`.
        expect (str): Substring of the tool result.
        allowed (bool): `True` when the call must run, `False` when Pi must refuse it as unknown.
    """

    tool: str
    arguments: dict[str, Any]
    expect: str
    allowed: bool


def seed_targets(root: Path, sandbox: Sandbox) -> Targets:
    """Create the disposable repository and sentinel locations under `root`.

    Parameters:
        root (Path): Directory to create (must not exist); never a live repository.
        sandbox (Sandbox): Scrubbed environment (no signing, no global git config).

    Returns:
        Targets: The seeded locations.
    """
    repo = root / "repo"
    repo.mkdir(parents=True)
    (repo / "note.txt").write_text(f"{NOTE_TEXT}\n")
    identity = ["-c", "user.name=Fork Contract", "-c", "user.email=fork-contract@example.invalid"]
    for args in (
        ["init", "--quiet", "--initial-branch=main"],
        ["add", "note.txt"],
        [*identity, "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", LOG_SUBJECT],
    ):
        git_text(sandbox, repo, *args)
    (repo / UNTRACKED_NAME).write_text("untracked\n")
    sentinels = root / "sentinels"
    sentinels.mkdir()
    return Targets(repo, sentinels / "forbidden-write.txt", sentinels / "forbidden-bash.txt")


def child_calls(spec: CaseSpec, targets: Targets) -> list[ChildCall]:
    """Derive the calls the child makes: the one allowed call, then every denied tool.

    Parameters:
        spec (CaseSpec): The case.
        targets (Targets): Seeded locations.

    Returns:
        list[ChildCall]: Calls in the order the child makes them.

    Raises:
        ContractError: If the spec's allowed tool is not in its allowlist.
    """
    require(
        spec.allowed in spec.expected_tools, f"[{spec.name}] allowed tool '{spec.allowed}' is not granted"
    )
    allowed = {
        "git_status": ChildCall("git_status", {"cwd": str(targets.repo)}, UNTRACKED_NAME, True),
        "git_log": ChildCall("git_log", {"cwd": str(targets.repo)}, LOG_SUBJECT, True),
        "read": ChildCall("read", {"path": str(targets.note)}, NOTE_TEXT, True),
    }[spec.allowed]
    # Every denied call is harmless by construction even if the allowlist were wrong: it writes a
    # sentinel, runs `touch` on one, reads a disposable repo, or commits there without pushing.
    denied = {
        "write": {"path": str(targets.write_sentinel), "content": "forbidden"},
        "bash": {"command": shlex.join(["/usr/bin/touch", str(targets.bash_sentinel)])},
        "git_status": {"cwd": str(targets.repo)},
        "git_commit": {
            "cwd": str(targets.repo),
            "subject": "Forbidden commit",
            "paths": ["note.txt"],
            "push": False,
        },
    }
    return [
        allowed,
        *(ChildCall(tool, denied[tool], f"Tool {tool} not found", False) for tool in spec.denied),
    ]


def agent_script(calls: Sequence[ChildCall]) -> tuple[list[ToolStep | TextStep], list[Route]]:
    """Build the parent script and the child route.

    Parameters:
        calls (Sequence[ChildCall]): Tool calls the child makes before its final answer.

    Returns:
        tuple[list[ToolStep | TextStep], list[Route]]: Parent turns (call `Agent`, then finish) and
            the route answering the child, keyed by `CHILD_MARKER` in the child's USER task only
            (the parent's own `Agent` arguments are in an assistant message and never match).
    """
    call = ToolStep(
        "Agent",
        {
            "description": "review the change",
            "prompt": f"{CHILD_MARKER}: review the working tree.",
            "subagent_type": AGENT_TYPE,
            "run_in_background": False,
        },
    )
    child: list[ToolStep | TextStep] = [ToolStep(c.tool, c.arguments) for c in calls]
    child.append(TextStep(CHILD_TEXT))
    return [call, TextStep(PARENT_TEXT)], [Route(CHILD_MARKER, child)]


def assess_case(
    spec: CaseSpec, result: PiRun, requests: Sequence[RecordedRequest], calls: Sequence[ChildCall]
) -> CaseEvidence:
    """Verify one run against its spec and distill the evidence.

    Parameters:
        spec (CaseSpec): Expectations.
        result (PiRun): The parent Pi run.
        requests (Sequence[RecordedRequest]): Requests the provider saw, parent and child.
        calls (Sequence[ChildCall]): What the child was scripted to call.

    Returns:
        CaseEvidence: Observed tools, marker, child text and tool uses.

    Raises:
        ContractError: On any deviation, including malformed consumed events.
    """
    what = f"[{spec.name}]"
    require_clean_run(result, what)
    parent = [r for r in requests if r.route is None]
    child = [r for r in requests if r.route == CHILD_MARKER]
    require(len(parent) == 2, f"{what} expected 2 parent requests, got {len(parent)}")
    require(
        len(child) == len(calls) + 1,
        f"{what} expected {len(calls) + 1} child requests (one per call plus the answer), got {len(child)}",
    )
    parent_tools = set(parent[0].tools)
    require("Agent" in parent_tools, f"{what} the fork's `Agent` tool is not loaded: {sorted(parent_tools)}")
    leaked = parent_tools & (REVIEWER_TOOLS - {"read", "grep", "find"})
    require(
        not leaked,
        f"{what} `--no-extensions` did not keep installed packages out of the parent: {sorted(leaked)}",
    )
    declared = set(child[0].tools)
    require(
        all(set(request.tools) == declared for request in child),
        f"{what} the child's tool list changed between its own requests",
    )
    require(
        declared == set(spec.expected_tools),
        f"{what} child tools {sorted(declared)} differ from expected {sorted(spec.expected_tools)}; "
        f"unexpected {sorted(declared - spec.expected_tools)}, "
        f"missing {sorted(spec.expected_tools - declared)}",
    )
    forbidden = declared & FORBIDDEN_REVIEWER_TOOLS
    require(
        not forbidden or spec.agent != AGENT_TYPE,
        f"{what} child exposes forbidden tools {sorted(forbidden)}",
    )
    system = child[0].system
    require(spec.prompt_marker in system, f"{what} child system prompt lacks the expected agent body")
    for other in spec.absent_markers:
        require(other not in system, f"{what} a lower-precedence agent body reached the child prompt")
    require(f'<active_agent name="{spec.agent}"/>' in system, f"{what} child prompt names another agent")
    outcomes = child[-1].tool_results
    require(
        len(outcomes) == len(calls),
        f"{what} the child saw {len(outcomes)} tool results for {len(calls)} calls",
    )
    for call, outcome in zip(calls, outcomes, strict=True):
        require(
            call.expect in outcome,
            f"{what} `{call.tool}` ({'allowed' if call.allowed else 'denied'}) answered "
            f"'{outcome[:200]}', expected it to contain '{call.expect}'",
        )

    record = result.single_tool_result("Agent")
    require(not tool_is_error(record), f"{what} `Agent` failed: {record.get('result')}")
    try:
        agent = AgentRecord.model_validate(record).result
    except ValidationError as e:
        raise ContractError(f"{what} malformed `Agent` result: {describe_validation(e)}") from e
    text = "".join(block.text for block in agent.content if block.type == "text")
    require(
        text.endswith(CHILD_TEXT),
        f"{what} `Agent` text does not end with the child's answer: '{text[-200:]}'",
    )
    details = agent.details
    require(
        (details.subagentType, details.status) == (spec.agent, "completed"),
        f"{what} `Agent` ended as {details.subagentType!r}/{details.status!r}",
    )
    expected_uses = len(calls) + spec.extension_errors
    require(
        details.toolUses == expected_uses,
        f"{what} `toolUses` is {details.toolUses}, expected {expected_uses} "
        f"({len(calls)} calls + {spec.extension_errors} extension diagnostics)",
    )
    if spec.packaged_max_turns is not None:
        require(
            details.maxTurns == spec.packaged_max_turns
            and f"max turns: {spec.packaged_max_turns}" in details.tags,
            f"{what} packaged metadata not applied: maxTurns={details.maxTurns} tags={details.tags}",
        )
    try:
        final = AssistantEnd.model_validate({"message": result.assistant_messages()[-1]})
    except (ValidationError, IndexError) as e:
        raise ContractError(f"{what} no well-formed final assistant message: {e}") from e
    require(
        PARENT_TEXT in "".join(b.text for b in final.message.content if b.type == "text"),
        f"{what} the parent did not finish with its scripted answer",
    )
    return {
        "case": spec.name,
        "trust": spec.trust,
        "child_tools": sorted(declared),
        "prompt_marker": spec.prompt_marker if len(spec.prompt_marker) <= 80 else spec.prompt_marker[:80],
        "child_text": CHILD_TEXT,
        "allowed_call": spec.allowed,
        "denied_calls": list(spec.denied),
        "tool_uses": details.toolUses,
        "parent_tools": sorted(parent_tools),
    }


@dataclass(frozen=True)
class ForkContext:
    """Everything the cases share.

    Parameters:
        pi_bin (Path): Stock `pi`.
        cases_dir (Path): Directory holding per-case sandboxes.
        base (Sandbox): Sandbox providing tool locations.
        fork_dir (Path): Archived fork copy with its locked dependencies.
        preset_dir (Path): Installed preset package.
        dev_tools_dir (Path): Installed dev-tools package.
    """

    pi_bin: Path
    cases_dir: Path
    base: Sandbox
    fork_dir: Path
    preset_dir: Path
    dev_tools_dir: Path


def run_case(ctx: ForkContext, spec: CaseSpec) -> CaseEvidence:
    """Run stock Pi for one case in a fresh sandbox and assess it.

    Parameters:
        ctx (ForkContext): Shared inputs.
        spec (CaseSpec): The case.

    Returns:
        CaseEvidence: Verified evidence.

    Raises:
        ContractError: If the run deviates from the spec.
    """
    sandbox = Sandbox(ctx.cases_dir / spec.name, ctx.base.tools)
    packages = [ctx.preset_dir, *([ctx.dev_tools_dir] if spec.with_dev_tools else [])]
    cwd = sandbox.root / "project"
    cwd.mkdir()
    settings = {"packages": [str(p) for p in packages]}
    settings_file = (
        (cwd / ".pi" / "settings.json") if spec.project_scope else (sandbox.agent_dir / "settings.json")
    )
    settings_file.parent.mkdir(parents=True, exist_ok=True)
    settings_file.write_text(json.dumps(settings))
    for content, target in (
        (spec.global_agent, sandbox.agent_dir / "agents"),
        (spec.project_agent, cwd / ".pi" / "agents"),
    ):
        if content is not None:
            target.mkdir(parents=True, exist_ok=True)
            (target / f"{AGENT_TYPE}.md").write_text(content)
    targets = seed_targets(sandbox.root / "targets", sandbox)
    head = git_text(sandbox, targets.repo, "rev-parse", "HEAD")
    calls = child_calls(spec, targets)
    parent_script, routes = agent_script(calls)
    with FauxProvider(parent_script, routes) as provider:
        (sandbox.agent_dir / "models.json").write_text(
            models_json(provider.base_url, PROVIDER, (PHYSICAL_MODEL,))
        )
        result = run_pi(
            ctx.pi_bin,
            sandbox,
            ctx.fork_dir,
            cwd,
            ["--model", f"{PROVIDER}/{PHYSICAL_MODEL}", "--mode", "json", "go"],
            trust=spec.trust,
        )
    evidence = assess_case(spec, result, provider.requests, calls)
    created = [p for p in (targets.write_sentinel, targets.bash_sentinel) if p.exists()]
    require(not created, f"[{spec.name}] a denied call had an effect: {[p.name for p in created]}")
    require(
        git_text(sandbox, targets.repo, "rev-parse", "HEAD") == head,
        f"[{spec.name}] the disposable repository's HEAD moved",
    )
    return evidence


def build_cases(packed_agent: str) -> list[CaseSpec]:
    """Derive the seven cases from the REAL packed `code-reviewer` file.

    Parameters:
        packed_agent (str): Content of `agents/code-reviewer.md` read from the preset tarball.

    Returns:
        list[CaseSpec]: Cases in `CASE_NAMES` order.

    Raises:
        ContractError: If the packed agent does not grant exactly `REVIEWER_TOOLS` or has no `max_turns`.
    """
    front, body = split_agent_markdown(packed_agent)
    granted = declared_tools(front)
    require(
        granted == REVIEWER_TOOLS,
        f"packed `code-reviewer` grants {sorted(granted)}, expected {sorted(REVIEWER_TOOLS)}",
    )
    turns = re.search(r"^max_turns:[ \t]*(\d+)[ \t]*$", front, re.MULTILINE)
    if turns is None:
        raise ContractError("packed `code-reviewer` declares no integer `max_turns`")
    global_agent = override_agent(GLOBAL_MARKER, "read, find", "false")
    project_agent = override_agent(PROJECT_MARKER, "read, ext:pi-dev-tools/git_log", "[pi-dev-tools]")
    return [
        CaseSpec(
            "package-default",
            True,
            None,
            None,
            REVIEWER_TOOLS | FORK_HELPER_TOOLS,
            body,
            (GLOBAL_MARKER, PROJECT_MARKER),
            0,
            int(turns.group(1)),
            "git_status",
        ),
        CaseSpec(
            "global-override",
            True,
            global_agent,
            None,
            frozenset({"read", "find"}),
            GLOBAL_MARKER,
            (body, PROJECT_MARKER),
            0,
            allowed="read",
        ),
        CaseSpec(
            "project-override",
            True,
            global_agent,
            project_agent,
            frozenset({"read", "git_log"}) | FORK_HELPER_TOOLS,
            PROJECT_MARKER,
            (body, GLOBAL_MARKER),
            0,
            allowed="git_log",
            trust="approve",
        ),
        # The fork consults Pi's canonical project-trust decision before reading `<cwd>/.pi/agents`:
        # the untrusted project agent is ignored and the global override wins, exactly as if the
        # project file did not exist.
        CaseSpec(
            "project-override-untrusted",
            True,
            global_agent,
            project_agent,
            frozenset({"read", "find"}),
            GLOBAL_MARKER,
            (body, PROJECT_MARKER),
            0,
            allowed="read",
            trust="no-approve",
        ),
        # `extensions: [pi-dev-tools]` and `ext:pi-dev-tools/...` both name a package that is not
        # installed. The fork documents warning (`extension-error:`), not refusal: the agent still
        # runs with its built-ins, and each of the two diagnostics counts as one `toolUses`.
        CaseSpec(
            "missing-dev-tools",
            False,
            None,
            None,
            frozenset({"read", "grep", "find"}) | FORK_HELPER_TOOLS,
            body,
            (GLOBAL_MARKER, PROJECT_MARKER),
            2,
            int(turns.group(1)),
            "read",
        ),
        CaseSpec(
            "project-package-trusted",
            True,
            None,
            None,
            REVIEWER_TOOLS | FORK_HELPER_TOOLS,
            body,
            (GLOBAL_MARKER, PROJECT_MARKER),
            0,
            int(turns.group(1)),
            "git_status",
            "approve",
            True,
        ),
        # A project-scoped install is read only when Pi trusts the project. Untrusted, `code-reviewer`
        # is not discoverable and the fork runs the documented `general-purpose` fallback: all
        # built-in tools, none of dev-tools. Pinned so a trust regression (the packaged reviewer
        # appearing for an untrusted project, or the reverse) fails here.
        CaseSpec(
            "project-package-untrusted",
            True,
            None,
            None,
            frozenset({"read", "grep", "find", "ls", "edit", "write", "bash"}) | FORK_HELPER_TOOLS,
            '<active_agent name="general-purpose"/>',
            (body, GLOBAL_MARKER, PROJECT_MARKER),
            0,
            allowed="read",
            trust="no-approve",
            project_scope=True,
            agent="general-purpose",
        ),
    ]


# --- report ---------------------------------------------------------------------------------------


class ArtifactIdentity(BaseModel):
    model_config = PROTOCOL_MODEL
    version: Semver = Field(description="Packed package version")
    tarball: TarballName = Field(description="Tarball file name")
    integrity: Sha512Integrity = Field(description="npm `sha512-` integrity of the tarball")
    shasum: Sha1Hex = Field(description="SHA-1 of the tarball")
    size: int = Field(gt=0, description="Tarball size in bytes")
    files: list[NonEmptyText] = Field(min_length=1, description="Files in the packed tarball")


class ForkContractReport(BaseModel):
    model_config = PROTOCOL_MODEL
    stock_pi: StockPiIdentity = Field(description="Pinned stock Pi identity")
    node: Annotated[str, StringConstraints(pattern=r"^v\d+\.\d+\.\d+")] = Field(
        description="Node version that ran the gate"
    )
    npm: Semver = Field(description="npm version that ran the gate")
    fork: ForkIdentity = Field(description="Selected pi-subagents fork and its installed dependencies")
    packages: dict[str, ArtifactIdentity] = Field(description="Packed preset and dev-tools tarballs")
    cases: list[CaseEvidenceModel] = Field(description="One verified entry per case, in order")

    @model_validator(mode="after")
    def _is_complete(self) -> Self:
        """Require both packages and every case exactly once.

        Returns:
            Self: The validated model.

        Raises:
            ValueError: If a package or case is missing, extra, or out of order.
        """
        expected = {PRESET_CONTRACT.name, DEV_TOOLS_CONTRACT.name}
        if set(self.packages) != expected:
            raise ValueError(f"packages {sorted(self.packages)} are not {sorted(expected)}")
        if tuple(case.case for case in self.cases) != CASE_NAMES:
            raise ValueError(f"cases {[c.case for c in self.cases]} are not {list(CASE_NAMES)}")
        return self


class ArtifactEvidence(TypedDict):
    """Return shape of `artifact_identity`, validated by `ArtifactIdentity` on serialization."""

    version: str
    tarball: str
    integrity: str
    shasum: str
    size: int
    files: list[str]


def artifact_identity(artifact: PackedArtifact) -> ArtifactEvidence:
    """Describe one tarball for the report.

    Parameters:
        artifact (PackedArtifact): Packed artifact.

    Returns:
        ArtifactEvidence: Fields of `ArtifactIdentity`.
    """
    return {
        "version": artifact.version,
        "tarball": artifact.path.name,
        "integrity": artifact.integrity,
        "shasum": artifact.shasum,
        "size": artifact.size,
        "files": list(artifact.files),
    }


def validate_fork_report(raw: Mapping[str, object]) -> ForkContractReport:
    """Validate the report at the serialization boundary.

    Parameters:
        raw (Mapping[str, object]): Report assembled from artifacts and case evidence.

    Returns:
        ForkContractReport: The validated report.

    Raises:
        ContractError: If any field is malformed.
    """
    try:
        return ForkContractReport.model_validate(raw)
    except ValidationError as e:
        raise ContractError(f"Fork report failed validation:\n{e}") from e


# --- orchestration --------------------------------------------------------------------------------


def pack_and_audit(
    repo_root: Path,
    contracts: Sequence[PackageContract],
    dest: Path,
    sandbox: Sandbox,
    supplied: Mapping[str, Path] | None = None,
) -> list[PackedArtifact]:
    """Pack the packages and fail on any tarball audit violation.

    Parameters:
        repo_root (Path): Repository root holding `packages/` and `LICENSE`.
        contracts (Sequence[PackageContract]): Packages to pack.
        dest (Path): Directory receiving the tarballs.
        sandbox (Sandbox): Environment for `npm`.
        supplied (Mapping[str, Path] | None): Existing tarballs, never repacked.

    Returns:
        list[PackedArtifact]: Audited artifacts, in order.

    Raises:
        ContractError: If any audit fails.
    """
    dest.mkdir(parents=True)
    root_license = (repo_root / "LICENSE").read_bytes()
    artifacts = [
        select_artifact(c, dest, sandbox, supplied or {}, repo_root / "packages" / c.directory)
        for c in contracts
    ]
    problems = [
        f"{a.contract.name}: {p}"
        for a in artifacts
        for p in audit_tarball(a, root_license, sandbox.tools.node)
    ]
    if problems:
        raise ContractError("Tarball audit failed:\n" + "\n".join(f"  - {p}" for p in problems))
    return artifacts


def run_fork_gate(
    work: Path,
    stock_prefix: Path,
    repo_root: Path = REPO_ROOT,
    supplied: Mapping[str, Path] | None = None,
) -> ForkContractReport:
    """Run the whole real-fork gate.

    Parameters:
        work (Path): Empty scratch directory.
        stock_prefix (Path): Reusable stock Pi install directory.
        repo_root (Path): Parent repository root.
        supplied (Mapping[str, Path] | None): Existing tarballs, never repacked.

    Returns:
        ForkContractReport: Validated identity and evidence report.

    Raises:
        ContractError: On the first deviation. The fork is preflighted before anything else runs.
    """
    tools = locate_tools()
    base = Sandbox(work / "base", tools)
    source = preflight_fork(repo_root, base)
    LOGGER.info(f"Selected fork '{source.path}' at {source.sha}")
    pi_bin = ensure_stock_pi(stock_prefix, base)
    preset, dev_tools = pack_and_audit(
        repo_root, [PRESET_CONTRACT, DEV_TOOLS_CONTRACT], work / "tarballs", base, supplied
    )
    installed = {
        artifact.contract.name: install_alone(artifact, base, work / f"install-{artifact.contract.directory}")
        for artifact in (preset, dev_tools)
    }
    fork_dir = work / "fork"
    archive_fork(source, fork_dir, base)
    installed_fork = install_fork_dependencies(fork_dir, base)
    ctx = ForkContext(
        pi_bin,
        work / "cases",
        base,
        fork_dir,
        installed[PRESET_CONTRACT.name],
        installed[DEV_TOOLS_CONTRACT.name],
    )
    (work / "cases").mkdir()
    cases = build_cases(read_member(preset.path, "agents/code-reviewer.md").decode("utf-8"))
    evidence = []
    for spec in cases:
        LOGGER.info(f"Case '{spec.name}' through stock Pi {STOCK_PI_VERSION} and the selected fork")
        evidence.append(run_case(ctx, spec))
    return validate_fork_report(
        {
            "stock_pi": {
                "package": STOCK_PI_PACKAGE,
                "version": STOCK_PI_VERSION,
                "integrity": STOCK_PI_INTEGRITY,
            },
            "node": run([tools.node, "--version"], env=base.env(), cwd=work, timeout=30).stdout.strip(),
            "npm": run([tools.npm, "--version"], env=base.env(), cwd=work, timeout=30).stdout.strip(),
            "fork": {
                "path": FORK_RELATIVE,
                "sha": source.sha,
                "version": installed_fork.version,
                "lock_sha256": installed_fork.lock_sha256,
                "dependencies": [dep.model_dump() for dep in installed_fork.dependencies],
            },
            "packages": {
                preset.contract.name: artifact_identity(preset),
                dev_tools.contract.name: artifact_identity(dev_tools),
            },
            "cases": list(evidence),
        }
    )


def parse_args(argv: Sequence[str] | None) -> argparse.Namespace:
    """Parse the command line.

    Parameters:
        argv (Sequence[str] | None): Arguments, or `None` for `sys.argv`.

    Returns:
        argparse.Namespace: Parsed options.
    """
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0] if __doc__ else None)
    parser.add_argument(
        "--stock-prefix", type=Path, default=DEFAULT_STOCK_PREFIX, help="Reusable stock Pi install directory"
    )
    parser.add_argument(
        "--work-dir", type=Path, help="Scratch directory (must be empty or absent); default: a temporary one"
    )
    parser.add_argument("--keep", action="store_true", help="Keep the scratch directory after the run")
    parser.add_argument("--tarball", action="append", default=[], metavar="DIRECTORY=PATH")
    parser.add_argument("--report", type=Path, help="Write the JSON identity/evidence report here")
    parser.add_argument(
        "--repo-root", type=Path, default=REPO_ROOT, help="Parent repository holding the fork Gitlink"
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    """Entry point.

    Parameters:
        argv (Sequence[str] | None): Arguments, or `None` for `sys.argv`.

    Returns:
        int: 0 when every contract holds, 1 on a violation or unavailable fork, 2 on a usage error.
    """
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    args = parse_args(argv)
    if args.work_dir is not None and args.work_dir.exists() and any(args.work_dir.iterdir()):
        LOGGER.error(f"`--work-dir` must be empty: '{args.work_dir}'")
        return 2
    work = args.work_dir or Path(tempfile.mkdtemp(prefix="pi-fork-contracts-"))
    work.mkdir(parents=True, exist_ok=True)
    try:
        supplied = parse_tarballs(args.tarball, [PRESET_CONTRACT, DEV_TOOLS_CONTRACT])
        report = run_fork_gate(
            work.resolve(), args.stock_prefix.resolve(), args.repo_root.resolve(), supplied
        )
    except ContractError as e:
        LOGGER.error(f"FAILED: {e}")
        return 1
    finally:
        if not args.keep:
            shutil.rmtree(work, ignore_errors=True)
    text = report.model_dump_json(indent=2) + "\n"
    if args.report:
        args.report.write_text(text)
    sys.stdout.write(text)
    LOGGER.info("fork package contracts: all passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
