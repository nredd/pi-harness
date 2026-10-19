"""Explicit-stack validation and isolation tests; no Pi process or live state."""

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
from harness.stack import Stack, find_package, load_stack, package_directory, stack_digest


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
        {"settings": {"packages": []}},
        {"unknown": True},
        {"name": 123},
        {"disabled_extensions": {"./missing": "unlisted"}},
        {"disabled_extensions": {"./pkg": ""}},
    ],
)
def test_stack_rejects_implicit_or_ambiguous_inputs(change: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        Stack.model_validate({"name": "unit", "sources": ["./pkg"]} | change)


def test_stack_file_resolves_relative_to_document_not_cwd(tmp_path: Path) -> None:
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
    root = Path(__file__).resolve().parents[1]
    personal = load_stack(root / "stacks/personal.json")
    local = load_stack(root / "stacks/local.json")
    assert len(personal.sources) == len(local.sources) == 13
    assert "npm:@nredd/pi-preset@0.1.0" in personal.sources
    assert "../../packages/preset" in local.sources
    assert len(personal.disabled_extensions) == len(local.disabled_extensions) == 1
    assert "pi-computer-use" in next(iter(personal.disabled_extensions))
    assert len([s for s in personal.sources if s.startswith("git:")]) == 5


def test_no_pi_path_fallback(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("PI_BIN", raising=False)
    with pytest.raises(FileNotFoundError, match="explicit `PI_BIN`"):
        pi_command()
    monkeypatch.setenv("PI_BIN", "/tmp/node /tmp/candidate.js")
    assert pi_command() == ["/tmp/node", "/tmp/candidate.js"]


def test_installer_uses_pi_install_then_overlay(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
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
        """Model installer writes only, never launch Pi."""
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
    other = sandbox.build_sandbox(tmp_path / "other", box.home)
    sentinel = package_directory("npm:one@1.2.3", other.agent_dir) / "sentinel"
    sentinel.write_text("private")
    assert not (package_directory("npm:one@1.2.3", box.agent_dir) / "sentinel").exists()
    assert other.env()["TMPDIR"] != box.env()["TMPDIR"]
    assert other.env()["XDG_CONFIG_HOME"] != box.env()["XDG_CONFIG_HOME"]


def test_package_lookup_does_not_guess_an_owner_checkout(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError, match="not installed"):
        package_directory("npm:@scope/missing@1.2.3", tmp_path)
    with pytest.raises(LookupError, match="not declared"):
        find_package("missing", [], tmp_path)
