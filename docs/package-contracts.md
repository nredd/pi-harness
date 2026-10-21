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
upstream MIT `LICENSE`, exact manifest dependency and exact `files`/allowlist, installs the tarball, and
requires `plan_mode_question` and `plan_mode_complete` from stock Pi. `dist/` is required and packed because
its extension manifest targets `./dist/index.ts`; `src/` stays packed as declared by the source package.

What each package must satisfy:

- `npm pack` contents match a narrow allowlist: `src/`, `LICENSE`, `README.md`, `package.json`, plus
  `CHANGELOG.md` (router) and `dist/pi-stats-export.mjs` + `docs/stats-snapshots.md` (session-kit).
  Tests, fixtures, `e2e/`, lint/TS/vitest config and planning docs must not ship. Before this change
  none of the tarballs had a `LICENSE` and all shipped `test/` plus dev config
- Packed `LICENSE` is byte-identical to the root `LICENSE`, except imported packages marked `own_license`,
  whose upstream MIT copyright text must be byte-identical to their workspace `LICENSE`
- Manifest: `private` absent or `false`, `publishConfig.access: public`, `MIT`, no optional/bundled
  dependencies, peers only from the Pi host set (`@earendil-works/pi-ai`,
  `pi-agent-core`, `pi-coding-agent`, `pi-tui`, `typebox`) with range `*`, `pi.extensions` present
- Every import is a `node:` builtin, a host module, or a relative path inside the package. No
  `@nredd/*` sibling. The stats artifact (`dist/`) may import only `node:` builtins: the standalone
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
- Fresh install (`--ignore-scripts --legacy-peer-deps --offline`, mirroring Pi's suppressed peer
  installs): `node_modules` and the lockfile contain only the package, so no duplicate host copy
- Stock Pi, `--mode json` with `--no-extensions --extension <installed dir>` (only that package),
  `--no-mcp`, `--offline`, no skills/templates/themes/context files, `--no-approve`:
  - dev-tools: a real `git_status` result on a disposable repo (`untracked.txt`), and an error result
    outside a repository
  - session-kit: real `monitor_start`/`monitor_read` output, then the exact packed bytes of
    `dist/pi-stats-export.mjs` copied ALONE into a fresh directory (no `src/`, package or
    `node_modules` beside or above it) and run with only `node` from another unrelated directory,
    exporting that real session and importing it elsewhere; unknown flags exit nonzero. The copy is
    not a rebuild, so artifact identity is the tarball's
  - subscription-router: `router/default` is listed and a request dispatches to the physical
    `local/m`; an invalid config registers nothing and does not crash Pi
  - in every run the package's tools are declared and no other package's are (sibling absent)

Isolation: the child environment is built from scratch, never inherited. `HOME`, `TMPDIR`/`TMP`/`TEMP`,
`XDG_*`, `CODEX_HOME`, `PI_CODING_AGENT_DIR` and the npm cache/config all live in a per-package
scratch directory (session-kit sweeps `os.tmpdir()` on startup, so nothing points at shared temp
state). No provider keys or loader variables (`NODE_OPTIONS`, ...) reach children; `HTTP(S)_PROXY`
points at a dead port with loopback excluded as defense in depth for clients honoring proxy
variables. This is not a network sandbox: direct sockets and clients ignoring those variables are
not intercepted. The only configured model is a loopback scripted provider (`faux_provider.py`)
registered through `models.json` with a dummy key.
Scratch is deleted unless `--keep`.

Limits: this is stock Pi only. It does not exercise `pi install npm:...`, the forked
subagents/Plan-mode integrations (the subagents one is covered by the next section), the
Bun-compiled candidate, or the full stack. Do not read a pass as candidate or fullstack acceptance.

## Optional integration: real packed preset and dev-tools through the selected pi-subagents fork

`make check-fork-package-contracts` (`scripts/fork_package_contracts.py`, `REPORT=/abs/file.json`
for a JSON report) is separate from both `make check` and `make check-package-contracts`. It proves a
REAL packed `@nredd/pi-preset` `code-reviewer` agent and the REAL packed `@nredd/pi-dev-tools` work
through the pi-subagents commit the parent Gitlink selects, on exact stock Pi 1.3.0 only. Not a
mocked resolver, not frontmatter parsing alone. The tooling is unit tested by `make check-scripts`
with disposable fake repositories and runs there without any initialized fork.

Fork selection (nothing is bootstrapped, updated, installed into, cleaned or written in `forks/`):

- Preflight runs before anything is built. `forks/pi-subagents` must have its own `.git`, a clean
  tree (tracked, staged and untracked), and `HEAD` equal to BOTH the Gitlink in the parent index and
  in the parent `HEAD`. A missing, uninitialized, dirty or mismatched fork is a clear refusal that
  points at `make bootstrap-forks`; the gate never runs it. An empty directory from an uninitialized
  submodule is detected explicitly (`git -C` would silently inspect the parent)
- The exact commit is exported with `git archive` into the scratch directory. Its own
  `package-lock.json` is kept and `npm ci --ignore-scripts --omit=dev --omit=peer` installs only the
  locked runtime dependencies there (verified: exactly `croner` and `nanoid`, nothing else). Both
  runtime versions and SHA-512 integrities are validated before npm starts; missing/malformed entries
  and unsupported optional/transitive dependencies refuse without registry access. No
  floating `npm install`. The tree must contain no `@earendil-works/*` or `typebox` anywhere, installed
  versions must equal the lockfile's, and `npm ci` must not rewrite the lockfile. Nested dependency
  trees are refused rather than omitted from the report. Dependency drift requires a deliberate
  update to the gate's supported dependency graph
- The report records the fork commit, its `package.json` version, the lockfile SHA-256, and each
  installed dependency's version and lock integrity, plus the preset and dev-tools tarball identities
  and the stock Pi pin. The registry is reached only for this `npm ci` and the stock Pi install
  (empty npm config, no credentials, a per-run cache, so every run needs the registry). Pi runs
  are offline against the loopback provider

Owned code comes only from packed tarballs. Preset and dev-tools are packed with `npm pack`, audited,
and installed into separate fresh projects (`install_alone`); Pi sees them only as local-path
`packages` in the sandbox `settings.json`, never the workspace sources. The preset has its own
`PRESET_CONTRACT` (not part of the standalone three, whose audit is unchanged): its manifest must
declare `MIT AND Apache-2.0 AND CC-BY-SA-4.0`, and `NOTICE.md`, the three license texts and both
themes are required content. `PackageContract.license` defaults to `MIT`, so a plugin declaring the
preset expression still fails.

The run: stock Pi `--no-extensions --extension <archived fork>` (so installed packages stay out of
the parent, which the gate asserts: no `git_*` tool in the parent request; the child's own loader
still resolves settings packages), the faux parent calls `Agent` with
`subagent_type: "code-reviewer"`, `run_in_background: false`; the child is answered from a separate
script selected by a marker in its task (`faux_provider.Route`, because step indexing counts
assistant messages and would otherwise replay the parent's `Agent` call). The child's request is
recorded with its declared tool names and its system prompt. The route matches the marker in the
child's `user` messages only (the parent's own `Agent` arguments sit in an assistant message), not
in all message text and not by the absence of `Agent` (nested helpers also lack it).

The child does not merely advertise tools, it calls them. Its script makes one allowed call against a
disposable seeded git repository (`git_status` sees the untracked file, `git_log` the seed commit
subject, `read` the tracked note) and then, for every tool of `write`, `bash`, `git_status`,
`git_commit` that its allowlist lacks, a call Pi must refuse with `Tool <name> not found`. The calls are
harmless by construction: `write` and `bash touch` aim at sentinel paths that must still not exist
afterwards, `git_commit` has `push: false` and the repository's `HEAD` must not move. The tool results
come back in the child's next request (`RecordedRequest.tool_results`) and are matched call by call.
Nothing touches a live repository, a remote or signing.

Cases (each its own Pi run in a fresh sandbox; `assess_case` is pure and unit tested):

- `package-default`: child tools are exactly `read`, `grep`, `find`, `git_diff`, `git_show`,
  `git_log`, `git_status` plus `SubagentWorkflow`. The expectation is derived from the packed
  `agents/code-reviewer.md` `tools:` line and checked equal to that set. `SubagentWorkflow` is the one
  always-injected fork helper: `createWorkflowRefusalTool` in the fork's `src/agent-runner.ts`, injected
  into every child with extensions loaded, and its only behavior is to refuse. Nested-delegation tools
  need `allowed_subagents` and `StructuredOutput` needs a requested schema, so neither is present.
  `edit`, `write`, `bash`, `ssh_exec`, `Agent`, `get_subagent_result`, `steer_subagent`, `git_commit`
  and every other dev-tools tool are absent. The packed prompt body is in the child's system prompt
  and `<active_agent name="code-reviewer"/>` names it; `max_turns: 40` reaches the run metadata
  (`details.maxTurns`, the `max turns: 40` tag); the `Agent` result is a non-error `completed`
  `code-reviewer` whose text ends with the child's answer; the parent finishes with its scripted
  answer. Stderr is empty. The child really runs `git_status` and Pi refuses its `write`, `bash` and
  `git_commit` calls. `toolUses` is the number of child calls (refused ones end like any other, so 4)
  plus the fork's `extension-error:` diagnostics (0 here)
- `global-override`: `<agent dir>/agents/code-reviewer.md` (`tools: read, find`, `extensions: false`)
  beats the package: only its body, tools `read`, `find`
- `project-override`: `<cwd>/.pi/agents/code-reviewer.md` (`tools: read, ext:pi-dev-tools/git_log`,
  `extensions: [pi-dev-tools]`) beats both the global and the package agent while still loading the
  real packed dev-tools: tools `read`, `git_log`, `SubagentWorkflow`; neither other body is in the
  prompt. Runs under `--approve`; the child really calls `git_log`, and `git_status`, `write`, `bash`,
  `git_commit` are refused
- `project-override-untrusted`: the same files under `--no-approve`. The selected fork consults Pi's
  canonical project-trust decision before reading `<cwd>/.pi/agents`, so the project agent is ignored
  and the global override wins: the child declares exactly `read` and `find`, carries the global
  prompt marker, and the project marker never reaches it. A fork that reads untrusted project agents
  fails this case on purpose
- `project-package-trusted` / `project-package-untrusted`: preset and dev-tools are installed through
  `<cwd>/.pi/settings.json`, which Pi reads only for a trusted project, with no agent-dir packages.
  The decision is Pi's real one-time flag (`--approve` / `--no-approve`, no saved `trust.json`, no
  faked policy). Trusted behaves exactly like `package-default`. Untrusted, `code-reviewer` is not
  discoverable: the fork resolves the type to its documented `general-purpose` fallback, and the child
  gets the built-ins (`read`, `grep`, `find`, `ls`, `edit`, `write`, `bash`) and none of dev-tools
  (`git_status`, `git_commit` refused as unknown). Note this means an untrusted install silently
  degrades to a write-capable agent; the case pins that so a change either way is visible
- `missing-dev-tools`: only the preset is installed. The documented contract is a warning, not a
  refusal: the fork reports `extension-error:extension "pi-dev-tools" requested by agent
  "code-reviewer" was not loaded` and `extension-error:ext:pi-dev-tools referenced by ...` through its
  tool-activity channel, and the agent still runs with its built-ins. Observed: the child declares
  `read`, `grep`, `find`, `SubagentWorkflow` (no `git_*`), the `Agent` result succeeds and its
  `toolUses` is exactly 2, one per diagnostic. The diagnostic text itself is not surfaced to the
  parent in this Pi/fork combination (it feeds the widget's tool-use counter), so the counter is the
  only machine-visible trace: `toolUses` is 7 (5 child calls, `git_status` among the refused ones, plus
  the 2 diagnostics); it is asserted rather than invented as stderr or text

Observed `toolUses` per case: `package-default` 4, `global-override` 5, `project-override` 5,
`project-override-untrusted` 5, `missing-dev-tools` 7, `project-package-trusted` 4,
`project-package-untrusted` 3.

Validated JSON (new consumed fields, strict types): the fork `package.json` and lockfile, installed
dependency manifests, the `Agent` result (`details.subagentType`/`status`/`toolUses`/`tags`/`maxTurns`,
`isError`), the final assistant message, and the faux request's `messages[].content` (string, part
list or null; a mistyped value is an HTTP 400, tool messages are recorded as text). Evidence and report models are strict Pydantic
(`ForkContractReport`); cases must be complete and in order.

Limits: stock Pi 1.3.0 and exactly the selected fork commit only. Packages are local-path
`packages`, not `pi install`/npm-managed (the gate never publishes). Not Bun, not the full assembled
stack, not authenticated providers, and no profile, role or activation behavior. A pass is not
candidate or fullstack acceptance.

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
