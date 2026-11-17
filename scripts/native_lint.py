"""Bootstrap isolated pinned linters and statically check owned shell/workflow sources.

References:
    https://www.shellcheck.net/
    https://github.com/rhysd/actionlint
    https://github.com/PowerShell/PSScriptAnalyzer
    https://docs.github.com/en/actions/learn-github-actions/expressions
"""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
import logging
import os
import platform
import re
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request
import zipfile
from pathlib import Path
from typing import Any

import yaml

LOGGER = logging.getLogger(__name__)
ROOT = Path(__file__).resolve().parent.parent
MANIFEST = Path(__file__).with_name("native_lint_tools.json")
VERSIONS = {"shellcheck": "0.11.0", "actionlint": "1.7.12", "pwsh": "7.4.22"}
EXPRESSION = re.compile(r"\$\{\{.*?\}\}", re.DOTALL)
SHELL_TOKEN = re.compile(r"'(?:[^']|'')*'|&&|\|\||!(?!=)")
# These are the actual custom labels in the workflows, not arbitrary runner-label waivers.
LABELS = "self-hosted-runner:\n  labels: [xcode-27, pi-linux, pi-macos, pi-wsl2]\n"
PS_SCRIPT = """$ErrorActionPreference = 'Stop'
Import-Module $args[0] -RequiredVersion 1.24.0 -Force
if ((Get-Module PSScriptAnalyzer).Version.ToString() -ne '1.24.0') { throw 'Wrong analyzer version' }
# CI diagnostics intentionally use the host stream, not a function's success output.
# Disposable fixture constructors are noninteractive and must not prompt for ShouldProcess.
foreach ($file in Get-ChildItem $args[1] -File -Recurse) {
    $tokens = $null
    $parseErrors = $null
    $null = [System.Management.Automation.Language.Parser]::ParseFile(
        $file.FullName, [ref]$tokens, [ref]$parseErrors)
    if ($parseErrors.Count -gt 0) {
        $parseErrors | Format-List | Out-String -Width 240 | Write-Output
        exit 1
    }
}
$excluded = @('PSAvoidUsingWriteHost', 'PSUseShouldProcessForStateChangingFunctions')
$issues = @(Invoke-ScriptAnalyzer -Path $args[1] -Recurse -Severity Error,Warning -ExcludeRule $excluded)
$issues | Format-Table -AutoSize | Out-String -Width 240 | Write-Output
if ($issues.Count -gt 0) { exit 1 }
"""


def run(argv: list[str], cwd: Path) -> str:
    """Run a bounded native tool, preserving diagnostics and refusing nonzero exits.

    Parameters:
        argv (list[str]): Absolute executable and arguments.
        cwd (Path): Working directory.
    Returns:
        str: Combined output, also logged.
    Raises:
        OSError: The tool is missing or cannot execute.
        subprocess.SubprocessError: Execution fails or exceeds five minutes.
    """
    with tempfile.TemporaryDirectory() as home:
        env = os.environ | {
            "HOME": home,
            "USERPROFILE": home,
            "XDG_CACHE_HOME": str(Path(home) / ".cache"),
            "XDG_CONFIG_HOME": str(Path(home) / ".config"),
            "POWERSHELL_TELEMETRY_OPTOUT": "1",
        }
        result = subprocess.check_output(
            argv, cwd=cwd, env=env, text=True, stderr=subprocess.STDOUT, timeout=300
        )
    if "ls-files" not in argv:
        LOGGER.info(result.strip())
    return result


def bootstrap(destination: Path, host: str) -> None:
    """Install checksum-verified archives into a disposable worktree-local prefix.

    Parameters:
        destination (Path): Explicit isolated prefix, never a global tool directory.
        host (str): Supported OS/architecture manifest key.
    Returns:
        None.
    Raises:
        ValueError: Host or archive checksum is unsupported.
        OSError: Download or extraction fails.
    """
    manifest = json.loads(MANIFEST.read_text())
    if host not in manifest:
        raise ValueError(f"Unsupported lint host: '{host}'")
    destination.mkdir(parents=True, exist_ok=True)
    for name, asset in manifest[host].items():
        target = destination / name
        with tempfile.TemporaryDirectory(dir=destination) as temporary:
            archive = Path(temporary) / "asset"
            with urllib.request.urlopen(asset["url"], timeout=120) as response:
                archive.write_bytes(response.read())
            if hashlib.sha256(archive.read_bytes()).hexdigest() != asset["sha256"]:
                raise ValueError(f"Checksum mismatch for '{name}'")
            extracted = Path(temporary) / "extracted"
            extracted.mkdir()
            if asset["url"].endswith((".whl", ".nupkg")):
                with zipfile.ZipFile(archive) as bundle:
                    bundle.extractall(extracted)
            else:
                with tarfile.open(archive) as bundle:
                    bundle.extractall(extracted, filter="data")
            if target.exists():
                shutil.rmtree(target)
            extracted.rename(target)
        for binary in target.rglob(name):
            if binary.is_file():
                binary.chmod(0o755)
    verify(destination)


def binaries(prefix: Path) -> dict[str, Path]:
    """Resolve only isolated binaries, without falling back to PATH.

    Parameters:
        prefix (Path): Installed prefix.
    Returns:
        dict[str, Path]: Exactly one binary per native tool.
    Raises:
        FileNotFoundError: A tool is absent or ambiguous.
    """
    found = {}
    for name in VERSIONS:
        matches = [path for path in (prefix / name).rglob(name) if path.is_file()]
        if len(matches) != 1:
            raise FileNotFoundError(f"Expected one isolated '{name}', found '{len(matches)}'")
        found[name] = matches[0].resolve()
    return found


def verify(prefix: Path) -> dict[str, Path]:
    """Refuse tools whose native version output differs from the pinned version.

    Parameters:
        prefix (Path): Installed isolated tools.
    Returns:
        dict[str, Path]: Verified executable paths.
    Raises:
        ValueError: A native version is not the required version.
    """
    tools = binaries(prefix)
    for name, version in VERSIONS.items():
        flag = "-version" if name == "actionlint" else "--version"
        output = run([str(tools[name]), flag], prefix)
        expected = {
            "shellcheck": f"version: {version}",
            "actionlint": version,
            "pwsh": f"PowerShell {version}",
        }
        if expected[name] not in output.splitlines():
            raise ValueError(f"Wrong '{name}' version; expected '{version}', got '{output.strip()}'")
    return tools


def composite_sources(root: Path, owned: list[Path], scratch: Path, shellcheck: Path) -> None:
    """Extract composite action run blocks for native static analysis.

    Parameters:
        root (Path): Repository root.
        owned (list[Path]): Tracked owned paths.
        scratch (Path): Temporary shell and PowerShell source directory.
        shellcheck (Path): Verified native executable.
    Returns:
        None.
    Raises:
        ValueError: A composite uses an unsupported shell.
    """
    for path in owned:
        if path.name not in {"action.yml", "action.yaml"} or not path.is_relative_to(
            root / ".github/actions"
        ):
            continue
        data = yaml.safe_load(path.read_text())
        for index, step in enumerate(data["runs"]["steps"]):
            if "run" not in step:
                continue
            script = EXPRESSION.sub("synthetic", step["run"])
            if step["shell"] in {"bash", "bash -e {0}"}:
                source = scratch / f"{path.parent.name}-{index}.bash"
                source.write_text("#!/usr/bin/env bash\n" + script)
                run([str(shellcheck), str(source)], root)
            elif step["shell"] == "pwsh":
                (scratch / "powershell" / f"{path.parent.name}-{index}.ps1").write_text(script)
            else:
                raise ValueError(f"Unsupported composite shell: '{step['shell']}'")


def workflow_shell(step: dict[str, Any], job: dict[str, Any], workflow: dict[str, Any]) -> str:
    """Resolve declared shell precedence, then the Windows/non-Windows implicit default.

    Parameters:
        step (dict): Workflow step.
        job (dict): Parent job, including its runner and matrix.
        workflow (dict): Parent workflow.
    Returns:
        str: Effective shell declaration; expressions remain inert data.
    """
    declared = step.get(
        "shell",
        job.get("defaults", {})
        .get("run", {})
        .get("shell", workflow.get("defaults", {}).get("run", {}).get("shell")),
    )
    if declared is not None:
        return declared
    runners = str(job["runs-on"])
    if "matrix." in runners:
        runners += str(job.get("strategy", {}).get("matrix", {}))
    return "pwsh" if "windows" in runners.lower() else "bash"


def shell_token(match: re.Match[str]) -> str:
    """Translate expression tokens without interpreting or executing their contents.

    Parameters:
        match (re.Match[str]): A GitHub string literal or boolean operator.
    Returns:
        str: Equivalent Python syntax for AST inspection only.
    """
    token = match.group()
    if token.startswith("'"):
        return json.dumps(token[1:-1].replace("''", "'"))
    return {"&&": " and ", "||": " or ", "!": " not "}[token]


def shell_candidates(node: ast.expr) -> list[str]:
    """Collect literal result alternatives from boolean selectors and format calls.

    Parameters:
        node (ast.expr): Unevaluated expression tree.
    Returns:
        list[str]: Conservative shell-command templates, ignoring selector predicates.
    Raises:
        ValueError: A result cannot be statically classified as a literal template.
    """
    if isinstance(node, ast.BoolOp):
        values = node.values[-1:] if isinstance(node.op, ast.And) else node.values
        return [candidate for value in values for candidate in shell_candidates(value)]
    if (
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == "format"
        and node.args
    ):
        node = node.args[0]
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return [node.value]
    raise ValueError("Nonliteral shell expression result")


def require_bash_expression(declaration: str, location: str) -> None:
    """Admit only expression shells whose literal result alternatives are all Bash.

    Parameters:
        declaration (str): Complete expression-valued shell declaration.
        location (str): Workflow file, job and step for refusal diagnostics.
    Returns:
        None.
    Raises:
        ValueError: A declaration is unknown, mixed-dialect or malformed.
    """
    try:
        if not declaration.startswith("${{") or not declaration.endswith("}}"):
            raise ValueError("Shell expression must occupy the complete declaration")
        expression = SHELL_TOKEN.sub(shell_token, declaration[3:-2].strip()).strip()
        for candidate in shell_candidates(ast.parse(expression, mode="eval").body):
            command, *_ = candidate.split()
            if command not in {"bash", "/bin/bash", "/usr/bin/bash"}:
                raise ValueError(f"Unsupported expression shell: '{command}'")
    except (SyntaxError, ValueError) as error:
        raise ValueError(f"Unclassifiable shell expression in {location}: '{declaration}'") from error


def lint(root: Path, prefix: Path) -> None:
    """Lint tracked source and embedded composite-action shell, never execute it.

    Parameters:
        root (Path): Repository checkout with its real tracked source inventory.
        prefix (Path): Isolated pinned tools.
    Returns:
        None.
    Raises:
        ValueError: The source inventory is empty.
        subprocess.SubprocessError: Any native lint diagnostic fails the gate.
    """
    tools = verify(prefix)
    files = run(["/usr/bin/git", "ls-files", "-z"], root).split("\0")
    # The core Gitlink is independently gated. Everything else is checked, including fixtures.
    owned = [root / file for file in files if file and not file.startswith("forks/")]
    shells = [path for path in owned if path.suffix in {".sh", ".bash"}]
    powershell = [path for path in owned if path.suffix in {".ps1", ".psm1", ".psd1"}]
    workflows = [
        path
        for path in owned
        if path.parent == root / ".github/workflows" and path.suffix in {".yml", ".yaml"}
    ]
    if not shells or not powershell or not workflows:
        raise ValueError("Empty shell, PowerShell or workflow inventory")
    with tempfile.TemporaryDirectory() as temporary:
        scratch = Path(temporary)
        cfg = scratch / "actionlint.yml"
        cfg.write_text(LABELS)
        run([str(tools["shellcheck"]), *map(str, shells)], root)
        run(
            [
                str(tools["actionlint"]),
                "-config-file",
                str(cfg),
                "-shellcheck",
                str(tools["shellcheck"]),
                *map(str, workflows),
            ],
            root,
        )
        ps_sources = scratch / "powershell"
        ps_sources.mkdir()
        for index, path in enumerate(powershell):
            shutil.copyfile(path, ps_sources / f"source-{index}.ps1")
        composite_sources(root, owned, scratch, tools["shellcheck"])
        for path in workflows:
            data = yaml.safe_load(path.read_text())
            for job_name, job in data["jobs"].items():
                for index, step in enumerate(job.get("steps", [])):
                    if "run" not in step:
                        continue
                    shell = workflow_shell(step, job, data).strip()
                    if "${{" in shell:
                        location = f"'{path.relative_to(root)}' job '{job_name}' step '{index}'"
                        require_bash_expression(shell, location)
                        source = scratch / f"{path.stem}-{job_name}-{index}.bash"
                        source.write_text("#!/usr/bin/env bash\n" + EXPRESSION.sub("synthetic", step["run"]))
                        LOGGER.info(f"ShellCheck expression-valued shell in {location}")
                        run([str(tools["shellcheck"]), str(source)], root)
                    elif shell.split()[0] in {"pwsh", "powershell"}:
                        script = EXPRESSION.sub("synthetic", step["run"])
                        (ps_sources / f"{path.stem}-{job_name}-{index}.ps1").write_text(script)
        analyzer = prefix / "analyzer/PSScriptAnalyzer.psd1"
        runner = scratch / "analyze.ps1"
        runner.write_text(PS_SCRIPT)
        run(
            [
                str(tools["pwsh"]),
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-File",
                str(runner),
                str(analyzer),
                str(ps_sources),
            ],
            root,
        )
    LOGGER.info(
        f"Linted {len(shells)} shell sources, {len(powershell)} PowerShell sources "
        f"and {len(workflows)} workflows; static analysis only"
    )


def main() -> None:
    """Run the bootstrap or lint CLI, failing closed with native diagnostics.

    Parameters:
        None.
    Returns:
        None.
    Raises:
        SystemExit: The CLI input or any tool fails.
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["bootstrap", "check"])
    parser.add_argument("--prefix", type=Path, default=ROOT / ".native-lint")
    parser.add_argument("--root", type=Path, default=ROOT)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    try:
        if args.command == "bootstrap":
            bootstrap(args.prefix.resolve(), f"{platform.system().lower()}-{platform.machine().lower()}")
        else:
            lint(args.root.resolve(), args.prefix.resolve())
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        LOGGER.error(str(error))
        if isinstance(error, subprocess.CalledProcessError):
            LOGGER.error(error.output)
        raise SystemExit(1) from error


if __name__ == "__main__":
    main()
