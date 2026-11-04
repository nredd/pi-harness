"""Unit coverage for the dev-tools, session-kit and router stock-Pi scenarios and their Pi plumbing.

The real scenarios need stock Pi and run through `make check-package-contracts`. Here `run_pi` and the
provider are replaced by scripted doubles, so every contract violation each scenario rejects is driven
deterministically: no Pi, no network, no wall-clock waits, and no signal to any process.

References:
    https://docs.pytest.org/en/stable/how-to/monkeypatch.html
"""

from __future__ import annotations

import json
import sys
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Literal

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from contract_helpers import StubProvider, make_context
from test_package_contracts import make_tarball

import faux_provider as fp
import package_contracts as pc

DEV_TOOLS, SESSION_KIT, ROUTER = pc.CONTRACTS
SECRET = "ab" * 16
INTEGRITY = "sha512-" + "A" * 86 + "=="


def tool_event(
    name: str, text: str = "", *, is_error: bool = False, structured: dict[str, Any] | None = None
) -> dict[str, Any]:
    """Build a `tool_execution_end` event.

    Parameters:
        name (str): Tool name.
        text (str): Result text.
        is_error (bool): The event's `isError` flag.
        structured (dict[str, Any] | None): `result.structuredContent`, omitted when `None`.

    Returns:
        dict[str, Any]: The event.
    """
    result: dict[str, Any] = {"content": [{"type": "text", "text": text}]}
    if structured is not None:
        result["structuredContent"] = structured
    return {"type": "tool_execution_end", "toolName": name, "isError": is_error, "result": result}


def assistant_event(provider: str, model: str, stop: str = "stop") -> dict[str, Any]:
    """Build a finished assistant `message_end` event.

    Parameters:
        provider (str): Serving provider.
        model (str): Serving model.
        stop (str): `stopReason`.

    Returns:
        dict[str, Any]: The event.
    """
    message = {"role": "assistant", "provider": provider, "model": model, "stopReason": stop}
    return {"type": "message_end", "message": message}


def pi_run(*events: dict[str, Any], returncode: int = 0, stdout: str = "", stderr: str = "") -> pc.PiRun:
    """Build a canned stock-Pi result.

    Parameters:
        *events (dict[str, Any]): Parsed JSON-mode events.
        returncode (int): Exit code.
        stdout (str): Raw stdout.
        stderr (str): Raw stderr.

    Returns:
        pc.PiRun: The result.
    """
    return pc.PiRun(returncode, events, stdout, stderr)


class ScriptedPi:
    """`run_pi` double that returns canned results in order and records each call."""

    def __init__(self, runs: Sequence[pc.PiRun]) -> None:
        """Queue `runs`.

        Parameters:
            runs (Sequence[pc.PiRun]): Results, one per expected call.
        """
        self.runs = list(runs)
        self.calls: list[tuple[Path, Path, list[str], dict[str, object]]] = []

    def __call__(
        self,
        _pi_bin: Path,
        _sandbox: pc.Sandbox,
        package: Path,
        cwd: Path,
        extra: Sequence[str],
        **kwargs: object,
    ) -> pc.PiRun:
        """Record the call and return the next canned result.

        Parameters:
            _pi_bin (Path): Ignored `pi` path.
            _sandbox (pc.Sandbox): Ignored environment.
            package (Path): Loaded package or wrapper.
            cwd (Path): Run directory.
            extra (Sequence[str]): Remaining Pi arguments.
            **kwargs (object): `session_dir` and `trust`.

        Returns:
            pc.PiRun: The next queued result.
        """
        self.calls.append((package, cwd, list(extra), kwargs))
        return self.runs.pop(0)


class Providers:
    """`Context.provider_session` double handing out one stub provider and recording each script."""

    def __init__(self, provider: StubProvider) -> None:
        """Hand out `provider`.

        Parameters:
            provider (StubProvider): Provider every session yields.
        """
        self.provider = provider
        self.scripts: list[list[fp.Step]] = []

    def __call__(self, _ctx: pc.Context, script: Sequence[fp.Step], _routes: object = ()) -> StubProvider:
        """Record `script` and return the stub.

        Parameters:
            _ctx (pc.Context): Ignored scenario context.
            script (Sequence[fp.Step]): Scripted turns.
            _routes (object): Ignored routes.

        Returns:
            StubProvider: The stub provider.
        """
        self.scripts.append(list(script))
        return self.provider


def install(
    monkeypatch: pytest.MonkeyPatch, runs: Sequence[pc.PiRun], provider: StubProvider
) -> tuple[ScriptedPi, Providers]:
    """Replace `run_pi` and the provider session.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): Substitutions.
        runs (Sequence[pc.PiRun]): Canned Pi results in call order.
        provider (StubProvider): Provider the scenario sees.

    Returns:
        tuple[ScriptedPi, Providers]: The installed doubles.
    """
    pi, providers = ScriptedPi(runs), Providers(provider)
    monkeypatch.setattr(pc, "run_pi", pi)
    # A plain function, so attribute lookup binds the scenario's `Context` like the real method.
    monkeypatch.setattr(
        pc.Context, "provider_session", lambda ctx, script, routes=(): providers(ctx, script, routes)
    )
    return pi, providers


# --- run_pi and Context ---------------------------------------------------------------------------


def stub_pi(path: Path) -> Path:
    """Write a stub `pi` that prints its argv as one JSON event, warns on stderr and exits 3.

    Parameters:
        path (Path): Destination.

    Returns:
        Path: The executable.
    """
    path.write_text(
        f"#!{sys.executable}\n"
        "import json, sys\n"
        "print(json.dumps({'type': 'argv', 'argv': sys.argv[1:]}))\n"
        "sys.stderr.write('warned')\n"
        "sys.exit(3)\n"
    )
    path.chmod(0o755)
    return path


def test_run_pi_passes_only_safe_flags_and_parses_json_mode(tmp_path: Path) -> None:
    """A JSON-mode run carries the session dir and trust decision; its nonzero exit is returned, not raised.

    Parameters:
        tmp_path (Path): Scratch root.
    """
    pi_bin = stub_pi(tmp_path / "pi")
    sandbox = pc.Sandbox(tmp_path / "sandbox", pc.locate_tools())
    sessions = tmp_path / "sessions"
    result = pc.run_pi(
        pi_bin,
        sandbox,
        tmp_path / "pkg",
        tmp_path,
        ["--mode", "json", "go"],
        session_dir=sessions,
        trust="approve",
    )
    assert (result.returncode, result.stderr) == (3, "warned")
    assert result.events == (
        {
            "type": "argv",
            "argv": [
                "--offline",
                "--approve",
                "--no-mcp",
                "--no-extensions",
                "--extension",
                str(tmp_path / "pkg"),
                "--no-skills",
                "--no-prompt-templates",
                "--no-themes",
                "--no-context-files",
                "--session-dir",
                str(sessions),
                "--mode",
                "json",
                "go",
            ],
        },
    )


def test_run_pi_defaults_to_no_session_and_skips_parsing_outside_json_mode(tmp_path: Path) -> None:
    """Without `--mode` stdout stays raw text; the default run is in-memory and untrusted.

    Parameters:
        tmp_path (Path): Scratch root.
    """
    pi_bin = stub_pi(tmp_path / "pi")
    sandbox = pc.Sandbox(tmp_path / "sandbox", pc.locate_tools())
    result = pc.run_pi(pi_bin, sandbox, tmp_path / "pkg", tmp_path, ["--list-models", "router"])
    assert result.events == ()
    argv = json.loads(result.stdout)["argv"]
    assert argv[1] == "--no-approve"
    assert argv[-3:] == ["--no-session", "--list-models", "router"]


def test_provider_session_registers_the_live_provider(tmp_path: Path) -> None:
    """`models.json` points stock Pi at the loopback provider the session returns.

    Parameters:
        tmp_path (Path): Scratch root.
    """
    ctx = make_context(tmp_path, DEV_TOOLS, "1.0.0")
    with ctx.provider_session([fp.TextStep("x")]) as provider:
        registered = json.loads((ctx.sandbox.agent_dir / "models.json").read_text())
        assert registered == json.loads(fp.models_json(provider.base_url, pc.PROVIDER, (pc.PHYSICAL_MODEL,)))
    assert provider.requests == []


def test_context_git_runs_in_the_repository(tmp_path: Path) -> None:
    """`Context.git` targets the given repository and fails loudly on a git error.

    Parameters:
        tmp_path (Path): Scratch root.
    """
    ctx = make_context(tmp_path, DEV_TOOLS, "1.0.0")
    repo = tmp_path / "repo"
    repo.mkdir()
    ctx.git(repo, "init", "-q", "-b", "main")
    assert (repo / ".git" / "HEAD").read_text() == "ref: refs/heads/main\n"
    with pytest.raises(pc.ContractError, match="exited"):
        ctx.git(repo, "rev-parse", "--verify", "HEAD")


def test_host_platform_is_sys_platform(monkeypatch: pytest.MonkeyPatch) -> None:
    """The seam reports the interpreter's platform, whatever it is.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): Platform override.
    """
    monkeypatch.setattr(sys, "platform", "sunos5")
    assert pc.host_platform() == "sunos5"


# --- dev-tools ------------------------------------------------------------------------------------


def git_status_runs(
    *, failed: bool = False, untracked: list[str] | None = None, outside_error: bool = True
) -> list[pc.PiRun]:
    """Build the in-repo and outside-repo `git_status` runs.

    Parameters:
        failed (bool): Make the in-repo call an error result.
        untracked (list[str] | None): Reported untracked files; defaults to the scenario's file.
        outside_error (bool): Whether the outside-repo call is an error result.

    Returns:
        list[pc.PiRun]: The two runs.
    """
    status = {"untracked": ["untracked.txt"] if untracked is None else untracked}
    return [
        pi_run(tool_event("git_status", "status", is_error=failed, structured=status)),
        pi_run(tool_event("git_status", "fatal: not a git repository", is_error=outside_error)),
    ]


def drive_dev_tools(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, runs: list[pc.PiRun]
) -> pc.DevToolsEvidence:
    """Run `scenario_dev_tools` with a real git repository and canned Pi runs.

    Parameters:
        tmp_path (Path): Scratch root.
        monkeypatch (pytest.MonkeyPatch): Substitutions.
        runs (list[pc.PiRun]): Canned `git_status` runs.

    Returns:
        pc.DevToolsEvidence: The scenario's evidence.
    """
    ctx = make_context(tmp_path, DEV_TOOLS, "1.0.0")
    published = SimpleNamespace(tarball="https://registry.example/x.tgz", integrity=INTEGRITY)
    monkeypatch.setattr(pc, "exercise_resource_snapshot", lambda _ctx: ("rss", "process_limit 51 refused"))
    monkeypatch.setattr(pc, "published_sampler_dist", lambda _sandbox, _cwd: published)
    monkeypatch.setattr(pc, "installed_sampler_integrity", lambda _installed, dist: dist.integrity)
    pi, providers = install(monkeypatch, runs, StubProvider(["git_status"]))
    evidence = pc.scenario_dev_tools(ctx)
    assert [call[1] for call in pi.calls] == [ctx.work / "repo", ctx.work / "not-a-repo"]
    assert (ctx.work / "repo" / ".git").is_dir()
    assert (ctx.work / "repo" / "untracked.txt").read_text() == "x\n"
    assert providers.scripts == [[fp.ToolStep("git_status"), fp.TextStep("done")]] * 2
    return evidence


def test_dev_tools_scenario_records_status_and_failure_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A clean status inside the repo and an error result outside it yield the evidence shape.

    Parameters:
        tmp_path (Path): Scratch root.
        monkeypatch (pytest.MonkeyPatch): Substitutions.
    """
    assert drive_dev_tools(tmp_path, monkeypatch, git_status_runs()) == {
        "tool": "git_status",
        "untracked": ["untracked.txt"],
        "failure_path": "fatal: not a git repository",
        "resource_ranking": "rss",
        "resource_sampler_integrity": INTEGRITY,
        "resource_failure_path": "process_limit 51 refused",
    }


@pytest.mark.parametrize(
    ("runs", "message"),
    [
        (git_status_runs(failed=True), "git_status failed: status"),
        (git_status_runs(untracked=[]), "unexpected status"),
        (git_status_runs(outside_error=False), "outside a repository must be an error result"),
        ([pi_run(returncode=1, stderr="crash"), *git_status_runs()[1:]], "dev-tools git_status: pi exited 1"),
    ],
    ids=["tool-error", "wrong-untracked", "outside-succeeds", "crash"],
)
def test_dev_tools_scenario_rejects(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, runs: list[pc.PiRun], message: str
) -> None:
    """Each violated `git_status` expectation fails with its own message.

    Parameters:
        tmp_path (Path): Scratch root.
        monkeypatch (pytest.MonkeyPatch): Substitutions.
        runs (list[pc.PiRun]): Canned runs carrying one violation.
        message (str): Expected failure.
    """
    with pytest.raises(pc.ContractError, match=message):
        drive_dev_tools(tmp_path, monkeypatch, runs)


# --- resource_snapshot ----------------------------------------------------------------------------


def snapshot_entry(*, measured: bool = True, **extra: object) -> dict[str, object]:
    """Build one projected `resource_snapshot` process entry.

    Parameters:
        measured (bool): Whether its interval CPU is available.
        **extra (object): Fields to add or replace.

    Returns:
        dict[str, object]: The entry.
    """
    cpu = {"state": "available" if measured else "unavailable"}
    return {"pid": 7, "parentPid": 1, "cpu": cpu, "rssBytes": 1024, "executable": "node"} | extra


def snapshot_runs(
    *,
    ranking: str = "interval-cpu",
    entries: object = None,
    processes: dict[str, object] | None = None,
    sampled: object = 1,
    text: str = "snapshot",
    failed: bool = False,
    refused: bool = True,
) -> list[pc.PiRun]:
    """Build the in-bounds and out-of-bounds `resource_snapshot` runs.

    Parameters:
        ranking (str): Reported ranking.
        entries (object): Process entries; defaults to one measured entry.
        processes (dict[str, object] | None): Whole `processes` payload, overriding the other fields.
        sampled (object): `coverage.sampled`.
        text (str): In-bounds result text.
        failed (bool): Make the in-bounds call an error result.
        refused (bool): Whether the `process_limit` 51 call is an error result.

    Returns:
        list[pc.PiRun]: The two runs.
    """
    payload = processes or {
        "status": "available",
        "entries": [snapshot_entry()] if entries is None else entries,
        "coverage": {"sampled": sampled},
        "ranking": ranking,
    }
    return [
        pi_run(tool_event("resource_snapshot", text, is_error=failed, structured={"processes": payload})),
        pi_run(tool_event("resource_snapshot", "process_limit 51 refused", is_error=refused)),
    ]


def drive_snapshot(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, runs: list[pc.PiRun], platform: str = "linux"
) -> tuple[str, str]:
    """Run `exercise_resource_snapshot` with an inert marker and canned Pi runs.

    The marker double has a pid but no process behind it, so nothing is spawned or signalled.

    Parameters:
        tmp_path (Path): Scratch root.
        monkeypatch (pytest.MonkeyPatch): Substitutions.
        runs (list[pc.PiRun]): Canned snapshot runs.
        platform (str): Host platform the scenario sees.

    Returns:
        tuple[str, str]: The expected ranking and the refusal text.
    """
    ctx = make_context(tmp_path, DEV_TOOLS, "1.0.0")
    discovered: list[tuple[int, str]] = []

    @contextmanager
    def marker(_ctx: pc.Context, project: Path, secret: str) -> Iterator[SimpleNamespace]:
        """Yield an inert marker in the scenario's project.

        Parameters:
            _ctx (pc.Context): Ignored scenario context.
            project (Path): Scenario project directory.
            secret (str): Marker secret.

        Yields:
            SimpleNamespace: Object with the marker's `pid`.
        """
        assert (project, secret) == (ctx.work / "resource", SECRET)
        yield SimpleNamespace(pid=4242)

    monkeypatch.setattr(pc.secrets, "token_hex", lambda _n: SECRET)
    monkeypatch.setattr(pc, "start_hostile_child", marker)
    monkeypatch.setattr(
        pc, "discover_child_with_installed_sampler", lambda _c, pid, s: discovered.append((pid, s))
    )
    monkeypatch.setattr(pc, "host_platform", lambda: platform)
    _pi, providers = install(monkeypatch, runs, StubProvider(["resource_snapshot"]))
    result = pc.exercise_resource_snapshot(ctx)
    assert discovered == [(4242, SECRET)]
    assert [script[0] for script in providers.scripts] == [
        fp.ToolStep("resource_snapshot", {"process_limit": 50, "interval_ms": 300}),
        fp.ToolStep("resource_snapshot", {"process_limit": 51}),
    ]
    return result


@pytest.mark.parametrize(
    ("platform", "measured", "expected"),
    [
        ("linux", True, "interval-cpu"),
        ("linux", False, "interval-cpu"),
        ("darwin", True, "interval-cpu"),
        ("darwin", False, "rss"),
    ],
)
def test_resource_snapshot_ranking_follows_platform_and_measurement(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, platform: str, *, measured: bool, expected: str
) -> None:
    """Linux always ranks by interval CPU; Darwin only once a CPU sample was measured, else by RSS.

    Parameters:
        tmp_path (Path): Scratch root.
        monkeypatch (pytest.MonkeyPatch): Substitutions.
        platform (str): Host platform.
        measured (bool): Whether the entry's CPU was measured.
        expected (str): Required ranking.
    """
    runs = snapshot_runs(ranking=expected, entries=[snapshot_entry(measured=measured)])
    assert drive_snapshot(tmp_path, monkeypatch, runs, platform) == (expected, "process_limit 51 refused")


@pytest.mark.parametrize(
    ("runs", "message"),
    [
        (snapshot_runs(failed=True), "resource_snapshot failed"),
        (snapshot_runs(text=f"argv0 {SECRET[:12]}"), "exposes the marker"),
        (snapshot_runs(processes={"status": "unavailable"}), "has no process metadata"),
        (snapshot_runs(entries={"not": "a list"}), "entries or coverage malformed"),
        (snapshot_runs(sampled="1"), "entries or coverage malformed"),
        (snapshot_runs(entries=[]), "0 entries is not the 50-bounded projection of 1 sampled"),
        (snapshot_runs(entries=[snapshot_entry(cmdline="x")]), "unexpected fields"),
        (snapshot_runs(entries=[snapshot_entry(parentPid="1")]), "unexpected fields"),
        (snapshot_runs(ranking="rss"), "ranking 'rss' is not 'interval-cpu' on linux"),
        (snapshot_runs(refused=False), "process_limit 51 must be an error result"),
    ],
    ids=[
        "tool-error",
        "leak",
        "unavailable",
        "entries-not-list",
        "sampled-not-int",
        "empty",
        "extra-field",
        "parent-not-int",
        "ranking",
        "limit-accepted",
    ],
)
def test_resource_snapshot_rejects(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, runs: list[pc.PiRun], message: str
) -> None:
    """Each violated snapshot expectation fails with its own message.

    Parameters:
        tmp_path (Path): Scratch root.
        monkeypatch (pytest.MonkeyPatch): Substitutions.
        runs (list[pc.PiRun]): Canned runs carrying one violation.
        message (str): Expected failure.
    """
    with pytest.raises(pc.ContractError, match=message):
        drive_snapshot(tmp_path, monkeypatch, runs)


@pytest.mark.parametrize(("comm", "shows"), [(SECRET[:15], True), ("node", False)])
def test_legacy_name_reads_linux_comm(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, comm: str, *, shows: bool
) -> None:
    """Linux compares the 15-byte `/proc/PID/comm` with the secret's prefix.

    Parameters:
        tmp_path (Path): Scratch root holding a fake procfs.
        monkeypatch (pytest.MonkeyPatch): Platform and procfs seams.
        comm (str): The child's comm.
        shows (bool): Expected answer.
    """
    (tmp_path / "proc" / "4242").mkdir(parents=True)
    (tmp_path / "proc" / "4242" / "comm").write_text(f"{comm}\n")
    monkeypatch.setattr(pc, "host_platform", lambda: "linux")
    monkeypatch.setattr(pc, "PROC_ROOT", tmp_path / "proc")
    assert pc.legacy_name_shows(make_context(tmp_path, DEV_TOOLS, "1.0.0"), 4242, SECRET) is shows


@pytest.mark.parametrize(("listed", "shows"), [(f"{SECRET}\n", True), ("node\n", False)])
def test_legacy_name_reads_darwin_ps_comm(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, listed: str, *, shows: bool
) -> None:
    """Darwin asks `/bin/ps -c` for the comm of exactly that pid, in a C locale.

    Parameters:
        tmp_path (Path): Scratch root.
        monkeypatch (pytest.MonkeyPatch): Platform and `run` seams.
        listed (str): The `ps` output.
        shows (bool): Expected answer.
    """
    ctx = make_context(tmp_path, DEV_TOOLS, "1.0.0")
    calls: list[tuple[list[object], dict[str, object]]] = []

    def ps(argv: list[object], **kwargs: object) -> SimpleNamespace:
        """Record the listing and answer `listed`."""
        calls.append((argv, kwargs))
        return SimpleNamespace(stdout=listed)

    monkeypatch.setattr(pc, "host_platform", lambda: "darwin")
    monkeypatch.setattr(pc, "run", ps)
    assert pc.legacy_name_shows(ctx, 4242, SECRET) is shows
    assert calls == [
        (
            [Path("/bin/ps"), "-c", "-o", "comm=", "-p", "4242"],
            {"env": {"LC_ALL": "C", "PATH": "/usr/bin:/bin"}, "cwd": ctx.work, "timeout": 30},
        )
    ]


# --- session-kit ----------------------------------------------------------------------------------


def monitor_run(
    *, started: str = "started m1", start_error: bool = False, read: str = "kit-contract-line"
) -> pc.PiRun:
    """Build the monitor run.

    Parameters:
        started (str): `monitor_start` text.
        start_error (bool): Make `monitor_start` an error result.
        read (str): `monitor_read` text.

    Returns:
        pc.PiRun: The run.
    """
    return pi_run(
        tool_event("monitor_start", started, is_error=start_error), tool_event("monitor_read", f"1: {read}")
    )


def drive_session_kit(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, run: pc.PiRun
) -> pc.SessionKitEvidence:
    """Run `scenario_session_kit` with a canned monitor run and a recording stats double.

    Parameters:
        tmp_path (Path): Scratch root.
        monkeypatch (pytest.MonkeyPatch): Substitutions.
        run (pc.PiRun): Canned monitor run.

    Returns:
        pc.SessionKitEvidence: The scenario's evidence.
    """
    ctx = make_context(tmp_path, SESSION_KIT, "1.0.0")
    make_tarball(ctx.artifact.path, {pc.STATS_ARTIFACT: b"// packed stats\n"})
    exercised: list[tuple[Path, bytes, Path, Path]] = []

    def stats(node: Path, artifact: bytes, agent_dir: Path, work: Path) -> SimpleNamespace:
        """Record the packed artifact run."""
        exercised.append((node, artifact, agent_dir, work))
        return SimpleNamespace(shards=[1, 2])

    monkeypatch.setattr(pc, "exercise_stats_artifact", stats)
    pi, providers = install(monkeypatch, [run], StubProvider(["monitor_start", "monitor_read"]))
    evidence = pc.scenario_session_kit(ctx)
    assert pi.calls[0][1] == ctx.work / "project"
    assert pi.calls[0][3] == {"session_dir": ctx.sandbox.agent_dir / "sessions"}
    node = str(ctx.sandbox.tools.node)
    assert providers.scripts[0][0] == fp.ToolStep(
        "monitor_start", {"name": "contract", "argv": [node, "-e", "console.log('kit-contract-line')"]}
    )
    assert exercised == [(ctx.sandbox.tools.node, b"// packed stats\n", ctx.sandbox.agent_dir, ctx.work)]
    return evidence


def test_session_kit_scenario_runs_monitor_then_stats(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The monitor reads its marker line, then the packed stats bytes run over that session.

    Parameters:
        tmp_path (Path): Scratch root.
        monkeypatch (pytest.MonkeyPatch): Substitutions.
    """
    assert drive_session_kit(tmp_path, monkeypatch, monitor_run()) == {
        "tools": ["monitor_start", "monitor_read"],
        "monitor_line": "kit-contract-line",
        "stats_shards": 2,
    }


@pytest.mark.parametrize(
    ("run", "message"),
    [
        (monitor_run(start_error=True), "monitor_start: started m1"),
        (monitor_run(started="started m2"), "monitor_start: started m2"),
        (monitor_run(read="other"), "monitor_read missed 'kit-contract-line'"),
        (pi_run(stderr="extension failed"), "session-kit monitor: unexpected stderr"),
    ],
    ids=["start-error", "wrong-id", "missed-line", "stderr"],
)
def test_session_kit_scenario_rejects(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, run: pc.PiRun, message: str
) -> None:
    """Each violated monitor expectation fails with its own message.

    Parameters:
        tmp_path (Path): Scratch root.
        monkeypatch (pytest.MonkeyPatch): Substitutions.
        run (pc.PiRun): Canned run carrying one violation.
        message (str): Expected failure.
    """
    with pytest.raises(pc.ContractError, match=message):
        drive_session_kit(tmp_path, monkeypatch, run)


# --- subscription-router --------------------------------------------------------------------------


def router_runs(
    *,
    listed: str = "router/default",
    answers: Sequence[dict[str, Any]] | None = None,
    rejected: pc.PiRun | None = None,
) -> list[pc.PiRun]:
    """Build the listing, dispatch and rejected-config runs.

    Parameters:
        listed (str): Listing stdout.
        answers (Sequence[dict[str, Any]] | None): Dispatch events; defaults to one physical answer.
        rejected (pc.PiRun | None): Rejected-config listing; defaults to a clean empty listing.

    Returns:
        list[pc.PiRun]: The three runs.
    """
    events = [assistant_event(pc.PROVIDER, pc.PHYSICAL_MODEL)] if answers is None else answers
    return [pi_run(stdout=listed), pi_run(*events), rejected or pi_run()]


def drive_router(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    runs: list[pc.PiRun],
    provider: StubProvider | None = None,
) -> pc.RouterEvidence:
    """Run `scenario_router` with canned runs and a recording packed-router double.

    Parameters:
        tmp_path (Path): Scratch root.
        monkeypatch (pytest.MonkeyPatch): Substitutions.
        runs (list[pc.PiRun]): Canned runs.
        provider (StubProvider | None): Provider; defaults to one physical request offering the router tool.

    Returns:
        pc.RouterEvidence: The scenario's evidence.
    """
    ctx = make_context(tmp_path, ROUTER, "1.0.0")
    packed: list[tuple[Path, str]] = []

    def exercise(_ctx: pc.Context, project: Path, mode: str) -> list[str]:
        """Record one packed-router mode."""
        packed.append((project, mode))
        return [f"{mode}/m"]

    monkeypatch.setattr(pc, "exercise_packed_router", exercise)
    pi, _providers = install(monkeypatch, runs, provider or StubProvider(["subscription_usage"]))
    evidence = pc.scenario_router(ctx)
    project = ctx.work / "project"
    assert [call[2] for call in pi.calls] == [
        ["--list-models", "router"],
        ["--model", "router/default", "--mode", "json", "go"],
        ["--list-models", "router"],
    ]
    rejected_config = json.loads((ctx.sandbox.agent_dir / "subscription-router.json").read_text())
    assert rejected_config == {"profiles": {"Bad Id": {"chain": []}}}
    assert packed == [(project, "balanced"), (project, "fallback"), (project, "recovery")]
    return evidence


def test_router_scenario_dispatches_and_rejects_a_bad_config(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`router/default` lists, dispatches to the physical model, and a bad config registers nothing.

    Parameters:
        tmp_path (Path): Scratch root.
        monkeypatch (pytest.MonkeyPatch): Substitutions.
    """
    assert drive_router(tmp_path, monkeypatch, router_runs()) == {
        "virtual_model": "router/default",
        "dispatched": f"{pc.PROVIDER}/{pc.PHYSICAL_MODEL}",
        "balanced": ["balanced/m"],
        "fallback": ["fallback/m"],
        "recovery": ["recovery/m"],
    }


class OtherModelProvider(StubProvider):
    """Provider whose one request named a model other than the physical one."""

    def __init__(self) -> None:
        """Record one request for `other`."""
        self.requests = [fp.RecordedRequest("other", ("user",), ("subscription_usage",), "", route=None)]


@pytest.mark.parametrize(
    ("runs", "provider", "message"),
    [
        (router_runs(listed="nothing"), None, "router/default not listed"),
        (router_runs(), OtherModelProvider(), "physical requests"),
        (router_runs(answers=[]), None, "expected one assistant message, got 0"),
        (router_runs(answers=[assistant_event("other", "m")]), None, "dispatched to other/m"),
        (router_runs(rejected=pi_run(returncode=1)), None, "must not crash Pi"),
        (router_runs(rejected=pi_run(stdout="router/default")), None, "rejected config registered models"),
        (router_runs(rejected=pi_run(stdout="Bad Id")), None, "rejected config registered models"),
    ],
    ids=["unlisted", "other-model", "no-answer", "wrong-dispatch", "crash", "kept-default", "registered-bad"],
)
def test_router_scenario_rejects(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    runs: list[pc.PiRun],
    provider: StubProvider | None,
    message: str,
) -> None:
    """Each violated routing expectation fails with its own message.

    Parameters:
        tmp_path (Path): Scratch root.
        monkeypatch (pytest.MonkeyPatch): Substitutions.
        runs (list[pc.PiRun]): Canned runs carrying one violation.
        provider (StubProvider | None): Provider override.
        message (str): Expected failure.
    """
    with pytest.raises(pc.ContractError, match=message):
        drive_router(tmp_path, monkeypatch, runs, provider)


class RecordingProvider:
    """`FauxProvider` double: an inert context manager whose requests the Pi double fills."""

    created: list[RecordingProvider]

    def __init__(self, script: Sequence[fp.Step]) -> None:
        """Remember `script` and register this provider.

        Parameters:
            script (Sequence[fp.Step]): Scripted turns.
        """
        self.script = list(script)
        self.requests: list[fp.RecordedRequest] = []
        self.base_url = f"http://127.0.0.1:{9000 + len(self.created)}/v1"
        self.created.append(self)

    def __enter__(self) -> RecordingProvider:
        """Enter the inert provider.

        Returns:
            RecordingProvider: This provider.
        """
        return self

    def __exit__(self, *_args: object) -> None:
        """Leave the inert provider.

        Parameters:
            *_args (object): Context-manager exception arguments.
        """
        return


RouterMode = Literal["balanced", "fallback", "recovery"]
PACKED_DISPATCH: dict[RouterMode, list[tuple[str, str]]] = {
    "balanced": [("openai-codex", "m-b")],
    "fallback": [("local", "m-c")],
    "recovery": [("anthropic", "m-a"), ("openai-codex", "m-b")],
}
PROVIDER_INDEX = {"anthropic": 0, "openai-codex": 1, "local": 2}


def drive_packed_router(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    mode: RouterMode,
    *,
    dispatch: Sequence[tuple[str, str]] | None = None,
    requested: Sequence[tuple[str, str]] | None = None,
    tools: Sequence[str] = ("subscription_usage",),
    stop: str = "stop",
) -> list[str]:
    """Run `exercise_packed_router` against three recording providers and a Pi double that "dispatches".

    Parameters:
        tmp_path (Path): Scratch root.
        monkeypatch (pytest.MonkeyPatch): Substitutions.
        mode (RouterMode): Router scenario.
        dispatch (Sequence[tuple[str, str]] | None): Assistant answers; defaults to the mode's contract.
        requested (Sequence[tuple[str, str]] | None): Providers that saw a request; defaults to `dispatch`.
        tools (Sequence[str]): Tools each recorded request declared.
        stop (str): Final `stopReason`.

    Returns:
        list[str]: The physical attempts.
    """
    ctx = make_context(tmp_path, ROUTER, "1.0.0")
    project = ctx.work / "project"
    project.mkdir()
    monkeypatch.setattr(RecordingProvider, "created", [], raising=False)
    monkeypatch.setattr(pc, "FauxProvider", RecordingProvider)
    answers = PACKED_DISPATCH[mode] if dispatch is None else dispatch
    wrappers: list[str] = []

    def dispatching(
        _pi_bin: Path, _sandbox: pc.Sandbox, wrapper: Path, cwd: Path, extra: Sequence[str], **_kwargs: object
    ) -> pc.PiRun:
        """Record a request at each requested provider and answer with `answers`."""
        assert (cwd, list(extra)) == (project, ["--model", "router/default", "--mode", "json", "go"])
        wrappers.append(wrapper.read_text())
        for name, model in answers if requested is None else requested:
            request = fp.RecordedRequest(model, ("user",), tuple(tools), "", route=None)
            RecordingProvider.created[PROVIDER_INDEX[name]].requests.append(request)
        events = [assistant_event(name, model) for name, model in answers]
        if events:
            events[-1]["message"]["stopReason"] = stop
        return pi_run(*events)

    monkeypatch.setattr(pc, "run_pi", dispatching)
    physical = pc.exercise_packed_router(ctx, project, mode)
    first = RecordingProvider.created[0].script[0]
    assert isinstance(first, fp.ErrorStep) is (mode == "recovery")
    registered = json.loads((ctx.sandbox.agent_dir / "models.json").read_text())["providers"]
    assert set(registered) == {"anthropic", "openai-codex", "local"}
    [wrapper] = wrappers
    assert f'const mode = "{mode}";' in wrapper
    assert (ctx.installed / "src/index.ts").as_posix() in wrapper
    assert (ctx.installed / "src/usage.ts").as_posix() in wrapper
    assert "PACKED_ROUTER_" not in wrapper
    return physical


@pytest.mark.parametrize("mode", PACKED_DISPATCH)
def test_packed_router_dispatches_each_mode(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, mode: RouterMode
) -> None:
    """Balanced, fallback and recovery each reach exactly their contracted physical providers.

    Parameters:
        tmp_path (Path): Scratch root.
        monkeypatch (pytest.MonkeyPatch): Substitutions.
        mode (RouterMode): Router scenario.
    """
    expected = [f"{name}/{model}" for name, model in PACKED_DISPATCH[mode]]
    assert drive_packed_router(tmp_path, monkeypatch, mode) == expected


@pytest.mark.parametrize(
    ("changes", "message"),
    [
        ({"dispatch": [("local", "m-c")]}, r"expected \['openai-codex/m-b'\], got \['local/m-c'\]"),
        ({"requested": [("openai-codex", "m-b"), ("local", "m-c")]}, "unexpected provider request count"),
        ({"tools": ()}, "none of \\['subscription_usage'\\] declared"),
        ({"stop": "error"}, "did not settle successfully"),
    ],
    ids=["wrong-provider", "extra-request", "no-tools", "unsettled"],
)
def test_packed_router_rejects(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, changes: dict[str, Any], message: str
) -> None:
    """Wrong dispatch, stray requests, missing tools and an unsettled stream each fail.

    Parameters:
        tmp_path (Path): Scratch root.
        monkeypatch (pytest.MonkeyPatch): Substitutions.
        changes (dict[str, Any]): `drive_packed_router` overrides carrying one violation.
        message (str): Expected failure.
    """
    with pytest.raises(pc.ContractError, match=message):
        drive_packed_router(tmp_path, monkeypatch, "balanced", **changes)
