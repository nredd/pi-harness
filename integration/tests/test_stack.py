"""Explicit-stack validation and isolation tests; no Pi process or live state.

References:
- https://docs.pydantic.dev/latest/concepts/strict_mode/
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md
"""

from __future__ import annotations

import hashlib
import json
import re
import subprocess
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from harness import sandbox
from harness.paths import pi_command
from harness.release import gitlink_tag, release_asset_url, release_checksums
from harness.stack import (
    PRESET_IDENTITY,
    LocalStackDocument,
    PackageSource,
    Stack,
    canonical_stack_bytes,
    derive_local_stack,
    find_package,
    load_stack,
    localize_source,
    package_directory,
    source_string,
    stack_digest,
    validate_release_identity,
    validate_shipped_stack,
)
from harness.stack_fixture import golden_fixture, golden_stack

CORE = {
    "tag": "v1.3.0-nredd.7",
    "integrity": {
        "earendil-works-pi-coding-agent-1.3.0.tgz": (
            "16479a0cb393c7820d8b1fbcdc5c941ceb5a271dc64ecb4b8be6574df3a2e617"
        ),
        "earendil-works-pi-tui-1.3.0.tgz": (
            "dd8ac6c221bfd8e76fcc5b93418ba8feffd63dd705bde814aea6d4b1b46938e0"
        ),
    },
}


def stack_document(**overrides: Any) -> dict[str, Any]:
    """Return a minimal valid stack document with selective test overrides.

    Parameters:
        **overrides (Any): document fields to replace.

    Returns:
        dict[str, Any]: strict stack document fixture.
    """
    return {"schema_version": 1, "name": "unit", "core": CORE, "sources": ["./pkg"]} | overrides


@pytest.mark.parametrize(
    "change",
    [
        {"name": ""},
        {"name": "../escape"},
        {"sources": []},
        {"sources": ["npm:pkg"]},
        {"sources": ["npm:pkg@latest"]},
        {"sources": ["git:github.com/x/y"]},
        {"sources": ["git:github.com/x/y@main"]},
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
        Stack.model_validate(stack_document() | change)


@pytest.mark.parametrize(
    ("settings", "path"),
    [
        ({"temperature": 1.0}, "$.settings.temperature"),
        ({"model": {"temperature": [1.0]}}, "$.settings.model.temperature[0]"),
        ({"model": {"a.b": [1.0]}}, '$.settings.model["a.b"][0]'),
        ({"number": float("nan")}, "$.settings.number"),
        ({"number": float("inf")}, "$.settings.number"),
        ({"number": float("-inf")}, "$.settings.number"),
    ],
)
def test_stack_rejects_floats_in_settings(settings: dict[str, Any], path: str) -> None:
    """Reject floats before Python and JavaScript can canonicalize them differently.

    Parameters:
        settings (dict[str, Any]): settings overlay containing a float.
        path (str): expected JSON path in the validation error.
    """
    with pytest.raises(ValidationError, match=rf"Float at `{re.escape(path)}` is not supported"):
        Stack.model_validate(stack_document(settings=settings))


@pytest.mark.parametrize(
    ("value", "path"),
    [
        (2**53, "$.settings.number"),
        (-(2**53), "$.settings.number"),
        ({"nested": {"number": [2**53]}}, "$.settings.nested.number[0]"),
        ({"nested": {"number": [-(2**53)]}}, "$.settings.nested.number[0]"),
    ],
)
def test_stack_rejects_unsafe_integers_in_settings(value: Any, path: str) -> None:
    """Reject integers JavaScript cannot parse and reproduce exactly.

    Parameters:
        value (Any): unsafe integer or nested container containing one.
        path (str): expected JSON path in the validation error.
    """
    settings = value if isinstance(value, dict) else {"number": value}
    with pytest.raises(ValidationError, match=rf"Integer at `{re.escape(path)}` is outside"):
        Stack.model_validate(stack_document(settings=settings))


@pytest.mark.parametrize(
    "settings",
    [
        {"lone": "\ud800"},
        {"\ud800": "lone key"},
    ],
)
def test_stack_rejects_lone_surrogates_before_pydantic_normalizes_them(settings: dict[str, Any]) -> None:
    """Reject lone surrogates instead of silently replacing them during JSON serialization."""
    with pytest.raises(ValidationError, match=r"String at `\$\.settings.*` contains a lone surrogate"):
        Stack.model_validate(stack_document(settings=settings))


@pytest.mark.parametrize(
    ("change", "pattern"),
    [
        (
            {"sources": [{"source": "./pkg", "extensions": ["\ud800"]}]},
            r"`\$\.sources\[0\]\.extensions\[0\]`",
        ),
        ({"name": "unit\ud800"}, r"`\$\.name`"),
        ({"disabled_extensions": {"./pkg": "why\ud800"}}, r"`\$\.disabled_extensions\[\"\./pkg\"\]`"),
        ({"schema_version": 1.0}, r"`\$\.schema_version`"),
    ],
)
def test_stack_rejects_noncanonical_values_outside_settings(change: dict[str, Any], pattern: str) -> None:
    """Apply the canonical-JSON guard to every field, not only `settings`."""
    with pytest.raises(ValidationError, match=pattern):
        Stack.model_validate(stack_document(**change))


def test_stack_rejects_non_string_nested_object_keys_before_json_normalizes_them() -> None:
    """Reject nested keys that could collide after a JSON serializer stringifies them."""
    for settings in (
        {"nested": {1: "integer", "1": "string"}},
        {"nested": {True: "boolean", "true": "string"}},
    ):
        with pytest.raises(ValidationError, match=r"Object key at `\$\.settings\.nested` must be a string"):
            Stack.model_validate(stack_document(settings=settings))


def test_stack_rejects_an_integer_key_at_any_nested_depth() -> None:
    """Reject a non-string nested key even when no normalized-key collision exists."""
    with pytest.raises(ValidationError, match=r"Object key at `\$\.settings\.nested` must be a string"):
        Stack.model_validate(stack_document(settings={"nested": {1: "integer"}}))


def test_stack_accepts_bools_before_rejecting_a_later_unsafe_integer() -> None:
    """Keep bools out of the integer guard while still finding later unsafe integers."""
    with pytest.raises(ValidationError, match=r"Integer at `\$\.settings\.values\[2\]` is outside"):
        Stack.model_validate(stack_document(settings={"values": [True, False, 2**53]}))


def test_stack_accepts_canonical_scalar_and_nested_settings() -> None:
    """Accept JSON values whose Python and JavaScript encodings agree."""
    settings = {
        "false": False,
        "negative": -(2**53 - 1),
        "null": None,
        "nested": [True, 0, 2**53 - 1, {"value": 1}],
    }
    assert Stack.model_validate(stack_document(settings=settings)).settings == settings


def test_producer_canonical_fixture_is_generated_from_the_real_serializer() -> None:
    """Lock the shared fixture to the bytes and digest the producer actually emits."""
    root = Path(__file__).resolve().parents[1]
    fixture = json.loads((root / "tests/fixtures/stack-canonical-golden.json").read_bytes())
    assert fixture == golden_fixture()
    assert fixture["sha256"] == "cd9eadbcd7ae585f17b86dad2af279daf83b5e83cd98f117e0fbf55b89deea61"
    assert hashlib.sha256(canonical_stack_bytes(golden_stack())).hexdigest() == fixture["sha256"]


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
        json.dumps(stack_document(sources=["./pkg", "npm:@scope/pkg@1.2.3", "git:github.com/x/y@v1.2.3"]))
    )
    stack = load_stack(path)
    assert stack.resolved_sources(path) == [
        str(package),
        "npm:@scope/pkg@1.2.3",
        "git:github.com/x/y@v1.2.3",
    ]
    assert (
        stack_digest(path)
        == hashlib.sha256(
            json.dumps(stack.model_dump(mode="json"), sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
    )
    assert find_package("pkg", [str(package)], tmp_path) == package
    with pytest.raises(FileNotFoundError, match=r"no `package\.json`"):
        Stack.model_validate(stack_document(sources=["./missing"])).resolved_sources(path)


def test_shipped_stack_is_semantically_valid_and_matches_the_core_gitlink() -> None:
    """Validate exact pins, exclusions, core identity and the generated local selection."""
    root = Path(__file__).resolve().parents[1]
    personal_path = root / "stacks/personal.json"
    personal = load_stack(personal_path)
    local = load_stack(root / "stacks/local.json")

    validate_shipped_stack(personal)
    validate_release_identity(
        personal,
        gitlink_tag(root.parent / "forks/pi"),
        release_checksums(personal.core.tag),
    )
    assert release_checksums(personal.core.tag)
    # Local is personal with each owned npm package and each nredd fork tag swapped for its
    # workspace path, in order, except the footer-only preset: local moves the full unfiltered
    # preset last.
    localized = [localize_source(source_string(source)) for source in personal.sources]
    preset = localize_source(f"npm:{PRESET_IDENTITY}@0.0.0")
    expected = [source for source in localized if source != preset] + [preset]
    assert [source_string(source) for source in local.sources] == expected, (
        f"local derivation diverged from personal: {expected}"
    )
    assert len(local.sources) == len(personal.sources)
    assert local.settings == personal.settings
    assert local.disabled_extensions == {
        localize_source(key): reason for key, reason in (personal.disabled_extensions or {}).items()
    }
    for stack in (personal, local):
        sources = {source_string(source) for source in stack.sources}
        for key, reason in (stack.disabled_extensions or {}).items():
            assert key in sources, f"{stack.name}: exclusion '{key}' names no source"
            assert reason.strip(), f"{stack.name}: exclusion '{key}' has no reason"
    assert isinstance(personal.sources[0], PackageSource)
    assert local.sources[-1] == "../../packages/preset"
    local_sources = [source_string(source) for source in local.sources]
    assert all(not source.startswith("git:github.com/nredd/") for source in local_sources)
    assert all(not source.startswith("npm:@nredd/") for source in local_sources)
    third_party = [
        source_string(source)
        for source in personal.sources
        if not source_string(source).startswith(("npm:@nredd/", "git:github.com/nredd/"))
    ]
    assert [source for source in local_sources if not source.startswith("../../")] == third_party
    for stack in (personal, local):
        declared = {source_string(source) for source in stack.sources}
        assert stack.disabled_extensions.keys() <= declared
        assert all(reason.strip() for reason in stack.disabled_extensions.values())
    assert (
        stack_digest(root / "stacks/local.json")
        == hashlib.sha256(
            json.dumps(local.model_dump(mode="json"), sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
    )


@pytest.mark.parametrize(
    ("core", "message"),
    [
        ({"tag": "v1.3.0", "integrity": CORE["integrity"]}, "tag"),
        ({"tag": CORE["tag"], "integrity": {"bad.txt": "0" * 64}}, "filename"),
        ({"tag": CORE["tag"], "integrity": {"good.tgz": "bad"}}, "SHA-256"),
    ],
)
def test_core_release_rejects_malformed_identities(core: dict[str, Any], message: str) -> None:
    """Reject malformed tags, filenames and digests before release verification."""
    with pytest.raises(ValidationError, match=message):
        Stack.model_validate(stack_document(core=core))


def test_local_derivation_rejects_missing_or_duplicate_presets() -> None:
    """Require one personal preset before deriving the development preset."""
    without_preset = Stack.model_validate(stack_document(name="personal", sources=["npm:pi-memory@0.4.2"]))
    duplicate_preset = Stack.model_validate(
        stack_document(name="personal", sources=["npm:@nredd/pi-preset@0.2.0", "npm:@nredd/pi-preset@0.2.1"])
    )
    for personal in (without_preset, duplicate_preset):
        with pytest.raises(ValueError, match="exactly one"):
            derive_local_stack(personal)


def test_local_descriptor_and_personal_file_fail_closed(tmp_path: Path) -> None:
    """Reject malformed descriptors and missing or nested personal documents."""
    with pytest.raises(ValidationError):
        LocalStackDocument.model_validate(
            {"schema_version": 1, "name": "personal", "derived_from": "personal.json"}
        )
    with pytest.raises(ValidationError):
        LocalStackDocument.model_validate(
            {"schema_version": 1, "name": "local", "derived_from": "personal.json", "extra": True}
        )
    descriptor = tmp_path / "local.json"
    descriptor.write_text(json.dumps({"schema_version": 1, "name": "local", "derived_from": "personal.json"}))
    with pytest.raises(FileNotFoundError):
        load_stack(descriptor)
    (tmp_path / "personal.json").write_text(descriptor.read_text())
    with pytest.raises(ValidationError):
        load_stack(descriptor)


@pytest.mark.parametrize(
    ("source", "local"),
    [
        ("npm:@nredd/pi-session-kit@0.6.0", "../../packages/session-kit"),
        ("npm:@nredd/pi-preset@0.2.0", "../../packages/preset"),
        ("npm:@nredd/pi-subagents@0.22.0-nredd.5", "../../packages/subagents"),
        ("npm:@nredd/pi-todo@2.13.10", "../../packages/todo"),
        ("npm:@nredd/pi-plan-mode@0.59.3-nredd.2", "../../packages/plan-mode"),
        ("npm:@nredd/pi-computer-use@0.5.2", "../../packages/computer-use"),
        ("npm:pi-memory@0.4.2", "npm:pi-memory@0.4.2"),
        ("npm:@gotgenes/pi-anthropic-auth@3.4.3", "npm:@gotgenes/pi-anthropic-auth@3.4.3"),
        ("git:github.com/someone/pi-subagents@v1.0.0", "git:github.com/someone/pi-subagents@v1.0.0"),
    ],
)
def test_localize_source_maps_only_owned_identities(source: str, local: str) -> None:
    """Pin the owned-package and fork mappings with literal inputs, independent of the stacks.

    Parameters:
        source (str): personal stack source.
        local (str): expected local development source.
    """
    assert localize_source(source) == local


def test_semantic_validators_reject_tampered_stack_documents() -> None:
    """Exercise the shipped and release validators without literal package pin tables."""
    personal = Stack.model_validate(stack_document(name="personal", sources=["npm:@nredd/pi-preset@0.2.0"]))
    with pytest.raises(ValueError, match="local path"):
        validate_shipped_stack(Stack.model_validate(stack_document(name="personal")))
    with pytest.raises(ValueError, match="does not match Gitlink tag"):
        validate_release_identity(personal, "v1.3.0-nredd.6", {})
    wrong = {release_asset_url("v1.3.0-nredd.7", "good.tgz"): "0" * 64}
    with pytest.raises(ValueError, match="integrity does not match"):
        validate_release_identity(personal, "v1.3.0-nredd.7", wrong)


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
                "schema_version": 1,
                "name": "fixture",
                "core": CORE,
                "sources": ["npm:one@1.2.3", "git:github.com/x/two@v1.2.3"],
                "settings": {"quietStartup": True},
                "disabled_extensions": {"git:github.com/x/two@v1.2.3": "GUI needs TCC"},
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
    assert box.settings()["packages"][-1] == {"source": "git:github.com/x/two@v1.2.3", "extensions": []}
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
        "git:github.com/x/y@v1.2.3",
    ]
    stack_path = tmp_path / "stack.json"
    stack_path.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "name": "filtered",
                "core": CORE,
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
    subagents = json.loads((box.agent_dir / "subagents.json").read_text())
    assert subagents == {"workflowsEnabled": False, "packageAgents": False}
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


def test_package_agents_gate_follows_filtered_sources_not_stack_name() -> None:
    """A filtered object source disables package agents under any name; plain strings do not."""
    plain = Stack.model_validate(stack_document(name="personal", sources=["npm:@scope/pkg@1.2.3"]))
    filtered = Stack.model_validate(
        stack_document(name="renamed", sources=[PackageSource(source="npm:@scope/pkg@1.2.3", skills=[])])
    )
    assert sandbox.subagents_policy(plain) == {"workflowsEnabled": False}
    assert sandbox.subagents_policy(filtered) == {"workflowsEnabled": False, "packageAgents": False}
