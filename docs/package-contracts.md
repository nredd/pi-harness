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
  - packed `package.json`: `name`, `private`, `license`, the four dependency fields,
    `peerDependencies`, `pi.extensions` (`PackedManifest`). A wrong type (`peerDependencies: []`,
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

What each package must satisfy:

- `npm pack` contents match a narrow allowlist: `src/`, `LICENSE`, `README.md`, `package.json`, plus
  `CHANGELOG.md` (router) and `dist/pi-stats-export.mjs` + `docs/stats-snapshots.md` (session-kit).
  Tests, fixtures, `e2e/`, lint/TS/vitest config and planning docs must not ship. Before this change
  none of the tarballs had a `LICENSE` and all shipped `test/` plus dev config
- Packed `LICENSE` is byte-identical to the root `LICENSE`
- Manifest: `private: true` (kept until the namespace/OIDC prerequisites exist), `MIT`, no
  `dependencies`/optional/bundled, peers only from the Pi host set (`@earendil-works/pi-ai`,
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

Limits: this is stock Pi only. It does not exercise `pi install npm:...` (nothing is published),
the forked subagents/Plan-mode integrations, the Bun-compiled candidate, or the full stack. Do not
read a pass as candidate or fullstack acceptance.

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
