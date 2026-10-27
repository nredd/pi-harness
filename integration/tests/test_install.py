"""Installer units against the real promoted snapshot, with a fake `pi` standing in for npm.

The network-facing verification (`gh attestation verify`, release downloads) is exercised for
real by `scenarios/installer`; here it is replaced at the module seams so every planning,
consent, staging, switch and recovery path runs offline.

References:
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md
"""

from __future__ import annotations

import ast
import builtins
import hashlib
import io
import json
import os
import shutil
import socket
import subprocess
import sys
import tarfile
from pathlib import Path
from textwrap import dedent
from typing import TYPE_CHECKING, Any

import pytest
import yaml

from harness import install
from harness.install import (
    ConsentError,
    ExitCode,
    InstallError,
    Journal,
    Layout,
    Options,
    RollbackError,
    UnsupportedError,
    VerificationError,
    Verified,
    plan_install,
    preflight,
    required_node,
    rollback,
    switch,
    verify_release,
    verify_snapshot,
)
from harness.promotion import (
    SNAPSHOT_REPO,
    SNAPSHOT_SIGNER_WORKFLOW,
    SNAPSHOT_SOURCE_REF,
    StackSnapshot,
    load_promoted_snapshot,
)
from harness.release import GITHUB_TOKEN_VARIABLES, release_asset_url
from harness.stack import package_declarations, source_string
from scenarios.installer import test_installer as acceptance

if TYPE_CHECKING:
    from collections.abc import Callable, Mapping

FIXTURE = Path(__file__).parent / "fixtures" / "stack-snapshot-24889f7.json"
INTEGRATION = Path(__file__).resolve().parent.parent
INSTALLER_WORKFLOW = INTEGRATION.parent / ".github" / "workflows" / "installer.yml"
SHA = "24889f7896be7157bf9077a41465a3b29620879f"
FAKE_PI = """\
#!{python}
# Fake `pi`: `install npm:<name>@<version>` writes the package and its lockfile entry.
import json, os, pathlib, sys
if sys.argv[1:] == ["--version"]:
    leaked = sorted(set(os.environ).intersection({tokens!r}))
    print("1.3.0", *(["LEAKED", *leaked] if leaked else []))
    sys.exit(0)
source = sys.argv[2]
agent = pathlib.Path(os.environ["PI_CODING_AGENT_DIR"])
log = pathlib.Path({log!r})
with log.open("a") as handle:
    leaked = sorted(set(os.environ).intersection({tokens!r}))
    call = [source, os.environ.get("npm_config_ignore_scripts"), os.environ["HOME"], leaked]
    handle.write(json.dumps(call) + "\\n")
if source in {fail!r}:
    print("npm ERR! simulated", file=sys.stderr)
    sys.exit(1)
name, version = source.removeprefix("npm:").rsplit("@", 1)
package = agent / "npm" / "node_modules" / name
package.mkdir(parents=True, exist_ok=True)
(package / "package.json").write_text(json.dumps({{"name": name, "version": version}}))
lock_path = agent / "npm" / "package-lock.json"
lock = json.loads(lock_path.read_text()) if lock_path.exists() else {{"packages": {{}}}}
integrity = {integrity!r}.get(f"{{name}}@{{version}}", "sha512-thirdparty")
lock["packages"][f"node_modules/{{name}}"] = {{"version": version, "integrity": integrity}}
lock_path.write_text(json.dumps(lock))
"""


def real_snapshot() -> StackSnapshot:
    """Load the real `stack/24889f7` promotion bytes.

    Returns:
        StackSnapshot: the validated published snapshot.
    """
    return load_promoted_snapshot(FIXTURE.read_bytes(), SHA)


def owned_integrity(snapshot: StackSnapshot) -> dict[str, str]:
    """Map owned package tags to the integrity the promotion verified.

    Parameters:
        snapshot (StackSnapshot): verified snapshot.

    Returns:
        dict[str, str]: `<name>@<version>` -> SRI integrity.
    """
    return {item.package: item.integrity for item in snapshot.gates.owned_packages}


class Harness:
    """One isolated HOME plus a fake core whose `pi` records every install."""

    def __init__(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        """Prepare the HOME and patch the network seams.

        Parameters:
            tmp_path (Path): private directory.
            monkeypatch (pytest.MonkeyPatch): module patcher.
        """
        self.home = (tmp_path / "home").resolve()
        self.home.mkdir()
        self.log = tmp_path / "pi-calls.jsonl"
        self.snapshot = real_snapshot()
        self.integrity = owned_integrity(self.snapshot)
        self.fail: list[str] = []
        self.monkeypatch = monkeypatch
        sources = [source_string(package) for package in self.snapshot.stack.sources]
        self.verified = Verified(self.snapshot, sources, {})
        self.fetched: list[Mapping[str, str] | None] = []
        self.env = {"PATH": str(self.home / ".local" / "bin")}
        monkeypatch.setattr(install.Path, "home", classmethod(lambda cls: self.home))
        monkeypatch.setattr(install, "preflight", lambda system, machine: {"node": "node"})
        monkeypatch.setattr(install, "verify_snapshot", lambda sha, workdir: self.snapshot)
        monkeypatch.setattr(install, "verify_release", lambda snapshot, node, workdir: self.verified)
        monkeypatch.setattr(install, "fetch_release", self.fetch_release)

    @property
    def layout(self) -> Layout:
        """The installer layout for this HOME."""
        return Layout.from_env(self.env, self.home, None)

    def fetch_release(
        self,
        tag: str,
        prefix: Path,
        provenance: object = None,
        checksums: Mapping[str, str] | None = None,
    ) -> Path:
        """Write a fake core prefix whose `pi` is the recording fake.

        Parameters:
            tag (str): core tag.
            prefix (Path): empty prefix.
            provenance (object): ignored verifier.
            checksums (Mapping[str, str] | None): recorded digests the download is bound to.

        Returns:
            Path: the fake executable.
        """
        self.fetched.append(checksums)
        binary = prefix / "bin" / "pi"
        binary.parent.mkdir(parents=True)
        binary.write_text(
            FAKE_PI.format(
                python=sys.executable,
                log=str(self.log),
                fail=self.fail,
                integrity=self.integrity,
                tokens=sorted(GITHUB_TOKEN_VARIABLES),
            )
        )
        binary.chmod(0o755)
        return binary

    def run(self, *, yes: bool = False, ask: Callable[[str], str] | None = None) -> ExitCode:
        """Run the installer for the real snapshot.

        Parameters:
            yes (bool): `--yes`.
            ask (Callable[[str], str] | None): prompt, `None` for a non-interactive run.

        Returns:
            ExitCode: the outcome.
        """
        return install.run(Options(SHA, yes, False, None), self.env, ask)

    def calls(self) -> list[list[Any]]:
        """Return every recorded `pi install`.

        Returns:
            list[list[Any]]: `[source, ignore_scripts, HOME, leaked token variables]` per call.
        """
        return [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []


def tree(root: Path) -> dict[str, str | bytes]:
    """Capture every file and link under a directory.

    Parameters:
        root (Path): directory.

    Returns:
        dict[str, str | bytes]: relative path -> bytes, or `-> target` for links.
    """
    captured: dict[str, str | bytes] = {}
    for path in sorted(root.rglob("*")):
        relative = str(path.relative_to(root))
        if path.is_symlink():
            captured[relative] = f"-> {path.readlink()}"
        elif path.is_file():
            captured[relative] = path.read_bytes()
    return captured


def seed_existing(home: Path) -> dict[str, Any]:
    """Write an existing personal Pi setup the installer must not lose.

    Parameters:
        home (Path): HOME.

    Returns:
        dict[str, Any]: the seeded settings.
    """
    agent = home / ".pi" / "agent"
    (agent / "npm" / "node_modules" / "mine").mkdir(parents=True)
    (agent / "npm" / "node_modules" / "mine" / "package.json").write_text('{"name":"mine","version":"1.0.0"}')
    settings = {"defaultModel": "my-model", "quietStartup": False, "packages": ["npm:mine@1.0.0"]}
    (agent / "settings.json").write_text(json.dumps(settings))
    (agent / "auth.json").write_text('{"anthropic":{"token":"secret"}}')
    (agent / "models.json").write_text('{"providers":{}}')
    (agent / "subagents.json").write_text('{"defaultModel":"x"}')
    (home / ".local" / "bin").mkdir(parents=True)
    (home / ".local" / "bin" / "pi").write_text("#!/bin/sh\necho brew pi\n")
    return settings


def test_real_snapshot_fixture_is_the_published_promotion() -> None:
    """The fixture is byte-for-byte the `stack/24889f7` asset, so filters come from a real promotion."""
    snapshot = real_snapshot()
    preset = snapshot.stack.sources[0]
    assert not isinstance(preset, str)
    assert preset.extensions == ["extensions/expanded-footer.ts"]
    assert preset.skills == preset.prompts == preset.themes == []
    assert set(snapshot.stack.disabled_extensions) == {"npm:@nredd/pi-computer-use@0.5.2"}


def test_fresh_install_reproduces_snapshot(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A clean HOME gets the exact order, filters, settings and disabled policy, with no prompt."""
    harness = Harness(tmp_path, monkeypatch)
    assert harness.run() == ExitCode.OK
    stack, layout = harness.snapshot.stack, harness.layout
    settings = json.loads((layout.agent_dir / "settings.json").read_text())
    assert settings == stack.settings | {"packages": package_declarations(stack, harness.verified.sources)}
    assert settings["packages"][0] == {
        "source": "npm:@nredd/pi-preset@0.2.0",
        "extensions": ["extensions/expanded-footer.ts"],
        "skills": [],
        "prompts": [],
        "themes": [],
    }
    assert {"source": "npm:@nredd/pi-computer-use@0.5.2", "extensions": []} in settings["packages"]
    assert json.loads((layout.agent_dir / "subagents.json").read_text()) == {"packageAgents": False}
    calls = harness.calls()
    assert [call[0] for call in calls] == harness.verified.sources
    assert {call[0] for call in calls if call[1] == "true"} == {"npm:@nredd/pi-computer-use@0.5.2"}
    assert all(not call[2].startswith(str(harness.home / ".pi")) for call in calls)
    assert layout.link.readlink() == layout.core(stack.core.tag) / "bin" / "pi"
    state = json.loads(layout.state.read_text())
    assert (state["source_sha"], state["stack_sha256"]) == (SHA, harness.snapshot.stack_sha256)
    assert not layout.journal.exists()
    assert not any((layout.root / "staging").iterdir())
    assert not (layout.agent_dir / "auth.json").exists()


def test_rerun_changes_nothing(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A repeat run of the same stack is a verified no-op."""
    harness = Harness(tmp_path, monkeypatch)
    harness.run()
    before, calls = tree(harness.home), len(harness.calls())
    assert harness.run() == ExitCode.OK
    assert tree(harness.home) == before
    assert len(harness.calls()) == calls


def test_rerun_repairs_drift(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A tampered package version is detected and reinstalled, with consent for the overwrite."""
    harness = Harness(tmp_path, monkeypatch)
    harness.run()
    manifest = harness.layout.agent_dir / "npm" / "node_modules" / "pi-memory" / "package.json"
    manifest.write_text('{"name":"pi-memory","version":"9.9.9"}')
    with pytest.raises(ConsentError):
        harness.run()
    assert harness.run(yes=True) == ExitCode.OK
    assert json.loads(manifest.read_text())["version"] == "0.4.2"


def test_existing_config_needs_consent_and_is_untouched(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Without `--yes` or a terminal yes, an existing setup is left byte-identical."""
    harness = Harness(tmp_path, monkeypatch)
    seed_existing(harness.home)
    before = tree(harness.home)
    with pytest.raises(ConsentError, match="--yes"):
        harness.run()
    with pytest.raises(ConsentError, match="Declined"):
        harness.run(ask=lambda prompt: "n")
    assert {k: v for k, v in tree(harness.home).items() if "pi-stack" not in k} == before
    assert harness.calls() == []


@pytest.mark.parametrize("recovering", [False, True])
def test_eof_prompt_declines_without_changes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture, recovering: bool
) -> None:
    """Both normal overwrite and interrupted-run recovery prompts map EOF to clean declined consent."""
    harness = Harness(tmp_path, monkeypatch)
    seed_existing(harness.home)
    if recovering:
        interrupt(harness, monkeypatch)
    before = {k: v for k, v in tree(harness.home).items() if not k.endswith("pi-stack/lock")}
    calls = harness.calls()

    def eof(prompt: str) -> str:
        """Model a terminal closing while input waits for consent."""
        raise EOFError

    with pytest.raises(ConsentError, match="nothing changed"):
        harness.run(ask=eof)
    monkeypatch.setattr(builtins, "input", eof)
    monkeypatch.setattr(sys.stdin, "isatty", lambda: True)
    monkeypatch.setenv("HOME", str(harness.home))
    monkeypatch.setenv("PI_CODING_AGENT_DIR", str(harness.layout.agent_dir))
    monkeypatch.setenv("XDG_DATA_HOME", str(harness.layout.root.parent))
    assert install.main([SHA]) == ExitCode.CONSENT
    assert "NOT APPLIED:" in caplog.text
    assert "nothing changed" in caplog.text
    assert {k: v for k, v in tree(harness.home).items() if not k.endswith("pi-stack/lock")} == before
    assert harness.calls() == calls


def test_existing_config_preserved_with_consent(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Agreeing keeps credentials and unrelated settings, and backs up everything replaced."""
    harness = Harness(tmp_path, monkeypatch)
    seeded = seed_existing(harness.home)
    agent = harness.layout.agent_dir
    auth, models = (agent / "auth.json").read_bytes(), (agent / "models.json").read_bytes()
    prompts: list[str] = []
    assert harness.run(ask=lambda prompt: prompts.append(prompt) or "y") == ExitCode.OK
    assert len(prompts) == 1
    assert (agent / "auth.json").read_bytes() == auth
    assert (agent / "models.json").read_bytes() == models
    settings = json.loads((agent / "settings.json").read_text())
    assert settings["defaultModel"] == "my-model"
    assert settings["quietStartup"] is True
    assert "npm:mine@1.0.0" not in settings["packages"]
    assert json.loads((agent / "subagents.json").read_text()) == {"defaultModel": "x", "packageAgents": False}
    (backup,) = (harness.layout.root / "backups").iterdir()
    assert json.loads((backup / "settings.json").read_text()) == seeded
    assert (backup / "npm" / "node_modules" / "mine" / "package.json").is_file()
    assert (backup / "bin-pi").read_text() == "#!/bin/sh\necho brew pi\n"
    assert harness.layout.link.is_symlink()


def test_plan_lists_overwrites_for_existing_setup(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """The plan names every replaced path and every package that stops loading."""
    harness = Harness(tmp_path, monkeypatch)
    seed_existing(harness.home)
    plan = plan_install(harness.layout, harness.verified)
    text = "\n".join(plan.overwrites)
    assert "package tree" in text
    assert "npm:mine@1.0.0" in text
    assert "brew" not in text
    assert "settings.json" in text
    assert "subagents.json" in text
    assert str(harness.layout.link) in text


def test_staging_failure_changes_nothing(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A failed `pi install` leaves the live tree identical and no staging behind."""
    harness = Harness(tmp_path, monkeypatch)
    seed_existing(harness.home)
    harness.fail.append("npm:pi-memory@0.4.2")
    before = {k: v for k, v in tree(harness.home).items() if "pi-stack" not in k}
    with pytest.raises(InstallError, match="pi-memory"):
        harness.run(yes=True)
    assert {k: v for k, v in tree(harness.home).items() if "pi-stack" not in k} == before
    assert not harness.layout.journal.exists()
    assert not any((harness.layout.root / "staging").iterdir())


def test_owned_integrity_mismatch_is_refused(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """An owned package whose npm integrity differs from the promotion is never switched in."""
    harness = Harness(tmp_path, monkeypatch)
    harness.integrity["@nredd/pi-todo@2.13.10"] = "sha512-" + "B" * 86 + "=="
    with pytest.raises(InstallError, match="pi-todo"):
        harness.run()
    assert not (harness.layout.agent_dir / "settings.json").exists()


def test_switch_failure_rolls_back(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A failure mid-switch restores the previous state before reporting."""
    harness = Harness(tmp_path, monkeypatch)
    seed_existing(harness.home)
    before = {k: v for k, v in tree(harness.home).items() if "pi-stack" not in k}

    def refuse(self: Path, target: Path | str) -> None:
        """Fail the final link step.

        Parameters:
            self (Path): link path.
            target (Path | str): link target.

        Raises:
            OSError: always.
        """
        raise OSError("disk full")

    monkeypatch.setattr(install.Path, "symlink_to", refuse)
    with pytest.raises(InstallError, match="rolled back"):
        harness.run(yes=True)
    assert {k: v for k, v in tree(harness.home).items() if "pi-stack" not in k} == before
    assert not harness.layout.journal.exists()


def test_interrupted_switch_is_restored(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A switch killed midway (no rollback ran) is restored exactly from its journal."""
    harness = Harness(tmp_path, monkeypatch)
    seed_existing(harness.home)
    before = {k: v for k, v in tree(harness.home).items() if "pi-stack" not in k}
    layout = harness.layout
    plan = plan_install(layout, harness.verified)
    layout.root.mkdir(parents=True)
    staged = install.stage(layout, harness.verified, plan, layout.root / "staging" / "x")

    class Killed(BaseException):
        """Stands in for SIGKILL: nothing after it runs."""

    def kill(self: Path, target: Path | str) -> None:
        """Die at the link step, after packages and settings were switched.

        Parameters:
            self (Path): link path.
            target (Path | str): link target.

        Raises:
            Killed: always.
        """
        raise Killed

    with monkeypatch.context() as patch:
        patch.setattr(install.Path, "symlink_to", kill)
        with pytest.raises(Killed):
            switch(layout, harness.verified, plan, staged, Journal(layout, layout.root / "backups" / "b"))
    assert layout.journal.exists()
    assert json.loads((layout.agent_dir / "settings.json").read_text())["quietStartup"] is True
    with pytest.raises(ConsentError):
        harness.run()
    assert layout.journal.exists()
    rollback(layout)
    assert {k: v for k, v in tree(harness.home).items() if "pi-stack" not in k} == before
    assert not layout.journal.exists()


def test_missing_expected_backup_keeps_journal_and_live_targets(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A lost backup is not proof that its journaled replacement never started."""
    harness = Harness(tmp_path, monkeypatch)
    seed_existing(harness.home)
    interrupt(harness, monkeypatch)
    layout = harness.layout
    document = json.loads(layout.journal.read_text())
    backup = Path(next(step["backup"] for step in document["steps"] if step["backup"]))
    install.remove(backup)
    before = tree(harness.home)
    with pytest.raises(RollbackError, match=r"Expected backup.*missing"):
        rollback(layout)
    assert tree(harness.home) == before
    assert layout.journal.exists()


@pytest.mark.parametrize("moment", ["after-check", "during-rename"])
def test_backup_store_swap_cannot_redirect_backups(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, moment: str
) -> None:
    """Swap AFTER apply's final check; writes stay anchored and lost backups cannot commit recovery."""
    harness = Harness(tmp_path, monkeypatch)
    seed_existing(harness.home)
    layout = harness.layout
    outside, held = tmp_path / "outside", tmp_path / "held-backups"
    outside.mkdir()
    attacked = False
    original_switch, original_replace = install.switch, os.replace

    def swap_store() -> None:
        """Replace the checked store with an attacker-controlled symlink."""
        nonlocal attacked
        attacked = True
        layout.backups.mkdir(parents=True, exist_ok=True)
        layout.backups.rename(held)
        layout.backups.symlink_to(outside)

    def before_switch(*args: Any, **kwargs: Any) -> None:
        """Swap after the last kind check but before switch opens its directory."""
        swap_store()
        original_switch(*args, **kwargs)

    def during_replace(src: Any, dst: Any, **kwargs: Any) -> None:
        """Swap at the actual rename, then hide it with an empty real store before rollback."""
        if Path(src) != layout.agent_dir / "npm":
            original_replace(src, dst, **kwargs)
            return
        swap_store()
        # The attacker prepares the same per-run directory so the old path-based rename succeeds.
        for directory in held.iterdir():
            (outside / directory.name).mkdir()
        try:
            original_replace(src, dst, **kwargs)
        finally:
            layout.backups.unlink()
            layout.backups.mkdir()

    if moment == "after-check":
        monkeypatch.setattr(install, "switch", before_switch)
        with pytest.raises(InstallError):
            harness.run(yes=True)
        assert not layout.journal.exists()
    else:
        monkeypatch.setattr(os, "replace", during_replace)
        monkeypatch.setattr(install, "checked_version", lambda *args: (_ for _ in ()).throw(OSError("fail")))
        with pytest.raises(RollbackError):
            harness.run(yes=True)
        assert layout.journal.exists()
        assert list(held.glob("*/npm/node_modules/mine/package.json"))
    assert attacked
    assert tree(outside) == {}


def test_rollback_store_swap_restores_from_open_directory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An ancestor swapped at the recovery rename cannot substitute an attacker's backup."""
    harness = Harness(tmp_path, monkeypatch)
    seed_existing(harness.home)
    interrupt(harness, monkeypatch)
    layout = harness.layout
    outside, held = tmp_path / "outside", tmp_path / "held"
    outside.mkdir()
    document = json.loads(layout.journal.read_text())
    fake = outside / Path(document["backups"]).name / "npm"
    fake.mkdir(parents=True)
    (fake / "attacker").write_text("not the original")
    original = os.replace
    attacked = False

    def swap(src: Any, dst: Any, **kwargs: Any) -> None:
        """Replace the ancestor after validation but at the restore syscall boundary."""
        nonlocal attacked
        if Path(dst) == layout.agent_dir / "npm":
            attacked = True
            layout.backups.rename(held)
            layout.backups.symlink_to(outside)
        original(src, dst, **kwargs)

    monkeypatch.setattr(os, "replace", swap)
    with pytest.raises(RollbackError):
        rollback(layout)
    assert attacked
    assert (layout.agent_dir / "npm" / "node_modules" / "mine" / "package.json").is_file()
    assert not (layout.agent_dir / "npm" / "attacker").exists()
    assert (fake / "attacker").read_text() == "not the original"
    assert layout.journal.exists()


def test_rerun_after_interruption_recovers_then_installs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """With consent, a rerun restores the interrupted switch and then installs cleanly."""
    harness = Harness(tmp_path, monkeypatch)
    layout = harness.layout
    plan = plan_install(layout, harness.verified)
    layout.root.mkdir(parents=True)
    staged = install.stage(layout, harness.verified, plan, layout.root / "staging" / "x")
    journal = Journal(layout, layout.root / "backups" / "b")
    journal.backups.mkdir(parents=True)
    journal.record(layout.agent_dir / "npm", "npm")
    layout.agent_dir.mkdir(parents=True)
    assert staged is not None
    (staged / "npm").replace(layout.agent_dir / "npm")
    assert harness.run(yes=True) == ExitCode.OK
    assert not layout.journal.exists()
    assert json.loads(layout.state.read_text())["source_sha"] == SHA


def test_preflight_reports_every_problem() -> None:
    """Platform and every missing tool are reported together, before anything changes."""
    with pytest.raises(UnsupportedError) as error:
        preflight("Windows", "AMD64", lambda name: None)
    message = str(error.value)
    assert "Windows/AMD64" in message
    assert all(f"`{tool}` not found" in message for tool in ("gh", "node", "npm"))


@pytest.mark.parametrize("pending_journal", [False, True])
@pytest.mark.parametrize("flags", [[], ["--yes"], ["--plan"]], ids=["normal", "yes", "plan"])
@pytest.mark.parametrize("missing_attrs", [False, True], ids=["unix-attrs-present", "unix-attrs-absent"])
@pytest.mark.parametrize("missing_fcntl", [False, True], ids=["fcntl-present", "fcntl-absent"])
def test_windows_without_fcntl_refuses_cleanly(
    tmp_path: Path, pending_journal: bool, flags: list[str], missing_attrs: bool, missing_fcntl: bool
) -> None:
    """Regression: pending --plan bypassed admission; other combinations guard the platform boundary."""
    home = tmp_path / "home"
    home.mkdir()
    root = home / ".local" / "share" / "pi-stack"
    if pending_journal:
        root.mkdir(parents=True)
        (root / "transaction.json").write_text("{}")
    before = tree(home)
    script = dedent("""\
        import os, platform, sys
        if sys.argv.pop(1) == 'True':
            sys.modules['fcntl'] = None
        if sys.argv.pop(1) == 'True':
            for name in ('O_NOFOLLOW', 'O_DIRECTORY', 'O_NONBLOCK', 'O_NOCTTY', 'getuid', 'fchmod'):
                if hasattr(os, name):
                    delattr(os, name)
        platform.system = lambda: 'Windows'
        platform.machine = lambda: 'AMD64'
        from harness.install import main
        sys.exit(main(sys.argv[1:]))
    """)
    result = subprocess.run(
        [sys.executable, "-c", script, str(missing_fcntl), str(missing_attrs), SHA, *flags],
        env={"HOME": str(home), "USERPROFILE": str(home), "PATH": os.defpath, "PYTHONPATH": str(INTEGRATION)},
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    assert result.returncode == ExitCode.UNSUPPORTED, result.stderr
    assert "UNSUPPORTED:" in result.stderr
    assert "Windows/AMD64" in result.stderr
    assert "nothing changed" in result.stderr
    assert "Traceback" not in result.stderr
    assert tree(home) == before


@pytest.mark.parametrize(
    "missing",
    [
        "os.O_NOFOLLOW",
        "os.O_DIRECTORY",
        "os.O_NONBLOCK",
        "os.O_NOCTTY",
        "os.getuid",
        "os.fchmod",
        "fcntl",
        "fcntl.flock",
        "fcntl.LOCK_EX",
        "fcntl.LOCK_NB",
    ],
)
def test_missing_unix_primitive_refuses_before_pending_plan(tmp_path: Path, missing: str) -> None:
    """Regression: even an allowlisted platform cannot report a journal without required primitives."""
    home = tmp_path / "home"
    root = home / ".local" / "share" / "pi-stack"
    root.mkdir(parents=True)
    (root / "transaction.json").write_text("{}")
    before = tree(home)
    script = dedent("""\
        import os, platform, sys
        missing = sys.argv.pop(1)
        if missing == 'fcntl':
            sys.modules['fcntl'] = None
        if missing.startswith('os.'):
            delattr(os, missing.split('.')[1])
        from harness import install
        if missing.startswith('fcntl.'):
            delattr(install.fcntl, missing.split('.')[1])
        platform.system = lambda: 'Linux'
        platform.machine = lambda: 'x86_64'
        sys.exit(install.main(sys.argv[1:]))
    """)
    result = subprocess.run(
        [sys.executable, "-c", script, missing, SHA, "--plan"],
        env={"HOME": str(home), "PATH": os.defpath, "PYTHONPATH": str(INTEGRATION)},
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    assert result.returncode == ExitCode.UNSUPPORTED, result.stderr
    assert "UNSUPPORTED:" in result.stderr
    assert missing in result.stderr
    assert "nothing changed" in result.stderr
    assert "Traceback" not in result.stderr
    assert tree(home) == before


def test_preflight_accepts_tested_platforms(tmp_path: Path) -> None:
    """Supported platforms with every tool present return absolute tool paths."""
    tool = tmp_path / "tool"
    tool.touch()
    for system, machine in install.SUPPORTED_PLATFORMS:
        # Not detected: the unit gate also runs on WSL hosts, where `wsl=None` would refuse.
        assert preflight(system, machine, lambda name: str(tool), wsl=False) == dict.fromkeys(
            install.REQUIRED_TOOLS, str(tool)
        )
    with pytest.raises(UnsupportedError, match="Linux/aarch64"):
        preflight("Linux", "aarch64", lambda name: str(tool), wsl=False)


def core_manifest() -> dict[str, Any]:
    """Return the consumed fields of the shipped coding-agent package.json.

    Returns:
        dict[str, Any]: valid core metadata before a test mutates one field.
    """
    return {
        "name": "@earendil-works/pi-coding-agent",
        "version": "1.3.0",
        "bin": {"pi": "dist/bundle/cli.js"},
        "engines": {"node": ">=22.19.0"},
    }


def make_tarball(path: Path, manifest: object) -> Path:
    """Write a release-shaped tarball with one `package/package.json`.

    Parameters:
        path (Path): tarball path.
        manifest (object): JSON document, including deliberately malformed test values.

    Returns:
        Path: `path`.
    """
    data = json.dumps(manifest).encode()
    with tarfile.open(path, "w:gz") as archive:
        info = tarfile.TarInfo("package/package.json")
        info.size = len(data)
        archive.addfile(info, io.BytesIO(data))
    return path


def test_required_node_reads_core_engines(tmp_path: Path) -> None:
    """The minimum Node.js comes from the verified core manifest; other range forms are refused."""
    assert required_node(make_tarball(tmp_path / "a.tgz", core_manifest())) == (22, 19, 0)
    with pytest.raises(VerificationError, match=r"engines\.node"):
        required_node(make_tarball(tmp_path / "b.tgz", core_manifest() | {"engines": {"node": "^22"}}))


@pytest.mark.parametrize("field", ["manifest", "name", "version", "engines", "engines.node", "bin", "bin.pi"])
@pytest.mark.parametrize("value", [[], "", 1, None, {}, False])
def test_malformed_verified_core_manifest_is_verification_failure(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    field: str,
    value: object,
) -> None:
    """Digest verification does not excuse bad metadata: every consumed shape fails cleanly with exit 3."""
    manifest: Any = core_manifest()
    if field == "manifest":
        manifest = value
    elif "." in field:
        parent, key = field.split(".")
        manifest[parent][key] = value
    else:
        manifest[field] = value
    tarball = make_tarball(tmp_path / "core.tgz", manifest)
    url = "https://example.invalid/core.tgz"
    digest = hashlib.sha256(tarball.read_bytes()).hexdigest()
    before = tree(tmp_path)

    def verify_metadata(opts: Options, env: object, ask: object) -> ExitCode:
        """Exercise the real digest and manifest readers through the CLI outcome boundary."""
        install.verify_asset(tarball, url, {url: digest})
        required_node(tarball)
        return ExitCode.OK

    monkeypatch.setattr(install, "run", verify_metadata)
    assert install.main([SHA]) == ExitCode.VERIFICATION
    assert "VERIFICATION FAILED, nothing changed" in caplog.text
    offending = field
    if field == "manifest":
        offending = "name" if isinstance(value, dict) else "root"
    elif isinstance(value, dict) and field in {"engines", "bin"}:
        offending = "engines.node" if field == "engines" else "bin.pi"
    assert f"`{offending}`" in caplog.text
    assert "Traceback" not in caplog.text
    assert tree(tmp_path) == before


@pytest.mark.parametrize("field", ["name", "version", "engines", "engines.node", "bin", "bin.pi"])
def test_core_manifest_missing_field_guard(tmp_path: Path, field: str) -> None:
    """Guard coverage, not a new regression: omitted required metadata was already refused."""
    manifest = core_manifest()
    target = manifest
    key = field
    if "." in field:
        parent, key = field.split(".")
        target = manifest[parent]
    del target[key]
    tarball = make_tarball(tmp_path / "core.tgz", manifest)
    with pytest.raises(VerificationError) as raised:
        required_node(tarball)
    assert f"`{field}`" in str(raised.value)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("name", "wrong-package"),
        ("version", "not-a-version"),
        ("bin.pi", " \t "),
    ],
)
def test_core_manifest_nonempty_bad_value_guard(tmp_path: Path, field: str, value: str) -> None:
    """Guard coverage: wrong nonempty identity/version and blank CLI paths were already refused."""
    manifest = core_manifest()
    if field == "bin.pi":
        manifest["bin"]["pi"] = value
    else:
        manifest[field] = value
    with pytest.raises(VerificationError) as raised:
        required_node(make_tarball(tmp_path / "core.tgz", manifest))
    assert f"`{field}`" in str(raised.value)


def test_old_node_is_refused(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Node.js older than the core's engine is a prerequisite failure, not a later crash."""
    snapshot = real_snapshot()
    workdir = tmp_path
    (workdir / "core").mkdir()
    make_tarball(workdir / "core" / "earendil-works-pi-coding-agent-1.3.0.tgz", core_manifest())
    monkeypatch.setattr(install, "validate_release_identity", lambda stack, tag, checksums: None)
    monkeypatch.setattr(install, "release_checksums", lambda tag: {})
    monkeypatch.setattr(install, "verify_core_assets", lambda stack, path, attest: None)
    monkeypatch.setattr(install, "node_version", lambda node: (20, 11, 0))
    with pytest.raises(UnsupportedError, match=r"Node\.js 20\.11\.0 is older than the 22\.19\.0"):
        install.verify_release(snapshot, "node", workdir)


def serve_snapshot(monkeypatch: pytest.MonkeyPatch, contents: bytes) -> list[tuple[str, ...]]:
    """Serve snapshot bytes and record attestation verification calls.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): module patcher.
        contents (bytes): bytes the release URL returns.

    Returns:
        list[tuple[str, ...]]: recorded `(repo, signer, ref)` identities.
    """
    identities: list[tuple[str, ...]] = []

    def fake_download(url: str, destination: Path) -> Path:
        """Write the served bytes.

        Parameters:
            url (str): requested URL.
            destination (Path): output.

        Returns:
            Path: `destination`.
        """
        assert url == f"https://github.com/nredd/pi-harness/releases/download/stack/{SHA}/stack-snapshot.json"
        destination.write_bytes(contents)
        return destination

    monkeypatch.setattr(install, "download", fake_download)
    monkeypatch.setattr(
        install,
        "verify_public_attestation",
        lambda path, repo, signer, ref: identities.append((repo, signer, ref)),
    )
    return identities


def test_verify_snapshot_requires_the_expected_identity(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The attestation is checked against `promote-stack.yml` on `main` before the schema is read."""
    identities = serve_snapshot(monkeypatch, FIXTURE.read_bytes())
    assert verify_snapshot(SHA, tmp_path) == real_snapshot()
    assert identities == [(SNAPSHOT_REPO, SNAPSHOT_SIGNER_WORKFLOW, SNAPSHOT_SOURCE_REF)]
    assert SNAPSHOT_SIGNER_WORKFLOW == "nredd/pi-harness/.github/workflows/promote-stack.yml"


def test_verify_snapshot_rejects_failed_attestation(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A tampered or foreign-signed snapshot stops before anything is parsed or installed."""
    serve_snapshot(monkeypatch, FIXTURE.read_bytes())

    def reject(*args: object) -> None:
        """Reject like `gh attestation verify` on a digest mismatch.

        Parameters:
            *args (object): ignored.

        Raises:
            RuntimeError: always.
        """
        raise RuntimeError("no matching attestations found")

    monkeypatch.setattr(install, "verify_public_attestation", reject)
    with pytest.raises(VerificationError, match="attestation rejected"):
        verify_snapshot(SHA, tmp_path)


@pytest.mark.parametrize(
    ("change", "message"),
    [
        (lambda doc: doc | {"stack_sha256": "0" * 64}, "stack_sha256"),
        (lambda doc: doc | {"source_sha": "b" * 40}, "not the pinned"),
        (lambda doc: doc | {"extra": 1}, "extra"),
    ],
)
def test_verify_snapshot_rejects_invalid_contents(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    change: Callable[[dict[str, Any]], dict[str, Any]],
    message: str,
) -> None:
    """Even attested bytes must match the schema, the canonical digest and the pin."""
    document = change(json.loads(FIXTURE.read_bytes()))
    serve_snapshot(monkeypatch, json.dumps(document).encode())
    with pytest.raises(VerificationError, match=message):
        verify_snapshot(SHA, tmp_path)


def test_main_maps_outcomes_to_exit_codes(monkeypatch: pytest.MonkeyPatch) -> None:
    """A malformed pin is a usage refusal; verification failures have their own status."""
    assert install.main(["not-a-sha"]) == ExitCode.UNSUPPORTED

    def refuse(opts: Options, env: object, ask: object) -> ExitCode:
        """Fail verification.

        Parameters:
            opts (Options): options.
            env (object): environment.
            ask (object): prompt.

        Raises:
            VerificationError: always.
        """
        raise VerificationError("bad digest")

    monkeypatch.setattr(install, "run", refuse)
    assert install.main([SHA]) == ExitCode.VERIFICATION


def test_layout_honors_pi_and_xdg_locations(tmp_path: Path) -> None:
    """`PI_CODING_AGENT_DIR` and `XDG_DATA_HOME` move the managed paths, as they move Pi's."""
    env = {"PI_CODING_AGENT_DIR": str(tmp_path / "agent"), "XDG_DATA_HOME": str(tmp_path / "data")}
    layout = Layout.from_env(env, tmp_path, tmp_path / "bin")
    assert layout.agent_dir == (tmp_path / "agent").resolve()
    assert layout.root == (tmp_path / "data" / "pi-stack").resolve()
    assert layout.link == (tmp_path / "bin").resolve() / "pi"


def test_unreadable_existing_settings_are_never_overwritten(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A corrupt `settings.json` stops the run instead of being replaced."""
    harness = Harness(tmp_path, monkeypatch)
    agent = harness.layout.agent_dir
    agent.mkdir(parents=True)
    (agent / "settings.json").write_text("{not json")
    with pytest.raises(InstallError, match="not readable JSON"):
        harness.run(yes=True)
    assert (agent / "settings.json").read_text() == "{not json"


def test_interrupted_update_restores_the_previous_state_record(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Killed right after the new `installed.json` lands, rollback restores the old record and tree."""
    harness = Harness(tmp_path, monkeypatch)
    harness.run()
    layout = harness.layout
    manifest = layout.agent_dir / "npm" / "node_modules" / "pi-memory" / "package.json"
    manifest.write_text('{"name":"pi-memory","version":"9.9.9"}')
    layout.state.write_text(json.dumps(json.loads(layout.state.read_text()) | {"note": "previous"}))
    before = tree(harness.home)
    plan = plan_install(layout, harness.verified)
    assert plan.install_packages
    staged = install.stage(layout, harness.verified, plan, layout.root / "staging" / "x")
    original = install.replace_file

    class Killed(BaseException):
        """Stands in for SIGKILL after the state record is written."""

    def kill_after_state(journal: Journal, live: Path, name: str, text: str) -> None:
        """Write the file, then die if it is the state record.

        Parameters:
            journal (Journal): step record.
            live (Path): file.
            name (str): backup name.
            text (str): contents.

        Raises:
            Killed: after writing `installed.json`.
        """
        original(journal, live, name, text)
        if name == install.STATE_FILE:
            raise Killed

    monkeypatch.setattr(install, "replace_file", kill_after_state)
    with pytest.raises(Killed):
        switch(layout, harness.verified, plan, staged, Journal(layout, layout.root / "backups" / "b"))
    assert json.loads(manifest.read_text())["version"] == "0.4.2"
    assert "note" not in json.loads(layout.state.read_text())
    rollback(layout)
    assert json.loads(layout.state.read_text())["note"] == "previous"
    after = tree(harness.home)
    for key in [key for key in before if "staging" not in key and "backups" not in key]:
        assert after.get(key) == before[key], key


SENTINEL = "ghp_sentinel-not-a-real-token"


def test_github_tokens_reach_no_child_but_gh(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """A caller's GitHub token never reaches `node`, `pi install` or the `pi --version` post-check."""
    for name in GITHUB_TOKEN_VARIABLES:
        monkeypatch.setenv(name, SENTINEL)
    caplog.set_level("INFO")
    harness = Harness(tmp_path, monkeypatch)
    assert harness.run() == ExitCode.OK
    assert all(call[3] == [] for call in harness.calls())
    assert "LEAKED" not in caplog.text
    assert SENTINEL not in caplog.text
    captured: list[tuple[list[str], dict[str, str]]] = []

    def record(argv: list[str], **kwargs: Any) -> str:
        """Record one child launch.

        Parameters:
            argv (list[str]): command.
            **kwargs (Any): subprocess options.

        Returns:
            str: a `node --version` answer.
        """
        captured.append((argv, kwargs["env"]))
        return "v22.19.0\n"

    monkeypatch.setattr(install.subprocess, "check_output", record)
    assert install.node_version("/usr/bin/node") == (22, 19, 0)
    assert install.post_check(harness.layout) == "v22.19.0"
    assert len(captured) == 2
    for argv, env in captured:
        assert not GITHUB_TOKEN_VARIABLES & set(env)
        assert SENTINEL not in [*argv, *env.values()]


def test_verify_release_binds_staged_core_to_the_snapshot(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The second (staging) download is checked against the snapshot digests, not a re-read list."""
    harness = Harness(tmp_path, monkeypatch)
    snapshot, tag = harness.snapshot, harness.snapshot.stack.core.tag
    (tmp_path / "work" / "core").mkdir(parents=True)
    make_tarball(
        tmp_path / "work" / "core" / "earendil-works-pi-coding-agent-1.3.0.tgz",
        core_manifest(),
    )
    recorded = {
        release_asset_url(tag, name): digest for name, digest in snapshot.stack.core.integrity.items()
    }
    extra = {release_asset_url(tag, "earendil-works-pi-ai-1.3.0.tgz"): "e" * 64}
    monkeypatch.setattr(install, "release_checksums", lambda release_tag: recorded | extra)
    monkeypatch.setattr(install, "verify_core_assets", lambda stack, path, attest: None)
    monkeypatch.setattr(install, "node_version", lambda node: (22, 19, 0))
    verified = verify_release(snapshot, "node", tmp_path / "work")
    assert verified.core_checksums == recorded | extra
    monkeypatch.setattr(install, "verify_release", lambda snapshot, node, workdir: verified)
    assert harness.run() == ExitCode.OK
    assert harness.fetched == [recorded | extra]


def test_verify_release_requires_integrity_for_installed_core_assets(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A snapshot that leaves `pi-tui` unrecorded cannot bind what npm would install."""
    snapshot = real_snapshot()
    core = snapshot.stack.core
    partial = {name: digest for name, digest in core.integrity.items() if "pi-tui" not in name}
    stack = snapshot.stack.model_copy(update={"core": core.model_copy(update={"integrity": partial})})
    monkeypatch.setattr(install, "verify_core_assets", lambda stack, path, attest: None)
    with pytest.raises(VerificationError, match="pi-tui"):
        install.verify_release(snapshot.model_copy(update={"stack": stack}), "node", tmp_path)


def test_verify_release_rejects_wrong_legacy_core_bytes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A legacy tag's manifest tarball must equal its frozen digest via the shared `verify_asset`."""

    def serve(url: str, destination: Path) -> Path:
        """Serve wrong bytes.

        Parameters:
            url (str): requested URL.
            destination (Path): output.

        Returns:
            Path: `destination`.
        """
        destination.write_bytes(b"not the release")
        return destination

    monkeypatch.setattr(install, "download", serve)
    monkeypatch.setattr(install, "verify_core_assets", lambda stack, path, attest: None)
    with pytest.raises(VerificationError, match="checksum mismatch"):
        install.verify_release(real_snapshot(), "node", tmp_path)


def test_cross_filesystem_layout_is_refused_before_any_change(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An installer root on another filesystem than the agent dir would fail mid-switch with EXDEV."""
    harness = Harness(tmp_path, monkeypatch)
    seed_existing(harness.home)
    before = tree(harness.home)
    agent = harness.layout.agent_dir
    monkeypatch.setattr(install, "device", lambda path: 2 if path == agent else 1)
    with pytest.raises(UnsupportedError, match="one filesystem"):
        harness.run(yes=True)
    assert tree(harness.home) == before
    assert not harness.layout.root.exists()


def test_device_uses_the_nearest_existing_ancestor(tmp_path: Path) -> None:
    """Paths that do not exist yet are judged by the directory they will be created in."""
    assert install.device(tmp_path / "a" / "b" / "c") == tmp_path.stat().st_dev


@pytest.mark.parametrize("name", ["settings.json", "subagents.json"])
def test_symlinked_settings_are_refused_before_any_change(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, name: str
) -> None:
    """A symlinked settings file would be replaced by a regular file and lost on rollback."""
    harness = Harness(tmp_path, monkeypatch)
    agent = harness.layout.agent_dir
    agent.mkdir(parents=True)
    target = tmp_path / "dotfiles" / name
    target.parent.mkdir()
    target.write_text('{"mine": true}')
    (agent / name).symlink_to(target)
    with pytest.raises(InstallError, match="symlink"):
        harness.run(yes=True)
    assert (agent / name).readlink() == target
    assert target.read_text() == '{"mine": true}'
    assert harness.calls() == []
    assert not (agent / "npm").exists()


def interrupt(harness: Harness, monkeypatch: pytest.MonkeyPatch) -> None:
    """Kill a switch at the link step, after packages and settings moved, leaving its journal.

    Parameters:
        harness (Harness): seeded HOME.
        monkeypatch (pytest.MonkeyPatch): module patcher.
    """
    layout = harness.layout
    plan = plan_install(layout, harness.verified)
    layout.root.mkdir(parents=True, exist_ok=True)
    staged = install.stage(layout, harness.verified, plan, layout.root / "staging" / "x")

    class Killed(BaseException):
        """Stands in for SIGKILL."""

    def kill(self: Path, target: Path | str) -> None:
        """Die at the link step.

        Parameters:
            self (Path): link path.
            target (Path | str): link target.

        Raises:
            Killed: always.
        """
        raise Killed

    with monkeypatch.context() as patch:
        patch.setattr(install.Path, "symlink_to", kill)
        with pytest.raises(Killed):
            switch(layout, harness.verified, plan, staged, Journal(layout, layout.root / "backups" / "b"))
    assert layout.journal.exists()


def test_interrupted_switch_is_restored_offline(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """Recovery needs no network and no tools: it runs before preflight and verification."""
    harness = Harness(tmp_path, monkeypatch)
    seed_existing(harness.home)
    before = {k: v for k, v in tree(harness.home).items() if "pi-stack" not in k}
    interrupt(harness, monkeypatch)

    def offline(*args: object) -> None:
        """Fail like a machine without network or `gh`.

        Parameters:
            *args (object): ignored.

        Raises:
            UnsupportedError: always.
        """
        raise UnsupportedError("`gh` not found on PATH")

    monkeypatch.setattr(install, "preflight", offline)
    assert harness.layout.journal.stat().st_mode & 0o777 == 0o600
    caplog.set_level("INFO")
    with pytest.raises(UnsupportedError, match="gh"):
        harness.run(yes=True)
    assert "This run restores them (with consent)" in caplog.text
    assert "next run" not in caplog.text
    assert not harness.layout.journal.exists()
    assert {k: v for k, v in tree(harness.home).items() if "pi-stack" not in k} == before


def edit_journal(harness: Harness, change: Callable[[dict[str, Any]], None]) -> None:
    """Rewrite the pending journal in place, keeping it private.

    Parameters:
        harness (Harness): HOME with a pending journal.
        change (Callable[[dict[str, Any]], None]): mutates the decoded journal.
    """
    journal = harness.layout.journal
    document = json.loads(journal.read_text())
    change(document)
    journal.write_text(json.dumps(document))


def add_step(target: Path | str, backup: Path | str | None = None) -> Callable[[dict[str, Any]], None]:
    """Build a journal edit appending one step.

    Parameters:
        target (Path | str): step target.
        backup (Path | str | None): step backup.

    Returns:
        Callable[[dict[str, Any]], None]: the edit.
    """

    def change(document: dict[str, Any]) -> None:
        """Append the step.

        Parameters:
            document (dict[str, Any]): decoded journal.
        """
        document["steps"].append({"target": str(target), "backup": None if backup is None else str(backup)})

    return change


def set_backup(name: str, backup: str) -> Callable[[dict[str, Any]], None]:
    """Build a journal edit pointing one recorded step's backup elsewhere.

    Parameters:
        name (str): final component of the step target.
        backup (str): new backup path.

    Returns:
        Callable[[dict[str, Any]], None]: the edit.
    """

    def change(document: dict[str, Any]) -> None:
        """Replace the backup.

        Parameters:
            document (dict[str, Any]): decoded journal.
        """
        (step,) = [step for step in document["steps"] if Path(step["target"]).name == name]
        step["backup"] = backup

    return change


def tamper_core(harness: Harness, outside: Path, case: str) -> None:
    """Make the pending journal name an untrusted versioned core prefix in one way.

    Parameters:
        harness (Harness): HOME with a pending journal.
        outside (Path): an unrelated directory the journal must never reach.
        case (str): which core tampering.

    Raises:
        ValueError: unknown case.
    """
    layout = harness.layout
    tag = harness.snapshot.stack.core.tag
    backup = layout.root / "backups" / "b" / f"core-{tag}"
    match case:
        case "core-unversioned-target":
            edit_journal(harness, add_step(layout.root / "core" / "main"))
        case "core-nested-target":
            edit_journal(harness, add_step(layout.core(tag) / "bin"))
        case "core-parent-symlink":
            shutil.rmtree(layout.root / "core", ignore_errors=True)
            (layout.root / "core").symlink_to(outside)
            edit_journal(harness, add_step(layout.core(tag)))
        case "core-file-backup":
            backup.write_text("not a directory")
            edit_journal(harness, add_step(layout.core(tag), backup))
        case _:
            raise ValueError(f"Unknown core tampering '{case}'")


def tamper(harness: Harness, outside: Path, case: str) -> None:
    """Make the pending journal untrusted in one way.

    Parameters:
        harness (Harness): HOME with a pending journal.
        outside (Path): an unrelated directory the journal must never reach.
        case (str): which tampering.

    Raises:
        ValueError: unknown case.
    """
    layout = harness.layout
    journal, backups = layout.journal, layout.root / "backups" / "b"
    agent = layout.agent_dir
    match case:
        case "outside-target":
            edit_journal(harness, add_step(outside))
        case "credentials-target":
            edit_journal(harness, add_step(agent / "auth.json"))
        case "traversal-target":
            edit_journal(harness, add_step(f"{agent / 'npm'}/../auth.json"))
        case "duplicate-target":
            edit_journal(harness, add_step(agent / "npm"))
        case "core-unversioned-target" | "core-nested-target" | "core-parent-symlink" | "core-file-backup":
            tamper_core(harness, outside, case)
        case "outside-backup":
            edit_journal(harness, set_backup("settings.json", str(outside / "settings.json")))
        case "traversal-backup":
            edit_journal(harness, set_backup("settings.json", f"{backups}/../c/settings.json"))
        case "traversal-backups-dir":
            edit_journal(harness, lambda document: document.update(backups=f"{backups}/.."))
        case "symlinked-backup":
            (backups / "settings.json").unlink()
            (backups / "settings.json").symlink_to(outside / "settings.json")
        case "directory-as-file-backup":
            (backups / "settings.json").unlink()
            (backups / "settings.json").mkdir()
        case "symlinked-backups-dir":
            moved = outside / "b"
            backups.replace(moved)
            backups.symlink_to(moved)
        case "symlinked-journal":
            copy = outside / "transaction.json"
            copy.write_text(journal.read_text())
            copy.chmod(0o600)
            journal.unlink()
            journal.symlink_to(copy)
        case "readable-journal":
            journal.chmod(0o644)
        case "corrupt-journal":
            journal.write_text("{not json")
        case "steps-not-a-list":
            edit_journal(harness, lambda document: document.update(steps={}))
        case "step-missing-backup":
            edit_journal(harness, lambda document: document["steps"].append({"target": str(agent / "npm")}))
        case _:
            raise ValueError(f"Unknown tampering '{case}'")


@pytest.mark.parametrize(
    "case",
    [
        "outside-target",
        "credentials-target",
        "traversal-target",
        "duplicate-target",
        "core-unversioned-target",
        "core-nested-target",
        "core-parent-symlink",
        "core-file-backup",
        "outside-backup",
        "traversal-backup",
        "traversal-backups-dir",
        "symlinked-backup",
        "directory-as-file-backup",
        "symlinked-backups-dir",
        "symlinked-journal",
        "readable-journal",
        "corrupt-journal",
        "steps-not-a-list",
        "step-missing-backup",
    ],
)
def test_untrusted_journal_changes_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, case: str, caplog: pytest.LogCaptureFixture
) -> None:
    """A journal naming anything but the switch's own paths and backups fails closed, untouched."""
    harness = Harness(tmp_path, monkeypatch)
    seed_existing(harness.home)
    interrupt(harness, monkeypatch)
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "settings.json").write_text('{"attacker": true}')
    (outside / "keep").write_text("keep")
    tamper(harness, outside, case)
    before = {k: v for k, v in tree(tmp_path).items() if not k.endswith("pi-stack/lock")}
    with pytest.raises(RollbackError, match="not trusted"):
        rollback(harness.layout)
    with pytest.raises(RollbackError, match="not trusted"):
        harness.run(yes=True)
    caplog.set_level("INFO")
    assert install.run(Options(SHA, False, True, None), harness.env, None) == ExitCode.OK
    assert "not trusted" in caplog.text
    assert "RESTORE" not in caplog.text
    assert {k: v for k, v in tree(tmp_path).items() if not k.endswith("pi-stack/lock")} == before
    assert harness.layout.journal.exists(follow_symlinks=False)


def test_dangling_package_tree_link_needs_consent(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A dangling `npm` link is existing state: the plan lists its overwrite and asks first."""
    harness = Harness(tmp_path, monkeypatch)
    agent = harness.layout.agent_dir
    agent.mkdir(parents=True)
    gone = tmp_path / "gone"
    (agent / "npm").symlink_to(gone)
    assert any(
        "'" + str(agent / "npm") + "'" in line
        for line in plan_install(harness.layout, harness.verified).overwrites
    )
    with pytest.raises(ConsentError):
        harness.run()
    assert (agent / "npm").readlink() == gone
    assert harness.calls() == []
    assert harness.run(yes=True) == ExitCode.OK
    (kept,) = (harness.layout.root / "backups").glob("*/npm")
    assert kept.readlink() == gone


def test_dangling_core_prefix_link_needs_consent(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A dangling core prefix link is replaced, so the plan lists it as an overwrite."""
    harness = Harness(tmp_path, monkeypatch)
    prefix = harness.layout.core(harness.snapshot.stack.core.tag)
    prefix.parent.mkdir(parents=True)
    prefix.symlink_to(tmp_path / "gone")
    plan = plan_install(harness.layout, harness.verified)
    assert any(str(prefix) in line for line in plan.overwrites)
    with pytest.raises(ConsentError):
        harness.run()
    assert prefix.is_symlink()


def test_plan_reports_a_pending_journal_without_planning(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """`--plan` names the pending restore and plans nothing against a half-switched tree."""
    harness = Harness(tmp_path, monkeypatch)
    seed_existing(harness.home)
    interrupt(harness, monkeypatch)
    before = tree(harness.home)

    def unreachable(*args: object) -> None:
        """Fail if verification or planning runs.

        Parameters:
            *args (object): ignored.

        Raises:
            AssertionError: always.
        """
        raise AssertionError("planned against a pending journal")

    monkeypatch.setattr(install, "verify_snapshot", unreachable)
    monkeypatch.setattr(install, "plan_install", unreachable)
    caplog.set_level("INFO")
    assert install.run(Options(SHA, False, True, None), harness.env, None) == ExitCode.OK
    assert "PENDING" in caplog.text
    assert "The next run without `--plan` restores them" in caplog.text
    assert f"RESTORE '{harness.layout.agent_dir / 'settings.json'}'" in caplog.text
    assert tree(harness.home) == before


def test_existing_git_tree_is_replaced_as_planned(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """The plan's `git` overwrite happens even though the stack stages no git package, and rolls back."""
    harness = Harness(tmp_path, monkeypatch)
    seed_existing(harness.home)
    git = harness.layout.agent_dir / "git" / "github.com" / "me" / "mine"
    git.mkdir(parents=True)
    (git / "index.ts").write_text("mine")
    assert any("git" in line for line in plan_install(harness.layout, harness.verified).overwrites)
    before = {k: v for k, v in tree(harness.home).items() if "pi-stack" not in k}

    def refuse(self: Path, target: Path | str) -> None:
        """Fail the final link step.

        Parameters:
            self (Path): link path.
            target (Path | str): link target.

        Raises:
            OSError: always.
        """
        raise OSError("disk full")

    with monkeypatch.context() as patch:
        patch.setattr(install.Path, "symlink_to", refuse)
        with pytest.raises(InstallError, match="rolled back"):
            harness.run(yes=True)
    assert {k: v for k, v in tree(harness.home).items() if "pi-stack" not in k} == before
    assert harness.run(yes=True) == ExitCode.OK
    assert not (harness.layout.agent_dir / "git").exists()
    (kept,) = (harness.layout.root / "backups").glob("*/git/github.com/me/mine/index.ts")
    assert kept.read_text() == "mine"


def make_unsupported(layout: Layout, case: str) -> Path:
    """Put an entry of a kind the installer cannot back up and restore where a switch replaces one.

    Parameters:
        layout (Layout): installer paths.
        case (str): which entry.

    Returns:
        Path: the unsupported entry.

    Raises:
        ValueError: unknown case.
    """
    match case:
        case "bin-pi-directory":
            path = layout.link
            if path.exists(follow_symlinks=False):
                path.unlink()
            path.mkdir(parents=True)
            (path / "mine").write_text("mine")
        case "npm-file" | "git-file":
            path = layout.agent_dir / case.removesuffix("-file")
            if path.is_dir():
                shutil.rmtree(path)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("mine")
        case "state-directory":
            path = layout.state
            path.mkdir(parents=True)
            (path / "mine").write_text("mine")
        case _:
            raise ValueError(f"Unknown case '{case}'")
    return path


@pytest.mark.parametrize("case", ["bin-pi-directory", "npm-file", "git-file", "state-directory"])
def test_unsupported_existing_kind_is_refused_before_consent(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, case: str
) -> None:
    """A kind the journal could not restore is refused before the prompt, so no switch strands it."""
    harness = Harness(tmp_path, monkeypatch)
    seed_existing(harness.home)
    path = make_unsupported(harness.layout, case)
    before = tree(tmp_path)
    prompts: list[str] = []
    with pytest.raises(UnsupportedError, match="nothing changed") as raised:
        harness.run(ask=lambda prompt: prompts.append(prompt) or "y")
    assert str(path) in str(raised.value)
    with pytest.raises(UnsupportedError, match="nothing changed"):
        harness.run(yes=True)
    assert prompts == []
    assert harness.calls() == []
    assert not harness.layout.journal.exists()
    assert {k: v for k, v in tree(tmp_path).items() if not k.endswith("pi-stack/lock")} == {
        k: v for k, v in before.items() if not k.endswith("pi-stack/lock")
    }


def test_kind_changed_after_planning_never_enters_the_journal(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A target that turns unsupported mid-run is refused unjournaled, so the journal still restores."""
    harness = Harness(tmp_path, monkeypatch)
    seed_existing(harness.home)
    layout = harness.layout
    plan = plan_install(layout, harness.verified)
    layout.root.mkdir(parents=True)
    staged = install.stage(layout, harness.verified, plan, layout.root / "staging" / "x")
    make_unsupported(layout, "bin-pi-directory")
    before = {k: v for k, v in tree(harness.home).items() if "pi-stack" not in k}
    with pytest.raises(UnsupportedError, match="bin") as raised:
        switch(layout, harness.verified, plan, staged, Journal(layout, layout.root / "backups" / "b"))
    assert "nothing changed" not in str(raised.value)
    steps = json.loads(layout.journal.read_text())["steps"]
    assert str(layout.link) not in [step["target"] for step in steps]
    assert rollback(layout)
    assert {k: v for k, v in tree(harness.home).items() if "pi-stack" not in k} == before
    assert not layout.journal.exists()


def test_kind_changed_mid_run_rolls_back_and_fails(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A mid-run kind change is a rolled-back failure (exit `1`), never reported as nothing changed."""
    harness = Harness(tmp_path, monkeypatch)
    seed_existing(harness.home)
    before = {k: v for k, v in tree(harness.home).items() if "pi-stack" not in k}
    original = install.stage

    def stage_then_swap(layout: Layout, verified: Verified, plan: install.Plan, staging: Path) -> Path | None:
        """Stage, then turn the `pi` link into a directory before the switch reaches it.

        Parameters:
            layout (Layout): installer paths.
            verified (Verified): verified input.
            plan (install.Plan): planned changes.
            staging (Path): staging directory.

        Returns:
            Path | None: the staged agent tree.
        """
        staged = original(layout, verified, plan, staging)
        make_unsupported(layout, "bin-pi-directory")
        return staged

    monkeypatch.setattr(install, "stage", stage_then_swap)
    with pytest.raises(InstallError, match="rolled back") as raised:
        harness.run(yes=True)
    assert not isinstance(raised.value, UnsupportedError)
    assert "nothing changed" not in str(raised.value)
    after = {k: v for k, v in tree(harness.home).items() if "pi-stack" not in k}
    assert after == {k: v for k, v in before.items() if k != ".local/bin/pi"} | {
        ".local/bin/pi/mine": b"mine"
    }
    assert not harness.layout.journal.exists()


SPECIAL_CHILD = """\
import sys
from pathlib import Path
from harness import install
from harness.promotion import load_promoted_snapshot
from harness.stack import source_string
snapshot = load_promoted_snapshot(Path(sys.argv[1]).read_bytes(), sys.argv[2])
sources = [source_string(package) for package in snapshot.stack.sources]
install.preflight = lambda system, machine: {"node": "node"}
install.verify_snapshot = lambda sha, workdir: snapshot
install.verify_release = lambda snapshot, node, workdir: install.Verified(snapshot, sources, {})
sys.exit(install.main(sys.argv[2:]))
"""


def make_special(path: Path, kind: str, monkeypatch: pytest.MonkeyPatch) -> None:
    """Create a FIFO, a link to one, or a Unix socket at `path`.

    Parameters:
        path (Path): entry to create; its parent exists.
        kind (str): `fifo`, `fifo-link` or `socket`.
        monkeypatch (pytest.MonkeyPatch): restores the working directory a socket bind uses.
    """
    match kind:
        case "fifo":
            os.mkfifo(path)
        case "fifo-link":
            os.mkfifo(path.with_name("pipe"))
            path.symlink_to(path.with_name("pipe"))
        case "socket":
            # Bound by relative name: `sun_path` is ~104 bytes and pytest's tmp paths can exceed it.
            monkeypatch.chdir(path.parent)
            server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            server.bind(path.name)
            server.close()
        case _:
            raise ValueError(f"Unknown kind '{kind}'")


@pytest.mark.parametrize(
    ("name", "kind", "message"),
    [
        ("settings.json", "fifo", "is a fifo; the installer only reads a regular file or a link to one"),
        ("subagents.json", "fifo", "is a fifo; the installer only reads a regular file or a link to one"),
        ("settings.json", "fifo-link", "is a fifo; the installer only reads a regular file or a link to one"),
        ("installed.json", "fifo", "is a fifo; the installer only replaces a file there"),
        ("installed.json", "fifo-link", "is a symlink; the installer only replaces a file there"),
        ("settings.json", "socket", "is a socket; the installer only reads a regular file or a link to one"),
        ("installed.json", "socket", "is a socket; the installer only replaces a file there"),
    ],
)
def test_special_files_fail_fast_without_changes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, name: str, kind: str, message: str
) -> None:
    """The real entry point refuses a FIFO or socket before opening it: exit `2`, never a hang.

    Run as a child with a hard timeout, because the regression is a read that blocks forever.
    """
    if kind == "socket" and not hasattr(socket, "AF_UNIX"):
        pytest.skip("no Unix domain sockets")
    agent, root = special_home(tmp_path)
    target = root / name if name == install.STATE_FILE else agent / name
    target.unlink(missing_ok=True)
    make_special(target, kind, monkeypatch)
    before = tree(tmp_path)
    result = run_child(tmp_path)
    assert result.returncode == ExitCode.UNSUPPORTED, result.stderr
    assert f"UNSUPPORTED: '{target}' {message}" in result.stderr
    assert "nothing changed" in result.stderr
    assert install.entry_kind(target) == ("symlink" if kind == "fifo-link" else kind)
    assert {k: v for k, v in tree(tmp_path).items() if not k.endswith("pi-stack/lock")} == before
    assert not (root / "transaction.json").exists()


def test_fifo_journal_fails_closed_without_blocking(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A FIFO in place of the journal is untrusted at once, never opened in blocking mode."""
    _, root = special_home(tmp_path)
    make_special(root / "transaction.json", "fifo", monkeypatch)
    before = tree(tmp_path)
    result = run_child(tmp_path)
    assert result.returncode == ExitCode.FAILED, result.stderr
    assert "is not trusted: it is not a regular file; nothing was restored" in result.stderr
    assert {k: v for k, v in tree(tmp_path).items() if not k.endswith("pi-stack/lock")} == before


def special_home(tmp_path: Path) -> tuple[Path, Path]:
    """Seed an existing setup under `tmp_path/home`, with the installer root under `tmp_path/data`.

    Parameters:
        tmp_path (Path): private directory.

    Returns:
        tuple[Path, Path]: the agent directory and the installer root, both existing.
    """
    home = tmp_path / "home"
    seed_existing(home)
    root = tmp_path / "data" / "pi-stack"
    root.mkdir(parents=True)
    return home / ".pi" / "agent", root


def run_child(tmp_path: Path, timeout: float = 60) -> subprocess.CompletedProcess[str]:
    """Run `install.main` with `--yes` in a child confined to `special_home`, killed after 60 s.

    Parameters:
        tmp_path (Path): directory `special_home` seeded.
        timeout (float): hard child deadline in seconds.

    Returns:
        subprocess.CompletedProcess[str]: the finished child.
    """
    home = tmp_path / "home"
    env = {
        "HOME": str(home),
        "PATH": os.environ["PATH"],
        "PYTHONPATH": str(INTEGRATION),
        "PI_CODING_AGENT_DIR": str(home / ".pi" / "agent"),
        "XDG_DATA_HOME": str(tmp_path / "data"),
    }
    argv = [str(FIXTURE), SHA, "--yes", "--bin-dir", str(home / ".local" / "bin")]
    return subprocess.run(
        [sys.executable, "-c", SPECIAL_CHILD, *argv],
        env=env,
        cwd=tmp_path,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )


def test_real_stdin_eof_declines_without_traceback(tmp_path: Path) -> None:
    """The real builtin input sees EOF on stdin and the entry point exits 4 without live changes."""
    special_home(tmp_path)
    before = tree(tmp_path)
    script = SPECIAL_CHILD.replace(
        "sys.exit(install.main(sys.argv[2:]))",
        "sys.stdin.isatty = lambda: True\nsys.exit(install.main(sys.argv[2:]))",
    )
    home = tmp_path / "home"
    result = subprocess.run(
        [sys.executable, "-c", script, str(FIXTURE), SHA],
        env={
            "HOME": str(home),
            "PATH": os.environ["PATH"],
            "PYTHONPATH": str(INTEGRATION),
            "PI_CODING_AGENT_DIR": str(home / ".pi" / "agent"),
            "XDG_DATA_HOME": str(tmp_path / "data"),
        },
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    assert result.returncode == ExitCode.CONSENT, result.stderr
    assert "NOT APPLIED:" in result.stderr
    assert "nothing changed" in result.stderr
    assert "EOFError" not in result.stderr
    assert "Traceback" not in result.stderr
    assert {k: v for k, v in tree(tmp_path).items() if not k.endswith("pi-stack/lock")} == before


def test_journal_is_private_before_any_data(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """No umask exposes the journal's paths: its file is owner-only from creation, before data."""
    modes: list[int] = []
    fsync = install.os.fsync

    def observe(descriptor: int) -> None:
        """Record the file mode the moment the data is flushed, before any later chmod.

        Parameters:
            descriptor (int): open file.
        """
        modes.append(install.os.fstat(descriptor).st_mode & 0o777)
        fsync(descriptor)

    monkeypatch.setattr(install.os, "fsync", observe)
    previous = install.os.umask(0)
    try:
        install.write_atomic(tmp_path / "transaction.json", "{}", mode=install.JOURNAL_MODE)
    finally:
        install.os.umask(previous)
    assert modes == [0o600]
    assert (tmp_path / "transaction.json").stat().st_mode & 0o777 == 0o600


def test_owner_read_only_journal_is_trusted(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Owner-only means no group or other bits; a `0400` journal still restores."""
    harness = Harness(tmp_path, monkeypatch)
    seed_existing(harness.home)
    before = {k: v for k, v in tree(harness.home).items() if "pi-stack" not in k}
    interrupt(harness, monkeypatch)
    harness.layout.journal.chmod(0o400)
    assert rollback(harness.layout)
    assert {k: v for k, v in tree(harness.home).items() if "pi-stack" not in k} == before


def test_restore_with_another_layout_says_how_to_recover(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A rerun with another `--bin-dir` fails closed and names the settings the restore needs."""
    harness = Harness(tmp_path, monkeypatch)
    seed_existing(harness.home)
    interrupt(harness, monkeypatch)
    before = tree(tmp_path)
    with pytest.raises(RollbackError, match="PI_CODING_AGENT_DIR") as raised:
        install.run(Options(SHA, True, False, tmp_path / "elsewhere"), harness.env, None)
    assert "--bin-dir" in str(raised.value)
    assert {k: v for k, v in tree(tmp_path).items() if not k.endswith("pi-stack/lock")} == {
        k: v for k, v in before.items() if not k.endswith("pi-stack/lock")
    }
    assert harness.run(yes=True) == ExitCode.OK


def harness_closure(*roots: Path) -> set[Path]:
    """Return every `harness` module the given files import, transitively, plus the files.

    Parameters:
        *roots (Path): Python files under `integration/`.

    Returns:
        set[Path]: files relative to `integration/`.
    """
    seen: set[Path] = set()
    pending = [root.relative_to(INTEGRATION) for root in roots]
    while pending:
        current = pending.pop()
        if current in seen:
            continue
        seen.add(current)
        for node in ast.walk(ast.parse((INTEGRATION / current).read_text())):
            names = []
            if isinstance(node, ast.ImportFrom) and node.module and node.module.split(".")[0] == "harness":
                names = [node.module, *(f"{node.module}.{alias.name}" for alias in node.names)]
            elif isinstance(node, ast.Import):
                names = [alias.name for alias in node.names if alias.name.split(".")[0] == "harness"]
            for name in names:
                module = Path(*name.split(".")).with_suffix(".py")
                if (INTEGRATION / module).is_file():
                    pending.append(module)
    return seen


def test_installer_workflow_covers_its_inputs() -> None:
    """Both trigger lists name every file the acceptance imports or is pinned by."""
    workflow = yaml.safe_load(INSTALLER_WORKFLOW.read_text())["on"]
    closure = harness_closure(
        INTEGRATION / "harness" / "install.py",
        INTEGRATION / "scenarios" / "installer" / "test_installer.py",
        INTEGRATION / "conftest.py",
    )
    required = {
        ".github/workflows/installer.yml",
        ".node-version",
        "integration/Makefile",
        "integration/pyproject.toml",
        "integration/uv.lock",
        "integration/harness/__init__.py",
        *(f"integration/{path}" for path in closure if path.parts[0] != "scenarios"),
    }
    for event in ("pull_request", "push"):
        paths = workflow[event]["paths"]
        assert "integration/scenarios/installer/**" in paths
        assert required - set(paths) == set(), event
        assert all((INTEGRATION.parent / path).exists() for path in paths if "*" not in path), event


@pytest.mark.parametrize(
    ("event", "ref", "head_repo", "expected"),
    [
        ("push", "refs/heads/main", "", "job-token"),
        ("workflow_dispatch", "refs/heads/main", "", "job-token"),
        ("pull_request", "refs/pull/126/merge", "nredd/pi-harness", "job-token"),
        ("pull_request", "refs/pull/126/merge", "someone/pi-harness", ""),
        ("pull_request", "refs/heads/main", "someone/pi-harness", ""),
        ("workflow_dispatch", "refs/heads/topic", "nredd/pi-harness", ""),
        ("push", "refs/heads/topic", "nredd/pi-harness", ""),
        ("pull_request_target", "refs/heads/main", "nredd/pi-harness", ""),
    ],
)
def test_installer_workflow_token_policy(event: str, ref: str, head_repo: str, expected: str) -> None:
    """Only main pushes/dispatches and owner-reviewed same-repo PRs get a read-only fallback token."""
    text = INSTALLER_WORKFLOW.read_text()
    workflow = yaml.safe_load(text)
    tokens = [
        (step.get("name"), name, value)
        for job in workflow["jobs"].values()
        for step in job["steps"]
        for name, value in step.get("env", {}).items()
        if "github.token" in str(value) or "secrets." in str(value)
    ]
    assert tokens == [
        (
            "Authenticate gh attestation fallback",
            "GH_TOKEN",
            "${{ ((github.event_name == 'pull_request' && "
            "github.event.pull_request.head.repo.full_name == github.repository) || "
            "((github.event_name == 'push' || github.event_name == 'workflow_dispatch') && "
            "github.ref == 'refs/heads/main')) && github.token || '' }}",
        )
    ]
    assert text.count("github.token") == 1
    assert "secrets." not in text
    # Evaluate the pinned, trusted expression with literal context values and no builtins.
    expression = tokens[0][2].removeprefix("${{ ").removesuffix(" }}")
    for name, value in {
        "github.event.pull_request.head.repo.full_name": head_repo,
        "github.repository": "nredd/pi-harness",
        "github.event_name": event,
        "github.ref": ref,
        "github.token": "job-token",
    }.items():
        expression = expression.replace(name, repr(value))
    assert eval(expression.replace("&&", "and").replace("||", "or"), {"__builtins__": {}}) == expected


def test_installer_workflow_token_is_confined_to_gh_login() -> None:
    """The make/uv/pytest/build step has no token; only gh login consumes it, with cleanup always."""
    workflow = yaml.safe_load(INSTALLER_WORKFLOW.read_text())
    steps = {step.get("name"): step for step in workflow["jobs"]["installer"]["steps"]}
    login = steps["Authenticate gh attestation fallback"]
    assert login["run"] == (
        'if [ -n "$GH_TOKEN" ]; then\n'
        "  printf '%s' \"$GH_TOKEN\" | env -u GH_TOKEN gh auth login "
        "--hostname github.com --with-token --insecure-storage\n"
        "fi\n"
    )
    assert login["env"]["GH_CONFIG_DIR"] == "${{ runner.temp }}/installer-gh"
    run_env = steps["Run the documented one-shot command in throwaway HOMEs"]["env"]
    assert set(run_env) == {"INSTALLER_GH_CONFIG_DIR", "INSTALLER_SPEC", "STACK_SHA"}
    cleanup = steps["Remove temporary gh login"]
    assert cleanup["if"] == "always()"
    assert cleanup["env"] == {"GH_CONFIG_DIR": login["env"]["GH_CONFIG_DIR"]}
    assert cleanup["run"] == 'rm -rf -- "$GH_CONFIG_DIR"'


def write_ci_gh_login(cfg: Path) -> None:
    """Model gh's insecure hosts.yml, including host-level and active-user token slots.

    Parameters:
        cfg (Path): existing private login directory.

    References:
        https://github.com/cli/cli/blob/trunk/internal/config/config.go
    """
    cfg.chmod(0o700)
    hosts = cfg / "hosts.yml"
    hosts.write_text(
        yaml.safe_dump(
            {
                "github.com": {
                    "user": "installer-ci",
                    "git_protocol": "https",
                    "oauth_token": SENTINEL,
                    "users": {"installer-ci": {"oauth_token": SENTINEL}},
                }
            }
        )
    )
    hosts.chmod(0o600)


def test_acceptance_token_environment_is_clean_but_gh_capability_remains(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """No token is inherited, but same-UID build code can use the PATH shim and read real hosts.yml."""
    cfg, tools, home = tmp_path / "login", tmp_path / "tools", tmp_path / "home"
    for directory in (cfg, tools, home):
        directory.mkdir()
    write_ci_gh_login(cfg)
    assert yaml.safe_load((cfg / "hosts.yml").read_text())["github.com"]["oauth_token"] == SENTINEL
    gh = shutil.which("gh")
    assert gh is not None, "Offline gh config interoperability requires the GitHub CLI"
    shim = acceptance.gh_config_shim(tmp_path / "shim", cfg, Path(gh))
    for token in GITHUB_TOKEN_VARIABLES:
        monkeypatch.setenv(token, SENTINEL)
    monkeypatch.setenv("GH_CONFIG_DIR", str(cfg))
    monkeypatch.setenv("INSTALLER_GH_CONFIG_DIR", str(cfg))
    env = acceptance.environment(home, tmp_path / "cache", f"{shim}:{tools}:/usr/bin:/bin")
    script = (
        "import os,subprocess,sys\n"
        f"assert {SENTINEL!r} not in repr(dict(os.environ)), 'token reached non-gh child'\n"
        "assert 'GH_CONFIG_DIR' not in os.environ\n"
        "assert 'INSTALLER_GH_CONFIG_DIR' not in os.environ\n"
        f"assert not set(os.environ).intersection({sorted(GITHUB_TOKEN_VARIABLES)!r})\n"
        "subprocess.run([sys.executable,'-c',sys.argv[1]],check=True)\n"
        "subprocess.run(['gh','auth','token','--hostname','github.com'],check=True)\n"
    )
    build = (
        "import os,pathlib,shlex,shutil,subprocess\n"
        f"assert {SENTINEL!r} not in repr(dict(os.environ))\n"
        "shim = pathlib.Path(shutil.which('gh'))\n"
        "cfg = shlex.split(shim.read_text().splitlines()[1])[1].split('=',1)[1]\n"
        f"assert {SENTINEL!r} in (pathlib.Path(cfg) / 'hosts.yml').read_text()\n"
        "token = subprocess.check_output(['gh','auth','token','--hostname','github.com'],text=True)\n"
        f"assert token.strip() == {SENTINEL!r}\n"
    )
    result = subprocess.run(
        [sys.executable, "-c", script, build], env=env, capture_output=True, text=True, check=False
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == SENTINEL


def test_acceptance_login_wraps_eager_parent_gh_lookup(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Direct parent verification and freshly launched installers both use the gh-only config shim."""
    cfg, tools = tmp_path / "login", tmp_path / "tools"
    cfg.mkdir()
    tools.mkdir()
    write_ci_gh_login(cfg)
    assert yaml.safe_load((cfg / "hosts.yml").read_text())["github.com"]["oauth_token"] == SENTINEL
    real_gh = shutil.which("gh")
    assert real_gh is not None, "Offline gh config interoperability requires the GitHub CLI"
    gh = tools / "gh"
    gh.symlink_to(real_gh)
    for name in GITHUB_TOKEN_VARIABLES | {"GH_CONFIG_DIR"}:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("INSTALLER_GH_CONFIG_DIR", str(cfg))
    monkeypatch.setenv("PATH", str(tools))
    monkeypatch.setattr(acceptance.release, "GH_BIN", str(gh))
    acceptance.configure_gh_login(tmp_path, monkeypatch)
    assert Path(acceptance.release.GH_BIN) == tmp_path / "gh-shim" / "gh"
    token = subprocess.check_output(
        [acceptance.release.GH_BIN, "auth", "token", "--hostname", "github.com"],
        env=acceptance.environment(tmp_path, tmp_path / "cache"),
        text=True,
        stderr=subprocess.STDOUT,
    )
    assert token.strip() == SENTINEL
    assert "GH_CONFIG_DIR" not in os.environ


def test_ci_documents_residual_gh_capability() -> None:
    """Environment hygiene must not be advertised as denying same-UID package credential access."""
    for name in ("AGENTS.md", "docs/ci.md"):
        text = (INTEGRATION.parent / name).read_text()
        assert "KNOWN RESIDUAL" in text
        assert "same-UID package code" in text
        assert "PATH" in text
        assert "hosts.yml" in text
        assert "read-only" in text
        assert "TRUST assumption" in text


def test_installer_workflow_token_permissions_are_read_only() -> None:
    """Explicit job permissions grant only checkout and attestation reads, never any write scope."""
    workflow = yaml.safe_load(INSTALLER_WORKFLOW.read_text())
    assert workflow["permissions"] == {}
    assert workflow["jobs"]["installer"]["permissions"] == {"contents": "read", "attestations": "read"}
    assert all(
        step.get("with", {}).get("persist-credentials") is False
        for step in workflow["jobs"]["installer"]["steps"]
        if step.get("uses", "").startswith("actions/checkout@")
    )


@pytest.mark.parametrize("kind", ["fifo", "fifo-link", "socket"])
def test_special_lock_is_bounded_and_unchanged(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, kind: str
) -> None:
    """A hostile lock entry never blocks or changes its target."""
    _, root = special_home(tmp_path)
    make_special(root / "lock", kind, monkeypatch)
    before = tree(tmp_path)
    result = run_child(tmp_path, timeout=3)
    assert result.returncode == ExitCode.UNSUPPORTED, result.stderr
    assert "lock" in result.stderr
    assert tree(tmp_path) == before


def test_lock_symlink_does_not_truncate_target(tmp_path: Path) -> None:
    """Reject a lock link before touching the existing target's bytes."""
    _, root = special_home(tmp_path)
    target = root / "mine"
    target.write_text("keep me")
    (root / "lock").symlink_to(target)
    result = run_child(tmp_path, timeout=3)
    assert target.read_text() == "keep me"
    assert result.returncode == ExitCode.UNSUPPORTED, result.stderr


@pytest.mark.parametrize("untrusted", ["owner", "mode"])
def test_lock_rejects_untrusted_regular_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, untrusted: str
) -> None:
    """Reject foreign ownership or writable-by-others locks without changing their contents."""
    harness = Harness(tmp_path, monkeypatch)
    lock = harness.layout.root / "lock"
    lock.parent.mkdir(parents=True)
    lock.write_text("keep me")
    if untrusted == "owner":
        monkeypatch.setattr(install.os, "getuid", lambda: lock.stat().st_uid + 1)
    else:
        lock.chmod(0o666)
    with (
        pytest.raises(UnsupportedError, match="must be a regular file you own"),
        install.locked(harness.layout),
    ):
        pytest.fail("untrusted lock acquired")
    assert lock.read_text() == "keep me"


def test_lock_keeps_bytes_and_excludes_contenders(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """The lock is never truncated, including by a losing contender."""
    harness = Harness(tmp_path, monkeypatch)
    lock = harness.layout.root / "lock"
    lock.parent.mkdir(parents=True)
    lock.write_text("keep me")
    with (
        install.locked(harness.layout),
        pytest.raises(InstallError, match="Another installer"),
        install.locked(harness.layout),
    ):
        pytest.fail("second installer acquired lock")
    assert lock.read_text() == "keep me"
    with install.locked(harness.layout):
        assert lock.read_text() == "keep me"


@pytest.mark.parametrize("race", ["static", "lookup", "open"])
def test_rerun_manifest_read_race_is_bounded(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, race: str
) -> None:
    """Reject a static FIFO, and a swap after lookup, on the real packages_ready rerun path."""
    harness = Harness(tmp_path, monkeypatch)
    assert harness.run() == ExitCode.OK
    script = dedent(
        """
        import os, sys
        from pathlib import Path
        from harness import install, stack
        from harness.promotion import load_promoted_snapshot
        snapshot = load_promoted_snapshot(Path(sys.argv[1]).read_bytes(), sys.argv[2])
        sources = [stack.source_string(p) for p in snapshot.stack.sources]
        layout = install.Layout.from_env({}, Path(sys.argv[3]), None)
        original = stack.package_directory
        def swap(source, agent):
            path = original(source, agent)
            manifest = path / "package.json"
            manifest.unlink()
            os.mkfifo(manifest)
            return path
        if sys.argv[4] == "lookup":
            stack.package_directory = swap
        elif sys.argv[4] == "open":
            original_open = os.open
            manifest = original(sources[0], layout.agent_dir) / "package.json"
            def swap_on_open(path, flags, *args):
                if path == manifest:
                    path.unlink()
                    os.mkfifo(path)
                return original_open(path, flags, *args)
            os.open = swap_on_open
        else:
            path = original(sources[0], layout.agent_dir) / "package.json"
            path.unlink()
            os.mkfifo(path)
        assert not install.packages_ready(layout, install.Verified(snapshot, sources, {}))
        """
    )
    subprocess.run(
        [sys.executable, "-c", script, str(FIXTURE), SHA, str(harness.home), race],
        env={"PYTHONPATH": str(INTEGRATION)},
        capture_output=True,
        text=True,
        timeout=3,
        check=True,
    )


def test_failed_package_staging_preserves_existing_core(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A live link to a drifted core keeps its original bytes when package staging fails."""
    harness = Harness(tmp_path, monkeypatch)
    assert harness.run() == ExitCode.OK
    prefix = harness.layout.core(harness.snapshot.stack.core.tag)
    (prefix / install.CORE_MARKER).unlink()
    (prefix / "mine").write_text("old core")
    harness.fail.append(harness.verified.sources[0])
    (harness.layout.agent_dir / "npm" / "node_modules").rename(tmp_path / "old-packages")
    before = tree(harness.home)
    with pytest.raises(InstallError, match=r"pi install.*failed"):
        harness.run(yes=True)
    assert tree(harness.home) == before


@pytest.mark.parametrize("kind", ["fifo", "socket"])
def test_special_core_prefix_is_refused_before_staging(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, kind: str
) -> None:
    """A non-restorable core prefix gets the documented semantic refusal, not OSError."""
    harness = Harness(tmp_path, monkeypatch)
    prefix = harness.layout.core(harness.snapshot.stack.core.tag)
    prefix.parent.mkdir(parents=True)
    make_special(prefix, kind, monkeypatch)
    with pytest.raises(UnsupportedError, match="only replaces"):
        harness.run(yes=True)
    assert not harness.fetched


@pytest.mark.parametrize("interrupt_switch", [False, True])
def test_core_replacement_is_backed_up_and_offline_recoverable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, interrupt_switch: bool
) -> None:
    """A drifted live core is backed up, and an interrupted switch restores it offline."""
    harness = Harness(tmp_path, monkeypatch)
    assert harness.run() == ExitCode.OK
    prefix = harness.layout.core(harness.snapshot.stack.core.tag)
    (prefix / install.CORE_MARKER).unlink()
    (prefix / "mine").write_text("old core")
    before = tree(harness.home)
    plan = plan_install(harness.layout, harness.verified)
    assert plan.install_core
    assert not plan.install_packages
    assert plan.link is None
    staging = tmp_path / "staging"
    staging.mkdir()
    staged_agent = install.stage(harness.layout, harness.verified, plan, staging)
    assert tree(harness.home) == before
    backups = harness.layout.root / "backups" / "core-replacement"
    journal = Journal(harness.layout, backups)
    if interrupt_switch:

        def interrupt_file(*args: object) -> None:
            """Interrupt after the core switch, before writing the installed state."""
            raise RuntimeError("interrupt")

        monkeypatch.setattr(install, "replace_file", interrupt_file)
        with pytest.raises(RuntimeError, match="interrupt"):
            switch(
                harness.layout, harness.verified, plan, staged_agent, journal, staged_core=staging / "core"
            )
        assert (backups / f"core-{prefix.name}" / "mine").read_text() == "old core"
        assert rollback(harness.layout)
        assert tree(harness.home) == before
    else:
        switch(harness.layout, harness.verified, plan, staged_agent, journal, staged_core=staging / "core")
        journal.commit()
        assert (backups / f"core-{prefix.name}" / "mine").read_text() == "old core"
        assert not (prefix / "mine").exists()
        assert install.core_ready(harness.layout, harness.snapshot.stack)


REAL_PREFLIGHT = install.preflight


def swap_in_store(layout: Layout, kind: str, outside: Path) -> Path:
    """Replace the backup store with an entry the journal reader refuses.

    Parameters:
        layout (Layout): installer paths.
        kind (str): `symlink`, `dangling-symlink` or `file`.
        outside (Path): directory a symlink points at.

    Returns:
        Path: the store path.

    Raises:
        ValueError: unknown kind.
    """
    store = layout.backups
    layout.root.mkdir(parents=True, exist_ok=True)
    shutil.rmtree(store, ignore_errors=True)
    match kind:
        case "symlink":
            outside.mkdir(exist_ok=True)
            store.symlink_to(outside)
        case "dangling-symlink":
            store.symlink_to(outside / "gone")
        case "file":
            store.write_text("mine")
        case _:
            raise ValueError(f"Unknown kind '{kind}'")
    return store


@pytest.mark.parametrize("kind", ["symlink", "dangling-symlink", "file"])
def test_unsupported_backup_store_is_refused_before_consent_or_changes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, kind: str
) -> None:
    """The reader refuses a non-directory `backups` store, so the writer must refuse it first."""
    harness = Harness(tmp_path, monkeypatch)
    seed_existing(harness.home)
    outside = tmp_path / "outside"
    store = swap_in_store(harness.layout, kind, outside)
    before = {k: v for k, v in tree(tmp_path).items() if not k.endswith("pi-stack/lock")}
    prompts: list[str] = []
    with pytest.raises(UnsupportedError, match="backups") as raised:
        harness.run(ask=lambda prompt: prompts.append(prompt) or "y")
    assert str(store) in str(raised.value)
    with pytest.raises(UnsupportedError, match="backups"):
        install.run(Options(SHA, False, True, None), harness.env, None)
    assert prompts == []
    assert harness.calls() == []
    assert not harness.layout.journal.exists()
    assert {k: v for k, v in tree(tmp_path).items() if not k.endswith("pi-stack/lock")} == before
    assert not outside.exists() or not any(outside.iterdir())


def test_backup_store_symlink_cannot_trap_a_failed_switch(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A symlinked store used to let a mid-switch failure strand a journal no run could restore."""
    harness = Harness(tmp_path, monkeypatch)
    seed_existing(harness.home)
    swap_in_store(harness.layout, "symlink", tmp_path / "outside")
    before = {k: v for k, v in tree(harness.home).items() if "pi-stack" not in k}
    with pytest.raises(UnsupportedError, match="backups"):
        harness.run(yes=True)
    assert {k: v for k, v in tree(harness.home).items() if "pi-stack" not in k} == before
    assert not harness.layout.journal.exists()


def test_backup_store_swapped_after_planning_is_refused_before_the_switch(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A store that turns into a link while staging runs is refused again before the first step."""
    harness = Harness(tmp_path, monkeypatch)
    seed_existing(harness.home)
    layout, outside = harness.layout, tmp_path / "outside"
    before = {k: v for k, v in tree(harness.home).items() if "pi-stack" not in k}
    stage = install.stage

    def swap_after_stage(*args: Any, **kwargs: Any) -> Path | None:
        """Stage for real, then swap the store like a concurrent process.

        Parameters:
            *args (Any): `install.stage` arguments.
            **kwargs (Any): `install.stage` options.

        Returns:
            Path | None: the staged agent tree.
        """
        staged = stage(*args, **kwargs)
        swap_in_store(layout, "symlink", outside)
        return staged

    monkeypatch.setattr(install, "stage", swap_after_stage)
    with pytest.raises(UnsupportedError, match="backups"):
        harness.run(yes=True)
    assert {k: v for k, v in tree(harness.home).items() if "pi-stack" not in k} == before
    assert not layout.journal.exists()
    assert not any(outside.iterdir())


def test_backup_store_on_another_filesystem_is_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A real `backups` mount point would fail the switch with EXDEV, so the one-filesystem rule covers it."""
    harness = Harness(tmp_path, monkeypatch)
    seed_existing(harness.home)
    layout = harness.layout
    (layout.root / "backups").mkdir(parents=True)
    before = tree(harness.home)
    monkeypatch.setattr(install, "device", lambda path: 2 if path == layout.root / "backups" else 1)
    with pytest.raises(UnsupportedError, match="one filesystem"):
        harness.run(yes=True)
    assert tree(harness.home) == before
    assert harness.calls() == []


def fake_tools(directory: Path) -> Callable[[str], str | None]:
    """Create `gh`, `npm` and a `node` that is a link to a version-manager style dispatcher.

    The dispatcher answers by its own name (`$0`), like Volta or mise shims: run as `node` it is
    Node.js, run under any other name it is the manager and prints a 2026 release.

    Parameters:
        directory (Path): empty directory.

    Returns:
        Callable[[str], str | None]: a `which` over that directory.
    """
    directory.mkdir()
    dispatcher = directory.parent / "manager-dispatcher"
    dispatcher.write_text(
        '#!/bin/sh\ncase "${0##*/}" in\n  node) echo v22.19.0;;\n  *) echo "manager 2026.1.0";;\nesac\n'
    )
    dispatcher.chmod(0o755)
    (directory / "node").symlink_to(dispatcher)
    for name in ("gh", "npm"):
        (directory / name).write_text("#!/bin/sh\n")
        (directory / name).chmod(0o755)
    return lambda name: str(directory / name) if (directory / name).exists() else None


def test_preflight_keeps_the_discovered_path_not_the_dispatcher(tmp_path: Path) -> None:
    """Resolving a version-manager link runs the manager, whose answer is not Node.js's."""
    which = fake_tools(tmp_path / "shims")
    tools = REAL_PREFLIGHT("Linux", "x86_64", which, wsl=False)
    assert tools["node"] == str(tmp_path / "shims" / "node")
    assert install.node_version(tools["node"]) == (22, 19, 0)


def test_preflight_makes_a_relative_discovery_absolute(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A relative `PATH` entry still yields an absolute tool path, without resolving links."""
    which = fake_tools(tmp_path / "shims")
    monkeypatch.chdir(tmp_path)
    tools = REAL_PREFLIGHT(
        "Linux", "x86_64", lambda name: f"shims/{name}" if which(name) else None, wsl=False
    )
    assert tools["node"] == str(tmp_path / "shims" / "node")
    assert install.node_version(tools["node"]) == (22, 19, 0)


def test_wsl_is_refused_by_preflight_before_anything_changes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """WSL reports `Linux/x86_64`; the documented refusal needs the physical WSL check, early."""
    which = fake_tools(tmp_path / "shims")
    with pytest.raises(UnsupportedError, match="WSL"):
        REAL_PREFLIGHT("Linux", "x86_64", which, wsl=True)
    harness = Harness(tmp_path, monkeypatch)
    # `install.main` reads `os.environ`: a host value would move the journal and agent directory.
    for name in ("XDG_DATA_HOME", "PI_CODING_AGENT_DIR"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(install, "preflight", REAL_PREFLIGHT)
    monkeypatch.setattr(install, "is_wsl", lambda: True)
    monkeypatch.setattr(install.platform, "system", lambda: "Linux")
    monkeypatch.setattr(install.platform, "machine", lambda: "x86_64")
    monkeypatch.setattr(install.shutil, "which", which)
    before = tree(tmp_path)
    with pytest.raises(UnsupportedError, match="WSL"):
        harness.run(yes=True)
    with pytest.raises(UnsupportedError, match="WSL"):
        install.run(Options(SHA, False, True, None), harness.env, None)
    assert install.main([SHA, "--yes"]) == ExitCode.UNSUPPORTED
    assert tree(tmp_path) == before
    assert not harness.layout.root.exists()
    assert harness.calls() == []


def test_agent_dir_expands_tilde_like_pi_with_the_injected_home(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`PI_CODING_AGENT_DIR` takes Pi's `~` and `~/` rule from the given home, nothing broader."""
    home = (tmp_path / "home").resolve()
    home.mkdir()
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("HOME", str(tmp_path / "not-the-home"))

    def agent(value: str) -> Path:
        """Resolve the agent directory for one setting.

        Parameters:
            value (str): `PI_CODING_AGENT_DIR`.

        Returns:
            Path: the agent directory.
        """
        return Layout.from_env({"PI_CODING_AGENT_DIR": value}, home, None).agent_dir

    assert agent("~/x") == home / "x"
    assert agent("~") == home
    assert agent("~/") == home
    assert agent("~/a//b") == home / "a" / "b"
    assert agent("~//x") == home / "x"
    assert agent("~someone/x") == (tmp_path / "~someone" / "x").resolve()
    assert agent("a~/x") == (tmp_path / "a~" / "x").resolve()
    assert agent("/abs/~/x") == Path("/abs/~/x")
    unexpanded = Layout.from_env({"XDG_DATA_HOME": "~/share"}, home, None)
    assert unexpanded.root == (tmp_path / "~" / "share" / "pi-stack").resolve()
    # Pi converts only `^file://` (case-sensitive) with `fileURLToPath`; other `file:` values are relative.
    assert agent("file:x") == (tmp_path / "file:x").resolve()
    assert agent("FILE:///x") == (tmp_path / "FILE:" / "x").resolve()


@pytest.mark.parametrize("value", ["file:///abs/agent", "file://localhost/abs/agent", "file://~/agent"])
def test_agent_dir_file_url_is_refused_before_anything_changes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, value: str
) -> None:
    """Pi reads a `file://` agent directory through `fileURLToPath`; guessing it could write elsewhere."""
    with pytest.raises(UnsupportedError, match="file://"):
        Layout.from_env({"PI_CODING_AGENT_DIR": value}, tmp_path, None)
    harness = Harness(tmp_path, monkeypatch)
    before = tree(tmp_path)
    with pytest.raises(UnsupportedError, match="PI_CODING_AGENT_DIR"):
        install.run(Options(SHA, True, False, None), harness.env | {"PI_CODING_AGENT_DIR": value}, None)
    assert tree(tmp_path) == before
    assert harness.calls() == []


MALFORMED_MANIFESTS = {
    "empty-object": "{}",
    "no-version": '{"name": "pi-memory"}',
    "no-name": '{"version": "0.4.2"}',
    "wrong-types": '{"name": 7, "version": ["0.4.2"]}',
    "not-an-object": "[]",
}
MALFORMED_LOCK_ENTRIES = {"string": "x", "null": None, "list": [], "number": 3}


def test_malformed_manifest_identity_is_a_value_error(tmp_path: Path) -> None:
    """The shared identity reader raises `ValueError`, never `KeyError`, for every bad manifest."""
    stack = real_snapshot().stack
    source = next(s for s in (source_string(p) for p in stack.sources) if s.startswith("npm:pi-memory@"))
    agent = tmp_path / "agent"
    package = agent / "npm" / "node_modules" / "pi-memory"
    package.mkdir(parents=True)
    fields = {
        "empty-object": "name",
        "no-version": "version",
        "no-name": "name",
        "wrong-types": "name",
        "not-an-object": "root",
    }
    for case, text in MALFORMED_MANIFESTS.items():
        (package / "package.json").write_text(text)
        with pytest.raises(ValueError, match="pi-memory") as raised:
            install.installed_identities(stack, [source] * len(stack.sources), agent)
        assert f"`{fields[case]}`" in str(raised.value)


@pytest.mark.parametrize("field", ["name", "version"])
@pytest.mark.parametrize("value", [[], "", 1, None, {}, False, pytest.param(..., id="omitted")])
def test_installed_manifest_independent_field_guard(tmp_path: Path, field: str, value: object) -> None:
    """Guard coverage: validate one malformed identity field while the other remains valid."""
    stack = real_snapshot().stack
    source = "npm:pi-memory@0.4.2"
    agent = tmp_path / "agent"
    package = agent / "npm" / "node_modules" / "pi-memory"
    package.mkdir(parents=True)
    manifest: dict[str, Any] = {"name": "pi-memory", "version": "0.4.2"}
    if value is ...:
        del manifest[field]
    else:
        manifest[field] = value
    (package / "package.json").write_text(json.dumps(manifest))
    before = tree(tmp_path)
    with pytest.raises(ValueError, match=rf"`{field}`") as raised:
        install.installed_identities(stack, [source] * len(stack.sources), agent)
    assert f"`{field}`" in str(raised.value)
    assert tree(tmp_path) == before


@pytest.mark.parametrize("field", ["root", "packages"])
@pytest.mark.parametrize("value", [[], "not-an-object", 1, None, False])
def test_owned_lock_container_guard(tmp_path: Path, field: str, value: object) -> None:
    """Guard coverage: malformed root/packages containers already failed; diagnostics name the field."""
    agent = tmp_path / "agent"
    lock = agent / "npm" / "package-lock.json"
    lock.parent.mkdir(parents=True)
    document = value if field == "root" else {"packages": value}
    lock.write_text(json.dumps(document))
    before = tree(tmp_path)
    with pytest.raises(InstallError) as raised:
        install.verify_owned_integrity(real_snapshot(), agent)
    assert f"`{field}`" in str(raised.value)
    assert tree(tmp_path) == before


@pytest.mark.parametrize("field", ["version", "integrity"])
@pytest.mark.parametrize(
    "value", [[], "", 1, None, {}, False, "wrong-nonempty-value", pytest.param(..., id="omitted")]
)
def test_owned_lock_object_field_guard(tmp_path: Path, field: str, value: object) -> None:
    """Guard coverage: object entries with bad version/integrity were already promotion mismatches."""
    snapshot = real_snapshot()
    entries: dict[str, dict[str, Any]] = {
        f"node_modules/{owned.package.rsplit('@', 1)[0]}": {
            "version": owned.package.rsplit("@", 1)[1],
            "integrity": owned.integrity,
        }
        for owned in snapshot.gates.owned_packages
    }
    first = next(iter(entries.values()))
    if value is ...:
        del first[field]
    else:
        first[field] = value
    agent = tmp_path / "agent"
    lock = agent / "npm" / "package-lock.json"
    lock.parent.mkdir(parents=True)
    lock.write_text(json.dumps({"packages": entries}))
    before = tree(tmp_path)
    with pytest.raises(InstallError) as raised:
        install.verify_owned_integrity(snapshot, agent)
    assert f"`{field}`" in str(raised.value)
    assert tree(tmp_path) == before


@pytest.mark.parametrize("case", sorted(MALFORMED_MANIFESTS))
def test_malformed_live_manifest_plans_repair_without_mutation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, case: str
) -> None:
    """A parseable but incomplete live manifest means repair, not a traceback, and waits for consent."""
    harness = Harness(tmp_path, monkeypatch)
    assert harness.run() == ExitCode.OK
    manifest = harness.layout.agent_dir / "npm" / "node_modules" / "pi-memory" / "package.json"
    manifest.write_text(MALFORMED_MANIFESTS[case])
    before = tree(harness.home)
    assert not install.packages_ready(harness.layout, harness.verified)
    assert plan_install(harness.layout, harness.verified).install_packages
    with pytest.raises(ConsentError):
        harness.run()
    assert tree(harness.home) == before
    assert harness.run(yes=True) == ExitCode.OK
    assert json.loads(manifest.read_text()) == {"name": "pi-memory", "version": "0.4.2"}


@pytest.mark.parametrize("case", sorted(MALFORMED_LOCK_ENTRIES))
def test_malformed_lock_entry_plans_repair_without_mutation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, case: str
) -> None:
    """A non-object lock `packages` entry for an owned package is a mismatch, not an `AttributeError`."""
    harness = Harness(tmp_path, monkeypatch)
    assert harness.run() == ExitCode.OK
    lock = harness.layout.agent_dir / "npm" / "package-lock.json"
    document = json.loads(lock.read_text())
    document["packages"]["node_modules/@nredd/pi-todo"] = MALFORMED_LOCK_ENTRIES[case]
    lock.write_text(json.dumps(document))
    before = tree(harness.home)
    with pytest.raises(InstallError, match="pi-todo") as raised:
        install.verify_owned_integrity(harness.snapshot, harness.layout.agent_dir)
    assert "`packages`" in str(raised.value)
    assert not install.packages_ready(harness.layout, harness.verified)
    with pytest.raises(ConsentError):
        harness.run()
    assert tree(harness.home) == before
    assert harness.run(yes=True) == ExitCode.OK
    assert json.loads(lock.read_text())["packages"]["node_modules/@nredd/pi-todo"]["version"] == "2.13.10"


def fail_post_check(monkeypatch: pytest.MonkeyPatch, failing: list[bool]) -> list[int]:
    """Make `post_check` fail while `failing[0]` is set, counting its calls.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): module patcher.
        failing (list[bool]): one-element switch.

    Returns:
        list[int]: one entry per call.
    """
    calls: list[int] = []
    original = install.post_check

    def check(layout: Layout) -> str:
        """Run the real check unless the failure is switched on.

        Parameters:
            layout (Layout): installer paths.

        Returns:
            str: version output.

        Raises:
            InstallError: while failing.
        """
        calls.append(1)
        if failing[0]:
            raise InstallError(f"Installed '{layout.link}' does not run: simulated")
        return original(layout)

    monkeypatch.setattr(install, "post_check", check)
    return calls


def test_failed_post_check_rolls_back_before_the_journal_commits(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An install that does not run is restored, never left in place and then called installed."""
    harness = Harness(tmp_path, monkeypatch)
    seed_existing(harness.home)
    before = {k: v for k, v in tree(harness.home).items() if "pi-stack" not in k}
    failing = [True]
    fail_post_check(monkeypatch, failing)
    with pytest.raises(InstallError, match=r"rolled back.*does not run") as raised:
        harness.run(yes=True)
    # The core was installed by this run, so removing it is not the advice.
    assert "was kept" not in str(raised.value)
    assert {k: v for k, v in tree(harness.home).items() if "pi-stack" not in k} == before
    assert not harness.layout.journal.exists()
    failing[0] = False
    assert harness.run(yes=True) == ExitCode.OK
    assert harness.layout.link.is_symlink()


def test_noop_rerun_still_runs_the_post_check(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """A matching install whose `pi --version` fails is never reported healthy."""
    harness = Harness(tmp_path, monkeypatch)
    assert harness.run() == ExitCode.OK
    failing = [True]
    calls = fail_post_check(monkeypatch, failing)
    before = tree(harness.home)
    caplog.set_level("INFO")
    with pytest.raises(InstallError, match="does not run") as raised:
        harness.run()
    assert f"Core '{harness.layout.core(harness.snapshot.stack.core.tag)}' was kept" in str(raised.value)
    assert calls == [1]
    assert "Already installed" not in caplog.text
    assert tree(harness.home) == before
    failing[0] = False
    assert harness.run() == ExitCode.OK
    assert f"Already installed: `stack/{SHA}`: 1.3.0, nothing to do" in caplog.messages


def test_failed_post_check_with_a_kept_core_names_its_removal(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A matching core marker is never reinstalled, so the error names the prefix to remove."""
    harness = Harness(tmp_path, monkeypatch)
    assert harness.run() == ExitCode.OK
    harness.layout.link.unlink()
    plan = plan_install(harness.layout, harness.verified)
    assert not plan.empty
    assert not plan.install_core
    fail_post_check(monkeypatch, [True])
    with pytest.raises(InstallError, match=r"rolled back.*does not run") as raised:
        harness.run(yes=True)
    assert f"Core '{harness.layout.core(harness.snapshot.stack.core.tag)}' was kept" in str(raised.value)
    assert "remove it and rerun" in str(raised.value)
