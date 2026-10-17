# Fork ownership

`forks/` contains upstream-derived repositories, not owned workspace packages. The parent Gitlinks
select their exact source revisions. Inspect them with `git submodule status`; do not maintain a
second list of release pins here.

| Submodule | Upstream | Build ownership |
|---|---|---|
| `forks/pi` | `earendil-works/pi` | Core npm workspace, standalone Bun build, native helpers |
| `forks/pi-subagents` | `tintinweb/pi-subagents` | Fork npm check/test gate |
| `forks/pi-plan-mode` | `narumiruna/pi-extensions`, `packages/pi-plan-mode` | Standalone vendored build/test harness |
| `forks/rpiv-todo` | `juicesharp/rpiv-mono`, `packages/rpiv-todo` | Subtree-split package, upstream monorepo gate |
| `forks/pi-claude-auth` | `pankajudhas81/pi-claude-auth` | Fork pnpm lint/build/test gate |
| `forks/pi-computer-use` | `injaneity/pi-computer-use` | Fork tests and native-helper build |

The initial Gitlinks select published fork tags already used by the existing installation. Adding
those Gitlinks does not establish Bun compatibility or rerun the fork gates. Native lockfiles,
licenses, source histories, and build procedures remain owned by their respective repositories.
The selected `forks/pi-subagents` commit is additionally exercised with the real packed preset and
dev-tools by `make check-fork-package-contracts` ([details](package-contracts.md)); it refuses a missing,
dirty or Gitlink-mismatched fork and never bootstraps or installs into it.
A normal clone has the fork as `origin`; add the upstream remote explicitly when maintaining a patch
queue. Follow each fork's contributor instructions before making changes.

Fork changes:

1. Use a dedicated checkout/worktree in the fork repository; do not modify installed package output.
2. Run the native gate and the applicable candidate integration tests.
3. Open a fork PR and obtain both mandatory reviewer-subagent reports on its final HEAD.
4. Publish the reviewed fork commit before opening the parent Gitlink update PR.
5. Gate and review the parent PR independently. No tag or pin promotion from unreviewed commits.

Parent Git worktrees isolate owned files, but do **not** automatically isolate submodule work. Do not
assume a clean parent checkout proves every fork is clean. Initialization/update must preflight all
initialized submodules and refuse dirty tracked, staged, or untracked state before changing any fork.
Do not use `--force`, discard changes, or clean a fork to make bootstrap succeed.

The top-level owned-code check is not a substitute for these fork gates or the full assembled-stack
verification. Authenticated-provider and physical-desktop checks are separate manual evidence.
