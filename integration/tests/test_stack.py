"""Explicit-stack validation and isolation tests; no Pi process or live state.

References:
- https://docs.pydantic.dev/latest/concepts/strict_mode/
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md
"""

from __future__ import annotations

import hashlib
import json
import subprocess
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from harness import sandbox
from harness.paths import pi_command
from harness.stack import (
    PackageSource,
    Stack,
    find_package,
    load_stack,
    package_directory,
    source_string,
    stack_digest,
)


@pytest.mark.parametrize(
    "change",
    [
        {"name": ""},
        {"name": "../escape"},
        {"sources": []},
        {"sources": ["npm:pkg"]},
        {"sources": ["npm:pkg@latest"]},
        {"sources": ["git:github.com/x/y"]},
        {"sources": ["~/code/pkg"]},
        {"sources": ["./pkg", "./pkg"]},
        {"sources": ["./pkg", {"source": "./pkg", "skills": []}]},
        {"sources": [{"source": "./pkg"}, {"source": "./pkg", "themes": []}]},
        {"sources": [{"source": "npm:pkg@latest"}]},
        {"sources": [{"source": "~/pkg"}]},
        {"sources": [{"source": ""}]},
        {"sources": [{"source": 12}]},
        {"sources": [{"skills": []}]},
        {"sources": [{"source": "./pkg", "agents": []}]},
        {"sources": [{"source": "./pkg", "autoload": False}]},
        {"sources": [{"source": "./pkg", "extensions": None}]},
        {"sources": [{"source": "./pkg", "skills": "skills/*"}]},
        {"sources": [{"source": "./pkg", "prompts": [False]}]},
        {"sources": [{"source": "./pkg", "themes": [1]}]},
        {"sources": [{"source": "./pkg", "extensions": {}}]},
        {"settings": {"packages": []}},
        {"unknown": True},
        {"name": 123},
        {"disabled_extensions": {"./missing": "unlisted"}},
        {"disabled_extensions": {"./pkg": ""}},
        {"disabled_extensions": {"./pkg": "   "}},
    ],
)
def test_stack_rejects_implicit_or_ambiguous_inputs(change: dict[str, Any]) -> None:
    """Reject invalid source shapes, floating identities and implicit machine state.

    Parameters:
        change (dict[str, Any]): invalid overlay on a minimal explicit stack.
    """
    with pytest.raises(ValidationError):
        Stack.model_validate({"name": "unit", "sources": ["./pkg"]} | change)


def test_stack_file_resolves_relative_to_document_not_cwd(tmp_path: Path) -> None:
    """Resolve local sources against the document and require real package manifests.

    Parameters:
        tmp_path (Path): private stack and local package tree.
    """
    package = tmp_path / "pkg"
    package.mkdir()
    (package / "package.json").write_text('{"name":"@test/pkg","version":"1.2.3"}')
    path = tmp_path / "stack.json"
    path.write_text(
        json.dumps({"name": "unit", "sources": ["./pkg", "npm:@scope/pkg@1.2.3", "git:github.com/x/y@v1"]})
    )
    stack = load_stack(path)
    assert stack.resolved_sources(path) == [str(package), "npm:@scope/pkg@1.2.3", "git:github.com/x/y@v1"]
    assert stack_digest(path) == hashlib.sha256(path.read_bytes()).hexdigest()
    assert find_package("pkg", [str(package)], tmp_path) == package
    with pytest.raises(FileNotFoundError, match=r"no `package\.json`"):
        Stack(name="unit", sources=["./missing"]).resolved_sources(path)


def test_supplied_stacks_are_pinned_and_exclusion_is_explicit() -> None:
    """Keep personal/local source counts, exact pins and headless exclusions deliberate."""
    root = Path(__file__).resolve().parents[1]
    personal = load_stack(root / "stacks/personal.json")
    local = load_stack(root / "stacks/local.json")
    assert len(personal.sources) == 12
    assert len(local.sources) == 13
    assert "git:github.com/nredd/pi-subagents@v0.22.0-nredd.5" in personal.sources
    assert "git:github.com/nredd/pi-plan-mode@v0.59.3-nredd.1" in personal.sources
    assert not any("pi-preset" in source_string(source) for source in personal.sources)
    assert "../../packages/preset" in local.sources
    assert len(personal.disabled_extensions) == len(local.disabled_extensions) == 1
    assert "pi-computer-use" in next(iter(personal.disabled_extensions))
    assert personal.sources[0] == local.sources[0] == "npm:@gotgenes/pi-anthropic-auth@3.4.3"
    assert len([source for source in personal.sources if source_string(source).startswith("git:")]) == 4


def test_no_pi_path_fallback(monkeypatch: pytest.MonkeyPatch) -> None:
    """Require an explicit CLI command instead of discovering the owner's installation.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): control the explicit PI_BIN input.
    """
    monkeypatch.delenv("PI_BIN", raising=False)
    with pytest.raises(FileNotFoundError, match="explicit `PI_BIN`"):
        pi_command()
    monkeypatch.setenv("PI_BIN", "/tmp/node /tmp/candidate.js")
    assert pi_command() == ["/tmp/node", "/tmp/candidate.js"]


def test_installer_uses_pi_install_then_overlay(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """Verify install isolation, evidence and fixture policy without launching Pi.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): replace the installer and plant forbidden environment values.
        tmp_path (Path): private package-set document and installation roots.
    """
    stack_path = tmp_path / "stack.json"
    stack_path.write_text(
        json.dumps(
            {
                "name": "fixture",
                "sources": ["npm:one@1.2.3", "git:github.com/x/two@v1"],
                "settings": {"quietStartup": True},
                "disabled_extensions": {"git:github.com/x/two@v1": "GUI needs TCC"},
            }
        )
    )
    calls: list[list[str]] = []
    monkeypatch.setenv("PI_BIN", "/explicit/pi")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "must-not-leak")
    monkeypatch.setenv("NODE_OPTIONS", "must-not-leak")

    def fake_install(argv: list[str], *, cwd: Path, env: dict[str, str], **kwargs: Any) -> str:
        """Model installer writes only, never launch Pi.

        Parameters:
            argv (list[str]): expected explicit Pi installation command.
            cwd (Path): private installation working directory.
            env (dict[str, str]): scrubbed installer environment.
            **kwargs (Any): subprocess capture and deadline options.

        Returns:
            str: simulated installer output.
        """
        assert cwd.is_dir()
        assert "ANTHROPIC_API_KEY" not in env
        assert "NODE_OPTIONS" not in env
        assert env["HOME"].startswith(str(tmp_path))
        assert env["PI_OFFLINE"] == "0"
        assert "shims" not in env["PATH"]
        assert kwargs["timeout"] == 600
        calls.append(argv)
        agent = Path(env["PI_CODING_AGENT_DIR"])
        source = argv[-1]
        assert env.get("npm_config_ignore_scripts") == ("true" if source.startswith("git:") else None)
        target = agent / ("npm/node_modules/one" if source.startswith("npm:") else "git/github.com/x/two")
        target.mkdir(parents=True)
        (target / "package.json").write_text(
            json.dumps({"name": "one" if source.startswith("npm:") else "two", "version": "1.2.3"})
        )
        settings = json.loads((agent / "settings.json").read_text())
        settings["packages"] = [*settings.get("packages", []), {"source": source, "autoload": True}]
        (agent / "settings.json").write_text(json.dumps(settings))
        return "installed"

    monkeypatch.setattr(subprocess, "check_output", fake_install)
    box = sandbox.install_stack(tmp_path / "install", stack_path)
    assert calls == [["/explicit/pi", "install", source] for source in load_stack(stack_path).sources]
    assert box.settings()["quietStartup"] is True
    assert box.settings()["packages"][0] == "npm:one@1.2.3"
    assert json.loads((box.agent_dir / "subagents.json").read_text())["workflowsEnabled"] is False
    assert box.settings()["packages"][-1] == {"source": "git:github.com/x/two@v1", "extensions": []}
    assert (box.agent_dir / "stack-name").read_text() == "fixture"
    box.patch_json("settings.json", {"retry": {"enabled": True}})
    other = sandbox.build_sandbox(tmp_path / "other", box.home)
    assert other.settings()["retry"] == {"enabled": True}
    sentinel = package_directory("npm:one@1.2.3", other.agent_dir) / "sentinel"
    sentinel.write_text("private")
    assert not (package_directory("npm:one@1.2.3", box.agent_dir) / "sentinel").exists()
    assert other.env()["TMPDIR"] != box.env()["TMPDIR"]
    assert other.env()["XDG_CONFIG_HOME"] != box.env()["XDG_CONFIG_HOME"]


@pytest.mark.parametrize("disabled", [False, True])
def test_installer_preserves_object_filters_and_omissions(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, disabled: bool
) -> None:
    """Install string identities, then restore exact filters for Pi's loader to interpret.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): replace process execution, never launch Pi.
        tmp_path (Path): private local package and agent directories.
        disabled (bool): headless exclusion overrides only the extension filter.
    """
    local = tmp_path / "pkg"
    local.mkdir()
    (local / "package.json").write_text('{"name":"local","version":"1.2.3"}')
    filters = ["extensions/*.ts", "!extensions/old.ts", "+extensions/exact.ts", "-extensions/off.ts"]
    entries: list[Any] = [
        {"source": "./pkg", "extensions": filters, "skills": [], "prompts": ["prompts/review.md"]},
        {"source": "npm:@scope/pkg@1.2.3", "themes": []},
        "git:github.com/x/y@v1",
    ]
    stack_path = tmp_path / "stack.json"
    stack_path.write_text(
        json.dumps(
            {
                "name": "filtered",
                "sources": entries,
                "disabled_extensions": {"./pkg": "headless only"} if disabled else {},
            }
        )
    )
    calls: list[str] = []
    monkeypatch.setenv("PI_BIN", "/explicit/pi")

    def fake_install(argv: list[str], **kwargs: Any) -> str:
        """Simulate installed manifests and deliberately discard installer-written settings.

        Parameters:
            argv (list[str]): source-string installation command.
            **kwargs (Any): subprocess arguments including the private install environment.

        Returns:
            str: installer output.
        """
        source = argv[-1]
        calls.append(source)
        env = kwargs["env"]
        assert env.get("npm_config_ignore_scripts") == ("true" if disabled and source == str(local) else None)
        agent = Path(env["PI_CODING_AGENT_DIR"])
        if source != str(local):
            directory = agent / (
                "npm/node_modules/@scope/pkg" if source.startswith("npm:") else "git/github.com/x/y"
            )
            directory.mkdir(parents=True)
            (directory / "package.json").write_text('{"name":"fixture","version":"1.2.3"}')
        (agent / "settings.json").write_text('{"packages":["installer-written-string"]}')
        return "installed"

    monkeypatch.setattr(subprocess, "check_output", fake_install)
    box = sandbox.install_stack(tmp_path / "install", stack_path)
    assert calls == [str(local), entries[1]["source"], entries[2]]
    expected = [
        {**entries[0], "source": str(local), "extensions": [] if disabled else filters},
        entries[1],
        entries[2],
    ]
    assert box.settings()["packages"] == expected
    # Missing themes/extensions MUST remain missing, not become [] during model serialization.
    assert "themes" not in expected[0]
    assert "extensions" not in expected[1]
    evidence = json.loads((box.agent_dir / "stack-evidence.json").read_text())
    assert evidence["configured_packages"] == expected
    assert find_package("local", box.settings()["packages"], box.agent_dir) == local
    assert isinstance(load_stack(stack_path).sources[0], PackageSource)
    copied = sandbox.build_sandbox(tmp_path / "copy", box.home)
    assert copied.settings()["packages"] == expected


def test_package_lookup_does_not_guess_an_owner_checkout(tmp_path: Path) -> None:
    """Fail lookup without guessing live package or checkout locations.

    Parameters:
        tmp_path (Path): empty private package root.
    """
    with pytest.raises(FileNotFoundError, match="not installed"):
        package_directory("npm:@scope/missing@1.2.3", tmp_path)
    with pytest.raises(LookupError, match="not declared"):
        find_package("missing", [], tmp_path)
