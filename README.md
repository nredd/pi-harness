# Pi harness

Development home for the `@nredd/pi-*` Pi plugins, the Pi core fork, their integration tests and
the exact-stack release tooling.

Documentation lives in this file, each package's `README.md` and git history. `docs/` holds only
the long references a test or release procedure reads: [CI](docs/ci.md), [coverage](docs/coverage.md),
[install](docs/install.md) and [releases](docs/releases.md), plus `docs/agents/issue-tracker.md` for
the `code-review` skill. New documentation under about 100 lines goes in a README and CI policy goes in comments next
to the workflow it describes; #893 moves `docs/ci.md` there. Do not add plans, coverage write-ups or
investigation notes; put the why in the commit.

## Layout

- `packages/`: independently versioned npm workspaces. Versions live in each `package.json`
  - `computer-use`, `plan-mode`, `subagents`, `todo`: forks, upstream noted in each README
  - `dev-tools`, `session-kit`, `subscription-router`, `preset`: own extensions and the optional preset
  - `resource-sampler`: Pi-independent ESM library used by session-kit
- `forks/pi`: the only Gitlink, the `nredd/pi` core fork
- `integration/`: `inprocess/` (real extension factories on core's session harness, Vitest and
  Bun), `scenarios/` (process and terminal boundaries, run by the CI `stack` jobs), `stacks/`
  (`personal.json` is the one maintained package selection), `harness/` and its unit tests.
  See [its README](integration/README.md)
- `scripts/`: CI classification, coverage accounting, package contracts and release tooling
- `coverage/policy.json`: enforced coverage policy
- `benchmarks/comparison/`: historical comparison experiments
- `releases/`: generated release manifests

## Development

Node `26.12.0` (`.node-version`), npm `11.20.0` (`packageManager`), Python `3.13.15`
(`.python-version`) under `uv`, Bun `1.4.4` (`.bun-version`), Git, `tmux`, macOS or Linux.

```sh
make install                 # install-owned (verify core overrides, npm ci --ignore-scripts, uv sync --locked) + install-benchmark
make check                   # owned-code gate: check-ts check-scripts check-integration check-benchmark
make check-package-contracts # packed tarballs through exact stock Pi; not part of `make check`
make help                    # every target
```

- `make check` never rewrites files and never modifies `forks/`; `check-integration` needs the `forks/pi` Gitlink initialized. `check-ts` takes `WORKSPACES=<paths>`
- `check-benchmark` needs `@openai/codex@0.154.0` first on `PATH` on macOS; it fails, never skips
- Packages build and test against the core fork's release tarballs pinned in root `overrides`.
  Stock Pi compatibility is `make check-package-contracts`' job
- Keep package-local `node_modules/` host copies absent: the in-process stack loader refuses a
  second host copy
- On macOS run long gates under `/usr/bin/caffeinate -is`. Do not relax real-time deadlines
- Never run an unguarded `npm audit fix`: test-host pins are deliberate

## CI and release

- What runs, what is NOT RUN and the flake policy: [CI](docs/ci.md)
- Owned packages publish through `publish.yml` from a signed tag; core ships through
  `nredd/tap/pi-coding-agent`. Procedure: [releases](docs/releases.md)
- `promote-stack.yml` attests a gated `main` commit as `stack/<sha>`:
  [stack promotion](#stack-promotion). Anyone installs one with a single `uvx` command:
  [install](docs/install.md)
- Dotfiles selects pins and activates them with `chezmoi update --upgrade`; require
  `pi-profile doctor` afterwards. Nothing here reads a machine's home, Brewfile or chezmoi source

### Required checks

Required checks on `main`, twelve contexts:

- `owned (ubuntu-24.04)`, `owned (macos-14)` and `owned (wsl2)`
- `contracts (ubuntu-24.04)`, `contracts (macos-14)` and `contracts (wsl2)`
- `stack (ubuntu-24.04, personal)`, `stack (ubuntu-24.04, local)`, `stack (macos-14, personal)`, `stack (macos-14, local)`, `stack (wsl2, personal)` and `stack (wsl2, local)`

Dropping a cell from a matrix would leave its context pending forever, which is why the cells that no longer test anything stay as bypass cells.

The `macos-14` in these names is a stable check context, not the OS version: GitHub retired that image, so the cells run on `xcode-27` (macOS 27, GitHub names new images after the Xcode major) via `matrix.runner`. Renaming them would need a ruleset change.

## Core fork

- `forks/pi` is `nredd/pi` (integration branch `main`), a patch queue on an `earendil-works/pi` release tag. Inspect it
  with `git submodule status`; add the `upstream` remote by hand when rebasing the queue
- A parent worktree does NOT isolate the submodule. Never `--force`, clean or discard inside it
- Order: core fork PR with its native gate and both reviews, publish the reviewed commit and
  release, then a parent PR that moves the Gitlink, root `overrides`, `integration/stacks/personal.json`
  and the lockfiles together
- `make check` is not the core gate. `forks.yml` runs the core suite at the exact Gitlink and
  `make check-core-compaction` runs the assembled child-compaction probes
- The extension forks are imported workspaces, not submodules. They are not kept in sync with
  upstream; each README records where it came from

## Frozen release verification

PR merge policy and release policy are separate. A PR needs all configured checks green on its
own final HEAD and independent Standards + Spec reviews of that exact HEAD. Unrelated advancement
of `main` does not require update-branch, a rebase, or another PR matrix. Actual conflicts still
need resolution; every HEAD change needs fresh checks and both reviews. Never weaken checks,
protection, app bindings or review requirements to merge.

The owner authorized non-strict required status checks on ruleset `25524267` on 2026-10-29.
All twelve matrix contexts remain bound to Actions app `15368`, with no bypass actors. This
source change does not edit remote protection. Keep `strict_required_status_checks_policy=false`.
The merge helper still compares the old and replacement executions' tested base SHA when proving
that a cancelled zero-step placeholder was superseded. It does not compare that base SHA against
the moving current main tip. Required checks and reviews remain tied to the unchanged PR HEAD.

Before publication or promotion, freeze one combined `main` candidate and run the complete CI
lane for that exact commit. `ci.yml` manual dispatch disables docs-only and main-push smoke
shortcuts, executes every owned and contracts cell plus the three stack cells that run a stack
(`ubuntu-24.04` personal and local, `macos-14` local), and calls the existing complete core fork
gate. The `not_run` stack cells (`macos-14` personal, both `wsl2`) are required-check names with
no work behind them; the verifier never asks for them, and a test binds its stack cells to the
`ci.yml` matrix. It reuses the native checks, packed contracts, Node D/E and standalone D/E producers.
It does not make bench F, live-provider G, linux-arm64 runtime, native desktop or the documented
standalone auth-interception exclusions into passes.

Dispatch it on the frozen candidate:

```sh
gh workflow run ci.yml --repo nredd/pi-harness --ref main
```

Record the run's exact `headSha`. All checkouts use that frozen event commit. If main advances
after dispatch, the run and release candidate remain valid; no newest-tip or timestamp freshness
predicate exists. If the desired candidate is already an older ancestor of main, create a
`release-verification/<full-sha>` branch at that exact commit and dispatch on that ref instead.
The classification step requires both the exact SHA-encoded branch name and main ancestry;
`test_dispatch_classifies_only_frozen_main_candidates` runs that real step against a fixture repo.
Each dispatch's `release-core` call groups per SHA without cancellation, so a later dispatch never
cancels an earlier candidate's core gate.
The verifier accepts only `main` or that exact frozen ref, never arbitrary PR branches. Delete
the temporary ref after release evidence is retained. Rerunning the original dispatch also keeps
the original commit. No branch is moved forward merely to satisfy release freshness.

`harness.release_gate` requires a successful `workflow_dispatch` run of `ci.yml`, its exact
candidate `head_sha`, the current attempt's complete matrix and core jobs, the successful actual
execution steps (not just successful job labels), and all retained, nonempty coverage, packed
contract, Node stack and standalone stack artifacts bound to that run and SHA.

The required job set is the verifier's own `OWNED_SHARDS`, not the candidate's. Each caller runs
the verifier that matches its candidate: `publish.yml` runs from the tag's commit, and
`promote-stack.yml` verifies a candidate from current `main`. A candidate that predates a shard
change (e.g. the #660 macOS split) therefore verifies under its own commit's gate, not current
`main`'s; do not promote such a candidate from a later `main` without re-freezing it.

The required steps follow the CI plan (`scripts/ci_paths.py`, [ci.md](docs/ci.md)): each `owned shard (<os>, <shard>)` job must have executed its planned `Owned gate <target>` steps, and the macOS `python` shard its `Benchmark unit gate` (`OWNED_SHARDS`: native cells `check-ts` (on macOS split across the `subagents`, `computer-use` and `ts` shards, #660), `check-scripts`, `check-integration`; WSL `check-ts`, `check-probes`, `check-providers`, `check-import-audit`), each `owned (<os>)` fan-in its `Require every planned shard to succeed` and coverage accounting steps, and the stack cells are exactly those the plan can run, never the `STACK_NOT_RUN` names. A dispatch is planned with `ci_paths.py --full`, so every such cell runs. Tests pin `harness.release_gate` to `OWNED_SHARDS`, `OWNED_GATES`, `STACK_NOT_RUN` and the step names in `ci.yml`.

Artifacts are per run, with no attempt field, so each required artifact is bound to the job that
uploads it (`coverage-<os>` to `owned (<os>)`, `contract-reports-<os>` to `contracts (<os>)`,
`stack-*` and `standalone-*` to their `stack (<os>, <stack>)` cell). That job must be in the
current attempt's job list and successful, and exactly one upload of that name must have a
`created_at` inside the job's `started_at`..`completed_at`, both bounds inclusive, compared as
offset-aware instants. A naive timestamp refuses. Two uploads inside one window refuse, the newest
never wins. After "Re-run failed jobs", the new attempt lists the carried-over successful jobs with
their original timestamps, so their original uploads still qualify; a re-run job qualifies only
through its new upload, never the failed attempt's same-named artifact. Missing, skipped, failed,
expired or mismatched evidence refuses, and so does a malformed REST page. `python -m harness.release_gate` exits 0 with evidence and 1 when refused; a
harness defect raises instead of reading as a refusal. Ordinary push/main smoke and old PR checks are
not fallbacks. Artifacts use normal Actions retention; expired evidence needs a real rerun, not
a replacement receipt. The verifier paginates run, job and artifact collections. Ubuntu publication/promotion jobs use
trusted `/usr/bin/gh`, not PATH lookup; the `publish.yml` `verify` job runs computer-use releases on
macOS and sets `RELEASE_GATE_GH=/opt/homebrew/bin/gh` there. Read-only local diagnostics on another platform must set
`RELEASE_GATE_GH` to its trusted absolute executable, e.g. `/opt/homebrew/bin/gh`;
relative, missing or nonexecutable paths refuse.

Publication and promotion are distinct candidates and evidence:

- Prepublication: merge the reviewed package/version/lock changes without selecting unpublished
  versions in `personal.json`. Run full frozen CI on that source candidate. Its owned suites,
  local workspace stack and packed contracts verify the candidate source/package graph. Its
  personal registry stack still describes the existing published selection, NOT the new release.
  `publish.yml` requires full execution evidence before verification and again before the
  privileged publish step, then packs once and checks/publishes those exact bytes through the
  existing descriptor and provenance gates. Do not reinterpret old registry-stack evidence as
  verification of the new package versions.
- Postpublication: after the registry integrity, signatures and provenance checks succeed, merge
  the reviewed exact published stack selection. This changes selected inputs, so freeze and fully
  verify that combined main candidate separately. `promote-stack.yml` requires its full execution
  evidence before snapshot construction; `promotion_verify` records the full dispatch run ID in
  `stack_run_ids`. Existing required-check, registry-byte, core and snapshot checks still apply.
  Owner environment approval remains mandatory before attestation/publication. Dotfiles adoption,
  deployment and activation consume that exact attested snapshot, never old PR or another package
  set's checks.

Older push/main-only evidence is insufficient for new publications and promotions. Existing published releases and snapshots remain historical artifacts and
are not retroactively relabelled as fully verified by this lane.

## Stack promotion

`integration/stacks/personal.json` is the only editable personal package list. A promotion turns one exact, already-gated `main` commit into an attested `stack/<sha>` release. Flow: verify -> attest -> `stack/<sha>` release -> dotfiles pins the sha. There is no moving pointer: consumers pin an exact `source_sha`, never `main`. This is the trust root for adoption, so every gate fails closed.

Full [frozen-candidate verification](#frozen-release-verification) is mandatory before snapshot
construction. It requires actual full matrix/core execution and retained artifacts for the exact
combined source SHA, not the selective push/main smoke or old PR checks. Unrelated later main
advancement does not invalidate a frozen verified candidate. No operation waives this barrier.

### Snapshot format

`stack-snapshot.json` is compact, sorted JSON with this strict schema (`integration/harness/promotion.py`):

- `schema_version`: currently `1`.
- `source_sha`: the exact 40-character `main` commit selected.
- `stack`: the validated `personal` stack object, including ordered sources and core release identity.
- `stack_sha256`: SHA-256 of compact sorted UTF-8 JSON for `stack`, not of the surrounding snapshot.
- `gates`:
  - `required_checks`: the configured `main` check names, all successful on `source_sha`.
  - `stack_run_ids`: the qualifying full-dispatch CI run for this exact frozen candidate.
  - `owned_packages`: one `{package, integrity}` per `npm:@nredd/` source, with the registry's real SHA-512 integrity from `scripts/npm_release.py stack-check`.
  - `core`: the core release tag and asset SHA-256 digests, which must equal the stack's `core` and the release's `SHA256SUMS`.

The snapshot's `stack` JSON obeys the canonical-JSON rules in `integration/README.md` (no floats, unsafe integers, non-string keys or lone surrogates); the producer guard lives in `integration/harness/stack.py`.

The module rejects unknown fields, malformed SHAs, non-personal stacks, digest mismatch, duplicate evidence, and owned-package evidence that is not exactly the stack's `@nredd/` sources.

The snapshot schema remains strict v1 and retains its historical owned-only integrity boundary. New promotions additionally publish and independently attest strict `dependency-graph.json`, containing its own schema version, exact `source_sha`, and source-selected complete native runtime locks bound to the canonical stack digest. The hardened standalone installer requires BOTH assets; historical snapshot-only promotions are unsupported, never silently downgraded. Existing dotfiles snapshot-v1 consumers are unchanged and do not gain installer runtime-byte guarantees.

### What gets verified

Workflow: `.github/workflows/promote-stack.yml` (`workflow_dispatch`, `main` only). The workflow concurrency group is `operation` plus the selected SHA, so a `verify-only` dispatch never replaces a pending `promote` of the same commit and two promotions of one SHA run one at a time. With 3+ duplicate same-SHA, same-operation dispatches GitHub keeps one pending run and cancels older pending ones, so duplicate pending dispatches coalesce. That is harmless: `stack/<sha>` creation is idempotent and fails closed on mismatch. Different SHAs are independent: each writes only its own `stack/<sha>` tag and release. Every job has `if: github.ref == 'refs/heads/main'`. All gate logic lives in Python with fixture tests, and every `run:` is one Python (or one `gh`/action) call with inputs passed through `env:` only. The read-only `verify` job runs `harness.release_gate` followed by `python -m harness.promotion_verify`, which repeats the full barrier before candidate construction and fetches the remaining evidence itself (`gh`/`git` through `promotion.run_command`) and calls `select_source_sha`, `descends_from`, `verify_required_checks`, `verify_core`, `collect_owned_evidence` (worktree per owned tag plus `stack-check`), `build_gates` and `build_snapshot`. The verifier also reads `integration/stacks/runtime-locks.json` from that exact source commit, binds its roots/digest to the selected stack, cross-checks owned SRI, and verifies every selected tarball against standard npm SRI (plus authenticated core SHA-256). It never re-resolves the graph during promotion or resume. The write-privileged `attest-and-publish` job runs stdlib-only `python3 -m harness.publish_gate` subcommands `prepare-release` and `tag-target` (the complete set), plus `gh attestation verify`, `actions/attest-build-provenance` and `gh release create`. `harness.promotion` is a library with no CLI. Evidence failures and Git failures print `FAILED: ...`, never a traceback.

- Inputs: `select_source_sha` (called by `promotion_verify`) requires `operation` to be `verify-only` or `promote` and `source_sha` to match `^[0-9a-f]{40}$`. The commit must be an ancestor of `origin/main`. The `fetch origin main` that gets `origin/main` carries no credentials (`persist-credentials: false`), which is fine because the repository is public.
- Required checks: every context from `GET /repos/nredd/pi-harness/rules/branches/main` (ruleset `main required checks`, readable by `GITHUB_TOKEN`) must be `completed`/`success` on that exact SHA, reported by the rule's `integration_id` app (`app.id`, 15368 for every configured context). No checks from the rules API fails closed. Review statuses are not required checks.
- Deferred, review statuses (`migration-review/standards`, `migration-review/spec`): they are no longer required checks and the merge flow posts no commit statuses (`docs/ci.md`), so there is nothing to read; reviews stay a process step.
- Deferred, tap readiness when core changes: not implemented; the core release's asset digests and attestation are the only core gate, and a tap bump is gated by its own green CI.
- Registry-stack evidence: the exact full `workflow_dispatch` run validated by `harness.release_gate`. Every owned and contracts cell, each stack cell that runs a stack, and the core gate must actually execute, with retained nonempty per-cell artifacts whose `workflow_run` id and `head_sha` match. Both step names and artifact templates are bounded producer contracts guarded by tests; update the verifier alongside producer renames. The personal stack installs the explicit sources from the registry and the core release into a disposable tree.
- Why the artifact: a skipped cell still reports its job as `success` (recorded run `39545048647` shows `stack (macos-14, personal)` green on a main push though it ran nothing). `ci.yml` uploads `stack-<os>-<stack>` only when `steps.plan.outputs.run == 'true'`, so docs-only and main-push smoke cells never produce it. The verifier matches only the exact artifact name, and a test guards that template in `ci.yml`.
- Push, PR and docs-only runs never qualify: only a full `ci.yml` dispatch of the exact SHA does, and it skips no docs, WSL-input or stack-input shortcut, so a docs-only candidate is promotable once dispatched; see [release verification](#frozen-release-verification). WSL cells do not run a stack, and differently named artifacts are not promotion substitutes. Artifacts expire with CI retention, so an old SHA must be dispatched again before it can be promoted.
- Owned packages: `scripts/npm_release.py stack-check` runs per `@nredd/` source against a worktree of its exact tag: registry presence, npm `audit signatures` (signature and attestation), and the SLSA provenance binding to `publish.yml`, the tag and the commit. The registry lookup (`npm view`) runs in a fresh empty directory with `NPM_CONFIG_USERCONFIG=/dev/null` and `--registry https://registry.npmjs.org`, so a `.npmrc` in the selected tag's tree cannot steer it.
- Core: asset digests are compared with the release's `SHA256SUMS`. For non-legacy tags `SHA256SUMS` is a mutable release asset, so each recorded asset is also downloaded, hashed against the recorded digest, and verified read-only with `gh attestation verify --repo nredd/pi --signer-workflow nredd/pi/.github/workflows/fork-release.yml --source-ref refs/tags/<tag>`. Legacy tags `v1.3.0-nredd.3` through `.7` predate that workflow and rely on the frozen `LEGACY_CHECKSUMS` hashes.

Core SSH signing keys are checked by the core release workflow, not by the promotion
consumer's attestation verifier. The core allowlist uses principal `nredd` and namespace `git`:
MacBook `SHA256:YHzjQXY3SPl20zOMMOoNz8o4dk+eOZEi8FA+vS6nwFY` (retained for historical tags)
and Mac mini `SHA256:+16+g7/7VKDJ2svgiuGIbfPnPF9pKKSU/h51+K9iHdk`.
The latter is owner-approved for `.8` and future releases. No wildcard principal, skipped
verification, new legacy exception, Gitlink move, or stack/pin change is implied.
Core, harness, dotfiles and tap keep separate trust boundaries.

The CI evidence is the only coupling to CI: run IDs are read with `gh run list/view`, the `actions: read` and `checks: read` permissions are granted, and an unreadable response fails with an explicit error.

### Required-check visibility

The twelve required checks live in ruleset `main required checks` (id `25524267`, non-strict). See [CI](docs/ci.md) for which of them are bypass cells: a green bypass cell is a reported name, not evidence, which is why the registry-stack artifact below is the evidence. The verifier discovers the live contexts rather than hard-coding eight, nine or twelve, so `GET /repos/nredd/pi-harness/rules/branches/main` returns them to `GITHUB_TOKEN` with no extra token. Classic branch protection is not read: if the rules API yields no check, `verify_required_checks` fails closed.

### Operations

Dispatch `Promote stack` with `operation`:

- `verify-only` (the default): runs every check above and builds the candidate snapshot. Writes nothing: no artifact, release, attestation or tag, and the `attest-and-publish` job (the only job in the `stack-promotion` environment, with write credentials) is skipped. Run it first to see exactly what a promotion would do; it needs no approval.
- `promote`: `verify-only` plus attestation and the `stack/<sha>` release.

Rollback is re-pinning: point dotfiles at an older retained `stack/<sha>`. Nothing in this repository moves, so there is no rollback operation. Tags are protected from update and deletion (ruleset `25524298`); release assets are not, but a replaced asset fails `gh attestation verify`, so every previously promoted snapshot stays usable only as attested.

Environment: `environment: stack-promotion` gates the whole `attest-and-publish` job, so a required reviewer (the owner) must approve before the job gets `contents`/`attestations`/`id-token` write. It is kept deliberately: it is the only human gate between a green `verify` and a permanent attested release, and a release cannot be retracted. It also restricts the job to `main`. No secret is stored in it any more.

Privilege split: the `verify` job runs only `main` code plus data from the selected commit, holds `contents`/`actions`/`checks` read only, and runs no `npm ci` or `uv sync` from the selected commit. The `attest-and-publish` job holds `id-token`/`attestations`/`contents` write, installs nothing, and only downloads the verified artifact, runs `harness.publish_gate` (standard library only, from `main`, asserted by a test), attests, and publishes.

### Release

`promote` attests both `stack-snapshot.json` and `dependency-graph.json` (`actions/attest-build-provenance`), creates release/tag `stack/<source_sha>` containing both, then confirms the tag points at `source_sha`. The tag namespace deliberately does not overlap package tags (`@nredd/<package>@<version>`).

Resume: `prepare-release` runs before any attestation. It asks `git/matching-refs/tags/stack/<sha>` for the exact ref; only an empty answer means `create`. Any `gh` failure (403, 5xx, rate limit) raises instead of being read as "absent". An existing tag must be a lightweight tag pointing at `source_sha` (annotated tags are rejected: `gh release create --target` only makes lightweight tags, so one is hand-made), its release must carry BOTH `stack-snapshot.json` and `dependency-graph.json` (otherwise refuse), and both assets must be byte-equal to the rebuilt source-selected evidence (`resume`). Both existing attestations are then verified and nothing new is created. A retained legacy release without a graph cannot be upgraded/backfilled. `tag-target` re-reads the ref after publication and requires the same. Evidence is deterministic (sorted checks, earliest qualifying run); if the required-check set changed in between, equality fails closed, so investigate.

### Owner touchpoints

Created 2026-10-20 via `gh api`; the workflow does not create or change any of them:

- Ruleset `25524267` `main required checks`: twelve contexts (`integration_id` 15368, non-strict).
- Environment `stack-promotion`: required reviewer the owner, deployment branches `main` only. The only job in it is `attest-and-publish`.
- Ruleset `25524298` `stack snapshot tags` on `refs/tags/stack/**`: blocks tag update and deletion; bypass is admin. It does not protect release assets, but consumers verify the attestation, so a tampered asset is rejected. Creation stays open: an unattested tag is unconsumable because consumers verify attestation, and `GITHUB_TOKEN` creates the tag through the release.

### Consumer requirements

Consumers pin an exact `source_sha`, download the `stack/<source_sha>` release asset and MUST verify its attestation before use:

```
gh release download stack/<source_sha> --repo nredd/pi-harness --pattern stack-snapshot.json
gh attestation verify stack-snapshot.json --repo nredd/pi-harness \
  --signer-workflow nredd/pi-harness/.github/workflows/promote-stack.yml \
  --source-ref refs/heads/main --deny-self-hosted-runners
```

Then validate it with `StackSnapshot` (`integration/harness/promotion.py`) and require its `source_sha` to equal the pin. `load_promoted_snapshot` does both. `gh attestation verify` needs a GitHub login unless it is given the bundle: the public attestations API serves it anonymously, which is what the installer does (`--bundle`, see [install](docs/install.md)). An unattested file, or one attested from another workflow or ref, must be rejected, keeping the last good stack. To roll back, pin an older retained `stack/<sha>`.

### Promoting

Run `verify-only` on a `main` SHA whose CI ran the stack job, then `promote` with the same SHA and approve the `stack-promotion` environment.

### Historical waived record

`stack/17236539759ccc8858e605ed3f07531cacf2d9e0` is an immutable historical owner-waived record, not green-CI evidence. Do not alter its tag or release, and do not treat retrospective review as satisfying its pre-release gates. The `owner-override` operation no longer exists; recovery requires an ordinary reviewed, green-CI `verify-only` then `promote` flow.

## Self-hosted runners

`nredd/pi-harness` is PUBLIC. A self-hosted runner executes whatever a workflow says, and a fork PR brings its own workflow file, so the design assumes any job may be hostile and makes the runner worthless to compromise.

Infra code and runbook live in the private `nredd/ci-runners` repo. This page is the policy and the spec.

### Pools

| Label | Host | Isolation |
| --- | --- | --- |
| `pi-linux` | Linux VM host | One linked-clone VM per job, destroyed after the job. Per-VM PVE firewall drops every private net, so no LAN, no tailnet. 8 vCPU, 10 GiB, 50 min cap |
| `pi-macos` | macOS arm64 host | One job at a time as the unprivileged hidden `ci` user. All `ci` processes killed and its home and `/tmp` files wiped before and after every job, runner restored from a root-owned golden copy. pf rules block `ci` from every private net. 50 min cap |
| `pi-wsl2` | ARM64 Windows host | One job at a time inside a fresh WSL2 distro (linux-arm64), imported from a read-only golden image under a dedicated non-admin Windows user `ci`, so it gets its own utility VM apart from the owner's dev distros. Unregistered and the VM shut down after every job. NAT networking; a guest nftables deny set (private ranges, tailnet/CGNAT, link-local, the gateway, plus every non-default route prefix of the host at job start) is the enforced layer, and a calibrated Hyper-V firewall rule is best effort. `wsl.conf`: automount, interop and `appendWindowsPath` off, no sudo, IPv6 off. Runs only on AC with enough free disk. 50 min cap |

`pi-wsl2` status: planned, not live. The isolation controls in its row and in the threat model below are the design; the native path has only run against stubs, and nothing is claimed as verified until the acceptance smoke and three real jobs have run (see Remaining).

All register repo-scoped with single-use JIT configs: a runner takes one job and its registration dies with it. No org or user level runners, no runner groups to misconfigure, nothing persistent to steal. The PAT that mints configs (`Administration: write`, `Actions: read`, this repo only) lives root-only (SYSTEM and Administrators on Windows) on the host, never inside a VM or the `ci` account.

### Repo settings (enforced, check with `gh api`)

- Actions allowed: `selected` -- GitHub-owned plus `astral-sh/setup-uv`, `oven-sh/setup-bun`, `taiki-e/install-action`, `Vampire/setup-wsl`
- `sha_pinning_required: true` (every `uses:` is already a full SHA)
- Fork PR approval: `all_external_contributors`, i.e. EVERY fork PR run waits for the owner. Never use "first-time contributors". Do NOT approve a fork PR run without reading its workflow diff: a fork can rewrite `runs-on` to a self-hosted label
- Workflow token default `read`, `can_approve_pull_request_reviews: false`
- No collaborators, no repo or org secrets (environments `npm`, `stack-promotion` are branch-gated), no `pull_request_target`, `workflow_run` or `issue_comment` workflows. Adding any of these with a self-hosted `runs-on` is a blocking change
- Ruleset `main required checks` requires the same names the hosted cells report

### Threat model

- Fork PR: never reaches a runner unless the owner approves the run (see above). Even then it gets a throwaway VM / wiped user with public internet only
- Same-repo PR or push: owner-authored, trusted like hosted, but still ephemeral
- Compromised dependency in a job: can burn that one VM or the `ci` account, cannot reach the LAN, tailnet, the PAT, the owner's home or any credential, and leaves nothing for the next job
- RESIDUAL on `pi-macos`: `ci` shares a kernel with the laptop, so a local privilege-escalation exploit would break out; loopback services stay reachable; DNS (port 53) to the resolvers stays open. A VM would be better but there is no disk for a macOS+Xcode image. Keep macOS patched
- RESIDUAL on `pi-linux`: `runner` has passwordless sudo inside the throwaway VM (apt installs); link-local IPv6 is not dropped
- `pi-wsl2` jobs assume hostile code as an unprivileged user in a fresh VM with outbound internet. A job can burn its one VM for the cap, use the public internet (including exfiltrating anything it can see: the checkout, the read-only job token, its own single-use JIT credential), resolve DNS through public resolvers and use CPU within the VM's cap. It cannot read the PAT or any Windows path (no automount, no interop, `ci` has no ACE on the secrets directory), reach the LAN, tailnet, routed prefixes, the Windows host or the dev distros' loopback, run `.exe` files, persist anything or register a second runner. The supervisor admits a run only when its head repository is this one, so a fork that rewrites `runs-on: pi-wsl2` sits queued until GitHub expires it (the rescue workflow leaves fork runs alone, and the supervisor leaves refused jobs out of its free-slot count); the workflow-side same-repo guard is NOT the boundary
- RESIDUAL on `pi-wsl2` (GitHub-side): a repo-scoped JIT runner is bound to its label, not to the job whose run the supervisor admitted, so an owner-approved fork job queued on `pi-wsl2` could be assigned to a runner minted for a same-repo job. The supervisor re-checks the run the runner actually took and kills the job on denial, so exposure is the seconds before that check. Never approve a fork run without reading its workflow diff; runner groups are not available to a personal repository
- RESIDUAL on `pi-wsl2`: a Linux kernel or WSL guest-to-host vulnerability breaks out of the VM (keep Windows, WSL and its kernel patched); the pool shares a host with the owner's dev VM and Windows session, so a job can still cost RAM, disk, CPU, battery and thermals (caps and preflights, not isolation); the Hyper-V firewall layer is per creator and calibrated per job, UNVERIFIED on a NAT port, and the guest layer falls to a kernel LPE; public internet means exfiltration, DNS exfiltration and any IP-allowlisted public service; a tunnel that comes up mid-job adds routes the job-start deny set does not hold (the supervisor aborts the job when the host's route set grows); host management policy may re-grant rights, and an administrator can always read `ci`'s data; there is no hosted ARM64 WSL2 to fall back to

### Smoke

`.github/workflows/runner-smoke.yml` runs on same-repo PRs touching it and on `workflow_dispatch`. Each pool must show: runner name and arch, public internet reachable, private targets (`192.168.x`, `100.x` tailnet, `10.x`) blocked. `pi-wsl2` runs `scripts/wsl2_smoke.sh`, which also checks non-root, no sudo, aarch64, IPv6 off, no `/mnt/c`, no WSL interop, no Windows path or `.exe` on `PATH`, no drvfs/9p mounts and closed loopback ports. The host's address and the dev environment's address and ports come from the runner's environment (`SMOKE_HOST_IP`, `SMOKE_DEV_IP`, `SMOKE_DEV_PORTS`), never from this repository. The same script is the first step of every `pi-wsl2` cell in `ci.yml`.

### Remaining

- `pi-macos` availability: a sleeping laptop leaves its jobs queued forever. `caffeinate -s` keeps it awake on AC; add a hosted fallback (route to hosted when no `pi-macos` runner is online or the job queues past N minutes) before making `pi-macos` a required cell
- Quiet benchmark runner (`bench`): `pi-linux` is a shared host, so it does NOT yet meet the bench admission policy
- `pi-wsl2` acceptance before `PI_WSL2_HEARTBEAT` is set: three consecutive green real jobs and a clean smoke on the laptop, then replace the estimated `CELL_SECONDS` entries for the `wsl2` cells with measured ones. Until the variable exists the pool reads as down and every `wsl2` cell stays hosted. Pooled cells keep reporting as `owned (wsl2)` and `contracts (wsl2)`, and the pool's own job is `smoke (pi-wsl2)`; no new required check name is added
- Alerting: the daemon only logs to journald; nothing pages when it is down
