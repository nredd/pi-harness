"""Real installer acceptance: the one-shot command against a published promotion, in throwaway HOMEs.

Every test runs the documented `uvx` command (or the real verification primitives) with real
GitHub releases, real `gh attestation verify`, real npm and a real core. Nothing reads or writes
the caller's HOME, Pi install, credentials or Homebrew.

Environment:
- `INSTALLER_SPEC`: the `uvx --from` value, e.g.
  `git+https://github.com/nredd/pi-harness@<sha>#subdirectory=integration`.
- `STACK_SHA`: the promoted `stack/<sha>` to install.

References:
- https://docs.astral.sh/uv/guides/tools/
- https://cli.github.com/manual/gh_attestation_verify
"""

from __future__ import annotations

import hashlib
import json
import os
import selectors
import shutil
import signal
import subprocess
import time
from pathlib import Path
from typing import Any

import pytest

from harness.install import EXCLUDE_NEWER, INSTALLER_PYTHON, download
from harness.promotion import (
    SNAPSHOT_ASSET,
    SNAPSHOT_REPO,
    SNAPSHOT_SIGNER_WORKFLOW,
    SNAPSHOT_SOURCE_REF,
    load_promoted_snapshot,
    snapshot_url,
)
from harness.release import AttestationRateLimitedError, attestation_bundle, verify_attestation
from harness.stack import package_declarations, source_string

pytestmark = pytest.mark.installer
INSTALL_TIMEOUT = 1200
KILL_AFTER = "pi install 'npm:pi-web-access"
EXIT_UNSUPPORTED, EXIT_VERIFICATION, EXIT_CONSENT = 2, 3, 4


@pytest.fixture(scope="module")
def spec() -> str:
    """The installer source under test.

    Returns:
        str: `INSTALLER_SPEC`.
    """
    value = os.environ.get("INSTALLER_SPEC")
    if not value:
        raise pytest.UsageError("Set `INSTALLER_SPEC` and `STACK_SHA` for the installer acceptance")
    return value


@pytest.fixture(scope="module")
def stack_sha() -> str:
    """The promoted stack under test.

    Returns:
        str: `STACK_SHA`.
    """
    value = os.environ.get("STACK_SHA")
    if not value:
        raise pytest.UsageError("Set `INSTALLER_SPEC` and `STACK_SHA` for the installer acceptance")
    return value


@pytest.fixture(scope="module")
def uv_cache(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """One uv cache shared by every throwaway HOME, so only the first run builds the tool.

    Parameters:
        tmp_path_factory (pytest.TempPathFactory): scratch.

    Returns:
        Path: cache directory.
    """
    return tmp_path_factory.mktemp("uv-cache")


@pytest.fixture
def home(tmp_path: Path) -> Path:
    """A fresh HOME on a real (non-symlinked) path.

    Parameters:
        tmp_path (Path): scratch.

    Returns:
        Path: empty HOME.
    """
    path = (tmp_path / "home").resolve()
    path.mkdir()
    return path


def command(spec: str, stack_sha: str, *args: str) -> list[str]:
    """Return the documented one-shot command.

    Parameters:
        spec (str): `uvx --from` value.
        stack_sha (str): promoted stack.
        *args (str): extra installer arguments.

    Returns:
        list[str]: argv.
    """
    uvx = shutil.which("uvx")
    assert uvx is not None, "`uvx` is required to run the installer acceptance"
    return [
        uvx, "--python", INSTALLER_PYTHON, "--exclude-newer", EXCLUDE_NEWER, "--from", spec,
        "pi-stack-install", stack_sha, *args,
    ]  # fmt: skip


def environment(home: Path, uv_cache: Path, path: str | None = None, gh_token: bool = True) -> dict[str, str]:
    """Build a clean environment: only PATH, the throwaway HOME and uv's cache.

    A runner's `GH_TOKEN` (reviewed `main` push or dispatch only, never a pull request) is passed to the
    installer for its rate-limit fallback: hosted runners share GitHub's anonymous rate limit.
    `uvx` and the installer process carry it; the installer hands it to `gh` alone.

    Parameters:
        home (Path): throwaway HOME.
        uv_cache (Path): shared uv cache.
        path (str | None): PATH override.
        gh_token (bool): pass a runner `GH_TOKEN` through; `False` for every non-installer launch.

    Returns:
        dict[str, str]: complete child environment, no user config.
    """
    token = os.environ.get("GH_TOKEN") if gh_token else None
    return {
        "PATH": path or os.environ["PATH"],
        "HOME": str(home),
        "TERM": "dumb",
        "UV_CACHE_DIR": str(uv_cache),
        "UV_PYTHON_INSTALL_DIR": str(uv_cache / "python"),
    } | ({"GH_TOKEN": token} if token else {})


def run(argv: list[str], env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    """Run the installer non-interactively.

    Parameters:
        argv (list[str]): command.
        env (dict[str, str]): environment.

    Returns:
        subprocess.CompletedProcess[str]: result with combined output in `stdout`.
    """
    return subprocess.run(
        argv,
        env=env,
        cwd=env["HOME"],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        timeout=INSTALL_TIMEOUT,
        check=False,
    )


def digest_tree(root: Path, exclude: str = ".local/share/pi-stack") -> dict[str, str]:
    """Hash every file and link under a HOME, outside the installer's own state.

    Parameters:
        root (Path): HOME.
        exclude (str): relative prefix to skip.

    Returns:
        dict[str, str]: relative path -> SHA-256, or `-> target` for links.
    """
    digests = {}
    for path in sorted(root.rglob("*")):
        relative = str(path.relative_to(root))
        if relative.startswith((exclude, ".cache", ".local/share/uv", ".local/state/gh", ".config/gh")):
            continue
        if path.is_symlink():
            digests[relative] = f"-> {path.readlink()}"
        elif path.is_file():
            digests[relative] = hashlib.sha256(path.read_bytes()).hexdigest()
    return digests


def seed_existing(home: Path) -> None:
    """Write an existing personal setup the installer must preserve.

    Parameters:
        home (Path): throwaway HOME.
    """
    agent = home / ".pi" / "agent"
    agent.mkdir(parents=True)
    (agent / "settings.json").write_text(
        json.dumps({"defaultModel": "mine", "packages": ["npm:pi-mine@1.0.0"]})
    )
    (agent / "auth.json").write_text('{"anthropic":{"type":"oauth","refresh":"not-a-real-token"}}')
    (agent / "auth.json").chmod(0o600)
    (agent / "models.json").write_text('{"providers":{}}')
    (agent / "AGENTS.md").write_text("# mine\n")


def published(stack_sha: str, workdir: Path) -> tuple[Path, Path | None]:
    """Download the real snapshot and its public bundle.

    Parameters:
        stack_sha (str): promoted stack.
        workdir (Path): scratch.

    Returns:
        tuple[Path, Path | None]: snapshot and bundle, `None` when rate-limited (then `gh` fetches).
    """
    snapshot = download(snapshot_url(stack_sha), workdir / SNAPSHOT_ASSET)
    try:
        return snapshot, attestation_bundle(SNAPSHOT_REPO, snapshot, workdir / "bundle.jsonl")
    except AttestationRateLimitedError:
        return snapshot, None


def test_missing_prerequisites_change_nothing(
    spec: str, stack_sha: str, uv_cache: Path, home: Path, tmp_path: Path
) -> None:
    """Without `gh`, `node` and `npm` every missing tool is named and HOME stays empty of Pi."""
    tools = tmp_path / "tools"
    tools.mkdir()
    hidden = {"gh", "node", "npm"}
    # Mirror every PATH executable except the three under test: uv, Git and the shell tools Git's
    # submodule scripts need keep working, and only the prerequisites disappear.
    for directory in [Path(entry) for entry in os.environ["PATH"].split(os.pathsep) if entry]:
        if not directory.is_dir():
            continue
        for executable in sorted(directory.iterdir()):
            link = tools / executable.name
            if executable.name not in hidden and not link.exists() and not link.is_symlink():
                link.symlink_to(executable)
    result = run(command(spec, stack_sha), environment(home, uv_cache, str(tools)))
    assert result.returncode == EXIT_UNSUPPORTED, result.stdout
    assert all(f"`{tool}` not found" in result.stdout for tool in ("gh", "node", "npm")), result.stdout
    assert not (home / ".pi").exists()
    assert not (home / ".local" / "share" / "pi-stack").exists()


def test_unpromoted_sha_is_refused(spec: str, uv_cache: Path, home: Path) -> None:
    """A commit without a `stack/<sha>` release is a verification failure before any change."""
    result = run(command(spec, "0" * 40), environment(home, uv_cache))
    assert result.returncode == EXIT_VERIFICATION, result.stdout
    assert "HTTP 404" in result.stdout
    assert not (home / ".pi").exists()
    assert not (home / ".local" / "share" / "pi-stack").exists()


def test_real_attestation_rejects_tampering_and_foreign_identities(stack_sha: str, tmp_path: Path) -> None:
    """Real `gh` accepts the published snapshot and rejects altered bytes, another signer or ref."""
    snapshot, bundle = published(stack_sha, tmp_path)
    verify_attestation(snapshot, SNAPSHOT_REPO, SNAPSHOT_SIGNER_WORKFLOW, SNAPSHOT_SOURCE_REF, bundle)
    tampered = tmp_path / "tampered.json"
    tampered.write_bytes(snapshot.read_bytes().replace(b'"quietStartup":true', b'"quietStartup":false'))
    assert tampered.read_bytes() != snapshot.read_bytes()
    with pytest.raises(RuntimeError, match="provenance verification failed"):
        verify_attestation(tampered, SNAPSHOT_REPO, SNAPSHOT_SIGNER_WORKFLOW, SNAPSHOT_SOURCE_REF, bundle)
    foreign = f"{SNAPSHOT_REPO}/.github/workflows/publish.yml"
    with pytest.raises(RuntimeError, match="provenance verification failed"):
        verify_attestation(snapshot, SNAPSHOT_REPO, foreign, SNAPSHOT_SOURCE_REF, bundle)
    with pytest.raises(RuntimeError, match="provenance verification failed"):
        verify_attestation(snapshot, SNAPSHOT_REPO, SNAPSHOT_SIGNER_WORKFLOW, "refs/heads/feature", bundle)


def test_fresh_install_matches_the_promotion_and_reruns_cleanly(
    spec: str, stack_sha: str, uv_cache: Path, home: Path, tmp_path: Path
) -> None:
    """A clean HOME gets the promoted core, order, filters and disabled policy; a rerun is a no-op."""
    result = run(command(spec, stack_sha), environment(home, uv_cache))
    assert result.returncode == 0, result.stdout
    snapshot = load_promoted_snapshot(published(stack_sha, tmp_path)[0].read_bytes(), stack_sha)
    stack = snapshot.stack
    sources = [source_string(package) for package in stack.sources]
    agent = home / ".pi" / "agent"
    settings = json.loads((agent / "settings.json").read_text())
    assert settings == stack.settings | {"packages": package_declarations(stack, sources)}
    assert json.loads((agent / "subagents.json").read_text()) == {"packageAgents": False}
    lock: dict[str, Any] = json.loads((agent / "npm" / "package-lock.json").read_text())["packages"]
    for owned in snapshot.gates.owned_packages:
        name, version = owned.package.rsplit("@", 1)
        assert lock[f"node_modules/{name}"] == lock[f"node_modules/{name}"] | {
            "version": version,
            "integrity": owned.integrity,
        }
    pi = home / ".local" / "bin" / "pi"
    assert pi.readlink() == home / ".local" / "share" / "pi-stack" / "core" / stack.core.tag / "bin" / "pi"
    env = environment(home, uv_cache, gh_token=False) | {"PI_OFFLINE": "1", "PI_SKIP_VERSION_CHECK": "1"}
    version = run([str(pi), "--version"], env)
    assert version.returncode == 0
    assert version.stdout.strip() == stack.core.tag.removeprefix("v").split("-")[0]
    listed = run([str(pi), "list"], env).stdout
    assert all(source in listed for source in sources), listed
    assert "npm:@nredd/pi-preset@0.2.0 (filtered)" in listed
    assert "npm:@nredd/pi-computer-use@0.5.2 (filtered)" in listed
    assert not (agent / "auth.json").exists()
    before = digest_tree(home)
    again = run(command(spec, stack_sha), environment(home, uv_cache))
    assert again.returncode == 0, again.stdout
    assert "Already installed" in again.stdout
    assert digest_tree(home) == before


def test_existing_config_needs_consent_and_survives(
    spec: str, stack_sha: str, uv_cache: Path, home: Path
) -> None:
    """An existing setup is untouched without `--yes`; with it, credentials and unrelated keys survive."""
    seed_existing(home)
    before = digest_tree(home)
    refused = run(command(spec, stack_sha), environment(home, uv_cache))
    assert refused.returncode == EXIT_CONSENT, refused.stdout
    assert "OVERWRITE" in refused.stdout
    assert "npm:pi-mine@1.0.0" in refused.stdout
    assert digest_tree(home) == before
    applied = run(command(spec, stack_sha, "--yes"), environment(home, uv_cache))
    assert applied.returncode == 0, applied.stdout
    after = digest_tree(home)
    for kept in (".pi/agent/auth.json", ".pi/agent/models.json", ".pi/agent/AGENTS.md"):
        assert after[kept] == before[kept]
    settings = json.loads((home / ".pi" / "agent" / "settings.json").read_text())
    assert settings["defaultModel"] == "mine"
    (backup,) = (home / ".local" / "share" / "pi-stack" / "backups").iterdir()
    assert json.loads((backup / "settings.json").read_text())["packages"] == ["npm:pi-mine@1.0.0"]


def group_has_live_members(pgid: int, timeout: float) -> bool:
    """Check owned-group liveness without mistaking unreaped zombies for writers.

    Parameters:
        pgid (int): process group created by this test.
        timeout (float): remaining cleanup deadline in seconds.

    Returns:
        bool: a non-zombie process remains in the group.
    """
    output = subprocess.check_output(["/bin/ps", "-axo", "pgid=,stat="], text=True, timeout=timeout)
    return any(
        fields[0] == str(pgid) and not fields[1].startswith("Z")
        for line in output.splitlines()
        if len(fields := line.split()) == 2
    )


def cleanup_group(process: subprocess.Popen[str], timeout: float = 60) -> None:
    """Quiesce an owned session, retaining its unreaped leader as the PGID anchor.

    Parameters:
        process (subprocess.Popen[str]): session leader; no caller may poll or reap it.
        timeout (float): shared deadline for signalling, process-table checks and reaping.

    Raises:
        BaseExceptionGroup: multiple cleanup steps failed; all failures are retained.
    """
    deadline = time.monotonic() + timeout
    errors: list[BaseException] = []
    try:
        assert process.returncode is None, "Process group ownership anchor was already reaped"
        while True:
            remaining = deadline - time.monotonic()
            assert remaining > 0, f"Process group '{process.pid}' survived cleanup"
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                break
            except PermissionError:
                # macOS rejects signals to some zombie-only groups. A live member is
                # still a real permission failure; zombies cannot fork or write.
                remaining = deadline - time.monotonic()
                assert remaining > 0, f"Process group '{process.pid}' survived cleanup"
                if group_has_live_members(process.pid, remaining):
                    raise
                break
            remaining = deadline - time.monotonic()
            assert remaining > 0, f"Process group '{process.pid}' survived cleanup"
            if not group_has_live_members(process.pid, remaining):
                break
            # Never poll/wait here: even a zombie leader reserves the PGID while a
            # fork racing SIGKILL can require another signal. Reap only after the
            # last possible signal, including on failed cleanup paths.
    except BaseException as error:
        errors.append(error)
    try:
        process.wait(timeout=max(deadline - time.monotonic(), 0))
    except BaseException as error:
        errors.append(error)
    try:
        if process.stdout is not None:
            process.stdout.close()
    except BaseException as error:
        errors.append(error)
    if len(errors) == 1:
        raise errors[0]
    if errors:
        raise BaseExceptionGroup("Process group cleanup failed", errors)


def kill_at_marker(process: subprocess.Popen[str], marker: str, timeout: float) -> str:
    """Wait at most `timeout` seconds for a line prefix, always kill and reap the group.

    Parameters:
        process (subprocess.Popen[str]): unreaped child in its own session with piped stdout.
        marker (str): line prefix at which to interrupt staging.
        timeout (float): marker detection deadline in seconds.

    Returns:
        str: bounded captured output through the marker.

    Raises:
        AssertionError: the marker is absent, late, or output exceeds one MiB.
    """
    output = bytearray()
    deadline = time.monotonic() + timeout
    marker_error: BaseException | None = None
    try:
        assert process.stdout is not None, "child stdout must be piped"
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            while True:
                remaining = deadline - time.monotonic()
                assert remaining > 0, f"Timed out waiting for '{marker}': {output.decode(errors='replace')}"
                if not selector.select(remaining):
                    continue
                chunk = os.read(process.stdout.fileno(), 65536)
                assert chunk, f"Child exited before '{marker}': {output.decode(errors='replace')}"
                output.extend(chunk)
                assert len(output) <= 1024 * 1024, "Child output exceeded one MiB before marker"
                if any(line.startswith(marker.encode()) for line in output.split(b"\n")):
                    return output.decode(errors="replace")
    except BaseException as error:
        marker_error = error
        raise
    finally:
        try:
            cleanup_group(process)
        except BaseException as cleanup_error:
            if marker_error is not None:
                raise BaseExceptionGroup(
                    "Marker wait and process group cleanup failed", [marker_error, cleanup_error]
                ) from None
            raise


def test_killed_install_changes_nothing_and_rerun_completes(
    spec: str, stack_sha: str, uv_cache: Path, home: Path
) -> None:
    """SIGKILL during package staging leaves the existing setup intact; the rerun installs."""
    seed_existing(home)
    before = digest_tree(home)
    process = subprocess.Popen(
        command(spec, stack_sha, "--yes"),
        env=environment(home, uv_cache),
        cwd=home,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        start_new_session=True,
    )
    seen = kill_at_marker(process, KILL_AFTER, INSTALL_TIMEOUT)
    assert process.returncode == -signal.SIGKILL, seen
    assert digest_tree(home) == before
    assert not (home / ".local" / "share" / "pi-stack" / "transaction.json").exists()
    rerun = run(command(spec, stack_sha, "--yes"), environment(home, uv_cache))
    assert rerun.returncode == 0, rerun.stdout
    assert json.loads((home / ".pi" / "agent" / "settings.json").read_text())["defaultModel"] == "mine"
