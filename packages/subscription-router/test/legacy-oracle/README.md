# Immutable legacy oracle

These six files are verbatim copies of `packages/subscription-router/src/` at merge base
`1e93038cffd4d2ca92ffd7bc8edeeebce389890d`. Their relative imports resolve entirely within this
fixture: neither selection nor routing delegates to production code. The snapshot includes its
config, quota-window matching/decisions and tracker dependencies so production changes cannot
silently change the reference implementation.

`policy-differential.test.ts` pins every Git blob ID, then compares `pick`, `route`, `admit`,
selection, decision bytes, dependency-call order and tracker changes over 4,096 fixed-seed states.
No fast-check dependency is needed. Do not edit or regenerate this oracle when production changes.
