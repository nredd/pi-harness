# Plan reconciliation

Approving a revised plan replaces only the todos with `source: "plan"`. Agent-created
items remain in place. If an agent-created item was blocked by a removed plan item, that
removed id is dropped from its `blockedBy` list. This is the existing dependency behavior:
no replacement dependency is inferred, and no new dependency edge is introduced.

Each seeded plan todo persists this identity:

```ts
planIdentity: {
  version: 1,
  headingPath: string[],
  workBody: string,
}
```

`headingPath` is every enclosing work-section heading (`##` and deeper), verbatim; the `#` title names the plan rather than its work. `workBody` is the exact Markdown work
body: a bullet's text plus nested lines, or a work section's prose and code, prefixed by
shared work context from enclosing sections. When a section has both prose and bullets,
the prose becomes its own todo and scopes the bullets. A colon-ended list lead-in scopes
its bullets without creating a label-only todo. Changing shared or ancestor work resets
related bullets rather than carrying proof into a revised scope. Leading code also scopes
subsequent bullets; a code-only work section becomes one heading-named todo, never tasks
for example bullets inside the code. The identity is deliberately
strict. A changed heading, bullet, nested line, or prose body starts a new pending todo rather
than attaching old proof to revised work.

On re-approval, completed or deferred `status`, `evidence`, and `reason` carry only when
exactly one prior version-1 identity and exactly one incoming identity match. Pending and
in-progress work restarts pending, so provenance never implies that work progressed across
an approval. Repeated identical bullets are ambiguous, so every duplicate starts pending.
Tasks written by an older extension without a versioned identity never carry state on their
next approval.

A carried todo records where its state came from:

```ts
planProvenance: { planId: string, taskId: number }
```

Both fields are part of the normal persisted task snapshot. Markdown fences are tracked by
fence character, opening-run length, and container-relative indentation, so an inner
````` fence cannot close an outer `~~~~` fence or create a fake todo. A nested fence ends
when its list container ends; root four-space-indented code is not a Markdown fence.
