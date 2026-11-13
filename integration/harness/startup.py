"""Measure launch-to-first-frame and input-ready latency of an installed `pi` in a real pane.

Unlike `scenarios/bench/test_startup.py`, this accepts an explicit installed `pi` and profile.
It loads a temporary local extension and submits only its nonce-bearing command, never a model
prompt. Use a synthetic sandbox when measuring without live-profile startup side effects.
Run with `uv run python -m harness.startup`, see `docs/startup-latency.md`.

`input_ready_s` requires acknowledgement from the command handler after the footer is drawn.
Screen echo alone, including a cooked tty echoing typed characters, proves no readiness.

References:
- Pi `PI_TIMING=1` startup phases: `packages/coding-agent/src/core/timings.ts` in the core fork
- tmux(1) `capture-pane`: https://man.openbsd.org/tmux.1
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import os
import platform
import re
import shutil
import statistics
import subprocess
import tempfile
import textwrap
import time
import uuid
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from harness.bench import REGRESSION_THRESHOLD
from harness.tmux import POLL_INTERVAL_S, TmuxPane

LOGGER = logging.getLogger(__name__)

SOCKET_ROOT = Path("/tmp")
SAMPLE_TIMEOUT_S = 60.0
READINESS_METHOD = "command-dispatch-v1"
READY_EXTENSION = textwrap.dedent("""\
import { writeFileSync } from "node:fs";
export default function startupReady(pi) {
    const nonce = process.env.PI_STARTUP_NONCE;
    pi.registerCommand(`harness-startup-ready-${nonce}`, {
        description: "No-provider startup readiness probe",
        handler: async (args) => {
            if (args !== nonce) throw new Error("Startup readiness nonce mismatch");
            writeFileSync(process.env.PI_STARTUP_ACK, nonce);
        },
    });
    writeFileSync(process.env.PI_STARTUP_REGISTERED, nonce);
}
""")
# Footer text of the owner's preset; override with `--frame-pattern` for another profile.
DEFAULT_FRAME_PATTERN = r"\bctx\b"
MILESTONES = ("first_paint_s", "frame_s", "input_ready_s")
SECTION = re.compile(r"^--- Startup Timings: (\w+) ---$")
PHASE = re.compile(r"^\s+(.*?): (\d+)ms$")
PACKAGE_PREFIX = re.compile(r".*/node_modules/")
STDERR_WRAPPER = '"$@" 2>"$PI_STARTUP_STDERR"'


def parse_timings(stderr: str) -> dict[str, int]:
    """Parse `PI_TIMING=1` output into `section:phase` -> milliseconds.

    Extension paths are shortened to the part after `node_modules/`, which drops the home directory.

    Parameters:
        stderr (str): captured stderr.

    Returns:
        dict[str, int]: phase durations, empty when no timing block was printed.
    """
    timings: dict[str, int] = {}
    section: str | None = None
    for line in stderr.splitlines():
        header = SECTION.match(line)
        if header:
            section = header.group(1)
            continue
        phase = PHASE.match(line)
        if phase and section:
            timings[f"{section}:{PACKAGE_PREFIX.sub('', phase.group(1))}"] = int(phase.group(2))
    return timings


def percentile(values: list[float], q: float) -> float:
    """Return the nearest-rank percentile.

    Parameters:
        values (list[float]): at least one sample.
        q (float): quantile in (0, 1].

    Returns:
        float: the sample at rank `ceil(q * n)`.

    Raises:
        ValueError: `values` is empty or `q` is outside (0, 1].
    """
    if not values or not 0 < q <= 1:
        raise ValueError(f"Need samples and `q` in (0, 1], got {len(values)} samples and q='{q}'")
    ordered = sorted(values)
    return ordered[math.ceil(q * len(ordered)) - 1]


def summarize(values: list[float]) -> dict[str, float]:
    """Reduce samples to count, median, p90, min and max.

    Parameters:
        values (list[float]): at least one sample.

    Returns:
        dict[str, float]: rounded to 4 places.

    Raises:
        ValueError: `values` is empty.
    """
    if not values:
        raise ValueError("Cannot summarize zero samples")
    return {
        "n": len(values),
        "median": round(statistics.median(values), 4),
        "p90": round(percentile(values, 0.9), 4),
        "min": round(min(values), 4),
        "max": round(max(values), 4),
    }


def scrubbed_env(base: dict[str, str]) -> dict[str, str]:
    """Drop inherited `PI_*` state so a nested session cannot attach to the caller's session.

    Parameters:
        base (dict[str, str]): environment to filter, usually `os.environ`.

    Returns:
        dict[str, str]: `base` without `PI_*` and `TMUX`, plus `PI_TIMING=1`.
    """
    env = {key: value for key, value in base.items() if not key.startswith("PI_") and key != "TMUX"}
    return env | {"PI_TIMING": "1"}


@dataclass(frozen=True)
class Sample:
    """One launch: seconds since process start for each milestone, plus `PI_TIMING` phases in ms."""

    first_paint_s: float
    frame_s: float
    input_ready_s: float
    timings: dict[str, int]


def _acknowledged(path: Path, nonce: str) -> bool:
    """Check a bounded nonce acknowledgement, treating an absent file as not yet ready.

    Parameters:
        path (Path): private fixture output.
        nonce (str): this launch's unpredictable token.

    Returns:
        bool: only an exact nonce, with no suffix or whitespace, matches.
    """
    try:
        with path.open() as stream:
            return stream.read(len(nonce) + 1) == nonce
    except FileNotFoundError:
        return False


def sample(
    argv: list[str],
    *,
    env: dict[str, str],
    frame_pattern: str = DEFAULT_FRAME_PATTERN,
    timeout_s: float = SAMPLE_TIMEOUT_S,
) -> Sample:
    """Launch `argv` once in a fresh pane and time its first frame and input readiness.

    Parameters:
        argv (list[str]): command to run, e.g. `["pi"]`.
        env (dict[str, str]): complete pane environment.
        frame_pattern (str): regex matching the footer once the UI is drawn.
        timeout_s (float): give up after this long.

    Returns:
        Sample: milestones and parsed phases.

    Raises:
        ValueError: `timeout_s` is not finite and positive.
        TimeoutError: the footer, command registration or dispatch acknowledgement never arrived.
    """
    if not math.isfinite(timeout_s) or timeout_s <= 0:
        raise ValueError("`timeout_s` must be finite and positive")
    frame = re.compile(frame_pattern, re.MULTILINE)
    scratch = Path(tempfile.mkdtemp(prefix="pis-", dir=SOCKET_ROOT))
    stderr_path = scratch / "stderr"
    workdir = scratch / "work"
    workdir.mkdir()
    pane = TmuxPane(socket=scratch / "pane.sock", name="startup")
    nonce = uuid.uuid4().hex
    extension = scratch / "ready.mjs"
    extension.write_text(READY_EXTENSION)
    registered = scratch / "registered"
    ack = scratch / "ack"
    marks: dict[str, float] = {}
    submitted = False
    try:
        started = time.monotonic()
        pane.start(
            ["/bin/sh", "-c", STDERR_WRAPPER, "sh", *argv, "-e", str(extension)],
            workdir,
            env
            | {
                "PI_STARTUP_STDERR": str(stderr_path),
                "PI_STARTUP_NONCE": nonce,
                "PI_STARTUP_REGISTERED": str(registered),
                "PI_STARTUP_ACK": str(ack),
            },
        )
        while time.monotonic() - started < timeout_s:
            screen = pane.capture()
            elapsed = time.monotonic() - started
            if screen.strip():
                marks.setdefault("first_paint_s", elapsed)
            if frame.search(screen):
                marks.setdefault("frame_s", elapsed)
            if "frame_s" in marks and not submitted and _acknowledged(registered, nonce):
                pane.type_text(f"/harness-startup-ready-{nonce} {nonce}")
                pane.send_keys("Escape")
                pane.send_keys("Enter")
                submitted = True
            if submitted and _acknowledged(ack, nonce):
                marks["input_ready_s"] = time.monotonic() - started
                break
            time.sleep(POLL_INTERVAL_S / 10)
        else:
            raise TimeoutError(f"No ready UI within {timeout_s}s, marks={marks}, submitted={submitted}")
        return Sample(**marks, timings=parse_timings(stderr_path.read_text(errors="replace")))
    finally:
        pane.kill()
        shutil.rmtree(scratch, ignore_errors=True)


def host_state() -> dict[str, Any]:
    """Describe the host for the record: OS, CPUs, load averages and power source.

    Returns:
        dict[str, Any]: `system`, `cpus`, `load`, `power`.
    """
    power = "unknown"
    if platform.system() == "Darwin":
        out = subprocess.run(["/usr/bin/pmset", "-g", "batt"], capture_output=True, text=True, check=False)
        power = out.stdout.splitlines()[0].strip() if out.stdout else power
    return {
        "system": platform.system().lower(),
        "cpus": os.cpu_count(),
        "load": [round(value, 2) for value in os.getloadavg()],
        "power": power,
    }


def run(
    variants: dict[str, list[str]],
    *,
    runs: int,
    gap_s: float,
    env: dict[str, str],
    frame_pattern: str = DEFAULT_FRAME_PATTERN,
) -> dict[str, Any]:
    """Sample every variant `runs` times, alternating their order each round.

    Parameters:
        variants (dict[str, list[str]]): label -> argv, e.g. wrapper vs direct core binary.
        runs (int): samples per variant, positive.
        gap_s (float): idle time before each sample; 0 is naturally warm, large is idle-gap.
        env (dict[str, str]): pane environment.
        frame_pattern (str): footer regex.

    Returns:
        dict[str, Any]: `host`, `runs`, `gap_s`, per-variant `summary` and raw `samples`.

    Raises:
        ValueError: `runs` is not positive.
    """
    if runs < 1:
        raise ValueError(f"`runs` must be positive, got '{runs}'")
    labels = list(variants)
    samples: dict[str, list[Sample]] = {label: [] for label in labels}
    for index in range(runs):
        for label in labels if index % 2 == 0 else reversed(labels):
            time.sleep(gap_s)
            samples[label].append(sample(variants[label], env=env, frame_pattern=frame_pattern))
    summary: dict[str, dict[str, Any]] = {}
    for label, rows in samples.items():
        summary[label] = {metric: summarize([getattr(row, metric) for row in rows]) for metric in MILESTONES}
        phases = sorted({key for row in rows for key in row.timings})
        summary[label]["phases_ms"] = {
            phase: summarize([float(row.timings[phase]) for row in rows if phase in row.timings])
            for phase in phases
        }
    return {
        "readiness_method": READINESS_METHOD,
        "host": host_state(),
        "runs": runs,
        "gap_s": gap_s,
        "summary": summary,
        "samples": {label: [asdict(row) for row in rows] for label, rows in samples.items()},
    }


def medians(report: dict[str, Any]) -> dict[str, dict[str, float]]:
    """Reduce a report to `label -> milestone -> median`, the shape stored as a baseline.

    Parameters:
        report (dict[str, Any]): output of `run`.

    Returns:
        dict[str, dict[str, float]]: milestone medians in seconds.
    """
    return {
        label: {metric: summary[metric]["median"] for metric in MILESTONES}
        for label, summary in report["summary"].items()
    }


def regressions(report: dict[str, Any], baseline: dict[str, Any]) -> list[str]:
    """List milestones whose median exceeds the baseline by more than `REGRESSION_THRESHOLD`.

    Labels or milestones absent from the baseline are reported, not skipped: a gate that passes
    because nothing was compared is worse than none.

    Parameters:
        report (dict[str, Any]): output of `run`.
        baseline (dict[str, Any]): versioned readiness method and recorded `medians`.

    Returns:
        list[str]: one message per problem, empty when within bounds.
    """
    if baseline.get("readiness_method") != READINESS_METHOD:
        return ["Incompatible readiness baseline: require command-dispatch-v1; preserve legacy echo history"]
    problems: list[str] = []
    for label, current in medians(report).items():
        recorded = baseline["medians"].get(label)
        if recorded is None:
            problems.append(f"No baseline for variant `{label}`")
            continue
        for metric, value in current.items():
            limit = recorded[metric] * (1 + REGRESSION_THRESHOLD)
            if value > limit:
                problems.append(
                    f"`{label}` `{metric}` regressed: {value:.3f}s > {limit:.3f}s "
                    f"(baseline {recorded[metric]:.3f}s + 20%)"
                )
    return problems


def main(argv: list[str] | None = None) -> int:
    """CLI: print one JSON report.

    Parameters:
        argv (list[str] | None): arguments, `sys.argv[1:]` when `None`.

    Returns:
        int: process exit status.
    """
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--runs", type=int, default=10)
    parser.add_argument("--gap", type=float, default=0.0, help="idle seconds before each sample")
    parser.add_argument("--frame-pattern", default=DEFAULT_FRAME_PATTERN)
    parser.add_argument("--output", type=Path, help="also write the JSON report here")
    parser.add_argument("--record", type=Path, help="write per-variant medians here as the new baseline")
    parser.add_argument("--baseline", type=Path, help="exit 1 when a median regressed past this baseline")
    parser.add_argument(
        "--env",
        action="append",
        default=[],
        metavar="KEY=VALUE",
        help="extra pane environment, e.g. PI_CODING_AGENT_DIR for a profile copy; repeatable",
    )
    parser.add_argument(
        "--variant",
        action="append",
        default=[],
        metavar="LABEL=COMMAND",
        help="e.g. wrapper=pi; repeatable, default `pi=pi`",
    )
    args = parser.parse_args(argv)
    variants: dict[str, list[str]] = {}
    for spec in args.variant or ["pi=pi"]:
        label, _, command = spec.partition("=")
        variants[label] = command.split()
    report = run(
        variants,
        runs=args.runs,
        gap_s=args.gap,
        env=scrubbed_env(dict(os.environ)) | dict(item.split("=", 1) for item in args.env),
        frame_pattern=args.frame_pattern,
    )
    text = json.dumps(report, indent=2, sort_keys=True)
    if args.output:
        args.output.write_text(text + "\n")
    print(text)
    if args.record:
        args.record.write_text(
            json.dumps(
                {"readiness_method": READINESS_METHOD, "medians": medians(report)}, indent=2, sort_keys=True
            )
            + "\n"
        )
    if args.baseline:
        problems = regressions(report, json.loads(args.baseline.read_text()))
        for problem in problems:
            LOGGER.error(problem)
        return 1 if problems else 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
