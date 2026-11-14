"""`harness.startup`: timing parser, statistics and the pane sampler against a fake `pi`."""

from __future__ import annotations

import json
import os
import runpy
import shutil
import subprocess
import sys
import tempfile
import textwrap
import time
from pathlib import Path
from typing import Any

import pytest

from harness import startup

# Pi emits timings before UI; this protocol stub is NOT native-Pi readiness proof.
# Native dispatch coverage lives in scenarios/test_startup.py.
FAKE_PI = textwrap.dedent("""\
import os,sys,time
from pathlib import Path
sys.stderr.write('--- Startup Timings: main ---\\n  TOTAL: 7ms\\n'
    '--- Startup Timings: extensions ---\\n  /h/node_modules/@a/b/index.ts module import: 3ms\\n')
sys.stderr.flush()
print('footer ctx 1%',flush=True)
if os.environ.get('CHILD_PID'):
    Path(os.environ['CHILD_PID']).write_text(str(os.getpid()))
time.sleep(0.1)
nonce = os.environ['PI_STARTUP_NONCE']
mode = os.environ.get('ACK_MODE', 'valid')
if mode != 'unregistered':
    Path(os.environ['PI_STARTUP_REGISTERED']).write_text(nonce)
line = sys.stdin.readline().replace('\\x1b', '').strip()
if mode != 'missing' and line == f'/harness-startup-ready-{nonce} {nonce}':
    Path(os.environ['PI_STARTUP_ACK']).write_text(nonce if mode == 'valid' else 'wrong-nonce')
time.sleep(30)
""")
TIMING_BLOCK = """\
--- Startup Timings: main ---
  parseArgs: 1ms
  TOTAL: 482ms
-----------------------------

--- Startup Timings: extensions ---
  /Users/x/.pi/agent/npm/node_modules/@nredd/pi-subagents/src/index.ts module import: 289ms
  stray: 5ms
"""


def test_parse_timings_allows_only_known_phases_and_explicit_fixture_aliases() -> None:
    """Untrusted stderr cannot put private paths or arbitrary labels in a timing report."""
    path = "/Users/x/.pi/agent/npm/node_modules/@nredd/pi-subagents/src/index.ts"
    assert startup.parse_timings(
        "  orphan: 9ms\n" + TIMING_BLOCK, extension_labels={path: "fixture-subagents"}
    ) == {
        "main:parseArgs": 1,
        "main:TOTAL": 482,
        "extensions:fixture-subagents module import": 289,
    }
    assert startup.parse_timings(TIMING_BLOCK) == {"main:parseArgs": 1, "main:TOTAL": 482}
    assert startup.parse_timings("no timings here") == {}
    assert startup.parse_timings("--- Startup Timings: main ---\n  TOTAL: 0ms") == {"main:TOTAL": 0}


@pytest.mark.parametrize(
    "stderr",
    [
        "x" * (64 * 1024 + 1),
        "\u00e9" * (32 * 1024 + 1),
        "\n" * 1025,
        "--- Startup Timings: main ---\n  TOTAL: 86400001ms",
        "--- Startup Timings: main ---\n  TOTAL: 1ms\n  TOTAL: 2ms",
        "--- Startup Timings: main ---\n  TOTAL: " + "9" * 20 + "ms",
    ],
)
def test_parse_timings_rejects_unbounded_or_ambiguous_records(stderr: str) -> None:
    """Bounds and duplicate guards fail closed without quoting the source text.

    Parameters:
        stderr (str): malformed synthetic timing stream.
    """
    with pytest.raises(ValueError, match="Startup timing"):
        startup.parse_timings(stderr)


@pytest.mark.parametrize(
    "labels",
    [
        {"/one": "private-name"},
        {"/one": "fixture-a", "/two": "fixture-a"},
        {"/one": "fixture-" + "a" * 65},
        {str(index): f"fixture-{index}" for index in range(129)},
    ],
)
def test_parse_timings_rejects_invalid_fixture_aliases(labels: dict[str, str]) -> None:
    """Aliases are bounded, synthetic and unique, never inferred from private paths.

    Parameters:
        labels (dict[str, str]): invalid explicit alias inventory.
    """
    with pytest.raises(ValueError, match="Startup timing"):
        startup.parse_timings("", extension_labels=labels)


def test_parse_timings_closes_sections_and_ignores_unknown_names() -> None:
    """Unknown sections, private labels and post-section log noise are not timing phases."""
    text = (
        "--- Startup Timings: main ---\n  TOTAL: 7ms\n-----------------------------\n"
        "  parseArgs: 8ms\n--- Startup Timings: private ---\n  TOTAL: 9ms\n"
        "--- Startup Timings: extensions ---\n  /secret/local.ts factory: 4ms\n"
        "  TOTAL: 4ms\n  /secret/unmapped.ts module import: 1ms\n"
        "--- Startup Timings: main ---\n  private label: 3ms\n  resourceLoader.reload: 2ms\n"
    )
    assert startup.parse_timings(text, extension_labels={"/secret/local.ts": "fixture-local"}) == {
        "main:TOTAL": 7,
        "extensions:fixture-local factory": 4,
        "extensions:TOTAL": 4,
        "main:resourceLoader.reload": 2,
    }


def test_percentile_and_summarize() -> None:
    """Nearest rank: p90 of ten samples is the ninth."""
    values = [float(n) for n in range(1, 11)]
    assert startup.percentile(values, 0.9) == 9.0
    assert startup.summarize(values) == {"n": 10, "median": 5.5, "p90": 9.0, "min": 1.0, "max": 10.0}
    for bad in (0.0, 1.5):
        with pytest.raises(ValueError, match="q="):
            startup.percentile(values, bad)
    with pytest.raises(ValueError, match="0 samples"):
        startup.percentile([], 0.5)
    with pytest.raises(ValueError, match="zero samples"):
        startup.summarize([])


def test_scrubbed_env_drops_inherited_pi_state() -> None:
    """A nested pi must not inherit the caller's session, but `PI_TIMING` is forced on."""
    env = startup.scrubbed_env({"PI_SESSION_FILE": "x", "PI_TIMING": "0", "TMUX": "t", "HOME": "/h"})
    assert env == {"HOME": "/h", "PI_TIMING": "1"}


def test_sample_times_first_frame_and_input_ready() -> None:
    """An early footer cannot finish readiness before registration and command acknowledgement."""
    result = startup.sample(
        [sys.executable, "-c", FAKE_PI], env=startup.scrubbed_env({"PATH": "/usr/bin:/bin"})
    )
    assert 0 < result.first_paint_s <= result.frame_s <= result.input_ready_s
    assert result.timings == {"main:TOTAL": 7}
    result = startup.sample(
        [sys.executable, "-c", FAKE_PI],
        env=startup.scrubbed_env({"PATH": "/usr/bin:/bin"}),
        extension_labels={"/h/node_modules/@a/b/index.ts": "fixture-faux"},
    )
    assert result.timings == {"main:TOTAL": 7, "extensions:fixture-faux module import": 3}


def test_sample_times_out_without_a_footer() -> None:
    """A pi that never draws the footer fails loudly instead of hanging."""
    with pytest.raises(TimeoutError, match="No ready UI"):
        startup.sample([sys.executable, "-c", "import time; time.sleep(5)"], env={}, timeout_s=0.3)


def test_run_alternates_variant_order_and_summarizes(monkeypatch: pytest.MonkeyPatch) -> None:
    """Order flips each round so a systematic first-launch penalty hits both variants equally."""
    order: list[str] = []

    def fake_sample(argv: list[str], **kwargs: object) -> startup.Sample:
        order.append(argv[0])
        assert kwargs["extension_labels"] == {"/a": "fixture-a"}
        return startup.Sample(0.1, 0.2, 0.3, {"main:TOTAL": 5})

    monkeypatch.setattr(startup, "sample", fake_sample)
    report = startup.run(
        {"a": ["a"], "b": ["b"]}, runs=3, gap_s=0.0, env={}, extension_labels={"/a": "fixture-a"}
    )
    assert order == ["a", "b", "b", "a", "a", "b"]
    assert report["readiness_method"] == startup.READINESS_METHOD
    assert report["summary"]["a"]["input_ready_s"]["median"] == 0.3
    assert report["summary"]["b"]["phases_ms"]["main:TOTAL"]["max"] == 5.0
    with pytest.raises(ValueError, match="positive"):
        startup.run({"a": ["a"]}, runs=0, gap_s=0.0, env={})


def test_host_state_reports_load_and_power(monkeypatch: pytest.MonkeyPatch) -> None:
    """Darwin asks `pmset`; other systems say `unknown`."""
    monkeypatch.setattr(startup.platform, "system", lambda: "Darwin")
    monkeypatch.setattr(
        startup.subprocess,
        "run",
        lambda *_, **__: type("R", (), {"stdout": "Now drawing from 'AC Power'\n -InternalBattery"})(),
    )
    assert startup.host_state()["power"] == "Now drawing from 'AC Power'"
    monkeypatch.setattr(startup.subprocess, "run", lambda *_, **__: type("R", (), {"stdout": ""})())
    assert startup.host_state()["power"] == "unknown"
    monkeypatch.setattr(startup.platform, "system", lambda: "Linux")
    state = startup.host_state()
    assert state["power"] == "unknown"
    assert state["system"] == "linux"
    assert len(state["load"]) == 3


def test_main_writes_json_report(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """`--variant` splits LABEL=COMMAND; the report is printed and written."""
    seen: dict[str, Any] = {}

    def fake_run(variants: dict[str, list[str]], **kwargs: object) -> dict[str, Any]:
        seen.update(variants=variants, **kwargs)
        return {"ok": True}

    monkeypatch.setattr(startup, "run", fake_run)
    out = tmp_path / "r.json"
    assert (
        startup.main(["--runs", "2", "--variant", "w=pi -x", "--env", "PI_X=a=b", "--output", str(out)]) == 0
    )
    assert seen["env"]["PI_X"] == "a=b"
    assert seen["variants"] == {"w": ["pi", "-x"]}
    assert seen["runs"] == 2
    assert json.loads(out.read_text()) == {"ok": True}
    assert json.loads(capsys.readouterr().out) == {"ok": True}
    assert startup.main([]) == 0
    assert seen["variants"] == {"pi": ["pi"]}
    assert startup.main(["--extension-label", "fixture-faux=/fixture/faux.ts"]) == 0
    assert seen["extension_labels"] == {"/fixture/faux.ts": "fixture-faux"}


@pytest.mark.parametrize("aliases", [["missing"], ["fixture-a="], ["fixture-a=/a", "fixture-b=/a"]])
def test_main_rejects_ambiguous_alias_inventory(aliases: list[str]) -> None:
    """Reject invalid alias syntax and duplicate paths before launching a child.

    Parameters:
        aliases (list[str]): malformed CLI fixture mappings.
    """
    argv = [part for alias in aliases for part in ("--extension-label", alias)]
    with pytest.raises(SystemExit) as raised:
        startup.main(argv)
    assert raised.value.code == 2


def test_sample_rejects_oversized_phase_output_and_cleans_scratch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Exercise the bounded file read at the real sample boundary, not just the parser.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): replace only the private pane transport.
    """
    scratch: list[Path] = []

    class Pane:
        """A deterministic pane producing oversized stderr and a real nonce acknowledgement."""

        def __init__(self, *, socket: Path, name: str) -> None:
            """Record the sampler's real scratch directory.

            Parameters:
                socket (Path): private sampler socket.
                name (str): sampler pane name.
            """
            scratch.append(socket.parent)

        def start(self, argv: list[str], cwd: Path, env: dict[str, str]) -> None:
            """Write synthetic output using the actual sampler environment.

            Parameters:
                argv (list[str]): unused synthetic command.
                cwd (Path): unused synthetic working directory.
                env (dict[str, str]): sampler's private paths and nonce.
            """
            Path(env["PI_STARTUP_STDERR"]).write_text("x" * (startup.MAX_TIMING_BYTES + 100))
            Path(env["PI_STARTUP_REGISTERED"]).write_text(env["PI_STARTUP_NONCE"])
            Path(env["PI_STARTUP_ACK"]).write_text(env["PI_STARTUP_NONCE"])

        def capture(self) -> str:
            """Make the existing frame gate pass.

            Returns:
                str: synthetic footer.
            """
            return "footer ctx 1%"

        def type_text(self, text: str) -> None:
            """Accept the sampler's no-provider command without real input.

            Parameters:
                text (str): submitted probe command.
            """

        def send_keys(self, *keys: str) -> None:
            """Keep terminal input entirely synthetic.

            Parameters:
                *keys (str): synthetic terminal input.
            """

        def kill(self) -> None:
            """There is no child process in this file-boundary fixture."""

    monkeypatch.setattr(startup, "TmuxPane", Pane)
    with pytest.raises(ValueError, match="byte limit"):
        startup.sample(["offline-fixture"], env={})
    assert scratch
    assert all(not path.exists() for path in scratch)


REPORT: dict[str, Any] = {
    "summary": {"a": {m: {"median": 1.0} for m in startup.MILESTONES}},
}


def baseline(value: float) -> dict[str, Any]:
    """Build a compatible command-dispatch baseline at a fixed milestone value.

    Parameters:
        value (float): all milestone medians, in seconds.

    Returns:
        dict[str, Any]: method-tagged fixture baseline.
    """
    return {
        "readiness_method": startup.READINESS_METHOD,
        "medians": {"a": dict.fromkeys(startup.MILESTONES, value)},
    }


def test_regressions_flag_slow_missing_and_unbaselined() -> None:
    """Within 20% passes; beyond it, or with nothing to compare, fails."""
    assert startup.medians(REPORT) == {"a": dict.fromkeys(startup.MILESTONES, 1.0)}
    assert startup.regressions(REPORT, baseline(1.0)) == []
    assert startup.regressions(REPORT, baseline(0.84)) == []
    slow = startup.regressions(REPORT, baseline(0.8))
    assert len(slow) == len(startup.MILESTONES)
    assert "`a` `first_paint_s` regressed: 1.000s > 0.960s" in slow[0]
    assert startup.regressions(REPORT, baseline(1.0) | {"medians": {}}) == ["No baseline for variant `a`"]
    assert "Incompatible readiness baseline" in startup.regressions(REPORT, {})[0]


def test_main_records_and_checks_a_baseline(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """`--record` writes medians; `--baseline` turns a regression into exit 1."""
    monkeypatch.setattr(startup, "run", lambda *_, **__: REPORT)
    recorded = tmp_path / "base.json"
    assert startup.main(["--record", str(recorded)]) == 0
    assert json.loads(recorded.read_text()) == baseline(1.0)
    assert startup.main(["--baseline", str(recorded)]) == 0
    recorded.write_text(json.dumps({"other": dict.fromkeys(startup.MILESTONES, 1.0)}))
    assert startup.main(["--baseline", str(recorded)]) == 1


def test_module_entrypoint_exits_with_main_status(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """`python -m harness.startup` runs one real sample against a fake `pi` and exits 0."""
    fake = tmp_path / "fake_pi.py"
    fake.write_text(FAKE_PI)
    monkeypatch.setattr(
        sys, "argv", ["harness.startup", "--runs", "1", "--variant", f"x={sys.executable} {fake}"]
    )
    with pytest.raises(SystemExit) as raised:
        runpy.run_module("harness.startup", run_name="__main__")
    assert raised.value.code == 0


@pytest.mark.parametrize("mode", ["valid", "unregistered", "missing", "malformed"])
def test_missing_or_malformed_ack_cleans_process_and_scratch(
    tmp_path: Path, mode: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Check readiness verdicts and cleanup independently of screen echo.

    Parameters:
        tmp_path (Path): private PID marker directory.
        mode (str): stub registration/acknowledgement behavior.
        monkeypatch (pytest.MonkeyPatch): tracks the sampler's scratch allocation.
    """
    pid_file = tmp_path / "pid"
    created: list[Path] = []
    original = tempfile.mkdtemp

    def tracked_mkdtemp(**kwargs: Any) -> str:
        """Record the real short socket directory without extending its path.

        Parameters:
            **kwargs (Any): original `mkdtemp` arguments.

        Returns:
            str: allocated socket directory.
        """
        directory = original(**kwargs)
        created.append(Path(directory))
        return directory

    monkeypatch.setattr(startup.tempfile, "mkdtemp", tracked_mkdtemp)
    argv = [sys.executable, "-c", FAKE_PI]
    env = {"ACK_MODE": mode, "CHILD_PID": str(pid_file)}
    if mode == "valid":
        startup.sample(argv, env=env)
    else:
        with pytest.raises(TimeoutError, match="No ready UI"):
            startup.sample(argv, env=env, timeout_s=0.5)
    assert created
    assert all(not directory.exists() for directory in created)
    pid = int(pid_file.read_text())
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            break
        time.sleep(0.01)
    else:
        pytest.fail("Sampler left its pane process alive")


def test_cooked_echo_is_not_ready() -> None:
    """A process with no command handler fails even if the tty echoes all typed input."""
    cooked = "import sys,time; print('footer ctx 1%',flush=True); sys.stdin.readline(); time.sleep(5)"
    with pytest.raises(TimeoutError, match="submitted=False"):
        startup.sample([sys.executable, "-c", cooked], env={}, timeout_s=0.3)


@pytest.mark.parametrize("timeout", [0.0, -1.0, float("nan"), float("inf")])
def test_invalid_timeout_is_rejected(timeout: float) -> None:
    """Reject invalid timeouts before allocating a pane.

    Parameters:
        timeout (float): invalid deadline interval.
    """
    with pytest.raises(ValueError, match="finite and positive"):
        startup.sample([], env={}, timeout_s=timeout)


def test_readiness_handler_rejects_wrong_nonce(tmp_path: Path) -> None:
    """Exercise the exact shipped JS handler; only a matching argument writes an ack.

    Parameters:
        tmp_path (Path): private extension and acknowledgement directory.
    """
    node = shutil.which("node")
    assert node is not None
    extension = tmp_path / "ready.mjs"
    extension.write_text(startup.READY_EXTENSION)
    ack = tmp_path / "ack"
    registered = tmp_path / "registered"
    script = textwrap.dedent("""\
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const { default: install } = await import(pathToFileURL(process.argv[1]).href);
let handler;
install({registerCommand(name, command) {
    if (name !== 'harness-startup-ready-token') throw new Error('Wrong command name');
    handler = command.handler;
}});
if (readFileSync(process.env.PI_STARTUP_REGISTERED, 'utf8') !== 'token') throw new Error('No registration');
try { await handler('malformed'); throw new Error('Accepted bad nonce'); }
catch (error) { if (error.message !== 'Startup readiness nonce mismatch') throw error; }
if (existsSync(process.env.PI_STARTUP_ACK)) throw new Error('Bad nonce acknowledged');
await handler('token');
if (readFileSync(process.env.PI_STARTUP_ACK, 'utf8') !== 'token') throw new Error('No ack');
""")
    subprocess.run(
        [node, "--input-type=module", "-e", script, str(extension)],
        env={
            "PI_STARTUP_NONCE": "token",
            "PI_STARTUP_ACK": str(ack),
            "PI_STARTUP_REGISTERED": str(registered),
        },
        check=True,
        capture_output=True,
        timeout=10,
    )
