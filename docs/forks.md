# Fork ownership

`forks/pi` is the only Gitlink. It tracks the upstream-derived Pi core used to build the
release bundle and Bun standalone. Inspect it with `git submodule status`.

| Submodule | Upstream | Build ownership |
|---|---|---|
| `forks/pi` | `earendil-works/pi` | Core npm workspace, standalone Bun build, native helpers |

The extension packages are imported workspaces in `packages/` and are selected from npm by
`integration/stacks/personal.json`. Their source histories, licenses, native gates and release
contracts live with the imported package; they are not submodules and have no fork CI jobs.

Computer-use tracks upstream main `67e9e2f77643f84605b738a3198048a88e92190e` plus the
explicit carried set in [its sync runbook](../packages/computer-use/UPSTREAM.md). That runbook records
exact worktree/diff commands, per-patch drop checks, signing continuity and rollback. All tools and
the Linux locked-source build remain; local signing is unchanged. Source sync is not activation.

A normal clone has the core fork as `origin`; add the upstream remote explicitly when maintaining a
patch queue. Follow its contributor instructions before making changes.

Fork changes:

1. Use a dedicated checkout/worktree in the core repository; do not modify installed package output.
2. Run the native gate and applicable candidate integration tests.
3. Open a core fork PR and obtain both mandatory reviewer-subagent reports on its final HEAD.
4. Publish the reviewed core commit before opening the parent Gitlink update PR.
5. Gate and review the parent PR independently, then record the [release manifest](releases.md). No tag or pin promotion from unreviewed commits.

Parent Git worktrees do **not** automatically isolate the core submodule. Do not assume a clean
parent checkout proves it is clean. Do not use `--force`, discard changes, or clean it to make an
update succeed.

The top-level owned-code check is not a substitute for the core fork gate or the full assembled-stack
verification. Authenticated-provider and physical-desktop checks are separate manual evidence.
