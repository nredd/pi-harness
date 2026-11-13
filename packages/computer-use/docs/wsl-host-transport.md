# WSL host transport

This is an opt-in transport to the existing Windows Rust helper, not a new Windows UIA implementation. Default Linux/WSLg behavior is unchanged. No helper is downloaded, installed, compiled or repaired, no PowerShell is started, and interop is never enabled automatically.

Provision a trusted protocol-v4 Windows helper yourself on a host volume. Verify its source/build provenance independently and record its SHA-256. From an interactive WSL guest with interop already available, set these variables before starting Pi (synthetic paths below):

```sh
export PI_COMPUTER_USE_WSL_HOST=1
export PI_COMPUTER_USE_WSL_HOST_HELPER=/mnt/c/Example/pi-computer-use/windows-bridge.exe
export PI_COMPUTER_USE_WSL_HOST_SHA256='<verified-64-hex-sha256>'
export PI_COMPUTER_USE_WSL_HOST_LOCK=/mnt/c/Example/pi-computer-use/shared-input-lease
```

The helper must be a canonical executable regular file, without symlinks, at most 64MiB. The digest is checked before each command; normal startup also checks protocol v4 and the existing architecture invariants. This is an explicit executable pin, not Authenticode verification or a sandbox. Keep the helper, its parent directory and the lease's parent directory writable only by the trusted desktop owner. Same-user replacement between verification and execution remains possible. Do not place the executable or lease on a network filesystem.

The lease path names a directory that does not yet exist, in an existing host-volume directory. Every participating WSL session/distro MUST use the same physical lease path even if their helper locations differ. Directory creation serializes whole requests, including `actBatch`, across these sessions. It does not coordinate unrelated Windows-native helpers, other automation programs or the human user; do not run them concurrently. No persistent lock owner metadata or private UI text is written.

One helper process is retained per transport. Requests are JSON lines on stdio, without a shell or PATH lookup. The transport caps a request at 1MiB, a response at 8MiB and queued commands at 32. Each command has one 15-second default deadline for queueing and UIA response, configurable by the backend up to 30 seconds. Bad/mismatched/extra frames, oversized output, disconnect, timeout or cancellation after delivery close the transport permanently and retain the lease. Local cancellation cannot prove Windows work stopped: Linux may only have killed an interop proxy. The owner must stop all relevant host helpers and verify no host work remains before manually removing the retained directory and restarting Pi. Never steal or age out a lease. An acknowledged helper refusal releases it normally, with the error code but not the helper's raw message.

The backend reuses Windows discovery, scoped observation, UIA read/wait and atomic batch mapping. It forwards negative multi-monitor coordinates and scale factors unchanged; per-monitor-v2 DPI setup, pattern probing/fallback, fresh target rectangles, capture and focus behavior remain the existing Windows helper's responsibility. It does not add screen-reader state changes, capture hash polling or new focus workarounds. Managed browser launches still run in the Linux guest; whole-desktop tools remain macOS-only. This is not transparent Windows browser launching.

Safety:
- `CI` rejects the opt-in; absence of `CI` is not a security boundary against a user who can execute arbitrary code.
- Never enable interop on secure CI guests, privileged hosts or the ARM64 runner pool to test this feature.
- This bridge exposes the owner's Windows desktop to trusted Pi code. Existing platform restrictions still apply; it is not a credential isolation mechanism.

Verification:
- `test/wsl-host-helper.test.mjs` uses disposable POSIX executable fixtures and synthetic JSON only. It exercises actual stdio reuse, fragmented output, process disconnect, digest refusal, abort, frame limits, deadlines and lease contention without native UI calls.
- Native Windows compilation/coverage belongs to issue #696, not this transport change.
- Actual WSL-to-Windows interop, UIA on Electron/WebView2, multi-monitor DPI/capture, minimized/foreground behavior and physical input acceptance are NOT RUN. Issue #673 remains open for these desktop acceptance cases. No GUI action is authorized by this transport implementation.
