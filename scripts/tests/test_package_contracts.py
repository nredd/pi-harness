"""Test the package-contract tooling against real npm tarballs and a real HTTP provider.

The Pi-driven scenarios need stock Pi and run through `make check-package-contracts`; these tests
cover the audits and the scripted provider with real inputs and the failure paths that gate relies on.

References:
    https://docs.npmjs.com/cli/v11/commands/npm-pack
"""

from __future__ import annotations

import io
import json
import shutil
import sys
import tarfile
import urllib.error
import urllib.request
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import faux_provider as fp
import package_contracts as pc

DEV_TOOLS = pc.CONTRACTS[0]
ROOT_LICENSE = (pc.REPO_ROOT / "LICENSE").read_bytes()


def make_tarball(path: Path, files: dict[str, bytes]) -> Path:
    """Write an npm-shaped tarball (`package/` prefix).

    Parameters:
        path (Path): Destination.
        files (dict[str, bytes]): Paths relative to the package root and their content.

    Returns:
        Path: `path`.
    """
    with tarfile.open(path, "w:gz") as tar:
        for name, data in files.items():
            info = tarfile.TarInfo(f"package/{name}")
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    return path


@pytest.fixture
def sandbox(tmp_path: Path) -> pc.Sandbox:
    """Sandbox with real tools under a temporary root.

    Parameters:
        tmp_path (Path): Pytest temporary directory.

    Returns:
        pc.Sandbox: Scrubbed environment.
    """
    return pc.Sandbox(tmp_path / "sandbox", pc.locate_tools())


def test_sandbox_env_is_scrubbed(sandbox: pc.Sandbox, monkeypatch: pytest.MonkeyPatch) -> None:
    """No ambient credential or config location may leak into child processes.

    Parameters:
        sandbox (pc.Sandbox): Sandbox under test.
        monkeypatch (pytest.MonkeyPatch): Injects ambient secrets.
    """
    monkeypatch.setenv("ANTHROPIC_API_KEY", "secret")
    monkeypatch.setenv("OPENAI_API_KEY", "secret")
    monkeypatch.setenv("NODE_OPTIONS", "--require=/tmp/evil.js")
    monkeypatch.setenv("PI_PACKAGE_DIR", "/live")
    env = sandbox.env()
    assert not {k for k in env if k.endswith("_API_KEY")}
    assert env["HOME"].startswith(str(sandbox.root))
    assert env["PI_CODING_AGENT_DIR"] == str(sandbox.agent_dir)
    assert env["PI_OFFLINE"] == "1"
    assert env["HTTPS_PROXY"] == pc.DEAD_PROXY
    assert "127.0.0.1" in env["NO_PROXY"]
    state_keys = ("HOME", "TMPDIR", "TMP", "TEMP", "CODEX_HOME", "npm_config_cache", "PI_CODING_AGENT_DIR")
    state_keys += tuple(k for k in env if k.startswith("XDG_"))
    assert all(Path(env[k]).is_relative_to(sandbox.root) for k in state_keys)
    assert set(env) <= {
        *state_keys,
        "PATH",
        "LANG",
        "PI_OFFLINE",
        "PI_SKIP_VERSION_CHECK",
        "PI_TELEMETRY",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "NO_PROXY",
        "GIT_CONFIG_GLOBAL",
        "GIT_CONFIG_NOSYSTEM",
        "npm_config_userconfig",
        "npm_config_globalconfig",
        "npm_config_update_notifier",
    }


def test_run_rejects_relative_executable(tmp_path: Path) -> None:
    """Commands resolve through absolute paths only.

    Parameters:
        tmp_path (Path): Pytest temporary directory.
    """
    with pytest.raises(ValueError, match="absolute path"):
        pc.run(["node", "--version"], env={}, cwd=tmp_path, timeout=5)


def test_run_reports_nonzero_exit(tmp_path: Path) -> None:
    """A failing child surfaces its streams.

    Parameters:
        tmp_path (Path): Pytest temporary directory.
    """
    with pytest.raises(pc.ContractError, match="exited 3"):
        pc.run([Path("/bin/sh"), "-c", "echo boom >&2; exit 3"], env={}, cwd=tmp_path, timeout=5)


@pytest.mark.parametrize(
    ("source", "expected"),
    [
        ('import { a } from "node:fs";', ["node:fs"]),
        ('import type { T } from "@earendil-works/pi-ai";', ["@earendil-works/pi-ai"]),
        ('import {\n  a,\n  b,\n} from "./x.ts";', ["./x.ts"]),
        ('export * from "../y.js";', ["../y.js"]),
        ('import "side-effect";', ["side-effect"]),
        ('const m = await import("lazy");', ["lazy"]),
        ('const r = require("cjs");', ["cjs"]),
        ('// "ssh itself failed", which also exits 255.\nconst s = "from \\"x\\"";', []),
    ],
)
def test_import_specifiers(source: str, expected: list[str]) -> None:
    """Static, dynamic, and CommonJS imports are found; comments and strings are not.

    Parameters:
        source (str): JS or TS text.
        expected (list[str]): Specifiers that must be found.
    """
    assert list(pc.import_specifiers(source)) == expected


@pytest.mark.parametrize(
    ("path", "source", "needle"),
    [
        ("src/a.ts", 'import x from "@nredd/pi-session-kit";', "sibling plugin"),
        ("src/a.ts", 'import x from "left-pad";', "neither a Node builtin nor a host module"),
        ("src/a.ts", 'import x from "fs";', "neither a Node builtin nor a host module"),
        ("src/a.ts", 'import x from "../../outside.ts";', "leaves the package"),
        ("src/a.ts", 'import x from "./missing.ts";', "leaves the package or is missing"),
        ("dist/cli.mjs", 'import x from "typebox";', "standalone artifact"),
    ],
)
def test_audit_imports_rejects(path: str, source: str, needle: str) -> None:
    """Sibling, third-party, escaping, and non-standalone imports are all violations.

    Parameters:
        path (str): Packed file path.
        source (str): File text.
        needle (str): Substring the violation must contain.
    """
    problems = pc.audit_imports(path, source, ["src/a.ts", "src/b.ts", "dist/cli.mjs"])
    assert len(problems) == 1
    assert needle in problems[0]


def test_audit_imports_accepts_host_builtin_and_js_to_ts() -> None:
    """Host modules (including subpaths), builtins, and `.js` specifiers resolving to `.ts` pass."""
    source = (
        'import { Type } from "typebox";\n'
        'import { x } from "@earendil-works/pi-coding-agent/hooks";\n'
        'import { spawn } from "node:child_process";\n'
        'import { y } from "./b.js";\n'
    )
    assert pc.audit_imports("src/a.ts", source, ["src/a.ts", "src/b.ts"]) == []


def test_audit_files_flags_leaks_and_gaps() -> None:
    """Fixtures, tests, dev config and missing required files are all reported."""
    files = ["README.md", "package.json", "src/index.ts", "test/a.test.ts", "biome.json", "src/x.test.snap"]
    problems = pc.audit_files(DEV_TOOLS, files)
    assert "missing required file 'LICENSE'" in problems
    assert "unexpected file 'test/a.test.ts'" in problems
    assert "unexpected file 'biome.json'" in problems
    assert "unexpected file 'src/x.test.snap'" in problems


def test_audit_license(tmp_path: Path) -> None:
    """Missing and divergent licenses fail; the identical one passes.

    Parameters:
        tmp_path (Path): Pytest temporary directory.
    """
    good = make_tarball(tmp_path / "good.tgz", {"LICENSE": ROOT_LICENSE})
    changed = make_tarball(tmp_path / "changed.tgz", {"LICENSE": ROOT_LICENSE + b"x"})
    absent = make_tarball(tmp_path / "absent.tgz", {"package.json": b"{}"})
    assert pc.audit_license(good, ROOT_LICENSE) == []
    assert "differs" in pc.audit_license(changed, ROOT_LICENSE)[0]
    assert "no 'LICENSE'" in pc.audit_license(absent, ROOT_LICENSE)[0]


def good_manifest() -> dict[str, object]:
    """A manifest satisfying every `dev-tools` rule.

    Returns:
        dict[str, object]: Parsed manifest.
    """
    return {
        "name": "@nredd/pi-dev-tools",
        "private": True,
        "license": "MIT",
        "peerDependencies": {"@earendil-works/pi-coding-agent": "*", "typebox": "*"},
        "pi": {"extensions": ["./src/index.ts"]},
    }


def test_audit_manifest_accepts_good() -> None:
    """The reference manifest has no findings."""
    assert pc.audit_manifest(DEV_TOOLS, good_manifest(), ["src/index.ts"]) == []


@pytest.mark.parametrize(
    ("mutation", "needle"),
    [
        ({"private": False}, "`private`"),
        ({"license": "ISC"}, "`license`"),
        ({"dependencies": {"typebox": "1.0.0"}}, "`dependencies` must be empty"),
        ({"optionalDependencies": {"@nredd/pi-session-kit": "*"}}, "`optionalDependencies`"),
        ({"peerDependencies": {"@nredd/pi-session-kit": "*"}}, "not a host module"),
        ({"peerDependencies": {"typebox": ">=1"}}, "must use the range '*'"),
        ({"pi": {"extensions": []}}, "`pi.extensions` is empty"),
        ({"pi": {"extensions": ["./src/missing.ts"]}}, "not in the tarball"),
        ({"name": "@nredd/other"}, "expected '@nredd/pi-dev-tools'"),
    ],
)
def test_audit_manifest_rejects(mutation: dict[str, object], needle: str) -> None:
    """Each independence or publication-safety rule is enforced.

    Parameters:
        mutation (dict[str, object]): Fields overriding the good manifest.
        needle (str): Substring a violation must contain.
    """
    problems = pc.audit_manifest(DEV_TOOLS, good_manifest() | mutation, ["src/index.ts"])
    assert any(needle in problem for problem in problems), problems


@pytest.mark.parametrize("contract", pc.CONTRACTS, ids=lambda c: c.directory)
def test_real_workspace_tarballs_pass_audit(
    contract: pc.PackageContract, tmp_path: Path, sandbox: pc.Sandbox
) -> None:
    """The real `npm pack` output of every workspace package satisfies the static audit.

    Parameters:
        contract (pc.PackageContract): Package to pack.
        tmp_path (Path): Pytest temporary directory.
        sandbox (pc.Sandbox): Scrubbed environment.
    """
    artifact = pc.pack(contract, tmp_path, sandbox)
    assert pc.audit_tarball(artifact, ROOT_LICENSE) == []
    assert (
        artifact.version
        == json.loads((pc.REPO_ROOT / "packages" / contract.directory / "package.json").read_text())[
            "version"
        ]
    )
    assert artifact.integrity.startswith("sha512-")


def test_pack_without_allowlist_is_rejected(tmp_path: Path, sandbox: pc.Sandbox) -> None:
    """The original leak: no `files` allowlist and no license ships tests and dev config.

    Parameters:
        tmp_path (Path): Pytest temporary directory.
        sandbox (pc.Sandbox): Scrubbed environment.
    """
    source = tmp_path / "dev-tools"
    shutil.copytree(
        pc.REPO_ROOT / "packages" / "dev-tools",
        source,
        ignore=shutil.ignore_patterns("node_modules", "LICENSE"),
    )
    manifest = json.loads((source / "package.json").read_text())
    del manifest["files"]
    (source / "package.json").write_text(json.dumps(manifest))
    (tmp_path / "out").mkdir()
    artifact = pc.pack(DEV_TOOLS, tmp_path / "out", sandbox, source)
    problems = pc.audit_tarball(artifact, ROOT_LICENSE)
    assert "missing required file 'LICENSE'" in problems
    assert any("unexpected file 'test/" in p for p in problems)
    assert "unexpected file 'biome.json'" in problems
    assert "unexpected file 'tsconfig.json'" in problems


def test_install_alone_has_no_host_copy(tmp_path: Path, sandbox: pc.Sandbox) -> None:
    """A real tarball installs by itself: no host module, no lockfile extras.

    Parameters:
        tmp_path (Path): Pytest temporary directory.
        sandbox (pc.Sandbox): Scrubbed environment.
    """
    artifact = pc.pack(DEV_TOOLS, tmp_path, sandbox)
    installed = pc.install_alone(artifact, sandbox, tmp_path / "project")
    assert (installed / "src" / "index.ts").is_file()
    assert not (tmp_path / "project" / "node_modules" / "@earendil-works").exists()
    assert not (tmp_path / "project" / "node_modules" / "typebox").exists()


def test_parse_events() -> None:
    """Strict JSONL framing: blank lines skipped, junk and non-objects rejected."""
    assert pc.parse_events('{"a": 1}\n\n{"b": 2}\n') == ({"a": 1}, {"b": 2})
    with pytest.raises(pc.ContractError, match="Non-JSON"):
        pc.parse_events("not json\n")
    with pytest.raises(pc.ContractError, match="Non-object"):
        pc.parse_events("[1]\n")


def test_pirun_helpers() -> None:
    """Tool results and assistant messages are extracted from event streams."""
    events = (
        {
            "type": "tool_execution_end",
            "toolName": "t",
            "result": {"content": [{"type": "text", "text": "hi"}]},
        },
        {"type": "tool_execution_end", "toolName": "u", "result": {"content": []}},
        {"type": "message_end", "message": {"role": "assistant", "model": "m"}},
        {"type": "message_end", "message": {"role": "user"}},
    )
    result = pc.PiRun(0, events, "", "")
    assert [pc.tool_text(r) for r in result.tool_results("t")] == ["hi"]
    assert result.assistant_messages() == [{"role": "assistant", "model": "m"}]


def test_require_tools_flags_missing_and_sibling() -> None:
    """The package's own tools must be declared and a sibling's must not be."""
    result = pc.PiRun(0, (), "", "")
    siblings = tuple(c for c in pc.CONTRACTS if c is not DEV_TOOLS)
    pc.require_tools(
        result, DEV_TOOLS, siblings, [fp.RecordedRequest("m", ("system",), ("read", "git_status"))]
    )
    with pytest.raises(pc.ContractError, match="declared"):
        pc.require_tools(result, DEV_TOOLS, siblings, [fp.RecordedRequest("m", ("system",), ("read",))])
    with pytest.raises(pc.ContractError, match="sibling tools"):
        pc.require_tools(
            result,
            DEV_TOOLS,
            siblings,
            [fp.RecordedRequest("m", ("system",), ("git_status", "monitor_start"))],
        )
    with pytest.raises(pc.ContractError, match="no request"):
        pc.require_tools(result, DEV_TOOLS, siblings, [])


def post(url: str, body: dict[str, object], path: str = "/chat/completions") -> str:
    """POST JSON to the provider and return the SSE body.

    Parameters:
        url (str): Provider base URL.
        body (dict[str, object]): Chat-completions request.
        path (str): Path under the base URL.

    Returns:
        str: Decoded response.
    """
    request = urllib.request.Request(
        f"{url}{path}",
        data=json.dumps(body).encode(),
        headers={"content-type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        return response.read().decode()


def test_faux_provider_replays_script_and_records_requests() -> None:
    """Turns are chosen by assistant-message count; the last repeats; requests are recorded."""
    tool = {"type": "function", "function": {"name": "git_status"}}
    with fp.FauxProvider([fp.ToolStep("git_status", {"a": 1}), fp.TextStep("done")]) as provider:
        first = post(provider.base_url, {"model": "m", "messages": [{"role": "user"}], "tools": [tool]})
        second = post(
            provider.base_url,
            {
                "model": "m",
                "messages": [{"role": "user"}, {"role": "assistant"}, {"role": "tool"}],
                "tools": [tool],
            },
        )
        third = post(provider.base_url, {"model": "m", "messages": [{"role": "assistant"}] * 5})
    assert '"name": "git_status"' in first
    assert '\\"a\\": 1' in first
    assert '"finish_reason": "tool_calls"' in first
    assert '"content": "done"' in second
    assert second.endswith("data: [DONE]\n\n")
    assert '"content": "done"' in third
    assert [r.model for r in provider.requests] == ["m", "m", "m"]
    assert provider.requests[0].tools == ("git_status",)
    assert provider.requests[1].roles == ("user", "assistant", "tool")


def test_faux_provider_rejects_empty_script_and_unknown_path() -> None:
    """An empty script is a caller bug; other paths 404."""
    with pytest.raises(ValueError, match="at least one step"):
        fp.FauxProvider([])
    with fp.FauxProvider([fp.TextStep("x")]) as provider, pytest.raises(urllib.error.HTTPError) as info:
        post(provider.base_url, {}, "/nope")
    assert info.value.code == 404


def test_models_json_registers_provider() -> None:
    """The rendered `models.json` carries a dummy key and the requested models."""
    document = json.loads(fp.models_json("http://127.0.0.1:1/v1", "local", ["m", "n"]))
    provider = document["providers"]["local"]
    assert provider["api"] == "openai-completions"
    assert provider["apiKey"] == fp.PROVIDER_API_KEY
    assert [m["id"] for m in provider["models"]] == ["m", "n"]


def test_main_refuses_nonempty_work_dir(tmp_path: Path) -> None:
    """A reused scratch directory is a usage error, reported before any work.

    Parameters:
        tmp_path (Path): Pytest temporary directory.
    """
    (tmp_path / "stale").write_text("x")
    assert pc.main(["--work-dir", str(tmp_path)]) == 2
