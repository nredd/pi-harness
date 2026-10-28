"""Preserve allowlisted, synthetic standalone startup evidence only after failure.

References:
- https://github.com/nredd/pi-harness/pull/178
- https://github.com/unjs/jiti/blob/v2.7.0/src/cache.ts
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import textwrap
from dataclasses import dataclass
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field

from harness.paths import FAUX_EXTENSION, GIT_BIN, NODE_BIN, REPO_ROOT
from harness.sandbox import Sandbox, install_stack

LOGGER = logging.getLogger(__name__)
MAX_FILE_BYTES = 256 * 1024 * 1024
FIXED_PATHS = frozenset(
    {
        "pi",
        "SHA256SUMS",
        "build.json",
        "build.log",
        "compile-command.json",
        "module-graph.json",
        "startup.stdout",
        "startup.stderr",
        "replay.stdout",
        "replay.stderr",
        "replay-wrapper.ts",
        "stack.json",
        "packages/pi-memory/index.ts",
        "packages/pi-memory/package.json",
        "packages/pi-memory/npm-lock.json",
        "core/loader.js",
        "core/virtual-modules.js",
        "core/typebox-helpers.js",
        "core/jiti-package.json",
        "core/typebox-package.json",
        "core/package-lock.json",
        "harness-package-lock.json",
    }
)
CACHE_PATH = re.compile(r"jiti/(?:primary|replay)/pi-memory-index(?:\+map)?(?:\.i)?\.[a-f0-9]{8}\.[cm]js\Z")
# Signature matching is deliberately conservative: refuse publication, never redact executable/code bytes.
CREDENTIAL = re.compile(
    rb"(?:npm_[A-Za-z0-9]{36,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,}|"
    rb"(?:sk|pk)-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[A-Z0-9]{16}|"
    rb"-----BEGIN [A-Z ]*PRIVATE KEY-----|"
    rb"Bearer [A-Za-z0-9._~-]{24,}|"
    rb'"(?:access_token|refresh_token|api_key)"\s*:\s*"[A-Za-z0-9._~-]{24,}"|'
    rb"https?://[^\s/@:]+:[^\s/@]+@)"
)
WRAPPER = """// Failure-only synthetic replay: preserve the raw exception before Pi formats it.
export default async function (pi) {
    try {
        const module = await import("./index.ts");
        await module.default(pi);
    } catch (error) {
        console.error("[standalone-diagnostic raw exception]",
            error instanceof Error ? error.stack : String(error));
        throw error;
    }
}
"""


@dataclass(frozen=True)
class StartupResult:
    """Hold original startup pipe bytes and a separate timeout verdict."""

    returncode: int
    stdout: bytes
    stderr: bytes
    timed_out: bool = False


class BuildMetadata(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    core_sha: str = Field(default="unavailable", description="Exact core Gitlink checkout revision")
    harness_sha: str = Field(default="unavailable", description="Diagnostic harness checkout revision")
    node_version: str = Field(default="unavailable", description="Build host Node version")
    bun_version: str = Field(default="unavailable", description="Pinned build host Bun version")
    pi_version: str = Field(default="unavailable", description="Observed compiled executable version")
    diagnostic_scope: str = Field(
        default="synthetic startup only; no environment/auth/home capture", description="Collection boundary"
    )
    build_command_note: str = Field(
        default="CI driver template; actual observed compile argv is compile-command.json",
        description="Distinguish the driver template from directly observed compile arguments",
    )
    build_command: list[str] = Field(default_factory=list, description="Frozen CI build driver template")


class DiagnosticReport(BuildMetadata):
    startup_returncode: int = Field(description="Original subprocess status, or synthetic 124 on timeout")
    startup_timed_out: bool = Field(description="Primary startup exceeded the 60-second deadline")
    replay_timed_out: bool | None = Field(description="Replay exceeded its deadline, or was not attempted")
    startup_argv: list[str] = Field(description="Original strict startup arguments")
    replay_returncode: int | None = Field(description="Supplemental wrapper replay status, if attempted")
    replay_note: str = Field(
        default="supplemental wrapper import/factory; original failure/status preserved",
        description="Replay is evidence only and cannot replace the primary verdict",
    )
    primary_jiti_files: list[str] = Field(description="Correlated original transformed-code artifact paths")
    module_graph: str = Field(description="Module graph artifact path, or explicit unavailable status")


def allowed_artifact_path(path: Path) -> bool:
    """Accept only fixed public inputs or precisely named memory transform files.

    Parameters:
        path (Path): artifact-relative path.

    Returns:
        bool: whether the path belongs to the closed allowlist.
    """
    if path.is_absolute() or ".." in path.parts:
        return False
    name = path.as_posix()
    return name in FIXED_PATHS or CACHE_PATH.fullmatch(name) is not None


def read_regular(path: Path, root: Path) -> bytes:
    """Read a bounded regular file without traversing symlinks below its declared root.

    Parameters:
        path (Path): exact file, never a recursive glob.
        root (Path): trusted input boundary.

    Returns:
        bytes: original bytes, unredacted.

    Raises:
        ValueError: a symlink, special file, escape or oversized input is encountered.
    """
    relative = path.relative_to(root)
    current = root
    for part in ("", *relative.parts):
        current = current / part
        if current.is_symlink():
            raise ValueError("Diagnostic input traverses a symlink")
    info = path.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_FILE_BYTES:
        raise ValueError("Diagnostic input is not a bounded regular file")
    return path.read_bytes()


def publish(files: dict[str, bytes], output: Path) -> None:
    """Scan every artifact input before atomically publishing a fresh allowlisted directory.

    Parameters:
        files (dict[str, bytes]): explicit artifact paths and original bytes.
        output (Path): new upload directory; never an installed home.

    Raises:
        ValueError: an unknown path or potential credential is present.
        FileExistsError: the destination already exists (including stale evidence).
    """
    if output.exists() or output.is_symlink():
        raise FileExistsError("Diagnostic output must be a new directory")
    for name, content in files.items():
        if not allowed_artifact_path(Path(name)):
            raise ValueError("Unapproved diagnostic artifact path")
        if len(content) > MAX_FILE_BYTES or CREDENTIAL.search(content):
            raise ValueError("Diagnostic credential scan refused publication")
    sums = "".join(f"{hashlib.sha256(data).hexdigest()}  {name}\n" for name, data in sorted(files.items()))
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".standalone-evidence-", dir=output.parent) as temporary:
        staging = Path(temporary) / "upload"
        staging.mkdir()
        for name, content in files.items():
            destination = staging / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(content)
        (staging / "SHA256SUMS").write_text(sums)
        staging.rename(output)


def cache_names(source: Path) -> list[str]:
    """Derive Jiti 2.7's cache names for this exact source path, including FIPS variants.

    Parameters:
        source (Path): absolute installed `pi-memory/index.ts` path.

    Returns:
        list[str]: exact names only; no unrelated memory packages or generic cache upload.
    """
    raw = str(source).encode()
    hashes = [hashlib.md5(raw, usedforsecurity=False).hexdigest()[:8], hashlib.sha256(raw).hexdigest()[:8]]
    return [
        f"pi-memory-index{maps}{interop}.{digest}.{extension}"
        for digest in hashes
        for maps in ("", "+map")
        for interop in ("", ".i")
        for extension in ("cjs", "mjs")
    ]


def capture_cache(box: Sandbox, core: Path, source: Path, phase: str) -> dict[str, bytes]:
    """Collect only transform filenames correlated to this sandbox's memory source.

    Parameters:
        box (Sandbox): synthetic fixture, not a live home.
        core (Path): source build root (Node-mode cache fallback).
        source (Path): original memory entrypoint.
        phase (str): `primary` before replay or `replay` afterwards.

    Returns:
        dict[str, bytes]: allowlisted original cache bytes. Absence is recorded by metadata.
    """
    roots = dict.fromkeys(
        [
            box.root / "tmp/jiti",
            Path(tempfile.gettempdir()) / "jiti",
            Path("/tmp/jiti"),
            core / "node_modules/.cache/jiti",
        ]
    )
    files: dict[str, bytes] = {}
    for root in roots:
        for name in cache_names(source):
            path = root / name
            if path.exists() or path.is_symlink():
                key = f"jiti/{phase}/{name}"
                data = read_regular(path, root)
                if key in files and files[key] != data:
                    raise ValueError("Conflicting correlated Jiti cache bytes")
                files[key] = data
    return files


def execute(argv: list[str], *, box: Sandbox, extra: dict[str, str]) -> StartupResult:
    """Run one bounded startup with the existing scrubbed synthetic fixture environment.

    Parameters:
        argv (list[str]): exact startup command.
        box (Sandbox): fresh fixture with empty auth and command shims.
        extra (dict[str, str]): explicit synthetic script path.

    Returns:
        StartupResult: original exit status and raw streams; timeout is separately marked with status 124.
    """
    try:
        result = subprocess.run(
            argv, cwd=box.workdir, env=box.env(extra), capture_output=True, timeout=60, check=False
        )
        return StartupResult(result.returncode, result.stdout, result.stderr)
    except subprocess.TimeoutExpired as error:
        return StartupResult(124, error.stdout or b"", error.stderr or b"", timed_out=True)


def build_metadata(box: Sandbox, binary: Path, core: Path) -> BuildMetadata:
    """Query explicit identities under synthetic HOME; never serialize the process environment.

    Parameters:
        box (Sandbox): private subprocess environment.
        binary (Path): exact compiled executable.
        core (Path): Gitlinked source root.

    Returns:
        BuildMetadata: validated revisions, versions and build command; unavailable queries are explicit.
    """
    commands = {
        "core_sha": [GIT_BIN, "-C", str(core), "rev-parse", "HEAD"],
        "harness_sha": [GIT_BIN, "-C", str(REPO_ROOT.parent), "rev-parse", "HEAD"],
        "node_version": [NODE_BIN, "--version"],
        "bun_version": [shutil.which("bun") or "/nonexistent/bun", "--version"],
        "pi_version": [str(binary), "--version"],
    }
    result: dict[str, str] = {}
    for name, argv in commands.items():
        try:
            result[name] = subprocess.check_output(
                argv, env=box.env(installing=True), text=True, stderr=subprocess.STDOUT, timeout=15
            ).strip()
        except (OSError, subprocess.SubprocessError) as error:
            result[name] = f"unavailable ({type(error).__name__})"
    return BuildMetadata(
        **result,
        build_command=[
            "./scripts/build-binaries.sh",
            "--skip-install",
            "--offline-model-data",
            "--platform",
            binary.parent.name,
            "--out",
            str(binary.parent.parent),
        ],
    )


def capture_inputs(box: Sandbox, binary: Path, core: Path, evidence: Path) -> dict[str, bytes]:
    """Read only named code/build inputs, not installed trees or token/config stores.

    Parameters:
        box (Sandbox): synthetic installed stack.
        binary (Path): executable actually used for the failed startup.
        core (Path): unchanged Gitlink checkout.
        evidence (Path): build-only evidence directory produced by the wrapper.

    Returns:
        dict[str, bytes]: explicit files; unavailable optional files are absent, not fabricated.
    """
    files = {"pi": read_regular(binary, binary.parent)}
    entries = {
        "core/package-lock.json": (core / "package-lock.json", core),
        "harness-package-lock.json": (REPO_ROOT.parent / "package-lock.json", REPO_ROOT.parent),
        "core/loader.js": (core / "packages/coding-agent/dist/core/extensions/loader.js", core),
        "core/virtual-modules.js": (
            core / "packages/coding-agent/dist/core/extensions/virtual-modules.js",
            core,
        ),
        "core/typebox-helpers.js": (core / "packages/ai/dist/utils/typebox-helpers.js", core),
        "core/jiti-package.json": (core / "node_modules/jiti/package.json", core),
        "core/typebox-package.json": (core / "node_modules/typebox/package.json", core),
    }
    for name in ("build.log", "compile-command.json", "module-graph.json"):
        entries[name] = (evidence / name, evidence)
    memory = box.agent_dir / "npm/node_modules/pi-memory"
    for name in ("index.ts", "package.json"):
        entries[f"packages/pi-memory/{name}"] = (memory / name, box.root)
    for name, (path, root) in entries.items():
        if path.exists() or path.is_symlink():
            files[name] = read_regular(path, root)
    lock = box.agent_dir / "npm/package-lock.json"
    if lock.exists() or lock.is_symlink():
        installed = json.loads(read_regular(lock, box.root))
        identity = installed.get("packages", {}).get("node_modules/pi-memory")
        if identity is not None:
            files["packages/pi-memory/npm-lock.json"] = json.dumps(identity, indent=2).encode()
    return files


def replay_memory(box: Sandbox, argv: list[str], extra: dict[str, str]) -> StartupResult | None:
    """At the same package-order slot, wrap memory's import/factory to print and rethrow its raw stack.

    Only a failed synthetic fixture is modified. Its original package entry and executable stay intact.

    Parameters:
        box (Sandbox): already-failed synthetic fixture.
        argv (list[str]): unchanged startup command.
        extra (dict[str, str]): unchanged synthetic script path.

    Returns:
        StartupResult | None: diagnostic-only replay; never replaces the primary verdict.
    """
    memory = box.agent_dir / "npm/node_modules/pi-memory"
    if not (memory / "index.ts").is_file():
        return None
    packages = box.settings().get("packages", [])
    for index, declaration in enumerate(packages):
        source = declaration if isinstance(declaration, str) else declaration.get("source", "")
        if source.startswith("npm:pi-memory@"):
            original = {} if isinstance(declaration, str) else declaration
            packages[index] = original | {"source": source, "extensions": ["diagnostic-wrapper.ts"]}
            (memory / "diagnostic-wrapper.ts").write_text(WRAPPER)
            manifest_path = memory / "package.json"
            manifest = json.loads(manifest_path.read_text())
            manifest["pi"] = manifest.get("pi", {}) | {"extensions": ["./diagnostic-wrapper.ts"]}
            manifest_path.write_text(json.dumps(manifest, indent=2))
            box.patch_json("settings.json", {"packages": packages})
            return execute(argv, box=box, extra=extra)
    return None


def diagnose(box: Sandbox, binary: Path, core: Path, evidence: Path, output: Path) -> int:
    """Keep the existing strict startup verdict and publish evidence only on failure.

    Parameters:
        box (Sandbox): freshly installed explicit personal stack under synthetic credentials.
        binary (Path): exact compiled executable, not an instrumented rebuild.
        core (Path): matching Gitlink checkout.
        evidence (Path): compile-only metadata.
        output (Path): fresh, allowlisted upload destination.

    Returns:
        int: original nonzero status, or 1 for output/warning assertion failures. Replay/scan cannot green it.
    """
    if output.exists() or output.is_symlink():
        raise FileExistsError("Refusing stale diagnostic output")
    script = box.root / "startup-script.json"
    script.write_text(
        json.dumps({"providers": {"faux": {"models": ["main"], "steps": [{"text": "STACK-OK"}]}}})
    )
    argv = [str(binary), "-e", str(FAUX_EXTENSION), "--model", "faux/main", "--no-approve", "-p", "hi"]
    extra = {"HARNESS_SCRIPT": str(script)}
    primary = execute(argv, box=box, extra=extra)
    # Decode only for the existing strict text verdict; never alter the retained pipe bytes.
    stdout = primary.stdout.decode("utf-8", errors="backslashreplace")
    stderr = primary.stderr.decode("utf-8", errors="backslashreplace")
    if primary.returncode == 0 and stdout.strip() == "STACK-OK" and not stderr.strip():
        return 0
    status = primary.returncode or 1
    try:
        files = capture_inputs(box, binary, core, evidence)
        files |= {"startup.stdout": primary.stdout, "startup.stderr": primary.stderr}
        source = box.agent_dir / "npm/node_modules/pi-memory/index.ts"
        files |= capture_cache(box, core, source, "primary")
        replay = replay_memory(box, argv, extra)
        if replay is not None:
            files |= {
                "replay.stdout": replay.stdout,
                "replay.stderr": replay.stderr,
                "replay-wrapper.ts": WRAPPER.encode(),
            }
            files |= capture_cache(box, core, source, "replay")
        metadata = DiagnosticReport(
            **build_metadata(box, binary, core).model_dump(),
            startup_returncode=primary.returncode,
            startup_timed_out=primary.timed_out,
            replay_timed_out=replay.timed_out if replay is not None else None,
            startup_argv=argv,
            replay_returncode=replay.returncode if replay is not None else None,
            primary_jiti_files=[name for name in files if name.startswith("jiti/primary/")],
            module_graph="module-graph.json" if "module-graph.json" in files else "unavailable",
        )
        files["build.json"] = metadata.model_dump_json(indent=2).encode()
        files["stack.json"] = (REPO_ROOT / "stacks/personal.json").read_bytes()
        publish(files, output)
        LOGGER.error(f"Strict standalone startup failed (status {status}); scanned evidence: '{output}'")
    except Exception as error:
        # Diagnostics are a side channel: an unexpected collector bug cannot replace the primary verdict.
        LOGGER.error(
            f"Strict standalone startup failed (status {status}); capture refused ({type(error).__name__})"
        )
    return status if status > 0 else 128 - status


def prepare_build(directory: Path, bun: Path) -> None:
    """Create a transparent Bun compile wrapper recording argv and emitting its module graph.

    Parameters:
        directory (Path): fresh private build-only evidence directory.
        bun (Path): pinned real Bun executable; never found recursively through the wrapper PATH.

    Raises:
        FileExistsError: a wrapper already exists.
    """
    launcher = directory / "bin/bun"
    launcher.parent.mkdir(parents=True, exist_ok=True)
    code = textwrap.dedent(f"""\
        #!{sys.executable}
        import json
        import os
        import sys
        from pathlib import Path

        args = sys.argv[1:]
        bun = {str(bun)!r}
        if args[:1] == ["build"] and "--compile" in args:
            args.append({f"--metafile={directory / 'module-graph.json'}"!r})
            Path({str(directory / "compile-command.json")!r}).write_text(json.dumps([bun, *args]))
        os.execv(bun, [bun, *args])
        """)
    with launcher.open("x") as stream:
        stream.write(code)
    launcher.chmod(0o700)


def main() -> int:
    """Prepare build observation or run one startup diagnostic in a new throwaway HOME.

    Returns:
        int: original startup verdict; preparation failures are fatal.
    """
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="action", required=True)
    prepare = subparsers.add_parser("prepare-build")
    prepare.add_argument("--directory", type=Path, required=True)
    startup = subparsers.add_parser("startup")
    startup.add_argument("--binary", type=Path, required=True)
    startup.add_argument("--core", type=Path, required=True)
    startup.add_argument("--build-evidence", type=Path, required=True)
    startup.add_argument("--output", type=Path, required=True)
    startup.add_argument(
        "--github-output", type=Path, help="Write artifact_ready only after scanned publication"
    )
    opts = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    if opts.action == "prepare-build":
        bun = shutil.which("bun")
        if bun is None:
            parser.error("Pinned Bun must be on PATH")
        prepare_build(opts.directory.resolve(), Path(bun).resolve())
        return 0
    binary = opts.binary.resolve(strict=True)
    if opts.output.exists() or opts.output.is_symlink():
        raise FileExistsError("Refusing stale diagnostic output before installation")
    output = opts.output.resolve()
    os.environ["PI_BIN"] = str(binary)
    with tempfile.TemporaryDirectory(prefix="standalone-startup-") as temporary:
        box = install_stack(Path(temporary) / "fixture", REPO_ROOT / "stacks/personal.json")
        status = diagnose(box, binary, opts.core.resolve(), opts.build_evidence.resolve(), output)
        if status != 0 and output.is_dir() and opts.github_output is not None:
            try:
                with opts.github_output.open("a") as stream:
                    stream.write("artifact_ready=true\n")
            except OSError:
                LOGGER.error("Cannot announce scanned diagnostic artifact; original startup status preserved")
        return status


if __name__ == "__main__":
    raise SystemExit(main())
