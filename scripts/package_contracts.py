"""Packed-package independence gate for the `@nredd/pi-*` plugins against exact stock Pi.

For each package this builds the real npm tarball, audits its contents, installs it alone into a
fresh project, and drives it through a real, exact-version stock Pi install:

1. `npm pack`: file list must match a narrow allowlist; `LICENSE` must be byte-identical to the
   repository root; the packed manifest must keep host modules as `*` peers with no dependencies.
2. Source audit: every import in the tarball is relative (inside the package), a Node builtin, or a
   host-provided Pi module. No sibling plugin, no bundled host copy.
3. Fresh install (`--ignore-scripts --legacy-peer-deps --offline`, like Pi's managed installs that
   suppress peer installation): `node_modules` holds only the package, never a host duplicate.
4. Stock Pi `--mode json` with only that package loaded (`--no-extensions --extension DIR`), a
   scrubbed environment, a temporary `HOME` and agent directory, no credentials, and a loopback
   scripted provider. The package must do real work: a dev tool result, a session-kit monitor and
   its stats artifact over a real session, and a router virtual model dispatching to a physical one.

Nothing here publishes anything or touches real Pi state. The stock Pi version and tarball
identities are recorded in the JSON report; nothing resolves "latest" at run time.

References:
    https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md
    https://docs.npmjs.com/cli/v11/commands/npm-pack
"""

from __future__ import annotations

import argparse
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
from collections.abc import Callable, Iterator, Sequence
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Any

from faux_provider import FauxProvider, Step, TextStep, ToolStep, models_json

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

IMPORT_SPEC = re.compile(
    r"""(?:^|\n)[ \t]*(?:import|export)\b[^;'"`]*?\bfrom\s*["']([^"']+)["']"""
    r"""|(?:^|\n)[ \t]*import\s*["']([^"']+)["']"""
    r"""|\bimport\s*\(\s*["']([^"']+)["']\s*\)"""
    r"""|\brequire\s*\(\s*["']([^"']+)["']\s*\)"""
)


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
    """

    name: str
    directory: str
    required: tuple[str, ...]
    allowed: tuple[re.Pattern[str], ...]
    exposes_tools: frozenset[str]


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
    found: dict[str, Path] = {}
    for name in ("node", "npm", "git"):
        located = shutil.which(name)
        if located is None:
            raise ContractError(f"`{name}` not found on PATH")
        found[name] = Path(located).resolve()
    return Tools(node=found["node"], npm=found["npm"], git=found["git"])


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


def verify_stock_pi(prefix: Path, pi_bin: Path, sandbox: Sandbox) -> None:
    """Check the installed Pi is exactly the pinned registry artifact.

    Parameters:
        prefix (Path): Install directory.
        pi_bin (Path): The `pi` executable.
        sandbox (Sandbox): Environment for the version probe.

    Raises:
        ContractError: On any identity mismatch.
    """
    lock = json.loads((prefix / "package-lock.json").read_text())
    entry = lock["packages"].get(f"node_modules/{STOCK_PI_PACKAGE}", {})
    if entry.get("version") != STOCK_PI_VERSION or entry.get("integrity") != STOCK_PI_INTEGRITY:
        raise ContractError(
            f"Stock Pi in '{prefix}' is {entry.get('version')!r} / {entry.get('integrity')!r}, "
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
        report = json.loads(done.stdout)[0]
    except (json.JSONDecodeError, IndexError, KeyError) as e:
        raise ContractError(
            f"Unparseable `npm pack --json` output for '{contract.name}': {done.stdout[:500]}"
        ) from e
    path = dest / report["filename"]
    with tarfile.open(path) as tar:
        files = tuple(sorted(strip_prefix(member.name) for member in tar.getmembers() if member.isfile()))
    if files != tuple(sorted(entry["path"] for entry in report["files"])):
        raise ContractError(f"`npm pack` file list for '{contract.name}' disagrees with its tarball")
    manifest = json.loads(read_member(path, "package.json"))
    return PackedArtifact(
        contract, path, manifest["version"], report["integrity"], report["shasum"], path.stat().st_size, files
    )


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


def audit_manifest(
    contract: PackageContract, manifest: dict[str, Any], expected_files: Sequence[str]
) -> list[str]:
    """Check the packed `package.json` for independence and publication safety.

    Parameters:
        contract (PackageContract): Expectations.
        manifest (dict[str, Any]): Parsed packed manifest.
        expected_files (Sequence[str]): Files that must be reachable through `pi.extensions`.

    Returns:
        list[str]: Violations; empty when the manifest conforms.
    """
    problems: list[str] = []
    if manifest.get("name") != contract.name:
        problems.append(f"name is '{manifest.get('name')}', expected '{contract.name}'")
    if manifest.get("private") is not True:
        problems.append("`private` must stay `true` until the publication prerequisites exist")
    if manifest.get("license") != "MIT":
        problems.append("`license` must be 'MIT'")
    for key in ("dependencies", "optionalDependencies", "bundledDependencies", "bundleDependencies"):
        if manifest.get(key):
            problems.append(f"`{key}` must be empty: host modules are peers and plugins are independent")
    peers: dict[str, str] = manifest.get("peerDependencies", {})
    problems += [f"peer '{name}' is not a host module" for name in peers if name not in HOST_MODULES]
    problems += [
        f"peer '{name}' must use the range '*', not '{peers[name]}'" for name in peers if peers[name] != "*"
    ]
    extensions = manifest.get("pi", {}).get("extensions", [])
    if not extensions:
        problems.append("`pi.extensions` is empty")
    problems += [
        f"`pi.extensions` entry '{entry}' is not in the tarball"
        for entry in extensions
        if PurePosixPath(entry).as_posix().removeprefix("./") not in expected_files
    ]
    return problems


def import_specifiers(source: str) -> Iterator[str]:
    """Yield every module specifier a JS or TS source imports.

    Parameters:
        source (str): File text.

    Yields:
        str: Each static import/export-from, dynamic `import()` or `require()` specifier.
    """
    for match in IMPORT_SPEC.finditer(source):
        yield next(group for group in match.groups() if group)


def audit_imports(path: str, source: str, files: Sequence[str]) -> list[str]:
    """Classify the imports of one packed source file.

    Allowed: Node builtins (`node:` prefix), host-provided Pi modules, and relative paths that stay
    inside the package. Everything else, including any `@nredd/` sibling, is a violation. The
    bundled stats artifact may import Node builtins only: it must run without Pi.

    Parameters:
        path (str): File path relative to the package root.
        source (str): File text.
        files (Sequence[str]): All tarball paths, to resolve relative imports.

    Returns:
        list[str]: Violations; empty when every import is acceptable.
    """
    problems: list[str] = []
    standalone = path.startswith("dist/")
    for spec in import_specifiers(source):
        if spec.startswith("node:"):
            continue
        if spec.startswith("."):
            target = PurePosixPath(os.path.normpath(PurePosixPath(path).parent / spec)).as_posix()
            stem = PurePosixPath(target).with_suffix("").as_posix()
            if target.startswith("..") or not any(
                f == target or PurePosixPath(f).with_suffix("").as_posix() == stem for f in files
            ):
                problems.append(f"{path}: relative import '{spec}' leaves the package or is missing")
        elif spec.startswith(SIBLING_SCOPE):
            problems.append(f"{path}: imports sibling plugin '{spec}'")
        elif standalone:
            problems.append(
                f"{path}: standalone artifact imports '{spec}', only `node:` builtins are allowed"
            )
        elif spec not in HOST_MODULES and not any(spec.startswith(f"{host}/") for host in HOST_MODULES):
            problems.append(f"{path}: imports '{spec}', which is neither a Node builtin nor a host module")
    return problems


def audit_tarball(artifact: PackedArtifact, root_license: bytes) -> list[str]:
    """Run every static tarball audit.

    Parameters:
        artifact (PackedArtifact): Tarball to audit.
        root_license (bytes): Content of the repository `LICENSE`.

    Returns:
        list[str]: All violations found.
    """
    contract = artifact.contract
    manifest = json.loads(read_member(artifact.path, "package.json"))
    problems = audit_files(contract, artifact.files)
    problems += audit_license(artifact.path, root_license)
    problems += audit_manifest(contract, manifest, artifact.files)
    for name in artifact.files:
        if name.endswith(CODE_SUFFIXES):
            problems += audit_imports(name, read_member(artifact.path, name).decode(), artifact.files)
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
    lock = json.loads((project / "package-lock.json").read_text())
    if set(lock["packages"]) != {"", f"node_modules/{artifact.contract.name}"}:
        raise ContractError(
            f"Unexpected lockfile entries after installing '{artifact.contract.name}': "
            f"{sorted(lock['packages'])}"
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
        """
        return [
            e["message"]
            for e in self.events
            if e.get("type") == "message_end" and e.get("message", {}).get("role") == "assistant"
        ]


def tool_text(record: dict[str, Any]) -> str:
    """Join the text blocks of a tool result record.

    Parameters:
        record (dict[str, Any]): A `tool_execution_end` event.

    Returns:
        str: Concatenated text content.
    """
    return "".join(
        block.get("text", "") for block in record["result"]["content"] if block.get("type") == "text"
    )


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
) -> PiRun:
    """Run stock Pi non-interactively with exactly one package loaded.

    Only safe, documented flags: `--offline`, `--no-mcp`, `--no-extensions` (with an explicit `--extension`),
    `--no-skills`, `--no-prompt-templates`, `--no-themes`, `--no-context-files`, `--no-approve`.

    Parameters:
        pi_bin (Path): Stock `pi`.
        sandbox (Sandbox): Scrubbed environment.
        package_dir (Path): Installed package directory to load.
        cwd (Path): Working directory for the run.
        extra (Sequence[str]): Remaining arguments (model, mode, prompt).
        session_dir (Path | None): Persist the session here; `None` keeps it in memory.

    Returns:
        PiRun: Exit code, parsed events and raw streams.
    """
    session = ["--session-dir", str(session_dir)] if session_dir else ["--no-session"]
    argv = [
        pi_bin,
        "--offline",
        "--no-approve",
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
    result: PiRun, contract: PackageContract, siblings: Sequence[PackageContract], requests: Sequence[Any]
) -> None:
    """Require the package's tools declared to the model and no sibling's.

    Parameters:
        result (PiRun): The run, for context in messages.
        contract (PackageContract): Package under test.
        siblings (Sequence[PackageContract]): Every other package.
        requests (Sequence[Any]): `RecordedRequest`s seen by the provider.

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


def scenario_dev_tools(ctx: Context) -> dict[str, Any]:
    """Real `git_status` result, and its failure path, through stock Pi.

    Parameters:
        ctx (Context): Scenario context.

    Returns:
        dict[str, Any]: Evidence recorded in the report.

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
    (record,) = ok.tool_results("git_status")
    require(record["isError"] is False, f"git_status failed: {tool_text(record)}")
    require(
        record["result"]["structuredContent"]["untracked"] == ["untracked.txt"],
        f"unexpected status: {record['result']}",
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
    (failed,) = bad.tool_results("git_status")
    require(
        failed["isError"] is True,
        f"git_status outside a repository must be an error result: {failed['result']}",
    )
    return {"tool": "git_status", "untracked": ["untracked.txt"], "failure_path": tool_text(failed)[:200]}


def scenario_session_kit(ctx: Context) -> dict[str, Any]:
    """Real monitor tools, then the standalone stats artifact over the resulting real session.

    Parameters:
        ctx (Context): Scenario context.

    Returns:
        dict[str, Any]: Evidence recorded in the report.

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
    (started,) = result.tool_results("monitor_start")
    require(
        started["isError"] is False and "started m1" in tool_text(started),
        f"monitor_start: {tool_text(started)}",
    )
    (read,) = result.tool_results("monitor_read")
    require(marker in tool_text(read), f"monitor_read missed '{marker}': {tool_text(read)}")

    # The artifact must run with only `node`, from outside any package, over that real session.
    artifact = ctx.installed / "dist" / "pi-stats-export.mjs"
    outside = ctx.work / "artifact-cwd"
    outside.mkdir()
    snapshots = ctx.work / "snapshots"
    exported = run(
        [
            ctx.sandbox.tools.node,
            artifact,
            "export",
            "--agent-dir",
            ctx.sandbox.agent_dir,
            "--output",
            snapshots,
        ],
        env=ctx.sandbox.env(),
        cwd=outside,
        timeout=PI_TIMEOUT_S,
    )
    export = json.loads(exported.stdout)
    manifest = json.loads((Path(export["snapshotDir"]) / "manifest.json").read_text())
    require(
        manifest["version"] == 1 and manifest["machineId"] == export["machineId"] and manifest["shards"],
        f"export: {manifest}",
    )
    other = ctx.work / "other-agent"
    other.mkdir()
    imported = json.loads(
        run(
            [ctx.sandbox.tools.node, artifact, "import", "--agent-dir", other, "--input", snapshots],
            env=ctx.sandbox.env(),
            cwd=outside,
            timeout=PI_TIMEOUT_S,
        ).stdout
    )
    require(imported["imported"] == 1 and imported["problems"] == [], f"import: {imported}")
    bad = run(
        [ctx.sandbox.tools.node, artifact, "export", "--bogus", "x"],
        env=ctx.sandbox.env(),
        cwd=outside,
        timeout=PI_TIMEOUT_S,
        check=False,
    )
    require(bad.returncode != 0, "stats artifact accepted an unknown flag")
    return {
        "tools": ["monitor_start", "monitor_read"],
        "monitor_line": marker,
        "stats_shards": len(manifest["shards"]),
    }


def scenario_router(ctx: Context) -> dict[str, Any]:
    """Virtual `router/default` registration and dispatch to a physical model, plus a rejected config.

    Parameters:
        ctx (Context): Scenario context.

    Returns:
        dict[str, Any]: Evidence recorded in the report.

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
    (answer,) = routed.assistant_messages()
    require(
        (answer["provider"], answer["model"]) == (PROVIDER, PHYSICAL_MODEL),
        f"dispatched to {answer['provider']}/{answer['model']}",
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


SCENARIOS: dict[str, Callable[[Context], dict[str, Any]]] = {
    "dev-tools": scenario_dev_tools,
    "session-kit": scenario_session_kit,
    "subscription-router": scenario_router,
}


# --- orchestration --------------------------------------------------------------------------------


def run_gate(work: Path, stock_prefix: Path, only: Sequence[str] | None) -> dict[str, Any]:
    """Run the whole contract gate and build the identity/evidence report.

    Parameters:
        work (Path): Empty scratch directory for tarballs, installs and sandboxes.
        stock_prefix (Path): Reusable stock Pi install directory.
        only (Sequence[str] | None): Package directories to restrict to; `None` runs all.

    Returns:
        dict[str, Any]: JSON-serializable report.

    Raises:
        ContractError: On the first violated contract, after all static audits ran.
    """
    tools = locate_tools()
    root_license = (REPO_ROOT / "LICENSE").read_bytes()
    base = Sandbox(work / "base", tools)
    pi_bin = ensure_stock_pi(stock_prefix, base)
    selected = [c for c in CONTRACTS if only is None or c.directory in only]
    tarballs = work / "tarballs"
    tarballs.mkdir()
    artifacts = [pack(contract, tarballs, base) for contract in selected]

    problems = [f"{a.contract.name}: {p}" for a in artifacts for p in audit_tarball(a, root_license)]
    if problems:
        raise ContractError("Tarball audit failed:\n" + "\n".join(f"  - {p}" for p in problems))

    report: dict[str, Any] = {
        "stock_pi": {
            "package": STOCK_PI_PACKAGE,
            "version": STOCK_PI_VERSION,
            "integrity": STOCK_PI_INTEGRITY,
        },
        "node": run([tools.node, "--version"], env=base.env(), cwd=work, timeout=30).stdout.strip(),
        "npm": run([tools.npm, "--version"], env=base.env(), cwd=work, timeout=30).stdout.strip(),
        "license_sha256": hashlib.sha256(root_license).hexdigest(),
        "packages": {},
    }
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
        report["packages"][contract.name] = {
            "version": artifact.version,
            "tarball": artifact.path.name,
            "integrity": artifact.integrity,
            "shasum": artifact.shasum,
            "size": artifact.size,
            "files": list(artifact.files),
            "evidence": evidence,
        }
    return report


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
    text = json.dumps(report, indent=2) + "\n"
    if args.report:
        args.report.write_text(text)
    sys.stdout.write(text)
    LOGGER.info("package contracts: all passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
