# Package contracts

`make check-package-contracts` proves the three plugin tarballs work alone against exact stock Pi.
It is explicit and separate from `make check`: it needs the npm registry on first use (to install
stock Pi) and runs real Pi processes. The tooling itself (`scripts/package_contracts.py`,
`scripts/faux_provider.py`) is unit tested by `make check-scripts`.

Pinned identity (constants in `scripts/package_contracts.py`, never "latest"):

- Stock Pi: `@earendil-works/pi-coding-agent@1.3.0`, integrity
  `sha512-V/WoCjA2hQSe3QLWIUB24cTRdtEdeLiIzkDqU5RMXV6VWuD+KGZnzVBMhglwdnQTySkehZsjt8a3g6Jd2g4nnw==`
- Installed with `npm install --ignore-scripts` into `~/code/pi-harness-builds/tools/pi-stock-1.3.0`
  (override with `--stock-prefix`), outside the source tree and reused. A mismatched lockfile
  integrity or `pi --version` fails the gate
- `--report FILE` (`make check-package-contracts REPORT=/abs/file.json`) records Pi, Node, npm, the
  `LICENSE` digest, and per package the version, tarball name, `sha512` integrity, `sha1`, size,
  file list and scenario evidence. The output meaning and key order are unchanged
- The report is a validated Pydantic model (`ContractReport`, `pydantic` added to the `integration` uv
  environment, which runs `scripts/`) built at the serialization boundary; scenarios return
  `TypedDict` evidence shapes. Malformed digests, versions, tarball names, duplicate files, evidence
  of the wrong package or with extra/missing fields, and a stock Pi identity other than the pins
  fail the gate instead of being written. `npm pack --json` output is validated the same way and its
  `sha512`/`sha1` are recomputed from the tarball bytes
- Every other consumed JSON document is validated before it can become evidence, and a malformed
  one is a `ContractError` (or an HTTP 400 from the faux provider), never a traceback or an
  apparently valid result. Only consumed fields are modelled, with strict types (no `"1"` -> `1`,
  no `true` -> `1`):
  - packed `package.json`: `name`, `private`, `publishConfig.access`, `license`, the four dependency
    fields, `peerDependencies`, `pi.extensions` (`PackedManifest`). A wrong type (`peerDependencies: []`,
    `pi: null`, `extensions: "x"`) is reported as `field ... is malformed`. Any other npm metadata is
    ignored on purpose, whatever its shape; invalid JSON or a non-object manifest is a violation
  - stats export/import stdout and `manifest.json`, per `docs/stats-snapshots.md` in session-kit
    (`StatsExportResult`, `StatsImportResult`, `StatsManifest`): exact keys, UUID v4, month,
    `file == <month>-<sha256>.json`, unique months, byte/time bounds, `problems` a list of strings.
    The shard files are not read here; the artifact's own import validates them
  - lockfiles (`packages` map), Pi `tool_execution_end` (`result.content`, boolean `isError`,
    `structuredContent` object-or-absent) and `message_end` (object `message`, string
    `role`/`provider`/`model`), and the faux provider request (`model`, `messages[].role`,
    `tools[].function.name`). Tool payloads inside `structuredContent` stay opaque until the one
    scenario that reads them (`git_status.untracked`). Not modelled: the rest of Pi's event stream

`@nredd/pi-plan-mode` is a separately invoked stock contract because it has the explicit runtime
`@narumitw/pi-tui-kit` dependency. `make check-plan-mode-package-contract` packs it, verifies its own
upstream MIT `LICENSE`, exact manifest dependency, manifest `files` list and the complete packed payload
(`packed_files` exact paths plus `packed_patterns` for the build-hashed `dist/chunks/*.ts(.map)`, each with
an exact count and an 8-character hash, so a rebuild is fine but a stray file is not; duplicated paths
fail, each chunk `.map` must pair with its `.ts`, every chunk must be reachable from `dist/index.ts`
by relative imports, and any non-regular tar member such as a symlink or hardlink fails), installs the
tarball, and requires
`plan_mode_question` and `plan_mode_complete` from stock Pi. The faux provider enters Plan mode with
`/plan <prompt>`, calls `plan_mode_question`, and the scenario records its explicit headless
`ui_unavailable` result. `dist/` is required and packed because its extension manifest targets
`./dist/index.ts`; `src/` stays packed as declared by the source package. Its native `npm run check`
first rebuilds and byte-compares every committed `dist/` file, so stale, missing, or extra generated
output fails before the ordinary package build.

`@nredd/pi-todo` is also a separately invoked stock contract because its imported runtime dependencies
`@juicesharp/rpiv-config` and `@juicesharp/rpiv-i18n` are installed from the registry. `make check-todo-package-contract`
packs the public plugin, verifies its retained upstream MIT `LICENSE`, dependency closure and narrow source
payload, then runs stock Pi with only that package loaded. The faux provider calls `todo` to create a task and
the contract records the subject from the tool result's `details.tasks[0]` snapshot, which the extension also
appends to the session branch; discovery alone is not sufficient evidence.

What each package must satisfy:

- `npm pack` contents match a narrow allowlist: `src/`, `LICENSE`, `README.md`, `package.json`, plus
  `CHANGELOG.md` (router), `dist/pi-stats-export.mjs`, `docs/stats-snapshots.md` and
  `docs/mon-dashboard.md` (session-kit, all required: the README links both docs, see
  `test_session_kit_readme_links_only_packed_files`) and
  `dist/` + `docs/` (plan-mode, additionally pinned by `packed_files`/`packed_patterns`). computer-use is
  also pinned by exact `packed_files`, including upstream's moved `docs/content/docs` pages and
  `activity_glow.swift` alongside the cursor/helper sources.
  Tests, fixtures, `e2e/`, lint/TS/vitest config and planning docs must not ship. Before this change
  none of the tarballs had a `LICENSE` and all shipped `test/` plus dev config
- Packed `LICENSE` is byte-identical to the root `LICENSE`, except imported packages marked `own_license`,
  whose upstream MIT copyright text must be byte-identical to their workspace `LICENSE`
- Manifest: `private` absent or `false`, `publishConfig.access: public`, `MIT`, no optional/bundled
  dependencies, peers only from the Pi host set (`@earendil-works/pi-ai`,
  `pi-agent-core`, `pi-coding-agent`, `pi-tui`, `typebox`) with range `*`, `pi.extensions` present
- Every import is a `node:` builtin, a host module, a declared runtime dependency, or a relative path
  inside the package. No `@nredd/*` sibling, with one narrow exception: an exact `SHARED_LIBRARIES`
  specifier (only the `library=True` `@nredd/pi-resource-sampler`) that the importing plugin's
  contract also declares as an exact runtime dependency at `RESOURCE_SAMPLER_VERSION`.
  `SHARED_LIBRARIES` maps each library to that common pin, and `shared_library_pin_problems` (run by
  `audit_manifest`, and over every contract in the tests) refuses a consumer declaring any other exact
  version, so the two consumers cannot drift apart. Both constants are defined once, in
  `scripts/package_contracts.py`, and serve both consumers: dev-tools' `resource_snapshot` (#128)
  and session-kit's `/mon` (#123). Bare specifier only. Deep imports,
  undeclared or ranged dependencies, `workspace:`/`file:` specs, imports from a library and imports
  from a standalone artifact (session-kit's stats `dist/`) all stay violations; whichever PR lands
  second keeps this one definition and the library/standalone guard. The stats artifact (`dist/`)
  may import only `node:` builtins: the standalone
  check runs before relative-import resolution, so `../src/index.ts` is rejected even if it exists
- Imports are read with the repository's installed TypeScript 7.0.2 parser (`scripts/import_audit.ts`
  via `typescript/unstable/sync`, which drives the bundled `tsgo`; no new dependency, one batched
  `node` run per package). It sees static imports and re-exports (including `import type`),
  `import x = require()`, `import("x")` types, dynamic `import()` and `require()` calls, with plain
  string and no-substitution template specifiers resolved. A computed specifier (template with
  `${}`, concatenation, a variable, a missing argument) is a violation reported as `file:line:col`,
  not skipped, and so is a file with syntax errors. Comments and string literals are ignored because
  they are not syntax. Limits: this is a syntactic audit, not a security proof. It does not see
  `eval`, `new Function`, `createRequire()(...)` results, `import.meta.resolve` or JSDoc `@import`
  tags, and a local `require` shadow is still treated as `require`
- Fresh install (`--ignore-scripts --legacy-peer-deps`, mirroring Pi's suppressed peer installs;
  `--offline` unless the contract declares runtime dependencies, which come from the registry, so
  dev-tools now needs the registry for its exact sampler): dependency-free packages have exactly the
  package in `node_modules` and the lockfile. A package
  with declared runtime dependencies instead has exactly the closure derived from each INSTALLED
  `node_modules/**/package.json` (`dependencies` + `optionalDependencies`, resolved npm-style by walking up
  from the requirer's `node_modules`, so nested paths work). That closure must equal the lockfile paths,
  every installed package path and the top-level directories; every entry under every `node_modules`
  (manifest or not) must be a closure path, and a scope directory needs a closure child. The only
  exemptions are npm's own: `.package-lock.json` as a regular file in the top-level `node_modules`, and
  `.bin` as a real directory holding only files or symlinks. Any other symlinked entry, or a loop, is a
  `ContractError`. Each installed `name` must match its path and every installed dependency edge's
  resolved version must satisfy its declared range (the repository's `semver`). Lock-only paths are
  allowed only when `optional: true` and an installed requirer lists them in `optionalDependencies`. A
  missing required dependency is a `ContractError`. The lockfile is never trusted for transitive edges
- Stock Pi, `--mode json` with `--no-extensions --extension <installed dir>` (only that package),
  `--no-mcp`, `--offline`, no skills/templates/themes/context files, `--no-approve`:
  - dev-tools: a real `git_status` result on a disposable repo (`untracked.txt`), and an error result
    outside a repository. Then a real parent-child discovery: the gate starts an idle, small `node`
    child whose argv[0], process title and Linux comm hold a random 32-hex secret, first proving the
    sampler 0.1.0 name source (`ps -c` comm on Darwin, `/proc/PID/comm` on Linux) shows it. One
    unranked scan by the sampler the installed plugin directory resolves (checked to be
    the installed registry copy) must contain exactly that PID with `parentPid` equal to the gate
    process, confirmed by an independent `/bin/ps`. Inclusion is not tied to the tool's top-50
    ranking, so a host with many larger or busier processes cannot hide it. The scan need NOT be
    complete: any process exiting mid-scan marks it partial, so requiring `coverage.complete` would
    make the gate host-flaky. Only `process-collection-unavailable` fails it outright. Otherwise the
    known child must be in the scan, partial or not, and a miss reports the scan's `coverage`
    (complete, or PARTIAL with sampled/enumerated counts and reasons such as `deadline`, `pid-limit`,
    `byte-limit`), so a truncated scan is never reported as a missing child. The child's name must be
    its kernel executable basename (the resolved `node` basename on Linux; on Darwin the invoked or
    resolved basename cut to 16 bytes), never comm and never an invented `""`, and no 12-character
    window of the secret may appear anywhere in that scan. The same probe then aborts a started
    sample, which must reject with the exact abort reason. It prints only PIDs, coverage counters,
    the marker child's own name and a leak flag, never other names.
    Marker readiness is owned by cleanup: a five-second selector deadline rejects silent, partial-line
    and exited children; startup failures and the completed probe SIGKILL and reap that exact child
    within two seconds, then close its pipe. `start_hostile_child` owns both startup and the scenario
    body in one context manager; simultaneous primary and cleanup failures raise an `ExceptionGroup`
    (a `BaseExceptionGroup` for interrupts), chained from the primary failure. Real-child tests check
    exact exit codes (-9 for killed markers, 7 for early exit), startup and completed-probe failures,
    and successful probe cleanup. Injected cleanup timeouts really reap and close the pipe before
    raising, and tests require both original exception objects when both fail.
    Both dev-tools native discovery and privacy fixtures use the same readiness/cleanup supervisor:
    spawn errors and real exit-before-ready failures reject, cleanup reaps within two seconds, and
    simultaneous body/cleanup failures retain both errors in an `AggregateError`.
    With the child still running, `resource_snapshot` with `process_limit: 50` must return exactly
    `min(50, coverage.sampled)` entries carrying only `pid`/`parentPid`/`cpu`/`rssBytes`/`executable`,
    ranked `interval-cpu` on Linux and `rss` on Darwin, and no window of the secret may appear in the
    tool record. `process_limit: 51` must be an error result.
    Evidence records the ranking, the refusal text and the sampler integrity, which must equal the
    registry's own `npm view @nredd/pi-resource-sampler@<RESOURCE_SAMPLER_VERSION> dist` integrity, with
    the lock's `resolved` equal to the published tarball URL (queried through the credential-free
    sandbox; URLs in errors drop userinfo and query). Tool-level cancellation is not driven through
    headless Pi. The package tests also run the secret-bearing child through the tool, and cancel
    the registry-installed sampler while its first scan is in flight (checked pending at abort, the
    sampler's own scan rejected with the exact abort reason rather than a later interval wait, no
    helper child left) and mid-interval; faked samplers cover a pre-aborted call, cancellation after
    the second sample, and disposal failures, rejected or thrown synchronously (the primary error or
    abort wins)
  - session-kit: real `monitor_start`/`monitor_read` output, then the exact packed bytes of
    `dist/pi-stats-export.mjs` copied ALONE into a fresh directory (no `src/`, package or
    `node_modules` beside or above it) and run with only `node` from another unrelated directory,
    exporting that real session and importing it elsewhere; unknown flags exit nonzero. The copy is
    not a rebuild, so artifact identity is the tarball's
  - subscription-router: `router/default` is listed and a request dispatches to the physical
    `local/m`; an invalid config registers nothing and does not crash Pi. Three additional stock-Pi
    processes embed the installed tarball's factory through `scripts/router_contract.mjs`: balanced
    dispatch to B, exhausted A/B falling back to unmeasured C, and an SSE quota error on A confirmed
    by a fresh usage read before recovery to B. Each asserts exact physical message order, provider
    request counts, successful final settlement and sibling-tool absence. Quota HTTP responses and
    credentials are synthetic injected transport dependencies; model streams use three real loopback
    faux providers. No workspace router source or sibling plugin is loaded. The original default-entry
    scenario remains separate, so the embedding fixture does not replace installation coverage
  - in every run the package's tools are declared and no other package's are (sibling absent)

Isolation: the child environment is built from scratch, never inherited. `HOME`, `TMPDIR`/`TMP`/`TEMP`,
`XDG_*`, `CODEX_HOME`, `PI_CODING_AGENT_DIR` and the npm cache/config all live in a per-package
scratch directory (session-kit sweeps `os.tmpdir()` on startup, so nothing points at shared temp
state). No provider keys or loader variables (`NODE_OPTIONS`, ...) reach children; `HTTP(S)_PROXY`
points at a dead port with loopback excluded as defense in depth for clients honoring proxy
variables. This is not a network sandbox: direct sockets and clients ignoring those variables are
not intercepted. Configured models use loopback scripted providers (`faux_provider.py`)
registered through `models.json` with dummy keys. The router's multiprovider cases configure three
such providers, never live subscription endpoints.
Scratch is deleted unless `--keep`.

Limits: this is stock Pi only. It does not exercise `pi install npm:...`, the Plan-mode
integration, the Bun-compiled candidate, or the full stack. Do not read a pass as candidate or fullstack acceptance.

## Subagents and computer-use contracts

`SUBAGENTS_CONTRACT` is likewise outside the standalone three, because it has real runtime
dependencies and `make check-package-contracts` installs offline. It differs from a plugin contract in
declared allowances only: `runtime_dependencies` (`croner`, `nanoid`; the manifest must match exactly and
the import audit admits just those), `peer_ranges` (the `>=1.1.0` floor instead of `*`) and
`own_license` (the packed `LICENSE` must equal the workspace's, which keeps upstream's copyright, not the
root one). The release `stock` gate installs the tarball plus those two dependencies from the registry
and requires `Agent`, `get_subagent_result`, `steer_subagent` and `SubagentWorkflow` in the model request.
`scenario_subagents` then has a faux parent call `Agent` in the foreground (routed faux child), which
is what imports `croner` and `nanoid` at runtime; failures print the tool list seen and the stderr tail.
`make check-subagents-package-contract` (`scripts/stock_package_contract.py --package @nredd/pi-subagents`, needs the registry)
runs that exact gate through `npm_release.run_stock_contract`, so the descriptor, siblings and scenario
match the release `verify` run; CI's `contracts` job runs it on every non-docs PR and uploads
`subagents-package-contracts.json`.

`COMPUTER_USE_CONTRACT` (`@nredd/pi-computer-use`) is also outside the standalone three (it declares
`own_license` and no runtime dependencies, but a `files`/`allowed` set for the macOS-only helpers:
`prebuilt/macos/{arm64,x64}/bridge`, plus the locked Linux crate source `native/linux/bridge-rs/{Cargo.toml,Cargo.lock,src/*.rs}` and `docs/content/docs/how-to-guides/linux.mdx`; no `target/` or `tests/`, no linux/windows prebuilts, no Windows crate).
Upstream sync provenance is packed in `UPSTREAM.md`; `activity_glow.swift` is required by both
build-source lists and the tarball audit. The release descriptor is unchanged: locally rebuilt
per-architecture macOS payloads, locally signed at install, and no upstream-signed app substitution.
Computer-use remains outside the coverage gate. `test:sync-reverts` supplies deterministic negative
controls for the carried patches, without running GUI tools.

`scenario_computer_use` is platform-aware because `extensions/computer-use.ts` registers
`desktop_screenshot` and `desktop_input` on darwin only: exactly 13 tools on darwin, exactly the other 11
elsewhere (a desktop tool on non-darwin fails). It also parses each packed helper's Mach-O header in
Python (works on Linux): 64-bit little-endian magic, `cputype` matching `arm64`/`x64`, mode `0755`. The
evidence records `platform`, the expected `tools` and per-arch `helpers`. NOT RUN, recorded in the report:
the `postinstall` (`setup-helper.mjs`; the stock install uses `--ignore-scripts`, and running it would
create a keychain signing identity, `pkill` a running helper and register the app with LaunchServices)
and every desktop tool (needs an interactive desktop with Accessibility/Screen Recording TCC grants).
`make check-computer-use-package-contract` (`scripts/stock_package_contract.py --package @nredd/pi-computer-use`,
needs the registry for stock Pi; postinstall and native desktop behavior are NOT RUN, as the evidence records) runs the same gate through `npm_release.run_stock_contract`; CI's `contracts` job runs it on
both OSes and uploads its report with the other `*contracts*.json` artifacts.

## Compiled resource sampler library

`make check-resource-sampler-contract` (also a prerequisite of `make check-package-contracts`)
builds, packs, audits and installs `@nredd/pi-resource-sampler` alone, then runs the descriptor's
fixed Node ESM consumer against those exact installed bytes. It samples the real host twice,
checks aggregate CPU range and self-process visibility, and exercises cancellation and disposal.
On Darwin it also requires additive v1 `memory.usage` (`app+wired+compressed`, used + available =
total) and `memory.swap` metrics, with unavailable never substituted by zero. Node >=26.1 also
requires available native self-process interval CPU and physical footprint after the second scan;
older Node keeps explicit unavailable process CPU. Native readers use only fixed builtin FFI and
libproc symbols, not an installed addon or helper. Linux retains absent
native-Darwin fields. `test_library_probe_rejects_missing_native_memory` executes the probe against
older/broken synthetic producers to prove each missing field fails and the hostile child is reaped.
This library gate tests the packed candidate tarball. Both consumers separately pin the published
registry `0.2.0`; their independent registry-resolution tests reject a workspace link. A
child's argv[0], process title and Linux comm hold a random 32-hex secret; the probe first proves the
0.1.0 name source (`ps -c` comm on Darwin, `/proc/PID/comm` on Linux) shows it, then requires the
child in the second snapshot and no 12-character window of the secret anywhere in either snapshot.
The probe samples with the library maxima (5s, 16384 PIDs, 16MiB); a child the bounded scan misses
fails with the snapshot coverage, never passes vacuously. Everything after spawn, readiness and the
negative control included, is followed by SIGTERM, then SIGKILL, and a bounded await of that exact
child's exit status; a cleanup failure is reported alongside the original error, never instead of
it. `resource_sampler_probe` builds the program; `test_library_probe_reaps_child_when_setup_fails`
runs it with a silent, an exiting, an undisguised and a SIGTERM-ignoring child and requires the
expected failure plus `hostile child reaped` with the expected status (SIGKILL for the last). The
legacy `ps` call is bounded too. `test_probe_reports_cleanup_failure_with_the_primary_error` patches
its own copy of the program so `stop` reaps and then throws, and requires the `AggregateError` text.
The gate runs the probe with `run(..., own_group=True)` (`run_own_group`): its own session, and on
the 30s timeout or a `KeyboardInterrupt` in the gate the whole process group is killed while its
leader is unreaped, so a hung probe cannot orphan the child. The group is signalled only while its
leader is unreaped, so the group id cannot have been reused; if `communicate` already reaped the
leader, nothing is signalled, the original exception carries a note, and surviving members may
outlive the gate. Only Python exceptions reach this cleanup: a SIGTERM or SIGHUP the gate does not
handle, or a SIGKILL, ends the worker with no cleanup and the group may outlive it. Default `run`
stays plain `subprocess.run`, which kills only the child. `test_probe_timeout_kills_its_whole_process_group` and
`test_probe_interrupt_kills_its_whole_process_group` time out or interrupt the real probe and require
EOF within 10s on a FIFO only the child holds (`FifoWitness`; the child exits on its own 20s after
it starts, opening included, so a regression cannot leave it behind). Its open is non-blocking and
retried, since a blocking open waits for a reader before any exit timer starts;
`test_fifo_writer_exits_without_a_reader` requires both writers to exit with no reader or a closed
one. `test_reaped_leader_group_is_never_signalled` and the `test_run_default_*` timeout/interrupt
tests cover the guard and the unchanged default path. The reaped-leader skip and unhandled
SIGTERM/SIGHUP/SIGKILL of the gate are not covered by any cleanup.
Existing `owned` macOS/Linux jobs run the native package tests; existing `contracts` jobs run this
packed consumer. No new runner matrix or Pi load is needed for a Pi-independent library.

`RESOURCE_SAMPLER_CONTRACT` explicitly opts into `library=True`: exact ESM `exports`, `types`,
`files`, and thirteen packed paths (five `.js`/`.d.ts` pairs, including the fixed Darwin native
reader, plus manifest/README/LICENSE). No `pi`
field, peers or runtime dependencies are allowed. Import auditing permits Node builtins and
in-package relative imports, never host modules or sibling extensions. The default extension
contract still requires `pi.extensions` and retains its original host-module rules. The release
descriptor uses the same audit/isolated execution gate. Consumers declare the exact registry release
(`RESOURCE_SAMPLER_VERSION`,
never a range, `workspace:` or `file:` spec) as a contract `runtime_dependencies` entry and are admitted
only through the narrow `SHARED_LIBRARIES` rule above, not a relaxed sibling import rule. Their stock
gate installs it from npm next to the packed plugin. In the monorepo npm would link the same-version
workspace, so the root lock carries a nested registry entry per consumer
(`packages/dev-tools/node_modules/@nredd/pi-resource-sampler` and
`packages/session-kit/node_modules/@nredd/pi-resource-sampler`) and package tests run the published
bytes, never the workspace copy. `npm dedupe` would drop those entries; both consumers' registry
resolution tests and the package-contract lock assertions fail if it does.

## Packed preset audit (no standalone Pi behavior)

`@nredd/pi-preset` ships agents, skills, themes and a footer, so its standalone contract cannot
exercise a complete managed profile. `make check-package-contracts` additionally runs
`package_contracts.py --audit-preset` (`run_audit_gate`; with `REPORT=/abs/x.json` the preset
report goes to `/abs/x-preset.json`): pack, full tarball audit against `PRESET_CONTRACT`, then
`install_alone` into a fresh project. The normal preset native gate separately packs the preset,
installs that tarball into a fresh npm consumer, and requires Pi's resource loader to load the
installed footer and all packaged skills from that installed path. The release `verify` stage runs
the audit function for the preset (descriptor gate `audit`), on supplied bytes, never a repack.

The former `fork_package_contracts.py` gate (packed preset + dev-tools driving a real child through the
Gitlinked `pi-subagents`) is removed. `packages/subagents` is now imported and loaded from source by
the in-process suite, which covers what that gate asserted against real children:
`integration/inprocess/reviewer.test.ts` (the preset `code-reviewer` agent file discovered from
`packages/preset`, child tools restricted to the read-only dev-tools allowlist, denied tools refused
without effect) and `specialists.test.ts`, plus `package_contracts.py`'s packed dev-tools scenario
and the stock subagents contract above. Those two files only cover the `code-reviewer` agent discovery, the read-only child tool
allowlist and denied-tool refusal; they have no global/project override or untrusted-project cases
(trust is covered by `packages/subagents/test/project-agent-trust-e2e.test.ts`, which does not use the
packed preset). No longer gated: the packed preset plus packed dev-tools bytes driving a real child
together. Residual risk is low: the tarball audit and install-alone gates catch tarball-only breakage
(a missing `agents/` file, a wrong `files` allowlist), and behavior is proven from the same sources.

Review dispositions (PR3, HEAD `4af6e2c`), both fixed:

- Spec, `import(\`@nredd/...\`)` and other computed imports passing silently: the regex scanner is
  replaced by the TypeScript parser above. Template, sibling-template and computed specifiers are
  rejected with `file:line:col` diagnostics; literal templates are classified like strings. Covered
  by `scripts/import_audit.test.ts` and the `audit_imports` cases in `scripts/tests/test_package_contracts.py`
- Standards, untyped report/evidence: `ContractReport` and per-package evidence models validate at
  the JSON boundary, scenario functions return `TypedDict`s, and artifact identity is checked
  against the tarball bytes. Residual `dict[str, Any]` is limited to Pi's JSONL events and the packed
  manifest (see above)

Review dispositions (PR3, round 2, HEAD `738a241`), all fixed:

- Standards, packed manifest fields unchecked (`peerDependencies: []` passed, `pi: null` crashed):
  `PackedManifest` validates the audited fields. Tests: `test_audit_manifest_rejects_malformed_fields`,
  `..._non_object`, `..._ignores_unaudited_npm_metadata`, `test_audit_tarball_reports_unparseable_manifest`
- Standards, stats export/import/manifest bypassed validation (string `shards` passed, `len()` made
  it look valid): `StatsExportResult`/`StatsImportResult`/`StatsManifest`. Tests:
  `test_stats_manifest_*`, `test_stats_export_result_rejects_malformed`, `test_stats_import_result_*`
- Spec, relative imports accepted before the standalone restriction: standalone is now checked first.
  Tests: three new `dist/` rows in `test_audit_imports_rejects`; the real-artifact test
  `test_standalone_stats_artifact_cannot_reach_package_siblings` shows a `../src/index.ts` import that
  runs in place fails in the isolated copy used by `exercise_stats_artifact`
- Audit of other consumed JSON, same class of defect: lockfiles, Pi `message_end`/`tool_execution_end`
  records, `isError`, and faux-provider request bodies (a list/null body or a non-numeric
  `Content-Length` dropped the connection). Tests: `test_read_lockfile_rejects_malformed`,
  `test_tool_text_rejects_malformed_result`, `test_single_tool_result_and_is_error`,
  `test_assistant_messages_rejects_malformed_events`, `test_faux_provider_answers_malformed_request_with_400`,
  `test_faux_provider_rejects_bad_content_length`; valid shapes are covered by the existing tests plus
  `test_standalone_stats_artifact_over_real_fixture_session` (real-format session, real built artifact)

- `exercise_stats_artifact` copies only real session JSONL into a clean producer home and plants private text/name/path sentinels. Packed standalone bytes run twice with only `HOME`, default executable `PATH` and `TZ`: stable UUID/directory and identical content-addressed month refs are required. Manifest/month bytes are inspected for strict usage-only fields, hash/size/header agreement and absence of sentinels, paths, `content` and `cwd`.
- Two imports into a separate empty viewer must persist exactly those month events without duplication; neither home may acquire credentials, settings, Pi git/npm packages or `node_modules`. Unknown CLI flags still fail. The full real matrix runs only in CI `contracts`; `scripts/tests/test_stats_contract.py` replaces only the process boundary to attack privacy, UUID churn, corrupt/missing months, no-op/duplicated cache and unwanted installation state.
