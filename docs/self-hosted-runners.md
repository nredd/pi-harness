# Self-hosted runners

`nredd/pi-harness` is PUBLIC. A self-hosted runner executes whatever a workflow says, and a fork PR brings its own workflow file, so the design assumes any job may be hostile and makes the runner worthless to compromise.

Infra code and runbook live in the private `nredd/ci-runners` repo. This page is the policy and the spec.

## Pools

| Label | Host | Isolation |
| --- | --- | --- |
| `pi-linux` | NAS (Proxmox) | One linked-clone VM per job from template `9001`, destroyed after the job. Per-VM PVE firewall drops every private net, so no LAN, no tailnet. 8 vCPU, 10 GiB, 50 min cap |
| `pi-macos` | MacBook Air (arm64) | One job at a time as the unprivileged hidden `ci` user. All `ci` processes killed and its home and `/tmp` files wiped before and after every job, runner restored from a root-owned golden copy. pf rules block `ci` from every private net. 50 min cap |

Both register repo-scoped with single-use JIT configs: a runner takes one job and its registration dies with it. No org or user level runners, no runner groups to misconfigure, nothing persistent to steal. The PAT that mints configs (`Administration: write`, `Actions: read`, this repo only) lives root-only on the host, never inside a VM or the `ci` account.

## Repo settings (enforced, check with `gh api`)

- Actions allowed: `selected` -- GitHub-owned plus `astral-sh/setup-uv`, `oven-sh/setup-bun`, `taiki-e/install-action`, `Vampire/setup-wsl`
- `sha_pinning_required: true` (every `uses:` is already a full SHA)
- Fork PR approval: `all_external_contributors`, i.e. EVERY fork PR run waits for the owner. Never use "first-time contributors". Do NOT approve a fork PR run without reading its workflow diff: a fork can rewrite `runs-on` to a self-hosted label
- Workflow token default `read`, `can_approve_pull_request_reviews: false`
- No collaborators, no repo or org secrets (environments `npm`, `stack-promotion` are branch-gated), no `pull_request_target`, `workflow_run` or `issue_comment` workflows. Adding any of these with a self-hosted `runs-on` is a blocking change
- Ruleset `main required checks` requires the same names the hosted cells report

## Threat model

- Fork PR: never reaches a runner unless the owner approves the run (see above). Even then it gets a throwaway VM / wiped user with public internet only
- Same-repo PR or push: owner-authored, trusted like hosted, but still ephemeral
- Compromised dependency in a job: can burn that one VM or the `ci` account, cannot reach the LAN, tailnet, the PAT, the owner's home or any credential, and leaves nothing for the next job
- RESIDUAL on `pi-macos`: `ci` shares a kernel with the laptop, so a local privilege-escalation exploit would break out; loopback services stay reachable; DNS (port 53) to the resolvers stays open. A VM would be better but there is no disk for a macOS+Xcode image. Keep macOS patched
- RESIDUAL on `pi-linux`: `runner` has passwordless sudo inside the throwaway VM (apt installs); link-local IPv6 is not dropped

## Smoke

`.github/workflows/runner-smoke.yml` runs on same-repo PRs touching it and on `workflow_dispatch`. Each pool must show: runner name and arch, public internet reachable, and non-identifying private, shared-address and link-local targets blocked. These probes do not prove every address is blocked. Keep any host-specific extra targets in runner-side environment or repository variables, never in the repository.

## Remaining

- Route jobs: add `[self-hosted, pi-linux]` / `[self-hosted, pi-macos]` to the `runner` matrix values in `scripts/ci_paths.py` (`RUNNERS`, pinned by `test_ci_guest_matrix.py`), only for same-repo events (`head.repo.full_name == github.repository`), hosted fallback otherwise, and update the "Hosted runners only" statement in [CI](ci.md)
- `pi-macos` availability: a sleeping laptop leaves its jobs queued forever. `caffeinate -s` keeps it awake on AC; add a hosted fallback (route to hosted when no `pi-macos` runner is online or the job queues past N minutes) before making `pi-macos` a required cell
- Quiet benchmark runner (`bench`, [migration plan](migration-plan.md) section 7): `pi-linux` is a shared host, so it does NOT yet meet the bench admission policy
- Windows/WSL: template `9002` exists on the NAS, no pool is wired
- Alerting: the daemon only logs to journald; nothing pages when it is down
