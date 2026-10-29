# Consolidate Pi harness development and distribution

- Status 2026-10-20: historical approved design, not an implementation inventory. Current status is
  [here](../PLAN.md); the rebuilt verification boundaries and scenario destinations are [here](verification-rebuild.md).
- The rebuild superseded sections 1, 7 and 9's verification layout and gates. Section 2's required
  review status is superseded: dual exact-HEAD reviews remain our process, recorded in PR comments,
  not a CI gate. The current required checks are [here](ci.md).
- Never built: sections 6-8's dotfiles release-manifest consumption/runtime-tree distribution,
  section 8's staging/activation/rollback transaction, section 7's GitHub App promotion, and
  section 5's three-platform standalone Bun acceptance. CI runs the stack D/E scenarios on a Bun standalone
  built from the Gitlinked core on darwin-arm64 and linux-x64, minus seven auth-interception skips; linux-arm64
  is NOT RUN.
- Current ownership supersedes section 1's five-submodule layout: only `forks/pi` is a Gitlink;
  subagents, plan-mode, todo and computer-use are imported npm workspaces. Computer-use's upstream
  base, carried patches and re-sync commands live [here](../packages/computer-use/UPSTREAM.md).
- Owned packages ship via `publish.yml`, core via the Homebrew tap, and dotfiles activates pins with
  `chezmoi update --upgrade` plus `pi-profile doctor`. Historical REA requirements below
  are marked retired inline; the original adoption research remains in `integration/docs/`.
- REA retirement supersedes every REA-specific requirement in historical sections 5, 6 and 9
  and the explicit boundaries below. `nredd/dotfiles#58` removed the managed server, warm hook,
  skill and doctor assertions; REA is not a package input, Bun prerequisite or release gate.
  Native MCP support remains. Dotfiles' `tests/rea-retirement.test.mjs` owns absence and
  disposable-home cleanup/no-launch regressions, not REA operation or engine installation.

## Summary

Create public `nredd/pi-harness` as the development home for owned plugins, presets, integration tests, benchmarks, and release tooling. Keep upstream forks as submodules and publish owned plugins independently under `@nredd`.

Chezmoi remains the machine entrypoint. Passing, reviewed releases automatically advance an exact release selection in private dotfiles, but machine updates only **stage** that release. Activation is explicit. Standalone Bun compatibility is a prerequisite; there is no Node-core fallback for this migration.

Every migration PR requires independent reviewer subagents before merge, including fork changes, dotfiles changes, and bot-generated promotion PRs.

## 1. Repository and development ownership

Import audited current-source snapshots from:
- `pi-dev-tools`
- `pi-session-kit`
- `pi-subscription-router`
- `pi-harness-e2e`
- `pi-harness-benchmark`

Retain private histories and existing tags. Audit source, fixtures, documentation, historical results, licenses, and attribution before public import; exclude real transcripts, credentials, private endpoints, and machine state. Preserve the benchmark’s experimental versions and invalid-run annotations rather than rewriting historical results for the current harness.

Use this structure:

```text
packages/                  independently versioned owned plugins and optional preset
forks/                     five upstream-fork submodules
integration/               existing E2E harness, fixtures, probes, and baselines
benchmarks/comparison/      historical matched-harness benchmark
scripts/                   build, release, and chezmoi integration implementation
docs/                      ownership, development, fork, release, and recovery documentation
```

The five submodules are core Pi, pi-subagents, pi-plan-mode, rpiv-todo and pi-computer-use. Preserve their upstream relationships and native build systems. Gitlinks select source revisions; bootstrap must refuse destructive updates to dirty fork checkouts. Fork commits must be published before parent releases reference them.

Use npm workspaces for owned TypeScript packages, uv for Python projects, and a root Makefile as the development entrypoint. Preserve separate fork lockfiles and necessary npm/pnpm/native tooling. Pin the initially validated toolchain rather than combining consolidation with unrelated tool upgrades. Do not introduce Nx, Turborepo, a container requirement, or a new package-manager migration.

Document owned-code worktrees separately from fork edits; do not claim that a parent Git worktree automatically isolates submodule changes.

## 2. Mandatory reviewer subagents on every PR

Apply this gate throughout the migration to every monorepo, fork, dotfiles, automation, documentation, and promotion PR. Small or bot-generated changes are not exempt.

- Run the affected repository’s gate before requesting review.
- Invoke `/skill:code-review` against the exact base-to-HEAD diff with this plan and the PR’s scoped requirements as the spec.
- Spawn separate read-only `code-reviewer` subagents for **Standards** and **Spec**, using `openai-codex/gpt-6.1-sol` as required by the existing skill. Neither axis may be replaced by the implementing agent’s self-review.
- If reviewers are quota-parked, wait. Do not silently substitute models or bypass review.
- Record the reviewed HEAD SHA, reviewer identities/models, both reports, verification evidence, and finding dispositions in the PR.
- Fix blocking findings, rerun affected gates, and re-review. Resolve judgement findings by fixing them or documenting a concrete rationale.
- Any subsequent change to the PR HEAD invalidates its review evidence and requires renewed review against the final diff.
- Merge only after both reviews are complete and all blocking findings are cleared. Tags and pin promotion must use reviewed commits.

Use a required, HEAD-bound review status to prevent merge without this evidence. The migration’s orchestration submits completed subagent-review evidence through the trusted control path; an untrusted PR must not be able to satisfy the gate by adding a receipt file. Do not place reviewer credentials on the benchmark runner or expose them to public PR jobs.

Bot-generated promotion PRs wait for the same review gate before auto-merge. This qualifies automatic promotion: passing tests alone are insufficient. Additional adversarial `critic` reviews supplement, rather than replace, the two required axes where the existing issue-shipping procedure or change risk calls for them.

## 3. Packages, presets, and compatibility

Publish independent npm artifacts:
- `@nredd/pi-dev-tools`
- `@nredd/pi-session-kit`
- `@nredd/pi-subscription-router`
- `@nredd/pi-preset`, an optional opinionated collection of agents, skills, themes, footer code, and policy defaults

Verify npm namespace ownership before publication. Keep plugin versions independent from each other and from assembled-stack releases.

Support current stable upstream Pi for standalone behavior. Record the exact tested upstream version; do not promise historical compatibility. Document optional integrations requiring the forked subagents or Plan-mode behavior. Keep host-provided Pi modules as peers/external imports rather than bundling duplicate host implementations.

Move reusable implementation and its tests out of dotfiles. Keep personal installation selection, overrides, machine configuration, credentials, and enterprise endpoints private or target-local. Public presets must not include the global instructions’ LAN, hardware, account, or credential details.

Use pi-subagents’ existing package-agent discovery and Pi’s existing skill/theme/extension packaging. Preserve local override precedence. Detect and retire only unchanged, positively identified migrated files so old global definitions do not silently shadow packaged resources.

Do not combine the process runners or usage-accounting algorithms merely because they look similar. Add shared lifecycle conformance tests, reproduce suspected defects, and fix demonstrated failures at their owning implementation. Preserve intentional capture and accounting differences.

## 4. Profiles and model-role enforcement

Use one profile resolver based on the validated active enterprise manifest. `workMachine` remains machine-bootstrap policy, not a second competing runtime-profile predicate. Preserve explicit personal/enterprise switching on either kind of machine.

Both profiles receive public dev-tools, session-kit, and specialist agents. Subscription routing remains a personal-profile default; enterprise resource filters must not reference personal router models.

Replace provider-specific selections inside reusable agent workflows with explicit logical role aliases. Personal preset defaults can retain the current preferred models. Enterprise roles require explicit mappings to available, fully qualified models. The migration’s mandatory review model remains the explicitly selected model from section 2, not an opportunity for silent fallback during this conversion.

Enforce required-role resolution in the shared subagents resolution/dispatch paths, including scheduled and workflow calls: a missing or unavailable required alias returns a diagnostic, never fuzzy-matches another provider or silently inherits the parent model. Ordinary unmanaged agent behavior need not be globally rewritten.

Malformed enterprise manifests fail closed. Record the selected profile and validated manifest digest locally; the managed launcher rejects stale profile configuration and directs the user to apply or explicitly switch profiles. This is consistency protection, not an adversarial sandbox.

Profile switches use the **active** release, never the staged one. Keep configuration rendering in a versioned implementation belonging to the active release, with a stable policy-input schema and a frozen legacy adapter for initial migration.

## 5. Bun compatibility prerequisite

Build standalone core archives for:
- `darwin-arm64`
- `linux-arm64`
- `linux-x64`

Preserve upstream’s adjacent binary/resource/native-helper layout. Do not relocate resources into an invented layout or treat an npm tarball as equivalent to the standalone archive.

Before distribution cutover, test the compiled artifact with packed plugins and the assembled stack. Cover:
- Jiti loading, embedded host-module identity, package-agent discovery, and resource filters.
- Monitor evaluated workers, interruption of pathological regexes, and worker cleanup.
- Detached process groups, signal escalation, pipe closure, and descendant cleanup.
- Subagents, quota admission/recovery, Plan-mode transitions, and tool annotations.
- TUI rendering, input, resizing, footer behavior, images, and codemode workers.
- Native helpers on supported platforms. RETIRED: engine-free REA MCP operation; REA is no
  longer bundled or required. Generic native MCP/codemode behavior remains supported.

Replace Node-specific harness assumptions with explicit runtime adapters. Verify mock-transport/preload readiness before scenarios run; missing interception must abort rather than contact real providers. Preserve credential-free faux execution and disable unrelated MCP servers in ordinary sandboxes.

Bun failures must be fixed and covered by regression tests, or the migration stops. Node remains
a declared prerequisite for other Node-based tooling; this is not a Node-free workstation
project. RETIRED: the REA-specific Node prerequisite, not the independent dotfiles modifier
runtime prerequisite.

## 6. Exact release inputs and artifacts

Separate independent plugin publication from promotion of a tested harness combination.

Use a schema-versioned release manifest containing:
- Immutable release identity and full monorepo source commit.
- Fork gitlink commits and provenance.
- Exact owned and third-party package versions/integrities.
- Platform archive URLs and SHA256 digests.
- Profile resource selections, prerequisite versions, and renderer/policy schema versions.
- Verification and review evidence identifying the exact source and artifacts tested.

Generate source identities from Gitlinks and package manifests rather than maintaining duplicate
hand-edited fork pins. Lock third-party resolution for extensions and required package-based
helpers. RETIRED: locking or shipping REA as a release input. Keep downloaded model data and
optional analysis engines outside release artifacts.

Build platform runtime trees from the exact package artifacts and locked dependencies. Archive the installed runtime tree explicitly; do not assume `npm pack` includes `node_modules`. Preserve licenses and reject accidental duplicate host packages.

Use one aggregate local runtime package with explicit nested resource declarations and per-profile
filters. Include both profiles’ public code so switching profiles needs no download or release
activation. Keep all declared resource paths within the package root. RETIRED: the REA server/skill
version relationship and real-directory skill installation requirement; neither resource is bundled.

Publish the same plugin tarballs and stack archives that passed verification. Use immutable release assets, checksums, and provenance. Do not rebuild between verification and publication.

## 7. CI, benchmarks, and automatic promotion

Hosted CI runs formatting checks without rewriting files, linting, type checking, unit tests, standalone-plugin installation tests, profile tests, and compiled-artifact integration/TUI tests. Test current stable stock Pi and the selected custom stack; record resolved host versions rather than allowing `latest` to drift within a run.

Failure policy:
- New correctness failures block.
- A documented isolated flake may trigger one fresh rerun of the entire failed job, only when no unrelated failure occurred. The rerun must pass; retain both outcomes.
- Benchmark failures block. No automatic threshold increases or baseline regeneration.
- Unavailable benchmark execution or required reviewers leaves promotion waiting.
- Authenticated-provider and physical-desktop checks remain manual, outside automatic promotion.

Use the Mac mini under a dedicated unprivileged account, without personal Pi credentials or signing keys. Register its runner with the **private dotfiles repository**, not the public monorepo, so public PR workflows cannot target it directly. A private control workflow accepts only authenticated requests for verified artifacts from approved protected-branch commits. Public PRs run on hosted runners.

Serialize benchmarks, require an idle preflight, and record hardware/runtime/artifact identity with results. Default idle admission: five minutes without console input and a one-minute low-CPU sample before measurement. Retain existing applicable thresholds; baseline changes require explicit reviewed evidence. Use process-scoped sleep prevention during runs.

Keep GitHub App credentials on hosted control/promotion jobs, not in benchmark execution. Grant only required permissions for private dispatch/pin PRs and public verification/review reporting and artifact reads.

Publish npm packages using trusted publishing/OIDC. Bootstrap package ownership interactively if required; do not add a long-lived npm publish token to CI.

After required release checks pass, the GitHub App opens a manifest-only dotfiles update. Run the mandatory Standards and Spec reviewer subagents on that PR and auto-merge only after current-HEAD review and private validation pass. Store an exact manifest URL and checksum, not a floating channel URL. Serialize promotion and reject stale candidates that would overwrite a newer selection. No additional human deployment approval is required once all gates, including subagent review, pass.

## 8. Chezmoi staging, activation, and rollback

Expose no new user-facing CLI:

```sh
chezmoi update
PI_HARNESS_ACTIVATE=1 chezmoi apply
PI_HARNESS_RELEASE=<published-release-id> PI_HARNESS_ACTIVATE=1 chezmoi apply
```

The first command stages only. The second activates the centrally selected release. The third explicitly reinstalls an older published release. The next ordinary update stages the central selection again, without activating it.

Keep installer and renderer implementation/tests in the monorepo. Dotfiles contain thin hooks and a checksum-pinned bootstrap. Never invoke nested chezmoi commands from an apply hook.

Staging downloads into a temporary directory, verifies schema/platform/checksums, safely extracts archives, and runs isolated credential-free installation checks. Write the staged receipt only after success. Failed staging leaves the active runtime and configuration untouched. Dry-runs execute no scripts or downloads.

Activation runs only after explicit opt-in and after the user closes Pi sessions. It uses the staged renderer to precompute and validate the candidate configuration, then switches runtime and managed outputs as one recoverable transaction. Normal applies continue using the active renderer until activation commits.

Back up every managed output the transaction changes, treating rendered configuration as potentially sensitive: restrictive directory permissions, `0600` files, no values in logs. On activation failure, restore the previous runtime and configuration. Keep a small crash-recovery journal; an incomplete transaction prevents new managed launches until recovery. Delete transaction backups after success. This is not a retained-generation system.

Do not alter raw auth stores, sessions, memory, trust state, or target-local manifests. No daemon, running-process tracker, automatic session termination, or historical-install retention manager.

Initial dotfiles adoption preserves legacy package configuration and the working Homebrew launcher until explicit activation. Freeze legacy behavior instead of allowing old install/update hooks to keep advancing it. Remove Pi from moving Homebrew upgrade selection without uninstalling it during staging.

After successful activation, remove only positively identified superseded Homebrew Pi, managed Git/npm install output, and unchanged migrated resources. Preserve unrelated packages and custom overrides. Cleanup failures are reported separately and leave the new validated installation active.

## 9. Verification and completion

Required scenarios include:

| Area | Acceptance evidence |
|---|---|
| Public import | Secret/privacy/license audit of the exact imported tree and packaged artifacts; provenance retained |
| PR review | Standards and Spec reports on every final PR HEAD; changed HEAD invalidates evidence; unresolved blockers and unavailable reviewers prevent merge |
| Review trust | Untrusted PR content cannot forge the required review status; promotion PRs receive the same reviews |
| Plugin independence | Each published package installs and exercises standalone behavior without sibling plugins |
| Contracts | Real-package optional-integration tests plus missing-package behavior; no replacement with mocks alone |
| Profiles | Personal/enterprise switching on one active release; strict missing-role refusal; no personal fallback |
| Bun | Compiled-artifact tests pass on all three platforms, including workers, process cleanup, and native resources |
| MCP | Generic native MCP/codemode support is retained. RETIRED: REA pin/skill alignment, engine-free operation, exposure and sandbox-disablement requirements. Dotfiles owns REA absence/cleanup regressions, not harness runtime acceptance. |
| Staging | Offline retry, corrupt checksum, unsupported platform, malicious archive paths, interrupted download, idempotency, dry-run, and no active-state changes |
| Activation | Initial legacy cutover, configuration failure, interrupted transaction, rollback, restrictive backup permissions, and credential/state preservation |
| Promotion | Known-flake rerun rules, blocking benchmarks, unavailable runner, stale-candidate rejection, manifest-only writes, current-HEAD review, and untrusted-PR isolation |
| Cleanup | Only identified managed output removed; modified overrides and unrelated packages survive |

Document the unified development entrypoint, mandatory review procedure, independent package releases, fork maintenance, exact-stack promotion, chezmoi commands, compatibility limits, and recovery in the same commits as behavior changes.

Validate the new distribution on personal macOS and actual enterprise WSL, recording release identities and acceptance evidence. Only then archive the five old private repositories with canonical-location notices; preserve their histories and tags. Leave unrelated repositories and inactive snapshots alone.

## Explicit boundaries

- No implementation or publication has occurred during planning.
- Every migration PR receives proper independent reviewer subagents; no direct-merge shortcut for bootstrap, documentation, tiny changes, or bot-generated pins.
- Bun compatibility and publication safety are blocking validation work, not assumed successes.
- Missing npm ownership, GitHub App setup, runner provisioning, review-model access, or enterprise access is a reported prerequisite blocker, never bypassed with broader credentials or skipped review.
- RETIRED: REA integration and optional REA engine adoption, not deferred migration work.
  Historical benchmark reruns, native Windows and Intel macOS support remain outside this migration.
- Manual live/desktop checks are reported separately and never described as having passed when they were not run.
