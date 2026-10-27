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
import errno
import hashlib
import inspect
import io
import json
import os
import re
import shutil
import socket
import ssl
import subprocess
import sys
import tarfile
from dataclasses import asdict
from email.message import Message
from http.client import HTTPException, IncompleteRead, RemoteDisconnected
from pathlib import Path
from textwrap import dedent
from typing import TYPE_CHECKING, Any
from urllib.error import HTTPError, URLError

import pytest
import yaml

from harness import install, release
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
ATOMIC_SUFFIX = re.compile(r"[0-9a-f]{32}\.(tmp|replacement)")
# Probe only synthetic/nonsecret keys, never dump arbitrary workstation credentials.
CHILD_ENV_PROBE_KEYS = (
    "NODE_OPTIONS",
    "NODE_PATH",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "all_proxy",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
    "REQUESTS_CA_BUNDLE",
    "CURL_CA_BUNDLE",
    "BASH_ENV",
    "ENV",
    "LD_PRELOAD",
    "DYLD_INSERT_LIBRARIES",
    "PYTHONPATH",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_KEY_0",
    "GIT_CONFIG_VALUE_0",
    "GIT_CONFIG_GLOBAL",
    "GIT_SSH_COMMAND",
    "GIT_ASKPASS",
    "Http_Proxy",
    "NPM_CONFIG_REGISTRY",
    "npm_config_registry",
    "NPM_CONFIG_PREFIX",
    "npm_config_prefix",
    "PI_FOO",
    "PI_CODING_AGENT_DIR",
    "HOME",
    "PATH",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "TERM",
    "XDG_DATA_HOME",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_STATE_HOME",
    "XDG_RUNTIME_DIR",
    "CI",
    "GITHUB_ACTIONS",
)
CONNECTIVITY_PROBE_KEYS = (
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "all_proxy",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
    "REQUESTS_CA_BUNDLE",
    "CURL_CA_BUNDLE",
)


@pytest.fixture(autouse=True)
def isolate_connectivity(monkeypatch: pytest.MonkeyPatch) -> None:
    """Never dump workstation proxy credentials or CA paths through recording test shims.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): scoped parent environment isolation.

    Returns:
        None: only explicitly set synthetic connectivity values can reach the shims.
    """
    for key in CONNECTIVITY_PROBE_KEYS:
        monkeypatch.delenv(key, raising=False)


FAKE_PI = """\
#!{python}
# Fake `pi`: `install npm:<name>@<version>` writes the package and its lockfile entry.
import json, os, pathlib, sys
with pathlib.Path({log!r}).with_suffix('.env.jsonl').open('a') as env_log:
    keys = {env_keys!r}
    env_log.write(json.dumps({{key: os.environ[key] for key in keys if key in os.environ}}) + "\\n")
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

        Returns:
            None: isolated HOME and network seams are ready.
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
        # Generic installer units model a native host, even when this test suite runs on WSL.
        monkeypatch.setattr(install, "is_wsl", lambda: False)
        monkeypatch.setattr(install, "preflight", lambda system, machine: {"node": "node"})
        monkeypatch.setattr(install, "verify_snapshot", lambda sha, workdir, **kwargs: self.snapshot)
        monkeypatch.setattr(
            install, "verify_release", lambda snapshot, node, workdir, **kwargs: self.verified
        )
        monkeypatch.setattr(install, "fetch_release", self.fetch_release)

    @property
    def layout(self) -> Layout:
        """Resolve the installer layout for this HOME.

        Returns:
            Layout: canonical fixture paths.
        """
        return Layout.from_env(self.env, self.home, None)

    def fetch_release(
        self,
        tag: str,
        prefix: Path,
        provenance: object = None,
        checksums: Mapping[str, str] | None = None,
        *,
        npm_bin: str | None = None,
    ) -> Path:
        """Write a fake core prefix whose `pi` is the recording fake.

        Parameters:
            tag (str): core tag.
            prefix (Path): empty prefix.
            provenance (object): ignored verifier.
            checksums (Mapping[str, str] | None): recorded digests the download is bound to.
            npm_bin (str | None): ignored dispatcher, since this fake writes the prefix directly.

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
                env_keys=CHILD_ENV_PROBE_KEYS,
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
        """Model a terminal closing while input waits for consent.

        Parameters:
            prompt (str): consent question.

        Returns:
            str: never returned.

        Raises:
            EOFError: always, modeling closed input.
        """
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


@pytest.mark.parametrize("failure", ["file", "eacces", "enospc", "erofs"])
def test_installer_root_creation_failure_is_clean_refusal(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture, failure: str
) -> None:
    """File-as-root and environment failures are clean exit 2 refusals, never raw mkdir tracebacks."""
    harness = Harness(tmp_path, monkeypatch)
    seed_existing(harness.home)
    root = harness.layout.root
    for name in ("XDG_DATA_HOME", "PI_CODING_AGENT_DIR"):
        monkeypatch.delenv(name, raising=False)
    if failure == "file":
        root.parent.mkdir(parents=True, exist_ok=True)
        root.write_text("not an installer directory")
    else:
        number = {"eacces": errno.EACCES, "enospc": errno.ENOSPC, "erofs": errno.EROFS}[failure]
        original = Path.mkdir

        def refuse(path: Path, *args: Any, **kwargs: Any) -> None:
            """Inject the actual filesystem error at installer-root creation only.

            Parameters:
                path (Path): directory to create.
                *args (Any): mkdir arguments.
                **kwargs (Any): mkdir options.

            Returns:
                None: unrelated directories are created.

            Raises:
                OSError: installer-root creation failed.
            """
            if path == root:
                raise OSError(number, os.strerror(number), str(path))
            original(path, *args, **kwargs)

        monkeypatch.setattr(Path, "mkdir", refuse)
    before = tree(harness.home)
    assert install.main([SHA, "--yes"]) == ExitCode.UNSUPPORTED
    assert "UNSUPPORTED:" in caplog.text
    assert f"Cannot create installer root '{root}'" in caplog.text
    assert "nothing changed" in caplog.text
    assert "Traceback" not in caplog.text
    assert tree(harness.home) == before
    assert harness.calls() == []


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


@pytest.mark.parametrize("failure", ["eacces", "interrupt"])
def test_unstarted_backup_rename_rolls_back_cleanly(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, failure: str
) -> None:
    """A pending step whose original never moved needs no missing backup and leaves no repair journal."""
    harness = Harness(tmp_path, monkeypatch)
    seed_existing(harness.home)
    layout = harness.layout
    before = {k: v for k, v in tree(harness.home).items() if "pi-stack" not in k}
    original = os.replace
    attempts: list[Path] = []

    def fail_rename(src: Any, dst: Any, **kwargs: Any) -> None:
        """Fail at the original-to-backup syscall, after record persisted but before any move.

        Parameters:
            src (Any): rename source.
            dst (Any): rename destination.
            **kwargs (Any): descriptor-relative rename options.

        Returns:
            None: unrelated renames complete.

        Raises:
            PermissionError: the selected backup rename was denied.
            KeyboardInterrupt: interrupted before the selected backup rename.
            OSError: an unrelated rename failed.
        """
        if Path(src) == layout.agent_dir / "npm":
            attempts.append(Path(src))
            if failure == "eacces":
                raise PermissionError(errno.EACCES, "backup rename refused")
            raise KeyboardInterrupt
        original(src, dst, **kwargs)

    with monkeypatch.context() as patch:
        patch.setattr(os, "replace", fail_rename)
        with pytest.raises(InstallError, match="rolled back") as raised:
            harness.run(yes=True)
    assert not isinstance(raised.value, RollbackError)
    assert len(attempts) == 1
    assert not layout.journal.exists()
    assert {k: v for k, v in tree(harness.home).items() if "pi-stack" not in k} == before
    assert harness.run(yes=True) == ExitCode.OK


def test_missing_backup_after_pending_rename_still_fails_loudly(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Preserve the lost-backup guard when rename succeeded but the saved phase was not persisted."""
    harness = Harness(tmp_path, monkeypatch)
    seed_existing(harness.home)
    layout = harness.layout
    original = os.replace

    def lose_backup_after_move(src: Any, dst: Any, **kwargs: Any) -> None:
        """Simulate loss after the original moved, before save marks it saved.

        Parameters:
            src (Any): rename source.
            dst (Any): rename destination.
            **kwargs (Any): rename options.

        Returns:
            None: unrelated renames complete.

        Raises:
            KeyboardInterrupt: the selected backup was removed after renaming.
            OSError: rename or fixture mutation failed.
        """
        original(src, dst, **kwargs)
        if Path(src) == layout.agent_dir / "npm":
            (backup,) = layout.backups.glob("*/npm")
            install.remove(backup)
            (layout.agent_dir / "npm").mkdir()
            (layout.agent_dir / "npm" / "replacement").write_text("new live entry")
            raise KeyboardInterrupt

    monkeypatch.setattr(os, "replace", lose_backup_after_move)
    with pytest.raises(RollbackError, match=r"Expected backup.*missing"):
        harness.run(yes=True)
    assert layout.journal.exists()
    assert (layout.agent_dir / "npm" / "replacement").read_text() == "new live entry"


@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("pending", "yes"),
        ("original", None),
        ("original", [1]),
        ("original", [True, 2, 3]),
        ("original", [-1, 2, 3]),
        ("original", ["1", 2, 3]),
    ],
)
def test_untrusted_pending_journal_metadata_is_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, key: str, value: object
) -> None:
    """Pending metadata must be strictly typed before it can excuse an absent original backup."""
    harness = Harness(tmp_path, monkeypatch)
    seed_existing(harness.home)
    interrupt(harness, monkeypatch)
    path = harness.layout.journal
    document = json.loads(path.read_text())
    step = next(step for step in document["steps"] if step["backup"])
    step[key] = value
    path.write_text(json.dumps(document))
    before = tree(harness.home)
    with pytest.raises(RollbackError, match="not trusted"):
        rollback(harness.layout)
    assert tree(harness.home) == before


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
        """Replace the checked store with an attacker-controlled symlink.

        Returns:
            None: the backup-store ancestor is replaced.

        Raises:
            OSError: fixture rename or link creation failed.
        """
        nonlocal attacked
        attacked = True
        layout.backups.mkdir(parents=True, exist_ok=True)
        layout.backups.rename(held)
        layout.backups.symlink_to(outside)

    def before_switch(*args: Any, **kwargs: Any) -> None:
        """Swap after the last kind check but before switch opens its directory.

        Parameters:
            *args (Any): forwarded switch arguments.
            **kwargs (Any): forwarded switch options.

        Returns:
            None: validation and the selected store swap complete.

        Raises:
            UnsupportedError: the store kind is refused.
        """
        swap_store()
        original_switch(*args, **kwargs)

    def during_replace(src: Any, dst: Any, **kwargs: Any) -> None:
        """Swap at the actual rename, then hide it with an empty real store before rollback.

        Parameters:
            src (Any): rename source.
            dst (Any): rename destination.
            **kwargs (Any): rename options.

        Returns:
            None: the injected rename completed.

        Raises:
            OSError: the underlying rename failed.
        """
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
        """Replace the ancestor after validation but at the restore syscall boundary.

        Parameters:
            src (Any): rename source.
            dst (Any): rename destination.
            **kwargs (Any): rename options.

        Returns:
            None: the rename completed against its anchored parent.

        Raises:
            OSError: the underlying rename failed.
        """
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
    journal.place(staged / "npm", layout.agent_dir / "npm")
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
        install.is_wsl = lambda: False
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
        """Exercise the real digest and manifest readers through the CLI outcome boundary.

        Parameters:
            opts (Options): requested stack.
            env (object): unused environment.
            ask (object): unused consent callback.

        Returns:
            ExitCode: successful verification.

        Raises:
            VerificationError: manifest validation failed.
        """
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


@pytest.mark.parametrize("caller", ["download", "checksums", "attestation"])
@pytest.mark.parametrize(
    "failure", ["truncated", "protocol", "disconnected", "io", "timeout", "tls", "length"]
)
def test_http_read_failures_are_clean_verification_failures(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    caller: str,
    failure: str,
) -> None:
    """Truncated-read regressions plus the HTTP/I/O/TLS/length family preserve clean CLI exit 3."""
    errors = {
        "truncated": IncompleteRead(b"partial", 100),
        "protocol": HTTPException("bad HTTP response"),
        "disconnected": RemoteDisconnected("peer disconnected"),
        "io": OSError(errno.EIO, "read failed"),
        "timeout": TimeoutError("read timed out"),
        "tls": ssl.SSLError("TLS read failed"),
        "length": ValueError("bad Content-Length"),
    }
    error = errors[failure]
    requests: list[str] = []

    class BrokenResponse(io.BytesIO):
        """A response that fails while consuming its body, not while opening the connection."""

        headers = Message()

        def read(self, size: int | None = -1) -> bytes:
            """Simulate an interrupted or malformed transfer after headers were accepted.

            Parameters:
                size (int | None): ignored read bound.

            Returns:
                bytes: never returned.

            Raises:
                OSError | HTTPException | ValueError: selected transfer failure.
            """
            raise error

    def open_response(request: Any, **kwargs: Any) -> BrokenResponse:
        """Record the exact caller URL and inject a body read failure.

        Parameters:
            request (Any): requested URL or request object.
            **kwargs (Any): ignored transport options.

        Returns:
            BrokenResponse: stream failing on its first read.
        """
        requests.append(request.full_url if hasattr(request, "full_url") else str(request))
        return BrokenResponse(b"partial")

    monkeypatch.setattr(release, "urlopen", open_response)
    snapshot = real_snapshot()
    artifact = tmp_path / "snapshot.json"
    artifact.write_bytes(FIXTURE.read_bytes())
    if caller == "attestation":
        monkeypatch.setattr(install, "download", lambda url, destination: artifact)

    def verify(opts: Options, env: object, ask: object) -> ExitCode:
        """Use the real verification caller and CLI error mapping.

        Parameters:
            opts (Options): requested stack.
            env (object): unused environment.
            ask (object): unused consent callback.

        Returns:
            ExitCode: successful verification.

        Raises:
            VerificationError: the simulated transfer failed.
        """
        if caller == "download":
            install.download("https://downloads.example.invalid/core.tgz", tmp_path / "download")
        elif caller == "checksums":
            core = snapshot.stack.core.model_copy(update={"tag": "v1.3.0-nredd.8"})
            stack = snapshot.stack.model_copy(update={"core": core})
            install.verify_release(snapshot.model_copy(update={"stack": stack}), "node", tmp_path)
        else:
            install.verify_snapshot(SHA, tmp_path)
        return ExitCode.OK

    monkeypatch.setattr(install, "run", verify)
    assert install.main([SHA]) == ExitCode.VERIFICATION
    assert len(requests) == 1
    assert requests[0] in caplog.text
    reasons = {
        "truncated": "Incomplete response: received 7 bytes, expected 100 more",
        "protocol": "HTTP protocol error: bad HTTP response",
        "disconnected": "Connection closed: peer disconnected",
        "io": "I/O error: read failed",
        "timeout": "Request timed out",
        "tls": "TLS error: TLS read failed",
        "length": "bad Content-Length",
    }
    assert reasons[failure] in caplog.text
    assert caplog.text.count(requests[0]) == 1
    assert "VERIFICATION FAILED, nothing changed" in caplog.text
    assert "Traceback" not in caplog.text
    assert not (tmp_path / "download").exists()


@pytest.mark.parametrize(
    ("kind", "reason"),
    [
        ("404", "HTTP 404 Not Found"),
        ("403", "HTTP 403 Forbidden"),
        ("500", "HTTP 500 Internal Server Error"),
        ("429", "HTTP 429 Too Many Requests"),
        ("dns", "DNS lookup failed"),
        ("timeout", "Request timed out"),
        ("truncated", "Incomplete response: received 3 bytes, expected 7 more"),
        ("truncated-unknown", "Incomplete response: received 3 bytes"),
    ],
)
def test_snapshot_fetch_cli_has_one_stable_diagnostic(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    kind: str,
    reason: str,
) -> None:
    """Exit three with one URL and the exact public reason, never nested urllib diagnostics.

    Parameters:
        tmp_path (Path): isolated installer HOME.
        monkeypatch (pytest.MonkeyPatch): HTTP failure and offline prerequisite seams.
        caplog (pytest.LogCaptureFixture): CLI log output.
        kind (str): concrete failure category.
        reason (str): literal expected user-facing reason.

    Returns:
        None: the CLI contract is exact and the home remains unchanged.
    """
    harness = Harness(tmp_path, monkeypatch)
    monkeypatch.setenv("PI_CODING_AGENT_DIR", str(harness.layout.agent_dir))
    monkeypatch.setenv("XDG_DATA_HOME", str(harness.layout.root.parent))
    failures = {
        "404": HTTPError("https://error.invalid/", 404, "Not Found", Message(), None),
        "403": HTTPError("https://error.invalid/", 403, "Forbidden", Message(), None),
        "500": HTTPError("https://error.invalid/", 500, "Internal Server Error", Message(), None),
        "429": HTTPError("https://error.invalid/", 429, "Too Many Requests", Message(), None),
        "dns": URLError(socket.gaierror(-2, "platform-specific DNS detail")),
        "timeout": TimeoutError("platform-specific timeout detail"),
        "truncated": IncompleteRead(b"abc", 7),
        "truncated-unknown": IncompleteRead(b"abc"),
    }

    def failed(request: Any, **kwargs: Any) -> Any:
        """Raise this case's concrete transport failure.

        Parameters:
            request (Any): ignored URL/request.
            **kwargs (Any): ignored transport options.

        Returns:
            Any: never returned.

        Raises:
            Exception: selected HTTP, DNS, timeout or incomplete-read fixture.
        """
        raise failures[kind]

    monkeypatch.setattr(release, "urlopen", failed)
    monkeypatch.setattr(install, "verify_snapshot", verify_snapshot)
    before = tree(harness.home)
    assert install.main([SHA, "--plan"]) == ExitCode.VERIFICATION
    url = f"https://github.com/nredd/pi-harness/releases/download/stack/{SHA}/stack-snapshot.json"
    assert caplog.messages == [f"VERIFICATION FAILED, nothing changed: Could not fetch '{url}': {reason}"]
    assert tree(harness.home) == before


def test_acceptance_plan_staging_and_rerun_text_contracts(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Lock the installer-owned text matched by acceptance consent, staging and rerun checks.

    Parameters:
        tmp_path (Path): isolated installer HOME.
        monkeypatch (pytest.MonkeyPatch): offline core/network fixture.
        caplog (pytest.LogCaptureFixture): actual message producer output.

    Returns:
        None: overwrite/source, kill-marker, version and no-op messages retain stable contracts.
    """
    harness = Harness(tmp_path, monkeypatch)
    seed_existing(harness.home)
    settings = harness.layout.agent_dir / install.SETTINGS_FILE
    document = json.loads(settings.read_text()) | {"packages": ["npm:pi-mine@1.0.0"]}
    settings.write_text(json.dumps(document))
    caplog.set_level("INFO")
    with pytest.raises(ConsentError):
        harness.run()
    assert "OVERWRITE stop loading packages not in the stack: npm:pi-mine@1.0.0" in caplog.messages
    caplog.clear()
    assert harness.run(yes=True) == ExitCode.OK
    assert "pi install 'npm:pi-web-access@0.43.0'" in caplog.messages
    assert any(message.startswith(acceptance.KILL_AFTER) for message in caplog.messages)
    assert install.post_check(harness.layout) == "1.3.0"
    caplog.clear()
    assert harness.run() == ExitCode.OK
    assert f"Already installed: `stack/{SHA}`: 1.3.0, nothing to do" in caplog.messages


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
        lambda path, repo, signer, ref, **kwargs: identities.append((repo, signer, ref)),
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

    def reject(*args: object, **kwargs: object) -> None:
        """Reject like `gh attestation verify` on a digest mismatch.

        Parameters:
            *args (object): ignored.
            **kwargs (object): ignored verifier options.

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
    monkeypatch.setattr(install, "verify_release", lambda snapshot, node, workdir, **kwargs: verified)
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

    Returns:
        None: the interrupted switch leaves its journal for recovery.
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

    Returns:
        None: private journal bytes are replaced.

    Raises:
        OSError: journal read or write failed.
        ValueError: journal fixture cannot be decoded.
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

        Returns:
            None: the step is appended in place.
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

        Returns:
            None: the backup reference is replaced in place.
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


def set_journal_fields(**values: Any) -> Callable[[dict[str, Any]], None]:
    """Build a named journal edit using the documented dictionary-merge form.

    Parameters:
        **values (Any): top-level fixture fields to replace.

    Returns:
        Callable[[dict[str, Any]], None]: named edit function.
    """

    def edit(document: dict[str, Any]) -> None:
        """Merge this fixture's malformed fields into the journal.

        Parameters:
            document (dict[str, Any]): journal fixture.

        Returns:
            None: document is mutated in place.
        """
        document |= values

    return edit


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
            edit_journal(harness, set_journal_fields(backups=f"{backups}/.."))
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
            edit_journal(harness, set_journal_fields(steps={}))
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
    with pytest.raises(RollbackError, match="not trusted"):
        install.run(Options(SHA, False, True, None), harness.env, None)
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

    def stage_then_swap(
        layout: Layout, verified: Verified, plan: install.Plan, staging: Path, **kwargs: Any
    ) -> Path | None:
        """Stage, then turn the `pi` link into a directory before the switch reaches it.

        Parameters:
            layout (Layout): installer paths.
            verified (Verified): verified input.
            plan (install.Plan): planned changes.
            staging (Path): staging directory.
            **kwargs (Any): preflight-selected tool paths forwarded to staging.

        Returns:
            Path | None: the staged agent tree.
        """
        staged = original(layout, verified, plan, staging, **kwargs)
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
install.is_wsl = lambda: False
install.preflight = lambda system, machine: {"node": "node"}
install.verify_snapshot = lambda sha, workdir, **kwargs: snapshot
install.verify_release = lambda snapshot, node, workdir, **kwargs: install.Verified(snapshot, sources, {})
sys.exit(install.main(sys.argv[2:]))
"""


def make_special(path: Path, kind: str, monkeypatch: pytest.MonkeyPatch) -> None:
    """Create a FIFO, a link to one, or a Unix socket at `path`.

    Parameters:
        path (Path): entry to create; its parent exists.
        kind (str): `fifo`, `fifo-link` or `socket`.
        monkeypatch (pytest.MonkeyPatch): restores the working directory a socket bind uses.

    Returns:
        None: the selected special entry exists.

    Raises:
        OSError: entry creation failed.
        ValueError: the requested special-entry kind is unknown.
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

        Returns:
            None: flush-time permissions are recorded and fsync completes.

        Raises:
            OSError: descriptor lookup or fsync failed.
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

    Returns:
        None: the synthetic gh login is written.

    Raises:
        OSError: fixture write failed.

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
            """Interrupt after the core switch, before writing the installed state.

            Parameters:
                *args (object): ignored file replacement arguments.

            Returns:
                None: never returned.

            Raises:
                RuntimeError: installed-state write was interrupted.
            """
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


@pytest.mark.parametrize("pending_journal", [False, True], ids=["no-journal-guard", "pending-regression"])
@pytest.mark.parametrize("flags", [[], ["--plan"], ["--yes"]], ids=["normal", "plan", "yes"])
def test_wsl_admission_precedes_pending_journal(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    pending_journal: bool,
    flags: list[str],
) -> None:
    """Refuse physical WSL before --plan reporting or --yes recovery can inspect or change a journal."""
    harness = Harness(tmp_path, monkeypatch)
    seed_existing(harness.home)
    if pending_journal:
        interrupt(harness, monkeypatch)
    journal = harness.layout.journal.read_bytes() if pending_journal else None
    for name in ("XDG_DATA_HOME", "PI_CODING_AGENT_DIR"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(install, "preflight", REAL_PREFLIGHT)
    monkeypatch.setattr(install, "is_wsl", lambda: True)
    monkeypatch.setattr(install.platform, "system", lambda: "Linux")
    monkeypatch.setattr(install.platform, "machine", lambda: "x86_64")
    before = tree(tmp_path)
    assert install.main([SHA, *flags]) == ExitCode.UNSUPPORTED
    assert "WSL" in caplog.text
    assert "nothing changed" in caplog.text
    assert tree(tmp_path) == before
    if pending_journal:
        assert harness.layout.journal.read_bytes() == journal


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
    assert unexpanded.root == home / ".local" / "share" / "pi-stack"
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
    "wrong-name": '{"name": "wrong-package", "version": "0.4.2"}',
    "empty-object": "{}",
    "no-version": '{"name": "pi-memory"}',
    "no-name": '{"version": "0.4.2"}',
    "wrong-types": '{"name": 7, "version": ["0.4.2"]}',
    "not-an-object": "[]",
}
MALFORMED_LOCK_ENTRIES = {"string": "x", "null": None, "list": [], "number": 3}
LOCK_CONTAINER_VALUES = [[], "not-an-object", 1, None, False]
LOCK_OBJECT_FIELD_VALUES = [
    [],
    "",
    1,
    None,
    {},
    False,
    "wrong-nonempty-value",
    pytest.param(..., id="omitted"),
]


def test_malformed_manifest_identity_is_a_value_error(tmp_path: Path) -> None:
    """The shared identity reader raises `ValueError`, never `KeyError`, for every bad manifest."""
    stack = real_snapshot().stack
    source = next(s for s in (source_string(p) for p in stack.sources) if s.startswith("npm:pi-memory@"))
    agent = tmp_path / "agent"
    package = agent / "npm" / "node_modules" / "pi-memory"
    package.mkdir(parents=True)
    fields = {
        "wrong-name": "name",
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


def owned_lock_container_error(tmp_path: Path, field: str, value: object) -> str:
    """Require unchanged refusal without mutations and return its diagnostic for a separate test.

    Parameters:
        tmp_path (Path): scratch directory.
        field (str): malformed container.
        value (object): bad JSON container value.

    Returns:
        str: rejection message, without asserting its newer field-specific wording.
    """
    agent = tmp_path / "agent"
    lock = agent / "npm" / "package-lock.json"
    lock.parent.mkdir(parents=True)
    document = value if field == "root" else {"packages": value}
    lock.write_text(json.dumps(document))
    before = tree(tmp_path)
    with pytest.raises(InstallError) as raised:
        install.verify_owned_integrity(real_snapshot(), agent)
    assert tree(tmp_path) == before
    return str(raised.value)


@pytest.mark.parametrize("field", ["root", "packages"])
@pytest.mark.parametrize("value", LOCK_CONTAINER_VALUES)
def test_owned_lock_container_refusal_guard(tmp_path: Path, field: str, value: object) -> None:
    """Unchanged refusal guard: all ten cases pass on 8488a7a, independent of diagnostic wording."""
    owned_lock_container_error(tmp_path, field, value)


@pytest.mark.parametrize("field", ["root", "packages"])
@pytest.mark.parametrize("value", LOCK_CONTAINER_VALUES)
def test_owned_lock_container_diagnostic_regression(tmp_path: Path, field: str, value: object) -> None:
    """Diagnostic regression: all ten field-label assertions fail on 8488a7a."""
    assert f"`{field}`" in owned_lock_container_error(tmp_path, field, value)


def owned_lock_object_field_error(tmp_path: Path, field: str, value: object) -> str:
    """Require an object-entry mismatch without mutations, leaving wording to a separate test.

    Parameters:
        tmp_path (Path): scratch directory.
        field (str): malformed entry field.
        value (object): bad JSON value or omission sentinel.

    Returns:
        str: rejection message, without asserting its newer field-specific wording.
    """
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
    assert tree(tmp_path) == before
    return str(raised.value)


@pytest.mark.parametrize("field", ["version", "integrity"])
@pytest.mark.parametrize("value", LOCK_OBJECT_FIELD_VALUES)
def test_owned_lock_object_field_refusal_guard(tmp_path: Path, field: str, value: object) -> None:
    """Unchanged refusal guard: all sixteen cases pass on 8488a7a without wording assertions."""
    owned_lock_object_field_error(tmp_path, field, value)


@pytest.mark.parametrize("field", ["version", "integrity"])
@pytest.mark.parametrize("value", LOCK_OBJECT_FIELD_VALUES)
def test_owned_lock_object_field_diagnostic_regression(tmp_path: Path, field: str, value: object) -> None:
    """Diagnostic regression: all sixteen field-label assertions fail on 8488a7a."""
    assert f"`{field}`" in owned_lock_object_field_error(tmp_path, field, value)


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


def pending_file_restore(harness: Harness) -> dict[Path, bytes]:
    """Journal settings followed by installed.json, matching the switch's restore order.

    Parameters:
        harness (Harness): isolated installer home.

    Returns:
        dict[Path, bytes]: original live bytes expected after recovery.
    """
    layout = harness.layout
    originals = {
        layout.agent_dir / install.SETTINGS_FILE: b'{"original":"settings"}',
        layout.state: b'{"original":"installed"}',
    }
    for path, contents in originals.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(contents)
    journal = Journal(layout, layout.backups / "retry")
    with journal.open_backups():
        for path in originals:
            install.replace_file(journal, path, path.name, '{"replacement":true}')
    return originals


def test_partial_rollback_resumes_completed_restores(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Restore installed.json, fail settings.json's rename, then retry without requiring consumed backups."""
    harness = Harness(tmp_path, monkeypatch)
    originals = pending_file_restore(harness)
    layout = harness.layout
    original_replace = os.replace
    attempts: list[Path] = []

    def fail_second(src: Any, dst: Any, **kwargs: Any) -> None:
        """Fail only the second backup-to-live rename, not atomic journal rewrites.

        Parameters:
            src (Any): rename source.
            dst (Any): rename destination.
            **kwargs (Any): rename options.

        Returns:
            None: other renames complete.

        Raises:
            OSError: the selected second rename failed.
        """
        if kwargs.get("src_dir_fd") is not None:
            attempts.append(Path(dst))
            if Path(dst).name == install.SETTINGS_FILE:
                raise OSError(errno.EIO, "second restore refused")
        original_replace(src, dst, **kwargs)

    with monkeypatch.context() as patch:
        patch.setattr(os, "replace", fail_second)
        with pytest.raises(RollbackError, match="second restore refused"):
            rollback(layout)
    assert attempts == [layout.state, layout.agent_dir / install.SETTINGS_FILE]
    assert layout.state.read_bytes() == originals[layout.state]
    assert not (layout.backups / "retry" / install.STATE_FILE).exists()
    assert rollback(layout) == [str(layout.agent_dir / install.SETTINGS_FILE)]
    assert {path: path.read_bytes() for path in originals} == originals
    assert not layout.journal.exists()


def test_recorded_restore_rejects_changed_live_state(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Recorded progress cannot excuse a consumed backup when its restored live entry changed."""
    harness = Harness(tmp_path, monkeypatch)
    originals = pending_file_restore(harness)
    layout = harness.layout
    original_replace = os.replace

    def fail_second(src: Any, dst: Any, **kwargs: Any) -> None:
        """Leave recovery interrupted after installed.json was restored.

        Parameters:
            src (Any): rename source.
            dst (Any): rename destination.
            **kwargs (Any): rename options.

        Returns:
            None: other renames complete.

        Raises:
            OSError: the next restore was refused.
        """
        if kwargs.get("src_dir_fd") is not None and Path(dst).name == install.SETTINGS_FILE:
            raise OSError("second restore refused")
        original_replace(src, dst, **kwargs)

    with monkeypatch.context() as patch:
        patch.setattr(os, "replace", fail_second)
        with pytest.raises(RollbackError):
            rollback(layout)
    layout.state.unlink()
    layout.state.write_bytes(originals[layout.state])
    before = tree(harness.home)
    with pytest.raises(RollbackError, match=r"Restored target.*changed"):
        rollback(layout)
    assert tree(harness.home) == before


def test_rollback_unlink_failure_leaves_completed_journal(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Once originals are restored, failed journal cleanup must be retryable without any backups."""
    harness = Harness(tmp_path, monkeypatch)
    originals = pending_file_restore(harness)
    layout = harness.layout
    original_unlink = Path.unlink

    def fail_cleanup(path: Path, *args: Any, **kwargs: Any) -> None:
        """Refuse transaction cleanup after all restore renames have succeeded.

        Parameters:
            path (Path): unlink destination.
            *args (Any): unlink arguments.
            **kwargs (Any): unlink options.

        Returns:
            None: unrelated unlinks complete.

        Raises:
            OSError: journal unlink failed.
        """
        if path == layout.journal:
            raise OSError(errno.EACCES, "journal cleanup refused")
        original_unlink(path, *args, **kwargs)

    with monkeypatch.context() as patch:
        patch.setattr(Path, "unlink", fail_cleanup)
        with pytest.raises(RollbackError, match="journal cleanup refused"):
            rollback(layout)
    assert {path: path.read_bytes() for path in originals} == originals
    completed = json.loads(layout.journal.read_text())
    shutil.rmtree(layout.backups)
    install.recover(layout, True, None)
    assert completed["steps"] == []
    assert not layout.journal.exists()
    assert {path: path.read_bytes() for path in originals} == originals


@pytest.mark.parametrize("flags", [["--plan"], ["--yes"]], ids=["plan", "recovery"])
@pytest.mark.parametrize("payload", ["nested", "oversized"])
def test_bounded_journal_failures_exit_cleanly(tmp_path: Path, flags: list[str], payload: str) -> None:
    """Actual CLI children reject deeply nested and oversized journals on both entry paths."""
    _, root = special_home(tmp_path)
    text = "[" * 10000 + "0" + "]" * 10000 if payload == "nested" else " " * (1024 * 1024 + 1)
    journal = root / install.JOURNAL_FILE
    journal.write_text(text)
    journal.chmod(0o600)
    before = tree(tmp_path)
    result = subprocess.run(
        [sys.executable, "-c", SPECIAL_CHILD, str(FIXTURE), SHA, *flags],
        env={
            "HOME": str(tmp_path / "home"),
            "PATH": os.defpath,
            "PYTHONPATH": str(INTEGRATION),
            "XDG_DATA_HOME": str(tmp_path / "data"),
        },
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    assert result.returncode == ExitCode.FAILED, result.stderr
    assert "is not trusted" in result.stderr
    assert "nothing was restored" in result.stderr
    if payload == "oversized":
        assert "exceeds 1048576 bytes" in result.stderr
    assert "Traceback" not in result.stderr
    assert {k: v for k, v in tree(tmp_path).items() if not k.endswith("pi-stack/lock")} == before


@pytest.mark.parametrize("name", [install.SETTINGS_FILE, install.SUBAGENTS_FILE])
@pytest.mark.parametrize("text", ["{}", ""])
def test_existing_empty_config_never_bypasses_consent(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, name: str, text: str
) -> None:
    """An empty object is still existing state; empty bytes remain corrupt JSON, never CREATE."""
    harness = Harness(tmp_path, monkeypatch)
    path = harness.layout.agent_dir / name
    path.parent.mkdir(parents=True)
    path.write_text(text)
    before = tree(harness.home)
    if text:
        plan = plan_install(harness.layout, harness.verified)
        assert any(str(path) in line for line in plan.overwrites)
        assert not any(str(path) in line for line in plan.creates if "install " not in line)
        with pytest.raises(ConsentError):
            harness.run()
    else:
        with pytest.raises(InstallError, match="not readable JSON"):
            harness.run()
    assert path.read_text() == text
    assert {k: v for k, v in tree(harness.home).items() if "pi-stack" not in k} == before
    assert harness.calls() == []


@pytest.mark.parametrize("field", ["name", "version"])
def test_wrong_staged_manifest_identity_is_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, field: str
) -> None:
    """A successful npm command cannot stage a foreign identity at the pinned package path."""
    harness = Harness(tmp_path, monkeypatch)
    original = subprocess.check_output

    def install_wrong_identity(argv: list[str], **kwargs: Any) -> str:
        """Run fake pi, then corrupt one installed manifest before staging verifies it.

        Parameters:
            argv (list[str]): child command.
            **kwargs (Any): child options.

        Returns:
            str: child output after manifest corruption.

        Raises:
            subprocess.SubprocessError: the child failed.
        """
        output = original(argv, **kwargs)
        if argv[1:] == ["install", "npm:pi-memory@0.4.2"]:
            agent = Path(kwargs["env"]["PI_CODING_AGENT_DIR"])
            manifest = agent / "npm/node_modules/pi-memory/package.json"
            document = json.loads(manifest.read_text())
            document[field] = "wrong-package" if field == "name" else "9.9.9"
            manifest.write_text(json.dumps(document))
        return output

    monkeypatch.setattr(subprocess, "check_output", install_wrong_identity)
    with pytest.raises(InstallError, match=rf"Staged packages.*`{field}`"):
        harness.run()
    assert not harness.layout.state.exists()
    assert not harness.layout.agent_dir.exists()


@pytest.mark.parametrize("operation", ["write", "rename"])
@pytest.mark.parametrize("after", [False, True], ids=["before", "after"])
@pytest.mark.parametrize("failure", [OSError, KeyboardInterrupt], ids=["io", "interrupt"])
def test_restore_every_call_boundary_is_retryable(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    operation: str,
    after: bool,
    failure: type[BaseException],
) -> None:
    """Interrupt every journal rewrite/restore rename, including both sides of the consumed-backup gap."""
    # Two restores, each with an intent and completion rewrite, then the empty completion record.
    count = 5 if operation == "write" else 2
    original_write, original_replace = install.write_atomic, os.replace
    for injection in range(count):
        case = tmp_path / str(injection)
        case.mkdir()
        with monkeypatch.context() as patch:
            harness = Harness(case, patch)
            originals = pending_file_restore(harness)
            calls = 0

            def fault(call: Callable[[], None], point: int = injection) -> None:
                """Fail once at this exact sequence index, before or after the operation.

                Parameters:
                    call (Callable[[], None]): operation to run.
                    point (int): selected fault index.

                Returns:
                    None: non-failing operations complete.

                Raises:
                    OSError | KeyboardInterrupt: injected interruption.
                """
                nonlocal calls
                index = calls
                calls += 1
                if index == point and not after:
                    raise failure("restore boundary")
                call()
                if index == point and after:
                    raise failure("restore boundary")

            def write(path: Path, text: str, mode: int | None = None) -> None:
                """Fault only the atomic journal rewrite seam.

                Parameters:
                    path (Path): write destination.
                    text (str): new contents.
                    mode (int | None): requested permissions.

                Returns:
                    None: the atomic write completes unless interrupted.

                Raises:
                    OSError | KeyboardInterrupt: injected interruption.
                """
                fault(lambda: original_write(path, text, mode))

            def rename(src: Any, dst: Any, **kwargs: Any) -> None:
                """Fault only backup-to-live renames, not journal replacements.

                Parameters:
                    src (Any): rename source.
                    dst (Any): rename destination.
                    **kwargs (Any): rename options.

                Returns:
                    None: the rename completes unless interrupted.

                Raises:
                    OSError | KeyboardInterrupt: injected interruption.
                """
                if kwargs.get("src_dir_fd") is not None:
                    fault(lambda: original_replace(src, dst, **kwargs))
                else:
                    original_replace(src, dst, **kwargs)

            with patch.context() as fault_patch:
                fault_patch.setattr(
                    install, "write_atomic", write if operation == "write" else original_write
                )
                fault_patch.setattr(os, "replace", rename if operation == "rename" else original_replace)
                with pytest.raises((RollbackError, KeyboardInterrupt), match="restore boundary"):
                    rollback(harness.layout)
            assert calls == injection + 1
            rollback(harness.layout)
            assert {path: path.read_bytes() for path in originals} == originals
            assert not harness.layout.journal.exists()


@pytest.mark.parametrize("mismatch", ["size", "mtime", "absent"])
def test_restore_intent_does_not_excuse_lost_backup(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, mismatch: str
) -> None:
    """A consumed backup is excused only while live mtime and size match the write-ahead identity."""
    harness = Harness(tmp_path, monkeypatch)
    pending_file_restore(harness)
    original = os.replace

    def interrupt_restore(src: Any, dst: Any, **kwargs: Any) -> None:
        """Interrupt just after installed.json's backup is consumed.

        Parameters:
            src (Any): rename source.
            dst (Any): rename destination.
            **kwargs (Any): rename options.

        Returns:
            None: unrelated renames complete.

        Raises:
            KeyboardInterrupt: the backup rename completed before interruption.
        """
        original(src, dst, **kwargs)
        if kwargs.get("src_dir_fd") is not None:
            raise KeyboardInterrupt

    with monkeypatch.context() as patch:
        patch.setattr(os, "replace", interrupt_restore)
        with pytest.raises(KeyboardInterrupt):
            rollback(harness.layout)
    state = harness.layout.state
    info = state.stat()
    if mismatch == "size":
        state.write_bytes(state.read_bytes() + b" ")
        os.utime(state, ns=(info.st_atime_ns, info.st_mtime_ns))
    elif mismatch == "mtime":
        os.utime(state, ns=(info.st_atime_ns, info.st_mtime_ns + 1_000_000_000))
    else:
        state.unlink()
    before = tree(harness.home)
    with pytest.raises(RollbackError, match=r"Expected backup.*missing"):
        rollback(harness.layout)
    assert tree(harness.home) == before
    assert harness.layout.journal.exists()


def test_installer_linux_helper_policy_documentation() -> None:
    """Installer policy is not a claim that the package lacks opt-in Linux support."""
    text = (INTEGRATION.parent / "docs/install.md").read_text()
    assert "Linux has no supported helper" not in text
    assert "../packages/computer-use/docs/linux.md" in text
    assert "disabled by installer policy" in text


def test_installer_restore_retry_documentation() -> None:
    """The retry contract names write-ahead reconciliation and its lost-backup refusal."""
    text = (INTEGRATION.parent / "docs/install.md").read_text()
    assert "`restoring`" in text
    assert "mtime and size" in text
    assert "missing backup with a nonmatching live target fails loudly" in text


def recovery_entry(path: Path, kind: str, contents: str) -> None:
    """Write a file, one-child tree or symlink without following an existing entry.

    Parameters:
        path (Path): entry to create or replace.
        kind (str): file, directory or symlink.
        contents (str): file/child bytes or readlink target.

    Returns:
        None: the selected entry is created.

    Raises:
        OSError: fixture mutation failed.
    """
    install.remove(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if kind == "directory":
        path.mkdir()
        (path / "child").write_text(contents)
    elif kind == "symlink":
        path.symlink_to(contents)
    else:
        path.write_text(contents)


def saved_recovery_entry(harness: Harness, kind: str) -> tuple[Journal, Path]:
    """Create one saved backup and its live replacement using the switch's real journal API.

    Parameters:
        harness (Harness): isolated installer home.
        kind (str): original entry kind.

    Returns:
        tuple[Journal, Path]: saved journal and live target.
    """
    layout = harness.layout
    target = {"file": layout.state, "directory": layout.agent_dir / "npm", "symlink": layout.link}[kind]
    recovery_entry(target, kind, "ORIGINAL")
    name, _ = install.journaled_path(layout, target)
    journal = Journal(layout, layout.backups / "content")
    with journal.open_backups():
        backup = journal.record(target, name)
        assert backup is not None
        journal.save(target, backup)
        replacement = target.with_name(target.name + ".new-fixture")
        recovery_entry(replacement, kind, "NEW FILE")
        place = getattr(journal, "place", None)
        if place is None:
            # Exercise the old switch protocol too when production is reverted for regression proofs.
            replacement.replace(target)
        else:
            place(replacement, target)
    return journal, target


def forge_recovery_entry(path: Path, kind: str, *, replace: bool = False, identical: bool = False) -> None:
    """Change content while preserving size/mtime, optionally substituting the entry's inode.

    Parameters:
        path (Path): original entry.
        kind (str): file, directory or symlink.
        replace (bool): substitute a separate entry rather than change bytes in place.
        identical (bool): retain content to isolate the device/inode corroboration check.

    Returns:
        None: the entry is forged with preserved size and mtime.

    Raises:
        OSError: fixture mutation failed.
    """
    info = path.lstat()
    value = "ORIGINAL" if identical else "FORGERY!"
    if replace or kind == "symlink":
        # Keep the old inode allocated so a filesystem cannot immediately recycle it.
        held = path.with_name(path.name + "-held")
        path.rename(held)
        recovery_entry(path, kind, value)
    else:
        data = path / "child" if kind == "directory" else path
        before = data.stat()
        data.write_text(value)
        os.utime(data, ns=(before.st_atime_ns, before.st_mtime_ns))
    os.utime(path, ns=(info.st_atime_ns, info.st_mtime_ns), follow_symlinks=False)


@pytest.mark.parametrize("case", ["file", "file-copy", "identical-copy", "symlink", "directory"])
def test_restore_intent_rejects_preserved_metadata_forgery(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, case: str
) -> None:
    """Same size and mtime never excuse changed bytes, changed link targets or a substituted inode."""
    harness = Harness(tmp_path, monkeypatch)
    kind = "file" if case in {"file-copy", "identical-copy"} else case
    _, target = saved_recovery_entry(harness, kind)
    original_replace = os.replace

    def interrupt(src: Any, dst: Any, **kwargs: Any) -> None:
        """Consume the original backup, then interrupt before the completion journal rewrite.

        Parameters:
            src (Any): rename source.
            dst (Any): rename destination.
            **kwargs (Any): rename options.

        Returns:
            None: unrelated renames complete.

        Raises:
            KeyboardInterrupt: restore completed before progress was saved.
        """
        original_replace(src, dst, **kwargs)
        if kwargs.get("src_dir_fd") is not None:
            raise KeyboardInterrupt

    with monkeypatch.context() as patch:
        patch.setattr(os, "replace", interrupt)
        with pytest.raises(KeyboardInterrupt):
            rollback(harness.layout)
    forge_recovery_entry(target, kind, replace=case.endswith("copy"), identical=case == "identical-copy")
    before = tree(harness.home)
    with pytest.raises(RollbackError):
        rollback(harness.layout)
    assert tree(harness.home) == before
    assert harness.layout.journal.exists()


@pytest.mark.parametrize("kind", ["file", "symlink", "directory"])
@pytest.mark.parametrize("replace", [False, True], ids=["content-change", "inode-swap"])
def test_backup_content_is_rechecked_after_restore_intent(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, kind: str, replace: bool
) -> None:
    """Tampering after the intent rewrite must preserve BOTH backup and live replacement on refusal."""
    harness = Harness(tmp_path, monkeypatch)
    journal, target = saved_recovery_entry(harness, kind)
    name, _ = install.journaled_path(harness.layout, target)
    backup = journal.backups / name
    original_write = install.write_atomic
    attacked = False

    def tamper(path: Path, text: str, mode: int | None = None) -> None:
        """Modify the backup immediately after write-ahead intent becomes durable.

        Parameters:
            path (Path): atomic write destination.
            text (str): serialized journal.
            mode (int | None): requested permissions.

        Returns:
            None: the write and selected corruption complete.

        Raises:
            OSError: the atomic write failed.
        """
        nonlocal attacked
        original_write(path, text, mode)
        if path == harness.layout.journal and not attacked:
            attacked = True
            forge_recovery_entry(backup, kind, replace=replace)

    with monkeypatch.context() as patch:
        patch.setattr(install, "write_atomic", tamper)
        with pytest.raises(RollbackError):
            rollback(harness.layout)
    assert attacked
    if kind == "directory":
        assert tree(target) == {"child": b"NEW FILE"}
        assert tree(backup) == {"child": b"FORGERY!"}
    elif kind == "symlink":
        assert target.readlink() == Path("NEW FILE")
        assert backup.readlink() == Path("FORGERY!")
    else:
        assert target.read_bytes() == b"NEW FILE"
        assert backup.read_bytes() == b"FORGERY!"
    before_retry = tree(harness.home)
    with pytest.raises(RollbackError):
        rollback(harness.layout)
    assert tree(harness.home) == before_retry
    assert backup.exists(follow_symlinks=False)
    assert harness.layout.journal.exists()


def test_every_existing_switch_write_is_classified_before_consent(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Derive the write set from Journal.record calls, including the unconditional state record."""
    harness = Harness(tmp_path, monkeypatch)
    assert harness.run() == ExitCode.OK
    layout = harness.layout
    # Force a settings-only repair with no other old paths to hide missing state consent.
    for name in (install.SETTINGS_FILE, install.SUBAGENTS_FILE):
        (layout.agent_dir / name).unlink()
    plan = plan_install(layout, harness.verified)
    assert not plan.empty
    inode = layout.state.stat().st_ino
    with pytest.raises(ConsentError):
        harness.run()
    assert layout.state.stat().st_ino == inode
    captured: list[Path] = []
    original_record = Journal.record

    def record(journal: Journal, target: Path, name: str) -> Path | None:
        """Observe the actual switch write set before each original is moved.

        Parameters:
            journal (Journal): transaction under observation.
            target (Path): switch destination.
            name (str): backup basename.

        Returns:
            Path | None: recorded backup or original absence.

        Raises:
            OSError: journal recording failed.
        """
        if target.exists(follow_symlinks=False):
            captured.append(target)
        return original_record(journal, target, name)

    monkeypatch.setattr(Journal, "record", record)
    assert harness.run(yes=True) == ExitCode.OK
    assert captured
    for target in captured:
        assert any(f"'{target}'" in line for line in plan.overwrites), target


class MutationAudit:
    """Observe real mutations, independently of which writes the installer journals."""

    def __init__(self, harness: Harness, patch: pytest.MonkeyPatch, plan: install.Plan) -> None:
        """Install observers before a full install, after the test's existing-state setup.

        Parameters:
            harness (Harness): isolated installer home.
            patch (pytest.MonkeyPatch): observer lifetime.
            plan (install.Plan): pre-consent classification.

        Returns:
            None: mutation observers and independent write sets are initialized.

        Raises:
            OSError: fixture inventory failed.
        """
        self.layout, self.plan = harness.layout, plan
        self.prefix = self.layout.core(harness.snapshot.stack.core.tag)
        self.existing = {
            path
            for root in (self.layout.root, self.layout.agent_dir, self.layout.bin_dir)
            for path in (root, *root.rglob("*"))
            if path.exists(follow_symlinks=False)
        }
        self.created: set[Path] = set()
        self.events: list[Path] = []
        self.journaled: set[Path] = set()
        self.backups: set[Path] = set()
        self.backup_runs: set[Path] = set()
        self.descriptors: dict[int, Path] = {}
        original_open, original_close, original_record = os.open, os.close, Journal.record

        def opened(path: Any, flags: int, *args: Any, **kwargs: Any) -> int:
            """Resolve relative descriptor destinations against the actual opened parent.

            Parameters:
                path (Any): open operand.
                flags (int): open flags.
                *args (Any): permission arguments.
                **kwargs (Any): descriptor-relative options.

            Returns:
                int: tracked open descriptor.

            Raises:
                OSError: open failed.
            """
            resolved = self.path(path, kwargs.get("dir_fd"))
            existed = resolved is not None and resolved.exists(follow_symlinks=False)
            descriptor = original_open(path, flags, *args, **kwargs)
            if resolved is not None:
                self.descriptors[descriptor] = resolved
                if flags & os.O_CREAT and not existed:
                    self.observe([(resolved, False)])
                elif flags & os.O_ACCMODE in {os.O_WRONLY, os.O_RDWR}:
                    self.observe([(resolved, existed)])
            return descriptor

        def closed(descriptor: int) -> None:
            """Do not attribute a recycled descriptor to a previous directory.

            Parameters:
                descriptor (int): descriptor to close.

            Returns:
                None: tracking and descriptor are released.

            Raises:
                OSError: close failed.
            """
            self.descriptors.pop(descriptor, None)
            original_close(descriptor)

        def recorded(journal: Journal, target: Path, name: str) -> Path | None:
            """Collect claimed journal coverage separately from observed mutation destinations.

            Parameters:
                journal (Journal): transaction under observation.
                target (Path): switch destination.
                name (str): backup basename.

            Returns:
                Path | None: recorded backup or original absence.

            Raises:
                OSError: journal recording failed.
            """
            backup = original_record(journal, target, name)
            self.journaled.add(target)
            self.backup_runs.add(journal.backups)
            if backup is not None:
                self.backups.add(backup)
            return backup

        patch.setattr(os, "open", opened)
        patch.setattr(os, "close", closed)
        patch.setattr(Journal, "record", recorded)
        self.watch(patch, os, "replace", (0, 1))
        self.watch(patch, os, "rename", (0, 1))
        self.watch(patch, os, "symlink", (1,))
        self.watch(patch, os, "mkdir", (0,))
        self.watch(patch, os, "unlink", (0,))
        self.watch(patch, os, "rmdir", (0,))
        for name in ("write_text", "write_bytes", "mkdir", "unlink", "rmdir"):
            self.watch(patch, Path, name, (0,))
        self.watch(patch, install, "write_atomic", (0,))
        self.watch_open(patch, builtins, "open")
        self.watch_open(patch, io, "open")
        self.watch(patch, os, "link", (1,))
        for name in ("truncate", "ftruncate", "chmod", "fchmod", "utime"):
            self.watch(patch, os, name, (0,))
        self.watch(patch, shutil, "rmtree", (0,))
        for name in ("move", "copy", "copy2", "copyfile", "copytree"):
            self.watch(patch, shutil, name, (1,))

    @property
    def parent_paths(self) -> set[Path]:
        """Include exact permanent ancestors without observing arbitrary sibling files.

        Returns:
            set[Path]: ancestors of the installer, agent and link roots.
        """
        return {
            parent
            for root in (self.layout.root, self.layout.agent_dir, self.layout.bin_dir)
            for parent in root.parents
        }

    def path(self, value: Any, descriptor: int | None = None) -> Path | None:
        """Resolve a mutation operand without following its final symlink.

        Parameters:
            value (Any): path-like operand or a tracked file descriptor.
            descriptor (int | None): optional anchored parent.

        Returns:
            Path | None: absolute lexical path, or an unresolvable descriptor operand.
        """
        if isinstance(value, int):
            return self.descriptors.get(value)
        path = Path(value)
        if not path.is_absolute() and descriptor is not None:
            parent = self.descriptors.get(descriptor)
            return None if parent is None else parent / path
        return path.absolute()

    def observe(self, before: list[tuple[Path, bool]]) -> None:
        """Record existing-path mutations and distinguish entries created during this run.

        Parameters:
            before (list[tuple[Path, bool]]): operands and their pre-call existence.

        Returns:
            None: in-scope mutation events are recorded.
        """
        roots = (self.layout.root, self.layout.agent_dir, self.layout.bin_dir)
        for path, existed in before:
            if path not in self.parent_paths and not any(
                path == root or path.is_relative_to(root) for root in roots
            ):
                continue
            if existed and path not in self.created:
                self.events.append(path)
            elif not existed and path.exists(follow_symlinks=False):
                self.created.add(path)

    def watch_open(self, patch: pytest.MonkeyPatch, owner: Any, name: str) -> None:
        """Observe writable builtin/io opens, which bypass Python's os.open wrapper.

        Parameters:
            patch (pytest.MonkeyPatch): observer lifetime.
            owner (Any): builtins or io module.
            name (str): open primitive.

        Returns:
            None: the open observer is installed.
        """
        original = getattr(owner, name)

        def opened(file: Any, mode: str = "r", *args: Any, **kwargs: Any) -> Any:
            """Record writable-open destinations and track their file descriptors.

            Parameters:
                file (Any): open operand.
                mode (str): requested access mode.
                *args (Any): open arguments.
                **kwargs (Any): open options.

            Returns:
                Any: real tracked file handle.

            Raises:
                OSError: open failed.
            """
            path = self.path(file)
            existed = path is not None and path.exists(follow_symlinks=False)
            handle = original(file, mode, *args, **kwargs)
            if path is not None:
                self.descriptors[handle.fileno()] = path
                if any(flag in mode for flag in "wax+"):
                    self.observe([(path, existed)])
            return handle

        patch.setattr(owner, name, opened)

    def watch(self, patch: pytest.MonkeyPatch, owner: Any, name: str, positions: tuple[int, ...]) -> None:
        """Observe successful mutation operands, not declared write intent.

        Parameters:
            patch (pytest.MonkeyPatch): observer lifetime.
            owner (Any): module or class.
            name (str): mutation primitive.
            positions (tuple[int, ...]): mutated argument positions (rename source AND destination).

        Returns:
            None: the mutation observer is installed.
        """
        original = getattr(owner, name)
        try:
            parameters = tuple(inspect.signature(original).parameters)
        except (ValueError, TypeError):
            # CPython's chmod/utime expose unrepresentable native defaults; both take `path` first.
            parameters = ("path",)

        def mutation(*args: Any, **kwargs: Any) -> Any:
            """Capture real pre-mutation existence, including descriptor-relative rename paths.

            Parameters:
                *args (Any): real mutation operands.
                **kwargs (Any): real mutation options, including directory descriptors.

            Returns:
                Any: underlying mutation result, unchanged.

            Raises:
                OSError: underlying mutation failed, so no successful event is recorded.
            """
            before = []
            for position in positions:
                key = "src_dir_fd" if position == 0 and name in {"replace", "rename"} else "dst_dir_fd"
                descriptor = kwargs.get(key) if name in {"replace", "rename"} else kwargs.get("dir_fd")
                operand = args[position] if len(args) > position else kwargs[parameters[position]]
                path = self.path(operand, descriptor)
                if path is not None:
                    existed = path.exists(follow_symlinks=False)
                    if name != "mkdir" or not existed:
                        before.append((path, existed))
            result = original(*args, **kwargs)
            self.observe(before)
            return result

        patch.setattr(owner, name, mutation)

    def assert_classified(self) -> None:
        """Require independent CREATE and OVERWRITE classifications, including transient entries.

        Returns:
            None: every observed mutation is independently authorized.

        Raises:
            AssertionError: an unjournaled or unplanned mutation was observed.
        """
        infrastructure = {self.layout.journal, self.layout.root / "lock"}
        for path in self.events:
            # Staging is disposable installer scratch, never live user state. Do not exempt root/core/state.
            if (
                path in infrastructure
                or path.is_relative_to(self.layout.root / "staging")
                or path in self.backups
            ):
                continue
            assert path in self.journaled, f"Unjournaled existing mutation: '{path}'"
            assert any(f"'{path}'" in message for message in self.plan.overwrites), path
        # The package CREATE names the agent directory, but authorizes only npm/git trees,
        # never arbitrary new personal files beside them.
        declared = {
            path
            for path in (
                self.layout.link,
                self.layout.state,
                self.layout.agent_dir / install.SETTINGS_FILE,
                self.layout.agent_dir / install.SUBAGENTS_FILE,
                self.prefix,
            )
            if any(f"'{path}'" in message for message in self.plan.creates)
        }
        if self.plan.install_packages:
            assert any(f"'{self.layout.agent_dir}'" in message for message in self.plan.creates)
            declared |= {self.layout.agent_dir / tree for tree in install.PACKAGE_TREES}
        directories = (
            self.layout.root / "core",
            self.layout.backups,
            self.layout.agent_dir,
            self.layout.bin_dir,
        )
        parents = {
            parent
            for directory in directories
            for parent in (*directory.parents, directory)
            if f"create directory '{parent}'" in self.plan.creates
        }
        # Rename-based OVERWRITEs recreate their original destination; that is not a new CREATE.
        recreated = {
            path for path in self.existing if any(f"'{path}'" in message for message in self.plan.overwrites)
        }
        planned = declared | recreated
        for path in self.created:
            # Named scratch exemptions, deliberately not blanket root/agent/bin allowances:
            # staging: disposable npm/core build workspace, never a live destination.
            if path.is_relative_to(self.layout.root / "staging"):
                continue
            # backup run: one switch's originals, created through the anchored backup writer.
            if path in self.backups | self.backup_runs:
                continue
            # atomic journal/config temporary: only UUID siblings of known write destinations.
            atomic_targets = planned | infrastructure
            if any(
                path.parent == target.parent
                and (
                    (
                        path.name.startswith(f".{target.name}.")
                        and ATOMIC_SUFFIX.fullmatch(path.name.removeprefix(f".{target.name}.")) is not None
                    )
                    or (
                        path.name.startswith(f"..{target.name}.")
                        and len(parts := path.name.removeprefix(f"..{target.name}.").split(".replacement."))
                        == 2
                        and ATOMIC_SUFFIX.fullmatch(parts[0] + ".replacement") is not None
                        and ATOMIC_SUFFIX.fullmatch(parts[1]) is not None
                    )
                )
                for target in atomic_targets
            ):
                continue
            # Permanent parent mkdirs require exact planner declarations; lock/journal are scratch.
            if path in parents | infrastructure:
                continue
            assert any(path == target or path.is_relative_to(target) for target in declared | recreated), (
                f"Unplanned CREATE: '{path}'"
            )


@pytest.mark.parametrize("existing", [False, True])
def test_switch_write_set_classification_includes_core_and_shims(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, existing: bool
) -> None:
    """Enumerate writes from the real switch, not a hand-maintained list of planner targets."""
    harness = Harness(tmp_path, monkeypatch)
    if existing:
        assert harness.run() == ExitCode.OK
        prefix = harness.layout.core(harness.snapshot.stack.core.tag)
        (prefix / install.CORE_MARKER).unlink()
        harness.layout.link.unlink()
        harness.layout.link.write_text("old shim")
        (harness.layout.agent_dir / "git").mkdir()
        for name in (install.SETTINGS_FILE, install.SUBAGENTS_FILE):
            (harness.layout.agent_dir / name).write_text("{}")
        harness.layout.state.write_text("{}")
        auth = harness.layout.agent_dir / "auth.json"
        auth.unlink(missing_ok=True)
        auth.write_text("personal state outside the installer write set")
    plan = plan_install(harness.layout, harness.verified)
    with monkeypatch.context() as patch:
        audit = MutationAudit(harness, patch, plan)
        assert harness.run(yes=True) == ExitCode.OK
    assert audit.events
    audit.assert_classified()


def recovery_transitions() -> list[tuple[str, str, str, str]]:
    """Expand the single documented transition table into the complete state cross-product.

    Returns:
        list[tuple[str, str, str, str]]: state, backup presence, live state and expected transition.
    """
    text = (INTEGRATION.parent / "docs/install.md").read_text()
    table = text.split("<!-- recovery-transition-table -->")[1].split("<!-- /recovery-transition-table -->")[
        0
    ]
    rows = [
        [cell.strip() for cell in line.strip("|").split("|")]
        for line in table.splitlines()
        if line.startswith("|")
    ]
    header, _, *body = rows
    return [
        (row[0], row[1], live, outcome)
        for row in body
        for live, outcome in zip(header[2:], row[2:], strict=True)
    ]


def test_recovery_transition_table_is_complete() -> None:
    """The documented oracle must include the exact requested 6 x 2 x 6 cross-product once."""
    transitions = recovery_transitions()
    states = {"pending", "saved", "legacy", "restoring", "restored", "new-target-completed"}
    presences = {"present", "missing"}
    lives = {"original", "new", "other", "absent", "directory", "symlink"}
    assert len(transitions) == 72
    assert {(state, presence, live) for state, presence, live, _ in transitions} == {
        (state, presence, live) for state in states for presence in presences for live in lives
    }
    assert {outcome for _, _, _, outcome in transitions} == {"restore", "skip", "refuse"}


def matrix_content_identity(path: Path, contents: bytes = b"ORIGINAL") -> dict[str, Any]:
    """Build the known regular-file fixture's content identity independently of production hashing.

    Parameters:
        path (Path): known fixture entry.
        contents (bytes): expected file contents.

    Returns:
        dict[str, Any]: expected wire identity, including rename-stable corroboration.
    """
    info = path.lstat()
    return {
        "kind": "file",
        "device": info.st_dev,
        "inode": info.st_ino,
        "mtime_ns": info.st_mtime_ns,
        "size": info.st_size,
        "sha256": hashlib.sha256(contents).hexdigest(),
    }


def seed_recovery_matrix(harness: Harness, state: str, presence: str, live: str) -> Path:
    """Seed a single documented transition without consulting its expected outcome.

    Parameters:
        harness (Harness): isolated installer.
        state (str): journal progress state.
        presence (str): backup presence.
        live (str): live entry state.

    Returns:
        Path: the backup entry, whether present or absent.
    """
    tmp_path = harness.home.parent
    layout = harness.layout
    target = layout.state
    recovery_entry(target, "file", "ORIGINAL")
    backups = layout.backups / "matrix"
    backups.mkdir(parents=True)
    backup = backups / target.name
    if presence == "present":
        if live == "original":
            os.link(target, backup)
        else:
            shutil.copy2(target, backup)
    info = target.stat()
    content = matrix_content_identity(target)
    raw: dict[str, Any] = {"target": str(target), "backup": str(backup)}
    if state in {"pending", "saved", "restored"}:
        raw |= {"pending": state == "pending", "original": [info.st_dev, info.st_ino, info.st_ctime_ns]}
    if state == "restoring":
        raw["restoring"] = matrix_content_identity(backup) if presence == "present" else content
    if state == "restored":
        raw |= {"restored": True, "restoring": content}
    if state == "new-target-completed":
        raw |= {"backup": None, "restored": True}
    if state in {"pending", "saved", "restoring"}:
        replacement = tmp_path / "replacement"
        replacement.write_bytes(b"NEW FILE")
        raw["replacement"] = matrix_content_identity(replacement, b"NEW FILE")
        if live == "new":
            replacement.replace(target)
    if live == "other" or (live == "new" and "replacement" not in raw):
        target.write_text("FORGERY!" if live == "other" else "NEW FILE")
        os.utime(target, ns=(info.st_atime_ns, info.st_mtime_ns))
    elif live == "absent":
        target.unlink()
    elif live in {"directory", "symlink"}:
        recovery_entry(target, live, "keep me")
    install.write_atomic(
        layout.journal, json.dumps({"backups": str(backups), "steps": [raw]}), mode=install.JOURNAL_MODE
    )
    return backup


@pytest.mark.parametrize(("state", "presence", "live", "outcome"), recovery_transitions())
def test_recovery_state_cross_product(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, *, state: str, presence: str, live: str, outcome: str
) -> None:
    """Every documented state/backup/live transition recovers idempotently or refuses without mutation."""
    harness = Harness(tmp_path, monkeypatch)
    backup = seed_recovery_matrix(harness, state, presence, live)
    layout, target = harness.layout, harness.layout.state
    before = tree(harness.home)
    if outcome == "refuse":
        with pytest.raises(RollbackError):
            rollback(layout)
        assert tree(harness.home) == before
    else:
        rollback(layout)
        assert rollback(layout) == []
        assert not layout.journal.exists()
        if state == "new-target-completed":
            assert not target.exists(follow_symlinks=False)
        else:
            assert target.read_bytes() == b"ORIGINAL"
        assert backup.exists() == (presence == "present" and outcome == "skip")


@pytest.mark.parametrize(
    "bad_hash", [None, "", "f" * 63, "g" * 64, 3, [], True, pytest.param(..., id="missing")]
)
def test_malformed_restoring_hash_is_refused_without_changes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, bad_hash: object
) -> None:
    """Missing, short and wrong-type hashes cannot authorize any restore operation."""
    harness = Harness(tmp_path, monkeypatch)
    journal, target = saved_recovery_entry(harness, "file")
    identity = matrix_content_identity(journal.backups / target.name)
    if bad_hash is ...:
        del identity["sha256"]
    else:
        identity["sha256"] = bad_hash

    def corrupt(document: dict[str, Any]) -> None:
        """Replace the intent with this case's malformed hash fixture.

        Parameters:
            document (dict[str, Any]): journal fixture.

        Returns:
            None: document is mutated in place.
        """
        document["steps"][0] |= {"restoring": identity}

    edit_journal(harness, corrupt)
    before = tree(harness.home)
    with pytest.raises(RollbackError, match="not trusted"):
        rollback(harness.layout)
    assert tree(harness.home) == before


def test_legacy_mtime_only_restore_intent_requires_manual_recovery(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An older mtime/size-only intent cannot silently substitute for a missing content hash."""
    harness = Harness(tmp_path, monkeypatch)
    journal, target = saved_recovery_entry(harness, "file")
    info = (journal.backups / target.name).stat()

    def weaken(document: dict[str, Any]) -> None:
        """Model an older intent that has no content hash or inode corroboration.

        Parameters:
            document (dict[str, Any]): journal fixture.

        Returns:
            None: document is mutated in place.
        """
        document["steps"][0] |= {"restoring": [info.st_mtime_ns, info.st_size]}

    edit_journal(harness, weaken)
    before = tree(harness.home)
    with pytest.raises(RollbackError, match="not trusted"):
        rollback(harness.layout)
    assert tree(harness.home) == before


@pytest.mark.parametrize("kind", ["file", "directory", "symlink"])
def test_content_bound_restore_resumes_after_rename(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, kind: str
) -> None:
    """All allowed entry kinds retain matching content and inode identity through a restore rename."""
    harness = Harness(tmp_path, monkeypatch)
    _, target = saved_recovery_entry(harness, kind)
    original = os.replace

    def interrupt(src: Any, dst: Any, **kwargs: Any) -> None:
        """Interrupt after the backup is consumed, leaving only write-ahead intent.

        Parameters:
            src (Any): rename source.
            dst (Any): rename destination.
            **kwargs (Any): rename options.

        Returns:
            None: unrelated renames complete.

        Raises:
            KeyboardInterrupt: restore completed before progress was saved.
        """
        original(src, dst, **kwargs)
        if kwargs.get("src_dir_fd") is not None:
            raise KeyboardInterrupt

    with monkeypatch.context() as patch:
        patch.setattr(os, "replace", interrupt)
        with pytest.raises(KeyboardInterrupt):
            rollback(harness.layout)
    rollback(harness.layout)
    assert rollback(harness.layout) == []
    if kind == "directory":
        assert tree(target) == {"child": b"ORIGINAL"}
    elif kind == "symlink":
        assert target.readlink() == Path("ORIGINAL")
    else:
        assert target.read_bytes() == b"ORIGINAL"


def test_restore_hashing_streams_and_bounds_content(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """File hashing uses bounded descriptor reads; trees refuse byte, entry and depth exhaustion."""
    data = b"x" * (2 * install.RESTORE_READ_SIZE + 7)
    path = tmp_path / "file"
    path.write_bytes(data)
    reads: list[int] = []
    original_read = os.read

    def read(descriptor: int, count: int) -> bytes:
        """Record requested chunk sizes on the actual fd read path.

        Parameters:
            descriptor (int): open file descriptor.
            count (int): requested read size.

        Returns:
            bytes: real file contents for this read.

        Raises:
            OSError: the underlying read failed.
        """
        reads.append(count)
        return original_read(descriptor, count)

    monkeypatch.setattr(os, "read", read)
    assert install.RestoreHasher().identity(path).sha256 == hashlib.sha256(data).hexdigest()
    assert len(reads) >= 4
    assert max(reads) <= install.RESTORE_READ_SIZE
    with pytest.raises(OSError, match="byte limit"):
        install.RestoreHasher(remaining_bytes=1).identity(path)
    directory = tmp_path / "directory"
    directory.mkdir()
    (directory / "child").write_text("data")
    with pytest.raises(OSError, match="entry limit"):
        install.RestoreHasher(remaining_entries=1).identity(directory)
    monkeypatch.setattr(install, "MAX_RESTORE_DEPTH", 0)
    with pytest.raises(OSError, match="depth/entry limit"):
        install.RestoreHasher().identity(directory)


def test_restore_tree_digest_has_defined_framing_and_never_follows_links(tmp_path: Path) -> None:
    """The recursive digest is reproducible from its documented framing, not linked target bytes."""
    directory = tmp_path / "tree"
    directory.mkdir()
    (directory / "file").write_bytes(b"data")
    outside = tmp_path / "outside"
    outside.write_text("private target bytes")
    (directory / "link").symlink_to("../outside")
    fields = (
        (b"file", b"file", hashlib.sha256(b"data").hexdigest().encode()),
        (b"link", b"symlink", hashlib.sha256(b"../outside").hexdigest().encode()),
    )
    framed = b"".join(len(value).to_bytes(8, "big") + value for child in fields for value in child)
    expected = hashlib.sha256(framed).hexdigest()
    assert install.RestoreHasher(remaining_entries=3).identity(directory).sha256 == expected
    outside.write_text("different private bytes")
    assert install.RestoreHasher().identity(directory).sha256 == expected
    with pytest.raises(OSError, match="entry limit"):
        install.RestoreHasher(remaining_entries=2).identity(directory)


@pytest.mark.parametrize("kind", ["file", "directory", "symlink"])
def test_post_crash_edits_refuse_without_mutating_any_entry(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, kind: str
) -> None:
    """A post-crash edit is user state, not a concurrent swap or authorized installer replacement."""
    harness = Harness(tmp_path, monkeypatch)
    journal, target = saved_recovery_entry(harness, "file")
    recovery_entry(target, kind, "USER EDIT")
    before = tree(harness.home)
    with pytest.raises(RollbackError, match="mv -i") as raised:
        rollback(harness.layout)
    assert str(target) in str(raised.value)
    assert tree(harness.home) == before
    assert (journal.backups / target.name).read_bytes() == b"ORIGINAL"


def test_legacy_unknown_replacement_refuses_new_live_content(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An older journal cannot authorize deleting live content it never identified."""
    harness = Harness(tmp_path, monkeypatch)
    saved_recovery_entry(harness, "file")
    edit_journal(harness, lambda document: document["steps"][0].pop("replacement", None))
    before = tree(harness.home)
    with pytest.raises(RollbackError, match="recorded replacement"):
        rollback(harness.layout)
    assert tree(harness.home) == before


def test_legacy_unknown_new_target_is_never_deleted(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Original absence in an old journal does not authorize deleting an unidentified live file."""
    harness = Harness(tmp_path, monkeypatch)
    layout = harness.layout
    journal = Journal(layout, layout.backups / "legacy-new")
    with journal.open_backups():
        journal.record(layout.state, layout.state.name)
    layout.state.write_text("unidentified newer state")
    before = tree(harness.home)
    with pytest.raises(RollbackError, match="recorded replacement"):
        rollback(layout)
    assert tree(harness.home) == before


def test_all_live_steps_are_checked_before_any_restore(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A later-discovered post-crash edit must not permit earlier restores or journal writes."""
    harness = Harness(tmp_path, monkeypatch)
    pending_file_restore(harness)
    (harness.layout.agent_dir / install.SETTINGS_FILE).write_text("post-crash edit")
    before = tree(harness.home)
    with pytest.raises(RollbackError, match="mv -i"):
        rollback(harness.layout)
    assert tree(harness.home) == before


def test_replacement_identity_is_durable_before_switch_rename(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """There is no rename-to-journal-update gap in identifying the installer's replacement."""
    harness = Harness(tmp_path, monkeypatch)
    layout = harness.layout
    layout.root.mkdir(parents=True)
    layout.state.write_bytes(b"ORIGINAL")
    journal = Journal(layout, layout.backups / "replacement-intent")
    original_replace = os.replace
    observed = False

    def inspect(src: Any, dst: Any, **kwargs: Any) -> None:
        """Inspect the actual durable journal immediately before installed.json lands.

        Parameters:
            src (Any): rename source.
            dst (Any): rename destination.
            **kwargs (Any): rename options.

        Returns:
            None: the inspected rename completes.

        Raises:
            AssertionError: write-ahead identity is missing.
            KeyboardInterrupt: intent was inspected before the state-file rename.
            OSError: rename failed.
        """
        nonlocal observed
        if Path(dst) == layout.state and kwargs.get("src_dir_fd") is None:
            document = json.loads(layout.journal.read_text())
            replacement = document["steps"][-1].get("replacement")
            assert replacement is not None
            info = Path(src).stat()
            assert replacement["sha256"] == hashlib.sha256(b"NEW FILE").hexdigest()
            assert (replacement["device"], replacement["inode"]) == (info.st_dev, info.st_ino)
            observed = True
            raise KeyboardInterrupt
        original_replace(src, dst, **kwargs)

    with journal.open_backups(), monkeypatch.context() as patch:
        patch.setattr(os, "replace", inspect)
        with pytest.raises(KeyboardInterrupt):
            install.replace_file(journal, layout.state, layout.state.name, "NEW FILE")
    assert observed
    rollback(layout)
    assert layout.state.read_bytes() == b"ORIGINAL"


@pytest.mark.parametrize("failure", [errno.EXDEV, errno.EIO])
def test_failed_backup_rename_preserves_live_and_backup(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, failure: int
) -> None:
    """The live entry is renamed back if the second restore rename fails, never deleted first."""
    harness = Harness(tmp_path, monkeypatch)
    journal, target = saved_recovery_entry(harness, "file")
    before, inode = tree(harness.home), target.stat().st_ino
    original = os.replace

    def refuse(src: Any, dst: Any, **kwargs: Any) -> None:
        """Inject a real EXDEV/EIO result at the backup-to-live syscall only.

        Parameters:
            src (Any): rename source.
            dst (Any): rename destination.
            **kwargs (Any): rename options.

        Returns:
            None: unrelated renames complete.

        Raises:
            OSError: the selected restore syscall failed.
        """
        if kwargs.get("src_dir_fd") is not None:
            raise OSError(failure, os.strerror(failure))
        original(src, dst, **kwargs)

    with monkeypatch.context() as patch:
        patch.setattr(os, "replace", refuse)
        with pytest.raises(RollbackError):
            rollback(harness.layout)
    assert target.read_bytes() == b"NEW FILE"
    assert target.stat().st_ino == inode
    assert (journal.backups / target.name).read_bytes() == b"ORIGINAL"
    assert {
        key: value for key, value in tree(harness.home).items() if not key.endswith(install.JOURNAL_FILE)
    } == {key: value for key, value in before.items() if not key.endswith(install.JOURNAL_FILE)}
    rollback(harness.layout)
    assert target.read_bytes() == b"ORIGINAL"


@pytest.mark.parametrize("moment", ["aside-moved", "backup-restored", "aside-deleted"])
def test_interrupted_restore_aside_reconciles_without_losing_entries(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, moment: str
) -> None:
    """Every new aside window is journaled, including a rename that succeeded before interruption."""
    harness = Harness(tmp_path, monkeypatch)
    _, target = saved_recovery_entry(harness, "file")
    original_replace, original_unlink = os.replace, Path.unlink

    def rename(src: Any, dst: Any, **kwargs: Any) -> None:
        """Interrupt after one of the two restore renames, not journal rewrites.

        Parameters:
            src (Any): rename source.
            dst (Any): rename destination.
            **kwargs (Any): rename options.

        Returns:
            None: unrelated renames complete.

        Raises:
            KeyboardInterrupt: the selected rename completed.
        """
        original_replace(src, dst, **kwargs)
        if (moment == "aside-moved" and Path(src) == target) or (
            moment == "backup-restored" and kwargs.get("src_dir_fd") is not None
        ):
            raise KeyboardInterrupt

    def unlink(path: Path, *args: Any, **kwargs: Any) -> None:
        """Interrupt after cleanup consumed the aside but before progress was recorded.

        Parameters:
            path (Path): entry to unlink.
            *args (Any): unlink arguments.
            **kwargs (Any): unlink options.

        Returns:
            None: unrelated unlinks complete.

        Raises:
            KeyboardInterrupt: the aside was consumed.
        """
        original_unlink(path, *args, **kwargs)
        if moment == "aside-deleted" and ".pi-stack-restore-" in path.name:
            raise KeyboardInterrupt

    with monkeypatch.context() as patch:
        patch.setattr(os, "replace", rename)
        patch.setattr(Path, "unlink", unlink)
        with pytest.raises(KeyboardInterrupt):
            rollback(harness.layout)
    rollback(harness.layout)
    assert target.read_bytes() == b"ORIGINAL"
    assert rollback(harness.layout) == []
    assert list(target.parent.glob("*.pi-stack-restore-*")) == []


def test_cross_device_restore_is_refused_before_mutation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A static layout-device mismatch is refused before even rewriting the journal."""
    harness = Harness(tmp_path, monkeypatch)
    journal, target = saved_recovery_entry(harness, "file")
    backup = journal.backups / target.name
    original_stat, original_identity = os.stat, install.RestoreHasher.identity
    identity = install.RestoreHasher().identity(backup)

    def stat_backup(path: Any, *args: Any, **kwargs: Any) -> os.stat_result:
        """Model a backup on another mounted device without requiring mount privileges.

        Parameters:
            path (Any): stat operand.
            *args (Any): stat arguments.
            **kwargs (Any): stat options.

        Returns:
            os.stat_result: real metadata with the selected device replaced.

        Raises:
            OSError: stat failed.
        """
        info = original_stat(path, *args, **kwargs)
        if kwargs.get("dir_fd") is not None and str(path) == backup.name:
            values = list(info)
            values[2] += 1
            return os.stat_result(values)
        return info

    def hash_backup(hasher: Any, path: Any, **kwargs: Any) -> Any:
        """Keep content hashing independent of the simulated layout-device probe.

        Parameters:
            hasher (Any): content hasher.
            path (Any): hash operand.
            **kwargs (Any): descriptor-relative hash options.

        Returns:
            Any: real content identity.

        Raises:
            OSError: hashing failed.
        """
        if kwargs.get("dir_fd") is not None and str(path) == backup.name:
            return identity
        return original_identity(hasher, path, **kwargs)

    before = tree(harness.home)
    with monkeypatch.context() as patch:
        patch.setattr(os, "stat", stat_backup)
        patch.setattr(install.RestoreHasher, "identity", hash_backup)
        with pytest.raises(RollbackError, match="different filesystems"):
            rollback(harness.layout)
    assert tree(harness.home) == before


@pytest.mark.parametrize(
    "mutation",
    [
        "atomic",
        "text",
        "bytes",
        "replace",
        "rename",
        "copy",
        "move",
        "symlink",
        "unlink",
        "open",
        "io-open",
        "truncate",
        "chmod",
    ],
)
def test_mutation_audit_detects_deliberately_unjournaled_overwrite(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, mutation: str
) -> None:
    """The consent test itself must catch accidental writes that bypass Journal.record entirely."""
    original = install.switch_anchored

    def unclassified(layout: Layout, *args: Any, **kwargs: Any) -> None:
        """Deliberately violate the write contract after the real switch has finished.

        Parameters:
            layout (Layout): live paths.
            *args (Any): switch arguments.
            **kwargs (Any): switch options.

        Returns:
            None: the switch and unplanned write complete.

        Raises:
            OSError: a fixture mutation failed.
        """
        original(layout, *args, **kwargs)
        target = layout.agent_dir / "auth.json"
        source = tmp_path / "rogue-source"
        source.write_text("unclassified")
        if mutation == "atomic":
            install.write_atomic(path=target, text="unclassified")
        elif mutation == "text":
            target.write_text("unclassified")
        elif mutation == "bytes":
            target.write_bytes(b"unclassified")
        elif mutation == "replace":
            source.replace(target)
        elif mutation == "rename":
            source.rename(target)
        elif mutation == "copy":
            shutil.copy2(src=source, dst=target)
        elif mutation == "move":
            shutil.move(source, target)
        elif mutation == "symlink":
            target.unlink(missing_ok=True)
            target.symlink_to(source)
        elif mutation in {"open", "io-open"}:
            writer = builtins.open if mutation == "open" else io.open
            with writer(target, "w") as handle:
                handle.write("unclassified")
        elif mutation in {"truncate", "chmod"}:
            if not target.exists():
                target.write_text("initial fixture")
            if mutation == "truncate":
                os.truncate(target, 1)
            else:
                target.chmod((target.stat().st_mode & 0o777) ^ 0o100)
        else:
            target.unlink(missing_ok=True)

    monkeypatch.setattr(install, "switch_anchored", unclassified)
    with pytest.raises(AssertionError, match=r"Unjournaled existing mutation: '.*auth\.json'"):
        test_switch_write_set_classification_includes_core_and_shims(tmp_path, monkeypatch, existing=True)


def test_backup_validation_permission_error_is_normalized(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Any validation I/O error becomes RollbackError before the restore mutates an entry."""
    harness = Harness(tmp_path, monkeypatch)
    journal, _ = saved_recovery_entry(harness, "file")
    original = install.entry_kind

    def denied(path: Path) -> str | None:
        """Model an unsearchable backup parent at the validation boundary.

        Parameters:
            path (Path): entry to classify.

        Returns:
            str | None: real entry kind for unrelated paths.

        Raises:
            PermissionError: backup lookup was denied.
        """
        if path == journal.backups:
            raise PermissionError(errno.EACCES, "backup parent unsearchable")
        return original(path)

    before = tree(harness.home)
    monkeypatch.setattr(install, "entry_kind", denied)
    with pytest.raises(RollbackError, match="not trusted"):
        rollback(harness.layout)
    assert tree(harness.home) == before


def test_actual_unsearchable_backup_parent_is_normalized(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Exercise actual filesystem permissions, not merely an injected validation exception."""
    if os.getuid() == 0:
        pytest.skip("root bypasses chmod 000 directory search permissions")
    harness = Harness(tmp_path, monkeypatch)
    journal, _ = saved_recovery_entry(harness, "file")
    before = tree(harness.home)
    mode = journal.backups.stat().st_mode & 0o777
    journal.backups.chmod(0)
    try:
        with pytest.raises(RollbackError, match="not trusted"):
            rollback(harness.layout)
    finally:
        journal.backups.chmod(mode)
    assert tree(harness.home) == before


@pytest.mark.parametrize("value", ["relative", "~/share", "../outside", "./data", ""])
def test_relative_xdg_data_home_uses_prescribed_fallback(tmp_path: Path, value: str) -> None:
    """XDG relative values are invalid and ignored, never resolved against the working directory."""
    home = tmp_path / "home"
    layout = Layout.from_env({"XDG_DATA_HOME": value, "XDG_CONFIG_HOME": "relative-also"}, home, None)
    assert layout.root == home.resolve() / ".local/share/pi-stack"


@pytest.mark.parametrize("name", ["test_install.py", "test_promotion.py"])
def test_installer_fixtures_do_not_use_update_expressions(name: str) -> None:
    """Keep dictionary edits out of lambda/expression update calls across both PR fixture files."""
    module = ast.parse(Path(__file__).with_name(name).read_text())
    parents = {child: parent for parent in ast.walk(module) for child in ast.iter_child_nodes(parent)}
    invalid = [
        node.lineno
        for node in ast.walk(module)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "update"
        and not isinstance(parents[node], ast.Expr)
    ]
    assert invalid == []


def test_journal_memory_failure_is_untrusted(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A bounded parse can still exhaust memory; normalize it instead of leaking an interpreter error."""
    harness = Harness(tmp_path, monkeypatch)
    pending_file_restore(harness)

    def exhausted(*args: Any, **kwargs: Any) -> object:
        """Model allocation failure inside the bounded JSON parser.

        Parameters:
            *args (Any): ignored JSON input.
            **kwargs (Any): ignored decoding options.

        Returns:
            object: never returned.

        Raises:
            MemoryError: the bounded parser exhausted memory.
        """
        raise MemoryError("bounded parse allocation failed")

    monkeypatch.setattr(install.json, "loads", exhausted)
    with pytest.raises(RollbackError, match=r"not trusted.*bounded parse allocation failed"):
        rollback(harness.layout)


@pytest.mark.parametrize("failure", [OSError, KeyboardInterrupt])
@pytest.mark.parametrize("mutation", [None, "new-child", "edited-child", "symlink-child"])
def test_partial_directory_aside_cleanup_retries(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, failure: type[BaseException], mutation: str | None
) -> None:
    """Partial rmtree permits only verified remnants, never post-interruption additions or edits.

    Parameters:
        tmp_path (Path): isolated fixture parent.
        monkeypatch (pytest.MonkeyPatch): cleanup fault injection.
        failure (type[BaseException]): interruption class.
        mutation (str | None): post-interruption user mutation, or no edit.

    Returns:
        None: valid remnants complete; edited remnants refuse twice without mutation.
    """
    harness = Harness(tmp_path, monkeypatch)
    _, target = saved_recovery_entry(harness, "directory")
    (target / "second").write_text("replacement child")
    (target / "nested").mkdir()
    (target / "nested" / "removed").write_text("nested replacement child")
    (target / "untouched-link").symlink_to("outside-not-followed")

    def replacement(document: dict[str, Any]) -> None:
        """Record both children as the switch's known replacement before starting recovery.

        Parameters:
            document (dict[str, Any]): journal fixture to edit.

        Returns:
            None: both replacement children are recorded.
        """
        document["steps"][0]["replacement"] = asdict(install.RestoreHasher().identity(target))

    edit_journal(harness, replacement)
    original_tree = {"child": b"ORIGINAL"}
    original_rmtree = shutil.rmtree
    aside: Path | None = None

    def partial(path: Path, *, dir_fd: int | None = None) -> None:
        """Delete one of two children before the real cleanup syscall sequence finishes.

        Parameters:
            path (Path): directory to remove.
            dir_fd (int | None): optional anchored parent descriptor.

        Returns:
            None: unrelated directory removals complete.

        Raises:
            OSError | KeyboardInterrupt: the parametrized cleanup interruption.
        """
        nonlocal aside
        if ".pi-stack-restore-" in Path(path).name:
            aside = Path(path)
            (aside / "child").unlink()
            (aside / "nested" / "removed").unlink()
            raise failure("partial cleanup")
        original_rmtree(path, dir_fd=dir_fd)

    with monkeypatch.context() as patch:
        patch.setattr(shutil, "rmtree", partial)
        with pytest.raises(RollbackError if failure is OSError else KeyboardInterrupt):
            rollback(harness.layout)
    assert aside is not None
    assert aside.exists()
    assert tree(target) == original_tree
    assert harness.layout.journal.exists()
    if mutation is not None:
        if mutation == "new-child":
            (aside / "new").write_text("NEW USER DATA")
        elif mutation == "edited-child":
            (aside / "second").write_text("edited replacement child")
        else:
            (aside / "second").unlink()
            (aside / "second").symlink_to("NEW USER DATA")
        before = tree(harness.home)
        for _ in range(2):
            with pytest.raises(RollbackError, match=r"aside.*changed"):
                rollback(harness.layout)
            assert tree(harness.home) == before
        return
    rollback(harness.layout)
    assert tree(target) == original_tree
    assert not aside.exists()
    assert not harness.layout.journal.exists()
    assert rollback(harness.layout) == []


@pytest.mark.parametrize("kind", ["file", "directory", "symlink"])
@pytest.mark.parametrize("recreated", ["file", "directory", "symlink"])
def test_cleaning_aside_rejects_recreated_user_data(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, kind: str, recreated: str
) -> None:
    """A consumed aside name never authorizes deletion of newly created user content.

    Parameters:
        tmp_path (Path): isolated fixture parent.
        monkeypatch (pytest.MonkeyPatch): cleanup interruption injection.
        kind (str): original replacement entry kind.
        recreated (str): new user entry kind.

    Returns:
        None: assertions verify two refusal retries preserve all entries.
    """
    harness = Harness(tmp_path, monkeypatch)
    _, target = saved_recovery_entry(harness, kind)
    original_remove = install.remove
    consumed: list[Path] = []

    def interrupted(path: Path) -> None:
        """Interrupt after deletion, before completion is journaled.

        Parameters:
            path (Path): cleanup operand.

        Returns:
            None: non-aside removals complete normally.

        Raises:
            OSError: the aside was consumed.
        """
        original_remove(path)
        if ".pi-stack-restore-" in path.name:
            consumed.append(path)
            raise OSError("cleanup interrupted after removal")

    with monkeypatch.context() as patch:
        patch.setattr(install, "remove", interrupted)
        with pytest.raises(RollbackError, match="cleanup interrupted"):
            rollback(harness.layout)
    (aside,) = consumed
    recovery_entry(aside, recreated, "NEW USER DATA")
    before = tree(harness.home)
    for _ in range(2):
        with pytest.raises(RollbackError, match=r"aside.*changed"):
            rollback(harness.layout)
        assert tree(harness.home) == before
        assert aside.exists(follow_symlinks=False)
        assert harness.layout.journal.exists()
    assert target.exists(follow_symlinks=False)


def test_cleanup_manifest_must_fit_journal_before_deletion(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Refuse an oversized manifest before removing any aside content.

    Parameters:
        tmp_path (Path): isolated fixture parent.
        monkeypatch (pytest.MonkeyPatch): journal byte limit injection.

    Returns:
        None: the intact aside and previous journal remain recoverable.
    """
    harness = Harness(tmp_path, monkeypatch)
    _, target = saved_recovery_entry(harness, "directory")
    persist = Journal.persist

    def bounded(journal: Journal) -> None:
        """Make only the cleaning rewrite exceed the journal bound.

        Parameters:
            journal (Journal): pending recovery progress.

        Returns:
            None: non-cleaning rewrites persist normally.

        Raises:
            OSError: cleaning metadata exceeds the injected limit.
        """
        if any(step.get("aside", {}).get("cleaning") for step in journal.steps):
            with monkeypatch.context() as patch:
                patch.setattr(install, "MAX_JOURNAL_BYTES", 1)
                persist(journal)
        else:
            persist(journal)

    with monkeypatch.context() as patch:
        patch.setattr(Journal, "persist", bounded)
        with pytest.raises(RollbackError, match="journal exceeds"):
            rollback(harness.layout)
    aside = install.load_journal(harness.layout)[1][0].aside
    assert aside is not None
    assert tree(aside.path) == {"child": b"NEW FILE"}
    assert tree(target) == {"child": b"ORIGINAL"}
    rollback(harness.layout)
    assert not aside.path.exists()
    assert not harness.layout.journal.exists()


@pytest.mark.parametrize("bad_path", ["../escape", "/absolute", "a//b", "a/./b", "missing/child"])
def test_cleanup_manifest_rejects_noncanonical_or_orphan_entries(tmp_path: Path, bad_path: str) -> None:
    """Malformed manifest paths cannot authorize deletion.

    Parameters:
        tmp_path (Path): entry identity fixture.
        bad_path (str): invalid relative entry name.

    Returns:
        None: schema validation rejects the manifest.
    """
    tmp_path.joinpath("file").write_text("fixture")
    identity = asdict(install.RestoreHasher().identity(tmp_path / "file"))
    with pytest.raises(ValueError, match="manifest"):
        install.cleanup_manifest({"": identity, bad_path: identity})


@pytest.mark.parametrize("live", ["original", "new"])
def test_restoring_backup_corruption_preflights_entire_transaction(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, live: str
) -> None:
    """A corrupt middle backup refuses before the first reverse-order step or journal can change."""
    harness = Harness(tmp_path, monkeypatch)
    backup = seed_recovery_matrix(harness, "restoring", "present", live)
    # Replace, not write through the hard link used by the matching-live-original cell.
    backup.unlink()
    backup.write_bytes(b"CORRUPTED")
    layout = harness.layout
    document = json.loads(layout.journal.read_text())
    # The last recorded step would be restored first. Both neighboring steps are valid
    # new targets, so a per-step check would delete one before discovering the middle fault.
    neighbors = []
    for name in (install.SETTINGS_FILE, install.SUBAGENTS_FILE):
        target = layout.agent_dir / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("new target")
        neighbors.append(
            {
                "target": str(target),
                "backup": None,
                "replacement": matrix_content_identity(target, b"new target"),
            }
        )
    document["steps"] = [neighbors[0], *document["steps"], neighbors[1]]
    install.write_atomic(layout.journal, json.dumps(document), mode=install.JOURNAL_MODE)
    before = tree(harness.home)
    identities = {Path(raw["target"]): Path(raw["target"]).lstat() for raw in document["steps"]}
    with pytest.raises(RollbackError, match="content identity changed"):
        rollback(layout)
    assert tree(harness.home) == before
    assert {path: path.lstat() for path in identities} == identities


@pytest.mark.parametrize("mutation", ["mkdir", "symlink"])
def test_mutation_audit_detects_unplanned_create(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, mutation: str
) -> None:
    """An extra new directory or symlink must fail the independent CREATE oracle."""
    original = install.switch_anchored

    def unplanned(layout: Layout, *args: Any, **kwargs: Any) -> None:
        """Inject a write outside every declared CREATE, without touching an existing entry.

        Parameters:
            layout (Layout): live destination paths.
            *args (Any): remaining switch arguments.
            **kwargs (Any): switch options.

        Returns:
            None: the switch and unplanned creation complete.

        Raises:
            OSError: fixture mutation failed.
        """
        original(layout, *args, **kwargs)
        target = layout.agent_dir / "unplanned"
        if mutation == "mkdir":
            target.mkdir()
        else:
            target.symlink_to("missing-target")

    monkeypatch.setattr(install, "switch_anchored", unplanned)
    with pytest.raises(AssertionError, match=r"Unplanned CREATE:.*unplanned"):
        test_switch_write_set_classification_includes_core_and_shims(tmp_path, monkeypatch, existing=False)


def explicit_raise_names(node: ast.FunctionDef | ast.AsyncFunctionDef) -> set[str]:
    """Collect statically named exceptions raised by this helper, excluding nested definitions.

    Parameters:
        node (ast.FunctionDef | ast.AsyncFunctionDef): helper syntax tree.

    Returns:
        set[str]: explicit exception class names; dynamic instances and propagated errors are unknown.
    """
    names: set[str] = set()
    pending: list[ast.AST] = list(node.body)
    while pending:
        child = pending.pop()
        if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
            continue
        if isinstance(child, ast.Raise) and child.exc is not None:
            exception = child.exc.func if isinstance(child.exc, ast.Call) else child.exc
            if isinstance(exception, (ast.Name, ast.Attribute)):
                name = ast.unparse(exception)
                if name.rsplit(".", 1)[-1][:1].isupper():
                    names.add(name)
        pending.extend(ast.iter_child_nodes(child))
    return names


@pytest.mark.parametrize(
    ("body", "expected"),
    [
        ("raise RuntimeError('interrupt')", {"RuntimeError"}),
        ("raise KeyboardInterrupt", {"KeyboardInterrupt"}),
        ("raise OSError('refused') from error", {"OSError"}),
        ("raise error", set()),
        ("raise failure('dynamic')", set()),
        ("def nested():\n    raise ValueError('nested')\nreturn None", set()),
    ],
)
def test_exception_contract_oracle_separates_explicit_and_unknown_raises(
    body: str,
    expected: set[str],
) -> None:
    """Check literal raises without inventing contracts for dynamic, propagated or nested errors.

    Parameters:
        body (str): helper body fixture.
        expected (set[str]): statically knowable exception names.

    Returns:
        None: the bounded syntax oracle identifies only this helper's explicit classes.
    """
    module = ast.parse("def helper():\n" + "\n".join("    " + line for line in body.splitlines()))
    (helper,) = module.body
    assert isinstance(helper, ast.FunctionDef)
    assert explicit_raise_names(helper) == expected


def test_interrupt_file_contract_names_the_actual_runtime_error() -> None:
    """Keep the interrupted-core fixture's literal exception and failure contract aligned.

    Returns:
        None: the callback documents RuntimeError, not KeyboardInterrupt.
    """
    module = ast.parse(Path(__file__).read_text())
    callbacks = [
        node
        for node in ast.walk(module)
        if isinstance(node, ast.FunctionDef) and node.name == "interrupt_file"
    ]
    (callback,) = callbacks
    assert explicit_raise_names(callback) == {"RuntimeError"}
    doc = ast.get_docstring(callback)
    assert doc is not None
    raises = doc.split("Raises:", 1)[1]
    assert "RuntimeError:" in raises
    assert "KeyboardInterrupt" not in raises


@pytest.mark.parametrize(
    "module", ["test_install.py", "test_release.py", "test_installer_process.py", "test_promotion.py"]
)
def test_test_helpers_have_typed_contracts(module: str) -> None:
    """Keep helper and nested callback contracts consistent across all installer test modules.

    Parameters:
        module (str): test module to inspect independently of production code.

    Returns:
        None: every helper documents typed inputs and its result or failure contract.
    """
    source = ast.parse((Path(__file__).parent / module).read_text())
    for node in ast.walk(source):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) or node.name.startswith("test_"):
            continue
        doc = ast.get_docstring(node)
        label = f"{module}:{node.lineno} {node.name}"
        assert doc, label
        arguments = [*node.args.posonlyargs, *node.args.args, *node.args.kwonlyargs]
        arguments += [arg for arg in (node.args.vararg, node.args.kwarg) if arg is not None]
        for arg in arguments:
            if arg.arg in {"self", "cls"}:
                continue
            assert arg.annotation is not None, label
            assert "Parameters:" in doc, label
            assert f"{arg.arg} ({ast.unparse(arg.annotation)}):" in doc, label
        assert node.returns is not None, label
        assert any(section in doc for section in ("Returns:", "Yields:", "Raises:")), label
        for exception in explicit_raise_names(node):
            assert "Raises:" in doc, label
            assert exception in doc.split("Raises:", 1)[1], (label, exception)
        if ast.unparse(node.returns) != "None" and any(
            isinstance(child, ast.Return) and child.value is not None for child in ast.walk(node)
        ):
            assert "Returns:" in doc, label


def test_plan_reports_state_and_permanent_parent_creates(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """The public plan must authorize every permanent write, not an oracle-only exception.

    Parameters:
        tmp_path (Path): isolated fixture parent.
        monkeypatch (pytest.MonkeyPatch): offline installer seams.
        caplog (pytest.LogCaptureFixture): public plan output.

    Returns:
        None: plan-only output declares state and exact permanent directories without writes.
    """
    harness = Harness(tmp_path, monkeypatch)
    caplog.set_level("INFO")
    before = tree(harness.home)
    assert install.run(Options(SHA, False, True, None), harness.env, None) == ExitCode.OK
    assert f"CREATE write installed state '{harness.layout.state}'" in caplog.text
    for path in (
        harness.layout.root,
        harness.layout.backups,
        harness.layout.root / "core",
        harness.layout.agent_dir,
        harness.layout.bin_dir,
    ):
        assert f"CREATE create directory '{path}'" in caplog.text
    assert tree(harness.home) == before


@pytest.mark.parametrize("layout_state", ["fresh", "existing-root", "symlink-root", "dangling-root-link"])
def test_normal_and_dry_plans_declare_the_same_permanent_creates(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    layout_state: str,
) -> None:
    """Lock mkdirs must remain in the actual normal-run plan, not just the dry-run plan.

    Parameters:
        tmp_path (Path): isolated installer fixture.
        monkeypatch (pytest.MonkeyPatch): mutation observers and plan recorder.
        caplog (pytest.LogCaptureFixture): public CREATE output.
        layout_state (str): fresh, existing directory, resolved symlink, or dangling root link.

    Returns:
        None: public CREATE lists agree and the actual normal plan authorizes every mutation.
    """
    harness = Harness(tmp_path, monkeypatch)
    target = harness.home / "real-root"
    if layout_state == "existing-root":
        harness.layout.root.mkdir(parents=True)
    elif layout_state in {"symlink-root", "dangling-root-link"}:
        if layout_state == "symlink-root":
            target.mkdir()
        else:
            target = harness.home / "absent/ancestors/real-root"
        data = harness.home / "data"
        data.mkdir()
        (data / "pi-stack").symlink_to(target, target_is_directory=True)
        harness.env["XDG_DATA_HOME"] = str(data)
    caplog.set_level("INFO")
    assert install.run(Options(SHA, False, True, None), harness.env, None) == ExitCode.OK
    expected = [record.message for record in caplog.records if record.message.startswith("CREATE ")]
    caplog.clear()
    reports: list[install.Plan] = []
    report = install.report_plan

    def recorded(plan: install.Plan, verified: Verified) -> None:
        """Record the actual normal-run plan independently of the test's pre-lock plan.

        Parameters:
            plan (install.Plan): actual public plan.
            verified (Verified): verified fixture snapshot.

        Returns:
            None: plan and public report are captured.
        """
        reports.append(plan)
        report(plan, verified)

    with monkeypatch.context() as patch:
        audit = MutationAudit(harness, patch, plan_install(harness.layout, harness.verified))
        patch.setattr(install, "report_plan", recorded)
        assert harness.run() == ExitCode.OK
    (actual,) = reports
    audit.plan = actual
    assert [record.message for record in caplog.records if record.message.startswith("CREATE ")] == expected
    audit.assert_classified()
    # The lock is transaction scratch, never a permanent payload CREATE; its parent still is.
    assert not any(f"'{harness.layout.root / 'lock'}'" in line for line in actual.creates)
    if layout_state in {"fresh", "dangling-root-link"}:
        assert f"create directory '{harness.layout.root}'" in actual.creates
        assert f"create directory '{harness.layout.root.parent}'" in actual.creates
        assert harness.layout.root.parent in audit.created
    else:
        assert f"create directory '{harness.layout.root}'" not in actual.creates
        assert f"create directory '{harness.layout.agent_dir.parent}'" in actual.creates
    if layout_state in {"symlink-root", "dangling-root-link"}:
        assert (harness.home / "data/pi-stack").is_symlink()
        assert (harness.home / "data/pi-stack").readlink() == target


def write_tool_shims(harness: Harness, commands: Path, log: Path) -> None:
    """Write executable recording shims, with npm building the fixture's core prefix.

    Parameters:
        harness (Harness): isolated install and package identities.
        commands (Path): shim directory to create.
        log (Path): absolute argv recording destination.

    Returns:
        None: executable tool shims are written.

    Raises:
        OSError: shim creation failed.
    """
    commands.mkdir()
    for name in ("gh", "npm", "node"):
        script = (
            f"#!{sys.executable}\nimport json,os,pathlib,sys\n"
            f"with pathlib.Path({str(log)!r}).with_suffix('.env.jsonl').open('a') as env_log:\n"
            f"    keys = {CHILD_ENV_PROBE_KEYS!r}\n"
            "    env_log.write(json.dumps({key: os.environ[key] for key in keys if key in os.environ})"
            " + '\\n')\n"
            f"with pathlib.Path({str(log)!r}).open('a') as handle:\n"
            "    handle.write(json.dumps(sys.argv) + '\\n')\n"
        )
        if name == "node":
            script += "print('v22.19.0')\n"
        elif name == "npm":
            fake_pi = FAKE_PI.format(
                python=sys.executable,
                log=str(harness.log),
                fail=[],
                integrity=harness.integrity,
                tokens=sorted(GITHUB_TOKEN_VARIABLES),
                env_keys=CHILD_ENV_PROBE_KEYS,
            )
            script += (
                "prefix = pathlib.Path(sys.argv[sys.argv.index('--prefix') + 1])\n"
                "binary = prefix / 'bin/pi'\nbinary.parent.mkdir(parents=True)\n"
                f"binary.write_text({fake_pi!r})\nbinary.chmod(0o755)\n"
            )
        (commands / name).write_text(script)
        (commands / name).chmod(0o755)


def assert_child_command(argv: Any, kwargs: Any, commands: Path, assert_absolute: bool) -> None:
    """Validate both subprocess boundaries independently of production environment construction.

    Parameters:
        argv (Any): actual child command.
        kwargs (Any): actual subprocess options.
        commands (Path): selected Node directory.
        assert_absolute (bool): additionally require an absolute executable.

    Returns:
        None: command and interpreter search path retain preflight identities.

    Raises:
        AssertionError: child lookup differs from the preflight selection.
    """
    if not assert_absolute:
        return
    assert Path(argv[0]).is_absolute(), argv
    child_path = kwargs["env"]["PATH"].split(os.pathsep)
    assert all(Path(entry).is_absolute() for entry in child_path), child_path
    assert child_path[0] == str(commands), child_path


def shim_core_tarball() -> bytes:
    """Build the minimal digest-bound core fixture for real npm shim execution.

    Returns:
        bytes: valid gzip tar containing the tui package manifest.

    Raises:
        tarfile.TarError: fixture archive construction failed.
    """
    payload = io.BytesIO()
    with tarfile.open(fileobj=payload, mode="w:gz") as archive:
        data = b"{}"
        member = tarfile.TarInfo("package/package.json")
        member.size = len(data)
        archive.addfile(member, io.BytesIO(data))
    return payload.getvalue()


def configure_tool_interpreters(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    commands: Path,
    shebang: str | None,
    different_node: bool,
) -> None:
    """Configure real interpreter lookup and an optional failing earlier Node.

    Parameters:
        tmp_path (Path): preflight cwd.
        monkeypatch (pytest.MonkeyPatch): environment lifetime.
        commands (Path): executable shim directory.
        shebang (str | None): npm shebang override.
        different_node (bool): insert the unvalidated Node decoy.

    Returns:
        None: shim interpreters and relative PATH are configured.

    Raises:
        OSError: fixture read or write failed.
    """
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("PATH", f"./bin{os.pathsep}{os.defpath}")
    if shebang is not None:
        npm = commands / "npm"
        interpreter = f"#!{sys.executable}" if shebang == "absolute" else shebang
        npm.write_text(interpreter + "\n" + npm.read_text().split("\n", 1)[1])
        node = commands / "node"
        script = node.read_text().replace(
            "print('v22.19.0')",
            (
                "if sys.argv[1:] == ['--version']:\n    print('v22.19.0')\n"
                "else:\n    import os\n"
                f"    os.execv({sys.executable!r}, [{sys.executable!r}, *sys.argv[1:]])"
            ),
        )
        node.write_text(script)
    if different_node:
        decoy = tmp_path / "decoy"
        decoy.mkdir()
        (decoy / "node").write_text("#!/bin/sh\nexit 91\n")
        (decoy / "node").chmod(0o755)
        monkeypatch.setenv("PATH", f"{decoy}{os.pathsep}./bin{os.pathsep}{os.defpath}")


def relative_tool_install(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    *,
    assert_absolute: bool,
    shebang: str | None = None,
    different_node: bool = False,
) -> None:
    """Run verification, npm staging, package installs and post-check through relative-PATH shims.

    Parameters:
        tmp_path (Path): isolated home and shim directory.
        monkeypatch (pytest.MonkeyPatch): offline network seams and subprocess observer.
        assert_absolute (bool): reject any relative executable at both subprocess boundaries.
        shebang (str | None): npm interpreter form, using the recording node shim.
        different_node (bool): place a failing node earlier than the explicitly validated node.

    Returns:
        None: complete install and executable-selection assertions pass.

    Raises:
        AssertionError: a tool, child PATH or installed result differs from the fixture contract.
        InstallError: the fixture installation failed.
    """
    harness = Harness(tmp_path, monkeypatch)
    commands, log = tmp_path / "bin", tmp_path / "tools.jsonl"
    write_tool_shims(harness, commands, log)
    configure_tool_interpreters(tmp_path, monkeypatch, commands, shebang, different_node)
    # Stale relative import-time globals must NOT win over this run's preflight paths.
    monkeypatch.setattr(release, "NPM_BIN", "./bin/npm")
    monkeypatch.setattr(release, "GH_BIN", "./bin/gh")

    def selected(system: str, machine: str) -> dict[str, str]:
        """Select the explicitly validated node independently of an earlier PATH decoy.

        Parameters:
            system (str): host operating system.
            machine (str): host architecture.

        Returns:
            dict[str, str]: discovered absolute tools with the chosen Node dispatcher.

        Raises:
            UnsupportedError: required tools or platform are unavailable.
        """
        tools = preflight(system, machine)
        if different_node:
            tools["node"] = str(commands / "node")
        return tools

    monkeypatch.setattr(install, "preflight", selected)
    monkeypatch.setattr(install, "verify_snapshot", verify_snapshot)
    monkeypatch.setattr(install, "fetch_release", release.fetch_release)
    monkeypatch.setattr(install, "fetch_bytes", lambda request: FIXTURE.read_bytes())

    def bundle(repo: str, path: Path, destination: Path) -> Path:
        """Provide a local attestation input while retaining the real gh subprocess boundary.

        Parameters:
            repo (str): ignored attesting repository.
            path (Path): ignored artifact path.
            destination (Path): bundle file to create.

        Returns:
            Path: local bundle destination.

        Raises:
            OSError: fixture write failed.
        """
        destination.write_text("{}\n")
        return destination

    monkeypatch.setattr(release, "attestation_bundle", bundle)
    tarball = shim_core_tarball()
    monkeypatch.setattr(release, "fetch_bytes", lambda request: tarball)
    checksums = {
        url: hashlib.sha256(tarball).hexdigest()
        for url in release.release_package_urls(harness.snapshot.stack.core.tag).values()
    }

    def verified(snapshot: StackSnapshot, node: str, workdir: Path, **kwargs: Any) -> Verified:
        """Keep real dispatcher executions; tarball identity is this offline fixture's digest.

        Parameters:
            snapshot (StackSnapshot): verified promotion fixture.
            node (str): preflight-selected Node.js dispatcher.
            workdir (Path): verification scratch directory.
            **kwargs (Any): preflight-selected GitHub CLI path.

        Returns:
            Verified: inputs bound to the fixture's tarball bytes.

        Raises:
            AssertionError: selected Node reports an unexpected version.
            UnsupportedError: selected Node cannot execute.
            OSError | RuntimeError: fixture write or provenance check failed.
        """
        assert install.node_version(node) == (22, 19, 0)
        artifact = workdir / "core.tgz"
        artifact.write_bytes(tarball)
        release.verify_provenance_anonymously(artifact, snapshot.stack.core.tag, **kwargs)
        return Verified(snapshot, harness.verified.sources, checksums)

    monkeypatch.setattr(install, "verify_release", verified)
    seen: list[str] = []
    original_run, original_popen = subprocess.run, subprocess.Popen

    def checked_run(argv: Any, *args: Any, **kwargs: Any) -> Any:
        """Observe check_output's run boundary before cwd can reinterpret an executable.

        Parameters:
            argv (Any): subprocess command list.
            *args (Any): remaining subprocess arguments.
            **kwargs (Any): subprocess options.

        Returns:
            Any: the real subprocess result.

        Raises:
            AssertionError: command or interpreter lookup changed.
            OSError | subprocess.SubprocessError: child execution failed.
        """
        seen.append(str(argv[0]))
        assert_child_command(argv, kwargs, commands, assert_absolute)
        return original_run(argv, *args, **kwargs)

    def checked_popen(argv: Any, *args: Any, **kwargs: Any) -> Any:
        """Also catch direct Popen users, independently of subprocess.run.

        Parameters:
            argv (Any): subprocess command list.
            *args (Any): remaining subprocess arguments.
            **kwargs (Any): subprocess options.

        Returns:
            Any: the real child process handle.

        Raises:
            AssertionError: command or interpreter lookup changed.
            OSError: child creation failed.
        """
        assert_child_command(argv, kwargs, commands, assert_absolute)
        return original_popen(argv, *args, **kwargs)

    monkeypatch.setattr(subprocess, "run", checked_run)
    monkeypatch.setattr(subprocess, "Popen", checked_popen)
    assert harness.run() == ExitCode.OK
    calls = [json.loads(line) for line in log.read_text().splitlines()]
    assert {call[0] for call in calls} == {str(commands / name) for name in ("gh", "npm", "node")}
    if shebang is not None and shebang != "absolute":
        assert any(call[:2] == [str(commands / "node"), str(commands / "npm")] for call in calls)
    assert {str(commands / name) for name in ("gh", "npm", "node")} <= set(seen)
    assert not harness.layout.journal.exists()


def test_install_relative_path_dispatchers_survive_staging_cwd(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Preflight's absolute, non-resolved paths must reach gh and npm, including npm's changed cwd."""
    relative_tool_install(tmp_path, monkeypatch, assert_absolute=False)


@pytest.mark.parametrize("shebang", ["#!/usr/bin/env node", "#!/usr/bin/env -S node", "absolute"])
@pytest.mark.parametrize("different_node", [False, True])
def test_install_npm_shebang_uses_validated_node(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, shebang: str, different_node: bool
) -> None:
    """An npm env-node shebang must retain preflight's Node across the staging cwd change.

    Parameters:
        tmp_path (Path): isolated tools and home.
        monkeypatch (pytest.MonkeyPatch): environment and network seams.
        shebang (str): actual kernel interpreter directive.
        different_node (bool): earlier PATH node must not override the validated one.

    Returns:
        None: the complete install succeeds and the Node marker proves interpreter selection.
    """
    relative_tool_install(
        tmp_path,
        monkeypatch,
        assert_absolute=False,
        shebang=shebang,
        different_node=different_node,
    )


@pytest.mark.parametrize("shebang", ["#!/usr/bin/env node", "#!/usr/bin/env -S node", "absolute"])
def test_every_child_uses_the_minimal_environment(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    shebang: str,
) -> None:
    """Real node/npm/gh/pi shims must see the allowlist, never parent runtime injection.

    Parameters:
        tmp_path (Path): isolated shims, environment logs and home.
        monkeypatch (pytest.MonkeyPatch): hostile and allowlisted parent settings.
        shebang (str): actual npm interpreter form.

    Returns:
        None: every observed child receives safe inherited keys and owned overrides only.
    """
    hostile = {
        "NODE_OPTIONS": f"--require {tmp_path / 'marker.js'}",
        "NODE_PATH": "parent-node-module-injection",
        "BASH_ENV": "parent-shell-injection",
        "ENV": "parent-shell-injection",
        "LD_PRELOAD": "parent-loader-injection",
        "DYLD_INSERT_LIBRARIES": "parent-loader-injection",
        "PYTHONPATH": "parent-python-injection",
        "GIT_CONFIG_COUNT": "1",
        "GIT_CONFIG_KEY_0": "core.sshCommand",
        "GIT_CONFIG_VALUE_0": "parent-git-injection",
        "GIT_CONFIG_GLOBAL": "parent-git-config",
        "GIT_SSH_COMMAND": "parent-git-command",
        "GIT_ASKPASS": "parent-git-askpass",
        "Http_Proxy": "wrong-case-proxy",
        "NPM_CONFIG_REGISTRY": "https://mirror.invalid",
        "npm_config_registry": "https://mirror.invalid",
        "NPM_CONFIG_PREFIX": "parent-uppercase-prefix",
        "npm_config_prefix": "parent-lowercase-prefix",
        "PI_FOO": "parent-pi-injection",
        "PI_CODING_AGENT_DIR": "parent-agent-redirect",
    }
    allowed = {
        "LANG": "C",
        "LC_ALL": "C",
        "TMPDIR": str(tmp_path),
        "TERM": "dumb",
        "XDG_DATA_HOME": str(tmp_path / "xdg-data"),
        "XDG_CONFIG_HOME": str(tmp_path / "xdg-config"),
        "XDG_CACHE_HOME": str(tmp_path / "xdg-cache"),
        "XDG_STATE_HOME": str(tmp_path / "xdg-state"),
        "XDG_RUNTIME_DIR": str(tmp_path / "xdg-runtime"),
        "CI": "1",
        "GITHUB_ACTIONS": "true",
    }
    for key, value in (hostile | allowed).items():
        monkeypatch.setenv(key, value)
    relative_tool_install(tmp_path, monkeypatch, assert_absolute=False, shebang=shebang)
    logs = (tmp_path / "tools.env.jsonl", tmp_path / "pi-calls.env.jsonl")
    environments = [json.loads(line) for log in logs for line in log.read_text().splitlines()]
    assert len(environments) >= 6
    for env in environments:
        for key, value in hostile.items():
            assert env.get(key) != value, (key, env)
        for key, value in allowed.items():
            assert env[key] == value, (key, env)
        assert Path(env["HOME"]).is_absolute()
        assert all(Path(entry).is_absolute() for entry in env["PATH"].split(os.pathsep))
    final = json.loads(logs[1].read_text().splitlines()[-1])
    assert final["PI_CODING_AGENT_DIR"] == str((tmp_path / "home/.pi/agent").resolve())


def test_node_version_does_not_execute_parent_preloads(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A Node version dispatcher must not execute an inherited --require module.

    Parameters:
        tmp_path (Path): synthetic preload and execution marker.
        monkeypatch (pytest.MonkeyPatch): parent NODE_OPTIONS injection.

    Returns:
        None: Node reports its version without creating the preload marker.
    """
    node = shutil.which("node")
    if node is None:
        pytest.skip("Real Node is unavailable for the preload negative control")
    marker = tmp_path / "preload-ran"
    preload = tmp_path / "marker.js"
    preload.write_text(f"require('node:fs').writeFileSync({json.dumps(str(marker))}, 'loaded');\n")
    options = f"--require {preload}"
    # Node's direct --version fast path need not evaluate preloads. A version-manager dispatcher
    # can evaluate JS while finding its version, so prove the preload works, then test that boundary.
    subprocess.check_output(
        [str(Path(node).absolute()), "-p", "process.version"],
        env={"NODE_OPTIONS": options, "PATH": os.defpath},
        text=True,
        stderr=subprocess.STDOUT,
        timeout=install.VERSION_TIMEOUT,
    )
    assert marker.read_text() == "loaded"
    marker.unlink()
    dispatcher = tmp_path / "node"
    dispatcher.write_text(
        f"#!{sys.executable}\nimport os\nos.execv({node!r}, [{node!r}, '-p', 'process.version'])\n"
    )
    dispatcher.chmod(0o700)
    monkeypatch.setenv("NODE_OPTIONS", options)
    assert install.node_version(dispatcher.as_posix()) > (0, 0, 0)
    assert not marker.exists()


def test_install_never_spawns_relative_executable(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Every run/Popen executable in a full installer flow must be absolute."""
    relative_tool_install(tmp_path, monkeypatch, assert_absolute=True)


@pytest.mark.parametrize(
    "key",
    [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "NO_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "no_proxy",
        "all_proxy",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
        "NODE_EXTRA_CA_CERTS",
        "REQUESTS_CA_BUNDLE",
        "CURL_CA_BUNDLE",
    ],
)
def test_connectivity_reaches_every_child(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, key: str) -> None:
    """Each exact connectivity key reaches real npm/gh/node/pi shims unchanged.

    Parameters:
        tmp_path (Path): isolated CA files, shims and install roots.
        monkeypatch (pytest.MonkeyPatch): scoped synthetic environment and network seams.
        key (str): exact allowlisted connectivity name.

    Returns:
        None: every child's environment preserves the synthetic value.

    Raises:
        AssertionError: any child drops or rewrites the value.
    """
    ca = tmp_path / "enterprise-ca.pem"
    ca.write_text("synthetic CA fixture")
    value = (
        str(tmp_path)
        if key == "SSL_CERT_DIR"
        else str(ca)
        if key in {"SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE"}
        else "internal.invalid,localhost"
        if key.lower() == "no_proxy"
        else "http://synthetic-user:synthetic-password@proxy.invalid:8080"
    )
    monkeypatch.setenv(key, value)
    relative_tool_install(tmp_path, monkeypatch, assert_absolute=True)
    for log in (tmp_path / "tools.env.jsonl", tmp_path / "pi-calls.env.jsonl"):
        environments = [json.loads(line) for line in log.read_text().splitlines()]
        assert environments
        assert all(env.get(key) == value for env in environments)


@pytest.mark.parametrize(
    "key", ["SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE"]
)
@pytest.mark.parametrize("kind", ["relative", "missing", "wrong-kind"])
def test_invalid_ca_dropped_with_value_free_warning(
    tmp_path: Path, caplog: pytest.LogCaptureFixture, key: str, kind: str
) -> None:
    """Relative, missing and wrong-kind CA paths never reach children or warning text.

    Parameters:
        tmp_path (Path): isolated path fixture.
        caplog (pytest.LogCaptureFixture): captured value-free warnings.
        key (str): CA file/directory variable.
        kind (str): relative, missing or wrong-kind path.

    Returns:
        None: invalid paths are dropped with the exact warning.

    Raises:
        AssertionError: an invalid path passes or its value is logged.
    """
    path = tmp_path / "private-ca-path"
    if kind == "wrong-kind":
        if key == "SSL_CERT_DIR":
            path.touch()
        else:
            path.mkdir()
    value = "private-relative-ca" if kind == "relative" else str(path)
    assert key not in release.child_environment({key: value})
    assert caplog.messages == [f"Dropping `{key}`: expected an absolute existing CA path"]
    assert value not in caplog.text


@pytest.mark.parametrize("key", CONNECTIVITY_PROBE_KEYS)
@pytest.mark.parametrize("character", ["\u0000", "\n", "\r"])
def test_connectivity_rejects_control_characters(
    caplog: pytest.LogCaptureFixture, key: str, character: str
) -> None:
    """Invalid environment values are dropped before spawn with a value-free warning.

    Parameters:
        caplog (pytest.LogCaptureFixture): captured warning text.
        key (str): exact connectivity variable.
        character (str): NUL, CR or LF injected into the value.

    Returns:
        None: no invalid value reaches a child.

    Raises:
        AssertionError: the value passes or its diagnostic exposes it.
    """
    assert key not in release.child_environment({key: f"private{character}value"})
    assert caplog.messages == [f"Dropping `{key}`: NUL/newline is not allowed"]


@pytest.mark.parametrize(
    "proxy",
    [
        "http://user:password@host:8080",
        "user:password@host:8080",
        "socks5://user:p%40ss@host:1080",
        "http://user@host:8080",
    ],
)
def test_proxy_redaction_before_tail_truncation(monkeypatch: pytest.MonkeyPatch, proxy: str) -> None:
    """Echoed environments and byte/string failure tails strip credentials before slicing.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): scoped synthetic proxy setting.
        proxy (str): credential-bearing URL or authority.

    Returns:
        None: independent expected strings match all sanitized tails.

    Raises:
        AssertionError: userinfo survives or truncation precedes redaction.
    """
    monkeypatch.setenv("HTTPS_PROXY", proxy)
    expected = proxy.replace(proxy.rsplit("://", maxsplit=1)[-1].split("@", maxsplit=1)[0] + "@", "")
    message = json.dumps({"HTTPS_PROXY": proxy}) + " " + proxy
    assert release.redact_diagnostic(message) == json.dumps({"HTTPS_PROXY": expected}) + " " + expected
    clean_message = json.dumps({"HTTPS_PROXY": expected}) + " " + expected
    for output in (message, message.encode()):
        error = subprocess.CalledProcessError(1, ["npm"], output=output)
        assert release._error_tail(error) == clean_message
    # If slicing came first, credentials straddling the boundary would remain visible.
    output = proxy + "x" * 5995
    error = subprocess.CalledProcessError(1, ["gh"], output=output)
    assert release._error_tail(error) == (expected + "x" * 5995)[-6000:]


@pytest.mark.parametrize("tool", ["node", "pi", "pi-install", "npm", "gh"])
def test_child_diagnostics_redact_proxy_credentials(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, tool: str
) -> None:
    """Real child errors and successful version text redact URL userinfo.

    Parameters:
        tmp_path (Path): isolated executable shims and staging.
        monkeypatch (pytest.MonkeyPatch): scoped environment and download seams.
        tool (str): installer subprocess boundary to exercise.

    Returns:
        None: public text retains host/source identities without credentials.

    Raises:
        AssertionError: credentials survive or useful identities disappear.
    """
    proxy = "http://echo-user:echo-password@proxy.invalid:8080"
    monkeypatch.setenv("HTTPS_PROXY", proxy)
    child = tmp_path / tool
    child.write_text(f"#!{sys.executable}\nimport os\nprint(os.environ['HTTPS_PROXY'])\n")
    child.chmod(0o700)
    if tool == "node":
        with pytest.raises(UnsupportedError) as caught:
            install.node_version(str(child))
        text = str(caught.value)
    elif tool == "pi":
        harness = Harness(tmp_path, monkeypatch)
        harness.layout.link.parent.mkdir(parents=True, exist_ok=True)
        harness.layout.link.symlink_to(child)
        text = install.post_check(harness.layout)
    else:
        child.write_text(child.read_text() + "raise SystemExit(1)\n")
        if tool == "pi-install":
            harness = Harness(tmp_path, monkeypatch)
            with pytest.raises(InstallError) as caught:
                install.install_packages(harness.verified, child, tmp_path / "staging")
        elif tool == "gh":
            with pytest.raises(RuntimeError) as caught:
                release.verify_attestation(
                    tmp_path / "asset", "nredd/pi", "workflow", "ref", gh_bin=str(child)
                )
        else:
            tarball = shim_core_tarball()
            monkeypatch.setattr(release, "fetch_bytes", lambda request: tarball)
            checksums = {
                url: hashlib.sha256(tarball).hexdigest()
                for url in release.release_package_urls("v1.3.0-nredd.7").values()
            }
            with pytest.raises(RuntimeError) as caught:
                release.fetch_release(
                    "v1.3.0-nredd.7", tmp_path / "prefix", checksums=checksums, npm_bin=str(child)
                )
        text = str(caught.value)
    assert "echo-user" not in text
    assert "echo-password" not in text
    assert "http://proxy.invalid:8080" in text
    if tool == "pi-install":
        assert harness.verified.sources[0] in text


@pytest.mark.parametrize("proxy", ["http://@host", "http://a@host"])
@pytest.mark.parametrize(
    "text", ["npm:@nredd/pkg@1.0", "git@github.com:repo", "email@example.com", "name@host"]
)
def test_proxy_redaction_preserves_nonproxy_identifiers(
    monkeypatch: pytest.MonkeyPatch, proxy: str, text: str
) -> None:
    """Empty/short userinfo must not damage scoped package, SSH or email identifiers.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): scoped proxy environment.
        proxy (str): empty or short proxy userinfo.
        text (str): unrelated identifier that must remain intact.

    Returns:
        None: only the proxy userinfo is removed.

    Raises:
        AssertionError: unrelated text changes or userinfo survives.
    """
    monkeypatch.setenv("HTTPS_PROXY", proxy)
    assert release.redact_diagnostic(f"{text} {proxy}") == f"{text} http://host"


@pytest.mark.parametrize("boundary", ["installer", "fallback-warning", "release-cli"])
def test_proxy_redaction_at_public_diagnostic_boundaries(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture, boundary: str
) -> None:
    """Public logs and CLI exits redact even when a lower layer returns a raw error.

    Parameters:
        tmp_path (Path): isolated artifact path.
        monkeypatch (pytest.MonkeyPatch): scoped failure injection and proxy environment.
        caplog (pytest.LogCaptureFixture): public logger output.
        boundary (str): installer error, fallback warning or release CLI.

    Returns:
        None: public text contains only the proxy host.

    Raises:
        AssertionError: a boundary exposes credentials or drops the host.
    """
    proxy = "http://log-user:log-password@host:8080"
    monkeypatch.setenv("HTTP_PROXY", proxy)
    error = (
        InstallError(proxy)
        if boundary == "installer"
        else release.AttestationRateLimitedError(proxy)
        if boundary == "fallback-warning"
        else RuntimeError(proxy)
    )

    def fail(*args: object, **kwargs: object) -> None:
        """Inject a raw transport diagnostic at the public boundary.

        Parameters:
            *args (object): unused operation inputs.
            **kwargs (object): unused operation options.

        Returns:
            None: never returned.

        Raises:
            RuntimeError: the raw diagnostic for this boundary.
        """
        raise error

    if boundary == "installer":
        monkeypatch.setattr(install, "run", fail)
        assert install.main([SHA]) == ExitCode.FAILED
        text = caplog.text
    elif boundary == "fallback-warning":
        monkeypatch.setattr(release, "attestation_bundle", fail)
        monkeypatch.setattr(release, "verify_attestation", lambda *args, **kwargs: None)
        release.verify_public_attestation(tmp_path / "asset", "repo", "workflow", "ref")
        text = caplog.text
    else:
        monkeypatch.setattr(release, "verify_root_overrides", fail)
        monkeypatch.setattr(sys, "argv", ["release", "--verify-root-overrides"])
        with pytest.raises(SystemExit) as caught:
            release.main()
        text = str(caught.value)
    assert "log-user" not in text
    assert "log-password" not in text
    assert "http://host:8080" in text


def test_snapshot_does_not_authenticate_third_party_lock_integrity(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Record the real snapshot's transport-trust gap without claiming broader integrity.

    Parameters:
        tmp_path (Path): isolated installation with real snapshot package declarations.
        monkeypatch (pytest.MonkeyPatch): fake download/package-install boundaries.

    Returns:
        None: owned evidence excludes third parties and their altered lock integrity passes.

    Raises:
        AssertionError: the snapshot's authentication coverage changes and docs need updating.
    """
    harness = Harness(tmp_path, monkeypatch)
    assert harness.run() == ExitCode.OK
    assert all(item.package.startswith("@nredd/") for item in harness.snapshot.gates.owned_packages)
    lock_path = harness.layout.agent_dir / "npm/package-lock.json"
    lock = json.loads(lock_path.read_text())
    third_party = next(key for key in lock["packages"] if not key.startswith("node_modules/@nredd/"))
    lock["packages"][third_party]["integrity"] = "sha512-untrusted-registry-substitution"
    lock_path.write_text(json.dumps(lock))
    install.verify_owned_integrity(harness.snapshot, harness.layout.agent_dir)
