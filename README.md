# Pi harness

Development home for independently versioned Pi plugins, an optional preset, integration tests,
benchmarks, and exact-stack release tooling. Upstream forks retain their histories as submodules.

Migration is in progress. There is no supported release or installer yet. The existing installation
remains authoritative until the standalone Bun stack passes verification and is explicitly activated.

See [the migration plan](docs/migration-plan.md) for scope, acceptance criteria, and rollout policy.
Every migration PR requires separate Standards and Spec reviewer subagents against its final HEAD,
including documentation, fork, dotfiles, and automated promotion changes.

Planned layout:

- `packages/`: independently versioned plugins and optional preset.
- `forks/`: exact upstream-fork source commits, with their native build systems.
- `integration/`: E2E scenarios, including the existing performance gates.
- `benchmarks/comparison/`: historical comparison experiments and annotated results.
- `scripts/`: build, release, and chezmoi integration implementation.
- `docs/`: development, source provenance, release, and recovery documentation.

Distribution policy:

- Publish reusable plugins separately from tested stack releases.
- Require standalone Bun verification on macOS ARM64 and Linux ARM64/x64.
- Keep credentials, enterprise endpoints, and machine policy outside public artifacts.
- Make `chezmoi update` stage only; activate explicitly through chezmoi after closing Pi sessions.
- Preserve auth, sessions, memory, trust state, local manifests, and modified user resources.

These are migration requirements, not claims that the distribution already implements them.
