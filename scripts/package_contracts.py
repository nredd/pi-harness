"""Packed-package independence gate for the `@nredd/pi-*` plugins against exact stock Pi.

For each package this builds the real npm tarball, audits its contents, installs it alone into a
fresh project, and drives it through a real, exact-version stock Pi install:

1. `npm pack`: file list must match a narrow allowlist; `LICENSE` must be byte-identical to the
   repository root; the packed manifest must keep host modules as `*` peers with no dependencies.
2. Source audit: every import in the tarball is relative (inside the package), a Node builtin, or a
   host-provided Pi module. No sibling plugin, no bundled host copy. Imports come from the installed
   TypeScript parser (`import_audit.ts`, one batched `node` run per package) rather than a regex;
   computed specifiers are rejected, not skipped. It is a syntactic audit, not a proof about `eval`.
3. Fresh install (`--ignore-scripts --legacy-peer-deps --offline`, like Pi's managed installs that
   suppress peer installation): `node_modules` holds only the package, never a host duplicate.
4. Stock Pi `--mode json` with only that package loaded (`--no-extensions --extension DIR`), a
   scrubbed environment, a temporary `HOME` and agent directory, no credentials, and a loopback
   scripted provider. The package must do real work: a dev tool result, a session-kit monitor and
   its stats artifact over a real session, and a router virtual model dispatching to a physical one.

Nothing here publishes anything or touches real Pi state. The stock Pi version and tarball
identities are recorded in the JSON report, which is a validated Pydantic model (`ContractReport`)
before it is serialized; nothing resolves "latest" at run time.

References:
    https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md
    https://docs.npmjs.com/cli/v11/commands/npm-pack
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Annotated, Any, Literal, Self, TypedDict

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    TypeAdapter,
    ValidationError,
    model_validator,
)

from faux_provider import FauxProvider, RecordedRequest, Step, TextStep, ToolStep, models_json

LOGGER = logging.getLogger(__name__)

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_STOCK_PREFIX = Path.home() / "code" / "pi-harness-builds" / "tools" / "pi-stock-1.3.0"

STOCK_PI_PACKAGE = "@earendil-works/pi-coding-agent"
STOCK_PI_VERSION = "1.3.0"
STOCK_PI_INTEGRITY = (
    "sha512-V/WoCjA2hQSe3QLWIUB24cTRdtEdeLiIzkDqU5RMXV6VWuD+KGZnzVBMhglwdnQTySkehZsjt8a3g6Jd2g4nnw=="
)

# Modules Pi supplies to extensions; they must be peers and never bundled or depended on.
HOST_MODULES = (
    "@earendil-works/pi-ai",
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-tui",
    "typebox",
)
SIBLING_SCOPE = "@nredd/"
PROVIDER = "local"  # Not `faux`: stats deliberately drop that provider name.
PHYSICAL_MODEL = "m"
PI_TIMEOUT_S = 120
NPM_TIMEOUT_S = 300
CODE_SUFFIXES = (".ts", ".mts", ".js", ".mjs")
NO_PROXY_VALUE = "127.0.0.1,localhost"
# Defense in depth for clients honoring proxy variables; this is not a network sandbox.
DEAD_PROXY = "http://127.0.0.1:9"

IMPORT_AUDIT = Path(__file__).with_name("import_audit.ts")
IMPORT_AUDIT_TIMEOUT_S = 120
STATS_ARTIFACT = "dist/pi-stats-export.mjs"
IMPORT_AUDIT_DIR = "pkg"  # Sources are laid out under this directory so the tsconfig cannot collide.


class ContractError(RuntimeError):
    """A package contract was violated, or the harness could not establish it."""


@dataclass(frozen=True)
class PackageContract:
    """Packaging expectations for one workspace package.

    Parameters:
        name (str): npm package name.
        directory (str): Directory under `packages/`.
        required (tuple[str, ...]): Files that must be in the tarball.
        allowed (tuple[re.Pattern[str], ...]): Every tarball path must match one of these.
        exposes_tools (frozenset[str]): Tool names unique to this package.
        license (str): Exact SPDX expression the packed manifest must declare.
    """

    name: str
    directory: str
    required: tuple[str, ...]
    allowed: tuple[re.Pattern[str], ...]
    exposes_tools: frozenset[str]
    license: str = "MIT"


CONTRACTS = (
    PackageContract(
        name="@nredd/pi-dev-tools",
        directory="dev-tools",
        required=("LICENSE", "README.md", "package.json", "src/index.ts"),
        allowed=(re.compile(r"^(LICENSE|README\.md|package\.json)$"), re.compile(r"^src/.+\.ts$")),
        exposes_tools=frozenset({"git_status"}),
    ),
    PackageContract(
        name="@nredd/pi-session-kit",
        directory="session-kit",
        required=("LICENSE", "README.md", "package.json", "src/index.ts", "dist/pi-stats-export.mjs"),
        allowed=(
            re.compile(r"^(LICENSE|README\.md|package\.json)$"),
            re.compile(r"^src/.+\.(ts|md)$"),
            re.compile(r"^dist/pi-stats-export\.mjs$"),
            re.compile(r"^docs/stats-snapshots\.md$"),
        ),
        exposes_tools=frozenset({"monitor_start", "monitor_read", "monitor_stop"}),
    ),
    PackageContract(
        name="@nredd/pi-subscription-router",
        directory="subscription-router",
        required=("LICENSE", "README.md", "package.json", "src/index.ts"),
        allowed=(
            re.compile(r"^(LICENSE|README\.md|CHANGELOG\.md|package\.json)$"),
            re.compile(r"^src/.+\.ts$"),
        ),
        exposes_tools=frozenset({"subscription_usage"}),
    ),
)

# The preset is audited and packed like the plugins but is deliberately NOT in `CONTRACTS`: it is not
# a standalone plugin (it relies on the forked pi-subagents and `@nredd/pi-dev-tools` for its agents),
# so `make check-package-contracts` does not run it. `fork_package_contracts.py` consumes it. Its
# themes are separately licensed, so the manifest must declare the full expression, and the license
# texts plus `NOTICE.md` are required content rather than optional extras.
PRESET_CONTRACT = PackageContract(
    name="@nredd/pi-preset",
    directory="preset",
    required=(
        "LICENSE",
        "NOTICE.md",
        "README.md",
        "package.json",
        "agents/code-reviewer.md",
        "extensions/expanded-footer.ts",
        "licenses/Apache-2.0-tokyonight.nvim.txt",
        "licenses/CC-BY-SA-4.0.txt",
        "licenses/MIT-enkia-tokyo-night-vscode-theme.txt",
        "themes/belafonte-day.json",
        "themes/tokyonight-storm.json",
    ),
    allowed=(
        re.compile(r"^(LICENSE|NOTICE\.md|README\.md|package\.json)$"),
        re.compile(r"^agents/[a-z-]+\.md$"),
        re.compile(r"^extensions/[a-z-]+\.ts$"),
        re.compile(r"^lib/[a-z-]+\.ts$"),
        re.compile(r"^licenses/[A-Za-z0-9.-]+\.txt$"),
        re.compile(r"^settings/[a-z-]+\.json$"),
        re.compile(r"^skills/[a-z-]+/SKILL\.md$"),
        re.compile(r"^themes/[a-z-]+\.json$"),
    ),
    exposes_tools=frozenset(),
    license="MIT AND Apache-2.0 AND CC-BY-SA-4.0",
)


# --- schemas --------------------------------------------------------------------------------------

STRICT_MODEL = ConfigDict(extra="forbid", frozen=True)
IGNORE_EXTRA_MODEL = ConfigDict(extra="ignore", frozen=True)

Sha512Integrity = Annotated[str, StringConstraints(pattern=r"^sha512-[A-Za-z0-9+/]{86}==$")]
Sha1Hex = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{40}$")]
Sha256Hex = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{64}$")]
Semver = Annotated[
    str, StringConstraints(pattern=r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$")
]
NonEmptyText = Annotated[str, StringConstraints(min_length=1)]
TarballName = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$")]


class NpmPackFile(BaseModel):
    model_config = IGNORE_EXTRA_MODEL
    path: NonEmptyText = Field(description="Path relative to the package root")


class NpmPackEntry(BaseModel):
    model_config = IGNORE_EXTRA_MODEL
    filename: TarballName = Field(description="Tarball file name inside the pack destination")
    integrity: Sha512Integrity = Field(description="npm `sha512-` integrity of the tarball")
    shasum: Sha1Hex = Field(description="SHA-1 of the tarball")
    files: list[NpmPackFile] = Field(min_length=1, description="Files npm says it packed")


class PackedManifestIdentity(BaseModel):
    model_config = IGNORE_EXTRA_MODEL
    name: NonEmptyText = Field(description="npm package name")
    version: Semver = Field(description="Package version")


def describe_validation(error: ValidationError) -> str:
    """Render a Pydantic failure as one line per offending field.

    Parameters:
        error (ValidationError): The validation failure.

    Returns:
        str: `; `-joined `field: message` entries.
    """
    return "; ".join(
        f"`{'.'.join(str(part) for part in item['loc']) or '<root>'}`: {item['msg']}"
        for item in error.errors()
    )


UuidV4 = Annotated[
    str, StringConstraints(pattern=r"^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$")
]
SnapshotMonth = Annotated[str, StringConstraints(pattern=r"^\d{4}-(0[1-9]|1[0-2])$")]
PROTOCOL_MODEL = ConfigDict(extra="forbid", frozen=True, strict=True)
LENIENT_STRICT_MODEL = ConfigDict(extra="ignore", frozen=True, strict=True)
STATS_MAX_BYTES = 128 * 1024 * 1024  # `MAX_BYTES` in `packages/session-kit/src/stats/snapshot.ts`.
STATS_MAX_MS = 8_640_000_000_000_000  # Largest valid JS `Date`, the `positive` bound there.


class PackedPi(BaseModel):
    model_config = LENIENT_STRICT_MODEL
    extensions: list[str] = Field(default_factory=list, description="Extension entry files Pi loads")


class PackedManifest(BaseModel):
    model_config = LENIENT_STRICT_MODEL
    name: str | None = Field(default=None, description="npm package name")
    private: bool | None = Field(default=None, description="Publication guard")
    license: str | None = Field(default=None, description="SPDX license identifier")
    dependencies: dict[str, str] = Field(default_factory=dict, description="Runtime dependencies")
    optionalDependencies: dict[str, str] = Field(default_factory=dict, description="Optional dependencies")
    bundledDependencies: list[str] | bool = Field(default=False, description="Bundled dependency names")
    bundleDependencies: list[str] | bool = Field(default=False, description="Alias of `bundledDependencies`")
    peerDependencies: dict[str, str] = Field(default_factory=dict, description="Peer dependency ranges")
    pi: PackedPi = Field(default_factory=PackedPi, description="Pi package manifest section")


class StatsShardRef(BaseModel):
    model_config = PROTOCOL_MODEL
    month: SnapshotMonth = Field(description="UTC month the shard covers")
    file: NonEmptyText = Field(description="Shard file name, exactly `<month>-<sha256>.json`")
    sha256: Sha256Hex = Field(description="SHA-256 of the exact shard bytes")
    bytes: int = Field(ge=0, le=STATS_MAX_BYTES, description="Shard size in bytes")

    @model_validator(mode="after")
    def _file_matches_identity(self) -> Self:
        """Require the documented content-addressed file name.

        Returns:
            Self: The validated model.

        Raises:
            ValueError: If `file` is not `<month>-<sha256>.json`.
        """
        if self.file != f"{self.month}-{self.sha256}.json":
            raise ValueError(f"shard file '{self.file}' is not '{self.month}-{self.sha256}.json'")
        return self


class StatsManifest(BaseModel):
    model_config = PROTOCOL_MODEL
    version: int = Field(ge=1, le=1, description="Snapshot schema version, exactly 1")
    machineId: UuidV4 = Field(description="Persistent installation UUID, matching its directory")
    label: Annotated[str, StringConstraints(min_length=1, max_length=1024)] = Field(
        description="Installation label"
    )
    exportedAt: int = Field(gt=0, le=STATS_MAX_MS, description="Export time, UTC Unix milliseconds")
    shards: list[StatsShardRef] = Field(description="One shard reference per month")

    @model_validator(mode="after")
    def _months_are_unique(self) -> Self:
        """Require exactly one shard per month.

        Returns:
            Self: The validated model.

        Raises:
            ValueError: If a month appears twice.
        """
        months = [ref.month for ref in self.shards]
        if len(set(months)) != len(months):
            raise ValueError(f"duplicate month in shards: {months}")
        return self


class StatsExportResult(BaseModel):
    model_config = PROTOCOL_MODEL
    machineId: UuidV4 = Field(description="Installation UUID that exported")
    snapshotDir: NonEmptyText = Field(description="`<OUT>/machines/<UUID>` directory written")


class StatsImportResult(BaseModel):
    model_config = PROTOCOL_MODEL
    imported: int = Field(ge=0, description="Machines imported this run")
    retained: int = Field(ge=0, description="Machines kept from earlier imports")
    problems: list[str] = Field(description="Coverage problems found")
    importedAt: int = Field(ge=0, le=STATS_MAX_MS, description="Last successful import, Unix milliseconds")


class ToolContentBlock(BaseModel):
    model_config = LENIENT_STRICT_MODEL
    type: str = Field(description="Content block kind")
    text: str = Field(default="", description="Text of a `text` block")


class ToolResult(BaseModel):
    model_config = LENIENT_STRICT_MODEL
    content: list[ToolContentBlock] = Field(description="Result content blocks")
    structuredContent: dict[str, object] | None = Field(
        default=None, description="Tool-specific payload, opaque until a scenario reads it"
    )


class ToolRecord(BaseModel):
    model_config = LENIENT_STRICT_MODEL
    result: ToolResult = Field(description="Tool result payload")


class ToolOutcome(BaseModel):
    model_config = LENIENT_STRICT_MODEL
    isError: bool = Field(description="Whether the tool reported failure")


class MessageEnvelope(BaseModel):
    model_config = LENIENT_STRICT_MODEL
    role: str | None = Field(default=None, description="Message author role")
    provider: str | None = Field(default=None, description="Provider that served an assistant message")
    model: str | None = Field(default=None, description="Model that served an assistant message")


class MessageEndEvent(BaseModel):
    model_config = LENIENT_STRICT_MODEL
    message: MessageEnvelope = Field(description="Finished message")


class LockEntry(BaseModel):
    model_config = LENIENT_STRICT_MODEL
    version: str | None = Field(default=None, description="Locked version")
    integrity: str | None = Field(default=None, description="Locked registry integrity")


class LockFile(BaseModel):
    model_config = LENIENT_STRICT_MODEL
    packages: dict[str, LockEntry] = Field(description="Lock entries by `node_modules/` path")


def parse_stats_json[M: BaseModel](model: type[M], text: str, what: str) -> M:
    """Parse and validate one stats protocol document.

    Parameters:
        model (type[M]): Boundary model.
        text (str): Raw JSON text.
        what (str): Document name for diagnostics, e.g. `manifest`.

    Returns:
        M: The validated document.

    Raises:
        ContractError: If the text is not JSON or does not match the documented shape.
    """
    try:
        return model.model_validate_json(text)
    except ValidationError as e:
        raise ContractError(f"Malformed stats {what}: {describe_validation(e)}") from e


class DevToolsEvidence(TypedDict):
    """Return shape of `scenario_dev_tools`."""

    tool: str
    untracked: list[str]
    failure_path: str


class SessionKitEvidence(TypedDict):
    """Return shape of `scenario_session_kit`."""

    tools: list[str]
    monitor_line: str
    stats_shards: int


class RouterEvidence(TypedDict):
    """Return shape of `scenario_router`."""

    virtual_model: str
    dispatched: str


ScenarioEvidence = DevToolsEvidence | SessionKitEvidence | RouterEvidence


class DevToolsEvidenceModel(BaseModel):
    model_config = STRICT_MODEL
    tool: Literal["git_status"] = Field(description="Tool the scenario ran")
    untracked: list[str] = Field(min_length=1, description="Untracked paths the real tool reported")
    failure_path: NonEmptyText = Field(description="Error text from the outside-a-repository run")


class SessionKitEvidenceModel(BaseModel):
    model_config = STRICT_MODEL
    tools: list[Literal["monitor_start", "monitor_read"]] = Field(
        min_length=1, description="Monitor tools the scenario exercised"
    )
    monitor_line: NonEmptyText = Field(description="Marker line the monitor captured")
    stats_shards: int = Field(ge=1, description="Shards in the exported stats manifest")


class RouterEvidenceModel(BaseModel):
    model_config = STRICT_MODEL
    virtual_model: Literal["router/default"] = Field(description="Virtual model that was requested")
    dispatched: Annotated[str, StringConstraints(pattern=r"^[^/\s]+/[^/\s]+$")] = Field(
        description="`provider/model` the virtual model dispatched to"
    )


EVIDENCE_MODELS: dict[str, type[BaseModel]] = {
    "@nredd/pi-dev-tools": DevToolsEvidenceModel,
    "@nredd/pi-session-kit": SessionKitEvidenceModel,
    "@nredd/pi-subscription-router": RouterEvidenceModel,
}


class StockPiIdentity(BaseModel):
    model_config = STRICT_MODEL
    package: str = Field(description="Stock Pi npm package name")
    version: Semver = Field(description="Stock Pi version")
    integrity: Sha512Integrity = Field(description="Stock Pi tarball integrity")

    @model_validator(mode="after")
    def _is_pinned(self) -> Self:
        """Reject any identity that is not the pinned one.

        Returns:
            Self: The validated model.

        Raises:
            ValueError: If the package, version or integrity differs from the pins.
        """
        pinned = (STOCK_PI_PACKAGE, STOCK_PI_VERSION, STOCK_PI_INTEGRITY)
        if (self.package, self.version, self.integrity) != pinned:
            raise ValueError(f"stock Pi identity is not the pinned {pinned!r}")
        return self


class PackageReport(BaseModel):
    model_config = STRICT_MODEL
    version: Semver = Field(description="Packed package version")
    tarball: TarballName = Field(description="Tarball file name")
    integrity: Sha512Integrity = Field(description="npm `sha512-` integrity of the tarball")
    shasum: Sha1Hex = Field(description="SHA-1 of the tarball")
    size: int = Field(gt=0, description="Tarball size in bytes")
    files: list[NonEmptyText] = Field(min_length=1, description="Files in the packed tarball")
    evidence: DevToolsEvidenceModel | SessionKitEvidenceModel | RouterEvidenceModel = Field(
        description="Scenario evidence for this package"
    )


class ContractReport(BaseModel):
    model_config = STRICT_MODEL
    stock_pi: StockPiIdentity = Field(description="Pinned stock Pi identity")
    node: Annotated[str, StringConstraints(pattern=r"^v\d+\.\d+\.\d+")] = Field(
        description="Node version that ran the contracts"
    )
    npm: Semver = Field(description="npm version that ran the contracts")
    license_sha256: Sha256Hex = Field(description="SHA-256 of the shared license text")
    packages: dict[str, PackageReport] = Field(
        min_length=1, description="Report entry per packed package name"
    )

    @model_validator(mode="after")
    def _packages_match_contracts(self) -> Self:
        """Cross-check each package entry against its contract.

        Returns:
            Self: The validated model.

        Raises:
            ValueError: If a package is unknown, its tarball name or file list is inconsistent, or its
                evidence belongs to another package.
        """
        for name, entry in self.packages.items():
            expected_model = EVIDENCE_MODELS.get(name)
            if expected_model is None:
                raise ValueError(f"unknown package '{name}'")
            if not isinstance(entry.evidence, expected_model):
                raise ValueError(f"evidence for '{name}' is a `{type(entry.evidence).__name__}`")
            expected_tarball = f"{name.removeprefix('@').replace('/', '-')}-{entry.version}.tgz"
            if entry.tarball != expected_tarball:
                raise ValueError(f"tarball '{entry.tarball}' is not '{expected_tarball}'")
            if len(set(entry.files)) != len(entry.files):
                raise ValueError(f"duplicate files for '{name}'")
        return self


def validate_report(raw: Mapping[str, object]) -> ContractReport:
    """Validate a report at the serialization boundary.

    Parameters:
        raw (Mapping[str, object]): Report assembled from artifacts and scenario evidence.

    Returns:
        ContractReport: The validated report.

    Raises:
        ContractError: If any identity or evidence field is malformed.
    """
    try:
        return ContractReport.model_validate(raw)
    except ValidationError as e:
        raise ContractError(f"Report failed validation:\n{e}") from e


def serialize_report(report: ContractReport) -> str:
    """Serialize a validated report as indented JSON.

    Parameters:
        report (ContractReport): Validated report.

    Returns:
        str: JSON text ending in a newline.
    """
    return report.model_dump_json(indent=2) + "\n"


@dataclass(frozen=True)
class PackedArtifact:
    """Identity of one built tarball.

    Parameters:
        contract (PackageContract): Package the tarball belongs to.
        path (Path): Tarball location.
        version (str): Package version from the packed manifest.
        integrity (str): npm `sha512-` integrity.
        shasum (str): SHA-1 as reported by `npm pack`.
        size (int): Tarball size in bytes.
        files (tuple[str, ...]): Paths inside the tarball without the `package/` prefix.
    """

    contract: PackageContract
    path: Path
    version: str
    integrity: str
    shasum: str
    size: int
    files: tuple[str, ...]


@dataclass(frozen=True)
class Tools:
    """Absolute paths of the executables the gate runs.

    Parameters:
        node (Path): `node`.
        npm (Path): `npm`.
        git (Path): `git`.
    """

    node: Path
    npm: Path
    git: Path


@dataclass
class Sandbox:
    """Scrubbed process environment rooted in a temporary directory.

    Parameters:
        root (Path): Directory holding `home`, `agent`, `tmp` and `npm-cache`.
        tools (Tools): Executables available on `PATH`.
        extra (dict[str, str]): Additional environment entries layered over the scrubbed base.
    """

    root: Path
    tools: Tools
    extra: dict[str, str] = field(default_factory=dict)

    def __post_init__(self) -> None:
        """Create the directory skeleton and empty npm config files."""
        for name in (
            "home",
            "agent",
            "tmp",
            "npm-cache",
            "codex",
            "xdg/config",
            "xdg/cache",
            "xdg/data",
            "xdg/state",
        ):
            (self.root / name).mkdir(parents=True, exist_ok=True)
        for name in ("npmrc-user", "npmrc-global"):
            (self.root / name).touch()

    @property
    def agent_dir(self) -> Path:
        """Isolated Pi agent directory (`PI_CODING_AGENT_DIR`).

        Returns:
            Path: `<root>/agent`.
        """
        return self.root / "agent"

    def env(self) -> dict[str, str]:
        """Build a minimal environment with no credentials or real config.

        Returns:
            dict[str, str]: The full environment for a child process.
        """
        bin_dirs = list(dict.fromkeys(str(tool.parent) for tool in (self.tools.node, self.tools.git)))
        env = {
            "PATH": os.pathsep.join([*bin_dirs, "/usr/bin", "/bin"]),
            "HOME": str(self.root / "home"),
            "TMPDIR": str(self.root / "tmp"),
            "TMP": str(self.root / "tmp"),
            "TEMP": str(self.root / "tmp"),
            "XDG_CONFIG_HOME": str(self.root / "xdg" / "config"),
            "XDG_CACHE_HOME": str(self.root / "xdg" / "cache"),
            "XDG_DATA_HOME": str(self.root / "xdg" / "data"),
            "XDG_STATE_HOME": str(self.root / "xdg" / "state"),
            "CODEX_HOME": str(self.root / "codex"),
            "LANG": "C.UTF-8",
            "PI_CODING_AGENT_DIR": str(self.agent_dir),
            "PI_OFFLINE": "1",
            "PI_SKIP_VERSION_CHECK": "1",
            "PI_TELEMETRY": "0",
            "HTTP_PROXY": DEAD_PROXY,
            "HTTPS_PROXY": DEAD_PROXY,
            "NO_PROXY": NO_PROXY_VALUE,
            "GIT_CONFIG_GLOBAL": "/dev/null",
            "GIT_CONFIG_NOSYSTEM": "1",
            "npm_config_cache": str(self.root / "npm-cache"),
            "npm_config_userconfig": str(self.root / "npmrc-user"),
            "npm_config_globalconfig": str(self.root / "npmrc-global"),
            "npm_config_update_notifier": "false",
        }
        return env | self.extra


def run(
    cmd: Sequence[str | Path],
    *,
    env: dict[str, str],
    cwd: Path,
    timeout: int,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    """Run an absolute-path command without a shell.

    Parameters:
        cmd (Sequence[str | Path]): Argument vector; `cmd[0]` must be absolute.
        env (dict[str, str]): Complete child environment.
        cwd (Path): Working directory.
        timeout (int): Seconds before the child is killed.
        check (bool): Raise `ContractError` on a nonzero exit.

    Returns:
        subprocess.CompletedProcess[str]: Captured text output.

    Raises:
        ContractError: On timeout, or on nonzero exit when `check` is set.
    """
    argv = [str(part) for part in cmd]
    if not Path(argv[0]).is_absolute():
        raise ValueError(f"Executable must be an absolute path: '{argv[0]}'")
    try:
        done = subprocess.run(
            argv,
            env=env,
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
            stdin=subprocess.DEVNULL,
        )
    except subprocess.TimeoutExpired as e:
        raise ContractError(f"`{' '.join(argv[:3])}` timed out after {timeout}s") from e
    if check and done.returncode != 0:
        raise ContractError(
            f"`{' '.join(argv[:3])}` exited {done.returncode}\n"
            f"stdout: {done.stdout[-2000:]}\nstderr: {done.stderr[-2000:]}"
        )
    return done


def locate_tools() -> Tools:
    """Resolve `node`, `npm` and `git` once so later runs never consult an untrusted `PATH`.

    Returns:
        Tools: Absolute executable paths.

    Raises:
        ContractError: If any executable is missing.
    """
    return Tools(node=locate_executable("node"), npm=locate_executable("npm"), git=locate_executable("git"))


def locate_executable(name: str) -> Path:
    """Resolve one executable on `PATH` to an absolute, symlink-free path.

    Parameters:
        name (str): Executable name.

    Returns:
        Path: Absolute path.

    Raises:
        ContractError: If the executable is missing.
    """
    located = shutil.which(name)
    if located is None:
        raise ContractError(f"`{name}` not found on PATH")
    return Path(located).resolve()


# --- stock Pi -------------------------------------------------------------------------------------


def ensure_stock_pi(prefix: Path, sandbox: Sandbox) -> Path:
    """Install exact stock Pi into `prefix` if needed, then verify its identity.

    Parameters:
        prefix (Path): Install directory, kept outside the source tree and reused across runs.
        sandbox (Sandbox): Environment for `npm`.

    Returns:
        Path: The `pi` executable.

    Raises:
        ContractError: If the installed version or registry integrity differs from the pins.
    """
    prefix.mkdir(parents=True, exist_ok=True)
    manifest = prefix / "package.json"
    if not manifest.exists():
        manifest.write_text(
            json.dumps(
                {"name": "pi-stock", "private": True, "dependencies": {STOCK_PI_PACKAGE: STOCK_PI_VERSION}},
                indent=2,
            )
            + "\n"
        )
    pi_bin = prefix / "node_modules" / ".bin" / "pi"
    if not pi_bin.exists():
        LOGGER.info(f"Installing {STOCK_PI_PACKAGE}@{STOCK_PI_VERSION} into '{prefix}'")
        run(
            [sandbox.tools.npm, "install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", prefix],
            env=sandbox.env() | {"HTTP_PROXY": "", "HTTPS_PROXY": ""},
            cwd=prefix,
            timeout=NPM_TIMEOUT_S,
        )
    verify_stock_pi(prefix, pi_bin, sandbox)
    return pi_bin


def read_lockfile(path: Path) -> LockFile:
    """Read the consumed part of an npm `package-lock.json`.

    Parameters:
        path (Path): Lockfile path.

    Returns:
        LockFile: Entries by `node_modules/` path.

    Raises:
        ContractError: If the file is unreadable, not JSON, or lacks a well-formed `packages` map.
    """
    try:
        return LockFile.model_validate_json(path.read_text())
    except (OSError, ValidationError) as e:
        raise ContractError(f"Malformed lockfile '{path}': {e}") from e


def verify_stock_pi(prefix: Path, pi_bin: Path, sandbox: Sandbox) -> None:
    """Check the installed Pi is exactly the pinned registry artifact.

    Parameters:
        prefix (Path): Install directory.
        pi_bin (Path): The `pi` executable.
        sandbox (Sandbox): Environment for the version probe.

    Raises:
        ContractError: On any identity mismatch.
    """
    lock = read_lockfile(prefix / "package-lock.json")
    entry = lock.packages.get(f"node_modules/{STOCK_PI_PACKAGE}", LockEntry())
    if entry.version != STOCK_PI_VERSION or entry.integrity != STOCK_PI_INTEGRITY:
        raise ContractError(
            f"Stock Pi in '{prefix}' is {entry.version!r} / {entry.integrity!r}, "
            f"expected {STOCK_PI_VERSION!r} / {STOCK_PI_INTEGRITY!r}"
        )
    reported = run([pi_bin, "--version"], env=sandbox.env(), cwd=prefix, timeout=PI_TIMEOUT_S).stdout.strip()
    if reported != STOCK_PI_VERSION:
        raise ContractError(f"`pi --version` reported '{reported}', expected '{STOCK_PI_VERSION}'")


# --- tarball audit --------------------------------------------------------------------------------


def pack(
    contract: PackageContract, dest: Path, sandbox: Sandbox, package_dir: Path | None = None
) -> PackedArtifact:
    """Run `npm pack` for one workspace package.

    Parameters:
        contract (PackageContract): Package to pack.
        dest (Path): Directory receiving the tarball.
        sandbox (Sandbox): Environment for `npm`.
        package_dir (Path | None): Directory to pack; defaults to the workspace package.

    Returns:
        PackedArtifact: Identity and file list as reported by npm and re-read from the tarball.

    Raises:
        ContractError: If npm output is malformed or disagrees with the tarball.
    """
    package_dir = package_dir or REPO_ROOT / "packages" / contract.directory
    done = run(
        [sandbox.tools.npm, "pack", "--json", "--ignore-scripts", "--pack-destination", dest],
        env=sandbox.env(),
        cwd=package_dir,
        timeout=NPM_TIMEOUT_S,
    )
    try:
        (report,) = TypeAdapter(list[NpmPackEntry]).validate_json(done.stdout)
    except (ValidationError, ValueError) as e:
        raise ContractError(
            f"Unparseable `npm pack --json` output for '{contract.name}': {done.stdout[:500]}"
        ) from e
    path = dest / report.filename
    data = path.read_bytes()
    digest = "sha512-" + base64.b64encode(hashlib.sha512(data).digest()).decode()
    if digest != report.integrity or hashlib.sha1(data, usedforsecurity=False).hexdigest() != report.shasum:
        raise ContractError(f"`npm pack` identity for '{contract.name}' disagrees with the tarball bytes")
    with tarfile.open(path) as tar:
        files = tuple(sorted(strip_prefix(member.name) for member in tar.getmembers() if member.isfile()))
    if files != tuple(sorted(entry.path for entry in report.files)):
        raise ContractError(f"`npm pack` file list for '{contract.name}' disagrees with its tarball")
    try:
        manifest = PackedManifestIdentity.model_validate_json(read_member(path, "package.json"))
    except ValidationError as e:
        raise ContractError(f"Packed `package.json` of '{contract.name}' has no usable identity: {e}") from e
    return PackedArtifact(contract, path, manifest.version, report.integrity, report.shasum, len(data), files)


def strip_prefix(name: str) -> str:
    """Drop npm's leading `package/` directory.

    Parameters:
        name (str): Tar member name.

    Returns:
        str: Path relative to the package root.
    """
    return PurePosixPath(name).relative_to("package").as_posix()


def read_member(tarball: Path, name: str) -> bytes:
    """Read one file out of an npm tarball.

    Parameters:
        tarball (Path): Tarball path.
        name (str): Path relative to the package root.

    Returns:
        bytes: File content.

    Raises:
        ContractError: If the member is absent or not a regular file.
    """
    with tarfile.open(tarball) as tar:
        try:
            member = tar.getmember(f"package/{name}")
        except KeyError as e:
            raise ContractError(f"'{tarball.name}' has no '{name}'") from e
        handle = tar.extractfile(member)
        if handle is None:
            raise ContractError(f"'{tarball.name}:{name}' is not a regular file")
        return handle.read()


def audit_files(contract: PackageContract, files: Sequence[str]) -> list[str]:
    """Check a tarball file list against the contract allowlist.

    Parameters:
        contract (PackageContract): Expectations.
        files (Sequence[str]): Tarball paths relative to the package root.

    Returns:
        list[str]: Violations; empty when the list conforms.
    """
    problems = [f"missing required file '{name}'" for name in contract.required if name not in files]
    problems += [
        f"unexpected file '{name}'"
        for name in files
        if not any(pattern.match(name) for pattern in contract.allowed)
    ]
    return problems


def audit_license(tarball: Path, root_license: bytes) -> list[str]:
    """Require the packed `LICENSE` to equal the repository root license byte for byte.

    Parameters:
        tarball (Path): Tarball path.
        root_license (bytes): Content of the repository `LICENSE`.

    Returns:
        list[str]: Violations; empty when identical.
    """
    try:
        packed = read_member(tarball, "LICENSE")
    except ContractError as e:
        return [str(e)]
    return [] if packed == root_license else ["packed `LICENSE` differs from the repository root `LICENSE`"]


def audit_manifest(contract: PackageContract, manifest: object, expected_files: Sequence[str]) -> list[str]:
    """Check the packed `package.json` for independence and publication safety.

    Only the audited fields are validated (see `PackedManifest`); other npm metadata is ignored on
    purpose. A malformed audited field is reported as a violation, never skipped.

    Parameters:
        contract (PackageContract): Expectations.
        manifest (object): Parsed packed manifest JSON value.
        expected_files (Sequence[str]): Files that must be reachable through `pi.extensions`.

    Returns:
        list[str]: Violations; empty when the manifest conforms.
    """
    try:
        parsed = PackedManifest.model_validate(manifest)
    except ValidationError as e:
        return [
            f"packed `package.json` field `{'.'.join(str(part) for part in item['loc']) or '<root>'}` "
            f"is malformed: {item['msg']}"
            for item in e.errors()
        ]
    problems: list[str] = []
    if parsed.name != contract.name:
        problems.append(f"name is '{parsed.name}', expected '{contract.name}'")
    if parsed.private is not True:
        problems.append("`private` must stay `true` until the publication prerequisites exist")
    if parsed.license != contract.license:
        problems.append(f"`license` must be '{contract.license}'")
    declared = {
        "dependencies": parsed.dependencies,
        "optionalDependencies": parsed.optionalDependencies,
        "bundledDependencies": parsed.bundledDependencies,
        "bundleDependencies": parsed.bundleDependencies,
    }
    problems += [
        f"`{key}` must be empty: host modules are peers and plugins are independent"
        for key, value in declared.items()
        if value
    ]
    peers = parsed.peerDependencies
    problems += [f"peer '{name}' is not a host module" for name in peers if name not in HOST_MODULES]
    problems += [
        f"peer '{name}' must use the range '*', not '{peers[name]}'" for name in peers if peers[name] != "*"
    ]
    extensions = parsed.pi.extensions
    if not extensions:
        problems.append("`pi.extensions` is empty")
    problems += [
        f"`pi.extensions` entry '{entry}' is not in the tarball"
        for entry in extensions
        if PurePosixPath(entry).as_posix().removeprefix("./") not in expected_files
    ]
    return problems


class FileImports(BaseModel):
    model_config = STRICT_MODEL
    specifiers: list[str] = Field(description="Every literal module specifier, in source order")
    diagnostics: list[str] = Field(
        description="`file:line:col: message` for syntax errors and computed specifiers"
    )


class ImportScan(BaseModel):
    model_config = STRICT_MODEL
    files: dict[str, FileImports] = Field(description="Parse results by path relative to the package root")


def scan_imports(sources: Mapping[str, str], node: Path) -> dict[str, FileImports]:
    """Parse JS/TS sources with the installed TypeScript parser in one batched `node` run.

    Parameters:
        sources (Mapping[str, str]): File text by path relative to the package root.
        node (Path): Absolute `node` path.

    Returns:
        dict[str, FileImports]: Specifiers and diagnostics for every input path.

    Raises:
        ContractError: If a path is unsafe, the helper fails, or its output is malformed.
    """
    if not sources:
        return {}
    for name in sources:
        pure = PurePosixPath(name)
        if pure.is_absolute() or ".." in pure.parts or not pure.parts:
            raise ContractError(f"Unsafe source path for the import audit: '{name}'")
    with tempfile.TemporaryDirectory(prefix="import-audit-") as scratch:
        root = Path(scratch)
        for name, text in sources.items():
            target = root / IMPORT_AUDIT_DIR / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text, encoding="utf-8")
        argv = [node, IMPORT_AUDIT, root, *(f"{IMPORT_AUDIT_DIR}/{name}" for name in sources)]
        env = {"PATH": os.pathsep.join([str(node.parent), "/usr/bin", "/bin"]), "HOME": str(root)}
        done = run(argv, env=env, cwd=root, timeout=IMPORT_AUDIT_TIMEOUT_S)
    try:
        scan = ImportScan.model_validate_json(done.stdout)
    except ValidationError as e:
        raise ContractError(f"Malformed `import_audit.ts` output: {e}") from e
    prefix = f"{IMPORT_AUDIT_DIR}/"
    found = {
        name.removeprefix(prefix): FileImports(
            specifiers=imports.specifiers,
            diagnostics=[problem.removeprefix(prefix) for problem in imports.diagnostics],
        )
        for name, imports in scan.files.items()
    }
    if found.keys() != sources.keys():
        raise ContractError(f"`import_audit.ts` returned {sorted(found)} for {sorted(sources)}")
    return found


def classify_imports(path: str, found: FileImports, files: Sequence[str]) -> list[str]:
    """Classify the parsed imports of one packed source file.

    Allowed: Node builtins (`node:` prefix), host-provided Pi modules, and relative paths that stay
    inside the package. Everything else, including any `@nredd/` sibling and any specifier the parser
    could not resolve to a literal, is a violation. The bundled stats artifact (`dist/`) may import
    `node:` builtins only; relative imports are forbidden too, because it is copied alone.

    Parameters:
        path (str): File path relative to the package root.
        found (FileImports): Parser output for the file.
        files (Sequence[str]): All tarball paths, to resolve relative imports.

    Returns:
        list[str]: Violations; empty when every import is acceptable.
    """
    problems = list(found.diagnostics)
    standalone = path.startswith("dist/")
    for spec in found.specifiers:
        if spec.startswith("node:"):
            continue
        if spec.startswith(SIBLING_SCOPE):
            problems.append(f"{path}: imports sibling plugin '{spec}'")
        elif standalone:
            problems.append(
                f"{path}: standalone artifact imports '{spec}', only `node:` builtins are allowed"
            )
        elif spec.startswith("."):
            target = PurePosixPath(os.path.normpath(PurePosixPath(path).parent / spec)).as_posix()
            stem = PurePosixPath(target).with_suffix("").as_posix()
            if target.startswith("..") or not any(
                f == target or PurePosixPath(f).with_suffix("").as_posix() == stem for f in files
            ):
                problems.append(f"{path}: relative import '{spec}' leaves the package or is missing")
        elif spec not in HOST_MODULES and not any(spec.startswith(f"{host}/") for host in HOST_MODULES):
            problems.append(f"{path}: imports '{spec}', which is neither a Node builtin nor a host module")
    return problems


def audit_imports(path: str, source: str, files: Sequence[str], node: Path | None = None) -> list[str]:
    """Parse and classify the imports of one source text.

    Parameters:
        path (str): File path relative to the package root.
        source (str): File text.
        files (Sequence[str]): All tarball paths, to resolve relative imports.
        node (Path | None): Absolute `node` path; resolved from `PATH` when `None`.

    Returns:
        list[str]: Violations; empty when every import is acceptable.
    """
    found = scan_imports({path: source}, node or locate_executable("node"))[path]
    return classify_imports(path, found, files)


def audit_tarball(artifact: PackedArtifact, root_license: bytes, node: Path | None = None) -> list[str]:
    """Run every static tarball audit.

    Parameters:
        artifact (PackedArtifact): Tarball to audit.
        root_license (bytes): Content of the repository `LICENSE`.
        node (Path | None): Absolute `node` path for the import audit; resolved from `PATH` when `None`.

    Returns:
        list[str]: All violations found.
    """
    contract = artifact.contract
    problems = audit_files(contract, artifact.files)
    problems += audit_license(artifact.path, root_license)
    try:
        manifest = json.loads(read_member(artifact.path, "package.json"))
    except (ContractError, ValueError) as e:
        problems.append(f"packed `package.json` is not valid JSON: {e}")
    else:
        problems += audit_manifest(contract, manifest, artifact.files)
    sources = {
        name: read_member(artifact.path, name).decode()
        for name in artifact.files
        if name.endswith(CODE_SUFFIXES)
    }
    scanned = scan_imports(sources, node or locate_executable("node"))
    for name, found in scanned.items():
        problems += classify_imports(name, found, artifact.files)
    return problems


# --- install --------------------------------------------------------------------------------------


def install_alone(artifact: PackedArtifact, sandbox: Sandbox, project: Path) -> Path:
    """Install one tarball into an empty project and prove no host or sibling copy came along.

    Parameters:
        artifact (PackedArtifact): Tarball to install.
        sandbox (Sandbox): Environment for `npm`.
        project (Path): New, empty project directory.

    Returns:
        Path: The installed package directory.

    Raises:
        ContractError: If anything besides the package landed in `node_modules` or the lockfile.
    """
    project.mkdir(parents=True)
    (project / "package.json").write_text('{"name": "contract-consumer", "private": true}\n')
    run(
        [
            sandbox.tools.npm,
            "install",
            "--ignore-scripts",
            "--legacy-peer-deps",
            "--offline",
            "--no-audit",
            "--no-fund",
            artifact.path,
        ],
        env=sandbox.env(),
        cwd=project,
        timeout=NPM_TIMEOUT_S,
    )
    installed = project / "node_modules" / artifact.contract.name
    entries = sorted(
        p.relative_to(project / "node_modules").as_posix()
        for p in (project / "node_modules").glob("*/*")
        if p.is_dir()
    )
    top = sorted(
        p.name for p in (project / "node_modules").iterdir() if p.name not in {".package-lock.json", ".bin"}
    )
    if entries != [artifact.contract.name] or top != [SIBLING_SCOPE.rstrip("/")]:
        raise ContractError(f"'{artifact.contract.name}' install pulled extra modules: {top} / {entries}")
    nested = [p for p in installed.rglob("node_modules") if p.is_dir()]
    if nested:
        raise ContractError(f"'{artifact.contract.name}' ships a nested `node_modules`: {nested}")
    lock = read_lockfile(project / "package-lock.json")
    if set(lock.packages) != {"", f"node_modules/{artifact.contract.name}"}:
        raise ContractError(
            f"Unexpected lockfile entries after installing '{artifact.contract.name}': "
            f"{sorted(lock.packages)}"
        )
    return installed


# --- stock Pi runs --------------------------------------------------------------------------------


@dataclass(frozen=True)
class PiRun:
    """Result of one stock Pi invocation in JSON mode.

    Parameters:
        returncode (int): Process exit code.
        events (tuple[dict[str, Any], ...]): Parsed stdout JSONL records.
        stdout (str): Raw stdout.
        stderr (str): Raw stderr.
    """

    returncode: int
    events: tuple[dict[str, Any], ...]
    stdout: str
    stderr: str

    def tool_results(self, name: str) -> list[dict[str, Any]]:
        """Return `tool_execution_end` records for one tool, in order.

        Parameters:
            name (str): Tool name.

        Returns:
            list[dict[str, Any]]: Matching records.
        """
        return [e for e in self.events if e.get("type") == "tool_execution_end" and e.get("toolName") == name]

    def assistant_messages(self) -> list[dict[str, Any]]:
        """Return finished assistant messages in order.

        Returns:
            list[dict[str, Any]]: `message_end` payloads with role `assistant`.

        Raises:
            ContractError: If a `message_end` event has no object `message`.
        """
        found: list[dict[str, Any]] = []
        for event in self.events:
            if event.get("type") != "message_end":
                continue
            try:
                parsed = MessageEndEvent.model_validate(event)
            except ValidationError as e:
                raise ContractError(f"Malformed `message_end` event: {describe_validation(e)}") from e
            if parsed.message.role == "assistant":
                found.append(event["message"])
        return found

    def single_tool_result(self, name: str) -> dict[str, Any]:
        """Return the one `tool_execution_end` record for a tool.

        Parameters:
            name (str): Tool name.

        Returns:
            dict[str, Any]: The record.

        Raises:
            ContractError: If the tool did not finish exactly once.
        """
        records = self.tool_results(name)
        if len(records) != 1:
            raise ContractError(f"Expected exactly one `{name}` result, got {len(records)}")
        return records[0]


def tool_text(record: dict[str, Any]) -> str:
    """Join the text blocks of a tool result record.

    Parameters:
        record (dict[str, Any]): A `tool_execution_end` event.

    Returns:
        str: Concatenated text content.

    Raises:
        ContractError: If the record has no well-formed `result.content`.
    """
    return "".join(block.text for block in parse_tool_record(record).result.content if block.type == "text")


def parse_tool_record(record: dict[str, Any]) -> ToolRecord:
    """Validate the consumed part of a `tool_execution_end` event.

    Parameters:
        record (dict[str, Any]): A `tool_execution_end` event.

    Returns:
        ToolRecord: Its result payload.

    Raises:
        ContractError: If `result` or `result.content` is missing or mistyped.
    """
    try:
        return ToolRecord.model_validate(record)
    except ValidationError as e:
        raise ContractError(
            f"Malformed tool result for '{record.get('toolName')}': {describe_validation(e)}"
        ) from e


def tool_is_error(record: dict[str, Any]) -> bool:
    """Read a tool record's `isError` flag, which must be a real boolean.

    Parameters:
        record (dict[str, Any]): A `tool_execution_end` event.

    Returns:
        bool: Whether the tool reported failure.

    Raises:
        ContractError: If `isError` is missing or not a boolean.
    """
    try:
        return ToolOutcome.model_validate(record).isError
    except ValidationError as e:
        raise ContractError(
            f"Malformed tool result for '{record.get('toolName')}': {describe_validation(e)}"
        ) from e


def parse_events(stdout: str) -> tuple[dict[str, Any], ...]:
    """Parse Pi's strict LF-framed JSONL stream.

    Parameters:
        stdout (str): Raw stdout.

    Returns:
        tuple[dict[str, Any], ...]: One object per record.

    Raises:
        ContractError: If a record is not a JSON object.
    """
    events: list[dict[str, Any]] = []
    for line in stdout.split("\n"):
        if not line.strip():
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError as e:
            raise ContractError(f"Non-JSON line in Pi JSON mode: '{line[:200]}'") from e
        if not isinstance(event, dict):
            raise ContractError(f"Non-object record in Pi JSON mode: '{line[:200]}'")
        events.append(event)
    return tuple(events)


def run_pi(
    pi_bin: Path,
    sandbox: Sandbox,
    package_dir: Path,
    cwd: Path,
    extra: Sequence[str],
    *,
    session_dir: Path | None = None,
    trust: Literal["approve", "no-approve"] = "no-approve",
) -> PiRun:
    """Run stock Pi non-interactively with exactly one package loaded.

    Only safe, documented flags: `--offline`, `--no-mcp`, `--no-extensions` (with an explicit `--extension`),
    `--no-skills`, `--no-prompt-templates`, `--no-themes`, `--no-context-files`, and one explicit
    project-trust decision (`--no-approve` unless `trust` says otherwise).

    Parameters:
        pi_bin (Path): Stock `pi`.
        sandbox (Sandbox): Scrubbed environment.
        package_dir (Path): Installed package directory to load.
        cwd (Path): Working directory for the run.
        extra (Sequence[str]): Remaining arguments (model, mode, prompt).
        session_dir (Path | None): Persist the session here; `None` keeps it in memory.
        trust (Literal["approve", "no-approve"]): One-time project-trust decision (`--approve` or
            `--no-approve`); Pi then never consults or writes a saved decision.

    Returns:
        PiRun: Exit code, parsed events and raw streams.
    """
    session = ["--session-dir", str(session_dir)] if session_dir else ["--no-session"]
    argv = [
        pi_bin,
        "--offline",
        f"--{trust}",
        "--no-mcp",
        "--no-extensions",
        "--extension",
        package_dir,
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
        *session,
        *extra,
    ]
    done = run(argv, env=sandbox.env(), cwd=cwd, timeout=PI_TIMEOUT_S, check=False)
    return PiRun(
        done.returncode, parse_events(done.stdout) if "--mode" in extra else (), done.stdout, done.stderr
    )


def require(condition: bool, message: str) -> None:
    """Raise `ContractError` unless `condition` holds.

    Parameters:
        condition (bool): Predicate that must be true.
        message (str): Failure description.

    Raises:
        ContractError: When `condition` is false.
    """
    if not condition:
        raise ContractError(message)


def require_clean_run(result: PiRun, what: str) -> None:
    """Require a successful Pi run with no extension errors or stray diagnostics.

    Parameters:
        result (PiRun): The run.
        what (str): Description for failure messages.

    Raises:
        ContractError: On a nonzero exit or any stderr output.
    """
    require(result.returncode == 0, f"{what}: pi exited {result.returncode}\n{result.stderr[-2000:]}")
    require(not result.stderr.strip(), f"{what}: unexpected stderr\n{result.stderr[-2000:]}")


def require_tools(
    result: PiRun,
    contract: PackageContract,
    siblings: Sequence[PackageContract],
    requests: Sequence[RecordedRequest],
) -> None:
    """Require the package's tools declared to the model and no sibling's.

    Parameters:
        result (PiRun): The run, for context in messages.
        contract (PackageContract): Package under test.
        siblings (Sequence[PackageContract]): Every other package.
        requests (Sequence[RecordedRequest]): Requests seen by the provider.

    Raises:
        ContractError: If an expected tool is missing or a sibling's tool is present.
    """
    require(bool(requests), f"{contract.name}: the provider received no request\n{result.stderr[-500:]}")
    declared = set(requests[0].tools)
    present = contract.exposes_tools & declared
    require(
        bool(present),
        f"{contract.name}: none of {sorted(contract.exposes_tools)} declared; got {sorted(declared)}",
    )
    foreign = declared & {tool for other in siblings for tool in other.exposes_tools}
    require(not foreign, f"{contract.name}: sibling tools present without the sibling: {sorted(foreign)}")


@dataclass(frozen=True)
class Context:
    """Everything a standalone scenario needs.

    Parameters:
        pi_bin (Path): Stock `pi`.
        sandbox (Sandbox): Scrubbed environment.
        installed (Path): Installed package directory.
        artifact (PackedArtifact): Tarball identity.
        work (Path): Scenario scratch directory.
        siblings (tuple[PackageContract, ...]): Other packages' contracts.
    """

    pi_bin: Path
    sandbox: Sandbox
    installed: Path
    artifact: PackedArtifact
    work: Path
    siblings: tuple[PackageContract, ...]

    def provider_session(self, script: Sequence[Step]) -> FauxProvider:
        """Write `models.json` for a loopback provider running `script`.

        Parameters:
            script (Sequence[Step]): Scripted turns.

        Returns:
            FauxProvider: Provider to use as a context manager around the Pi run.
        """
        provider = FauxProvider(script)
        (self.sandbox.agent_dir / "models.json").write_text(
            models_json(provider.base_url, PROVIDER, (PHYSICAL_MODEL,))
        )
        return provider

    def git(self, repo: Path, *args: str) -> None:
        """Run `git` in a disposable repository.

        Parameters:
            repo (Path): Repository directory.
            *args (str): Git arguments.
        """
        run([self.sandbox.tools.git, "-C", repo, *args], env=self.sandbox.env(), cwd=repo, timeout=60)


def scenario_dev_tools(ctx: Context) -> DevToolsEvidence:
    """Real `git_status` result, and its failure path, through stock Pi.

    Parameters:
        ctx (Context): Scenario context.

    Returns:
        DevToolsEvidence: Evidence recorded in the report.

    Raises:
        ContractError: If the tool misbehaves.
    """
    repo = ctx.work / "repo"
    repo.mkdir()
    ctx.git(repo, "init", "-q", "-b", "main")
    (repo / "untracked.txt").write_text("x\n")
    script = [ToolStep("git_status"), TextStep("done")]
    with ctx.provider_session(script) as provider:
        ok = run_pi(
            ctx.pi_bin,
            ctx.sandbox,
            ctx.installed,
            repo,
            ["--model", f"{PROVIDER}/{PHYSICAL_MODEL}", "--mode", "json", "go"],
        )
    require_clean_run(ok, "dev-tools git_status")
    require_tools(ok, ctx.artifact.contract, ctx.siblings, provider.requests)
    record = ok.single_tool_result("git_status")
    require(not tool_is_error(record), f"git_status failed: {tool_text(record)}")
    structured = parse_tool_record(record).result.structuredContent
    require(
        structured is not None and structured.get("untracked") == ["untracked.txt"],
        f"unexpected status: {record.get('result')}",
    )

    not_repo = ctx.work / "not-a-repo"
    not_repo.mkdir()
    with ctx.provider_session(script):
        bad = run_pi(
            ctx.pi_bin,
            ctx.sandbox,
            ctx.installed,
            not_repo,
            ["--model", f"{PROVIDER}/{PHYSICAL_MODEL}", "--mode", "json", "go"],
        )
    require_clean_run(bad, "dev-tools git_status outside a repository")
    failed = bad.single_tool_result("git_status")
    require(
        tool_is_error(failed),
        f"git_status outside a repository must be an error result: {failed.get('result')}",
    )
    return {"tool": "git_status", "untracked": ["untracked.txt"], "failure_path": tool_text(failed)[:200]}


def scenario_session_kit(ctx: Context) -> SessionKitEvidence:
    """Real monitor tools, then the standalone stats artifact over the resulting real session.

    Parameters:
        ctx (Context): Scenario context.

    Returns:
        SessionKitEvidence: Evidence recorded in the report.

    Raises:
        ContractError: If the monitor or the artifact misbehaves.
    """
    marker = "kit-contract-line"
    script = [
        ToolStep(
            "monitor_start",
            {"name": "contract", "argv": [str(ctx.sandbox.tools.node), "-e", f"console.log('{marker}')"]},
        ),
        ToolStep("monitor_read", {"id": "contract"}),
        TextStep("done"),
    ]
    project = ctx.work / "project"
    project.mkdir()
    sessions = ctx.sandbox.agent_dir / "sessions"
    with ctx.provider_session(script) as provider:
        result = run_pi(
            ctx.pi_bin,
            ctx.sandbox,
            ctx.installed,
            project,
            ["--model", f"{PROVIDER}/{PHYSICAL_MODEL}", "--mode", "json", "go"],
            session_dir=sessions,
        )
    require_clean_run(result, "session-kit monitor")
    require_tools(result, ctx.artifact.contract, ctx.siblings, provider.requests)
    started = result.single_tool_result("monitor_start")
    require(
        not tool_is_error(started) and "started m1" in tool_text(started),
        f"monitor_start: {tool_text(started)}",
    )
    read = result.single_tool_result("monitor_read")
    require(marker in tool_text(read), f"monitor_read missed '{marker}': {tool_text(read)}")

    # The exact packed bytes must run with only `node`, alone in an unrelated directory (no sibling
    # `src/`, package or `node_modules`), over that real session.
    manifest = exercise_stats_artifact(
        ctx.sandbox.tools.node,
        read_member(ctx.artifact.path, STATS_ARTIFACT),
        ctx.sandbox.env(),
        ctx.sandbox.agent_dir,
        ctx.work,
    )
    return {
        "tools": ["monitor_start", "monitor_read"],
        "monitor_line": marker,
        "stats_shards": len(manifest.shards),
    }


def exercise_stats_artifact(
    node: Path, artifact: bytes, env: dict[str, str], agent_dir: Path, work: Path
) -> StatsManifest:
    """Export and import a real session with the stats artifact copied alone into `work`.

    The artifact lives in `work/standalone` with nothing else, so a relative import into the package
    (`../src/...`) or a bare package import cannot resolve, exactly as when the file is copied out.

    Parameters:
        node (Path): Absolute `node` path.
        artifact (bytes): Exact bytes of the packed `dist/pi-stats-export.mjs`.
        env (dict[str, str]): Complete child environment.
        agent_dir (Path): Agent directory holding the real session to export.
        work (Path): Scratch directory; created if absent and used only for this run.

    Returns:
        StatsManifest: The validated exported manifest.

    Raises:
        ContractError: If any command fails or any consumed document is malformed.
    """
    standalone = work / "standalone"
    standalone.mkdir(parents=True)
    script = standalone / "pi-stats-export.mjs"
    script.write_bytes(artifact)
    outside = work / "artifact-cwd"
    outside.mkdir()
    snapshots = work / "snapshots"
    exported = run(
        [node, script, "export", "--agent-dir", agent_dir, "--output", snapshots],
        env=env,
        cwd=outside,
        timeout=PI_TIMEOUT_S,
    )
    export = parse_stats_json(StatsExportResult, exported.stdout, "export")
    expected_dir = snapshots / "machines" / export.machineId
    require(
        Path(export.snapshotDir) == expected_dir, f"export wrote '{export.snapshotDir}', not '{expected_dir}'"
    )
    try:
        manifest_text = (expected_dir / "manifest.json").read_text()
    except OSError as e:
        raise ContractError(f"export left no readable manifest in '{expected_dir}': {e}") from e
    manifest = parse_stats_json(StatsManifest, manifest_text, "manifest")
    require(manifest.machineId == export.machineId, f"export: manifest is for '{manifest.machineId}'")
    require(bool(manifest.shards), "export: the manifest references no shards")
    other = work / "other-agent"
    other.mkdir()
    imported = parse_stats_json(
        StatsImportResult,
        run(
            [node, script, "import", "--agent-dir", other, "--input", snapshots],
            env=env,
            cwd=outside,
            timeout=PI_TIMEOUT_S,
        ).stdout,
        "import",
    )
    require(
        (imported.imported, imported.retained, imported.problems) == (1, 0, []),
        f"import: {imported}",
    )
    bad = run(
        [node, script, "export", "--bogus", "x"], env=env, cwd=outside, timeout=PI_TIMEOUT_S, check=False
    )
    require(bad.returncode != 0, "stats artifact accepted an unknown flag")
    return manifest


def scenario_router(ctx: Context) -> RouterEvidence:
    """Virtual `router/default` registration and dispatch to a physical model, plus a rejected config.

    Parameters:
        ctx (Context): Scenario context.

    Returns:
        RouterEvidence: Evidence recorded in the report.

    Raises:
        ContractError: If routing misbehaves.
    """
    config = ctx.sandbox.agent_dir / "subscription-router.json"
    config.write_text(
        json.dumps(
            {
                "profiles": {
                    "default": {"name": "Contract", "chain": [{"model": f"{PROVIDER}/{PHYSICAL_MODEL}"}]}
                }
            }
        )
    )
    project = ctx.work / "project"
    project.mkdir()
    base = ["--mode", "json", "go"]
    with ctx.provider_session([TextStep("routed")]) as provider:
        listing = run_pi(ctx.pi_bin, ctx.sandbox, ctx.installed, project, ["--list-models", "router"])
        routed = run_pi(ctx.pi_bin, ctx.sandbox, ctx.installed, project, ["--model", "router/default", *base])
    require(
        listing.returncode == 0 and "default" in listing.stdout,
        f"router/default not listed:\n{listing.stdout}{listing.stderr}",
    )
    require_clean_run(routed, "router dispatch")
    require_tools(routed, ctx.artifact.contract, ctx.siblings, provider.requests)
    require(
        [r.model for r in provider.requests] == [PHYSICAL_MODEL], f"physical requests: {provider.requests}"
    )
    answers = routed.assistant_messages()
    require(len(answers) == 1, f"expected one assistant message, got {len(answers)}")
    answer = MessageEnvelope.model_validate(answers[0])
    require(
        (answer.provider, answer.model) == (PROVIDER, PHYSICAL_MODEL),
        f"dispatched to {answer.provider}/{answer.model}",
    )

    config.write_text(json.dumps({"profiles": {"Bad Id": {"chain": []}}}))
    with ctx.provider_session([TextStep("unused")]):
        rejected = run_pi(ctx.pi_bin, ctx.sandbox, ctx.installed, project, ["--list-models", "router"])
    require(rejected.returncode == 0, f"a rejected router config must not crash Pi:\n{rejected.stderr}")
    require(
        "default" not in rejected.stdout and "Bad Id" not in rejected.stdout,
        f"rejected config registered models:\n{rejected.stdout}",
    )
    return {"virtual_model": "router/default", "dispatched": f"{PROVIDER}/{PHYSICAL_MODEL}"}


SCENARIOS: dict[str, Callable[[Context], ScenarioEvidence]] = {
    "dev-tools": scenario_dev_tools,
    "session-kit": scenario_session_kit,
    "subscription-router": scenario_router,
}


# --- orchestration --------------------------------------------------------------------------------


def run_gate(work: Path, stock_prefix: Path, only: Sequence[str] | None) -> ContractReport:
    """Run the whole contract gate and build the identity/evidence report.

    Parameters:
        work (Path): Empty scratch directory for tarballs, installs and sandboxes.
        stock_prefix (Path): Reusable stock Pi install directory.
        only (Sequence[str] | None): Package directories to restrict to; `None` runs all.

    Returns:
        ContractReport: Validated report.

    Raises:
        ContractError: On the first violated contract or a malformed report, after all static audits ran.
    """
    tools = locate_tools()
    root_license = (REPO_ROOT / "LICENSE").read_bytes()
    base = Sandbox(work / "base", tools)
    pi_bin = ensure_stock_pi(stock_prefix, base)
    selected = [c for c in CONTRACTS if only is None or c.directory in only]
    tarballs = work / "tarballs"
    tarballs.mkdir()
    artifacts = [pack(contract, tarballs, base) for contract in selected]

    problems = [
        f"{a.contract.name}: {p}" for a in artifacts for p in audit_tarball(a, root_license, tools.node)
    ]
    if problems:
        raise ContractError("Tarball audit failed:\n" + "\n".join(f"  - {p}" for p in problems))

    packages: dict[str, object] = {}
    for artifact in artifacts:
        contract = artifact.contract
        sandbox = Sandbox(work / f"sandbox-{contract.directory}", tools)
        installed = install_alone(artifact, sandbox, sandbox.root / "project")
        scratch = sandbox.root / "scenario"
        scratch.mkdir()
        siblings = tuple(c for c in CONTRACTS if c is not contract)
        LOGGER.info(f"Exercising '{contract.name}' through stock Pi {STOCK_PI_VERSION}")
        evidence = SCENARIOS[contract.directory](
            Context(pi_bin, sandbox, installed, artifact, scratch, siblings)
        )
        packages[contract.name] = {
            "version": artifact.version,
            "tarball": artifact.path.name,
            "integrity": artifact.integrity,
            "shasum": artifact.shasum,
            "size": artifact.size,
            "files": list(artifact.files),
            "evidence": evidence,
        }
    return validate_report(
        {
            "stock_pi": {
                "package": STOCK_PI_PACKAGE,
                "version": STOCK_PI_VERSION,
                "integrity": STOCK_PI_INTEGRITY,
            },
            "node": run([tools.node, "--version"], env=base.env(), cwd=work, timeout=30).stdout.strip(),
            "npm": run([tools.npm, "--version"], env=base.env(), cwd=work, timeout=30).stdout.strip(),
            "license_sha256": hashlib.sha256(root_license).hexdigest(),
            "packages": packages,
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
    parser.add_argument("--report", type=Path, help="Write the JSON identity/evidence report here")
    parser.add_argument(
        "--package", action="append", choices=[c.directory for c in CONTRACTS], help="Restrict to one package"
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    """Entry point.

    Parameters:
        argv (Sequence[str] | None): Arguments, or `None` for `sys.argv`.

    Returns:
        int: 0 when every contract holds, 1 on a violation, 2 on a usage error.
    """
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    args = parse_args(argv)
    if args.work_dir is not None and args.work_dir.exists() and any(args.work_dir.iterdir()):
        LOGGER.error(f"`--work-dir` must be empty: '{args.work_dir}'")
        return 2
    work = args.work_dir or Path(tempfile.mkdtemp(prefix="pi-package-contracts-"))
    work.mkdir(parents=True, exist_ok=True)
    try:
        report = run_gate(work.resolve(), args.stock_prefix.resolve(), args.package)
    except ContractError as e:
        LOGGER.error(f"FAILED: {e}")
        return 1
    finally:
        if not args.keep:
            shutil.rmtree(work, ignore_errors=True)
    text = serialize_report(report)
    if args.report:
        args.report.write_text(text)
    sys.stdout.write(text)
    LOGGER.info("package contracts: all passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
