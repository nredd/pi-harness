"""Independent compiled-library packaging, without weakening extension contracts.

References:
    https://nodejs.org/api/packages.html#package-entry-points
"""

from __future__ import annotations

import errno
import json
import os
import signal
import subprocess
from dataclasses import dataclass, field, replace
from enum import Enum, auto
from pathlib import Path
from typing import Any

import pytest
from contract_helpers import FifoWitness

import package_contracts as pc
import release_descriptors as rd


def manifest() -> dict[str, object]:
    """Return the actual library's public manifest for mutation tests.

    Returns:
        dict[str, object]: Parsed package metadata.
    """
    return json.loads((pc.REPO_ROOT / "packages/resource-sampler/package.json").read_text())


def test_library_manifest_and_descriptor() -> None:
    """Require exact ESM exports, no Pi peers, and the isolated runtime probe."""
    contract = pc.RESOURCE_SAMPLER_CONTRACT
    assert pc.audit_manifest(contract, manifest(), contract.required) == []
    descriptor = rd.descriptor_for(contract.name)
    assert descriptor is not None
    assert descriptor.contract.library
    assert descriptor.contract_gates == ("audit",)
    assert descriptor.contract.node_probe
    assert descriptor.stock_gate is None


@pytest.mark.parametrize(
    "mutation",
    [
        {"pi": {"extensions": []}},
        {"peerDependencies": {"@earendil-works/pi-tui": "*"}},
        {"dependencies": {"@nredd/pi-session-kit": "*"}},
        {"exports": {".": "./src/index.ts"}},
        {"types": "./src/index.ts"},
        {"type": "commonjs"},
        {"files": ["dist", "src", "LICENSE", "README.md"]},
    ],
)
def test_library_manifest_rejects_bad_boundaries(mutation: dict[str, object]) -> None:
    """Reject host coupling, source loading, unpinned payloads and wrong entrypoints."""
    contract = pc.RESOURCE_SAMPLER_CONTRACT
    assert pc.audit_manifest(contract, manifest() | mutation, contract.required)


def test_extension_still_requires_pi_entrypoint() -> None:
    """A library exemption must not weaken ordinary extension entrypoint validation."""
    contract = pc.CONTRACTS[0]
    problems = pc.audit_manifest(contract, manifest() | {"name": contract.name}, contract.required)
    assert "`pi.extensions` is empty" in problems


def test_library_imports_and_payload_are_exact() -> None:
    """Allow relative ESM but never host imports or extra/missing compiled files."""
    contract = pc.RESOURCE_SAMPLER_CONTRACT
    files = list(contract.required)
    assert pc.audit_files(contract, files) == []
    assert pc.audit_files(contract, [*files, "dist/unexpected.js"])
    assert pc.audit_files(contract, files[:-1])
    allowed = pc.FileImports(specifiers=["node:os", "./types.js"], diagnostics=[])
    assert pc.classify_imports("dist/index.js", allowed, files, library=True) == []
    for specifier in ["@earendil-works/pi-tui", "@nredd/pi-dev-tools", "../../outside.js"]:
        found = pc.FileImports(specifiers=[specifier], diagnostics=[])
        assert pc.classify_imports("dist/index.js", found, files, library=True)


def test_library_probe_runs_on_installed_bytes(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Assert the audit gate actually invokes the descriptor probe after isolated install."""
    calls: list[dict[str, object]] = []
    tools = pc.locate_tools()
    contract = pc.RESOURCE_SAMPLER_CONTRACT
    artifact = pc.PackedArtifact(
        contract=contract,
        path=tmp_path / "library.tgz",
        version="0.1.0",
        integrity="sha512-" + "A" * 86 + "==",
        shasum="0" * 40,
        size=1,
        files=contract.required,
    )
    monkeypatch.setattr(pc, "select_artifact", lambda *_args: artifact)
    monkeypatch.setattr(pc, "audit_tarball", lambda *_args: [])
    monkeypatch.setattr(pc, "install_alone", lambda *_args: calls.append({"kind": "install"}))
    monkeypatch.setattr(pc, "run", lambda argv, **kwargs: calls.append({"argv": argv, **kwargs}))
    pc.run_audit_gate(tmp_path, contract)
    assert calls[0] == {"kind": "install"}
    assert calls[1]["argv"] == [tools.node, "--input-type=module", "-e", contract.node_probe]
    assert calls[1]["cwd"] == tmp_path / "install"
    assert calls[1]["own_group"] is True


def session_kit() -> pc.PackageContract:
    """Return the session-kit contract, the only declared consumer of the shared sampler.

    Returns:
        pc.PackageContract: Session-kit packaging contract.
    """
    return next(c for c in pc.CONTRACTS if c.name == "@nredd/pi-session-kit")


def test_session_kit_declares_the_exact_published_sampler() -> None:
    """The consumer pins one exact registry release, never a range, workspace or file spec."""
    contract = session_kit()
    assert contract.runtime_dependencies == (("@nredd/pi-resource-sampler", pc.RESOURCE_SAMPLER_VERSION),)
    actual = json.loads((pc.REPO_ROOT / "packages/session-kit/package.json").read_text())
    assert actual["dependencies"] == {"@nredd/pi-resource-sampler": pc.RESOURCE_SAMPLER_VERSION}
    files = list(contract.required)
    assert pc.audit_manifest(contract, actual, files) == []
    for spec in ["^0.1.0", "workspace:*", "file:../resource-sampler", "0.0.0-bootstrap.0"]:
        mutated = actual | {"dependencies": {"@nredd/pi-resource-sampler": spec}}
        assert pc.audit_manifest(contract, mutated, files), spec


def test_only_declared_shared_library_is_an_allowed_sibling_import() -> None:
    """A declared shared library is importable; plugins, subpaths and undeclared use stay banned."""
    files = ["src/a.ts"]
    declared = ["@nredd/pi-resource-sampler"]

    def problems(spec: str, dependencies: list[str]) -> list[str]:
        """Classify one synthetic import against independent sibling declarations.

        Parameters:
            spec (str): Module specifier to classify.
            dependencies (list[str]): Explicitly allowed shared-library names.

        Returns:
            list[str]: Boundary violations, empty for a permitted import.
        """
        found = pc.FileImports(specifiers=[spec], diagnostics=[])
        return pc.classify_imports("src/a.ts", found, files, dependencies)

    assert problems("@nredd/pi-resource-sampler", declared) == []
    assert problems("@nredd/pi-resource-sampler", [])
    assert problems("@nredd/pi-resource-sampler/dist/collect.js", declared)
    assert problems("@nredd/pi-dev-tools", ["@nredd/pi-dev-tools"])
    standalone = pc.classify_imports(
        "dist/x.mjs",
        pc.FileImports(specifiers=["@nredd/pi-resource-sampler"], diagnostics=[]),
        ["dist/x.mjs"],
        declared,
        standalone_artifacts=["dist/x.mjs"],
    )
    assert standalone
    library = pc.classify_imports(
        "dist/index.js",
        pc.FileImports(specifiers=["@nredd/pi-resource-sampler"], diagnostics=[]),
        ["dist/index.js"],
        declared,
        library=True,
    )
    assert library


def test_shared_library_consumers_use_the_common_pin() -> None:
    """Every contract declaring the sampler uses `SHARED_LIBRARIES`' one exact version."""
    assert dict(pc.SHARED_LIBRARIES) == {"@nredd/pi-resource-sampler": pc.RESOURCE_SAMPLER_VERSION}
    for contract in (*pc.CONTRACTS, pc.RESOURCE_SAMPLER_CONTRACT):
        assert pc.shared_library_pin_problems(contract) == [], contract.name
    drifted = replace(session_kit(), runtime_dependencies=(("@nredd/pi-resource-sampler", "0.1.0"),))
    assert pc.shared_library_pin_problems(drifted) == [
        "'@nredd/pi-session-kit' declares shared library '@nredd/pi-resource-sampler' at '0.1.0', "
        f"not the common pin '{pc.RESOURCE_SAMPLER_VERSION}'"
    ]


def test_session_kit_locks_the_registry_sampler_not_the_workspace() -> None:
    """npm links a same-version workspace, so the root lock must carry a nested registry entry.

    `npm dedupe` would drop it and silently test the workspace copy instead of the published bytes.
    """
    lock = json.loads((pc.REPO_ROOT / "package-lock.json").read_text())["packages"]
    name, version = "@nredd/pi-resource-sampler", pc.RESOURCE_SAMPLER_VERSION
    entry = lock[f"packages/session-kit/node_modules/{name}"]
    assert entry["version"] == version
    assert entry["resolved"] == f"https://registry.npmjs.org/{name}/-/pi-resource-sampler-{version}.tgz"
    assert entry["integrity"].startswith("sha512-")
    assert "link" not in entry
    assert lock["packages/session-kit"]["dependencies"] == {name: version}


NEGATIVE_CONTROL = "hostile child does not expose the secret through the 0.1.0 name source"
SILENT = "setInterval(() => {}, 1000);"
ENV = {"PATH": "/usr/bin:/bin"}
READY = "console.log('ready'); setInterval(() => {}, 1000);"


@pytest.mark.parametrize(
    ("probe", "failure", "status"),
    [
        # Only the deliberately never-ready child gets a short deadline; the rest keep the shipped one.
        pytest.param(
            pc.resource_sampler_probe(SILENT, ready_ms=300),
            "hostile child not ready within 300 ms",
            "SIGTERM",
            id="silent",
        ),
        pytest.param(
            pc.resource_sampler_probe("process.exit(3);"),
            "hostile child exited before readiness",
            "3",
            id="exits",
        ),
        pytest.param(
            pc.resource_sampler_probe(READY, disguise=False),
            NEGATIVE_CONTROL,
            "SIGTERM",
            id="negative-control",
        ),
        # Installs its handler before `ready`, so SIGTERM is really ignored and only SIGKILL reaps it.
        pytest.param(
            pc.resource_sampler_probe(f"process.on('SIGTERM', () => {{}}); {READY}", disguise=False),
            NEGATIVE_CONTROL,
            "SIGKILL",
            id="ignores-sigterm",
        ),
    ],
)
def test_library_probe_reaps_child_when_setup_fails(
    tmp_path: Path, probe: str, failure: str, status: str
) -> None:
    """Run the real probe with a broken child: it must fail for that reason and still reap the child.

    The failures happen before the probe imports the library, so no installed package is needed.
    `hostile child reaped` is printed only after Node observed that exact child's exit status, so a
    reused PID cannot make it pass.

    Parameters:
        tmp_path (Path): Empty working directory without the library installed.
        probe (str): Probe program around a broken child.
        failure (str): Expected setup failure.
        status (str): Expected exit code or terminating signal of the reaped child.
    """
    result = subprocess.run(
        [str(pc.locate_tools().node), "--input-type=module", "-e", probe],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    assert result.returncode != 0
    assert failure in result.stderr
    assert f"hostile child reaped: {status}\n" in result.stderr


def probe_argv(child: str) -> list[str | Path]:
    """Return the real probe around `child`, which never prints `ready` within the run deadline.

    Parameters:
        child (str): Child program.

    Returns:
        list[str | Path]: Probe argument vector.
    """
    return [
        pc.locate_tools().node,
        "--input-type=module",
        "-e",
        pc.resource_sampler_probe(child, ready_ms=60_000),
    ]


def test_probe_timeout_kills_its_whole_process_group(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Time out the real probe while its child waits for readiness: no grandchild may survive.

    The child is the FIFO's only writer and never prints `ready`, so the probe outlives the `run`
    deadline. The real `communicate` and its 2s deadline start only once the child's byte arrived, so
    a slow node boot under load cannot let the deadline kill the group before the grandchild exists.
    EOF on the FIFO after `run` returns proves every writer exited, without a reusable PID probe. On a
    regression the child still exits on its own `WITNESS_EXIT_S` bound and the probe follows once
    readiness fails.

    Parameters:
        tmp_path (Path): Probe working directory holding the FIFO.
        monkeypatch (pytest.MonkeyPatch): Delays the real `communicate` until the grandchild is running.
    """
    communicate = subprocess.Popen.communicate
    with FifoWitness(tmp_path) as witness:

        def after_start(
            self: subprocess.Popen[str], data: str | None = None, timeout: float | None = None
        ) -> tuple[str, str]:
            """Run the real communication, with its deadline, only after the child opened its witness.

            Parameters:
                self (subprocess.Popen[str]): Probe leader.
                data (str | None): Real communication input.
                timeout (float | None): Real communication deadline, `run`'s 2s.

            Returns:
                tuple[str, str]: Real captured output; unreached here, the probe outlives the deadline.
            """
            assert witness.started(), "child never wrote to the FIFO"
            return communicate(self, data, timeout)

        monkeypatch.setattr(subprocess.Popen, "communicate", after_start)
        with pytest.raises(pc.ContractError, match="timed out after 2s"):
            pc.run(probe_argv(FifoWitness.NODE_WRITER), env=ENV, cwd=tmp_path, timeout=2, own_group=True)
        assert witness.gone(), "grandchild still holds the FIFO after the timeout"


def test_probe_interrupt_kills_its_whole_process_group(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Interrupt `run` while the real probe's child is alive: the interrupt propagates, the group dies.

    Parameters:
        tmp_path (Path): Probe working directory holding the FIFO.
        monkeypatch (pytest.MonkeyPatch): Injects `KeyboardInterrupt` once the grandchild is running.
    """
    argv = probe_argv(FifoWitness.NODE_WRITER)
    with FifoWitness(tmp_path) as witness:

        def interrupted(*_args: object, **_kwargs: object) -> None:
            """Interrupt communication only after the real child opens its witness.

            Parameters:
                *_args (object): Unused Popen communication positional arguments.
                **_kwargs (object): Unused Popen communication keyword arguments.

            Raises:
                KeyboardInterrupt: Once the real grandchild is known to be running.
            """
            assert witness.started(), "child never wrote to the FIFO"
            raise KeyboardInterrupt

        monkeypatch.setattr(subprocess.Popen, "communicate", interrupted)
        with pytest.raises(KeyboardInterrupt) as raised:
            pc.run(argv, env=ENV, cwd=tmp_path, timeout=30, own_group=True)
        assert not getattr(raised.value, "__notes__", None)
        assert witness.gone(), "grandchild still holds the FIFO after the interrupt"


def test_reaped_leader_group_is_never_signalled(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Once the leader is reaped its id may be reused: fail with the original error, signal nothing.

    Parameters:
        tmp_path (Path): Working directory.
        monkeypatch (pytest.MonkeyPatch): Reaps the leader inside `communicate`, then interrupts.
    """
    signalled: list[int] = []

    def reaped_then_interrupted(self: subprocess.Popen[str], *_args: object, **_kwargs: object) -> None:
        """Reap the leader before simulating a communication interrupt.

        Parameters:
            self (subprocess.Popen[str]): Probe leader whose exit status must be collected first.
            *_args (object): Unused communication positional arguments.
            **_kwargs (object): Unused communication keyword arguments.

        Raises:
            KeyboardInterrupt: After reaping, so no potentially reused process group is signalled.
        """
        self.wait()
        raise KeyboardInterrupt

    monkeypatch.setattr(subprocess.Popen, "communicate", reaped_then_interrupted)
    monkeypatch.setattr(pc.os, "killpg", lambda pgid, _signal: signalled.append(pgid))
    with pytest.raises(KeyboardInterrupt) as raised:
        pc.run([Path("/bin/sh"), "-c", "exit 0"], env={}, cwd=tmp_path, timeout=5, own_group=True)
    assert signalled == []
    assert "not signalled: its leader was already reaped" in raised.value.__notes__[0]


RUN_LEADER = ["/bin/sh", "-c", "exit 0"]


class Listing(Enum):
    """How the injected `/bin/ps` seam answers for the refused group."""

    REAL = auto()  # run the real, read-only listing
    LIVE = auto()  # report a live member in the leader's group


def leader_is_unreaped(pid: int) -> bool:
    """Report whether `pid` is still this process's unreaped child, without reaping it.

    Parameters:
        pid (int): child process id.

    Returns:
        bool: always `True`: the leader still anchors its process group number.

    Raises:
        ChildProcessError: `pid` was already reaped, which fails the test that recorded it.
    """
    os.waitid(os.P_PID, pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
    return True


@dataclass
class RefusedGroup:
    """What the injected `killpg` and `/bin/ps` saw for one exited, unreaped leader's group.

    Attributes:
        leaders (list[subprocess.Popen[str]]): the run's leader, captured inside `communicate`.
        signalled (list[tuple[int, int, bool]]): `(pgid, signal, leader still unreaped)` per call.
        listings (list[list[str]]): `/bin/ps` argument vectors.
    """

    leaders: list[subprocess.Popen[str]] = field(default_factory=list)
    signalled: list[tuple[int, int, bool]] = field(default_factory=list)
    listings: list[list[str]] = field(default_factory=list)


def refuse_zombie_group(
    monkeypatch: pytest.MonkeyPatch, raised: BaseException, listing: Listing | Exception
) -> RefusedGroup:
    """Fail `communicate` once the leader exited unreaped, and answer `EPERM` like Darwin; signal nothing.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): installs the seams.
        raised (BaseException): what `communicate` raises after the leader exited.
        listing (Listing | Exception): how `/bin/ps` answers, or the listing failure to raise.

    Returns:
        RefusedGroup: what was captured, signalled and listed.
    """
    seen = RefusedGroup()
    check_output = subprocess.check_output
    communicate = subprocess.Popen.communicate

    def exited_then_failed(self: subprocess.Popen[str], *args: Any, **kwargs: Any) -> tuple[str, str]:
        """Wait for the leader's exit without reaping it, then fail like a timeout or interrupt.

        Only the run's leader fails; the real `/bin/ps` listing communicates for real.

        Parameters:
            self (subprocess.Popen[str]): the run's own session leader, or the listing.
            *args (Any): real communication positional arguments.
            **kwargs (Any): real communication keyword arguments.

        Returns:
            tuple[str, str]: the listing's real output.

        Raises:
            BaseException: `raised`, with the leader a zombie that still anchors its group.
        """
        if self.args != RUN_LEADER:
            return communicate(self, *args, **kwargs)
        seen.leaders.append(self)
        os.waitid(os.P_PID, self.pid, os.WEXITED | os.WNOWAIT)
        raise raised

    def refused(pgid: int, sig: int) -> None:
        """Record the owned-group signal and refuse it, like `killpg` at a zombie-only Darwin group.

        Parameters:
            pgid (int): process group to signal; must be the run's own leader.
            sig (int): signal to send.

        Raises:
            PermissionError: always.
        """
        leader = seen.leaders[0]
        assert pgid == leader.pid
        seen.signalled.append((pgid, sig, leader_is_unreaped(pgid)))
        raise PermissionError(errno.EPERM, "Operation not permitted")

    def listed(argv: list[str], **kwargs: Any) -> str:
        """Record the process-table listing, then run it for real or answer the injected verdict.

        Parameters:
            argv (list[str]): listing argument vector.
            **kwargs (Any): real `check_output` options.

        Returns:
            str: `pgid stat` lines.

        Raises:
            Exception: the injected listing failure.
        """
        assert argv[0] == "/bin/ps"
        seen.listings.append(argv)
        if isinstance(listing, Exception):
            raise listing
        if listing is Listing.LIVE:
            return f"{seen.leaders[0].pid} S\n"
        return check_output(argv, **kwargs)

    monkeypatch.setattr(subprocess.Popen, "communicate", exited_then_failed)
    monkeypatch.setattr(os, "killpg", refused)
    monkeypatch.setattr(subprocess, "check_output", listed)
    return seen


# Each `communicate` failure, and what `run` reports for it once the group is gone.
ORIGINALS: dict[str, tuple[BaseException, type[BaseException]]] = {
    "timeout": (subprocess.TimeoutExpired(RUN_LEADER, 5), pc.ContractError),
    "interrupt": (KeyboardInterrupt(), KeyboardInterrupt),
}
LISTING_FAILURES = [
    subprocess.TimeoutExpired(["/bin/ps"], 5),
    subprocess.CalledProcessError(1, ["/bin/ps"]),
    FileNotFoundError(errno.ENOENT, "No such file or directory", "/bin/ps"),
]


def run_exiting_leader(tmp_path: Path) -> None:
    """Run a leader that exits at once through `run_own_group`.

    Parameters:
        tmp_path (Path): Working directory.
    """
    pc.run(RUN_LEADER, env={}, cwd=tmp_path, timeout=5, own_group=True)


@pytest.mark.parametrize("original", ORIGINALS)
def test_zombie_only_eperm_keeps_the_original_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, original: str
) -> None:
    """`EPERM` at a group whose only member is the exited, unreaped leader means gone (#361).

    The real `/bin/ps` lists the zombie, so the refusal is explained and the original failure surfaces.

    Parameters:
        tmp_path (Path): Working directory.
        monkeypatch (pytest.MonkeyPatch): Recording seams.
        original (str): `ORIGINALS` key.
    """
    raised, expected = ORIGINALS[original]
    seen = refuse_zombie_group(monkeypatch, raised, listing=Listing.REAL)
    with pytest.raises(expected):
        run_exiting_leader(tmp_path)
    [leader] = seen.leaders
    assert seen.signalled == [(leader.pid, signal.SIGKILL, True)]
    assert seen.listings == [["/bin/ps", "-axo", "pgid=,stat="]]
    assert leader.returncode == 0


@pytest.mark.parametrize("original", ORIGINALS)
def test_eperm_with_a_live_member_surfaces(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, original: str
) -> None:
    """A refusal while a member still runs is a real failure, never read as reaped.

    Parameters:
        tmp_path (Path): Working directory.
        monkeypatch (pytest.MonkeyPatch): Recording seams.
        original (str): `ORIGINALS` key; the refusal replaces that failure.
    """
    raised, _ = ORIGINALS[original]
    seen = refuse_zombie_group(monkeypatch, raised, listing=Listing.LIVE)
    with pytest.raises(PermissionError) as caught:
        run_exiting_leader(tmp_path)
    assert caught.value.__context__ is raised
    assert len(seen.listings) == 1
    assert seen.signalled == [(seen.leaders[0].pid, signal.SIGKILL, True)]


@pytest.mark.parametrize("failure", LISTING_FAILURES, ids=type)
def test_eperm_with_a_failed_listing_surfaces_chained(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, failure: Exception
) -> None:
    """A listing that cannot explain the `EPERM` surfaces it, chained to the listing failure.

    The original failure stays its context, so the refusal never hides why the group was killed.

    Parameters:
        tmp_path (Path): Working directory.
        monkeypatch (pytest.MonkeyPatch): Recording seams.
        failure (Exception): injected `/bin/ps` failure.
    """
    raised, _ = ORIGINALS["timeout"]
    seen = refuse_zombie_group(monkeypatch, raised, listing=failure)
    with pytest.raises(PermissionError) as caught:
        run_exiting_leader(tmp_path)
    assert caught.value.__cause__ is failure
    assert caught.value.__context__ is raised
    assert seen.signalled == [(seen.leaders[0].pid, signal.SIGKILL, True)]


def test_probe_reports_cleanup_failure_with_the_primary_error(tmp_path: Path) -> None:
    """A failing `stop` surfaces as `AggregateError` with the setup failure first, child still reaped.

    The failure is injected into this test's copy of the probe program only: the real `stop` runs,
    then throws.

    Parameters:
        tmp_path (Path): Empty working directory without the library installed.
    """
    probe = pc.resource_sampler_probe(READY, disguise=False)
    anchor = "async function stop(child) {"
    assert probe.count(anchor) == 1
    injected = probe.replace(
        anchor,
        "async function stop(child) { await realStop(child); throw new Error('injected cleanup failure'); }\n"
        "async function realStop(child) {",
    )
    result = subprocess.run(
        [str(pc.locate_tools().node), "--input-type=module", "-e", injected],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    assert result.returncode != 0
    assert "AggregateError" in result.stderr
    assert f"{NEGATIVE_CONTROL}; cleanup also failed: injected cleanup failure" in result.stderr
    assert "hostile child reaped: SIGTERM\n" in result.stderr


@pytest.mark.parametrize("missing", ["usage", "swap"])
def test_library_probe_rejects_missing_native_memory(tmp_path: Path, missing: str) -> None:
    """Exercise the real probe assertions with an older or broken producer, not just their text.

    Parameters:
        tmp_path (Path): Isolated probe working directory.
        missing (str): Native metric removed from the synthetic producer.
    """
    probe = pc.resource_sampler_probe()
    anchor = "const { createResourceSampler } = await import('@nredd/pi-resource-sampler');"
    producer = """
    const createResourceSampler = () => {
        let n = 0;
        return {
            async sample() {
                const memory = {
                    totalBytes: 16, freeBytes: 1,
                    usage: { state: 'available', value: {
                        usedBytes: 12, availableBytes: 4, basis: 'app+wired+compressed' } },
                    swap: { state: 'available', value: { usedBytes: 3, totalBytes: 4 } }
                };
                delete memory.MISSING;
                return { cpu: n++ ? { state: 'available', value: 10 } : { state: 'warming' },
                    memory, processes: [] };
            },
            async dispose() {}
        };
    };
    """
    assert probe.count(anchor) == 1
    probe = probe.replace(anchor, producer.replace("MISSING", missing)).replace(
        "if (process.platform === 'darwin') {", "if (true) {"
    )
    result = subprocess.run(
        [str(pc.locate_tools().node), "--input-type=module", "-e", probe],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    assert result.returncode != 0
    message = "native memory usage missing" if missing == "usage" else "native swap missing"
    assert message in result.stderr
    assert "hostile child reaped:" in result.stderr


def test_library_probe_rejects_non_positive_readiness() -> None:
    """Reject a readiness bound that could never be met before building the program."""
    with pytest.raises(ValueError, match="ready_ms"):
        pc.resource_sampler_probe(ready_ms=0)
