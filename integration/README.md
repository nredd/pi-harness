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

- `harness/release.py` copies the tap formula's recipe: global `npm install` of the released coding-agent tgz, replace its nested `@earendil-works/pi-tui` with the released tui tgz, remove foreign native prebuilds. It never reads the tap at runtime
- The exact Gitlink must have a release tag (`git describe --tags --exact-match`), not a nearest ancestor. When `releases/*.json` records that tag, both downloaded assets must match its SHA-256s; missing/conflicting recorded identities fail closed. An unrecorded tag logs `manifest=not recorded`, not checksum verification
- CI reports the binary's `--version` and exact tag; installation logs the stack document SHA-256 and each installed manifest name/version/source. Per-OS, per-stack artifacts retain failures and JUnit results
- `Stack` is a strict Pydantic schema: `name`, nonempty unique `sources`, optional `settings`, optional reasoned `disabled_extensions`. npm versions and git refs are explicit; local paths resolve relative to the stack file. Unknown fields, implicit-home paths and a `settings.packages` override are refused
- `personal.json` contains the twelve personal sources with exact third-party npm versions, plus `npm:@nredd/pi-preset@0.1.0` for the expanded footer. `local.json` replaces owned packages and Gitlinked forks with repository-relative paths, keeping the same pinned third parties
- Both stacks install `pi-computer-use` through Pi but explicitly disable its npm lifecycle scripts and extension discovery on both platforms. Its postinstall otherwise creates a GUI app even before extension loading, so the declared headless exclusion must cover that side effect too. macOS needs GUI/TCC and Linux has no CI desktop session. This is a declared headless exclusion, not coverage of its helper. Fork-owned desktop suites remain opt-in
- npm user/global configs are separate empty private files, never the owner's npm config or the same `/dev/null` loaded twice. Installer failures include captured command diagnostics
- Pi performs every package install into a new `PI_CODING_AGENT_DIR` and HOME. No package directory is linked from the owner's install. Per-test homes copy only that installed fixture; writable auth/session/cache/tmp/XDG state is private. Local package sources are deliberately the caller's supplied workspace
- The final package list uses the stack's resolved sources, not Pi's cwd-relative saved paths; this preserves declared exclusions when fixture homes are copied. Exact npm versions are checked against installed manifests
- Fixture-only deferred-tool, router and disabled workflow-trigger settings are explicit harness policy, not copied owner preferences. `subagents.json` sets `workflowsEnabled: false`: the separate dynamic-workflows package owns workflow orchestration, so the two do not produce a startup conflict warning. Titles are disabled unless a dedicated scenario enables a faux title model. No live credentials are inherited

Boundary inventory:

- `D`: `scenarios/test_stack.py` (quiet text/JSON/RPC/TUI discovery and exact stack-keyed tool goldens plus deferred promotion), `test_auth_transport.py` (native direct/routed OAuth, exclusions, refresh persistence/refusal/logout), `test_monitor_lifetime.py` (process groups, EOF/stop, SIGKILL orphan ownership), `test_print_output.py` (`/diff`, bad refs, `/stats` CLI channels), `test_startup.py` (ordinary/fatal factory and startup errors across CLI modes, fatal nonzero exit/no provider/no held-message leak)
- `E`: `scenarios/tui/test_footer_resize.py`, real tmux/SIGWINCH 120 -> 60 -> 320 -> 120 on the preset footer. No scaled timers. Native renderer suites own width arithmetic
- Role framing and disclosure clicks are core-native since `v1.3.0-nredd.6`: `forks/pi/packages/coding-agent/test/interactive-{framing,disclosure}.test.ts`, not another process gate
- Landed A-stack ports run in `integration/inprocess/`, documented [here](inprocess/README.md); their old Python rows are removed, not resurrected by this gate
- `F`: `scenarios/bench/`, serial and quiet-runner only. Existing baselines are historical, not re-recorded on hosted runners. CI visibly reports NOT RUN until a quiet runner and one evidenced rebaseline exist
- `G`: `scenarios/live/`, never CI, opt-in with `HARNESS_LIVE=1` and explicit `HARNESS_AUTH_FILE=/absolute/auth.json`. Credentials are linked only from that supplied path; refresh writes through. The shared cost cap remains $0.50
- Unported `A`/`A-stack`/`B` rows remain in `scenarios/integration/` and other `scenarios/tui/` files for their owning port branches. CI selects only the five root `test_*.py` files and `tui/test_footer_resize.py`, all marked `stack`; it never runs the legacy directories wholesale
- Thirteen machine-specific static rows and their schema/pin/Brew parser/discovery units are removed. The ledger assigns them to the dotfiles doctor; that doctor is a separate item, not implemented here

Infrastructure:

- xdist `--dist loadfile` keeps each file's cases together; each worker installs its own immutable fixture input and each test gets private writable state. Kernel-assigned loopback ports, private tmux servers and exact worker-separated process tags prevent collisions
- Headless JSON drains stdout/stderr concurrently with size limits and a hard deadline, including silent-process failures. RPC has concurrent bounded readers and deadline-based event readiness. TUI launch failures clean up their private server; a wrapper records the child's actual exit status rather than relying on version-dependent tmux exit-status format fields
- Auth transport first requires an in-process preload nonce, a refused non-loopback probe and a successful loopback readiness echo. Missing `NODE_OPTIONS` support fails startup before credentials can dispatch. It then uses only fake credentials and a Node preload guarding `fetch`: Anthropic/OAuth hosts redirect to the recording loopback server; other non-loopback fetches fail closed. Forbidden `claude`/`security` subprocesses are recorded/refused. This tests the released Node bundle, not Bun's unsupported `NODE_OPTIONS` interception (runtime adapter remains item 8)
- Flakes follow [here](../docs/ci.md): correctness blocks, one fresh whole-job rerun only for an isolated documented flake, both attempts retained. No automatic retry-until-green
