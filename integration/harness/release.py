"""Install the released core into a private prefix using the tap formula's npm/resource steps.

No tap is read at runtime. The copied recipe installs the coding-agent tgz globally, replaces
its nested pi-tui with the release tgz, and prunes foreign native prebuilds.

`--verify-root-overrides` gates the root `package.json` overrides the same way before any
`npm ci`: this module and `harness.paths` are standard library only, so it runs under a bare
`PYTHONPATH=integration python3 -m harness.release` with no `uv sync`.

References:
- https://github.com/nredd/homebrew-tap/blob/main/Formula/pi-coding-agent.rb
- https://github.com/nredd/pi/releases
- https://docs.npmjs.com/cli/v11/configuring-npm/package-lock-json
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import logging
import os
import platform
import re
import shutil
import ssl
import subprocess
import tarfile
import tempfile
import traceback
from collections.abc import Callable, Iterator, Mapping
from contextlib import contextmanager
from contextvars import ContextVar
from http import HTTPStatus
from http.client import HTTPException, HTTPMessage, HTTPResponse, IncompleteRead, RemoteDisconnected
from pathlib import Path
from socket import gaierror
from ssl import SSLError
from types import MappingProxyType
from typing import IO, override
from urllib import request as urllib_request
from urllib.error import HTTPError, URLError
from urllib.parse import unquote, urlsplit
from urllib.request import (
    HTTPRedirectHandler,
    HTTPSHandler,
    ProxyHandler,
    Request,
    build_opener,
)

from harness.paths import GH_BIN, GIT_BIN, NPM_BIN, REPO_ROOT

LOGGER = logging.getLogger(__name__)
CHILD_PATH: ContextVar[str | None] = ContextVar("installer_child_path", default=None)
TAG = re.compile(r"^v(?P<version>\d+\.\d+\.\d+)-nredd\.\d+$")
SHA256_HEX = re.compile(r"[0-9a-f]{64}")
SRI_SHA512 = re.compile(r"sha512-[A-Za-z0-9+/]{86}==")
CODING_AGENT_TARBALL = "earendil-works-pi-coding-agent-1.3.0.tgz"
TUI_TARBALL = "earendil-works-pi-tui-1.3.0.tgz"
AGENT_CORE_TARBALL = "earendil-works-pi-agent-core-1.3.0.tgz"
AI_TARBALL = "earendil-works-pi-ai-1.3.0.tgz"
LEGACY_CHECKSUMS = MappingProxyType(
    {
        "v1.3.0-nredd.3": MappingProxyType(
            {
                CODING_AGENT_TARBALL: "753efe6fcb54da651e1dc02f6cc56dda029d55e5a40f833bdf9308dae88babd5",
                TUI_TARBALL: "ccd8f2d2aa8e99fed96394cc5ade43c13597bcdd2472552dab5957d038a5afbd",
            }
        ),
        "v1.3.0-nredd.4": MappingProxyType(
            {
                CODING_AGENT_TARBALL: "0042ebdca83a8cf92f406f097ec5f05dd131c859761c954e3f2feae0fef3cf87",
                TUI_TARBALL: "ccd8f2d2aa8e99fed96394cc5ade43c13597bcdd2472552dab5957d038a5afbd",
                AGENT_CORE_TARBALL: "e08bbd6b348a00eb97250ebfa33a722c70323b55a2d1e6f5b446513fcb5dad35",
                AI_TARBALL: "1b7ed741d704e0e288056630c1abc1a71eaec83eac148689c1d9b152361085b7",
            }
        ),
        "v1.3.0-nredd.5": MappingProxyType(
            {
                CODING_AGENT_TARBALL: "84f1c4b5075efca538a8f7b65334dba8dff265525d7b1f1f69bb0c1d677ac644",
                TUI_TARBALL: "dd8ac6c221bfd8e76fcc5b93418ba8feffd63dd705bde814aea6d4b1b46938e0",
                AGENT_CORE_TARBALL: "e08bbd6b348a00eb97250ebfa33a722c70323b55a2d1e6f5b446513fcb5dad35",
                AI_TARBALL: "1b7ed741d704e0e288056630c1abc1a71eaec83eac148689c1d9b152361085b7",
            }
        ),
        "v1.3.0-nredd.6": MappingProxyType(
            {
                CODING_AGENT_TARBALL: "0c1b9549cfed58c19f03b642cb259bf52f83beb1a339f154e5616c9b28c939b8",
                TUI_TARBALL: "dd8ac6c221bfd8e76fcc5b93418ba8feffd63dd705bde814aea6d4b1b46938e0",
                AGENT_CORE_TARBALL: "e08bbd6b348a00eb97250ebfa33a722c70323b55a2d1e6f5b446513fcb5dad35",
                AI_TARBALL: "1b7ed741d704e0e288056630c1abc1a71eaec83eac148689c1d9b152361085b7",
            }
        ),
        "v1.3.0-nredd.7": MappingProxyType(
            {
                CODING_AGENT_TARBALL: "16479a0cb393c7820d8b1fbcdc5c941ceb5a271dc64ecb4b8be6574df3a2e617",
                TUI_TARBALL: "dd8ac6c221bfd8e76fcc5b93418ba8feffd63dd705bde814aea6d4b1b46938e0",
            }
        ),
    }
)
LEGACY_RELEASE_TAGS = frozenset(LEGACY_CHECKSUMS)
# Every asset the harness consumes, coding-agent and tui first: they are the ones npm installs.
RELEASE_PACKAGES = ("pi-coding-agent", "pi-tui", "pi-agent-core", "pi-ai")
CORE_REPO = "nredd/pi"
ATTESTATION_WORKFLOW = f"{CORE_REPO}/.github/workflows/fork-release.yml"
RELEASE_URL_PREFIX = f"https://github.com/{CORE_REPO}/releases/download/"
ROOT_OVERRIDE_SCOPE = "@earendil-works/"
ATTESTATIONS_API = "https://api.github.com"
RATE_LIMIT_STATUSES = frozenset({403, 429})
# Every variable `gh` reads a GitHub token from; only `gh`'s login fallback may see them.
# https://cli.github.com/manual/gh_help_environment
GITHUB_TOKEN_VARIABLES = frozenset(
    {"GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"}
)
# Exact, case-sensitive connectivity keys, never npm configuration or runtime injection.
PROXY_ENVIRONMENT_KEYS = frozenset(
    {
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "NO_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "no_proxy",
        "all_proxy",
    }
)
CA_FILE_ENVIRONMENT_KEYS = frozenset(
    {"SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE"}
)
CA_ENVIRONMENT_KEYS = CA_FILE_ENVIRONMENT_KEYS | {"SSL_CERT_DIR"}
CONNECTIVITY_ENVIRONMENT_KEYS = PROXY_ENVIRONMENT_KEYS | CA_ENVIRONMENT_KEYS
PROXY_USERINFO = re.compile(r"(?P<scheme>[A-Za-z][A-Za-z0-9+.-]*://)[^\s/\"'<>?#]*@")
MIN_PROXY_PASSWORD_TOKEN_LENGTH = 8
# Runtime/location/locale only. Tool configuration and code-injection variables are not inherited.
CHILD_ENVIRONMENT_KEYS = frozenset(
    {
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
    }
)
ProvenanceCheck = Callable[[Path, str], None]
# Bound public assets, including responses without Content-Length, before allocating their bodies.
MAX_FETCH_BYTES = 256 * 1024 * 1024
CONTENT_LENGTH = re.compile(r"[0-9]+")
# Typeshed omits this runtime helper on macOS, where proxy_bypass also reads system state.
# Select urllib's environment-only implementation explicitly, with our validated mapping.
PROXY_BYPASS_ENVIRONMENT: Callable[[str, dict[str, str]], bool] = vars(urllib_request)[
    "proxy_bypass_environment"
]


class HTTPSRedirectHandler(HTTPRedirectHandler):
    """Refuse every redirect that leaves HTTPS, including cross-origin downgrades."""

    @override
    def redirect_request(
        self, req: Request, fp: IO[bytes], code: int, msg: str, headers: HTTPMessage, newurl: str
    ) -> Request | None:
        """Validate the next URL before urllib can open it.

        Parameters:
            req (Request): original request.
            fp (IO[bytes]): redirect response stream.
            code (int): HTTP status.
            msg (str): response reason.
            headers (HTTPMessage): response headers.
            newurl (str): resolved redirect destination.

        Returns:
            Request | None: urllib's redirected request.

        Raises:
            ValueError: the next hop is not HTTPS.
        """
        if urlsplit(newurl).scheme != "https":
            raise ValueError(f"Redirect requires HTTPS, refused '{newurl}'")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class ValidatedProxyHandler(ProxyHandler):
    """Use only explicit proxy/bypass policy, never ambient or platform proxy settings."""

    proxies: dict[str, str]

    @override
    def proxy_open(self, req: Request, proxy: str, type: str) -> None:
        """Configure HTTPS CONNECT using the validated proxy and explicit bypass list.

        Parameters:
            req (Request): HTTPS request, including its destination port.
            proxy (str): selected proxy URL or authority.
            type (str): protocol selected by urllib's handler dispatch.

        Returns:
            None: urllib's HTTPS handler completes the request or direct bypass.

        Raises:
            ValueError: the proxy is not an HTTP CONNECT authority.
        """
        if not proxy or PROXY_BYPASS_ENVIRONMENT(req.host, self.proxies):
            return
        parsed = urlsplit(proxy if "://" in proxy else f"http://{proxy}")
        # urllib tunnels HTTPS origins but cannot layer TLS to an HTTPS proxy. Refuse
        # that scheme rather than silently sending CONNECT credentials in plaintext.
        if parsed.scheme != "http" or not parsed.hostname:
            raise ValueError("Installer proxy requires an HTTP CONNECT authority")
        if parsed.username is not None:
            credentials = f"{unquote(parsed.username)}:{unquote(parsed.password or '')}"
            encoded = base64.b64encode(credentials.encode()).decode("ascii")
            req.add_unredirected_header("Proxy-Authorization", f"Basic {encoded}")
        req.set_proxy(parsed.netloc.rsplit("@", 1)[-1], parsed.scheme)


def urlopen(request: str | Request, *, timeout: int) -> HTTPResponse:
    """Open HTTPS with the same validated connectivity policy as installer children.

    Parameters:
        request (str | Request): public HTTPS resource.
        timeout (int): socket timeout in seconds.

    Returns:
        HTTPResponse: urllib response, including HTTP headers and bounded-read support.

    Raises:
        OSError | ValueError: transport configuration or HTTPS connection failed.
    """
    env = connectivity_environment(os.environ)
    proxies = {
        name: env.get(name + "_proxy", env.get(name.upper() + "_PROXY", ""))
        for name in ("http", "https", "all", "no")
    }
    # urllib has no ALL_PROXY fallback by itself; make the documented fallback explicit.
    if "https_proxy" not in env and "HTTPS_PROXY" not in env:
        proxies["https"] = proxies["all"]
    return build_opener(
        ValidatedProxyHandler(proxies),
        HTTPSHandler(context=fetch_ssl_context(env)),
        HTTPSRedirectHandler(),
    ).open(request, timeout=timeout)


def fetch_ssl_context(env: Mapping[str, str]) -> ssl.SSLContext:
    """Build TLS trust from validated CA paths and explicit compiled-in defaults.

    Parameters:
        env (Mapping[str, str]): validated connectivity values, never ambient OpenSSL overrides.

    Returns:
        ssl.SSLContext: hostname-verifying context with all configured additional CA bundles.

    Raises:
        OSError | ValueError: a configured CA bundle is unreadable or invalid.
    """
    defaults = ssl.get_default_verify_paths()
    cafile = env.get("SSL_CERT_FILE")
    capath = env.get("SSL_CERT_DIR")
    if cafile is None and Path(str(defaults.openssl_cafile)).resolve().is_file():
        cafile = defaults.openssl_cafile
    if capath is None and Path(str(defaults.openssl_capath)).resolve().is_dir():
        capath = defaults.openssl_capath
    # Passing neither argument to create_default_context would silently reread ambient
    # SSL_CERT_FILE/SSL_CERT_DIR, including values validation rejected. Fail closed instead.
    context = (
        ssl.create_default_context(cafile=cafile, capath=capath)
        if cafile or capath
        else ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    )
    for key in ("NODE_EXTRA_CA_CERTS", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE"):
        if key in env:
            context.load_verify_locations(cafile=env[key])
    return context


def format_exception_redacted(error: BaseException) -> str:
    """Format the complete cause/context chain through the one diagnostic sanitizer.

    Parameters:
        error (BaseException): untrusted transport exception and its traceback chain.

    Returns:
        str: formatted traceback without proxy URL userinfo.
    """
    return redact_diagnostic("".join(traceback.format_exception(error)))


def detached_exception[Error: BaseException](replacement: Error, error: BaseException) -> Error:
    """Prepare a redacted replacement with a sanitized cause and no original exception graph.

    Callers must raise the returned exception OUTSIDE their except handler so Python cannot
    reattach the raw exception as implicit `__context__`.

    Parameters:
        replacement (Error): operation-specific exception, preserving its domain type/metadata.
        error (BaseException): untrusted underlying error and complete cause/context chain.

    Returns:
        Error: replacement with sanitized message and formatted cause, no raw traceback/context.

    Raises:
        ValueError: the original error was supplied as its own replacement.
    """
    if replacement is error:
        raise ValueError("A detached exception requires a distinct replacement")
    replacement.args = (redact_diagnostic(str(replacement)),)
    if isinstance(replacement, SystemExit) and isinstance(replacement.code, str):
        replacement.code = redact_diagnostic(replacement.code)
    replacement.__cause__ = RuntimeError(format_exception_redacted(error))
    replacement.__context__ = None
    replacement.__traceback__ = None
    return replacement


def fetch_failure_reason(error: Exception) -> str:
    """Translate transport exceptions into stable, single-line public reasons, never urllib repr.

    Parameters:
        error (Exception): HTTP, DNS, timeout, TLS, protocol, I/O or validation failure.

    Returns:
        str: readable reason without URL wrapping or response-body contents.
    """
    # Specific subclasses precede their parents: HTTPError -> URLError, and protocol/TLS
    # failures -> HTTPException/OSError. Preserve that order when adding a transport category.
    if isinstance(error, HTTPError):
        try:
            default = HTTPStatus(error.code).phrase
        except ValueError:
            default = "Unknown reason"
        reason = f"HTTP {error.code} {error.reason or default}"
    elif isinstance(error, URLError):
        reason = (
            fetch_failure_reason(error.reason)
            if isinstance(error.reason, Exception)
            else f"Network error: {error.reason}"
        )
    elif isinstance(error, gaierror):
        reason = "DNS lookup failed"
    elif isinstance(error, TimeoutError):
        reason = "Request timed out"
    elif isinstance(error, IncompleteRead):
        expected = f", expected {error.expected} more" if error.expected is not None else ""
        reason = f"Incomplete response: received {len(error.partial)} bytes{expected}"
    elif isinstance(error, SSLError):
        detail = error.strerror or (error.args[0] if error.args else "connection failed")
        reason = f"TLS error: {detail}"
    elif isinstance(error, RemoteDisconnected):
        reason = f"Connection closed: {error}"
    elif isinstance(error, HTTPException):
        reason = f"HTTP protocol error: {error}"
    elif isinstance(error, OSError):
        reason = f"I/O error: {error.strerror or error}"
    else:
        reason = str(error)
    return redact_diagnostic(" ".join(reason.split()))


class FetchError(OSError):
    """A public HTTP read failed; preserve status for the anonymous rate-limit fallback."""

    def __init__(self, url: str, error: Exception) -> None:
        """Keep the URL and reason without exposing callers to protocol-specific exceptions.

        Parameters:
            url (str): public resource URL.
            error (Exception): HTTP, I/O, TLS, timeout or response-length failure.

        Returns:
            None: the public diagnostic names the requested URL once and retains the HTTP status.
        """
        self.status = error.code if isinstance(error, HTTPError) else None
        super().__init__(redact_diagnostic(f"Could not fetch '{url}': {fetch_failure_reason(error)}"))


def fetch_bytes(request: str | Request) -> bytes:
    """Read a complete public response, normalizing HTTP and I/O failures in one place.

    Parameters:
        request (str | Request): public URL, optionally with an explicit `Accept` header only.

    Returns:
        bytes: complete response body, never a partially consumed response.

    Raises:
        FetchError: HTTPException (including IncompleteRead/RemoteDisconnected), OSError
            (including TimeoutError/SSLError), non-HTTPS URL/redirect, invalid Content-Length,
            length mismatch, headers other than `Accept` or response exceeding `MAX_FETCH_BYTES`.
    """
    url = request.full_url if isinstance(request, Request) else request
    try:
        # urllib forwards most caller headers across origins, including Authorization and Cookie;
        # unredirected headers are the only general exception. Public downloads need only Accept.
        if isinstance(request, Request) and any(key.lower() != "accept" for key, _ in request.header_items()):
            raise ValueError("Public downloads permit only the `Accept` request header")
        if urlsplit(url).scheme != "https":
            raise ValueError("Download requires HTTPS")
        with urlopen(request, timeout=120) as response:
            lengths = response.headers.get_all("Content-Length", [])
            length = None
            if lengths:
                if len(lengths) != 1 or CONTENT_LENGTH.fullmatch(lengths[0].strip()) is None:
                    raise ValueError(f"Invalid Content-Length: '{lengths}'")
                length = int(lengths[0])
                if length > MAX_FETCH_BYTES:
                    raise ValueError(f"Content-Length exceeds {MAX_FETCH_BYTES} bytes")
                # urllib requests Connection: close. Read to EOF, not its parsed length, so
                # both undersized and oversized declarations are checked against actual bytes.
                response.length = None
            body = response.read(MAX_FETCH_BYTES + 1)
            if len(body) > MAX_FETCH_BYTES:
                raise ValueError(f"Response exceeds {MAX_FETCH_BYTES} bytes")
            if length is not None and len(body) != length:
                raise ValueError(f"Content-Length mismatch: expected {length} bytes, received {len(body)}")
            return body
    except (HTTPException, OSError, ValueError) as error:
        failure = detached_exception(FetchError(url, error), error)
    # Raising outside the handler prevents Python attaching the raw error as __context__.
    raise failure from failure.__cause__


class AttestationRateLimitedError(RuntimeError):
    """GitHub's anonymous API rate limit refused an attestation lookup."""


@contextmanager
def pinned_child_path(node: str) -> Iterator[None]:
    """Freeze child PATH at preflight, prioritizing the validated Node dispatcher.

    Parameters:
        node (str): preflight-selected Node path; links are not resolved.

    Yields:
        None: child environments use this run's absolute search path.

    Raises:
        OSError: the current directory cannot be determined.
    """
    path = os.pathsep.join(
        [
            str(Path(node).absolute().parent),
            *(str(Path(entry).absolute()) for entry in os.environ.get("PATH", os.defpath).split(os.pathsep)),
        ]
    )
    token = CHILD_PATH.set(path)
    try:
        yield
    finally:
        CHILD_PATH.reset(token)


def redact_diagnostic(text: str) -> str:
    """Remove proxy URL userinfo from public diagnostics, including echoed child output.

    Parameters:
        text (str): untrusted diagnostic before truncating its output tail.

    Returns:
        str: diagnostic retaining the scheme and host, never username/password userinfo.
    """
    representations: dict[str, str] = {}
    tokens: set[str] = set()
    for key in sorted(PROXY_ENVIRONMENT_KEYS):
        value = os.environ.get(key, "")
        scheme, separator, rest = value.partition("://")
        if not separator:
            rest = value
        authority = rest.split("/", 1)[0].split("?", 1)[0].split("#", 1)[0]
        if "@" not in authority:
            continue
        userinfo = authority.rsplit("@", 1)[0]
        clean_rest = rest[len(userinfo) + 1 :]
        prefix = scheme + separator if separator else ""
        for original, clean in ((value, prefix + clean_rest), (rest, clean_rest)):
            representations[original] = clean
            representations[unquote(original)] = unquote(clean)
        # Split before decoding: an encoded colon may belong to the username itself.
        password = userinfo.partition(":")[2]
        if password:
            for credentials in (userinfo, unquote(userinfo)):
                tokens |= {credentials, credentials + "@"}
            for secret in (password, unquote(password)):
                if len(secret) >= MIN_PROXY_PASSWORD_TOKEN_LENGTH:
                    tokens.add(secret)
    for original in sorted(representations, key=lambda value: (-len(value), value)):
        clean = representations[original]
        text = (
            text.replace(original, clean)
            if "://" in original
            else replace_diagnostic_token(text, original, clean)
        )
    # Greedy authority matching consumes through the FINAL '@', not a decoded password's '@'.
    text = PROXY_USERINFO.sub(lambda match: match["scheme"] or "", text)
    for token in sorted(tokens, key=lambda value: (-len(value), value)):
        text = replace_diagnostic_token(text, token)
    return text


def replace_diagnostic_token(text: str, token: str, replacement: str = "[redacted]") -> str:
    """Replace a known diagnostic token only at non-word boundaries, never word substrings.

    Parameters:
        text (str): diagnostic after complete URL redaction.
        token (str): known authority, userinfo or sufficiently long password, encoded or decoded.
        replacement (str): clean authority or the default `[redacted]` marker.

    Returns:
        str: diagnostic with only matching whole tokens replaced.

    Raises:
        ValueError: an empty token would make scanning ambiguous.
    """
    if not token:
        raise ValueError("A redaction token must not be empty")
    parts: list[str] = []
    offset = 0
    while (position := text.find(token, offset)) >= 0:
        end = position + len(token)
        before = text[position - 1] if position else ""
        after = text[end] if end < len(text) else ""
        whole = not (before.isalnum() or before == "_" or after.isalnum() or after == "_")
        parts.extend((text[offset:position], replacement if whole else token))
        offset = end
    return "".join(parts) + text[offset:]


def connectivity_environment(env: Mapping[str, str]) -> dict[str, str]:
    """Validate the shared child/fetch connectivity allowlist without exposing values.

    Parameters:
        env (Mapping[str, str]): untrusted parent transport settings.

    Returns:
        dict[str, str]: unchanged valid values, retaining both case variants for children.
    """
    result: dict[str, str] = {}
    for key in sorted(CONNECTIVITY_ENVIRONMENT_KEYS):
        if key not in env:
            continue
        value = env[key]
        if any(character in value for character in ("\u0000", "\n", "\r")):
            LOGGER.warning(f"Dropping `{key}`: NUL/newline is not allowed")
            continue
        if key in CA_ENVIRONMENT_KEYS:
            try:
                path = Path(str(value)).resolve()
                valid = (
                    Path(str(value)).is_absolute()
                    and path.exists()
                    and (path.is_dir() if key == "SSL_CERT_DIR" else path.is_file())
                )
            except (OSError, RuntimeError):
                valid = False
            if not valid:
                LOGGER.warning(f"Dropping `{key}`: expected an absolute existing CA path")
                continue
        result[key] = value
    for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"):
        lower = key.lower()
        if key in result and lower in result and result[key] != result[lower]:
            LOGGER.warning(f"Conflicting `{key}` and `{lower}`: installer fetch prefers `{lower}`")
    return result


def child_environment(
    env: Mapping[str, str],
    *,
    overrides: Mapping[str, str] | None = None,
    github_tokens: bool = False,
) -> dict[str, str]:
    """Build every child environment from runtime/connectivity allowlists and owned overrides.

    Connectivity values containing NUL/CR/LF and CA paths that are not absolute existing
    files/directories are dropped with value-free warnings. Proxy userinfo is preserved
    for the child; use `redact_diagnostic` before displaying any child output.

    Parameters:
        env (Mapping[str, str]): untrusted parent environment, filtered by explicit key.
        overrides (Mapping[str, str] | None): installer-owned tool settings, never parent passthrough.
        github_tokens (bool): allow GitHub tokens and `GH_CONFIG_DIR` only for gh login fallback.

    Returns:
        dict[str, str]: explicit environment with absolute PATH entries and selected Node first.

    Raises:
        OSError: an unpinned relative PATH cannot be made absolute.
    """
    allowed = CHILD_ENVIRONMENT_KEYS | (
        GITHUB_TOKEN_VARIABLES | {"GH_CONFIG_DIR"} if github_tokens else set()
    )
    result = {key: value for key, value in env.items() if key in allowed}
    result |= connectivity_environment(env)
    result |= dict(overrides or {})
    path = CHILD_PATH.get()
    if path is None:
        path = os.pathsep.join(
            str(Path(entry).absolute()) for entry in result.get("PATH", os.defpath).split(os.pathsep)
        )
    return result | {"PATH": path}


def gitlink_tag(directory: Path) -> str:
    """Require an exact release tag on the supplied Gitlink checkout.

    Parameters:
        directory (Path): initialized core fork.

    Returns:
        str: exact tag, never a nearest ancestor or installed-version guess.

    Raises:
        RuntimeError: the Gitlink is untagged.
    """
    try:
        # Match the sandbox's explicit-environment/isolated-HOME policy. No inherited GIT_*,
        # askpass, credential configuration, XDG config, or token can redirect this checkout.
        with tempfile.TemporaryDirectory(prefix="pi-gitlink-home-") as home:
            return subprocess.check_output(
                [GIT_BIN, "-C", str(directory), "describe", "--tags", "--exact-match"],
                env=child_environment(
                    os.environ,
                    overrides={
                        "PATH": os.defpath,
                        "HOME": home,
                        "XDG_CONFIG_HOME": home,
                        "GIT_CONFIG_NOSYSTEM": "1",
                        "GIT_TERMINAL_PROMPT": "0",
                    },
                ),
                text=True,
                stderr=subprocess.STDOUT,
            ).strip()
    except (OSError, subprocess.SubprocessError) as error:
        detail = error.output if isinstance(error, subprocess.CalledProcessError) else str(error)
        failure = detached_exception(
            RuntimeError(
                f"Core Gitlink at '{directory}' is untagged; release it before gating pins: {detail}"
            ),
            error,
        )
    raise failure from failure.__cause__


def release_asset_url(tag: str, name: str) -> str:
    """Return the GitHub release download URL of one core fork asset.

    Parameters:
        tag (str): core fork release tag, e.g. `v1.3.0-nredd.7`.
        name (str): asset file name.

    Returns:
        str: download URL.
    """
    return f"{RELEASE_URL_PREFIX}{tag}/{name}"


def release_package_urls(tag: str) -> dict[str, str]:
    """Return the asset URL of every `RELEASE_PACKAGES` tarball at a core tag.

    Parameters:
        tag (str): core fork release tag.

    Returns:
        dict[str, str]: package (e.g. `pi-tui`) -> release asset URL.

    Raises:
        ValueError: `tag` is not a core fork release tag.
    """
    match = TAG.fullmatch(tag)
    if match is None:
        raise ValueError(f"Not a core fork release tag: '{tag}'")
    return {
        package: release_asset_url(tag, f"earendil-works-{package}-{match['version']}.tgz")
        for package in RELEASE_PACKAGES
    }


def release_checksums(tag: str) -> dict[str, str]:
    """Read a release checksum file, preserving named pre-attestation releases.

    Parameters:
        tag (str): requested core tag.

    Returns:
        dict[str, str]: release asset URL -> sha256 mapping.

    Raises:
        ValueError: malformed, incomplete, or unrecognized release identities.
    """
    if tag in LEGACY_RELEASE_TAGS:
        return {release_asset_url(tag, name): digest for name, digest in LEGACY_CHECKSUMS[tag].items()}
    try:
        contents = fetch_bytes(release_asset_url(tag, "SHA256SUMS")).decode("utf-8")
    except FetchError as error:
        raise ValueError(str(error)) from error
    except UnicodeError as error:
        raise ValueError(f"Could not decode release checksums for '{tag}': {error}") from error
    checksums: dict[str, str] = {}
    for line in contents.splitlines():
        fields = line.split(maxsplit=1)
        if len(fields) != 2:
            raise ValueError(f"Malformed release checksum line for '{tag}': '{line}'")
        digest, name = fields
        if not SHA256_HEX.fullmatch(digest) or "/" in name or name.startswith("*"):
            raise ValueError(f"Invalid release checksum line for '{tag}': '{line}'")
        url = release_asset_url(tag, name)
        if url in checksums:
            raise ValueError(f"Duplicate release checksum for '{url}'")
        checksums[url] = digest
    if not checksums:
        raise ValueError(f"No release checksums for '{tag}'")
    return checksums


def _error_tail(error: subprocess.CalledProcessError | subprocess.TimeoutExpired) -> str:
    """Return the last 6000 characters of a failed subprocess's captured output.

    Parameters:
        error (subprocess.CalledProcessError | subprocess.TimeoutExpired): the failure; its
            `output` may be `str`, `bytes` or `None`.

    Returns:
        str: decoded output tail, empty when nothing was captured.
    """
    output = error.output or ""
    if isinstance(output, bytes):
        output = output.decode("utf-8", errors="replace")
    return redact_diagnostic(output)[-6000:]


def attestation_bundle(repo: str, path: Path, destination: Path) -> Path:
    """Download the public GitHub attestation bundles for one artifact digest, without credentials.

    The attestations API answers anonymously for public repositories, so a verifier needs no
    GitHub login and no token ever leaves the machine. The bundles are only inputs to
    `gh attestation verify --bundle`, which checks them; they are trusted for nothing else.

    Parameters:
        repo (str): `owner/name` that must have produced the attestation.
        path (Path): artifact whose SHA-256 selects the attestations.
        destination (Path): JSON Lines file to write, one Sigstore bundle per line.

    Returns:
        Path: `destination`.

    Raises:
        AttestationRateLimitedError: GitHub's anonymous rate limit refused the request.
        RuntimeError: the API could not be read, answered malformed JSON, or lists no attestation.
    """
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    url = f"{ATTESTATIONS_API}/repos/{repo}/attestations/sha256:{digest}"
    request = Request(url, headers={"Accept": "application/vnd.github+json"})
    try:
        document = json.loads(fetch_bytes(request))
    except FetchError as error:
        if error.status in RATE_LIMIT_STATUSES:
            raise AttestationRateLimitedError(f"Anonymous attestations API refused: {error}") from error
        raise RuntimeError(f"Attestation lookup failed for '{path.name}': {error}") from error
    except (OSError, ValueError) as error:
        raise RuntimeError(f"Could not read attestations for '{path.name}' from '{url}': {error}") from error
    attestations = document.get("attestations") if isinstance(document, dict) else None
    bundles = [item.get("bundle") for item in attestations or [] if isinstance(item, dict)]
    if not bundles or not all(isinstance(bundle, dict) for bundle in bundles):
        raise RuntimeError(f"No attestation bundle for '{path.name}' (sha256 '{digest}') in '{repo}'")
    destination.write_text("".join(json.dumps(bundle) + "\n" for bundle in bundles))
    return destination


def verify_attestation(
    path: Path,
    repo: str,
    signer_workflow: str,
    source_ref: str,
    bundle: Path | None = None,
    *,
    gh_bin: str | None = None,
) -> None:
    """Require GitHub build provenance for one artifact from an exact repository, workflow and ref.

    Parameters:
        path (Path): artifact to verify.
        repo (str): `owner/name` the attestation must belong to.
        signer_workflow (str): `owner/name/.github/workflows/<file>` that must have signed it.
        source_ref (str): exact Git ref the signing run must have built.
        bundle (Path | None): local bundle file; absent, `gh` fetches with its own login.
        gh_bin (str | None): preflight-selected dispatcher path, default `GH_BIN`.

    Raises:
        FileNotFoundError: GitHub CLI is unavailable.
        RuntimeError: the artifact lacks the required provenance identity.
    """
    gh_bin = str(Path(gh_bin or GH_BIN).absolute())
    if not Path(gh_bin).is_file():
        raise FileNotFoundError(f"Attestation verification requires `gh` at '{gh_bin}'")
    # A local bundle needs no GitHub API call, so `gh` gets a token only when it must fetch.
    env = child_environment(os.environ, github_tokens=bundle is None)
    try:
        subprocess.check_output(
            [
                gh_bin,
                "attestation",
                "verify",
                str(path),
                *(["--bundle", str(bundle)] if bundle is not None else []),
                "--repo",
                repo,
                "--signer-workflow",
                signer_workflow,
                "--source-ref",
                source_ref,
                "--deny-self-hosted-runners",
            ],
            env=env,
            text=True,
            stderr=subprocess.STDOUT,
            timeout=120,
        )
    except (OSError, subprocess.SubprocessError) as error:
        detail = (
            _error_tail(error)
            if isinstance(error, (subprocess.CalledProcessError, subprocess.TimeoutExpired))
            else str(error)
        )
        failure = detached_exception(
            RuntimeError(f"GitHub provenance verification failed for '{path}': {detail}"), error
        )
    else:
        return
    raise failure from failure.__cause__


def verify_public_attestation(
    path: Path, repo: str, signer_workflow: str, source_ref: str, *, gh_bin: str | None = None
) -> None:
    """Verify provenance from the anonymous bundle, falling back to `gh`'s own login when rate-limited.

    The fallback lets `gh` fetch the attestation with whatever login it already has (`gh auth
    login` or `GH_TOKEN`); this module never reads a credential. Without one, the rate limit
    stays a verification failure.

    Parameters:
        path (Path): artifact to verify.
        repo (str): `owner/name` the attestation must belong to.
        signer_workflow (str): workflow that must have signed it.
        source_ref (str): exact Git ref the signing run must have built.
        gh_bin (str | None): preflight-selected dispatcher path, default `GH_BIN`.

    Raises:
        FileNotFoundError: GitHub CLI is unavailable.
        RuntimeError: no bundle exists, or the artifact lacks the required provenance identity.
    """
    try:
        bundle: Path | None = attestation_bundle(repo, path, path.with_name(f"{path.name}.sigstore.jsonl"))
    except AttestationRateLimitedError as error:
        LOGGER.warning(
            redact_diagnostic(f"{error}; retrying with `gh attestation verify` and gh's own login")
        )
        bundle = None
    verify_attestation(path, repo, signer_workflow, source_ref, bundle, gh_bin=gh_bin)


def verify_provenance(path: Path, tag: str, bundle: Path | None = None) -> None:
    """Require GitHub provenance from the dedicated core-release workflow.

    Parameters:
        path (Path): downloaded release artifact.
        tag (str): exact core tag bound to the source ref.
        bundle (Path | None): local attestation bundle; absent, `gh` fetches with its own login.

    Raises:
        FileNotFoundError: GitHub CLI is unavailable.
        RuntimeError: the artifact lacks the required provenance identity.
    """
    verify_attestation(path, CORE_REPO, ATTESTATION_WORKFLOW, f"refs/tags/{tag}", bundle)


def verify_provenance_anonymously(path: Path, tag: str, *, gh_bin: str | None = None) -> None:
    """Verify core provenance from the public attestation bundle (see `verify_public_attestation`).

    Parameters:
        path (Path): downloaded release artifact.
        tag (str): exact core tag bound to the source ref.
        gh_bin (str | None): preflight-selected dispatcher path, default `GH_BIN`.

    Raises:
        FileNotFoundError: GitHub CLI is unavailable.
        RuntimeError: no bundle exists or it does not prove the required identity.
    """
    verify_public_attestation(path, CORE_REPO, ATTESTATION_WORKFLOW, f"refs/tags/{tag}", gh_bin=gh_bin)


def verify_asset(path: Path, url: str, checksums: Mapping[str, str]) -> None:
    """Require downloaded bytes to match a recorded release identity.

    Parameters:
        path (Path): downloaded asset.
        url (str): canonical release URL.
        checksums (dict[str, str]): tag's recorded assets.

    Raises:
        ValueError: no recorded checksum for this asset or its bytes disagree.
    """
    if url not in checksums:
        raise ValueError(f"No recorded release checksum for '{url}'")
    actual = hashlib.sha256(path.read_bytes()).hexdigest()
    if checksums[url] != actual:
        raise ValueError(
            f"Release checksum mismatch for '{url}': '{actual}', expected '{checksums.get(url)}'"
        )
    LOGGER.info(f"Release asset '{url}' sha256={actual}")


def download_verified_asset(
    url: str,
    tag: str,
    checksums: Mapping[str, str],
    destination: Path,
    provenance: ProvenanceCheck | None = None,
) -> Path:
    """Download one release asset, then require its recorded sha256 and, for new tags, provenance.

    Parameters:
        url (str): canonical release URL.
        tag (str): exact core tag the URL belongs to.
        checksums (Mapping[str, str]): the tag's recorded assets.
        destination (Path): file to write.
        provenance (ProvenanceCheck | None): per-asset verifier taking the asset and tag;
            defaults to `verify_provenance` (the caller's `gh` login).

    Returns:
        Path: `destination`, whose bytes are verified.

    Raises:
        ValueError: no recorded checksum or the bytes disagree.
        RuntimeError: a non-legacy asset lacks the required provenance.
        FileNotFoundError: a non-legacy asset needs `gh`, which is unavailable.
        FetchError: the public download failed with a normalized URL/reason diagnostic.
        OSError: writing the downloaded bytes to `destination` failed.
    """
    destination.write_bytes(fetch_bytes(url))
    verify_asset(destination, url, checksums)
    if tag not in LEGACY_RELEASE_TAGS:
        (provenance or verify_provenance)(destination, tag)
    return destination


def _npm_integrity(path: Path) -> str:
    """Return the npm SRI string (`sha512-<base64>`) of a file's bytes.

    Parameters:
        path (Path): file to digest.

    Returns:
        str: SRI integrity value as written in `package-lock.json`.
    """
    return "sha512-" + base64.b64encode(hashlib.sha512(path.read_bytes()).digest()).decode("ascii")


def _read_json_object(path: Path) -> dict[str, object]:
    """Read a JSON file that must hold an object.

    Parameters:
        path (Path): `package.json` or `package-lock.json`.

    Returns:
        dict[str, object]: parsed object.

    Raises:
        ValueError: unreadable, invalid JSON, or not an object.
    """
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"Could not read JSON from '{path}': {error}") from error
    if not isinstance(data, dict):
        raise ValueError(f"Expected a JSON object in '{path}'")
    return data


def _root_override_pins(manifest: dict[str, object]) -> dict[str, tuple[str, str]]:
    """Parse the four required core overrides into exact `(tag, url)` pins.

    Parameters:
        manifest (dict[str, object]): root `package.json`.

    Returns:
        dict[str, tuple[str, str]]: package name -> (release tag, asset URL), in `RELEASE_PACKAGES` order.

    Raises:
        ValueError: a core override is missing, extra, not a plain release URL, or names a foreign asset.
    """
    overrides = manifest.get("overrides")
    if not isinstance(overrides, dict):
        raise ValueError("Root `package.json` has no `overrides` object")
    expected = [f"{ROOT_OVERRIDE_SCOPE}{package}" for package in RELEASE_PACKAGES]
    scoped = sorted(name for name in overrides if name.startswith(ROOT_OVERRIDE_SCOPE))
    if scoped != sorted(expected):
        raise ValueError(
            f"Root `{ROOT_OVERRIDE_SCOPE}*` overrides must be exactly {expected}, found {scoped}"
        )
    pins: dict[str, tuple[str, str]] = {}
    for package, name in zip(RELEASE_PACKAGES, expected, strict=True):
        url = overrides[name]
        if not isinstance(url, str) or not url.startswith(RELEASE_URL_PREFIX):
            raise ValueError(f"Override '{name}' must be a `{RELEASE_URL_PREFIX}` URL, found '{url}'")
        tag = url.removeprefix(RELEASE_URL_PREFIX).partition("/")[0]
        if TAG.fullmatch(tag) is None or url != release_package_urls(tag)[package]:
            raise ValueError(
                f"Override '{name}' is not the canonical '{package}' asset of a core tag: '{url}'"
            )
        pins[name] = (tag, url)
    return pins


def _locked_integrity(packages: dict[str, object], name: str, url: str) -> str:
    """Return the lockfile sha512 SRI of one override, requiring the lock to resolve exactly `url`.

    Parameters:
        packages (dict[str, object]): the lockfile's `packages` object.
        name (str): overridden package name.
        url (str): the override URL.

    Returns:
        str: the lockfile `integrity` value.

    Raises:
        ValueError: nested copies, a missing entry, a different `resolved`, or non-sha512 integrity.
    """
    nested = [path for path in packages if path.endswith(f"/node_modules/{name}")]
    if nested:
        raise ValueError(f"Nested lock entries {nested} bypass the override for '{name}'")
    entry = packages.get(f"node_modules/{name}")
    if not isinstance(entry, dict):
        raise ValueError(f"Lockfile has no `packages` entry for 'node_modules/{name}'")
    if entry.get("resolved") != url:
        raise ValueError(f"Lockfile `resolved` for '{name}' is '{entry.get('resolved')}', expected '{url}'")
    integrity = entry.get("integrity")
    if not isinstance(integrity, str) or not SRI_SHA512.fullmatch(integrity):
        raise ValueError(f"Lockfile `integrity` for '{name}' is not sha512 SRI: '{integrity}'")
    return integrity


def verify_root_overrides(root: Path) -> None:
    """Verify every root core override against the lockfile and the recorded release, before `npm ci`.

    For each of the four `@earendil-works` overrides: the lockfile `resolved` equals the override
    URL, its `integrity` is sha512 SRI, the downloaded tarball matches the tag's recorded sha256
    (frozen `LEGACY_CHECKSUMS` for legacy tags, a published `SHA256SUMS` covering all of
    `RELEASE_PACKAGES` otherwise) and the lockfile sha512, and non-legacy tags also pass
    `verify_provenance` at the exact tag. Tags come only from `package.json`, never a Gitlink.

    Parameters:
        root (Path): repository root holding `package.json` and `package-lock.json`.

    Raises:
        ValueError: any override, lock entry, checksum or integrity disagrees.
        RuntimeError: a non-legacy asset lacks the required provenance.
        FileNotFoundError: a non-legacy tag needs `gh`, which is unavailable.
        OSError: an asset download (including `URLError`) or scratch write failed.
    """
    pins = _root_override_pins(_read_json_object(root / "package.json"))
    packages = _read_json_object(root / "package-lock.json").get("packages")
    if not isinstance(packages, dict):
        raise ValueError(f"Lockfile '{root / 'package-lock.json'}' has no `packages` metadata")
    integrities = {name: _locked_integrity(packages, name, url) for name, (_tag, url) in pins.items()}
    checksums_by_tag: dict[str, dict[str, str]] = {}
    with tempfile.TemporaryDirectory(prefix="root-overrides-") as scratch:
        for name, (tag, url) in pins.items():
            if tag not in checksums_by_tag:
                checksums_by_tag[tag] = release_checksums(tag)
                missing = [u for u in release_package_urls(tag).values() if u not in checksums_by_tag[tag]]
                if missing and tag not in LEGACY_RELEASE_TAGS:
                    raise ValueError(f"Release '{tag}' does not publish checksums for {missing}")
            asset = Path(scratch) / name.removeprefix(ROOT_OVERRIDE_SCOPE)
            download_verified_asset(url, tag, checksums_by_tag[tag], asset)
            actual = _npm_integrity(asset)
            if actual != integrities[name]:
                raise ValueError(
                    f"Lockfile `integrity` mismatch for '{name}': '{actual}', expected '{integrities[name]}'"
                )
            LOGGER.info(f"Root override '{name}' verified at '{tag}'")


def prune_native(node_modules: Path, system: str, arch: str) -> None:
    """Keep only host-native prebuild directories, matching the formula.

    Parameters:
        node_modules (Path): coding-agent's nested dependencies.
        system (str): node OS name.
        arch (str): node architecture name.
    """
    for pattern, wanted in (
        ("koffi/build/koffi/*", f"{system}_{arch}"),
        ("@earendil-works/pi-tui/native/**/prebuilds/*", f"{system}-{arch}"),
    ):
        for directory in node_modules.glob(pattern):
            if directory.is_dir() and directory.name != wanted:
                shutil.rmtree(directory)


def release_tarballs(tag: str) -> list[str]:
    """Return the release tarball filenames of `RELEASE_PACKAGES` for one core tag, in order.

    Parameters:
        tag (str): core fork release tag.

    Returns:
        list[str]: filenames; the first two are the ones `fetch_release` installs.

    Raises:
        ValueError: not a core fork release tag.
    """
    return [url.rsplit("/", 1)[1] for url in release_package_urls(tag).values()]


def fetch_release(
    tag: str,
    prefix: Path,
    provenance: ProvenanceCheck | None = None,
    checksums: Mapping[str, str] | None = None,
    *,
    npm_bin: str | None = None,
) -> Path:
    """Verify every consumed release asset, then install into a new private prefix, never the live one.

    New tags must publish all of `RELEASE_PACKAGES`. Legacy tags are verified for exactly the assets
    in `LEGACY_CHECKSUMS`. Only coding-agent and tui are installed; `pi-agent-core` and `pi-ai` are
    verified because pi-harness's root overrides consume them.

    Parameters:
        tag (str): released core tag.
        prefix (Path): empty installation prefix.
        provenance (ProvenanceCheck | None): per-asset verifier taking the asset and tag;
            defaults to `verify_provenance` (the caller's `gh` login).
        checksums (Mapping[str, str] | None): release URL -> SHA-256 the downloaded bytes must
            match; defaults to `release_checksums(tag)`.
        npm_bin (str | None): preflight-selected dispatcher path, default `NPM_BIN`.

    Returns:
        Path: private pi executable.

    Raises:
        ValueError: invalid tag, nonempty prefix, or missing/mismatched recorded checksums.
        RuntimeError: provenance or npm installation failed.
        FileNotFoundError: npm is unavailable.
    """
    urls = list(release_package_urls(tag).values())
    if prefix.exists() and any(prefix.iterdir()):
        raise ValueError(f"Release prefix must be empty: '{prefix}'")
    checksums = dict(release_checksums(tag) if checksums is None else checksums)
    if tag in LEGACY_RELEASE_TAGS:
        urls = [url for url in urls if url in checksums]
    for url in urls:
        if url not in checksums:
            raise ValueError(f"No recorded release checksum for '{url}'")
    npm_bin = str(Path(npm_bin or NPM_BIN).absolute())
    if not Path(npm_bin).is_file():
        raise FileNotFoundError(f"Release installation requires `npm` at '{npm_bin}'")
    prefix.mkdir(parents=True, exist_ok=True)
    home = prefix / "fetch-home"
    home.mkdir()
    for name in ("npmrc-user", "npmrc-global"):
        (prefix / name).touch()
    env = {
        "PATH": os.environ.get("PATH", os.defpath),
        "HOME": str(home),
        "npm_config_userconfig": str(prefix / "npmrc-user"),
        "npm_config_globalconfig": str(prefix / "npmrc-global"),
        "npm_config_cache": str(prefix / "npm-cache"),
        "PI_SKIP_VERSION_CHECK": "1",
    }
    assets = []
    for url in urls:
        asset = prefix / url.rsplit("/", 1)[1]
        assets.append(download_verified_asset(url, tag, checksums, asset, provenance))
    try:
        subprocess.check_output(
            [
                npm_bin,
                "install",
                "--global",
                "--prefix",
                str(prefix),
                "--min-release-age=0",
                "--build-from-source",
                "--ignore-scripts",
                "--loglevel=silly",
                str(assets[0]),
            ],
            cwd=prefix,
            env=child_environment(os.environ, overrides=env),
            text=True,
            stderr=subprocess.STDOUT,
            timeout=600,
        )
    except (OSError, subprocess.SubprocessError) as error:
        detail = (
            _error_tail(error)
            if isinstance(error, (subprocess.CalledProcessError, subprocess.TimeoutExpired))
            else str(error)
        )
        failure = detached_exception(RuntimeError(f"Core release npm installation failed: {detail}"), error)
    else:
        failure = None
    if failure is not None:
        raise failure from failure.__cause__
    modules = prefix / "lib/node_modules/@earendil-works/pi-coding-agent/node_modules"
    destination = modules / "@earendil-works/pi-tui"
    if destination.exists():
        shutil.rmtree(destination)
    unpack = prefix / "tui-resource"
    with tarfile.open(assets[1]) as archive:
        archive.extractall(unpack, filter="data")
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(unpack / "package"), destination)
    system = "darwin" if platform.system() == "Darwin" else "linux"
    arch = "arm64" if platform.machine() in {"arm64", "aarch64"} else "x64"
    prune_native(modules, system, arch)
    binary = prefix / "bin/pi"
    LOGGER.info(f"Resolved binary '{binary}' from '{tag}'")
    return binary


def main() -> None:
    """Fetch a supplied tag or Gitlink tag, or verify the root overrides before `npm ci`."""
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0] if __doc__ else None)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--tag")
    source.add_argument("--gitlink", type=Path)
    source.add_argument(
        "--verify-root-overrides",
        action="store_true",
        help="verify the root `package.json` core overrides against the lockfile and release",
    )
    parser.add_argument("--prefix", type=Path, help="empty install prefix (with --tag or --gitlink)")
    parser.add_argument(
        "--root", type=Path, default=REPO_ROOT.parent, help="repository root for --verify-root-overrides"
    )
    args = parser.parse_args()
    if args.verify_root_overrides:
        if args.prefix is not None:
            parser.error("`--prefix` does not apply to `--verify-root-overrides`")
        try:
            verify_root_overrides(args.root.resolve())
        except (ValueError, RuntimeError, OSError) as error:
            failure = detached_exception(
                SystemExit(f"Root core override verification failed: {error}"), error
            )
        else:
            return
        raise failure from failure.__cause__
    if args.prefix is None:
        parser.error("`--prefix` is required with `--tag` or `--gitlink`")
    tag = args.tag or gitlink_tag(args.gitlink.resolve())
    fetch_release(tag, args.prefix.resolve())


if __name__ == "__main__":
    main()
