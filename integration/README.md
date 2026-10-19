# Assembled-stack gate

- CI is the gate for tap and profile pin bumps. `pi-harness-e2e`'s local `make verify` is retired by this gate, not a prerequisite for it. Owner-local installation/render checks belong to the dotfiles doctor (`PLAN.md` item 7)
- No default binary, home, credentials or package set. Inputs are `PI_BIN` and `--stack <file>`; the release fetcher accepts `--tag` or an initialized `--gitlink`. Nothing discovers the owner's Pi, dotfiles, tap or Brewfile
- Do not run real processes on the owner's swap-bound Mac. `make check-integration` runs formatter, linter, ty and infrastructure units only; CI owns scenarios

Inputs and installation:

```sh
cd integration
uv sync --locked
uv run --locked python -m harness.release --gitlink ../forks/pi --prefix /tmp/pi-candidate
# Or: --tag v1.3.0-nredd.6. Prefix must be empty, never a live install.
export PI_BIN=/tmp/pi-candidate/bin/pi
uv run --locked pytest scenarios/test_*.py scenarios/tui/test_footer_resize.py \
  --stack stacks/personal.json -m stack -n 2 --dist loadfile --log-cli-level=INFO
# Repeat with --stack stacks/local.json.
```

- `harness/release.py` copies the tap formula's recipe: global `npm install` of the released coding-agent tgz with Homebrew's `--build-from-source --ignore-scripts` defaults and the formula's `--min-release-age=0` override, replace its nested `@earendil-works/pi-tui` with the released tui tgz, remove foreign native prebuilds. It never reads the tap at runtime
- The exact Gitlink must have a release tag (`git describe --tags --exact-match`), not a nearest ancestor. Both downloaded assets must have recorded SHA-256s in `releases/*.json` and match them. A missing manifest directory, unrecorded tag, missing asset, conflicting identity or digest mismatch refuses installation before npm runs
- Bun standalone: deferred with the Bun checklist (#26-31), blocked on runtime adapter #58. Fork release `v1.3.0-nredd.6` has only npm tarballs; the shipped binary is the Homebrew-shaped Node bundle. Each stack job inspects the selected release's assets and visibly prints `Bun standalone: not run (no standalone asset in <tag>)` when none exists. If a standalone asset appears, the gate refuses unsupported coverage. It never builds Bun binaries or reports Bun standalone as passing
- CI reports the binary's `--version` and exact tag; installation logs the stack document SHA-256 and each installed manifest name/version/source. Per-OS, per-stack artifacts retain failures and JUnit results
- `Stack` is a strict Pydantic schema: `name`, nonempty unique `sources`, optional `settings`, optional reasoned `disabled_extensions`. npm versions and git refs are explicit; local paths resolve relative to the stack file. Unknown fields, implicit-home paths and a `settings.packages` override are refused
- `personal.json` is exactly the twelve sources dotfiles will pin this cycle: subagents `v0.22.0-nredd.3` and the four exact third-party npm pins, with NO preset. `local.json` replaces owned packages and Gitlinked forks with repository-relative paths, keeps the same pinned third parties, and includes the local preset. Preset adoption is deferred to profiles (#21) to avoid duplicating dotfiles-managed agents, skills and themes
- Both stacks install `pi-computer-use` through Pi but explicitly disable its npm lifecycle scripts and extension discovery on both platforms. Its postinstall otherwise creates a GUI app even before extension loading, so the declared headless exclusion must cover that side effect too. macOS needs GUI/TCC and Linux has no CI desktop session. This is a declared headless exclusion, not coverage of its helper. Fork-owned desktop suites remain opt-in
- npm user/global configs are separate empty private files, never the owner's npm config or the same `/dev/null` loaded twice. Installer failures include captured command diagnostics
- Pi performs every package install into a new `PI_CODING_AGENT_DIR` and HOME. No package directory is linked from the owner's install. Per-test homes copy only that installed fixture; writable auth/session/cache/tmp/XDG state is private. Local package sources are deliberately the caller's supplied workspace
- The final package list uses the stack's resolved sources, not Pi's cwd-relative saved paths; this preserves declared exclusions when fixture homes are copied. Exact npm versions are checked against installed manifests
- Fixture-only deferred-tool, router and disabled workflow-trigger settings are explicit harness policy, not copied owner preferences. `subagents.json` sets `workflowsEnabled: false`: the separate dynamic-workflows package owns workflow orchestration, so the two do not produce a startup conflict warning. Titles are disabled unless a dedicated scenario enables a faux title model. No live credentials are inherited

Boundary inventory:

- `D`: `scenarios/test_stack.py` (quiet text/JSON/RPC/TUI discovery and exact stack-keyed tool goldens plus deferred promotion), `test_auth_transport.py` (native direct/routed OAuth, exclusions, refresh persistence/refusal/logout), `test_monitor_lifetime.py` (process groups, EOF/stop, SIGKILL orphan ownership, separate owner pidfile directories, live-owner listings, empty new-owner listings and repeated-startup preservation), `test_print_output.py` (`/diff`, bad refs, `/stats` CLI channels), `test_startup.py` (ordinary/fatal factory and startup errors across CLI modes, fatal nonzero exit/no provider/no held-message leak)
- `E`: `scenarios/tui/test_footer_resize.py`, real tmux/SIGWINCH 120 -> 60 -> 320 -> 120. This test explicitly `pi install`s `packages/preset` as a test-scoped extra source into its private writable copy of either stack, retaining only one preset entry when local already includes it. The live footer remains the dotfiles copy, recorded in the ledger as formatting-identical to `packages/preset`; this test does not adopt the preset into the personal profile. Priced cache-usage history keeps the cost segment present in both tiers, matching the frozen fixture. Full/compact stats-format matches and whole-pane width bounds are asserted after each resize, not just footer width. No scaled timers. Native renderer suites own width arithmetic
- Role framing and disclosure clicks are core-native since `v1.3.0-nredd.6`: `forks/pi/packages/coding-agent/test/interactive-{framing,disclosure}.test.ts`, not another process gate
- Landed A-stack ports and the four single-fork `B:rpiv-todo` interactive rows run in `integration/inprocess/`, documented [here](inprocess/README.md); their old Python rows are removed, not resurrected by this gate
- `F`: `scenarios/bench/`, serial and quiet-runner only. Existing baselines are historical, not re-recorded on hosted runners. CI visibly reports NOT RUN until a quiet runner and one evidenced rebaseline exist
- `G`: `scenarios/live/`, never CI, opt-in with `HARNESS_LIVE=1` and explicit `HARNESS_AUTH_FILE=/absolute/auth.json`. Credentials are linked only from that supplied path; refresh writes through. The shared cost cap remains $0.50
- Unported `A`/`A-stack`/`B` rows remain in `scenarios/integration/` and other `scenarios/tui/` files for their owning port branches. CI selects only the five root `test_*.py` files and `tui/test_footer_resize.py`, all marked `stack`; it never runs the legacy directories wholesale
- Thirteen machine-specific static rows and their schema/pin/Brew parser/discovery units are removed. The ledger assigns them to the dotfiles doctor; that doctor is a separate item, not implemented here

Excluded scenario files (paths below are relative to `scenarios/`; the six `stack` files above are the only CI-selected Python scenarios):

| Files | Reason excluded from `stack` |
| --- | --- |
| `integration/test_agent_worktree.py`, `integration/test_plan_mode_confirmation.py`, `integration/test_plan_mode_gate.py`, `integration/test_plan_mode_policy.py`, `integration/test_subagents.py` | Unported fork-owned `B` rows, not D process boundaries |
| `integration/test_router_e2e.py` | Only the fork-owned `B:pi-subagents` `no-router` case remains. Pending its native port, the legacy wrapper requires explicit `PI_BIN` and `--stack stacks/local.json` (the local router source contains the shell fixture); no `pinned_checkout`, rendered owner settings or live environment. This is excluded from the assembled D/E gate, not claimed covered |
| `integration/test_quota_footer_headless.py`, `tui/test_footer_cache.py`, `tui/test_quota_footer.py` | Preset-native `A` ports; live dotfiles footer adoption remains deferred, so retain these legacy receipts |
| `tui/test_conversation_viewer.py`, `tui/test_fleet.py`, `tui/test_fleet_stall.py`, `tui/test_transcript_rows.py`, `tui/test_virtual_model_row.py` | Unported fork-owned `B` or composed `A-stack` terminal rows; native virtual-terminal suites own these |
| `bench/test_compaction.py`, `bench/test_fanout.py`, `bench/test_multisession.py`, `bench/test_render.py`, `bench/test_startup.py`, `bench/test_typed_vs_bash.py` | `F` measurements/instrumentation require a quiet runner and explicit baseline; hosted CI reports NOT RUN |
| `live/test_live.py` | `G` requires explicit credentials and opt-in; never CI |

The goal/quota/loop ports in #33 remain native; their three deleted Python files are not restored or listed as exclusions. Main's Progress lines and per-row receipts remain in `docs/verification-rebuild.md`.

Native stats receipts remain in `packages/session-kit/test/scenarios/{stats-view,stats-data}.test.ts`; `inprocess/stats-plan.test.ts` adds three-machine dedup/freshness and Plan mode on native export/import. Packed standalone privacy, stable UUID and repeated import stay in `scripts/package_contracts.py::exercise_stats_artifact`, CI `contracts` only. `inprocess/diff-plan.test.ts` and `transcript.test.ts` replace the remaining command/Plan and composed-row processes. The two latency-probe functions moved into multisession calibration/readiness/sample assertions; bench remains NOT RUN.

Infrastructure:

- xdist `--dist loadfile` keeps each file's cases together; each worker installs its own immutable fixture input and each test gets private writable state. Kernel-assigned loopback ports, private tmux servers and exact worker-separated process tags prevent collisions
- Headless JSON drains stdout/stderr concurrently with size limits and a hard deadline, including silent-process failures. RPC has concurrent bounded readers and deadline-based event readiness. TUI launch failures clean up their private server; a wrapper records the child's actual exit status rather than relying on version-dependent tmux exit-status format fields
- Auth transport first requires an in-process preload nonce, a refused non-loopback probe and a successful loopback readiness echo. Missing `NODE_OPTIONS` support fails startup before credentials can dispatch. It then uses only fake credentials and a Node preload guarding `fetch`: Anthropic/OAuth hosts redirect to the recording loopback server; other non-loopback fetches fail closed. Forbidden `claude`/`security` subprocesses are recorded/refused. This tests the released Node bundle, not Bun's unsupported `NODE_OPTIONS` interception (runtime adapter remains item 8)
- Flakes follow [here](../docs/ci.md): correctness blocks, one fresh whole-job rerun only for an isolated documented flake, both attempts retained. No automatic retry-until-green
