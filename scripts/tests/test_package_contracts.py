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
from pydantic import ValidationError

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
        ("const m = await import(`@nredd/pi-session-kit`);", ["@nredd/pi-session-kit"]),
        ('import fs = require("fs-eq");', ["fs-eq"]),
        ('type T = import("typed").T;', ["typed"]),
        ('// "ssh itself failed", which also exits 255.\nconst s = "from \\"x\\"";', []),
        ('// import x from "@nredd/pi-session-kit";\nconst s = \'require("@nredd/x")\';', []),
    ],
)
def test_scan_imports(source: str, expected: list[str]) -> None:
    """Static, dynamic, and CommonJS imports are found; comments and strings are not.

    Parameters:
        source (str): JS or TS text.
        expected (list[str]): Specifiers that must be found.
    """
    found = pc.scan_imports({"src/a.ts": source}, pc.locate_executable("node"))["src/a.ts"]
    assert found.specifiers == expected
    assert found.diagnostics == []


def test_scan_imports_batches_files() -> None:
    """One helper run answers for every file, keyed by the original path."""
    found = pc.scan_imports(
        {"src/a.ts": 'import "a";', "dist/b.mjs": 'import("b");'}, pc.locate_executable("node")
    )
    assert {name: imports.specifiers for name, imports in found.items()} == {
        "src/a.ts": ["a"],
        "dist/b.mjs": ["b"],
    }


@pytest.mark.parametrize("name", ["../escape.ts", "/abs.ts", ""])
def test_scan_imports_rejects_unsafe_paths(name: str) -> None:
    """Tarball paths that could leave the scratch directory never reach the helper.

    Parameters:
        name (str): Hostile path.
    """
    with pytest.raises(pc.ContractError, match="Unsafe source path"):
        pc.scan_imports({name: ""}, pc.locate_executable("node"))


@pytest.mark.parametrize(
    "source",
    [
        "const m = import(`@nredd/${name}`);",
        'const m = import("@nredd/" + name);',
        "const m = import(name);",
        "const m = require(name);",
        "const m = require(`@nredd/${name}`);",
        "const m = cond ? import(a) : import(b);",
        "type T = import(`@nredd/${name}`).T;",
    ],
)
def test_audit_imports_rejects_computed_specifiers(source: str) -> None:
    """A specifier the gate cannot read is a violation with a file:line:col location, never skipped.

    Parameters:
        source (str): JS or TS text with a non-literal specifier.
    """
    problems = pc.audit_imports("src/a.ts", source, ["src/a.ts"])
    assert problems
    assert all(p.startswith("src/a.ts:") and "not a string literal" in p for p in problems), problems


@pytest.mark.parametrize(
    "source",
    [
        "const m = await import(`@nredd/pi-session-kit`);",
        'const m = await import("@nredd/pi-session-kit");',
        'const m = require("@nredd/pi-session-kit");',
        'export * from "@nredd/pi-session-kit";',
        'type T = import("@nredd/pi-session-kit").T;',
    ],
)
def test_audit_imports_rejects_sibling_in_every_form(source: str) -> None:
    """Sibling plugin imports are caught in unexercised, non-static branches too.

    Parameters:
        source (str): JS or TS text importing the sibling.
    """
    problems = pc.audit_imports("src/a.ts", source, ["src/a.ts"])
    assert len(problems) == 1
    assert "sibling plugin" in problems[0]


def test_audit_imports_ignores_import_text_in_comments_and_strings() -> None:
    """Text that merely looks like an import is not one."""
    source = (
        '// import x from "@nredd/pi-session-kit";\n'
        '/* require("@nredd/pi-session-kit") */\n'
        "const s = `import('@nredd/pi-session-kit')`;\n"
        'import { ok } from "node:fs";\n'
    )
    assert pc.audit_imports("src/a.ts", source, ["src/a.ts"]) == []


def test_audit_imports_rejects_computed_import_equals() -> None:
    """`import x = require(<expression>)` is not valid syntax, so it is rejected as a syntax error."""
    problems = pc.audit_imports("src/a.ts", 'import x = require("a" + b);', ["src/a.ts"])
    assert any("syntax error" in p for p in problems), problems


def test_audit_imports_reports_syntax_errors() -> None:
    """A file that does not parse cannot be trusted to list every import."""
    problems = pc.audit_imports("src/a.ts", 'import "node:fs";\nconst = ;\n', ["src/a.ts"])
    assert any(p.startswith("src/a.ts:2:") and "syntax error" in p for p in problems), problems


@pytest.mark.parametrize(
    ("path", "source", "needle"),
    [
        ("src/a.ts", 'import x from "@nredd/pi-session-kit";', "sibling plugin"),
        ("src/a.ts", 'import x from "left-pad";', "neither a Node builtin nor a host module"),
        ("src/a.ts", 'import x from "fs";', "neither a Node builtin nor a host module"),
        ("src/a.ts", 'import x from "../../outside.ts";', "leaves the package"),
        ("src/a.ts", 'import x from "./missing.ts";', "leaves the package or is missing"),
        ("dist/cli.mjs", 'import x from "typebox";', "standalone artifact"),
        ("dist/cli.mjs", 'import x from "../src/b.ts";', "standalone artifact"),
        ("dist/cli.mjs", 'import x from "./cli.mjs";', "standalone artifact"),
        ("dist/cli.mjs", 'export * from "../src/b.ts";', "standalone artifact"),
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
        "publishConfig": {"access": "public"},
        "license": "MIT",
        "peerDependencies": {"@earendil-works/pi-coding-agent": "*", "typebox": "*"},
        "pi": {"extensions": ["./src/index.ts"]},
    }


def test_audit_manifest_rejects_missing_publish_config() -> None:
    """A manifest with no `publishConfig` at all is not publishable."""
    manifest = good_manifest()
    del manifest["publishConfig"]
    problems = pc.audit_manifest(DEV_TOOLS, manifest, ["src/index.ts"])
    assert any("`publishConfig.access` must be `public`" in problem for problem in problems), problems


def test_audit_manifest_accepts_good() -> None:
    """The reference manifest has no findings."""
    assert pc.audit_manifest(DEV_TOOLS, good_manifest(), ["src/index.ts"]) == []


@pytest.mark.parametrize(
    ("mutation", "needle"),
    [
        ({"private": True}, "`private` must be absent or `false`"),
        ({"publishConfig": {"access": "restricted"}}, "`publishConfig.access` must be `public`"),
        ({"publishConfig": {}}, "`publishConfig.access` must be `public`"),
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


def test_audit_manifest_accepts_false_private() -> None:
    """An explicit false `private` value remains publishable."""
    assert pc.audit_manifest(DEV_TOOLS, good_manifest() | {"private": False}, ["src/index.ts"]) == []


@pytest.mark.parametrize(
    ("mutation", "field"),
    [
        ({"peerDependencies": []}, "peerDependencies"),
        ({"peerDependencies": "typebox"}, "peerDependencies"),
        ({"peerDependencies": {"typebox": 1}}, "peerDependencies.typebox"),
        ({"peerDependencies": None}, "peerDependencies"),
        ({"pi": None}, "pi"),
        ({"pi": "src/index.ts"}, "pi"),
        ({"pi": []}, "pi"),
        ({"pi": {"extensions": "./src/index.ts"}}, "pi.extensions"),
        ({"pi": {"extensions": [1]}}, "pi.extensions.0"),
        ({"pi": {"extensions": None}}, "pi.extensions"),
        ({"dependencies": []}, "dependencies"),
        ({"optionalDependencies": "x"}, "optionalDependencies"),
        ({"bundledDependencies": "yes"}, "bundledDependencies.list[str]"),
        ({"bundleDependencies": {"a": 1}}, "bundleDependencies.list[str]"),
        ({"private": "true"}, "private"),
        ({"private": None}, "private"),
        ({"publishConfig": "public"}, "publishConfig"),
        ({"publishConfig": {"access": True}}, "publishConfig.access"),
        ({"license": 1}, "license"),
        ({"name": 5}, "name"),
    ],
)
def test_audit_manifest_rejects_malformed_fields(mutation: dict[str, object], field: str) -> None:
    """A malformed audited field is a clear diagnostic, never a silent pass or a crash.

    Parameters:
        mutation (dict[str, object]): Malformed fields overriding the good manifest.
        field (str): Dotted field path the diagnostic must name.
    """
    problems = pc.audit_manifest(DEV_TOOLS, good_manifest() | mutation, ["src/index.ts"])
    assert any(f"`{field}`" in problem and "malformed" in problem for problem in problems), problems


@pytest.mark.parametrize("manifest", [[], "x", None, 3])
def test_audit_manifest_rejects_non_object(manifest: object) -> None:
    """A manifest that is not a JSON object is reported, not crashed on.

    Parameters:
        manifest (object): Non-object JSON value.
    """
    problems = pc.audit_manifest(DEV_TOOLS, manifest, ["src/index.ts"])
    assert any("malformed" in problem for problem in problems), problems


def test_audit_manifest_ignores_unaudited_npm_metadata() -> None:
    """Unknown or unaudited npm fields of any shape are explicitly ignored."""
    extra = {"scripts": 1, "keywords": "x", "files": {"a": 1}, "repository": [], "x-custom": None}
    assert pc.audit_manifest(DEV_TOOLS, good_manifest() | extra, ["src/index.ts"]) == []
    assert pc.audit_manifest(DEV_TOOLS, good_manifest() | {"bundledDependencies": []}, ["src/index.ts"]) == []
    assert any(
        "bundledDependencies" in p
        for p in pc.audit_manifest(
            DEV_TOOLS, good_manifest() | {"bundledDependencies": True}, ["src/index.ts"]
        )
    )


def test_audit_tarball_reports_unparseable_manifest(tmp_path: Path) -> None:
    """Invalid JSON in the packed manifest is a violation, not a traceback.

    Parameters:
        tmp_path (Path): Pytest temporary directory.
    """
    tarball = make_tarball(tmp_path / "bad.tgz", {"LICENSE": ROOT_LICENSE, "package.json": b"{nope"})
    artifact = pc.PackedArtifact(
        DEV_TOOLS, tarball, "1.0.0", "sha512-x", "0" * 40, 1, ("LICENSE", "package.json")
    )
    problems = pc.audit_tarball(artifact, ROOT_LICENSE)
    assert any("`package.json` is not valid JSON" in problem for problem in problems), problems


@pytest.mark.parametrize("contract", [*pc.CONTRACTS, pc.PRESET_CONTRACT], ids=lambda c: c.directory)
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


INTEGRITY = "sha512-" + "A" * 86 + "=="


PINNED = {
    "package": pc.STOCK_PI_PACKAGE,
    "version": pc.STOCK_PI_VERSION,
    "integrity": pc.STOCK_PI_INTEGRITY,
}
GOOD_ENTRY: dict[str, object] = {
    "version": "0.3.0",
    "tarball": "nredd-pi-dev-tools-0.3.0.tgz",
    "integrity": INTEGRITY,
    "shasum": "a" * 40,
    "size": 1234,
    "files": ["LICENSE", "package.json"],
    "evidence": {"tool": "git_status", "untracked": ["untracked.txt"], "failure_path": "not a repo"},
}


def good_report(packages: dict[str, object] | None = None) -> dict[str, object]:
    """Build a report that satisfies every schema rule.

    Parameters:
        packages (dict[str, object] | None): Package entries; defaults to the dev-tools entry.

    Returns:
        dict[str, object]: Raw report as `run_gate` assembles it.
    """
    return {
        "stock_pi": PINNED,
        "node": "v26.12.0",
        "npm": "11.20.0",
        "license_sha256": "b" * 64,
        "packages": packages or {"@nredd/pi-dev-tools": GOOD_ENTRY},
    }


def with_entry(**changes: object) -> dict[str, object]:
    """Return `good_report()` with fields of the dev-tools package entry replaced.

    Parameters:
        **changes (object): Entry fields to replace.

    Returns:
        dict[str, object]: Raw report.
    """
    return good_report({"@nredd/pi-dev-tools": GOOD_ENTRY | changes})


def test_validate_report_accepts_good_and_round_trips() -> None:
    """A well-formed report keeps its meaning and key order through serialization."""
    report = pc.validate_report(good_report())
    assert json.loads(pc.serialize_report(report)) == good_report()
    assert list(json.loads(pc.serialize_report(report))) == list(good_report())


def test_validate_report_accepts_every_scenario_evidence() -> None:
    """Each package takes only its own evidence shape."""
    packages: dict[str, object] = {
        "@nredd/pi-dev-tools": GOOD_ENTRY,
        "@nredd/pi-session-kit": GOOD_ENTRY
        | {
            "tarball": "nredd-pi-session-kit-0.3.0.tgz",
            "evidence": {"tools": ["monitor_start", "monitor_read"], "monitor_line": "x", "stats_shards": 1},
        },
        "@nredd/pi-subscription-router": GOOD_ENTRY
        | {
            "tarball": "nredd-pi-subscription-router-0.3.0.tgz",
            "evidence": {"virtual_model": "router/default", "dispatched": "local/m"},
        },
    }
    assert len(pc.validate_report(good_report(packages)).packages) == 3


@pytest.mark.parametrize(
    ("raw", "needle"),
    [
        (with_entry(integrity="sha512-short"), "integrity"),
        (with_entry(integrity="sha1-" + "A" * 27), "integrity"),
        (with_entry(shasum="XYZ"), "shasum"),
        (with_entry(size=0), "size"),
        (with_entry(version="latest"), "version"),
        (with_entry(tarball="../evil.tgz"), "tarball"),
        (with_entry(tarball="nredd-pi-dev-tools-9.9.9.tgz"), "is not"),
        (with_entry(files=[]), "files"),
        (with_entry(files=["a", "a"]), "duplicate files"),
        (with_entry(evidence={"tool": "git_status", "untracked": [], "failure_path": "x"}), "untracked"),
        (with_entry(evidence={"tool": "git_status", "untracked": ["a"], "failure_path": ""}), "failure_path"),
        (
            with_entry(evidence={"tool": "git_status", "untracked": ["a"], "failure_path": "x", "extra": 1}),
            "extra",
        ),
        (with_entry(evidence={"tool": "monitor_start"}), "evidence"),
        (
            with_entry(evidence={"virtual_model": "router/default", "dispatched": "local/m"}),
            "evidence",
        ),
    ],
)
def test_validate_report_rejects_malformed_identity_and_evidence(raw: dict[str, object], needle: str) -> None:
    """Bad artifact identity or evidence shapes fail at the serialization boundary.

    Parameters:
        raw (dict[str, object]): Report with one malformed field.
        needle (str): Substring the error must contain.
    """
    with pytest.raises(pc.ContractError, match="Report failed validation") as excinfo:
        pc.validate_report(raw)
    assert needle in str(excinfo.value)


@pytest.mark.parametrize(
    "changes",
    [
        {"node": "latest"},
        {"license_sha256": "abc"},
        {"packages": {}},
        {"unexpected": 1},
        {"stock_pi": PINNED | {"version": "1.3.1"}},
        {"stock_pi": PINNED | {"integrity": INTEGRITY}},
        {"packages": {"@nredd/pi-unknown": GOOD_ENTRY}},
    ],
)
def test_validate_report_rejects_malformed_top_level(changes: dict[str, object]) -> None:
    """Top-level identity, pins and package names are enforced.

    Parameters:
        changes (dict[str, object]): Top-level fields to corrupt.
    """
    with pytest.raises(pc.ContractError, match="Report failed validation"):
        pc.validate_report(good_report() | changes)


def test_evidence_typed_dicts_match_models() -> None:
    """The scenario return shapes and the validated models describe the same fields."""
    pairs = {
        pc.DevToolsEvidence: pc.DevToolsEvidenceModel,
        pc.SessionKitEvidence: pc.SessionKitEvidenceModel,
        pc.RouterEvidence: pc.RouterEvidenceModel,
    }
    for shape, model in pairs.items():
        assert set(shape.__annotations__) == set(model.model_fields)


def test_pack_rejects_digest_mismatch(tmp_path: Path, sandbox: pc.Sandbox) -> None:
    """`npm pack` identity that disagrees with the tarball bytes is rejected.

    Parameters:
        tmp_path (Path): Pytest temporary directory.
        sandbox (pc.Sandbox): Scrubbed environment.
    """
    tarball = make_tarball(
        tmp_path / "fixture.tgz", {"package.json": json.dumps({"name": "x", "version": "1.0.0"}).encode()}
    )
    payload = tmp_path / "payload.json"
    payload.write_text(
        json.dumps(
            [
                {
                    "filename": "x-1.0.0.tgz",
                    "integrity": INTEGRITY,
                    "shasum": "a" * 40,
                    "files": [{"path": "package.json"}],
                }
            ]
        )
    )
    fake_npm = tmp_path / "npm"
    fake_npm.write_text(f'#!/bin/sh\ncp "{tarball}" "$5/x-1.0.0.tgz"\ncat "{payload}"\n')
    fake_npm.chmod(0o755)
    liar = pc.Sandbox(tmp_path / "liar", pc.Tools(sandbox.tools.node, fake_npm, sandbox.tools.git))
    (tmp_path / "out").mkdir()
    with pytest.raises(pc.ContractError, match="disagrees with the tarball bytes"):
        pc.pack(DEV_TOOLS, tmp_path / "out", liar, tmp_path)


def test_npm_pack_entry_rejects_malformed_identity() -> None:
    """Malformed `npm pack --json` identity never becomes an artifact."""
    with pytest.raises(ValidationError):
        pc.NpmPackEntry.model_validate({"filename": "x.tgz", "integrity": "nope", "shasum": "a", "files": []})


# --- stats protocol boundaries --------------------------------------------------------------------

MACHINE_ID = "123e4567-e89b-42d3-a456-426614174000"
MONTH = "2026-09"
SHARD_HASH = "a" * 64


def good_stats_manifest() -> dict[str, object]:
    """A manifest matching `docs/stats-snapshots.md`.

    Returns:
        dict[str, object]: Parsed manifest.
    """
    return {
        "version": 1,
        "machineId": MACHINE_ID,
        "label": "Pi machine",
        "exportedAt": 1_790_000_000_000,
        "shards": [{"month": MONTH, "file": f"{MONTH}-{SHARD_HASH}.json", "sha256": SHARD_HASH, "bytes": 10}],
    }


def test_stats_manifest_accepts_documented_shape() -> None:
    """The documented manifest validates and `parse_stats_json` round-trips it."""
    parsed = pc.parse_stats_json(pc.StatsManifest, json.dumps(good_stats_manifest()), "manifest")
    assert parsed.machineId == MACHINE_ID
    assert len(parsed.shards) == 1


@pytest.mark.parametrize(
    "mutation",
    [
        {"shards": MONTH},
        {"shards": "abc"},
        {"shards": {"a": 1}},
        {"shards": [MONTH]},
        {"shards": None},
        {"version": 2},
        {"version": True},
        {"version": "1"},
        {"machineId": "nope"},
        {"machineId": MACHINE_ID.upper()},
        {"label": ""},
        {"label": "x" * 1025},
        {"label": 3},
        {"exportedAt": 0},
        {"exportedAt": "1"},
        {"exportedAt": 1.5},
        {"extra": 1},
    ],
)
def test_stats_manifest_rejects_malformed(mutation: dict[str, object]) -> None:
    """Malformed manifest field types and values fail with a `ContractError`.

    Parameters:
        mutation (dict[str, object]): Fields overriding the good manifest.
    """
    with pytest.raises(pc.ContractError, match="Malformed stats manifest"):
        pc.parse_stats_json(pc.StatsManifest, json.dumps(good_stats_manifest() | mutation), "manifest")


@pytest.mark.parametrize(
    "ref",
    [
        {"month": "2026-13", "file": f"2026-13-{SHARD_HASH}.json", "sha256": SHARD_HASH, "bytes": 1},
        {"month": MONTH, "file": "other.json", "sha256": SHARD_HASH, "bytes": 1},
        {"month": MONTH, "file": f"{MONTH}-{SHARD_HASH}.json", "sha256": "A" * 64, "bytes": 1},
        {"month": MONTH, "file": f"{MONTH}-{SHARD_HASH}.json", "sha256": SHARD_HASH, "bytes": -1},
        {"month": MONTH, "file": f"{MONTH}-{SHARD_HASH}.json", "sha256": SHARD_HASH, "bytes": "1"},
        {
            "month": MONTH,
            "file": f"{MONTH}-{SHARD_HASH}.json",
            "sha256": SHARD_HASH,
            "bytes": 128 * 1024**2 + 1,
        },
        {"month": MONTH, "file": f"{MONTH}-{SHARD_HASH}.json", "sha256": SHARD_HASH},
        {"month": MONTH, "file": f"../{MONTH}-{SHARD_HASH}.json", "sha256": SHARD_HASH, "bytes": 1},
    ],
)
def test_stats_manifest_rejects_malformed_shard_reference(ref: dict[str, object]) -> None:
    """Shard references enforce month, file/hash identity, and byte bounds.

    Parameters:
        ref (dict[str, object]): Malformed shard reference.
    """
    raw = json.dumps(good_stats_manifest() | {"shards": [ref]})
    with pytest.raises(pc.ContractError, match="Malformed stats manifest"):
        pc.parse_stats_json(pc.StatsManifest, raw, "manifest")


def test_stats_manifest_rejects_duplicate_months() -> None:
    """Each manifest references exactly one shard per month."""
    ref = {"month": MONTH, "file": f"{MONTH}-{SHARD_HASH}.json", "sha256": SHARD_HASH, "bytes": 10}
    raw = json.dumps(good_stats_manifest() | {"shards": [ref, ref]})
    with pytest.raises(pc.ContractError, match="duplicate month"):
        pc.parse_stats_json(pc.StatsManifest, raw, "manifest")


@pytest.mark.parametrize("raw", ["", "not json", "[]", "null", '"x"', "1"])
def test_stats_json_rejects_non_objects(raw: str) -> None:
    """Non-object and unparseable stdout is a `ContractError`.

    Parameters:
        raw (str): Raw stdout text.
    """
    with pytest.raises(pc.ContractError, match="Malformed stats export"):
        pc.parse_stats_json(pc.StatsExportResult, raw, "export")


@pytest.mark.parametrize(
    "raw",
    [
        {"machineId": MACHINE_ID},
        {"machineId": MACHINE_ID, "snapshotDir": ""},
        {"machineId": MACHINE_ID, "snapshotDir": 1},
        {"machineId": "x", "snapshotDir": "/a"},
        {"machineId": MACHINE_ID, "snapshotDir": "/a", "extra": 1},
    ],
)
def test_stats_export_result_rejects_malformed(raw: dict[str, object]) -> None:
    """The export response keeps exactly `machineId` and `snapshotDir`.

    Parameters:
        raw (dict[str, object]): Malformed response.
    """
    with pytest.raises(pc.ContractError, match="Malformed stats export"):
        pc.parse_stats_json(pc.StatsExportResult, json.dumps(raw), "export")


GOOD_IMPORT = {"imported": 1, "retained": 0, "problems": [], "importedAt": 1_790_000_000_000}


def test_stats_import_result_accepts_documented_shape() -> None:
    """The documented import response validates."""
    parsed = pc.parse_stats_json(pc.StatsImportResult, json.dumps(GOOD_IMPORT), "import")
    assert (parsed.imported, parsed.retained, parsed.problems) == (1, 0, [])


@pytest.mark.parametrize(
    "mutation",
    [
        {"imported": "1"},
        {"imported": True},
        {"imported": 1.5},
        {"imported": -1},
        {"retained": "0"},
        {"problems": "none"},
        {"problems": [1]},
        {"problems": None},
        {"importedAt": "x"},
        {"importedAt": -1},
        {"extra": 1},
    ],
)
def test_stats_import_result_rejects_malformed(mutation: dict[str, object]) -> None:
    """String counts, non-list problems and other type confusion are rejected.

    Parameters:
        mutation (dict[str, object]): Fields overriding the good response.
    """
    with pytest.raises(pc.ContractError, match="Malformed stats import"):
        pc.parse_stats_json(pc.StatsImportResult, json.dumps(GOOD_IMPORT | mutation), "import")


def test_stats_import_result_missing_field() -> None:
    """A response lacking a field fails instead of defaulting."""
    raw = {k: v for k, v in GOOD_IMPORT.items() if k != "problems"}
    with pytest.raises(pc.ContractError, match="Malformed stats import"):
        pc.parse_stats_json(pc.StatsImportResult, json.dumps(raw), "import")


def write_stats_session(agent_dir: Path) -> None:
    """Write one real-format Pi session with a single assistant usage record.

    Parameters:
        agent_dir (Path): Agent directory receiving `sessions/`.
    """
    path = agent_dir / "sessions" / "project" / "s.jsonl"
    path.parent.mkdir(parents=True)
    header = {
        "type": "session",
        "version": 3,
        "id": "fixture-session",
        "timestamp": "2026-09-30T12:00:00.000Z",
    }
    usage = {
        "input": 5,
        "output": 2,
        "cacheRead": 0,
        "cacheWrite": 0,
        "totalTokens": 7,
        "cost": {"total": 0.01},
    }
    assistant = {
        "type": "message",
        "id": "entry-1",
        "timestamp": "2026-09-30T12:00:01.000Z",
        "message": {
            "role": "assistant",
            "content": [{"type": "text", "text": "hi"}],
            "api": "x",
            "provider": "local",
            "model": "m",
            "usage": usage,
            "stopReason": "stop",
            "timestamp": 1_790_000_001_000,
        },
    }
    path.write_text("\n".join(json.dumps(line) for line in (header, assistant)) + "\n")


DIST_ARTIFACT = pc.REPO_ROOT / "packages" / "session-kit" / "dist" / "pi-stats-export.mjs"


def test_standalone_stats_artifact_over_real_fixture_session(tmp_path: Path, sandbox: pc.Sandbox) -> None:
    """The exact built bytes export and import a real-format session from an isolated directory.

    Parameters:
        tmp_path (Path): Pytest temporary directory.
        sandbox (pc.Sandbox): Scrubbed environment.
    """
    write_stats_session(sandbox.agent_dir)
    manifest = pc.exercise_stats_artifact(
        sandbox.tools.node, DIST_ARTIFACT.read_bytes(), sandbox.env(), sandbox.agent_dir, tmp_path / "work"
    )
    assert len(manifest.shards) == 1
    copied = tmp_path / "work" / "standalone" / "pi-stats-export.mjs"
    assert copied.read_bytes() == DIST_ARTIFACT.read_bytes()
    assert [p.name for p in copied.parent.iterdir()] == ["pi-stats-export.mjs"]


def test_standalone_stats_artifact_cannot_reach_package_siblings(tmp_path: Path, sandbox: pc.Sandbox) -> None:
    """A relative import into the package passes in place but fails in the isolated copy.

    Parameters:
        tmp_path (Path): Pytest temporary directory.
        sandbox (pc.Sandbox): Scrubbed environment.
    """
    package = tmp_path / "package"
    (package / "src").mkdir(parents=True)
    (package / "dist").mkdir()
    (package / "src" / "index.ts").write_text("export const x = 1;\n")
    tampered = b'import "../src/index.ts";\n' + DIST_ARTIFACT.read_bytes()
    (package / "dist" / "pi-stats-export.mjs").write_bytes(tampered)
    write_stats_session(sandbox.agent_dir)
    in_place = pc.run(
        [
            sandbox.tools.node,
            package / "dist" / "pi-stats-export.mjs",
            "export",
            "--agent-dir",
            sandbox.agent_dir,
            "--output",
            tmp_path / "out",
        ],
        env=sandbox.env(),
        cwd=tmp_path,
        timeout=60,
        check=False,
    )
    assert in_place.returncode == 0, in_place.stderr
    with pytest.raises(pc.ContractError, match="exited"):
        pc.exercise_stats_artifact(
            sandbox.tools.node, tampered, sandbox.env(), sandbox.agent_dir, tmp_path / "work"
        )


def test_tool_text_rejects_malformed_result() -> None:
    """Malformed Pi tool results are a `ContractError`, not a `KeyError`."""
    with pytest.raises(pc.ContractError, match="Malformed tool result"):
        pc.tool_text({"toolName": "t", "result": {"content": "oops"}})
    with pytest.raises(pc.ContractError, match="Malformed tool result"):
        pc.tool_text({"toolName": "t"})


def test_read_lockfile_rejects_malformed(tmp_path: Path) -> None:
    """A lockfile that is not the npm shape is a `ContractError`.

    Parameters:
        tmp_path (Path): Pytest temporary directory.
    """
    path = tmp_path / "package-lock.json"
    for text in ("{nope", "[]", '{"packages": []}', '{"packages": {"": {"version": 1}}}', "{}"):
        path.write_text(text)
        with pytest.raises(pc.ContractError, match="lockfile"):
            pc.read_lockfile(path)
    path.write_text('{"packages": {"": {}, "node_modules/x": {"version": "1.0.0", "other": []}}}')
    assert set(pc.read_lockfile(path).packages) == {"", "node_modules/x"}


@pytest.mark.parametrize(
    "body",
    [
        b"not json",
        b"[]",
        b"null",
        b'{"model": "m", "messages": {}}',
        b'{"model": "m", "messages": [null]}',
        b'{"model": "m", "messages": [{"role": 1}]}',
        b'{"model": "m", "tools": [{}]}',
        b'{"model": "m", "tools": [{"function": null}]}',
        b'{"model": "m", "tools": "x"}',
        b'{"messages": []}',
        b'{"model": 3}',
    ],
)
def test_faux_provider_answers_malformed_request_with_400(body: bytes) -> None:
    """Malformed consumed request shapes get an HTTP diagnostic and are never recorded.

    Parameters:
        body (bytes): Raw request body.
    """
    with fp.FauxProvider([fp.TextStep("x")]) as provider:
        request = urllib.request.Request(f"{provider.base_url}/chat/completions", data=body, method="POST")
        with pytest.raises(urllib.error.HTTPError) as info:
            urllib.request.urlopen(request, timeout=10)
        assert info.value.code == 400
        assert "malformed chat request" in info.value.reason
        assert provider.requests == []


def test_faux_provider_rejects_bad_content_length() -> None:
    """A non-numeric `Content-Length` is a 400, not a dropped connection."""
    with fp.FauxProvider([fp.TextStep("x")]) as provider:
        request = urllib.request.Request(
            f"{provider.base_url}/chat/completions", data=b"{}", headers={"content-length": "abc"}
        )
        with pytest.raises(urllib.error.HTTPError) as info:
            urllib.request.urlopen(request, timeout=10)
        assert info.value.code == 400


@pytest.mark.parametrize(
    "event",
    [
        {"type": "message_end", "message": None},
        {"type": "message_end", "message": []},
        {"type": "message_end"},
        {"type": "message_end", "message": {"role": 1}},
        {"type": "message_end", "message": {"role": "assistant", "provider": 3}},
    ],
)
def test_assistant_messages_rejects_malformed_events(event: dict[str, object]) -> None:
    """A `message_end` without an object message is a diagnostic, not an `AttributeError`.

    Parameters:
        event (dict[str, object]): Malformed event.
    """
    with pytest.raises(pc.ContractError, match="Malformed `message_end`"):
        pc.PiRun(0, (event,), "", "").assistant_messages()


def test_single_tool_result_and_is_error() -> None:
    """Exactly one tool record is required and `isError` must be a real boolean."""
    ok = {"type": "tool_execution_end", "toolName": "t", "isError": False, "result": {"content": []}}
    run = pc.PiRun(0, (ok,), "", "")
    assert run.single_tool_result("t") is ok
    assert pc.tool_is_error(ok) is False
    with pytest.raises(pc.ContractError, match="exactly one `u`"):
        run.single_tool_result("u")
    with pytest.raises(pc.ContractError, match="exactly one `t`"):
        pc.PiRun(0, (ok, ok), "", "").single_tool_result("t")
    for bad in ({"toolName": "t"}, {"toolName": "t", "isError": "false"}, {"toolName": "t", "isError": None}):
        with pytest.raises(pc.ContractError, match="Malformed tool result"):
            pc.tool_is_error(bad)


def preset_manifest() -> dict[str, object]:
    """A manifest satisfying the preset contract, including its multi-license expression.

    Returns:
        dict[str, object]: Parsed manifest.
    """
    return good_manifest() | {
        "name": "@nredd/pi-preset",
        "license": "MIT AND Apache-2.0 AND CC-BY-SA-4.0",
        "peerDependencies": {"@earendil-works/pi-coding-agent": "*", "@earendil-works/pi-tui": "*"},
        "pi": {"extensions": ["./extensions/expanded-footer.ts"]},
    }


def test_preset_contract_accounts_for_separately_licensed_assets() -> None:
    """The preset must declare the full license expression; plugins stay MIT-only."""
    files = ["extensions/expanded-footer.ts"]
    assert pc.audit_manifest(pc.PRESET_CONTRACT, preset_manifest(), files) == []
    mit_only = pc.audit_manifest(pc.PRESET_CONTRACT, preset_manifest() | {"license": "MIT"}, files)
    assert any("MIT AND Apache-2.0 AND CC-BY-SA-4.0" in problem for problem in mit_only), mit_only
    leaked = pc.audit_manifest(DEV_TOOLS, good_manifest() | {"license": preset_manifest()["license"]}, files)
    assert any("`license` must be 'MIT'" in problem for problem in leaked), leaked


def test_preset_is_not_a_standalone_plugin_contract() -> None:
    """The standalone gate keeps exactly its three plugins; the preset is consumed by the fork gate."""
    assert [c.directory for c in pc.CONTRACTS] == ["dev-tools", "session-kit", "subscription-router"]
    assert pc.PRESET_CONTRACT not in pc.CONTRACTS
    assert set(pc.SCENARIOS) == {c.directory for c in pc.CONTRACTS}


@pytest.mark.parametrize(
    "files",
    [
        ["LICENSE", "package.json", "README.md"],
        list(pc.PRESET_CONTRACT.required[:-1]),
    ],
)
def test_preset_audit_requires_notice_and_license_texts(files: list[str]) -> None:
    """Dropping `NOTICE.md`, a license text or a theme is a missing-file violation.

    Parameters:
        files (list[str]): File list lacking required content.
    """
    problems = pc.audit_files(pc.PRESET_CONTRACT, files)
    assert any("missing required file" in problem for problem in problems), problems


def test_preset_audit_rejects_unlisted_files() -> None:
    """Tests, fixtures and config do not ship in the preset tarball."""
    problems = pc.audit_files(pc.PRESET_CONTRACT, [*pc.PRESET_CONTRACT.required, "test/x.ts", "biome.json"])
    assert "unexpected file 'test/x.ts'" in problems
    assert "unexpected file 'biome.json'" in problems


def chat(role: str, text: str | list[dict[str, object]] | None) -> dict[str, object]:
    """Build one chat message.

    Parameters:
        role (str): Message role.
        text (str | list[dict[str, object]] | None): Content, a list of parts, or `None`.

    Returns:
        dict[str, object]: Message.
    """
    return {"role": role, "content": text}


def test_faux_routes_pick_a_script_by_user_marker_and_index_it_independently() -> None:
    """A marked conversation gets its own script and turn indexing; others keep the default."""
    routes = [fp.Route("MARK-A", [fp.TextStep("route a")]), fp.Route("MARK-B", [fp.TextStep("route b")])]
    tool = {"type": "function", "function": {"name": "git_log"}}
    with fp.FauxProvider([fp.ToolStep("Agent"), fp.TextStep("parent done")], routes) as provider:
        parent_first = post(
            provider.base_url,
            {"model": "m", "messages": [chat("system", "S"), chat("user", "go")], "tools": []},
        )
        child = post(
            provider.base_url,
            {
                "model": "m",
                "messages": [
                    chat("system", "child system"),
                    chat("user", [{"type": "text", "text": "MARK-B x"}]),
                ],
                "tools": [tool],
            },
        )
        parent_second = post(
            provider.base_url,
            {
                "model": "m",
                "messages": [
                    chat("system", "S"),
                    chat("user", "go"),
                    chat("assistant", None),
                    chat("tool", "tool output that says MARK-A"),
                ],
            },
        )
    assert '"name": "Agent"' in parent_first
    assert '"content": "route b"' in child
    assert '"content": "parent done"' in parent_second
    first, second, third = provider.requests
    assert (first.route, second.route, third.route) == (None, "MARK-B", None)
    assert second.tools == ("git_log",)
    assert second.system == "child system"
    assert third.roles == ("system", "user", "assistant", "tool")


def test_faux_records_tool_results_in_order() -> None:
    """`tool` messages (string or parts) are recorded as text, in order, for later assertions."""
    with fp.FauxProvider([fp.TextStep("x")]) as provider:
        post(
            provider.base_url,
            {
                "model": "m",
                "messages": [
                    chat("user", "hi"),
                    chat("tool", "first"),
                    chat("tool", [{"type": "text", "text": "sec"}, {"type": "text", "text": "ond"}]),
                    chat("assistant", None),
                ],
            },
        )
    assert provider.requests[0].tool_results == ("first", "second")


def test_faux_routes_ignore_markers_outside_user_messages() -> None:
    """Only user text selects a route: tool output and assistant text echoing it must not."""
    with fp.FauxProvider([fp.TextStep("default")], [fp.Route("MARK", [fp.TextStep("routed")])]) as provider:
        body = post(
            provider.base_url,
            {"model": "m", "messages": [chat("user", "hi"), chat("assistant", "MARK"), chat("tool", "MARK")]},
        )
    assert '"content": "default"' in body
    assert provider.requests[0].route is None


def test_faux_routes_first_matching_route_wins() -> None:
    """With two markers present, routes are tried in the order given."""
    routes = [fp.Route("ONE", [fp.TextStep("one")]), fp.Route("TWO", [fp.TextStep("two")])]
    with fp.FauxProvider([fp.TextStep("default")], routes) as provider:
        body = post(provider.base_url, {"model": "m", "messages": [chat("user", "TWO then ONE")]})
    assert '"content": "one"' in body


def test_faux_routes_reject_bad_definitions() -> None:
    """Empty markers, empty scripts and duplicate markers are caller bugs."""
    with pytest.raises(ValueError, match="marker"):
        fp.Route("", [fp.TextStep("x")])
    with pytest.raises(ValueError, match="at least one step"):
        fp.Route("M", [])
    with pytest.raises(ValueError, match="duplicate route markers"):
        fp.FauxProvider(
            [fp.TextStep("x")], [fp.Route("M", [fp.TextStep("a")]), fp.Route("M", [fp.TextStep("b")])]
        )


@pytest.mark.parametrize(
    "content",
    [5, {"text": "x"}, [5], [{"text": 3}], [None]],
)
def test_faux_provider_rejects_malformed_message_content(content: object) -> None:
    """Newly consumed `messages[].content` is validated: a mistyped value is a 400, never recorded.

    Parameters:
        content (object): Malformed content value.
    """
    body = json.dumps({"model": "m", "messages": [{"role": "user", "content": content}]}).encode()
    with fp.FauxProvider([fp.TextStep("x")]) as provider:
        request = urllib.request.Request(f"{provider.base_url}/chat/completions", data=body, method="POST")
        with pytest.raises(urllib.error.HTTPError) as info:
            urllib.request.urlopen(request, timeout=10)
        assert info.value.code == 400
        assert provider.requests == []


def test_faux_provider_records_system_and_developer_text() -> None:
    """The recorded `system` text joins `system` and `developer` messages in order."""
    with fp.FauxProvider([fp.TextStep("x")]) as provider:
        post(
            provider.base_url,
            {
                "model": "m",
                "messages": [chat("developer", "D"), chat("system", [{"type": "text", "text": "S"}])],
            },
        )
    assert provider.requests[0].system == "D\nS"
