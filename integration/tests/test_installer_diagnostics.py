"""Prove proxy redaction and detached exception graphs at every installer child boundary.

References:
- https://docs.python.org/3/library/traceback.html#traceback.format_exception
- https://docs.python.org/3/library/logging.html#logging.Logger.debug
- https://docs.python.org/3/library/urllib.parse.html#urllib.parse.unquote
"""

from __future__ import annotations

import ast
import hashlib
import io
import logging
import subprocess
import sys
import traceback
from dataclasses import dataclass
from functools import partial
from operator import index
from pathlib import Path
from typing import TYPE_CHECKING, Never, override
from urllib.parse import quote, unquote

import pytest

from harness import install, release
from harness.install import verify_release, verify_snapshot
from tests.test_install import SHA, Harness, shim_core_tarball

if TYPE_CHECKING:
    from collections.abc import Callable
    from typing import Self, SupportsIndex

LOGGER = logging.getLogger(__name__)
SCANNER_WORK_PER_CHARACTER = 12
SCANNER_WORK_ALLOWANCE = 64
BOUNDARIES = (
    "node",
    "pi-install",
    "post-check",
    "gitlink",
    "gh",
    "npm-core",
    "snapshot",
    "core-verification",
    "core-stage",
    "apply",
    "kept-version",
    "no-op",
    "release-cli",
)
PROXY_CASES = (
    ("http://user:p%40ss@proxy.invalid:8080", "http://proxy.invalid:8080"),
    ("http://user:p%3Ass@proxy.invalid", "http://proxy.invalid"),
    ("http://user:p%2Fss@proxy.invalid", "http://proxy.invalid"),
    ("http://user:p%25ss@proxy.invalid", "http://proxy.invalid"),
    ("http://us%C3%A9r:p%C3%A4ssword@proxy.invalid", "http://proxy.invalid"),
    ("user:p%40ss@proxy.invalid:8080", "proxy.invalid:8080"),
    ("http://user:p%40ss@[::1]:8080", "http://[::1]:8080"),
    ("HTTP://user:p%40ss@proxy.invalid", "HTTP://proxy.invalid"),
    ("http://us%3Aer:p%40ss@proxy.invalid", "http://proxy.invalid"),
)


RAW_CHAIN_ALLOWLIST = {
    "install.py": {
        "required_node": (1, "Local core-tar manifest reads and schema parsing"),
        "download": (2, "Already-detached FetchError and local destination writes"),
        "verify_snapshot": (1, "Snapshot JSON/schema validation after attestation"),
        "verify_release": (1, "Local core-asset digest comparison, not provenance subprocess"),
        "read_json": (1, "Local settings JSON parsing"),
        "read_regular": (1, "Local regular-file admission"),
        "require_restorable_kind": (1, "Local restore-layout admission"),
        "consent": (1, "Prompt EOF conversion"),
        "read_journal": (2, "Local journal open and JSON parsing"),
        "load_journal": (1, "Local journal validation"),
        "check_restore_step": (2, "Local restore identity and missing-backup checks"),
        "rollback": (1, "Local filesystem rollback failures"),
        "install_packages": (1, "Staged local manifest/identity validation AFTER subprocesses"),
        "locked": (3, "Local filesystem/lock admission"),
    },
    "release.py": {
        "release_checksums": (2, "Already-detached FetchError and UTF-8 decoding"),
        "attestation_bundle": (3, "Already-detached fetch status wrappers and JSON parsing"),
        "_read_json_object": (1, "Local manifest/lock JSON reads"),
    },
}


@dataclass(frozen=True)
class FailureBoundary:
    """Describe one installer operation and the exception type it publicly promises.

    Parameters:
        action (Callable[[], object]): operation that reaches a synthetic child failure.
        error_type (type[BaseException]): expected public domain error or CLI exit.

    Returns:
        FailureBoundary: immutable test operation and failure contract.

    Raises:
        TypeError: required constructor arguments are missing.
    """

    action: Callable[[], object]
    error_type: type[BaseException]


@pytest.fixture(autouse=True)
def isolate_diagnostic_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep real proxy credentials and CA paths out of all diagnostic fixtures.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): scoped environment isolation.

    Returns:
        None: tests can observe only explicitly configured synthetic transport values.

    Raises:
        OSError: the process environment cannot be modified.
    """
    for key in release.CONNECTIVITY_ENVIRONMENT_KEYS:
        monkeypatch.delenv(key, raising=False)


def prepare_boundary(
    name: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, underlying: Exception, proxy: str
) -> FailureBoundary:
    """Reach a direct child boundary or an operation that wraps a child's domain error.

    Parameters:
        name (str): boundary from the explicit installer failure inventory.
        tmp_path (Path): private harness roots and fixture binaries.
        monkeypatch (pytest.MonkeyPatch): scoped failure and network seams.
        underlying (Exception): raw OSError, process failure or timeout containing credentials.
        proxy (str): synthetic proxy URL included in an upstream domain error.

    Returns:
        FailureBoundary: callable failure path and its expected public exception type.

    Raises:
        AssertionError: the no-op fixture cannot be installed before failure injection.
        ValueError: an unknown boundary name is requested.
    """
    harness = Harness(tmp_path, monkeypatch)
    tool = tmp_path / "tool"
    tool.touch()

    def failed_child(*args: object, **kwargs: object) -> Never:
        """Raise the raw synthetic child error without running an external program.

        Parameters:
            *args (object): unused subprocess positional arguments.
            **kwargs (object): unused subprocess options.

        Returns:
            Never: this failure seam never returns.

        Raises:
            OSError | subprocess.SubprocessError: the selected raw child failure.
        """
        raise underlying

    def failed_operation(*args: object, **kwargs: object) -> Never:
        """Simulate a child domain error retaining an unsafe underlying exception graph.

        Parameters:
            *args (object): unused operation positional arguments.
            **kwargs (object): unused operation options.

        Returns:
            Never: this failure seam never returns.

        Raises:
            install.InstallError | RuntimeError: a domain wrapper with a raw child cause/context.
        """
        wrapper = install.InstallError if name in {"apply", "kept-version", "no-op"} else RuntimeError
        try:
            raise underlying
        except Exception as error:
            raise wrapper(f"Child operation failed at '{proxy}'") from error

    # Prepare a true healthy no-op before intercepting subprocesses.
    if name == "no-op":
        assert harness.run() == install.ExitCode.OK
        monkeypatch.setattr(install, "checked_version", failed_operation)
        return FailureBoundary(harness.run, install.InstallError)
    monkeypatch.setattr(subprocess, "check_output", failed_child)
    tarball = shim_core_tarball()
    monkeypatch.setattr(release, "fetch_bytes", lambda request: tarball)
    checksums = {
        url: hashlib.sha256(tarball).hexdigest()
        for url in release.release_package_urls("v1.3.0-nredd.7").values()
    }
    direct = {
        "node": FailureBoundary(partial(install.node_version, str(tool)), install.UnsupportedError),
        "pi-install": FailureBoundary(
            partial(install.install_packages, harness.verified, tool, tmp_path / "staging"),
            install.InstallError,
        ),
        "post-check": FailureBoundary(partial(install.post_check, harness.layout), install.InstallError),
        "gitlink": FailureBoundary(partial(release.gitlink_tag, tmp_path), RuntimeError),
        "gh": FailureBoundary(
            partial(
                release.verify_attestation, tmp_path / "asset", "repo", "workflow", "ref", gh_bin=str(tool)
            ),
            RuntimeError,
        ),
        "npm-core": FailureBoundary(
            partial(
                release.fetch_release,
                "v1.3.0-nredd.7",
                tmp_path / "prefix",
                checksums=checksums,
                npm_bin=str(tool),
            ),
            RuntimeError,
        ),
    }
    if name in direct:
        return direct[name]
    if name == "snapshot":
        monkeypatch.setattr(install, "download", lambda url, path: path)
        monkeypatch.setattr(install, "verify_public_attestation", failed_operation)
        boundary = FailureBoundary(partial(verify_snapshot, SHA, tmp_path), install.VerificationError)
    elif name == "core-verification":
        monkeypatch.setattr(install, "verify_core_assets", failed_operation)
        boundary = FailureBoundary(
            partial(verify_release, harness.snapshot, str(tool), tmp_path), install.VerificationError
        )
    elif name == "core-stage":
        monkeypatch.setattr(install, "fetch_release", failed_operation)
        plan = install.plan_install(harness.layout, harness.verified)
        boundary = FailureBoundary(
            partial(install.stage, harness.layout, harness.verified, plan, tmp_path / "staging"),
            install.InstallError,
        )
    elif name == "apply":
        monkeypatch.setattr(install, "stage", lambda *args, **kwargs: None)
        monkeypatch.setattr(install, "switch", lambda *args, **kwargs: None)
        monkeypatch.setattr(install, "checked_version", failed_operation)
        plan = install.plan_install(harness.layout, harness.verified)
        boundary = FailureBoundary(
            partial(install.apply, harness.layout, harness.verified, plan), install.InstallError
        )
    elif name == "kept-version":
        monkeypatch.setattr(install, "post_check", failed_operation)
        boundary = FailureBoundary(
            partial(
                install.checked_version, harness.layout, harness.layout.core(harness.snapshot.stack.core.tag)
            ),
            install.InstallError,
        )
    elif name == "release-cli":
        monkeypatch.setattr(release, "verify_root_overrides", failed_operation)
        monkeypatch.setattr(sys, "argv", ["release", "--verify-root-overrides"])
        boundary = FailureBoundary(release.main, SystemExit)
    else:
        raise ValueError(f"Unknown fixture boundary: '{name}'")
    return boundary


def rendered_failure(boundary: FailureBoundary, renderer: str) -> tuple[str, BaseException]:
    """Use unmodified standard traceback/logging renderers, not the production sanitizer.

    Parameters:
        boundary (FailureBoundary): operation and expected public error contract.
        renderer (str): traceback or logging output to return.

    Returns:
        tuple[str, BaseException]: rendered public text and the public exception graph root.

    Raises:
        AssertionError: the operation does not raise its expected error.
    """
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    LOGGER.addHandler(handler)

    def invoke() -> object:
        """Capture real `exc_info=True` logging while an operation's exception is active.

        Returns:
            object: the operation's successful return value, unexpected for these fixtures.

        Raises:
            BaseException: the original public operation error after logging it.
        """
        try:
            return boundary.action()
        except BaseException:
            LOGGER.error("Child boundary failed", exc_info=True)
            raise

    try:
        with pytest.raises(boundary.error_type) as caught:
            invoke()
    finally:
        LOGGER.removeHandler(handler)
    error = caught.value
    text = stream.getvalue() if renderer == "logging" else "".join(traceback.format_exception(error))
    return text, error


@pytest.mark.parametrize("name", BOUNDARIES)
@pytest.mark.parametrize("renderer", ["traceback", "logging"])
@pytest.mark.parametrize("kind", ["os", "process", "timeout"])
def test_every_child_error_boundary_detaches_raw_causes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, name: str, renderer: str, kind: str
) -> None:
    """Every direct/transitive child wrapper detaches credential-bearing underlying errors.

    Parameters:
        tmp_path (Path): private installer roots and fixture binaries.
        monkeypatch (pytest.MonkeyPatch): scoped child failures and proxy environment.
        name (str): installer/release child-error boundary.
        renderer (str): standard traceback or `exc_info=True` logging.
        kind (str): underlying OSError, process failure or timeout.

    Returns:
        None: public messages, causes and contexts contain no original credential-bearing errors.

    Raises:
        AssertionError: a wrapper leaks a URL, keeps raw context or changes its error contract.
    """
    proxy = "http://boundary-user:boundary-password@proxy.invalid:8080"
    monkeypatch.setenv("HTTPS_PROXY", proxy)
    underlying = {
        "os": OSError(f"Transport failed using '{proxy}'"),
        "process": subprocess.CalledProcessError(1, ["tool", proxy], output=proxy),
        "timeout": subprocess.TimeoutExpired(["tool", proxy], 1, output=proxy),
    }[kind]
    boundary = prepare_boundary(name, tmp_path, monkeypatch, underlying, proxy)
    text, error = rendered_failure(boundary, renderer)
    assert "boundary-user" not in text
    assert "boundary-password" not in text
    assert "proxy.invalid:8080" in text
    assert error is not underlying
    assert error.__context__ is None
    assert error.__cause__ is not None
    assert error.__cause__ is not underlying
    assert error.__cause__.__context__ is None
    assert error.__cause__.__cause__ is None
    if isinstance(error, SystemExit):
        assert "boundary-user" not in str(error.code)
        assert "boundary-password" not in str(error.code)


@pytest.mark.parametrize(("proxy", "clean"), PROXY_CASES)
@pytest.mark.parametrize("decoded", [False, True])
@pytest.mark.parametrize("schemeless", [False, True])
def test_known_proxy_encoded_decoded_and_schemeless_renderings(
    monkeypatch: pytest.MonkeyPatch, proxy: str, clean: str, decoded: bool, schemeless: bool
) -> None:
    """Known URL/authority renderings redact encoded or decoded credentials as a whole.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): scoped encoded proxy setting.
        proxy (str): encoded configured proxy, including Unicode and IPv6 cases.
        clean (str): independently specified public host URL.
        decoded (bool): whether the diagnostic percent-decodes the configured value.
        schemeless (bool): whether the diagnostic omits the URL scheme.

    Returns:
        None: only the expected host, scheme and port remain.

    Raises:
        AssertionError: any encoded/decoded userinfo survives or host identity changes.
    """
    monkeypatch.setenv("HTTPS_PROXY", proxy)
    value = unquote(proxy) if decoded else proxy
    expected = clean
    if schemeless:
        value = value.split("://", 1)[-1]
        expected = clean.split("://", 1)[-1]
    assert release.redact_diagnostic(f"proxy='{value}'") == f"proxy='{expected}'"


@pytest.mark.parametrize("proxy", [case[0] for case in PROXY_CASES])
@pytest.mark.parametrize("decoded", [False, True])
def test_known_userinfo_without_host_is_redacted(
    monkeypatch: pytest.MonkeyPatch, proxy: str, decoded: bool
) -> None:
    """A child that logs only configured userinfo cannot bypass complete-URL redaction.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): scoped encoded proxy URL.
        proxy (str): encoded configured proxy.
        decoded (bool): whether only the decoded userinfo is printed.

    Returns:
        None: the credential pair is replaced even without scheme, host or trailing `@`.

    Raises:
        AssertionError: a userinfo-only rendering remains visible.
    """
    monkeypatch.setenv("HTTPS_PROXY", proxy)
    credentials = proxy.split("://", 1)[-1].rsplit("@", 1)[0]
    if decoded:
        credentials = unquote(credentials)
    for value in (credentials, credentials + "@"):
        assert release.redact_diagnostic(f"userinfo='{value}'") == "userinfo='[redacted]'"


@pytest.mark.parametrize(
    "url",
    ["http://user:p@ss@proxy.invalid", "HTTP://user:p@ss@[::1]:8080", "http://user:p%40ss@proxy.invalid"],
)
def test_fallback_url_redaction_consumes_final_authority_at(url: str) -> None:
    """Unknown but valid authority renderings consume the final `@`, not password fragments.

    Parameters:
        url (str): URL not present in the known proxy environment.

    Returns:
        None: all userinfo is removed while host and original scheme survive.

    Raises:
        AssertionError: a decoded password fragment survives fallback matching.
    """
    scheme, authority = url.split("://", 1)
    assert release.redact_diagnostic(url) == scheme + "://" + authority.rsplit("@", 1)[-1]


@pytest.mark.parametrize(
    "secret", ["long-password", "long%40password", "pässword-long", "tiny", "x", "e", "a", "*", "_"]
)
def test_password_only_redaction_masks_every_occurrence(monkeypatch: pytest.MonkeyPatch, secret: str) -> None:
    """Every nonempty known password representation is masked, even inside unrelated words.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): scoped known proxy password.
        secret (str): encoded, Unicode, short or one-character configured password.

    Returns:
        None: plain, labeled and word-embedded occurrences never survive redaction.

    Raises:
        AssertionError: a length/boundary exclusion or a mask-character collision leaks a password.
    """
    monkeypatch.setenv("HTTPS_PROXY", f"http://user:{secret}@proxy.invalid")
    for value in list(
        dict.fromkeys((secret, unquote(secret), quote(secret, safe=""), quote(unquote(secret), safe="")))
    ):
        for message in (value, f"password='{value}'.", f"prefix{value}suffix"):
            assert value not in release.redact_diagnostic(message)


@pytest.mark.parametrize("module", ["test_installer_transport.py", "test_installer_diagnostics.py"])
def test_new_test_classes_fixtures_and_nested_helpers_have_contracts(module: str) -> None:
    """Sweep entire added test modules, including classes, fixtures and nested callbacks.

    Parameters:
        module (str): newly added installer test module to inspect in full.

    Returns:
        None: all definitions document typed inputs, returns and failure contracts.

    Raises:
        AssertionError: any class/helper/fixture/test lacks a required contract section.
    """
    tree = ast.parse(Path(__file__).with_name(module).read_text())
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            continue
        doc = ast.get_docstring(node) or ""
        for section in ("Returns:", "Raises:"):
            assert section in doc, (module, node.name, section)
        if isinstance(node, ast.ClassDef):
            assert "Parameters:" in doc, (module, node.name)
            continue
        arguments = [*node.args.posonlyargs, *node.args.args, *node.args.kwonlyargs]
        arguments += [arg for arg in (node.args.vararg, node.args.kwarg) if arg is not None]
        for arg in arguments:
            if arg.arg in {"self", "cls"}:
                continue
            assert arg.annotation is not None, (module, node.name, arg.arg)
            assert "Parameters:" in doc, (module, node.name)
            assert f"{arg.arg} (" in doc, (module, node.name, arg.arg)
        assert node.returns is not None, (module, node.name)


def test_existing_isolation_fixture_has_complete_contract() -> None:
    """Include the touched pre-existing fixture outside the whole-new-module sweep.

    Returns:
        None: synthetic environment isolation is documented with the complete typed form.

    Raises:
        AssertionError: its parameter, return or failure section is omitted.
    """
    tree = ast.parse(Path(__file__).with_name("test_install.py").read_text())
    fixture = next(
        node
        for node in tree.body
        if isinstance(node, ast.FunctionDef) and node.name == "isolate_connectivity"
    )
    doc = ast.get_docstring(fixture) or ""
    for section in ("Parameters:", "Returns:", "Raises:"):
        assert section in doc
    assert "monkeypatch (pytest.MonkeyPatch)" in doc


def assert_raw_chain_inventory(source: str, module: str) -> None:
    """Audit every named exception cause, with explicit non-child/already-safe reasons.

    Parameters:
        source (str): installer module source or an in-memory regression mutation.
        module (str): installer/release module selecting the audited exception inventory.

    Returns:
        None: every remaining named cause is a documented local-I/O/data or safe-fetch chain.

    Raises:
        AssertionError: a raw child wrapper is reintroduced or an unaudited cause is added.
    """
    tree = ast.parse(source)
    owners = {
        child: function.name
        for function in ast.walk(tree)
        if isinstance(function, ast.FunctionDef)
        for child in ast.walk(function)
    }
    found: dict[str, int] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Raise) and isinstance(node.cause, ast.Name):
            owner = owners.get(node, "<module>")
            found[owner] = found.get(owner, 0) + 1
    expected = RAW_CHAIN_ALLOWLIST[module]
    assert all(reason for count, reason in expected.values())
    assert found == {name: count for name, (count, reason) in expected.items()}


@pytest.mark.parametrize("module", ["install.py", "release.py"])
def test_all_named_exception_causes_have_nonchild_or_detached_reason(module: str) -> None:
    """Keep the complete from-error/from-exc/from-e audit explicit and regression-checked.

    Parameters:
        module (str): installer/release module to inspect in full.

    Returns:
        None: raw child-error chaining cannot return unnoticed at a new or existing boundary.

    Raises:
        AssertionError: a named exception cause is not covered by the audited inventory.
    """
    assert_raw_chain_inventory(Path(release.__file__).with_name(module).read_text(), module)


@pytest.mark.parametrize("module", ["install.py", "release.py"])
def test_chain_inventory_rejects_new_raw_child_wrapper(module: str) -> None:
    """Prove a raw chained-child wrapper fails the source audit in either module.

    Parameters:
        module (str): installer module receiving the in-memory raw-wrapper mutation.

    Returns:
        None: the audit rejects the unsafe operation without changing any actual source.

    Raises:
        AssertionError: a weakened audit accepts a newly chained raw child exception.
    """
    source = Path(release.__file__).with_name(module).read_text()
    mutation = (
        "\ndef raw_wrapper():\n    try:\n        child()\n"
        "    except OSError as error:\n        raise RuntimeError(str(error)) from error\n"
    )
    with pytest.raises(AssertionError):
        assert_raw_chain_inventory(source + mutation, module)


class CountedText(str):
    """Instrument logical string-search/read work without depending on wall-clock timing.

    Parameters:
        value (str): diagnostic input whose search/read spans should be counted.

    Returns:
        CountedText: string with mutable `work` recording touched characters/search spans.

    Raises:
        None: constructing from a valid string does not raise.
    """

    work: int

    def __new__(cls: type[Self], value: str) -> Self:
        """Initialize the immutable string and its logical operation counter.

        Parameters:
            value (str): diagnostic contents.

        Returns:
            Self: instrumented string with a zero counter.

        Raises:
            None: valid string construction does not raise.
        """
        result = super().__new__(cls, value)
        result.work = 0
        return result

    @override
    def __getitem__(self, key: SupportsIndex | slice, /) -> str:
        """Count indexed reads and copied slices while preserving native string semantics.

        Parameters:
            key (SupportsIndex | slice): character index or slice.

        Returns:
            str: native indexed character or copied slice.

        Raises:
            IndexError: a character index lies outside the string.
            TypeError: an index does not implement the indexing protocol.
            AssertionError: logical work exceeds the scanner's deterministic linear budget.
        """
        self.work += len(range(*key.indices(len(self)))) if isinstance(key, slice) else 1
        assert self.work <= SCANNER_WORK_PER_CHARACTER * len(self) + SCANNER_WORK_ALLOWANCE
        return super().__getitem__(key)

    @override
    def find(self, sub: str, start: SupportsIndex | None = 0, end: SupportsIndex | None = None) -> int:
        """Count the logical searched span up to the match, not an unsearched suffix.

        Parameters:
            sub (str): literal delimiter to locate.
            start (SupportsIndex | None): first search position.
            end (SupportsIndex | None): exclusive search limit.

        Returns:
            int: native match offset, or minus one.

        Raises:
            TypeError: the substring or indexing arguments have invalid types.
            AssertionError: rescanning growing suffixes exhausts the linear work budget.
        """
        begin = 0 if start is None else index(start)
        stop = len(self) if end is None else index(end)
        result = super().find(sub, begin, stop)
        lower, upper, _ = slice(begin, stop).indices(len(self))
        self.work += max(0, (result + len(sub) if result >= 0 else upper) - lower)
        assert self.work <= SCANNER_WORK_PER_CHARACTER * len(self) + SCANNER_WORK_ALLOWANCE
        return result


@pytest.mark.parametrize("atom", ["a", "a@", "http://"])
def test_large_redaction_input_has_linear_character_work(atom: str) -> None:
    """One/four-MiB adversarial diagnostics require linear search/read work, not regex retries.

    Parameters:
        atom (str): letters, repeated `a@` or repeated scheme delimiters.

    Returns:
        None: exact output and a deterministic linear operation bound hold at both sizes.

    Raises:
        AssertionError: the scanner is absent, revisits growing prefixes or changes plain text.
    """
    # Fail the old implementation before invoking its quadratic regex on a MiB of letters.
    assert "redact_url_userinfo" in vars(release)
    work: list[int] = []
    for size in (1024 * 1024, 4 * 1024 * 1024):
        value = (atom * (size // len(atom) + 1))[:size]
        counted = CountedText(value)
        assert release.redact_diagnostic(counted) == value
        assert size <= counted.work <= SCANNER_WORK_PER_CHARACTER * size + SCANNER_WORK_ALLOWANCE
        work.append(counted.work)
    assert work[1] <= 4 * work[0] + SCANNER_WORK_ALLOWANCE


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("http://http://user:p@ss@host/path", "http://http://host/path"),
        ("1http://user:pass@host", "1http://host"),
        ("123://user:pass@host", "123://user:pass@host"),
        (
            "http://host/path@user?query@value#fragment@value",
            "http://host/path@user?query@value#fragment@value",
        ),
        ("HTTP://user:pass@[::1]:8080?q=@not-userinfo", "HTTP://[::1]:8080?q=@not-userinfo"),
        ("http://user:p@host\u2003http://user:q@other", "http://host\u2003http://other"),
    ],
)
def test_linear_url_scanner_preserves_boundaries_and_nested_schemes(value: str, expected: str) -> None:
    """Preserve URL delimiter semantics while visiting nested schemes only once more.

    Parameters:
        value (str): unknown URL text, with no configured proxy credentials.
        expected (str): independently specified result after authority-only redaction.

    Returns:
        None: nested schemes, invalid prefixes, paths, queries and whitespace behave correctly.

    Raises:
        AssertionError: the linear scanner skips a credential or erases non-authority text.
    """
    assert release.redact_diagnostic(value) == expected


@pytest.mark.parametrize("secret", ["tiny", "x", "e", "a", "*", "p@ss", "p/ss", "päss"])
def test_successful_child_output_and_info_message_mask_all_password_occurrences(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture, secret: str
) -> None:
    """A successful real child cannot return a short/embedded password for INFO logging.

    Parameters:
        tmp_path (Path): private executable and installer roots.
        monkeypatch (pytest.MonkeyPatch): scoped known password and fixture home.
        caplog (pytest.LogCaptureFixture): INFO message payload capture.
        secret (str): literal password, including one-character and reserved/Unicode cases.

    Returns:
        None: returned version/output and logged message contain no password representations.

    Raises:
        AssertionError: post-check success or INFO logging exposes any configured password form.
    """
    encoded = quote(secret, safe="")
    monkeypatch.setenv("HTTPS_PROXY", f"http://user:{encoded}@proxy.invalid")
    harness = Harness(tmp_path, monkeypatch)
    child = tmp_path / "child"
    payload = f"password='{secret}' embedded=prefix{secret}suffix encoded={encoded}"
    child.write_text(f"#!{sys.executable}\nprint({payload!r})\n")
    child.chmod(0o700)
    harness.layout.link.parent.mkdir(parents=True, exist_ok=True)
    harness.layout.link.symlink_to(child)
    returned = install.post_check(harness.layout)
    with caplog.at_level(logging.INFO, logger=LOGGER.name):
        LOGGER.info(returned)
    assert caplog.messages == [returned]
    for value in list(dict.fromkeys((secret, encoded, quote(encoded, safe="")))):
        assert value not in returned
        assert value not in caplog.messages[0]


@pytest.mark.parametrize("renderer", ["traceback", "logging"])
@pytest.mark.parametrize("secret", ["tiny", "p@ss", "p/ss", "päss"])
def test_short_and_encoded_passwords_do_not_survive_exception_rendering(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, renderer: str, secret: str
) -> None:
    """Standard traceback/logging output and detached causes mask short embedded passwords.

    Parameters:
        tmp_path (Path): private child-boundary fixtures.
        monkeypatch (pytest.MonkeyPatch): scoped encoded password and OSError injection.
        renderer (str): standard traceback or `exc_info=True` logging.
        secret (str): short or reserved/Unicode literal password.

    Returns:
        None: standard renderers and every detached cause have no credential representation.

    Raises:
        AssertionError: a plain/encoded/embedded password survives in a cause or public text.
    """
    encoded = quote(secret, safe="")
    proxy = f"http://user:{encoded}@proxy.invalid"
    monkeypatch.setenv("HTTPS_PROXY", proxy)
    payload = f"password='{secret}', embedded=prefix{secret}suffix, encoded={encoded}"
    boundary = prepare_boundary("node", tmp_path, monkeypatch, OSError(payload), proxy)
    text, error = rendered_failure(boundary, renderer)
    assert error.__context__ is None
    cause = error.__cause__
    assert cause is not None
    assert cause.__context__ is None
    for value in list(dict.fromkeys((secret, encoded, quote(encoded, safe="")))):
        assert value not in text
        assert value not in str(error)
        assert value not in str(cause)


@pytest.mark.parametrize("kind", ["oversized", "mask-alphabet"])
def test_pathological_proxy_passwords_elide_diagnostics_safely(
    monkeypatch: pytest.MonkeyPatch, kind: str
) -> None:
    """Bound pathological proxy input and avoid mask collisions without dropping any password.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): scoped oversized/mask-colliding proxy credentials.
        kind (str): oversized proxy value or a password containing every mask candidate.

    Returns:
        None: diagnostics are elided when safe bounded redaction cannot produce a marker.

    Raises:
        AssertionError: a pathological input bypasses the safety cap or leaks mask characters.
    """
    # Keep these independent of implementation constants: the documented cap is 8192,
    # and every printable ASCII candidate must be unavailable for the collision case.
    secret = "x" * 8193 if kind == "oversized" else "".join(chr(value) for value in range(32, 127))
    monkeypatch.setenv("HTTPS_PROXY", f"http://user:{quote(secret, safe='')}@proxy.invalid")
    assert release.redact_diagnostic("diagnostic payload") == ""


def test_large_credential_free_bypass_list_does_not_elide_messages(monkeypatch: pytest.MonkeyPatch) -> None:
    """Large enterprise bypass lists without credentials must not silence installer errors.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): scoped large credential-free bypass list.

    Returns:
        None: ordinary diagnostics and child bypass settings remain unchanged.

    Raises:
        AssertionError: the credential cap incorrectly suppresses unrelated error messages.
    """
    value = ",".join(f"host{number}.internal.invalid" for number in range(1000))
    assert len(value) > 8192
    monkeypatch.setenv("NO_PROXY", value)
    assert release.redact_diagnostic("Connection failed") == "Connection failed"
    assert release.child_environment({"NO_PROXY": value})["NO_PROXY"] == value


@pytest.mark.parametrize("secret", ["päss", "p/ss", "Pa?ss"])
def test_percent_escape_hex_case_cannot_bypass_password_masking(
    monkeypatch: pytest.MonkeyPatch, secret: str
) -> None:
    """Lowercase and mixed-case percent escapes cannot evade encoded password masking.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): scoped canonical encoded proxy password.
        secret (str): Unicode or reserved-character password with case-sensitive plain letters.

    Returns:
        None: lowercase/mixed escape forms disappear without lowercasing ordinary text.

    Raises:
        AssertionError: hex-letter case bypasses masking or ordinary text is case-folded.
    """
    encoded = quote(secret, safe="")
    monkeypatch.setenv("HTTPS_PROXY", f"http://user:{encoded}@proxy.invalid")
    lower = encoded.replace("%C3", "%c3").replace("%A4", "%a4").replace("%2F", "%2f").replace("%3F", "%3f")
    mixed = encoded.replace("%C3", "%c3").replace("%2F", "%2f").replace("%3F", "%3f")
    for value in list(dict.fromkeys((lower, mixed))):
        assert value != encoded, "The fixture must actually vary an escape's hex-letter case"
        redacted = release.redact_diagnostic(f"UnrelatedCase prefix{value}suffix")
        assert value not in redacted
        assert encoded not in redacted
        assert secret not in redacted
        assert "UnrelatedCase" in redacted


def test_one_character_password_mask_does_not_grow_large_output(monkeypatch: pytest.MonkeyPatch) -> None:
    """One-character passwords are still removed in one non-growing bounded literal pass.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): scoped single-character credential.

    Returns:
        None: a MiB of matching characters is masked without growing the diagnostic.

    Raises:
        AssertionError: short passwords survive, output expands or the linear scanner is missing.
    """
    assert "redact_url_userinfo" in vars(release)
    monkeypatch.setenv("HTTPS_PROXY", "http://user:x@proxy.invalid")
    original = "x" * (1024 * 1024)
    redacted = release.redact_diagnostic(original)
    assert "x" not in redacted
    assert len(redacted) <= len(original)
