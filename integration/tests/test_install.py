"""Installer units against the real promoted snapshot, with a fake `pi` standing in for npm.

The network-facing verification (`gh attestation verify`, release downloads) is exercised for
real by `scenarios/installer`; here it is replaced at the module seams so every planning,
consent, staging, switch and recovery path runs offline.

References:
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md
"""

from __future__ import annotations

import ast
import io
import json
import shutil
import sys
import tarfile
from pathlib import Path
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


def test_preflight_accepts_tested_platforms(tmp_path: Path) -> None:
    """Supported platforms with every tool present return absolute tool paths."""
    tool = tmp_path / "tool"
    tool.touch()
    for system, machine in install.SUPPORTED_PLATFORMS:
        assert preflight(system, machine, lambda name: str(tool)) == dict.fromkeys(
            install.REQUIRED_TOOLS, str(tool)
        )
    with pytest.raises(UnsupportedError, match="Linux/aarch64"):
        preflight("Linux", "aarch64", lambda name: str(tool))


def make_tarball(path: Path, manifest: dict[str, Any]) -> Path:
    """Write a release-shaped tarball with one `package/package.json`.

    Parameters:
        path (Path): tarball path.
        manifest (dict[str, Any]): manifest.

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
    assert required_node(make_tarball(tmp_path / "a.tgz", {"engines": {"node": ">=22.19.0"}})) == (22, 19, 0)
    with pytest.raises(VerificationError, match=r"engines\.node"):
        required_node(make_tarball(tmp_path / "b.tgz", {"engines": {"node": "^22"}}))


def test_old_node_is_refused(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Node.js older than the core's engine is a prerequisite failure, not a later crash."""
    snapshot = real_snapshot()
    workdir = tmp_path
    (workdir / "core").mkdir()
    make_tarball(
        workdir / "core" / "earendil-works-pi-coding-agent-1.3.0.tgz", {"engines": {"node": ">=22.19.0"}}
    )
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
        {"engines": {"node": ">=22.19.0"}},
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
    with pytest.raises(UnsupportedError, match="bin"):
        switch(layout, harness.verified, plan, staged, Journal(layout, layout.root / "backups" / "b"))
    steps = json.loads(layout.journal.read_text())["steps"]
    assert str(layout.link) not in [step["target"] for step in steps]
    assert rollback(layout)
    assert {k: v for k, v in tree(harness.home).items() if "pi-stack" not in k} == before
    assert not layout.journal.exists()


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


def test_installer_workflow_token_is_main_only() -> None:
    """Only reviewed `main` code gets the job token: never a PR, never a dispatch on another branch."""
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
            "Run the documented one-shot command in throwaway HOMEs",
            "GH_TOKEN",
            "${{ github.event_name != 'pull_request' && github.ref == 'refs/heads/main' "
            "&& github.token || '' }}",
        )
    ]
    assert text.count("github.token") == 1
    assert "secrets." not in text
