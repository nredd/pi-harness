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

## plan-mode

Promotes plan-mode's `bun` signal to enforced at 0/0 on darwin and linux, retiring its native
`bun test` subset (8 cases) and `tool-policy.test.ts` canary (25 cases) for the full 637-case
Vitest suite on Bun 1.4.4 through `scripts/run-vitest.ts bun`, with no `files` subset.

Measured on PR #362 HEAD `74d704f4a36366350ba8be6acfd437c3a137f3e3`, CI run `41767456760`,
`owned` jobs `126369170331` (macos-14, green), `126369170371` (ubuntu-24.04, green) and
`126369170298` (wsl2, red only on subagents `preloaded-skill-e2e.test.ts` timing out at 5000ms,
filed under #312; plan-mode ran and accounted). Counts are reparsed from `coverage-macos-14`
(artifact `13294596478`), `coverage-ubuntu-24.04` (`13294082326`) and `coverage-wsl2`
(`13293962501`) LCOV and match each `coverage/summary.json` (`enforced`, delta 0 from reference 0):

| OS | Source files | Lines / uncovered | Functions / uncovered | `lcov.info` sha256 prefix |
| --- | --- | --- | --- | --- |
| macos-14 | 34 | 2999 / 0 | 702 / 0 | `9effc27bcffb` |
| ubuntu-24.04 | 34 | 2999 / 0 | 702 / 0 | `76238761ebe4` |
| wsl2 | 34 | 2999 / 0 | 702 / 0 | `cee1c3d86f51` |

The files differ byte-wise because hit counts vary per OS (e.g. `DA:114,4438` on macos-14 vs
`DA:114,2854` on ubuntu-24.04). Normalizing every `DA`/`FNDA` count to hit/miss, the record sets
are identical across all three OSes and identical to each OS's Node primary report:

```sh
norm() { grep -E '^(SF|FN|DA|FNDA|LF|LH|FNF|FNH):' "$1" | sed -E 's/^DA:([0-9]+),0$/DA:\1,miss/; s/^DA:([0-9]+),[1-9][0-9]*$/DA:\1,hit/; s/^FNDA:0,/FNDA:miss,/; s/^FNDA:[1-9][0-9]*,/FNDA:hit,/'; }
for o in macos-14 ubuntu-24.04 wsl2; do for s in bun primary; do
  norm coverage-$o/packages/plan-mode/coverage/$s/lcov.info | shasum -a 256 | cut -c1-12
done; done
```

All six print `a1087a1cfa17`, over 3701 `DA`/`FNDA` records with 0 misses. `BRDA` branch records are
not compared; branches are report-only.

## dev-tools

Promotes dev-tools' `bun` signal to enforced at 0/0 on darwin and linux, retiring its native
`bun test test/scenarios` subset (5 cases) and `ssh/hosts.test.ts` canary (17 cases) for the full
449-case Vitest suite on Bun 1.4.4 through `scripts/run-vitest.ts bun`, with no `files` subset.

Measured on PR #433 HEAD `eaa4167ab72a2d49d7a633f412251184c67d39a1`, CI run `41863283747`,
`owned` jobs `126712706367` (macos-14), `126701716897` (ubuntu-24.04) and `126703588001` (wsl2),
all green. Bun's `test/cargo/tools.test.ts` ran all 14 cases on every OS; on the previous head's run
`41806017200` it skipped 13 on ubuntu-24.04 and wsl2 because rustup could not find its home under
the launcher's disposable HOME (fixed by `toolchainHomeEnv` in `scripts/run-vitest.ts`). Counts are
reparsed from `coverage-macos-14` (artifact `13343851896`), `coverage-ubuntu-24.04` (`13341639716`)
and `coverage-wsl2` (`13343175567`) LCOV and match each `coverage/summary.json` (`enforced`, delta 0
from reference 0):

| OS | Source files | Lines / uncovered | Functions / uncovered | `lcov.info` sha256 prefix |
| --- | --- | --- | --- | --- |
| macos-14 | 23 | 1600 / 0 | 279 / 0 | `6f943431ec65` |
| ubuntu-24.04 | 23 | 1600 / 0 | 279 / 0 | `fb0df64b765b` |
| wsl2 | 23 | 1600 / 0 | 279 / 0 | `059915d1ac54` |

With the plan-mode `norm` above, the Bun and primary reports of all three OSes all print
`fb774e38bb1f`, over 1879 `DA`/`FNDA` records with 0 misses. `BRDA` branch records are not compared.
