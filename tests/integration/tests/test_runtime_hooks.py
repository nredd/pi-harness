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
from harness.startup import Sample
from scenarios import test_startup as readiness_scenario

ROOT = Path(__file__).resolve().parents[2]
ENGINES = ["node", "bun", "compiled-bun"]
PRELOAD = 'globalThis.__harnessPreload = "loaded";\n'
ENTRYPOINT = dedent("""\
    console.log(JSON.stringify({ preload: globalThis.__harnessPreload ?? null, gc: typeof globalThis.gc }));
""")


def test_no_hook_requested_sets_no_environment() -> None:
    """An empty request must not export blank `NODE_OPTIONS` or `BUN_OPTIONS`."""
    assert runtime_hooks() == {}
    assert runtime_hooks(env={"NODE_OPTIONS": "--trace-warnings"}) == {}


def test_hooks_are_spelled_for_each_runtime_in_order(tmp_path: Path) -> None:
    """Node gets `--import`, Bun gets `--preload`, and both get `--expose-gc`, preserving order."""
    first, second = tmp_path / "a.mjs", tmp_path / "b.mjs"
    assert runtime_hooks([first, second], expose_gc=True) == {
        "NODE_OPTIONS": f"--import {first} --import {second} --expose-gc",
        "BUN_OPTIONS": f"--preload {first} --preload {second} --expose-gc",
    }
    assert runtime_hooks(expose_gc=True) == {"NODE_OPTIONS": "--expose-gc", "BUN_OPTIONS": "--expose-gc"}
    existing = {"NODE_OPTIONS": '--import "/fixture with space/old.mjs"', "BUN_OPTIONS": "--smol"}
    assert runtime_hooks([first], env=existing) == {
        "NODE_OPTIONS": f"{existing['NODE_OPTIONS']} --import {first}",
        "BUN_OPTIONS": f"--smol --preload {first}",
    }


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
    env |= {"NODE_OPTIONS": "--expose-gc", "BUN_OPTIONS": "--expose-gc"}
    hooked = env | runtime_hooks([preload], env=env)
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


@pytest.mark.parametrize("engine", ["node", "compiled-bun"])
def test_readiness_guard_acknowledges_on_each_runtime(
    engine: str, compiled_entrypoint: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Run the exact readiness guard on Node and an actual compiled Bun fixture.

    Parameters:
        engine (str): native runtime receiving the guard.
        compiled_entrypoint (Path): small compiled report fixture.
        tmp_path (Path): synthetic readiness HOME.
        monkeypatch (pytest.MonkeyPatch): substitutes only the sampler's CLI process.
    """
    entry = tmp_path / "entry.mjs"
    entry.write_text(ENTRYPOINT)
    node = shutil.which("node")
    assert node is not None
    command = [node, str(entry)] if engine == "node" else [str(compiled_entrypoint)]

    def run_guard(argv: list[str], *, env: dict[str, str], frame_pattern: str) -> Sample:
        """Execute the real preload before the small report entrypoint.

        Parameters:
            argv (list[str]): unused native Pi command, replaced only in this unit seam.
            env (dict[str, str]): scenario-generated environment, including both hooks.
            frame_pattern (str): sampler's footer pattern.

        Returns:
            Sample: synthetic timing values, never a latency measurement.
        """
        subprocess.run(command, env=env, check=True, capture_output=True, timeout=10)
        return Sample(0.1, 0.2, 0.3, {})

    monkeypatch.setattr(readiness_scenario, "pi_command", lambda: ["fixture"])
    monkeypatch.setattr(readiness_scenario, "sample", run_guard)
    readiness_scenario.test_startup_readiness_native_dispatch_without_network(tmp_path)


@pytest.mark.parametrize("ack", [None, "wrong-nonce"])
def test_readiness_guard_cannot_pass_without_loaded_ack(
    ack: str | None, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Absent/wrong guard admission fails even when no network log exists.

    Parameters:
        ack (str | None): absent or malformed guard acknowledgement.
        tmp_path (Path): synthetic HOME and marker directory.
        monkeypatch (pytest.MonkeyPatch): replaces dispatch without running a preload.
    """

    def unguarded_sample(argv: list[str], *, env: dict[str, str], frame_pattern: str) -> Sample:
        """Simulate successful readiness with an unadmitted network guard.

        Parameters:
            argv (list[str]): unused process command.
            env (dict[str, str]): scenario marker paths.
            frame_pattern (str): unused footer regex.

        Returns:
            Sample: synthetic successful dispatch.
        """
        if ack is not None:
            Path(env["GUARD_LOADED"]).write_text(ack)
        return Sample(0.1, 0.2, 0.3, {})

    monkeypatch.setattr(readiness_scenario, "pi_command", lambda: ["fixture"])
    monkeypatch.setattr(readiness_scenario, "sample", unguarded_sample)
    with pytest.raises(AssertionError, match="Network guard preload"):
        readiness_scenario.test_startup_readiness_native_dispatch_without_network(tmp_path)


@pytest.mark.parametrize("engine", ["node", "compiled-bun"])
def test_failed_preload_exits_nonzero(engine: str, compiled_entrypoint: Path, tmp_path: Path) -> None:
    """A failed hook is a process failure, never evidence of no network calls.

    Parameters:
        engine (str): runtime receiving the invalid preload.
        compiled_entrypoint (Path): small compiled fixture.
        tmp_path (Path): private entrypoint and failed guard.
    """
    (tmp_path / "entry.mjs").write_text(ENTRYPOINT)
    guard = tmp_path / "failed.mjs"
    guard.write_text('throw new Error("guard installation failed");\n')
    node = shutil.which("node")
    assert node is not None
    command = [node, str(tmp_path / "entry.mjs")] if engine == "node" else [str(compiled_entrypoint)]
    result = subprocess.run(
        command, env=runtime_hooks([guard]), capture_output=True, text=True, timeout=10, check=False
    )
    assert result.returncode != 0
    assert "guard installation failed" in result.stderr
