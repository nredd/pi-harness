"""Exercise the real render handler inside a small compiled Bun executable.

This is instrumentation proof with a synthetic TUI, NOT compiled Pi or performance acceptance.

References:
- https://github.com/nredd/pi-harness/issues/628
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
ENTRY = """
import probe from __PROBE__;
const calls = [];
const original = Bun.gc;
Bun.gc = (sync) => { calls.push(sync); return original(sync); };
if (process.argv[2] === 'failure') globalThis.gc = () => { throw Error('collection failed'); };
let handler;
probe({ registerCommand: (_, command) => { handler = command.handler; } });
const renders = [];
let invalidations = 0;
const tui = {
  invalidate: () => { invalidations++; },
  renderNow: (force) => { renders.push(force ?? false); },
  terminal: { columns: 120, rows: 40 },
};
await handler('3', { ui: { setWidget: (_, factory) => { if (factory) factory(tui); } } });
console.log(JSON.stringify({ calls, renders, invalidations }));
"""


@pytest.fixture(scope="module")
def compiled_render(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """Compile the actual probe with a synthetic command registry and TUI.

    Parameters:
        tmp_path_factory (pytest.TempPathFactory): disposable build directory provider.

    Returns:
        Path: native executable embedding the real render probe.
    """
    bun = shutil.which("bun")
    assert bun, "Pinned Bun is required"
    assert (
        subprocess.check_output([bun, "--version"], text=True, stderr=subprocess.STDOUT).strip()
        == (ROOT / ".bun-version").read_text().strip()
    )
    root = tmp_path_factory.mktemp("compiled-render")
    source = root / "entry.ts"
    source.write_text(ENTRY.replace("__PROBE__", json.dumps(str(ROOT / "integration/probes/render.ts"))))
    binary = root / "render"
    subprocess.run(
        [bun, "build", "--compile", str(source), "--outfile", str(binary)],
        check=True,
        capture_output=True,
        text=True,
        timeout=60,
    )
    return binary


@pytest.mark.parametrize("expose", [False, True])
def test_compiled_render_gc(compiled_render: Path, tmp_path: Path, expose: bool) -> None:
    """Prove fallback and exposed collection routes execute before a real record is appended.

    Parameters:
        compiled_render (Path): small native fixture, not the Pi standalone.
        tmp_path (Path): private output and HOME.
        expose (bool): enable Bun's exposed global collector instead of the fallback.
    """
    out = tmp_path / "render.jsonl"
    env = {"HOME": str(tmp_path), "HARNESS_PROBE_OUT": str(out)}
    if expose:
        env["BUN_OPTIONS"] = "--expose-gc"
    result = subprocess.run(
        [str(compiled_render)],
        env=env,
        check=True,
        capture_output=True,
        text=True,
        timeout=30,
    )
    execution = json.loads(result.stdout)
    assert execution == {
        "calls": [] if expose else [True],
        "renders": [True] * 5 + [False] * 5,
        "invalidations": 5,
    }
    records = out.read_text().splitlines()
    assert len(records) == 1
    record = json.loads(records[0])
    assert record["gc"] is True
    assert record["gc_method"] == ("global.gc" if expose else "Bun.gc(true)")
    assert record["runtime"]["engine"] == "bun"
    assert record["runtime"]["version"] == (ROOT / ".bun-version").read_text().strip()
    assert len(record["frames_ms"]) == len(record["steady_frames_ms"]) == 3
    assert record["heap_used"] > 0
    assert (record["width"], record["height"]) == (120, 40)


def test_failed_gc_writes_no_record(compiled_render: Path, tmp_path: Path) -> None:
    """A collector failure must not publish a successful heap reading.

    Parameters:
        compiled_render (Path): small compiled instrumentation fixture.
        tmp_path (Path): private HOME and output.
    """
    out = tmp_path / "render.jsonl"
    result = subprocess.run(
        [str(compiled_render), "failure"],
        env={"HOME": str(tmp_path), "HARNESS_PROBE_OUT": str(out)},
        check=False,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode != 0
    assert "collection failed" in result.stderr
    assert not out.exists()


def test_benchmark_make_runtime_identity() -> None:
    """Dry-run both runtime selections without launching benchmarks or touching startup scope."""
    make = shutil.which("make")
    assert make
    for runtime in ("node", "bun-standalone"):
        result = subprocess.check_output(
            [
                make,
                "-n",
                "-C",
                str(ROOT / "integration"),
                "bench",
                "STACK=stacks/personal.json",
                f"RUNTIME={runtime}",
            ],
            text=True,
            stderr=subprocess.STDOUT,
        )
        assert f'--runtime "{runtime}"' in result
        assert 'scenarios/bench --stack "stacks/personal.json"' in result
        assert "UPDATE_BASELINES" not in result
