# Self-hosted runners

`nredd/pi-harness` is PUBLIC. A self-hosted runner executes whatever a workflow says, and a fork PR brings its own workflow file, so the design assumes any job may be hostile and makes the runner worthless to compromise.

Infra code and runbook live in the private `nredd/ci-runners` repo. This page is the policy and the spec.

## Pools

| Label | Host | Isolation |
| --- | --- | --- |
| `pi-linux` | NAS (Proxmox) | One linked-clone VM per job from template `9001`, destroyed after the job. Per-VM PVE firewall drops every private net, so no LAN, no tailnet. 8 vCPU, 10 GiB, 50 min cap |
| `pi-macos` | MacBook Air (arm64) | One job at a time as the unprivileged hidden `ci` user. All `ci` processes killed and its home and `/tmp` files wiped before and after every job, runner restored from a root-owned golden copy. pf rules block `ci` from every private net. 50 min cap |
| `pi-wsl2` | ARM64 Windows laptop | One job at a time inside a fresh WSL2 distro (linux-arm64), imported from a read-only golden image under a dedicated non-admin Windows user `ci`, so it gets its own utility VM apart from the owner's dev distros. Unregistered and the VM shut down after every job. NAT networking; a guest nftables deny set (private ranges, tailnet/CGNAT, link-local, the gateway, plus every non-default route prefix of the host at job start) is the enforced layer, and a calibrated Hyper-V firewall rule is best effort. `wsl.conf`: automount, interop and `appendWindowsPath` off, no sudo, IPv6 off. Runs only on AC with enough free disk. 50 min cap |

All register repo-scoped with single-use JIT configs: a runner takes one job and its registration dies with it. No org or user level runners, no runner groups to misconfigure, nothing persistent to steal. The PAT that mints configs (`Administration: write`, `Actions: read`, this repo only) lives root-only (SYSTEM and Administrators on Windows) on the host, never inside a VM or the `ci` account.

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
- `pi-wsl2` jobs assume hostile code as an unprivileged user in a fresh VM with outbound internet. A job can burn its one VM for the cap, use the public internet (including exfiltrating anything it can see: the checkout, the read-only job token, its own single-use JIT credential), resolve DNS through public resolvers and use CPU within the VM's cap. It cannot read the PAT or any Windows path (no automount, no interop, `ci` has no ACE on the secrets directory), reach the LAN, tailnet, routed prefixes, the Windows host or the dev distros' loopback, run `.exe` files, persist anything or register a second runner. The supervisor admits a run only when its head repository is this one, so a fork that rewrites `runs-on: pi-wsl2` sits queued until GitHub expires it (the rescue workflow leaves fork runs alone, and the supervisor leaves refused jobs out of its free-slot count); the workflow-side same-repo guard is NOT the boundary
- RESIDUAL on `pi-wsl2`: a Linux kernel or WSL guest-to-host vulnerability breaks out of the VM (keep Windows, WSL and its kernel patched); the pool shares a host with the owner's dev VM and Windows session, so a job can still cost RAM, disk, CPU, battery and thermals (caps and preflights, not isolation); the Hyper-V firewall layer is per creator and calibrated per job, UNVERIFIED on a NAT port, and the guest layer falls to a kernel LPE; public internet means exfiltration, DNS exfiltration and any IP-allowlisted public service; a tunnel that comes up mid-job adds routes the job-start deny set does not hold (the supervisor aborts the job when the host's route set grows); host management policy may re-grant rights, and an administrator can always read `ci`'s data; there is no hosted ARM64 WSL2 to fall back to

## Smoke

`.github/workflows/runner-smoke.yml` runs on same-repo PRs touching it and on `workflow_dispatch`. Each pool must show: runner name and arch, public internet reachable, private targets (`192.168.x`, `100.x` tailnet, `10.x`) blocked. `pi-wsl2` runs `scripts/wsl2_smoke.sh`, which also checks non-root, no sudo, aarch64, IPv6 off, no `/mnt/c`, no WSL interop, no Windows path or `.exe` on `PATH`, no drvfs/9p mounts and closed loopback ports. The host's address and the dev environment's address and ports come from the runner's environment (`SMOKE_HOST_IP`, `SMOKE_DEV_IP`, `SMOKE_DEV_PORTS`), never from this repository. The same script is the first step of every `pi-wsl2` cell in `ci.yml`.

## Remaining

- Route jobs: add `[self-hosted, pi-linux]` / `[self-hosted, pi-macos]` to the `runner` matrix values in `scripts/ci_paths.py` (`RUNNERS`, pinned by `test_ci_guest_matrix.py`), only for same-repo events (`head.repo.full_name == github.repository`), hosted fallback otherwise, and update the "Hosted runners only" statement in [CI](ci.md)
- `pi-macos` availability: a sleeping laptop leaves its jobs queued forever. `caffeinate -s` keeps it awake on AC; add a hosted fallback (route to hosted when no `pi-macos` runner is online or the job queues past N minutes) before making `pi-macos` a required cell
- Quiet benchmark runner (`bench`, [migration plan](migration-plan.md) section 7): `pi-linux` is a shared host, so it does NOT yet meet the bench admission policy
- `pi-wsl2` acceptance before `PI_WSL2_HEARTBEAT` is set: three consecutive green real jobs and a clean smoke on the laptop, then replace the estimated `CELL_SECONDS` entries for the `wsl2` cells with measured ones. Until the variable exists the pool reads as down and every `wsl2` cell stays hosted. Pooled cells keep reporting as `owned (wsl2)` and `contracts (wsl2)`, and the pool's own job is `smoke (pi-wsl2)`; no new required check name is added
- Alerting: the daemon only logs to journald; nothing pages when it is down
