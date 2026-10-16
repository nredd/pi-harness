# Source provenance

Initial snapshot import of the five private repositories. Only the tracked tree at the recorded
commit was imported (`git archive HEAD`): no history, tags, ignored files, caches, `node_modules`,
virtualenvs, `__pycache__`, or run artifacts. Private histories and tags remain in the source
repositories. Fork submodules are recorded separately in [forks.md](forks.md).

Identities are commit and tree object IDs and tags only. No author, committer, or e-mail data from
the source repositories is recorded here.

| Destination | Source | Commit | Tree | Tag at commit | Tracked files |
|---|---|---|---|---|---:|
| `packages/dev-tools` | `pi-dev-tools` | `9fddb3d2fd73a1c7d48cc39b1eedba4c953bfd5a` | `ad6132a73c2c692b14bb758ac49fbb4a59d33457` | `v0.4.0` | 68 |
| `packages/session-kit` | `pi-session-kit` | `6323d99d71a2d9b39af2d9704ef302c31ea837cd` | `fcc6eab3c02a7beb7513f55496d8514260087790` | `v0.3.0` | 95 |
| `packages/subscription-router` | `pi-subscription-router` | `5454e657bd485624639ac1ab019a2f82c50240da` | `bf9180ebab23555eb2591e4293829867630a1b17` | `v0.3.0` | 29 |
| `integration` | `pi-harness-e2e` | `e4a0123f14d0233452d4873f5579bbd21228c6b5` | `4d15e8d33e761a13236fb3bfc67202d7910fa2ca` | none | 108 |
| `benchmarks/comparison` | `pi-harness-benchmark` | `c926ea2133967f798e006f04a30efc2da03d82a1` | `b8d76ecb6229faea445df1f0bc162588b7f8b5ef` | none | 70 |

`packages/session-kit/dist/pi-stats-export.mjs` is tracked in the source and imported as is;
`npm run test` rebuilds it byte-identically (verified against the source commit).

## Deliberate modifications

Everything else is byte-identical to the source commit. Verified with `diff -r` against a fresh
`git archive` of each commit.

Workspace and licensing (`packages/*`):

- `package.json` `name` scoped to `@nredd/pi-dev-tools`, `@nredd/pi-session-kit`,
  `@nredd/pi-subscription-router`. `private: true` is kept until a publication pipeline exists
- `package.json` `repository` points at `nredd/pi-harness` with a `directory`, instead of the
  private source repositories
- Package READMEs identify unpublished migration workspaces, point development commands at the
  root workspace, and label retained Git install/installed-runtime instructions as legacy
- Per-package `package-lock.json` removed: the root npm workspace owns one `package-lock.json`.
  Dependency versions in each `package.json` are unchanged (including the router's older
  `@earendil-works/pi-*` `0.99.x` pins, which npm nests); no upgrades. The originals remain in the
  source commits
- Root `LICENSE` is the benchmark's MIT license (copyright holder Redd), copied verbatim
- Three exact `.gitattributes` entries preserve raw parser fixtures: space-prefixed empty context
  lines in the Cargo/Ruff formatter diffs, and the SSH configuration's intentional CRLF line.
  Git's ordinary trailing-whitespace check misclassifies those fixture bytes; source checks remain
  unchanged for all other paths

Privacy sanitization:

- `packages/dev-tools/test/fixtures/cargo/{check,clippy-good}.jsonl`: `/Users/<user>/.cargo/registry`
  -> `/home/user/.cargo/registry` (recorded cargo output paths only)
- `packages/dev-tools/test/fixtures/ssh/config`: a personal LAN hostname -> `nas.example.invalid`
  (`HostName` value is not asserted by any test)
- `integration/docs/fork-upgrade-followup.md`: removed a real session entry ID and timestamp from the
  incident evidence. Not needed for the regression, which is described by block types and sizes
- `integration/docs/coordinated-release-exception.md`: two private conversation quotes paraphrased.
  The owner's historical exception/cancellation and the exact metrics are preserved. Source commits
  and history are untouched
- `benchmarks/comparison/README.md`: local cache path in the install snippet -> the relative
  `benchmarks/comparison` checkout path
- `integration/tests/test_stats.py`: opaque machine UUID replaced with an obviously synthetic
  UUID; the same UUID validation and path-confinement assertions remain
- `benchmarks/comparison/results/runs/*/result.json` (all 36): the private absolute benchmark root
  (an `artifacts`/`worktree` path prefix, wherever it appeared: `*_path`, gate `command`/`argv`,
  `output_path`, `launch_argv`, session paths) -> `<benchmark-root>`. Files were re-serialized with
  the original formatting (sorted keys, 2-space indent, ASCII escapes, trailing newline); no value
  other than those listed here changed. Each affected row gained an `Import sanitization` entry in
  `parser_warnings`
- The 9 Codex rows (04, 07, 12, 15, 20, 23, 28, 31, 36): the `launch_argv` value
  `permissions.benchmark_isolated=...` was redacted whole to
  `permissions.benchmark_isolated=<redacted-permission-profile>`. The original contained a private
  volume name and username. The flag structure (`-c`, `default_permissions=...`) is unchanged
- Row 34 (`34-anthropic-ambiguity-heavy-change-r3-claude`): `planning_quality.evidence` held a real
  transcript excerpt. Replaced with
  `assistant-text: [redacted transcript evidence: real excerpt removed for public import]`. No
  evidence was invented. `asked_before_choosing`, metrics, `status`, `protocol_valid`, and
  `protocol_violations` are unchanged
- `report.json`, `report.md`, `OPERATOR_NOTES.md` held none of these values (grepped), so they are
  unchanged. `report.md` was read from line 1 (first 12 lines included)

Portability fixes (demonstrated failures, not upgrades):

- `benchmarks/comparison/tests/conftest.py`: autouse fixture puts stub `pi`/`claude`/`codex`
  binaries (reporting the benchmark's own pinned versions) first on `PATH`, and points the Pi
  plan-mode package/config paths at temp files with the pinned values. 20 of 21 failing unit tests
  (the 21st needs the real pinned Codex CLI, below) failed on any host whose installed native CLIs or `~/.pi` differ from the 2026 run
- `benchmarks/comparison/tests/test_validity_blockers.py` and `pyproject.toml`: the one test that
  launches the real Codex sandbox is marked `native_runtime` (registered marker). The marker only
  tells the `conftest.py` stubs to stay out of the way; the test is *not* deselected or skipped and
  runs in the root gate. It requires the historical pinned `@openai/codex@0.154.0` first on `PATH`
  and macOS (the historical benchmark is macOS-only, Seatbelt), and fails if it is unavailable.
  The CLI is installed with `npm install --ignore-scripts` into an isolated prefix, with a
  throwaway `CODEX_HOME`/`XDG_CACHE_HOME`; see the root README
- `benchmarks/comparison/README.md`: document stubbed unit inputs and the required native sandbox
  test, and distinguish public audited source/results from local-only generated artifacts
- Historical third-party versions (`CLI_VERSIONS`, `PI_PLAN_EXTENSION_VERSION`, pinned models) and
  all results other than the sanitizations above are unchanged

## Result-row verification

All 36 imported `benchmarks/comparison/results/runs/*/result.json` rows were compared with the
originals at the source commit. Numeric, boolean, and null scalars, version/model/hash metadata, and
validity/protocol annotations are unchanged; only the sanitizations listed above differ.
`report.json`, `report.md`, and `OPERATOR_NOTES.md` are byte-identical. Evidence: a local script,
`~/code/pi-harness-builds/check-import-metrics.mjs`, kept outside this repository.

## Review and commit status

Protected `main` review statuses (separate Standards and Spec reviewers on the final HEAD) apply to
every PR, including this import. Commit this source snapshot only after the full owned-code gate passes, including the historical
native sandbox regression. This is not evidence for the candidate/full-stack release gate.

## Development toolchain

Versions validated for owned-code development (not imported from the sources; no dependency
versions or historical CLI constants changed): Node `26.12.0` (`.node-version`), Python `3.13.15`
(`.python-version`), Bun `1.3.14` (`.bun-version`), npm `11.20.0` (root `packageManager`), uv
`0.13.1`. Fork build toolchains are separate and documented in [forks.md](forks.md).

## Audit evidence

Scans of the imported tracked tree, after sanitization:

- Absolute-path scan (`/Users/`, `/Volumes`, `/home/`, `redd`): none outside synthetic fixtures
- E-mail scan: only `example.invalid`/`example.com` test values, the `noreply@anthropic.com`
  commit trailer, and `git@github.com` remote syntax
- Secret-shape scan (`sk-`, `ghp_`, `AKIA`, private-key headers, JWT-like strings): synthetic
  auth/redaction fixtures in dev-tools, session-kit, router, and integration tests, plus the router's
  credential-type prefix constant. These are intentional test inputs/detection logic, not credentials
- UUID scan: synthetic test values and cargo/nextest run IDs in recorded fixtures. The opaque stats
  test machine ID was replaced with an obviously synthetic UUID
- Synthetic sample sessions and fake auth tokens in tests are intentional and retained
- All 10 Markdown files under `integration/` (README plus 9 docs) were read: no credentials or
  transcripts. Source-attribution and failure notes retained

This is a snapshot audit, not a publication approval. Rerun the scans on the final tree and on
packaged artifacts before publishing.
