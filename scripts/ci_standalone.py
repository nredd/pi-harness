"""Build the CI standalone executable twice before exporting it to the stack tests.

References:
- https://bun.sh/docs/bundler/executables
- https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path


def install_inputs(core: Path, model_data: Path, npm: str, tar: str) -> None:
    """Restore the frozen model inputs without calling the live model fetch.

    Parameters:
        core (Path): Disposable core checkout.
        model_data (Path): Runner-local extraction directory.
        npm (str): Resolved npm executable.
        tar (str): Resolved tar executable.
    """
    subprocess.run([npm, "ci", "--ignore-scripts"], cwd=core, check=True)
    ai = core / "packages/ai"
    version = json.loads((ai / "package.json").read_text(encoding="utf-8"))["version"]
    model_data.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [npm, "pack", f"@earendil-works/pi-ai@{version}", "--pack-destination", str(model_data)],
        cwd=core,
        check=True,
    )
    subprocess.run(
        [tar, "-xzf", str(model_data / f"earendil-works-pi-ai-{version}.tgz"), "-C", str(model_data)],
        check=True,
    )
    destination = ai / "src/providers/data"
    if destination.exists():
        shutil.rmtree(destination)
    shutil.copytree(model_data / "package/dist/providers/data", destination)


def build(core: Path, evidence: Path, platform: str, output: Path) -> int:
    """Run the wrapped build, streaming merged output to the runner and evidence file.

    Parameters:
        core (Path): Disposable core checkout.
        evidence (Path): Wrapper and evidence directory.
        platform (str): Standalone platform argument.
        output (Path): Standalone output directory.

    Returns:
        int: Build exit status, not the status of the log writer.
    """
    env = os.environ | {"PATH": f"{evidence / 'bin'}{os.pathsep}{os.environ['PATH']}"}
    cmd = [
        str(core / "scripts/build-binaries.sh"),
        "--skip-install",
        "--offline-model-data",
        "--platform",
        platform,
        "--out",
        str(output),
    ]
    with (
        (evidence / "build.log").open("wb") as log,
        subprocess.Popen(cmd, cwd=core, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT) as child,
    ):
        assert child.stdout is not None
        for line in child.stdout:
            log.write(line)
            sys.stdout.buffer.write(line)
            sys.stdout.buffer.flush()
        return child.wait()


def keep_first(evidence: Path, executable: Path, first: Path) -> None:
    """Preserve whatever evidence the first build produced, even on failure.

    Parameters:
        evidence (Path): Wrapper and evidence directory.
        executable (Path): Built executable path.
        first (Path): Destination of the first executable.
    """
    archive = evidence / "first"
    archive.mkdir(exist_ok=True)
    for name in ("build.log", "compile-command.json", "module-graph.json"):
        path = evidence / name
        if path.exists():
            path.replace(archive / name)
    if executable.is_file():
        executable.replace(first)


def tool_path(name: str) -> str:
    """Resolve a tool from the runner's configured PATH.

    Parameters:
        name (str): Executable name.

    Returns:
        str: Resolved executable path.
    """
    executable = shutil.which(name)
    if executable is None:
        raise FileNotFoundError(f"Standalone build requires `{name}`")
    return executable


def main(platform: str) -> int:
    """Verify that both builds use identical compile argv and produce identical bytes.

    Parameters:
        platform (str): Standalone build platform from the stack matrix.

    Returns:
        int: Exit status, with `PI_BIN` published only on success.
    """
    root = Path.cwd()
    core = root / "forks/pi"
    temp = Path(os.environ["RUNNER_TEMP"])
    evidence = temp / "pi-build-evidence"
    output = temp / "pi-standalone"
    first = temp / "pi-first-build"
    executable = output / platform / "pi"
    npm, tar = tool_path("npm"), tool_path("tar")
    diagnostics = [sys.executable, "-m", "harness.standalone_diagnostics"]
    env = os.environ | {"PYTHONPATH": str(root / "tests/integration")}
    install_inputs(core, temp / "model-data", npm, tar)
    subprocess.run([*diagnostics, "prepare-build", "--directory", str(evidence)], env=env, check=True)
    status = build(core, evidence, platform, output)
    keep_first(evidence, executable, first)
    if status:
        return status
    if status := build(core, evidence, platform, output):
        return status
    command = "compile-command.json"
    if (evidence / "first" / command).read_bytes() != (evidence / command).read_bytes():
        sys.stderr.write("Standalone compile commands differ between builds\n")
        return 1
    subprocess.run(
        [
            *diagnostics,
            "verify-reproducible",
            "--first",
            str(first),
            "--second",
            str(executable),
            "--digest-out",
            str(root / "tests/integration/artifacts/standalone-pi.sha256"),
        ],
        env=env,
        check=True,
    )
    with Path(os.environ["GITHUB_ENV"]).open("a", encoding="utf-8") as exported:
        exported.write(f"PI_BIN={executable}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(*sys.argv[1:]))
