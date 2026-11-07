# Bun standalone evidence

CI scope (2026-10-29, auth skips removed 2026-11-07, #14):

- Previously `.github/workflows/ci.yml` ran only the release-tarball Node bundle for D/E, across
  two OSes and two stacks. `owned`'s Bun package/in-process tests were not standalone coverage.
  The release API for `v1.3.0-nredd.8` confirms the coding-agent and pi-tui npm tarballs and no standalone archive
- Each existing `stack (..., personal)` job builds Gitlink `4af3d547ef0f78ed077ce7a373cdeebfc9e5cd6e`
  (`v1.3.0-nredd.8`) using root `.bun-version` (1.4.4; upgrade evidence [here](bun-upgrade.md)); the core has no `.bun-version` file.
  They restore npm release model data, run the official `forks/pi/scripts/build-binaries.sh`
  with `--offline-model-data`, and execute the native archive on macOS ARM64 and Linux x64.
  Each running `stack` cell builds for its own explicit stack. No binaries are committed or published
- No auth case is skipped (#14): `NODE_OPTIONS --import` is ignored by the standalone, so
  `integration/harness/anthropic_mock.py::anthropic_env` also sets `BUN_OPTIONS --preload`.
  `providers/redirect_anthropic.mjs` and `providers/auth_guard.mjs` implement the hook;
  `test_request_uses_auth_json_token_with_claude_code_headers[missing-preload]` still exercises
  fail-closed startup on standalone
- No selected D/E scenario scales timers (`fast_timers.mjs` is deleted, #378) or uses `--expose-gc`.
  Injected-clock behavior is native; GC instrumentation is confined to excluded render benches
  (`integration/harness/probe.py`, `scenarios/bench/test_render.py`), whose probe now falls back to
  `Bun.gc(true)` when `--expose-gc` is unavailable. Not run on a compiled standalone (tracked in #628). The actual adapter issue is
  [here](https://github.com/nredd/pi-harness/issues/14), not the nonexistent repository issue #58
- NOT RUN: Linux ARM64 (no `ubuntu-24.04-arm` job), other architectures/Windows,
  packed contracts under standalone, benchmarks, live credentials and desktop/TCC helpers.
  REA was retired in `nredd/dotfiles#58`; it is not an outstanding Bun or release requirement.
  This is a source-build D/E gate, not full Bun acceptance or a published-artifact gate
- CI results, run IDs and measured runner cost belong in the draft PR; job definitions alone are
  not evidence that these new runs pass. See [here](ci.md) for the zero-added-job capacity budget

## Runtime hook adapter (#14)

`integration/harness/runtime_hooks.py::runtime_hooks` is the one place that spells a harness hook
for both runtimes: `NODE_OPTIONS` (`--import`, `--expose-gc`) for Node and `BUN_OPTIONS`
(`--preload`, `--expose-gc`) for a compiled Bun standalone. `anthropic_env` (auth redirect) and
`probe_args` (`--expose-gc`) both use it. Bun 1.4.4 evidence (2026-11-06, compiled `bun build
--compile`, `tests/test_runtime_hooks.py`):

- `NODE_OPTIONS` with `--import`, `--require` or `--expose-gc` is ignored by the standalone
- `BUN_OPTIONS=--preload <module>` and `BUN_OPTIONS=--expose-gc` are honored by the standalone and
  by `bun <file>`; Node ignores `BUN_OPTIONS`, so setting both is safe
- `BUN_OPTIONS` does not parse quotes: a `--preload "<path with space>"` is silently dropped, so
  the adapter refuses preload paths holding whitespace or quotes
- Fast timers: no scenario scales timers any more (`fast_timers.mjs` was deleted, #378), so there is
  no timer preload to adapt. The issue comment attributes the old `/loop` and footer-poll failures
  to that preload. Re-run on the compiled core (2026-11-06, Gitlink `4af3d547`, Bun 1.4.4
  darwin-arm64 standalone, personal stack with `pi-session-kit` 0.9.0, real time, no scaling,
  throwaway probe not committed): `/loop 30s` was observed with one run 39 s after submit (the probe polled `/loop list` every ~9 s, so that bounds the 30 s tick, not its precision) and the
  footer's usage poll repeated 60.002 s after the first. The old Python scenarios themselves were
  ported to in-process tests and no longer exist (`787f72f1`)

The render probe keeps its `Bun.gc(true)` fallback behind the adapter's `--expose-gc`.

## Auth runtime adapter (#14)

The harness sets both `NODE_OPTIONS=--import <redirect>` and
`BUN_OPTIONS=--preload <redirect>` through that adapter. Compiled Bun 1.4.4 honors the latter
before its entrypoint; Node continues using the former. Both load the same harness-only
fetch/egress hook. No SDK, production extension, live configuration, timer behavior or runtime pin
changes.

`auth_guard.mjs` still runs readiness during extension factory loading, before session-start
warmup or auth dispatch: a per-launch identity nonce, refused non-loopback fetch, then a real
loopback echo. Invalid mock origins fail before hook installation; redirects are disabled so an
HTTP redirect cannot escape interception. Both Node child-process and direct Bun spawn calls
refuse `claude`/`security`. This is instrumentation, NOT a sandbox against arbitrary subprocess,
native-addon, socket or deliberately hostile extension activity.

Local native fixture evidence (2026-10-29): `tests/test_auth_runtime.py` compiles the two-module
fixture with pinned Bun and directly executes that native artifact. Before adding `BUN_OPTIONS`
to `anthropic_env`, its admission test failed with `redirect preload is missing`; the missing-hook
negative control passed. After wiring the hook, admission and refusal pass. The fixture uses the
real hook, shared readiness verifier, recording loopback server and fake-only environment. It
also exercises replaced fetch, identity/echo/egress failures, unsafe mock origins, forbidden
Node/Bun subprocess APIs and a real HTTP redirect that must not reach its destination. It is
NOT the compiled Pi core and proves no auth shaping, router dispatch or refresh acceptance.

The unchanged shaping, direct/router/API-key/custom, refresh persistence/refusal and missing-hook
assertions run on the actual compiled core inside the ordinary standalone D/E step of each stack;
the `--bun-auth-adapter` opt-in and its candidate steps are gone. Hosted receipts before removal
(`redd/issue-14-runtime-adapter` PR run 42335928288, `standalone-auth-*.xml`): linux-x64 personal,
linux-x64 local and darwin-arm64 local each 8 tests, 0 skipped, 0 failures. macOS `personal` is not a
CI cell. Linux ARM64, packed contracts and published-artifact acceptance remain outside this gate.

Historical local evidence below predates the rebuilt integration gate. Do not treat the old
`pi-harness-e2e` failures or smoke results as execution evidence for the new Gitlink/CI jobs.

## Initial prerequisite checkpoint

This is a local macOS ARM64 build/smoke and Linux cross-build checkpoint, **not** full-stack or release acceptance.
No live installation, tap, pin, auth store, or desktop state was changed.

Source and toolchain:

- Core tag `v1.3.0-nredd.2`, commit `dba4cfa6d072f41b548d2c5498d5742268b6449f`.
- Bun `1.3.14+0d9b296af`, matching the source CI pin; downloaded into an isolated tool directory
  and checked against the official release SHA256 list. System Bun was not replaced.
- Node `26.12.0`, npm `11.20.0`; this differs from the source CI's Node 22 build environment.
- New clean fork worktree; `npm ci --ignore-scripts`; release model data restored from
  `@earendil-works/pi-ai@1.3.0`, including its manifest; `npm run build:offline`.
- Official `scripts/build-binaries.sh --skip-install --skip-build --platform darwin-arm64 --out <output>`.

Observed on 2026-10-16:

| Check | Result |
|---|---|
| Offline package build | Exit 0 |
| Official standalone build | Exit 0 |
| Artifact format | Mach-O ARM64 executable |
| `pi --version` | `1.3.0`, exit 0 |
| `pi --help` | Usage, exit 0 |
| `scripts/smoke-test-codemode-binary.mjs <binary>` | `PI_CODEMODE_BINARY_SMOKE_OK`, exit 0; independently rerun with the same result |

The same official build script also cross-compiled `linux-arm64` and baseline `linux-x64` with
Bun 1.3.14, each into a separate output directory. Both commands exited 0; `file` identified the
expected ARM aarch64 and x86-64 ELF executables. Neither Linux artifact has been executed yet.
Their archive SHA256 values are:

- Linux ARM64: `b12653564358c9886118d0d832a1c65c7e5e7efafb3393af34ed14a07af92cc8`.
- Linux x64: `02a469684d584e31a92377373848ebfcacac6146efc0b0973bd15193f82b8750`.

The smoke runs used a cleared environment, temporary HOME/agent directory, offline mode, and the
script's loopback-only faux provider. No real credentials were copied. The codemode smoke exercises
an embedded worker through the actual compiled binary, not a standalone Bun script.

Artifact SHA256 values (local candidate, not published release assets):

- Executable: `deb684fd30e096e25f7b0b095c97a0b719a8e8bedf47f8b903874e9b10f1cac5`.
- Archive: `84a1c8ac353e278467f6cd593e13ee1ded9d4693162a8df8648a6be591dffb4e`.

Additional isolated compiled-host probes observed correct host-module member identity and the real
session-kit `BoundedMatcher` normal, timeout, invalid-regex, and close-with-queued-work behavior.
An independent rerun observed five matching worker runs: pathological input returned conservatively
in 103-104 ms while the event loop progressed; worker close completed in 213-248 ms. These are
scratch-probe observations, not yet portable checked-in regression coverage.

The compiled executable ignores `NODE_OPTIONS` preloads. A scratch `BUN_OPTIONS --preload` adapter
with a readiness handshake redirected fetch and blocked `node:child_process`, but direct
`Bun.spawn*` bypassed that guard. Do not run the auth dispatch/refresh harness under the compiled binary until its
runtime adapter is integrated and fails closed. The new CI explicitly skips those branches;
only the existing missing-preload refusal is exercised without interception. Do not mistake a probe adapter for a sandbox.

At that historical checkpoint, remaining work included integrated interception readiness, packed
plugins, model-role behavior, subagents, Plan mode, full monitor/process cleanup, TUI scenarios,
native helpers, REA, full integration and performance gates, and both Linux architectures.
REA is now retired and is no longer required. The local executable is unsigned/unnotarized.

Dependency audit:

- `npm audit --json` returned nonzero with two high entries for one chain:
  the example workspace `pi-extension-gondolin` -> `@earendil-works/gondolin@0.12.0` ->
  `node-forge@1.4.0`, [GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv).
- `npm explain node-forge` confirms that chain. npm reports no available fix.
- The archive contains the Gondolin example source and package metadata, but no `node_modules`
  directory. This does not by itself prove whether vulnerable code is absent from the compiled binary.
- `npm audit --workspace packages/coding-agent --omit=dev --json` exited 0 with no findings. This
  narrower runtime-workspace result does not clear the full workspace's example dependency finding.
- No dependency was changed and no security waiver was applied. Release impact/remediation remains
  unresolved; successful smoke tests do not clear this audit finding.

2026-10-18, first full `pi-harness-e2e` gate against the darwin-arm64 Bun 1.3.14 standalone built from the
`v1.3.0-nredd.3` tree (binary SHA256
`370dc52cd4c76cd13f82ab0f05c2956c5ed6473dfaeb1df8d3f505f4a5f3da7d`, logs `pi-harness-builds/bun-checklist-20261018/`):

- unit 93 passed; fast 140 passed, 10 failed, 1 skipped (no enterprise manifest on this machine; the
  failures are all the documented Anthropic auth refusals: Bun ignores the
  `NODE_OPTIONS` preload, so the harness refuses before any request); tui+bench 105 passed, 18 failed
- 13 TUI failures are deterministic under Bun and pass on Node in the same session, all `pi-session-kit`
  timer behavior (quota footer never polls, `/loop` never ticks): nredd/pi-harness#14
- `bench/test_render_2k_message_transcript`: the probe needs `--expose-gc`, which Bun lacks (same issue; the probe now uses `Bun.gc(true)`, see above)
- `bench/test_multi_session_responsiveness` `ms_input_p95_n4` 11.4-12.5ms vs the 9.9ms limit under Bun;
  three `typed_vs_bash` cases failed in the suite and passed alone (order-dependent, not re-run further)
- Checklist items 5.x remain open; the Node/Homebrew tree is the only shipped runtime. Trust cases A-F and the
  fatal-startup matrix stay identical across runtimes (`verify-8754b00/`)
