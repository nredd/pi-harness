# Bun enforced promotion receipt

Promotes the `bun` signal of `preset`, `subscription-router` and `todo` from report-only to
enforced at 0/0 on darwin and linux ([#320](https://github.com/nredd/pi-harness/issues/320)).
Each runs its full Vitest suite on pinned Bun 1.4.4 through `scripts/run-vitest.ts bun`, with
Istanbul and the full primary inventory (no `files` subset).

Measured on PR #332 HEAD `791a1d9cbb7abe7a4faa53131b4db5d516f6ee7c`, CI run `41716990843`,
`owned` jobs `126206824979` (macos-14), `126206824929` (ubuntu-24.04) and `126206825175` (wsl2),
all green. Counts below are reparsed from the downloaded `coverage-macos-14` (artifact
`13276154964`), `coverage-ubuntu-24.04` (`13271839506`) and `coverage-wsl2` (`13274860564`)
LCOV, and match each artifact's `coverage/summary.json` (`enforced`, delta 0 from reference 0):

| Bun signal | Source files | Lines / uncovered | Functions / uncovered | `lcov.info` sha256 prefix |
| --- | --- | --- | --- | --- |
| preset | 3 | 370 / 0 | 93 / 0 | `004608ea9fc4` |
| subscription-router | 8 | 565 / 0 | 129 / 0 | `dfd1d188d4cc` |
| todo | 18 | 962 / 0 | 219 / 0 | `0243830ba903` |

All three OS artifacts are byte-identical per package, so the table holds for each one.
Later commits on the PR change only docs, comments and tests, not producers or measured source.

Not promoted here: `resource-sampler` (report-only reference darwin 8/4, linux 47/8) and
`inprocess` (darwin 17/4, linux 27/8, goal `report-only`). Both measured at delta 0 in the same
artifacts.
