# Retained index lifecycle coverage

PR #198 already includes `c49b6429`'s
`test/index-coverage-final-lifecycle.test.ts` alongside its three original index
coverage files. This is the combined 101-case scope, not a separate-worktree
isolation claim or an unintegrated #201 increment. Production, configuration,
providers and dependencies are unchanged; independent #193 coverage is excluded.

| Existing Node/Istanbul checkpoint | Index lines | Index functions | Missing lines/functions |
| --- | ---: | ---: | ---: |
| Original 98 cases at `afd32e60` | 1399/1437 | 243/251 | 38/8 |
| `c49b6429` adds 3 cases, combined 101 | 1402/1437 | 246/251 | 35/5 |

These are existing measurements of unchanged source, not a fresh coverage result
at the documentation correction. The unchanged source inventory is 1437 lines and
251 functions. [The combined note](subagents-index-coverage.md) owns reproduction,
current gates, remaining named themes and broader mutation limits.

The three cases use registered lifecycle handlers, actual manager/runner/child
sessions, a private parent session file and real fleet/viewer input. The child
provider is scripted; **the test emitter auto-acks `router:rpc:admit`**, as does the
generation/viewer fixture. Neither fixture validates production router admission.
No direct closure invocation or counter hooks manufacture coverage.

- `restores both members of a held grouped completion once after reload`: hold
  two real group members' results, reload, then deliver both original results and
  identities once at the next boundary. The old context receives no notice.
- `routes steer from a fresh fleet viewer to its detached survivor`: reload while
  a child runs, open its survivor from a fresh fleet, submit a viewer instruction,
  then assert that instruction in the original transcript and its redirected result.
- `routes stop from a fresh fleet viewer to its detached survivor`: stop through
  that viewer, assert stopped state/toast, then assert detached roster and settled
  manager-record release. Neither old nor replacement context receives the notice.

## Existing mutation receipts

The existing lifecycle run used
`vitest run test/index-coverage-final-lifecycle.test.ts --maxWorkers=1`.
Recovered assertion outcomes are preserved [here](https://github.com/nredd/pi-harness/pull/198#issuecomment-6474084561);
these mutations were not executed again for the documentation correction.

| Mutation | Owning red test | Outcome |
| --- | --- | --- |
| Suppress detached notice delivery | `restores both members of a held grouped completion once after reload` | Exit 1, 1 failed/2 passed; expected one `sendMessage`, received zero. |
| Route survivor abort to unknown id | `routes stop from a fresh fleet viewer to its detached survivor` | Exit 1, 1 failed/2 passed; expected stop toast, received no calls. |
| Route survivor steer to unknown id | `routes steer from a fresh fleet viewer to its detached survivor` | Exit 1, 1 failed/2 passed; expected redirected result, received original result. |
| Suppress settled detached-manager disposal | Both named `routes steer` and `routes stop` cases above | Exit 1, 2 failed/1 passed; expected undefined `getRecord(id)`, received retained record. |

These are named assertion failures, not parser/import failures. The author's
existing receipt records restoration between runs. #201 had no PR comments when
these outcomes were recovered; the durable receipt is on #198. Together with
[the original 14 and additional 17 kills/1 survivor](https://github.com/nredd/pi-harness/pull/198#issuecomment-6473821322),
this is bounded evidence, not complete mutation proof of all 101 cases.

At combined code HEAD `a04a6cd1`, all four files/101 cases pass on Node and Bun;
lint/types pass. Full Node passes 3550 cases with 8 skipped; full Bun has 3550
passed/1 failed/7 skipped, the existing #174 authored-stack-line failure. Earlier
two missing-`ModuleKind` failures did not reproduce in the fresh installation.
The attempted coverage rerun could not resolve the Istanbul provider and stopped
before tests. No full green gate, new coverage measurement, 100% completion or
provider inconsistency is claimed.
