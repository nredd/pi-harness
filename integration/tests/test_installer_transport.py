"""Exercise installer-only transport, traceback and subprocess-boundary contracts.

References:
- https://docs.python.org/3/library/urllib.request.html
- https://docs.python.org/3/library/ssl.html#ssl.create_default_context
- https://docs.python.org/3/library/traceback.html
"""

from __future__ import annotations

import ast
import io
import logging
import select
import shutil
import socket
import ssl
import subprocess
import threading
import traceback
from contextlib import contextmanager
from dataclasses import dataclass
from http.client import RemoteDisconnected
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from socketserver import BaseRequestHandler, ThreadingTCPServer
from typing import TYPE_CHECKING, Any, override
from urllib.error import URLError
from urllib.request import Request

import pytest

from harness import release

if TYPE_CHECKING:
    from collections.abc import Iterator

LOGGER = logging.getLogger(__name__)
CONNECTIVITY_KEYS = (
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
DOCUMENTED_TESTS = (
    "test_connectivity_reaches_every_child",
    "test_invalid_ca_dropped_with_value_free_warning",
    "test_connectivity_rejects_control_characters",
    "test_proxy_redaction_before_tail_truncation",
    "test_child_diagnostics_redact_proxy_credentials",
    "test_proxy_redaction_preserves_nonproxy_identifiers",
    "test_proxy_redaction_at_public_diagnostic_boundaries",
)
SPAWNS = {"run", "Popen", "check_output", "check_call", "call", "getoutput", "getstatusoutput"}
INSTALLER_SPAWNS = {
    "install.py": {"node_version", "install_packages", "post_check"},
    "release.py": {"gitlink_tag", "verify_attestation", "fetch_release"},
}


@dataclass(frozen=True)
class LocalTransport:
    """Ephemeral HTTPS origin and recording CONNECT proxy, never public network traffic."""

    certificate: Path
    ca_directory: Path
    proxy: str
    url: str
    port: int
    connects: list[bytes]


@pytest.fixture(autouse=True)
def isolated_connectivity(monkeypatch: pytest.MonkeyPatch) -> None:
    """Prevent workstation proxy/CA values from affecting or leaking into fixture tests.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): scoped environment mutation.

    Returns:
        None: each test starts with no inherited connectivity configuration.
    """
    for key in CONNECTIVITY_KEYS:
        monkeypatch.delenv(key, raising=False)


@contextmanager
def running_server(server: ThreadingHTTPServer | ThreadingTCPServer) -> Iterator[None]:
    """Serve a loopback fixture with bounded cleanup and daemon request threads.

    Parameters:
        server (ThreadingHTTPServer | ThreadingTCPServer): bound fixture listener.

    Yields:
        None: fixture requests can be served.

    Raises:
        AssertionError: the serving thread survives shutdown.
    """
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
    thread.start()
    try:
        yield
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
        assert not thread.is_alive()


@pytest.fixture
def local_transport(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[LocalTransport]:
    """Create a local CA, hostname-verifying TLS origin and real CONNECT tunnel.

    Parameters:
        tmp_path (Path): ephemeral private key, certificate and OpenSSL config.
        monkeypatch (pytest.MonkeyPatch): resolve only fixture hostnames to loopback.

    Yields:
        LocalTransport: ready listeners and recording proxy requests.

    Raises:
        AssertionError: OpenSSL is missing or a fixture cannot shut down.
        OSError | subprocess.CalledProcessError: certificate/listener setup failed.
    """
    openssl = shutil.which("openssl")
    assert openssl is not None, "Local HTTPS tests require `openssl` (available on supported CI hosts)"
    certificate, key, cfg = tmp_path / "ca.pem", tmp_path / "key.pem", tmp_path / "openssl.cnf"
    cfg.write_text(
        "[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=extensions\n"
        "[dn]\nCN=origin.invalid\n[extensions]\nbasicConstraints=critical,CA:TRUE\n"
        "subjectAltName=DNS:origin.invalid,DNS:sub.origin.invalid,IP:127.0.0.1\n"
    )
    subprocess.check_output(
        [
            str(Path(openssl).absolute()),
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-days",
            "1",
            "-keyout",
            str(key),
            "-out",
            str(certificate),
            "-config",
            str(cfg),
        ],
        text=True,
        stderr=subprocess.STDOUT,
    )
    ca_directory = tmp_path / "hashed-ca"
    ca_directory.mkdir()
    digest = subprocess.check_output(
        [str(Path(openssl).absolute()), "x509", "-in", str(certificate), "-hash", "-noout"],
        text=True,
        stderr=subprocess.STDOUT,
    ).strip()
    (ca_directory / f"{digest}.0").write_bytes(certificate.read_bytes())

    class Origin(BaseHTTPRequestHandler):
        """Return a small HTTPS payload without process-global logging."""

        def do_GET(self) -> None:
            """Serve the fixed body.

            Returns:
                None: headers and body are sent.

            Raises:
                OSError: the fixture connection closed unexpectedly.
            """
            self.send_response(200)
            self.send_header("Content-Length", "7")
            self.end_headers()
            self.wfile.write(b"trusted")

        @override
        def log_message(self, format: str, *args: object) -> None:
            """Keep fixture HTTP diagnostics silent.

            Parameters:
                format (str): unused HTTP diagnostic template.
                *args (object): unused diagnostic values.

            Returns:
                None: no fixture traffic is logged.
            """

    origin = ThreadingHTTPServer(("127.0.0.1", 0), Origin)
    tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    tls.load_cert_chain(certificate, key)
    origin.socket = tls.wrap_socket(origin.socket, server_side=True)
    port = origin.server_port
    connects: list[bytes] = []

    class Proxy(BaseRequestHandler):
        """Relay CONNECT bytes to the loopback origin, never resolve an external host."""

        @override
        def handle(self) -> None:
            """Record CONNECT/auth headers and tunnel the TLS stream.

            Returns:
                None: the tunnel closes when either peer closes.

            Raises:
                OSError: a fixture socket fails.
            """
            self.request.settimeout(5)
            headers = b""
            while b"\r\n\r\n" not in headers and len(headers) < 8192:
                chunk = self.request.recv(1024)
                if not chunk:
                    return
                headers += chunk
            connects.append(headers)
            if not headers.startswith(b"CONNECT "):
                return
            with socket.create_connection(("127.0.0.1", port), timeout=5) as upstream:
                self.request.sendall(b"HTTP/1.0 200 Connection established\r\n\r\n")
                peers = (self.request, upstream)
                while ready := select.select(peers, (), (), 5)[0]:
                    for source in ready:
                        data = source.recv(65536)
                        if not data:
                            return
                        (upstream if source is self.request else self.request).sendall(data)

    getaddrinfo = socket.getaddrinfo

    def local_dns(host: Any, *args: Any, **kwargs: Any) -> Any:
        """Map fixture DNS names to loopback without changing production transport code.

        Parameters:
            host (Any): requested hostname/address.
            *args (Any): original resolver positional arguments.
            **kwargs (Any): original resolver keyword arguments.

        Returns:
            Any: native resolver results for loopback or the unchanged nonfixture host.
        """
        return getaddrinfo(
            "127.0.0.1" if host in {"origin.invalid", "sub.origin.invalid"} else host, *args, **kwargs
        )

    monkeypatch.setattr(socket, "getaddrinfo", local_dns)
    proxy = ThreadingTCPServer(("127.0.0.1", 0), Proxy)
    with running_server(origin), running_server(proxy):
        yield LocalTransport(
            certificate,
            ca_directory,
            f"http://user:pass@127.0.0.1:{proxy.server_address[1]}",
            f"https://sub.origin.invalid:{port}/payload",
            port,
            connects,
        )


@pytest.mark.parametrize(
    "key", ["SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE"]
)
def test_https_fetch_uses_validated_proxy_and_ca(
    local_transport: LocalTransport, monkeypatch: pytest.MonkeyPatch, key: str
) -> None:
    """Real HTTPS goes through CONNECT and trusts each explicit supported CA setting.

    Parameters:
        local_transport (LocalTransport): loopback TLS origin/proxy fixture.
        monkeypatch (pytest.MonkeyPatch): scoped connectivity values.
        key (str): CA file/directory setting to exercise.

    Returns:
        None: TLS succeeds and authenticated CONNECT reaches the recording proxy.

    Raises:
        AssertionError: routing, payload or proxy authentication differs.
    """
    monkeypatch.setenv("HTTPS_PROXY", local_transport.proxy)
    monkeypatch.setenv(
        key, str(local_transport.ca_directory if key == "SSL_CERT_DIR" else local_transport.certificate)
    )
    assert release.fetch_bytes(local_transport.url) == b"trusted"
    assert len(local_transport.connects) == 1
    assert b"Proxy-Authorization: Basic dXNlcjpwYXNz" in local_transport.connects[0]


@pytest.mark.parametrize(
    "key", ["SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE"]
)
def test_fetch_drops_relative_ca_before_tls_defaults(
    local_transport: LocalTransport,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    key: str,
) -> None:
    """Rejected relative CAs cannot sneak back through OpenSSL's ambient default loading.

    Parameters:
        local_transport (LocalTransport): loopback TLS origin and private CA.
        monkeypatch (pytest.MonkeyPatch): scoped relative CA and proxy settings.
        caplog (pytest.LogCaptureFixture): shared value-free validation warnings.
        key (str): CA variable to reject before creating the SSL context.

    Returns:
        None: TLS fails and the warning names only the rejected variable.

    Raises:
        AssertionError: an ambient CA grants trust or warning text exposes its value.
    """
    monkeypatch.chdir(local_transport.certificate.parent)
    relative = (
        local_transport.ca_directory.name if key == "SSL_CERT_DIR" else local_transport.certificate.name
    )
    monkeypatch.setenv(key, relative)
    monkeypatch.setenv("HTTPS_PROXY", local_transport.proxy)
    with pytest.raises(release.FetchError, match="TLS error"):
        release.fetch_bytes(local_transport.url)
    assert caplog.messages == [f"Dropping `{key}`: expected an absolute existing CA path"]
    assert relative not in caplog.text


@pytest.mark.parametrize("key", ["ALL_PROXY", "all_proxy"])
def test_installer_all_proxy_fallback(
    local_transport: LocalTransport, monkeypatch: pytest.MonkeyPatch, key: str
) -> None:
    """The explicit ALL_PROXY fallback is honored when no HTTPS proxy key is present.

    Parameters:
        local_transport (LocalTransport): loopback TLS origin/proxy fixture.
        monkeypatch (pytest.MonkeyPatch): scoped proxy and CA values.
        key (str): exact uppercase/lowercase fallback name.

    Returns:
        None: the HTTPS request traverses the fallback CONNECT proxy.

    Raises:
        AssertionError: the request silently bypasses the configured fallback.
    """
    monkeypatch.setenv(key, local_transport.proxy)
    monkeypatch.setenv("NODE_EXTRA_CA_CERTS", str(local_transport.certificate))
    assert release.fetch_bytes(local_transport.url) == b"trusted"
    assert local_transport.connects


def test_empty_https_proxy_disables_all_proxy_fallback(
    local_transport: LocalTransport, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An explicitly empty HTTPS setting disables routing even with a fallback configured.

    Parameters:
        local_transport (LocalTransport): loopback TLS origin/proxy fixture.
        monkeypatch (pytest.MonkeyPatch): explicit empty proxy and configured fallback.

    Returns:
        None: the request goes directly to the TLS origin.

    Raises:
        AssertionError: an empty explicit proxy accidentally activates the fallback.
    """
    monkeypatch.setenv("https_proxy", "")
    monkeypatch.setenv("ALL_PROXY", local_transport.proxy)
    monkeypatch.setenv("NODE_EXTRA_CA_CERTS", str(local_transport.certificate))
    assert release.fetch_bytes(local_transport.url) == b"trusted"
    assert not local_transport.connects


@pytest.mark.parametrize("scheme", ["https", "socks5", "ftp"])
def test_installer_refuses_unsupported_proxy_without_downgrade(scheme: str) -> None:
    """Unsupported proxy schemes fail before urllib can send downgraded credentials.

    Parameters:
        scheme (str): non-HTTP proxy scheme that the stdlib tunnel cannot honor safely.

    Returns:
        None: proxy configuration fails without altering the origin request.

    Raises:
        AssertionError: a non-HTTP proxy is silently accepted or the URL exposes userinfo.
    """
    handler = release.ValidatedProxyHandler({})
    request = Request("https://origin.invalid/resource")
    with pytest.raises(ValueError, match="HTTP CONNECT authority") as caught:
        handler.proxy_open(request, f"{scheme}://user:pass@proxy.invalid:8080", "https")
    assert "user:pass" not in str(caught.value)
    assert request.host == "origin.invalid"
    assert not request.has_header("Proxy-Authorization")


def test_fetch_context_without_defaults_ignores_ambient_ca(
    local_transport: LocalTransport, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Missing explicit/compiled-in roots fail closed instead of loading ambient CA paths.

    Parameters:
        local_transport (LocalTransport): real CA paths used only as rejected ambient inputs.
        monkeypatch (pytest.MonkeyPatch): missing compiled-in defaults and ambient trusted CA.

    Returns:
        None: the context verifies hostnames/certificates and its trust store is empty.

    Raises:
        AssertionError: ambient CA paths populate the supposedly explicit empty trust store.
    """
    defaults = ssl.get_default_verify_paths()._replace(
        openssl_cafile=str(local_transport.certificate.parent / "missing-default.pem"),
        openssl_capath=str(local_transport.certificate.parent / "missing-default-dir"),
    )
    monkeypatch.setattr(ssl, "get_default_verify_paths", lambda: defaults)
    monkeypatch.setenv("SSL_CERT_FILE", str(local_transport.certificate))
    monkeypatch.setenv("SSL_CERT_DIR", str(local_transport.ca_directory))
    context = release.fetch_ssl_context({})
    assert context.check_hostname
    assert context.verify_mode == ssl.CERT_REQUIRED
    assert context.cert_store_stats()["x509"] == 0


def test_rejected_ambient_ca_uses_explicit_compiled_default(
    local_transport: LocalTransport, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """A rejected relative CA does not block the explicit compiled-in default trust store.

    Parameters:
        local_transport (LocalTransport): CA treated as the compiled-in default for this test.
        monkeypatch (pytest.MonkeyPatch): relative ambient CA and explicit default-path fixture.
        caplog (pytest.LogCaptureFixture): value-free validation warning.

    Returns:
        None: the HTTPS/CONNECT request succeeds through the compiled-in default CA.

    Raises:
        AssertionError: a rejected ambient path displaces default trust or appears in a warning.
    """
    defaults = ssl.get_default_verify_paths()._replace(
        openssl_cafile=str(local_transport.certificate),
        openssl_capath=str(local_transport.certificate.parent / "missing-default-dir"),
    )
    monkeypatch.setattr(ssl, "get_default_verify_paths", lambda: defaults)
    monkeypatch.setenv("SSL_CERT_FILE", "rejected-relative.pem")
    monkeypatch.setenv("HTTPS_PROXY", local_transport.proxy)
    assert release.fetch_bytes(local_transport.url) == b"trusted"
    assert local_transport.connects
    assert caplog.messages == ["Dropping `SSL_CERT_FILE`: expected an absolute existing CA path"]
    assert "rejected-relative.pem" not in caplog.text


@pytest.mark.parametrize("missing", ["proxy", "ca"])
def test_https_transport_requires_explicit_proxy_and_trust(
    local_transport: LocalTransport, monkeypatch: pytest.MonkeyPatch, missing: str
) -> None:
    """Removing a setting removes its routing/trust capability, not certificate checks.

    Parameters:
        local_transport (LocalTransport): loopback TLS origin/proxy fixture.
        monkeypatch (pytest.MonkeyPatch): scoped connectivity values.
        missing (str): proxy or CA capability to omit.

    Returns:
        None: no proxy is contacted when absent, and untrusted TLS fails.

    Raises:
        AssertionError: the missing capability remains active.
    """
    if missing != "proxy":
        monkeypatch.setenv("HTTPS_PROXY", local_transport.proxy)
    if missing != "ca":
        monkeypatch.setenv("NODE_EXTRA_CA_CERTS", str(local_transport.certificate))
        assert release.fetch_bytes(local_transport.url) == b"trusted"
        assert not local_transport.connects
    else:
        with pytest.raises(release.FetchError, match="TLS error"):
            release.fetch_bytes(local_transport.url)
        assert local_transport.connects


@pytest.mark.parametrize(
    ("entry", "bypass"),
    [
        ("", False),
        ("*", True),
        ("sub.origin.invalid:{port}", True),
        ("sub.origin.invalid:1", False),
        (".origin.invalid", True),
        ("origin.invalid", True),
        ("other.invalid", False),
    ],
)
def test_installer_no_proxy_semantics(
    local_transport: LocalTransport, monkeypatch: pytest.MonkeyPatch, entry: str, bypass: bool
) -> None:
    """Installer bypass uses explicit urllib host/port/domain rules, not OS proxy state.

    Parameters:
        local_transport (LocalTransport): loopback TLS origin/proxy fixture.
        monkeypatch (pytest.MonkeyPatch): scoped proxy and CA settings.
        entry (str): bypass-list entry, optionally containing the fixture port placeholder.
        bypass (bool): expected direct route.

    Returns:
        None: real CONNECT observations match the documented bypass semantics.

    Raises:
        AssertionError: ambient settings or wrong host matching change the route.
    """
    monkeypatch.setenv("HTTPS_PROXY", local_transport.proxy)
    monkeypatch.setenv("NODE_EXTRA_CA_CERTS", str(local_transport.certificate))
    monkeypatch.setenv("no_proxy", entry.format(port=local_transport.port))
    assert release.fetch_bytes(local_transport.url) == b"trusted"
    assert bool(local_transport.connects) is not bypass


@pytest.mark.parametrize("pair", ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"])
def test_conflicting_proxy_case_warns_without_rewriting_children(
    caplog: pytest.LogCaptureFixture, pair: str
) -> None:
    """Both child spellings survive conflicts, and the warning never contains either value.

    Parameters:
        caplog (pytest.LogCaptureFixture): captured conflict warning.
        pair (str): uppercase half of the supported pair.

    Returns:
        None: exact inherited case variants survive and only variable names are logged.

    Raises:
        AssertionError: either value is rewritten or exposed.
    """
    env = {pair: "upper-private-value", pair.lower(): "lower-private-value"}
    child = release.child_environment(env)
    assert {key: child[key] for key in env} == env
    assert caplog.messages == [
        f"Conflicting `{pair}` and `{pair.lower()}`: installer fetch prefers `{pair.lower()}`"
    ]


def test_installer_prefers_lowercase_proxy_and_empty_bypass(
    local_transport: LocalTransport, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """Conflicting HTTPS proxies select lowercase; empty lowercase bypass overrides `*`.

    Parameters:
        local_transport (LocalTransport): loopback TLS origin/proxy fixture.
        monkeypatch (pytest.MonkeyPatch): scoped conflicting case variants.
        caplog (pytest.LogCaptureFixture): value-free warnings.

    Returns:
        None: the real fetch reaches only the lowercase CONNECT proxy.

    Raises:
        AssertionError: uppercase proxy/bypass wins or credentials are logged.
    """
    monkeypatch.setenv("HTTPS_PROXY", "http://other:secret@127.0.0.1:1")
    monkeypatch.setenv("https_proxy", local_transport.proxy)
    monkeypatch.setenv("NO_PROXY", "*")
    monkeypatch.setenv("no_proxy", "")
    monkeypatch.setenv("NODE_EXTRA_CA_CERTS", str(local_transport.certificate))
    assert release.fetch_bytes(local_transport.url) == b"trusted"
    assert local_transport.connects
    assert len(caplog.messages) == 2
    assert "secret" not in caplog.text
    assert "user:pass" not in caplog.text


@pytest.mark.parametrize("kind", ["url", "protocol", "context"])
@pytest.mark.parametrize("renderer", ["traceback", "logging"])
def test_fetch_traceback_and_context_are_redacted(
    monkeypatch: pytest.MonkeyPatch, kind: str, renderer: str
) -> None:
    """Standard traceback/logging renderers cannot expose original transport cause/context.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): scoped failing opener and synthetic proxy.
        kind (str): urllib, protocol or nested-context exception shape.
        renderer (str): standard traceback or `exc_info=True` logging.

    Returns:
        None: the complete public exception graph contains only redacted transport text.

    Raises:
        AssertionError: any original cause/context or credentials survive.
    """
    proxy = "http://trace-user:trace-password@proxy.invalid:8080"
    monkeypatch.setenv("HTTPS_PROXY", proxy)

    def failed(*args: object, **kwargs: object) -> Any:
        """Raise the selected raw transport exception with an optional implicit context.

        Parameters:
            *args (object): unused request arguments.
            **kwargs (object): unused request options.

        Returns:
            Any: never returned.

        Raises:
            URLError | RemoteDisconnected: unredacted synthetic transport failure.
        """
        if kind == "protocol":
            raise RemoteDisconnected(proxy)
        if kind == "context":
            try:
                raise ValueError(proxy)
            except ValueError as error:
                raise URLError(proxy) from error
        raise URLError(proxy)

    monkeypatch.setattr(release, "urlopen", failed)
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    LOGGER.addHandler(handler)
    try:
        with pytest.raises(release.FetchError) as caught:
            release.fetch_bytes("https://public.invalid/artifact")
        if renderer == "logging":
            try:
                raise caught.value
            except release.FetchError:
                LOGGER.error("Transport failure", exc_info=True)
    finally:
        LOGGER.removeHandler(handler)
    error = caught.value
    text = stream.getvalue() if renderer == "logging" else "".join(traceback.format_exception(error))
    assert error.__context__ is None
    assert error.__cause__ is not None
    assert error.__cause__.__context__ is None
    assert "trace-user" not in text
    assert "trace-password" not in text
    assert "http://proxy.invalid:8080" in text
    assert "public.invalid/artifact" in text


@pytest.mark.parametrize(
    ("module", "name"),
    [("test_install.py", name) for name in DOCUMENTED_TESTS]
    + [("test_release.py", "test_shared_fetch_diagnostics_are_stable")],
)
def test_added_test_docstrings_have_typed_sections(module: str, name: str) -> None:
    """Gate the review-identified and newly touched test docstrings, not only helpers.

    Parameters:
        module (str): installer/release test module to inspect.
        name (str): regression test whose typed contract must be documented.

    Returns:
        None: its docstring documents typed inputs, result and failure contract.

    Raises:
        AssertionError: a required typed documentation section is missing.
    """
    tree = ast.parse(Path(__file__).with_name(module).read_text())
    node = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == name)
    doc = ast.get_docstring(node) or ""
    for section in ("Parameters:", "Returns:", "Raises:"):
        assert section in doc, name
    for argument in (*node.args.posonlyargs, *node.args.args, *node.args.kwonlyargs):
        assert f"{argument.arg} (" in doc, name


def test_ca_path_validation_resolves_then_checks_existence() -> None:
    """Preserve the house path-validation contract as a mechanical source regression.

    Returns:
        None: shared CA validation resolves and explicitly checks existence/type.

    Raises:
        AssertionError: a later change skips resolution or existence validation.
    """
    tree = ast.parse(Path(release.__file__).read_text())
    node = next(
        node
        for node in tree.body
        if isinstance(node, ast.FunctionDef) and node.name == "connectivity_environment"
    )
    calls = [call for call in ast.walk(node) if isinstance(call, ast.Call)]
    assert any(
        isinstance(call.func, ast.Attribute)
        and call.func.attr == "resolve"
        and ast.unparse(call.func.value) == "Path(str(value))"
        for call in calls
    )
    assert any(isinstance(call.func, ast.Attribute) and call.func.attr == "exists" for call in calls)


def assert_spawn_policy(source: str, module: str) -> None:
    """Enumerate every direct subprocess spawn and verify its explicit environment producer.

    Parameters:
        source (str): installer module source, including mutation-test inputs.
        module (str): module basename selecting the documented install-path inventory.

    Returns:
        None: every known spawn uses the helper, with no allowlisted bypass exceptions.

    Raises:
        AssertionError: a spawn is added/removed, aliases subprocess or bypasses the helper.
    """
    tree = ast.parse(source)
    assert not any(
        isinstance(node, ast.ImportFrom) and node.module == "subprocess" for node in ast.walk(tree)
    )
    assert not any(
        isinstance(node, ast.Import)
        and any(alias.name == "subprocess" and alias.asname for alias in node.names)
        for node in ast.walk(tree)
    )
    found: set[str] = set()
    for function in (node for node in ast.walk(tree) if isinstance(node, ast.FunctionDef)):
        for call in (node for node in ast.walk(function) if isinstance(node, ast.Call)):
            if (
                not isinstance(call.func, ast.Attribute)
                or not isinstance(call.func.value, ast.Name)
                or call.func.value.id != "subprocess"
                or call.func.attr not in SPAWNS
            ):
                continue
            found.add(function.name)
            environment = next((item.value for item in call.keywords if item.arg == "env"), None)
            if isinstance(environment, ast.Name):
                definitions = [
                    node.value
                    for node in ast.walk(function)
                    if isinstance(node, ast.Assign)
                    and any(
                        isinstance(target, ast.Name) and target.id == environment.id
                        for target in node.targets
                    )
                ]
                assert len(definitions) == 1
                environment = definitions[0]
            assert isinstance(environment, ast.Call), (module, function.name)
            assert isinstance(environment.func, ast.Name), (module, function.name)
            assert environment.func.id == "child_environment", (module, function.name)
    assert found == INSTALLER_SPAWNS[module]
    all_spawns = [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and isinstance(node.func.value, ast.Name)
        and node.func.value.id == "subprocess"
        and node.func.attr in SPAWNS
    ]
    assert len(all_spawns) == len(found)


@pytest.mark.parametrize("module", ["install.py", "release.py"])
def test_installer_subprocess_inventory_has_no_environment_bypass(module: str) -> None:
    """All installer-owned spawns use the shared helper; infrastructure modules are excluded.

    Parameters:
        module (str): installer/release module whose entire AST is inspected.

    Returns:
        None: the documented inventory and helper routing remain exact.

    Raises:
        AssertionError: an installer spawn bypasses the helper or escapes inventory.
    """
    assert_spawn_policy(Path(release.__file__).with_name(module).read_text(), module)


@pytest.mark.parametrize("module", ["install.py", "release.py"])
@pytest.mark.parametrize("kind", ["function", "module", "alias"])
def test_spawn_inventory_rejects_added_bypass(module: str, kind: str) -> None:
    """Prove the AST gate detects a newly added unfiltered subprocess in either module.

    Parameters:
        module (str): installer module to mutate in memory only.
        kind (str): function-level, module-level or imported-alias bypass.

    Returns:
        None: the deliberately added bypass fails the policy assertion.

    Raises:
        AssertionError: a future weakened guard accepts the bypass.
    """
    source = Path(release.__file__).with_name(module).read_text()
    addition = {
        "function": "\ndef bypass():\n    subprocess.run(['node'])\n",
        "module": "\nsubprocess.run(['node'])\n",
        "alias": "\nfrom subprocess import run as hidden\nhidden(['node'])\n",
    }[kind]
    with pytest.raises(AssertionError):
        assert_spawn_policy(source + addition, module)


@pytest.mark.parametrize("topic", ["child-scope", "network-trust"])
def test_install_docs_define_scope_and_independent_authentication(topic: str) -> None:
    """Keep the explicitly scoped child/transport authentication contracts in user docs.

    Parameters:
        topic (str): child inventory or registry transport-trust documentation gap.

    Returns:
        None: concrete exclusions, integrity limits and the tracking issue remain documented.

    Raises:
        AssertionError: documentation drops the review-required scope/security decision.
    """
    docs = Path(release.__file__).parents[2] / "docs/install.md"
    text = docs.read_text()
    required = (
        (
            "promotion.py.run_command",
            "Sandbox.env",
            "publish_gate",
            "power",
            "stats",
            "rpc",
            "git_fixture",
            "tmux",
            "headless",
            "NOT covered",
        )
        if topic == "child-scope"
        else (
            "## Network trust",
            "NO independently authenticated integrity",
            "generated npm lockfile",
            "npm install",
            "issues/169",
            "AFTER installation",
        )
    )
    for term in required:
        assert term in text, term
