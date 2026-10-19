# In-process stack scenarios

- Run `npm run check --workspace integration/inprocess` with pinned Bun `1.3.14` first on `PATH`. Checks Biome, TypeScript, Vitest and `bun test`.
- `support.ts` / `startStack` binds real extension factories to core's real `AgentSession`. Forks share the workspace's host SDK; fork-local `node_modules` are forbidden.
- `goal-support.ts` owns physical faux-provider registration, runtime/auth binding and teardown for goal/subagents/quota/router scenarios; responses and assertions stay local. Kit, router and subagents scheduling/delivery share an injected clock. Residual native fork timers are documented at `GoalStack.subagents`: admission tests require the router's exact quota block (the 100 ms timeout fails open), and manager retention is unref'd and disposed on quit. Follow-up fork clock seams would remove both. Core's zero-delay retry macrotask in `quota-goal.test.ts` has no elapsed-time assertion or wall-time sleep.
- `plan-todos.test.ts` covers approved plans and persisted todo state. `annotated-tools.test.ts` covers real dev-tools/monitor annotations consumed by Plan, fake SSH and a controlled monitor with a fake clock.
- `agents-support.ts` configures only fixture settings and package sources. The real pi-subagents factory discovers the unmodified `packages/preset/agents/*.md`; its real child runner loads dev-tools and enforces frontmatter. Parent and child share the faux transport, not a stub runner.
- `specialists.test.ts` covers five agent surfaces, read-only writes and debugger commit exclusion against real npm `pi-web-access@0.36.0` and `pi-memory@0.4.2`. Parent registration assertions prevent vacuous exclusion checks; the real child loader resolves their manifest entries and provenance. No synthetic web/memory packages remain.
- `support.ts` isolates web config/cache and memory storage under temporary HOME/agent directories. Web uses eager schemas, disabled browser cookies/UI, and no tool execution; a failing fetch spy asserts zero requests. Memory disables search, background updates and exit summaries; its startup `qmd` probe reaches a failing first-on-PATH shim with a checked invocation log, never the installed qmd.
- `reviewer.test.ts` covers the exact seven reads plus subagents' refusal helper, all seven read executions against the shared TS git fixture, and seven denied mutations with byte-preserved sentinels.
- `child-tools.test.ts` covers both factory orders, real deferred promotion, adversarial active-set reset, hidden tool provenance, schemas and refused execution. The fixture kit entry only passes existing `createSessionKit` options from a test-owned symbol so child loads use the same controlled spawn/clock as the parent.
- `nesting.test.ts` loads real workflow/deferred factories and checks explanatory child refusals. `turn-cap.test.ts` reaches the real child cap after promotion, then proves exactly one tool-free final report request despite the deferred engine's always-active spine.
- `workflow-trigger.test.ts` loads npm `@quintinshaw/pi-dynamic-workflows@3.14.0` with fixture `keywordTriggerEnabled: false`. A UI-capable host ensures the disabled setting is actually tested. This version leaves user input intact even when armed, so the test also checks the faux request for the keyword-arming directive.
- Third-party code is pinned in this workspace: workflows `3.14.0`, deferred engine `0.5.0`, web access `0.36.0`, memory `0.4.2`. The root override keeps web access's MCP SDK at `1.32.1`, matching the personal stack's fix for `GHSA-6qxp-vccf-f47h`. Tests read no live settings, installed extension code or credentials. No source seams were added to forks or owned extensions.

Mutation checks (each reverted before the final gates):

| File | Production mutation | Red assertion |
| --- | --- | --- |
| `annotated-tools.test.ts` | Remove dev-tools git read-only hint | `Plan admits annotated dev-tools reads` receives Plan refusal |
| `child-tools.test.ts` | Register child kit tools without hidden exposure | Both orders expose `monitor_start` in child schemas |
| `nesting.test.ts` | Remove foreign `workflow` from subagents' blocked set | Missing workflow refusal reason |
| `turn-cap.test.ts` | Allow `setActiveToolsByName` during forced final report | Final schemas contain `bash`, `search_tools`, `Agent` |
| `specialists.test.ts` | Add `write` to preset architect tools | Surface and explicit-write rejection fail |
| `reviewer.test.ts` | Add `write` to preset reviewer tools | Exact surface and explicit-write rejection fail |
| `workflow-trigger.test.ts` | Ignore keyword enable setting in installed workspace runtime | Keyword-arming directive appears in request |

- Evidence: `~/code/pi-harness-builds/ports/stack-agents-mutation-*.log`; final gates use `stack-agents-check.log`, `stack-agents-integration.log`, `stack-agents-ts.log` in the same directory.
- Review-fix mutation checks use invalid web/memory registration names in test expectations; Node and Bun each report two failures before reverting. Logs: `~/code/pi-harness-builds/ports/stack-agents-fix-mutation-{node,bun}.log`. Final review-fix gates: `stack-agents-fix-{check,integration,ts}.log` in the same directory.
- Python rows owned by these tests are removed, including the unasserted typed-policy tables and their activation/keying setup; out-of-scope Plan shell-policy and subagents rows and their shared helpers remain. `docs/verification-rebuild.md` records the thirteen replacements.
