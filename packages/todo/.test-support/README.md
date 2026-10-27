# Standalone test support

Source: `juicesharp/rpiv-mono` release `54df50eea935fc9753edc300d5f23c5e28d906d7`
(`@juicesharp/rpiv-todo@2.13.9`, subtree split `7903c76b`).

`upstream/{pi,session,theme,manifest}.ts` are unchanged copies from
`packages/test-utils/`, with the upstream MIT license. The local barrel exports
only those helpers used by this package. `rpiv-workflow` is a dev-only dependency
for their type imports; no workflow code is loaded by the helpers.

`.vitest.config.ts` aliases the unpublished `@juicesharp/rpiv-test-utils` to this
barrel. `setup.ts` preserves upstream's dynamic state/i18n reset and config
cleanup while isolating config through `XDG_CONFIG_HOME`; it leaves `HOME`
untouched so Bun cannot read the real home through a cached `os.homedir()`.  No upstream
test assertions or tests are removed. Keep support/config files in dot paths so
upstream's unchanged ship-manifest walker does not mistake them for production.

Test census:

- Before bootstrap: `npm test` exits 127 (`vitest: command not found`), zero tests.
- Stock split `7903c76b` with this support/config: 253 tests in 21 files pass.
- Selected fork `3c62a0b` with this support/config: 377 tests in 26 files pass.
- With the rendering regressions: 382 Vitest tests in 28 files pass.
- Bun 1.3.14: two real interactive settled-row regressions pass. This is native
  Bun coverage, not a claim that Bun runs the upstream Vitest/`vi.mock` suite.

`settled-row.ts` mounts the real core interactive harness and VirtualTerminal,
registering this fork's renderers with a snapshot-less legacy result. Both update
and delete rows failed with `expected ... to contain 'changed subject'` before
the fix and pass after it. Valid historical snapshots intentionally do not change
when the live task changes; the existing historical-row tests remain unchanged.
