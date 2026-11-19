"""Exercise the CI standalone builder with a disposable core checkout and no network."""

from __future__ import annotations

import hashlib
import os
import subprocess
import sys
import tarfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import ci_standalone

ROOT = Path(__file__).resolve().parents[2]
PLATFORM = "linux-x64"


def executable(path: Path, text: str) -> None:
    """Write an executable fixture command.

    Parameters:
        path (Path): Command path.
        text (str): Command body.
    """
    path.write_text("#!/bin/bash\nset -eu\n" + text)
    path.chmod(0o755)


@pytest.fixture
def runner(tmp_path: Path) -> dict[str, str]:
    """Stage a real tar archive and fixture commands alongside the real diagnostics.

    Parameters:
        tmp_path (Path): Disposable runner root.

    Returns:
        dict[str, str]: Runner environment.
    """
    core = tmp_path / "forks/pi"
    ai = core / "packages/ai"
    ai.mkdir(parents=True)
    (ai / "package.json").write_text('{"version":"5.6.7"}')
    (core / "scripts").mkdir()
    (tmp_path / "tests/integration").mkdir(parents=True)
    (tmp_path / "tests/integration/harness").symlink_to(ROOT / "tests/integration/harness")
    models = tmp_path / "fixture-models"
    models.write_text("frozen models\n")
    with tarfile.open(tmp_path / "models.tgz", "w:gz") as archive:
        archive.add(models, arcname="package/dist/providers/data/fixture.ts")
    tools = tmp_path / "bin"
    tools.mkdir()
    executable(
        tools / "npm",
        """
case "$*" in
    'ci --ignore-scripts') printf '%s\\n' 'ci --ignore-scripts' >> "$RUNNER_TEMP/npm.log" ;;
    'pack @earendil-works/pi-ai@5.6.7 --pack-destination '*)
        /bin/cp "$RUNNER_TEMP/models.tgz" "$4/earendil-works-pi-ai-5.6.7.tgz" ;;
    *) exit 99 ;;
esac
""",
    )
    (tools / "bun").symlink_to("/usr/bin/true")
    executable(
        core / "scripts/build-binaries.sh",
        """
[[ "$*" == "--skip-install --offline-model-data --platform linux-x64 --out $RUNNER_TEMP/pi-standalone" ]]
[[ "$(command -v bun)" == "$RUNNER_TEMP/pi-build-evidence/bin/bun" ]]
[[ "$(<packages/ai/src/providers/data/fixture.ts)" == 'frozen models' ]]
pass=first
[[ ! -d "$RUNNER_TEMP/pi-build-evidence/first" ]] || pass=second
printf '%s\\n' "build $pass" >&2
[[ "$CASE" != fail-first ]] || exit 36
printf '%s\\n' "$*" > "$RUNNER_TEMP/pi-build-evidence/compile-command.json"
printf '%s\\n' graph > "$RUNNER_TEMP/pi-build-evidence/module-graph.json"
/bin/mkdir -p "$6/$4"
printf '%s\\n' executable > "$6/$4/pi"
if [[ "$pass" == second ]]; then
    case "$CASE" in
        fail-second) exit 37 ;;
        argv) printf '%s\\n' drift >> "$RUNNER_TEMP/pi-build-evidence/compile-command.json" ;;
        bytes) printf '%s\\n' drift >> "$6/$4/pi" ;;
    esac
fi
""",
    )
    return os.environ | {
        "PATH": f"{tools}{os.pathsep}/usr/bin:/bin",
        "RUNNER_TEMP": str(tmp_path),
        "GITHUB_ENV": str(tmp_path / "github-env"),
    }


@pytest.mark.parametrize(
    ("case", "status"), [("ok", 0), ("fail-first", 36), ("fail-second", 37), ("argv", 1), ("bytes", 1)]
)
def test_standalone_publishes_only_two_equivalent_builds(
    tmp_path: Path, runner: dict[str, str], case: str, status: int
) -> None:
    """Run the actual builder, compare evidence, and fail closed on either build or comparison.

    Parameters:
        tmp_path (Path): Disposable runner root.
        runner (dict[str, str]): Runner environment.
        case (str): Fixture fault to inject.
        status (int): Expected build step exit code.
    """
    data = tmp_path / "forks/pi/packages/ai/src/providers/data"
    if case != "fail-first":
        data.mkdir(parents=True)
        (data / "stale.ts").touch()
    result = subprocess.run(
        [sys.executable, str(ROOT / "scripts/ci_standalone.py"), PLATFORM],
        cwd=tmp_path,
        env=runner | {"CASE": case},
        check=False,
        capture_output=True,
        text=True,
    )
    assert result.returncode == status, result.stderr + result.stdout
    assert not (data / "stale.ts").exists()
    assert (tmp_path / "npm.log").read_text() == "ci --ignore-scripts\n"
    evidence = tmp_path / "pi-build-evidence"
    first = evidence / "first"
    assert (first / "build.log").read_text() == "build first\n"
    exe = tmp_path / "pi-standalone" / PLATFORM / "pi"
    exported = tmp_path / "github-env"
    digest = tmp_path / "tests/integration/artifacts/standalone-pi.sha256"
    if case == "fail-first":
        assert result.stdout == "build first\n"
        assert not (tmp_path / "pi-first-build").exists()
        assert not (evidence / "build.log").exists()
    else:
        assert result.stdout == "build first\nbuild second\n"
        assert (first / "module-graph.json").read_text() == "graph\n"
        assert (tmp_path / "pi-first-build").read_text() == "executable\n"
        assert (evidence / "build.log").read_text() == "build second\n"
    if case == "ok":
        assert exported.read_text() == f"PI_BIN={exe}\n"
        assert digest.read_text() == f"{hashlib.sha256(exe.read_bytes()).hexdigest()}  pi\n"
    else:
        assert not exported.exists()
        assert not digest.exists()


def test_standalone_cannot_start_without_npm(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Fail with the missing tool's name before creating build outputs.

    Parameters:
        tmp_path (Path): Disposable runner root.
        monkeypatch (pytest.MonkeyPatch): Isolate the runner's tool lookup and paths.
    """
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("RUNNER_TEMP", str(tmp_path))
    monkeypatch.setenv("GITHUB_ENV", str(tmp_path / "github-env"))
    monkeypatch.setenv("PATH", str(tmp_path / "empty"))
    with pytest.raises(FileNotFoundError, match="Standalone build requires `npm`"):
        ci_standalone.main(PLATFORM)
    assert not (tmp_path / "pi-build-evidence").exists()
    assert not (tmp_path / "github-env").exists()
