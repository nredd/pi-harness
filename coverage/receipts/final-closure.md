# Final closure integration

Plain merge `33dda4ad` incorporates main without rewriting the policy branch. PR #203 is closed,
not marked merged: its continuation landed through #210 at `1d24b829` according to its closing
receipt. No separate open continuation remains.

Local primary producers passed on macOS, Node 26.12.0 and Bun 1.4.4. After adding worker-error
settlement/cancellation assertions and applying #195's reviewed Istanbul inventory:

| Package | Covered/total lines | Covered/total functions |
| --- | --- | --- |
| dev-tools | 1502/1502 | 260/260 |
| plan-mode | 2996/2996 | 699/699 |
| preset | 365/365 | 91/91 |
| resource-sampler | 371/371 | 55/55 |
| session-kit | 3541/3541 | 824/824 |
| subagents | 7173/7173 | 1422/1422 |
| subscription-router | 566/566 | 129/129 |
| todo | 964/964 | 221/221 |

The initial dev-tools V8 producer omitted `src/git/push-remote.ts`; the Istanbul producer now
lists all 22 executable modules. Its `src/core/index.ts` is a static named-export barrel. Real
TypeScript and emitted ESM Istanbul maps are tested for zero counters, not assigned fictional
LCOV coverage. The strict facade grammar now accepts TypeScript local specifiers, trailing
commas and inline type bindings, preserving rejection of executable additions.

The subagents worker error is delivered at the real worker's public EventEmitter boundary with
a held child. Both Error and string payloads must settle as failed and abort that exact child.
No production guard or assertion is removed.

Bun 1.4.4 now exits nonzero for the 50%-function fixture with either LCOV alone or text plus
LCOV. The pinned-runtime regression asserts that repair; both reporters remain mandatory.

These are advisory local receipts, not hosted floors. Global enforcement remains disabled until
complete independent hosted measurements establish applicable per-OS primary coverage. Linux's
Darwin-native code remains inventoried and must retain an explicit per-OS floor, never an exclusion.
