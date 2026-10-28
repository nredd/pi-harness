# REA MCP server adoption: verify record

Historical evidence only, not an installation or release requirement. The managed REA
integration was retired in `nredd/dotfiles#58` (`52913a1`). Current harness installers,
package/stack profiles, sandbox configuration, native hooks and tests do not bundle or
start REA. Generic native MCP support and unrelated reverse-engineering research remain.
Audit of the 1,266 paths in `git ls-files` at `166e801a`, including filename inventory and
tracked-file content searches for the REA name, `rea-agents`, `mcp__rea`, the skill and warm
hook names, found no owned REA binary/download-cache asset or active installer/package wiring.
Remaining matches are this historical record, superseded requirements marked retired in
`docs/`, integration exclusions, and process-title fixtures/provenance in
`packages/dev-tools/{README.md,test/resource.test.ts}` and
`scripts/tests/test_package_contracts.py`. Those fixtures never launch a REA server.

Installed configuration predating retirement can still register REA until an authorized chezmoi
apply/update writes `~/.pi/agent/mcp.json` and removes
`~/.agents/skills/reverse-engineer-anything`. The dotfiles source owns both retirement
paths and disposable-home regression tests. Its targeted MCP modifier preserves unrelated
servers/settings. Existing Pi sessions retain their MCP children after source/config edits:
restart all such sessions after activation. Do not treat them as orphans or broadly kill
processes. Source preparation does not authorize activation, deployment or release.

Date: 2026-10-16. Chezmoi `cf994ec` registers the `rea` MCP server (`npx -y rea-agents@6.5.0 mcp`,
default `codemode` exposure, both profiles) in `~/.pi/agent/mcp.json` and vendors the
`reverse-engineer-anything` skill. No pin or fork changed; core stays `v1.3.0-nredd.1`.

Harness changes in the same change set:
- `build_sandbox` overrides every `mcp.json` server to `enabled: false` (no network, no 207-tool
  stdio spawn in faux runs)
- `scenarios/static/test_config.py` checks the committed config: exactly `rea`, exact `npx` pin,
  no `exposure`, vendored skill present and at the same version as the server, warm script and
  skills README on the same pin

Full `make verify` (`/tmp/make_verify2.log`, exit 2):
- 86 Python + 7 Node unit tests passed
- 150 static/integration passed, 1 expected skip (no enterprise manifest)
- 122 TUI/bench passed, 1 failed
- Every `scenarios/bench` test passed: compaction, fanout, multisession (the n4 input p95 that was
  over its limit on the coordinated release passed this run), render x2, startup x2,
  typed-vs-bash x3
- Sole failure: `scenarios/tui/test_session_kit_monitor_diff.py::test_diff_overlay_layout_navigation_and_close[320]`,
  `wait_position` timed out on the `p` (previous file) step of the `/diff` overlay at 320 columns,
  20 minutes into the TUI batch. Re-run alone: 7/7 widths pass in 53 s. Session-kit TUI, no REA
  involvement (sandboxes have `rea` disabled). Treated as a load flake per the owner's rule that
  only a *completely* failed benchmark gates; this is not a benchmark at all

Live checks on the applied install:
- `pi mcp list`: `rea: connected, 207 tools (codemode, global)`, exit 0
- `npx -y rea-agents@6.5.0 doctor --client pi --json`: `registration:pi` healthy at
  `~/.pi/agent/mcp.json`, skill `aligned` version `42`; `environment_healthy: false` only from the
  expected missing engines (Hopper, Ghidra, IDA, JADX)
- Headless `pi -p` with `codemode`: `describeNamespace("mcp__rea")` returned 207 tools and
  `mcp__rea__analyze_javascript_application` on a 5-file Electron fixture found the paired
  `ping` IPC channel
- Plan mode: `codemode` is not in `defaultPlanTools`, so REA stays unavailable while planning
- `chezmoi diff --recursive ~/.pi` and `~/.agents` empty after apply

Owner rule recorded for future gates: moderately slow benchmarks and isolated TUI flakes are
recorded, not blocking. A benchmark that fails outright is investigated before deploying.
