"""Prove `runtime_hooks` loads a preload and exposes `gc` under Node, Bun and a compiled Bun standalone.

The compiled executable is the case that motivated the adapter: it ignores `NODE_OPTIONS`.

References:
- https://github.com/nredd/pi-harness/issues/14
- https://bun.sh/docs/runtime/bunfig#preload
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path
from textwrap import dedent

import pytest

from harness.runtime_hooks import runtime_hooks

ROOT = Path(__file__).resolve().parents[2]
ENGINES = ["node", "bun", "compiled-bun"]
PRELOAD = 'globalThis.__harnessPreload = "loaded";\n'
ENTRYPOINT = dedent("""\
    console.log(JSON.stringify({ preload: globalThis.__harnessPreload ?? null, gc: typeof globalThis.gc }));
""")


def test_no_hook_requested_sets_no_environment() -> None:
    """An empty request must not export blank `NODE_OPTIONS` or `BUN_OPTIONS`."""
    assert runtime_hooks() == {}


def test_hooks_are_spelled_for_each_runtime_in_order(tmp_path: Path) -> None:
    """Node gets `--import`, Bun gets `--preload`, and both get `--expose-gc`, preserving order."""
    first, second = tmp_path / "a.mjs", tmp_path / "b.mjs"
    assert runtime_hooks([first, second], expose_gc=True) == {
        "NODE_OPTIONS": f"--import {first} --import {second} --expose-gc",
        "BUN_OPTIONS": f"--preload {first} --preload {second} --expose-gc",
    }
    assert runtime_hooks(expose_gc=True) == {"NODE_OPTIONS": "--expose-gc", "BUN_OPTIONS": "--expose-gc"}


@pytest.mark.parametrize("name", ["with space.mjs", 'with"quote.mjs', "with'quote.mjs"])
def test_unquotable_preload_paths_are_refused(tmp_path: Path, name: str) -> None:
    """Bun drops a quoted `--preload` silently, so refuse the path instead of running unhooked."""
    with pytest.raises(ValueError, match="cannot quote"):
        runtime_hooks([tmp_path / name])


@pytest.fixture(scope="module")
def compiled_entrypoint(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """Compile the report entrypoint with the pinned Bun.

    Parameters:
        tmp_path_factory (pytest.TempPathFactory): private output directory.

    Returns:
        Path: compiled standalone executable.
    """
    bun = shutil.which("bun")
    assert bun, "The pinned Bun runtime is required for the compiled standalone"
    assert (
        subprocess.check_output([bun, "--version"], text=True).strip()
        == (ROOT / ".bun-version").read_text().strip()
    )
    directory = tmp_path_factory.mktemp("compiled-hooks")
    source = directory / "entry.mjs"
    source.write_text(ENTRYPOINT)
    binary = directory / "entry"
    subprocess.run(
        [bun, "build", "--compile", str(source), "--outfile", str(binary)],
        check=True,
        capture_output=True,
        text=True,
        timeout=60,
    )
    return binary


def report(engine: str, compiled: Path, directory: Path, env: dict[str, str]) -> dict[str, str | None]:
    """Run the entrypoint on `engine` with only `env` and return what it observed.

    Parameters:
        engine (str): `node`, `bun` or `compiled-bun`.
        compiled (Path): compiled standalone for `compiled-bun`.
        directory (Path): working directory holding `entry.mjs`.
        env (dict[str, str]): the entire child environment.

    Returns:
        dict[str, str | None]: the loaded preload marker and `typeof gc`.
    """
    if engine == "compiled-bun":
        command = [str(compiled)]
    else:
        executable = shutil.which(engine)
        assert executable, f"Required engine '{engine}' is absent"
        command = [str(Path(executable).resolve()), str(directory / "entry.mjs")]
    result = subprocess.run(
        command, cwd=directory, env=env, capture_output=True, text=True, timeout=30, check=False
    )
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


@pytest.mark.parametrize("engine", ENGINES)
def test_preload_and_gc_load_on_every_runtime(engine: str, compiled_entrypoint: Path, tmp_path: Path) -> None:
    """The adapter's variables load the preload and expose `gc` on Node, Bun and the standalone.

    Parameters:
        engine (str): runtime under test.
        compiled_entrypoint (Path): compiled standalone.
        tmp_path (Path): private working directory.
    """
    (tmp_path / "entry.mjs").write_text(ENTRYPOINT)
    preload = tmp_path / "preload.mjs"
    preload.write_text(PRELOAD)
    env = {"HOME": str(tmp_path)}
    assert report(engine, compiled_entrypoint, tmp_path, env) == {"preload": None, "gc": "undefined"}
    hooked = env | runtime_hooks([preload], expose_gc=True)
    assert report(engine, compiled_entrypoint, tmp_path, hooked) == {"preload": "loaded", "gc": "function"}


@pytest.mark.parametrize("flag", ["--import {preload}", "--require {cjs}", "--expose-gc"])
def test_compiled_bun_ignores_node_options(compiled_entrypoint: Path, tmp_path: Path, flag: str) -> None:
    """Pin the root cause of #14: no `NODE_OPTIONS` flag reaches a compiled standalone.

    Parameters:
        compiled_entrypoint (Path): compiled standalone.
        tmp_path (Path): private working directory.
        flag (str): one Node option, isolated from the others.
    """
    preload, cjs = tmp_path / "preload.mjs", tmp_path / "preload.cjs"
    preload.write_text(PRELOAD)
    cjs.write_text(PRELOAD)
    env = {"HOME": str(tmp_path), "NODE_OPTIONS": flag.format(preload=preload, cjs=cjs)}
    assert report("compiled-bun", compiled_entrypoint, tmp_path, env) == {"preload": None, "gc": "undefined"}


def test_bun_drops_a_quoted_preload_silently(compiled_entrypoint: Path, tmp_path: Path) -> None:
    """Pin why paths with whitespace are refused: Bun runs unhooked instead of failing.

    Parameters:
        compiled_entrypoint (Path): compiled standalone.
        tmp_path (Path): private working directory.
    """
    spaced = tmp_path / "with space"
    spaced.mkdir()
    preload = spaced / "preload.mjs"
    preload.write_text(PRELOAD)
    env = {"HOME": str(tmp_path), "BUN_OPTIONS": f'--preload "{preload}"'}
    assert report("compiled-bun", compiled_entrypoint, tmp_path, env) == {"preload": None, "gc": "undefined"}
